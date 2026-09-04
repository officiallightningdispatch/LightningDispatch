/**
 * Live map (owner's #1 priority, 2026-08-11): a REAL map (street tiles +
 * markers) for the owner portal (dashboard, queue, drivers) and the
 * contractor portal (home, active). Zero new dependencies — plain <img> OSM
 * raster tiles (tile.openstreetmap.org) under a small custom pan/zoom
 * wrapper (drag, wheel, pinch, +/- buttons, recenter). Markers:
 *  - driver pins  — fresh GPS pings (green) / stale (gray)
 *  - job pins     — active jobs' pickup waypoints (rose), with the AI
 *                   dispatcher's quoted ETA when one exists
 *  - self pin     — the signed-in contractor's own position (blue)
 * Data comes from getLiveMapData (LOCAL DB only — never Towbook), polled at
 * the app's existing 15s cadence. If the tile host is unreachable the map
 * degrades to an SVG pin plot with a "map unavailable" note — it never
 * crashes the page.
 */
import { LocateFixed, MapPin, Minus, Plus, Radar, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "~/components/ui";
import { getLiveMapData, type LiveMapData } from "~/data/server";

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
/** Cap auto-fit zoom so a lone pin still has street context. */
const FIT_MAX_ZOOM = 15;
const OSM = "https://tile.openstreetmap.org";

/* ------------------------------ projections ------------------------------ */

function latLngToWorld(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * TILE * n;
  const siny = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * TILE * n;
  return { x, y };
}
function worldToLatLng(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const n = Math.pow(2, zoom);
  const lng = (x / (TILE * n)) * 360 - 180;
  const n2 = Math.PI - (2 * Math.PI * y) / (TILE * n);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));
  return { lat, lng };
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** New center/zoom so the world point under `anchor` (client px inside the
 *  viewport) stays fixed when the zoom changes. */
function zoomAtPoint(
  g: { center: { lat: number; lng: number }; zoom: number; viewport: { w: number; h: number } },
  anchor: { x: number; y: number },
  newZoom: number,
): { center: { lat: number; lng: number }; zoom: number } {
  const cw = latLngToWorld(g.center.lat, g.center.lng, g.zoom);
  const aw = { x: cw.x + anchor.x - g.viewport.w / 2, y: cw.y + anchor.y - g.viewport.h / 2 };
  const scale = Math.pow(2, newZoom - g.zoom);
  const nc = worldToLatLng(
    aw.x * scale - (anchor.x - g.viewport.w / 2),
    aw.y * scale - (anchor.y - g.viewport.h / 2),
    newZoom,
  );
  return { center: nc, zoom: newZoom };
}

/* --------------------------------- pins --------------------------------- */

export type MapPin = {
  id: string;
  kind: "driver" | "job" | "self";
  lat: number;
  lng: number;
  title: string;
  sub: string | null;
  fresh?: boolean;
  mine?: boolean;
  eta?: number | null;
};

type Viewport = { w: number; h: number };

/* ------------------------------ the component ---------------------------- */

export type LiveMapProps = {
  /** Tailwind height class for the tile viewport (default h-72 sm:h-80). */
  heightClass?: string;
  /** Data poll interval — app cadence is 15s (matches the old driver map). */
  pollMs?: number;
  /** Shown when the feed is unavailable (demo mode / not signed in). */
  emptyTitle?: string;
  emptyBody?: string;
  /** Rendered under the map on the /owner/drivers page (roster rows). */
  showDriverList?: boolean;
  /** "panel" = the original card look (header counts, legend, borders).
   *  "hero" = full-bleed driver-portal map: no Card wrapper, no header/legend/
   *  driver list, slimmer zoom controls, waiting-for-GPS as a floating chip.
   *  The data contract, pins and poll are IDENTICAL either way (R2 spec §b). */
  variant?: "panel" | "hero";
  /** Force the chrome-free look (hero implies it). */
  hideChrome?: boolean;
  /** Fired on a tap (pointerup with <6px movement, single pointer, no pinch) —
   *  the driver portal uses it to expand the bottom sheet. Additive; ignored
   *  by existing call sites. */
  onTap?: () => void;
  /** Driver-portal pages pass true so the server scopes the feed to the
   *  EFFECTIVE driver identity — an owner/admin in driver view (view toggle,
   *  2026-08-12) sees exactly what a contractor sees (self pin, "mine" flags,
   *  anonymized neighbors) instead of the ops-wide view. No-op for a
   *  contractor session (already scoped by role). */
  driverScope?: boolean;
};

const timeAgoLabel = (iso: string, now: number): string => {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export function LiveMap({
  heightClass = "h-72 sm:h-80",
  pollMs = 15000,
  emptyTitle = "Live map unavailable",
  emptyBody = "Sign in and connect a database to see driver positions and active job pickups here.",
  showDriverList = false,
  variant = "panel",
  hideChrome = false,
  onTap,
  driverScope = false,
}: LiveMapProps) {
  const isHero = variant === "hero" || hideChrome;
  const [data, setData] = useState<LiveMapData | null>(null);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Feature batch 5 (owner-directed 2026-08-12): when the driver-portal map
  // has NO stored self pin (no active job / no recent ping), fall back to the
  // browser's own geolocation so the blue dot + "You are here" ALWAYS renders
  // on the driver's map — no dead/empty screen with no job. One-shot: we take
  // the fix, render the dot, and never nag for permissions repeatedly.
  const [browserSelf, setBrowserSelf] = useState<{ lat: number; lng: number } | null>(null);
  const [browserSelfDenied, setBrowserSelfDenied] = useState(false);
  // Default view: the org's operating area (Bridgeport CT / 06606) so the
  // street map is always visible even before any pings arrive.
  const [center, setCenter] = useState<{ lat: number; lng: number }>({ lat: 41.19, lng: -73.2 });
  const [zoom, setZoom] = useState(12);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  const mapRef = useRef<HTMLDivElement>(null);
  const geomRef = useRef({ center, zoom, viewport });
  geomRef.current = { center, zoom, viewport };
  const dragRef = useRef<{ sx: number; sy: number; cwx: number; cwy: number; startedAt: number; moved: boolean } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; mid: { x: number; y: number }; zoom: number } | null>(null);
  const pinchUsedRef = useRef(false);
  const tileOkRef = useRef<Set<string>>(new Set());
  const tileFailRef = useRef<Set<string>>(new Set());

  /* ------------------------------ data + poll ------------------------------ */
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(false);
    try {
      const r = await getLiveMapData({ data: { driverScope } });
      if (r === null) {
        // The feed RESOLVED to null (transient auth/DB hiccup — not a fetch
        // failure, so no throw reached the catch): a signed-in user would
        // otherwise sit on the loading skeleton forever. Treat it as an error
        // and let the explicit error state (with Retry) take over.
        setData(null);
        setError(true);
        return;
      }
      setData(r);
      setLastUpdated(new Date());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(true), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  /* Feature 5 — browser self-location fallback (driver-scoped maps only):
   * when the feed has no self pin, ask the browser once for a fix. A granted
   * fix renders the blue dot; a denial shows the honest location chip. */
  useEffect(() => {
    if (!driverScope || browserSelf || browserSelfDenied) return;
    if (data && data.self) return; // server already knows where we are
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setBrowserSelfDenied(true);
      return;
    }
    let stopped = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (stopped) return;
        const lat = Number(pos.coords.latitude);
        const lng = Number(pos.coords.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) setBrowserSelf({ lat, lng });
      },
      () => { if (!stopped) setBrowserSelfDenied(true); },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    );
    return () => { stopped = true; };
  }, [driverScope, browserSelf, browserSelfDenied, data]);

  /* -------------------------------- viewport -------------------------------- */
  // The viewport div does NOT exist on first mount: while data is null a loading
  // skeleton renders instead, so a mount-time effect sees mapRef.current ===
  // null and the ResizeObserver is never attached — viewport stays null, geo
  // stays null, and the map silently renders FallbackPlot forever (QA
  // 2026-08-11). Drive setup from a callback ref instead: it fires exactly when
  // the viewport div mounts (and React 19 calls the returned cleanup on
  // unmount), so the map always measures its container and paints tiles.
  const setupMap = useCallback((node: HTMLDivElement | null) => {
    mapRef.current = node;
    if (!node) return;
    // Immediate initial measurement — don't wait for the RO's first callback;
    // the map must still compute a viewport if that callback fires late/never.
    const r0 = node.getBoundingClientRect();
    if (r0.width > 0 && r0.height > 0) {
      setViewport((v) => (v && Math.abs(v.w - r0.width) < 1 && Math.abs(v.h - r0.height) < 1 ? v : { w: r0.width, h: r0.height }));
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setViewport((v) => (v && Math.abs(v.w - r.width) < 1 && Math.abs(v.h - r.height) < 1 ? v : { w: r.width, h: r.height }));
    });
    ro.observe(node);
    // Wheel zoom must be non-passive to preventDefault — attach natively here
    // too (it has the exact same mount-lifetime bug the RO had).
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geomRef.current;
      const vp = g.viewport;
      if (!vp) return;
      const rect = node.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = zoomAtPoint({ center: g.center, zoom: g.zoom, viewport: vp }, anchor, clamp(g.zoom + dir, MIN_ZOOM, MAX_ZOOM));
      setCenter(next.center);
      setZoom(next.zoom);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      node.removeEventListener("wheel", onWheel);
      if (mapRef.current === node) mapRef.current = null;
    };
  }, []);

  /* ---------------------------------- pins ---------------------------------- */
  const pins = useMemo<MapPin[]>(() => {
    const list: MapPin[] = [];
    // Feature 5: the blue dot comes from the feed's self pin when the server
    // knows our position; otherwise (no active job / no recent ping) from the
    // browser geolocation fallback so the map NEVER renders without "you".
    if (data?.self) {
      list.push({ id: "self", kind: "self", lat: data.self.lat, lng: data.self.lng, title: "You", sub: null, fresh: true });
    } else if (driverScope && browserSelf) {
      list.push({ id: "self-browser", kind: "self", lat: browserSelf.lat, lng: browserSelf.lng, title: "You", sub: null, fresh: true });
    }
    for (const d of data?.drivers ?? []) {
      list.push({
        id: `d-${d.driverId}`,
        kind: "driver",
        lat: d.lat,
        lng: d.lng,
        title: d.driverName,
        sub: d.fresh ? (d.jobStatus ?? "available") : "stale",
        fresh: d.fresh,
      });
    }
    for (const j of data?.jobs ?? []) {
      list.push({
        id: `j-${j.jobId}`,
        kind: "job",
        lat: j.lat,
        lng: j.lng,
        title: j.customerName ?? "Roadside job",
        sub: j.etaMinutes != null ? `${j.etaMinutes} min ETA` : j.driverName ?? j.serviceType ?? j.status,
        mine: j.mine,
        eta: j.etaMinutes,
      });
    }
    // Never let malformed or known geolocation-denied coordinates poison the
    // viewport. Keep this client-side guard because feeds can contain legacy
    // rows and the map is also consumed by staff-scoped views.
    const usable = (p: MapPin) => Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
      !(p.lat === 0 && p.lng === 0) && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
    const clean = list.filter(usable);
    const self = clean.find((p) => p.kind === "self");
    if (driverScope && self) {
      // A stale/placeholder pin from another feed must not move a driver's
      // first view across the country. 100 miles is intentionally generous.
      const maxLat = 100 / 69;
      const maxLng = 100 / (69 * Math.max(0.2, Math.cos(self.lat * Math.PI / 180)));
      return clean.filter((p) => p === self || (Math.abs(p.lat - self.lat) <= maxLat && Math.abs(p.lng - self.lng) <= maxLng));
    }
    return clean;
  }, [data, driverScope, browserSelf]);

  /* --------------------------- fit to pins (once) --------------------------- */
  const fit = useCallback((pts: MapPin[], vw: number, vh: number) => {
    if (!pts.length || vw <= 0 || vh <= 0) return;
    const self = driverScope ? pts.find((p) => p.kind === "self") : undefined;
    if (self) {
      const miles = 5;
      const latPad = miles / 69;
      const lngPad = miles / (69 * Math.max(0.2, Math.cos(self.lat * Math.PI / 180)));
      const lats = [self.lat - latPad, self.lat + latPad];
      const lngs = [self.lng - lngPad, self.lng + lngPad];
      const pad = 64;
      let z = 14;
      for (; z >= MIN_ZOOM; z--) {
        const tl = latLngToWorld(Math.max(...lats), Math.min(...lngs), z);
        const br = latLngToWorld(Math.min(...lats), Math.max(...lngs), z);
        if (br.x - tl.x <= vw - pad * 2 && br.y - tl.y <= vh - pad * 2) break;
      }
      setZoom(z);
      setCenter({ lat: self.lat, lng: self.lng });
      return;
    }
    const lats = pts.map((p) => p.lat);
    const lngs = pts.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const pad = 64;
    let z = FIT_MAX_ZOOM;
    for (; z >= MIN_ZOOM; z--) {
      const tl = latLngToWorld(maxLat, minLng, z);
      const br = latLngToWorld(minLat, maxLng, z);
      if (br.x - tl.x <= vw - pad * 2 && br.y - tl.y <= vh - pad * 2) break;
    }
    setZoom(z);
    setCenter({ lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 });
  }, []);
  const pinsKey = pins.map((p) => p.id).sort().join("|");
  const fittedRef = useRef<string>("");
  useEffect(() => {
    if (!viewport || pins.length === 0) return;
    if (fittedRef.current === pinsKey) return;
    fittedRef.current = pinsKey;
    fit(pins, viewport.w, viewport.h);
  }, [pinsKey, pins, viewport, fit]);

  /* ------------------------------- tile geometry ------------------------------- */
  const geo = useMemo(() => {
    if (!viewport) return null;
    const cw = latLngToWorld(center.lat, center.lng, zoom);
    const left = cw.x - viewport.w / 2;
    const top = cw.y - viewport.h / 2;
    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((left + viewport.w) / TILE);
    const y0 = Math.floor(top / TILE);
    const y1 = Math.floor((top + viewport.h) / TILE);
    const span = Math.pow(2, zoom);
    const tiles: { key: string; px: number; py: number; src: string }[] = [];
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const wx = ((tx % span) + span) % span; // wrap around the antimeridian
        if (ty < 0 || ty >= span) continue; // above/below the world — no tiles
        tiles.push({ key: `${zoom}/${tx}/${ty}`, px: tx * TILE - left, py: ty * TILE - top, src: `${OSM}/${zoom}/${wx}/${ty}.png` });
      }
    }
    const markers = pins.map((p) => {
      const w = latLngToWorld(p.lat, p.lng, zoom);
      return { pin: p, px: w.x - left, py: w.y - top };
    });
    return { tiles, markers };
  }, [viewport, center, zoom, pins]);

  /* -------------------------------- interaction -------------------------------- */
  const panBy = (dx: number, dy: number) => {
    const g = geomRef.current;
    if (!g.viewport) return;
    const cw = latLngToWorld(g.center.lat, g.center.lng, g.zoom);
    setCenter(worldToLatLng(cw.x - dx, cw.y - dy, g.zoom));
  };
  const zoomBy = (dir: 1 | -1) => {
    const g = geomRef.current;
    const vp = g.viewport;
    if (!vp) return;
    const next = zoomAtPoint({ center: g.center, zoom: g.zoom, viewport: vp }, { x: vp.w / 2, y: vp.h / 2 }, clamp(g.zoom + dir, MIN_ZOOM, MAX_ZOOM));
    setCenter(next.center);
    setZoom(next.zoom);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointersRef.current.size === 1) {
      const cw = latLngToWorld(center.lat, center.lng, zoom);
      dragRef.current = { sx: e.clientX, sy: e.clientY, cwx: cw.x, cwy: cw.y, startedAt: Date.now(), moved: false };
    } else if (pointersRef.current.size === 2) {
      dragRef.current = null;
      pinchUsedRef.current = true;
      const pts = [...pointersRef.current.values()];
      pinchRef.current = {
        startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        zoom,
      };
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current;
    if (pinch) {
      const pts = [...pointersRef.current.values()];
      if (pts.length === 2) {
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinch.startDist > 0) {
          const g = geomRef.current;
          const vp = g.viewport;
          const target = clamp(pinch.zoom + Math.round(Math.log2(dist / pinch.startDist)), MIN_ZOOM, MAX_ZOOM);
          if (vp && target !== g.zoom) {
            const rect = mapRef.current?.getBoundingClientRect();
            const anchor = rect ? { x: (pts[0].x + pts[1].x) / 2 - rect.left, y: (pts[0].y + pts[1].y) / 2 - rect.top } : { x: vp.w / 2, y: vp.h / 2 };
            const next = zoomAtPoint({ center: g.center, zoom: g.zoom, viewport: vp }, anchor, target);
            setCenter(next.center);
            setZoom(next.zoom);
          }
        }
      }
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 10) d.moved = true;
    panBy(e.clientX - d.sx, e.clientY - d.sy);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      // A tap is intentionally strict: short press, <10px movement, and no
      // drag/pinch. This keeps map gestures from triggering sheet actions.
      const d = dragRef.current;
      const onControl = e.target instanceof Element && e.target.closest("button") != null;
      const elapsed = d ? Date.now() - d.startedAt : Infinity;
      const distance = d ? Math.hypot(e.clientX - d.sx, e.clientY - d.sy) : Infinity;
      if (d && onTap && !pinchUsedRef.current && !d.moved && elapsed <= 250 && distance < 10 && !onControl) onTap();
      pinchUsedRef.current = false;
      dragRef.current = null;
    }
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    pinchRef.current = null;
    dragRef.current = null;
  };

  /* ------------------------------ tile failures ------------------------------ */
  const onTileLoad = (key: string) => {
    tileOkRef.current.add(key);
    if (tilesUnavailable) setTilesUnavailable(false);
  };
  const onTileError = (key: string) => {
    tileFailRef.current.add(key);
    if (tileOkRef.current.size === 0) setTilesUnavailable(true);
  };

  /* ------------------------------ derived counts ------------------------------ */
  const freshDrivers = pins.filter((p) => p.kind === "driver" && p.fresh).length;
  const staleDrivers = pins.filter((p) => p.kind === "driver" && !p.fresh).length;
  const jobPins = pins.filter((p) => p.kind === "job").length;
  const hasSelf = pins.some((p) => p.kind === "self");
  const waitingForGps = pins.length > 0 && freshDrivers === 0 && staleDrivers === 0 && hasSelf === false;
  const now = Date.now();

  /* ------------------------------- empty states ------------------------------- */
  // Loading: keep the tile skeleton (pulse) — never swap in a card mid-load.
  if (data === null && !error) {
    return (
      <div className={`${heightClass} animate-pulse bg-ink-100/70 ${isHero ? "" : "rounded-xl"}`} aria-busy="true" />
    );
  }
  // Feed error (fetch failure OR a null resolve — see load()): an explicit,
  // retryable error state. Never an eternal skeleton, never a silent blank.
  if (data === null && error) {
    return (
      <div className={`${heightClass} grid place-items-center ${isHero ? "" : "rounded-xl border border-ink-100 bg-surface"}`} role="alert">
        <div className="flex max-w-xs flex-col items-center gap-2 p-6 text-center">
          <Radar className="size-6 text-amber-600" aria-hidden="true" />
          <p className="text-sm font-bold text-ink-700">{emptyTitle}</p>
          <p className="text-xs leading-relaxed text-ink-500">
            We couldn&apos;t load live positions. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={() => void load(false)}
            className="mt-1 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-500 px-4 text-xs font-bold text-white transition-colors hover:bg-brand-600"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }
  // NOTE: no early return for pins.length === 0 — the street map always renders
  // (owner 2026-08-11); an honest overlay note covers the zero-data case below.

  return (
    <Card className={`overflow-hidden p-0 ${isHero ? "h-full border-0 shadow-none" : ""}`}>
      {/* header: live counts + waiting-for-GPS note (hero: chrome omitted) */}
      {!isHero && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-ink-500">
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success-500" /> {freshDrivers} live</span>
            {staleDrivers > 0 && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-ink-300" /> {staleDrivers} stale</span>}
            <span className="flex items-center gap-1.5"><MapPin className="size-3.5 text-danger-500" /> {jobPins} jobs</span>
            {hasSelf && <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-blue-500" /> you</span>}
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && <span className="text-[11px] tabular-nums text-ink-400">updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
            <button
              type="button"
              aria-label="Refresh map"
              onClick={() => void load(false)}
              className="grid size-7 place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-ink-50 hover:text-ink-600"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {!isHero && waitingForGps && (
        <p className="flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-800">
          <Radar className="size-3.5 shrink-0" /> Waiting for driver GPS — no fresh pings in the last 2 minutes.
        </p>
      )}

      {/* the map viewport */}
      <div
        ref={setupMap}
        className={`relative w-full select-none overflow-hidden bg-ink-50 ${heightClass} ${isHero ? "h-full" : ""}`}
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        role="application"
        aria-label="Live map"
      >
        {geo && !tilesUnavailable ? (
          <>
            {geo.tiles.map((t) => (
              <img
                key={t.key}
                src={t.src}
                alt=""
                draggable={false}
                referrerPolicy="no-referrer"
                loading="eager"
                className="pointer-events-none absolute"
                style={{ left: t.px, top: t.py, width: TILE, height: TILE, imageRendering: "auto" }}
                onLoad={() => onTileLoad(t.key)}
                onError={() => onTileError(t.key)}
              />
            ))}
            {geo.markers.map((m) => (
              <MapMarker key={m.pin.id} pin={m.pin} px={m.px} py={m.py} zoom={zoom} />
            ))}
            {/* attribution — required by OSM's tile policy */}
            <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-white/85 px-1.5 py-0.5 text-[9px] font-medium text-ink-500 shadow-sm">
              © OpenStreetMap
            </span>
          </>
        ) : (
          <FallbackPlot pins={pins} tilesUnavailable={tilesUnavailable} />
        )}

        {/* honest empty note — the street map still renders; only the pins are
            missing (owner 2026-08-11). Feature 5: with a browser self fix the
            map shows "You are here" — the note yields to the real dot; a
            denied/unsupported location shows the honest location chip. */}
        {(data === null || pins.length === 0) && (
          <p className="absolute left-1/2 top-3 z-20 flex w-max max-w-[92vw] -translate-x-1/2 items-center gap-1.5 rounded-full border border-ink-200 bg-surface/95 px-3 py-1.5 text-[11px] font-semibold text-ink-600 shadow-card backdrop-blur">
            <Radar className="size-3.5 shrink-0 text-amber-600" />
            {data === null
              ? `${emptyTitle} — ${emptyBody}`
              : driverScope && browserSelfDenied
                ? "Location is off — allow location in your browser to show you on the map"
                : "No live driver positions yet — positions appear when drivers' phones ping"}
          </p>
        )}

        {/* waiting-for-GPS chip (hero: slim floating chip top-center — it is
            safety-relevant so it stays visible) */}
        {isHero && waitingForGps && (
          <p className="absolute left-1/2 top-3 z-20 flex w-max max-w-[92vw] -translate-x-1/2 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50/95 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-card backdrop-blur">
            <Radar className="size-3.5 shrink-0" /> Waiting for driver GPS — no fresh pings in the last 2 minutes.
          </p>
        )}

        {/* zoom + recenter controls */}
        <div className={`absolute right-2 top-2 flex flex-col overflow-hidden rounded-xl border border-ink-200 bg-surface shadow-card ${isHero ? "opacity-80" : ""}`}>
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)} className={`grid place-items-center text-ink-600 transition-colors duration-150 hover:bg-ink-50 ${isHero ? "size-8" : "size-9"}`}>
            <Plus className={`${isHero ? "size-3.5" : "size-4"}`} />
          </button>
          <span className="h-px bg-ink-100" />
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} className={`grid place-items-center text-ink-600 transition-colors duration-150 hover:bg-ink-50 ${isHero ? "size-8" : "size-9"}`}>
            <Minus className={`${isHero ? "size-3.5" : "size-4"}`} />
          </button>
          <span className="h-px bg-ink-100" />
          <button
            type="button"
            aria-label="Re-center map"
            onClick={() => viewport && fit(pins, viewport.w, viewport.h)}
            className={`grid place-items-center text-brand-600 transition-colors duration-150 hover:bg-brand-50 ${isHero ? "size-8" : "size-9"}`}
          >
            <LocateFixed className={`${isHero ? "size-3.5" : "size-4"}`} />
          </button>
        </div>
      </div>

      {/* legend (hero: omitted) */}
      {!isHero && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-ink-100 px-4 py-2.5 text-[11px] font-medium text-ink-500">
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-success-500 ring-2 ring-success-100" /> driver live</span>
          <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-ink-300 ring-2 ring-ink-100" /> driver stale</span>
          <span className="flex items-center gap-1.5"><MapPin className="size-3.5 text-danger-500" /> job pickup</span>
          {hasSelf && <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-blue-500 ring-2 ring-blue-100" /> you</span>}
          <span className="ml-auto hidden text-[10px] text-ink-400 sm:inline">drag · scroll/pinch to zoom</span>
        </div>
      )}

      {!isHero && showDriverList && data !== null && data.drivers.length > 0 && (
        <div className="divide-y divide-ink-100 border-t border-ink-100">
          {data.drivers.map((d) => (
            <div key={d.driverId} className="flex items-center gap-3 px-4 py-3">
              <span className={`size-2.5 shrink-0 rounded-full ${d.fresh ? "bg-success-500" : "bg-ink-300"}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink-800">{d.driverName}</p>
                <p className="text-[11px] text-ink-400">
                  {d.jobStatus ?? "no active job"} · pinged {timeAgoLabel(d.capturedAt, now)}
                </p>
              </div>
              <p className="shrink-0 text-[11px] tabular-nums text-ink-400">
                {d.lat.toFixed(4)}, {d.lng.toFixed(4)}
              </p>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- markers --------------------------------- */

function MapMarker({ pin, px, py, zoom }: { pin: MapPin; px: number; py: number; zoom: number }) {
  const showLabel = zoom >= 12;
  if (pin.kind === "job") {
    return (
      <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full" style={{ left: px, top: py }}>
        <svg viewBox="0 0 24 24" className="size-6 drop-shadow-md" aria-hidden="true">
          <path d="M12 1.8C7.5 1.8 3.9 5.4 3.9 9.9c0 5.4 8.1 12.3 8.1 12.3s8.1-6.9 8.1-12.3c0-4.5-3.6-8.1-8.1-8.1z" fill={pin.mine ? "#7c3aed" : "#e11d48"} stroke="#fff" strokeWidth="1.6" />
          <circle cx="12" cy="9.9" r="3" fill="#fff" />
        </svg>
        {showLabel && (
          <span className="absolute left-1/2 top-full mt-0.5 max-w-36 -translate-x-1/2 truncate rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-ink-700 shadow-sm">
            {pin.title}
          </span>
        )}
      </div>
    );
  }
  if (pin.kind === "self") {
    return (
      <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: px, top: py }}>
        <span className="relative grid place-items-center">
          <span className="absolute size-9 animate-ping rounded-full bg-blue-400/30" style={{ animationDuration: "2.4s" }} />
          <span className="size-4 rounded-full border-[3px] border-white bg-blue-600 shadow-md" />
        </span>
        <span className="absolute left-1/2 top-full mt-0.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">You are here</span>
      </div>
    );
  }
  // driver
  const fresh = pin.fresh !== false;
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: px, top: py }}>
      <span className="relative grid place-items-center">
        {fresh && <span className="absolute size-8 animate-ping rounded-full bg-success-400/25" style={{ animationDuration: "2.4s" }} />}
        <span className={`size-4 rounded-full border-[3px] border-white shadow-md ${fresh ? "bg-success-500" : "bg-ink-300"}`} />
      </span>
      {showLabel && (
        <span className="absolute left-1/2 top-full mt-0.5 max-w-28 -translate-x-1/2 truncate rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-ink-700 shadow-sm">
          {pin.title}
        </span>
      )}
    </div>
  );
}

/* ------------------------- fallback (tiles unreachable) ------------------------- */

function FallbackPlot({ pins, tilesUnavailable }: { pins: MapPin[]; tilesUnavailable: boolean }) {
  const W = 800;
  const H = 360;
  const PAD = 34;
  // Zero pins with unreachable tiles: nothing to plot — just the note.
  if (pins.length === 0) {
    return (
      <div className="grid h-full w-full place-items-center bg-ink-50">
        <p className="rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-sm">
          Map tiles unavailable — showing positions only
        </p>
      </div>
    );
  }
  const lats = pins.map((p) => p.lat);
  const lngs = pins.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  let spanLat = maxLat - minLat;
  let spanLng = maxLng - minLng;
  if (spanLat < 0.02) spanLat = 0.02;
  if (spanLng < 0.02) spanLng = 0.02;
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;
  const xMin = cLng - spanLng / 2 - spanLng * 0.15;
  const xMax = cLng + spanLng / 2 + spanLng * 0.15;
  const yMin = cLat - spanLat / 2 - spanLat * 0.15;
  const yMax = cLat + spanLat / 2 + spanLat * 0.15;
  const px = (lng: number) => PAD + ((lng - xMin) / (xMax - xMin)) * (W - PAD * 2);
  const py = (lat: number) => H - PAD - ((lat - yMin) / (yMax - yMin)) * (H - PAD * 2);
  const color = (p: MapPin) => (p.kind === "job" ? (p.mine ? "#7c3aed" : "#e11d48") : p.kind === "self" ? "#2563eb" : p.fresh === false ? "#9aa3af" : "#10b981");
  return (
    <div className="relative h-full w-full">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" role="img" aria-label="Live map (fallback)">
        <rect width={W} height={H} fill="#f8fafc" />
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={`v${f}`} x1={W * f} y1={0} x2={W * f} y2={H} stroke="#e4e7ec" strokeWidth="1" />
        ))}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={`h${f}`} x1={0} y1={H * f} x2={W} y2={H * f} stroke="#e4e7ec" strokeWidth="1" />
        ))}
        {pins.map((p) => (
          <g key={p.id}>
            {p.kind === "job" ? (
              <>
                <path d={`M${px(p.lng)} ${py(p.lat) - 16} c-4 0 -7 3.2 -7 7.2 0 4.8 7 11 7 11 s7-6.2 7-11 c0-4 -3-7.2 -7-7.2z`} fill={color(p)} stroke="#fff" strokeWidth="1.5" />
                <circle cx={px(p.lng)} cy={py(p.lat) - 9} r="2.6" fill="#fff" />
              </>
            ) : (
              <>
                <circle cx={px(p.lng)} cy={py(p.lat)} r={13} fill={color(p)} opacity={p.kind === "self" ? 0.25 : 0.15} />
                <circle cx={px(p.lng)} cy={py(p.lat)} r={6} fill={color(p)} stroke="#fff" strokeWidth="2.5" />
              </>
            )}
            <text x={px(p.lng)} y={py(p.lat) + (p.kind === "job" ? 14 : 20)} textAnchor="middle" fontSize={11} fontWeight={700} fill="#334155">
              {p.title.split(" ")[0]}
            </text>
          </g>
        ))}
      </svg>
      {tilesUnavailable && (
        <p className="absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-sm">
          Map tiles unavailable — showing positions only
        </p>
      )}
    </div>
  );
}

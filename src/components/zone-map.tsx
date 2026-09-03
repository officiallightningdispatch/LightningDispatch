/**
 * Owner Zones map — OSM raster tiles (owner-directed "Option B", 2026-09-03).
 * Replaces the TomTom Web SDK map with the same free/credential-less tile
 * source + projection/pan-zoom pattern proven in live-map.tsx (plain <img>
 * tiles under a small custom pan/zoom wrapper). Zone polygons, the demand
 * legend, click-to-select, draw mode, and edit-mode vertex drag/midpoint-insert
 * are reimplemented over an SVG polygon overlay so visuals + interactions match
 * the previous MapLibre/TomTom behavior. If the tile host is unreachable the
 * map degrades gracefully (zones still render on a plain background with a note).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { demandLevelToColor } from "~/lib/zone-model";
import { zoneCirclePolygon } from "~/lib/zone-circle";

export type ZoneMapItem = {
  id: string;
  name: string;
  state: string;
  market: string;
  geometry: any;
  lat: number;
  lng: number;
  radiusMiles: number;
  demandLevel: number | null;
  demandSource: "set" | "computed" | "unavailable";
  status: "available" | "busy" | "reserved" | "at_capacity";
  isReserved: boolean;
  unlockJobsRequired: number;
  capacity: number | null;
  color: string | null;
  active: boolean;
};
export { zoneCirclePolygon } from "~/lib/zone-circle";

type Point = [number, number];

/* ------------------------------ projections ------------------------------ */
const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
const OSM = "https://tile.openstreetmap.org";

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

type Viewport = { w: number; h: number };
type GeoState = { center: { lat: number; lng: number }; zoom: number; viewport: Viewport };

function zoomAtPoint(
  g: GeoState,
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
function projectPoint(lat: number, lng: number, center: { lat: number; lng: number }, zoom: number, viewport: Viewport): { x: number; y: number } {
  const cw = latLngToWorld(center.lat, center.lng, zoom);
  const w = latLngToWorld(lat, lng, zoom);
  return { x: w.x - (cw.x - viewport.w / 2), y: w.y - (cw.y - viewport.h / 2) };
}
function unprojectPoint(px: number, py: number, center: { lat: number; lng: number }, zoom: number, viewport: Viewport): { lat: number; lng: number } {
  const cw = latLngToWorld(center.lat, center.lng, zoom);
  return worldToLatLng(cw.x - viewport.w / 2 + px, cw.y - viewport.h / 2 + py, zoom);
}

/* --------------------------- geometry extraction --------------------------- */
function cleanRing(ring: unknown): Point[] | null {
  if (!Array.isArray(ring)) return null;
  const pts: Point[] = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    pts.push([lng, lat]);
  }
  return pts.length >= 3 ? pts : null;
}
/** Extract a GeoJSON Polygon/MultiPolygon into polygon groups (outer ring + holes). */
function geometryPolygons(geometry: unknown): Point[][][] {
  const out: Point[][][] = [];
  if (!geometry || typeof geometry !== "object") return out;
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === "Polygon" && Array.isArray(g.coordinates)) {
    const rings = g.coordinates.map(cleanRing).filter((r): r is Point[] => r != null);
    if (rings.length) out.push(rings);
  } else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) {
    for (const poly of g.coordinates) {
      if (!Array.isArray(poly)) continue;
      const rings = poly.map(cleanRing).filter((r): r is Point[] => r != null);
      if (rings.length) out.push(rings);
    }
  }
  return out;
}
function pointInRing(lng: number, lat: number, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ------------------------------ the component ------------------------------ */

export function ZoneMap({
  zones,
  selectedZoneId,
  onSelectZone,
  onDeleteZone,
  mode = "view",
  onGeometryChange,
}: {
  zones: ZoneMapItem[];
  selectedZoneId: string | null;
  onSelectZone: (id: string | null) => void;
  onDeleteZone?: (id: string) => void;
  mode?: "view" | "draw" | "edit";
  onGeometryChange?: (geometry: any) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const handles = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<"draw" | "edit" | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const drag = useRef<{ index: number; midpoint: boolean } | null>(null);
  const frame = useRef<number | null>(null);

  // OSM tile viewport state (national default mirrors the prior TomTom view).
  const [center, setCenter] = useState<{ lat: number; lng: number }>({ lat: 38, lng: -96 });
  const [zoom, setZoom] = useState(4);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  const geomRef = useRef<GeoState>({ center, zoom, viewport: viewport ?? { w: 0, h: 0 } });
  geomRef.current = { center, zoom, viewport: viewport ?? { w: 0, h: 0 } };

  const mapDragRef = useRef<{ sx: number; sy: number; startedAt: number; moved: boolean } | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; zoom: number } | null>(null);
  const tileOkRef = useRef<Set<string>>(new Set());
  const tileFailRef = useRef<Set<string>>(new Set());

  const zonesRef = useRef(zones);
  const selectedRef = useRef(selectedZoneId);
  const pointsRef = useRef(points);
  const toolRef = useRef(tool);
  const selectRef = useRef(onSelectZone);
  const geometryChangeRef = useRef(onGeometryChange);
  zonesRef.current = zones;
  selectedRef.current = selectedZoneId;
  pointsRef.current = points;
  toolRef.current = tool;
  selectRef.current = onSelectZone;
  geometryChangeRef.current = onGeometryChange;
  const selected = zones.find((z) => z.id === selectedZoneId);

  /* ----------------------------- viewport setup ----------------------------- */
  const setupMap = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    if (!node) return;
    const r0 = node.getBoundingClientRect();
    if (r0.width > 0 && r0.height > 0) {
      setViewport((v) => (v && Math.abs(v.w - r0.width) < 1 && Math.abs(v.h - r0.height) < 1 ? v : { w: r0.width, h: r0.height }));
    }
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setViewport((v) => (v && Math.abs(v.w - r.width) < 1 && Math.abs(v.h - r.height) < 1 ? v : { w: r.width, h: r.height }));
      }
    });
    ro.observe(node);
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
      if (ref.current === node) ref.current = null;
    };
  }, []);

  /* ------------------------------- tile geometry ------------------------------ */
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
        const wx = ((tx % span) + span) % span;
        if (ty < 0 || ty >= span) continue;
        tiles.push({ key: `${zoom}/${tx}/${ty}`, px: tx * TILE - left, py: ty * TILE - top, src: `${OSM}/${zoom}/${wx}/${ty}.png` });
      }
    }
    return { tiles };
  }, [viewport, center, zoom]);

  const onTileLoad = (key: string) => {
    tileOkRef.current.add(key);
    if (tilesUnavailable) setTilesUnavailable(false);
  };
  const onTileError = (key: string) => {
    tileFailRef.current.add(key);
    if (tileOkRef.current.size === 0) setTilesUnavailable(true);
  };

  /* ----------------------------- zone paint model ----------------------------- */
  const zoneItems = useMemo(() => {
    return zones.map((z) => {
      const geometry = z.geometry ?? zoneCirclePolygon(z.lat, z.lng, z.radiusMiles);
      const demand = demandLevelToColor(z.demandLevel);
      const bucket = demand.label === "Low" ? 0 : demand.label === "Medium" ? 1 : demand.label === "High" ? 2 : 3;
      const active = z.active !== false;
      const isReserved = z.isReserved === true || z.status === "reserved";
      const selectedFlag = z.id === selectedZoneId;
      const fillColor = active ? demand.hex : "#6B7280";
      const fillOpacity = !active ? 0.12 : selectedFlag ? 0.7 : [0.55, 0.68, 0.8, 0.88][bucket];
      let outlineColor: string;
      let outlineWidth: number;
      let outlineOpacity: number;
      if (!active) {
        outlineColor = "#6B7280";
        outlineWidth = 2;
        outlineOpacity = 0.35;
      } else if (selectedFlag) {
        outlineColor = "#F27801";
        outlineWidth = 4;
        outlineOpacity = 1;
      } else if (isReserved) {
        outlineColor = "#F59E0B";
        outlineWidth = 3.5;
        outlineOpacity = 1;
      } else {
        outlineColor = z.status === "at_capacity" ? "#6B7280" : z.status === "busy" ? "#DC2626" : "#16A34A";
        outlineWidth = 2;
        outlineOpacity = 1;
      }
      return { id: z.id, geometry, fillColor, fillOpacity, outlineColor, outlineWidth, outlineOpacity };
    });
  }, [zones, selectedZoneId]);

  // SVG paths in screen px (recomputed on pan/zoom).
  const rendered = useMemo(() => {
    if (!viewport) return [];
    return zoneItems.map((item) => {
      const polygons = geometryPolygons(item.geometry);
      let d = "";
      for (const rings of polygons) {
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const q = projectPoint(ring[i][1], ring[i][0], center, zoom, viewport);
            d += `${i === 0 ? "M" : "L"}${q.x.toFixed(2)},${q.y.toFixed(2)}`;
          }
          d += "Z";
        }
      }
      return { id: item.id, d, fillColor: item.fillColor, fillOpacity: item.fillOpacity, outlineColor: item.outlineColor, outlineWidth: item.outlineWidth, outlineOpacity: item.outlineOpacity };
    }).filter((r) => r.d.length > 0);
  }, [zoneItems, viewport, center, zoom]);

  // Hit-test polygons in lat/lng space (independent of viewport).
  const hitPolygons = useMemo(() => {
    return zoneItems
      .map((item) => ({ id: item.id, outers: geometryPolygons(item.geometry).map((rings) => rings[0]).filter((r): r is Point[] => r != null) }))
      .filter((x) => x.outers.length > 0);
  }, [zoneItems]);

  // Draw preview path (draw mode, 2+ points).
  const drawPreview = useMemo(() => {
    if (tool !== "draw" || points.length < 2 || !viewport) return null;
    const closed = points.length >= 3;
    const pts = closed ? [...points, points[0]] : points;
    let d = "";
    for (let i = 0; i < pts.length; i++) {
      const q = projectPoint(pts[i][1], pts[i][0], center, zoom, viewport);
      d += `${i === 0 ? "M" : "L"}${q.x.toFixed(2)},${q.y.toFixed(2)}`;
    }
    if (closed) d += "Z";
    return d;
  }, [tool, points, viewport, center, zoom]);

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
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointersRef.current.size === 1) {
      mapDragRef.current = { sx: e.clientX, sy: e.clientY, startedAt: Date.now(), moved: false };
    } else if (pointersRef.current.size === 2) {
      mapDragRef.current = null;
      const pts = [...pointersRef.current.values()];
      pinchRef.current = { startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), zoom };
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
            const rect = ref.current?.getBoundingClientRect();
            const anchor = rect ? { x: (pts[0].x + pts[1].x) / 2 - rect.left, y: (pts[0].y + pts[1].y) / 2 - rect.top } : { x: vp.w / 2, y: vp.h / 2 };
            const next = zoomAtPoint({ center: g.center, zoom: g.zoom, viewport: vp }, anchor, target);
            setCenter(next.center);
            setZoom(next.zoom);
          }
        }
      }
      return;
    }
    const d = mapDragRef.current;
    if (!d) return;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) >= 10) d.moved = true;
    panBy(e.clientX - d.sx, e.clientY - d.sy);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) {
      const d = mapDragRef.current;
      const elapsed = d ? Date.now() - d.startedAt : Infinity;
      const distance = d ? Math.hypot(e.clientX - d.sx, e.clientY - d.sy) : Infinity;
      const isClick = !!d && !d.moved && elapsed <= 300 && distance < 10;
      mapDragRef.current = null;
      if (isClick) {
        const rect = ref.current?.getBoundingClientRect();
        const g = geomRef.current;
        if (rect && g.viewport) {
          const ll = unprojectPoint(e.clientX - rect.left, e.clientY - rect.top, g.center, g.zoom, g.viewport);
          handleClick(ll.lng, ll.lat);
        }
      }
    }
  };
  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    pinchRef.current = null;
    mapDragRef.current = null;
  };

  /* ------------------------- draw / select / edit tools ------------------------- */
  const addPoint = (p: Point) => {
    const old = pointsRef.current;
    if (old.length >= 3 && Math.abs(old[0][0] - p[0]) < 0.03 && Math.abs(old[0][1] - p[1]) < 0.03) {
      const ring = [...old, old[0]];
      geometryChangeRef.current?.({ type: "Polygon", coordinates: [ring] });
      setTool(null);
      return;
    }
    setPoints([...old, p]);
  };
  const handleClick = (lng: number, lat: number) => {
    if (toolRef.current === "draw") {
      addPoint([lng, lat]);
      return;
    }
    for (let i = hitPolygons.length - 1; i >= 0; i--) {
      const hp = hitPolygons[i];
      for (const outer of hp.outers) {
        if (pointInRing(lng, lat, outer)) {
          selectRef.current(hp.id);
          return;
        }
      }
    }
  };

  const start = (t: "draw" | "edit") => {
    setTool(t);
    if (t === "draw") setPoints([]);
    if (t === "edit" && selected?.geometry) {
      const r = selected.geometry.coordinates?.[0] ?? [];
      setPoints(r.slice(0, -1));
    }
  };
  const finish = () => {
    setTool(null);
    setPoints([]);
    drag.current = null;
    if (frame.current) cancelAnimationFrame(frame.current);
  };
  function emit(next: Point[], final = false) {
    setPoints(next);
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const ring = [...next, next[0]];
      geometryChangeRef.current?.({ type: "Polygon", coordinates: [ring] });
      if (final) frame.current = null;
    });
  }
  function moveDrag(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !ref.current) return;
    e.preventDefault();
    const rect = ref.current.getBoundingClientRect();
    const g = geomRef.current;
    if (!g.viewport) return;
    const ll = unprojectPoint(e.clientX - rect.left, e.clientY - rect.top, g.center, g.zoom, g.viewport);
    const next = [...pointsRef.current];
    if (d.midpoint) {
      next.splice(d.index, 0, [ll.lng, ll.lat]);
      drag.current = { index: d.index, midpoint: false };
    } else {
      next[d.index] = [ll.lng, ll.lat];
    }
    emit(next);
  }
  function endDrag() {
    if (!drag.current) return;
    const next = [...pointsRef.current];
    geometryChangeRef.current?.({ type: "Polygon", coordinates: [[...next, next[0]]] });
    drag.current = null;
  }
  function renderHandles() {
    const el = handles.current;
    if (!el || tool !== "edit" || points.length < 3) {
      if (el) el.replaceChildren();
      return;
    }
    el.replaceChildren();
    const g = geomRef.current;
    if (!g.viewport) return;
    const add = (p: Point, index: number, midpoint: boolean) => {
      const q = projectPoint(p[1], p[0], g.center, g.zoom, g.viewport);
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-label", midpoint ? "Insert polygon vertex" : "Move polygon vertex");
      b.style.cssText = `position:absolute;left:${q.x}px;top:${q.y}px;transform:translate(-50%,-50%);width:48px;height:48px;cursor:grab;background:transparent;border:0;padding:0;z-index:3;pointer-events:auto;`;
      const dot = document.createElement("span");
      dot.style.cssText = `display:block;margin:auto;width:${midpoint ? 10 : 12}px;height:${midpoint ? 10 : 12}px;border-radius:9999px;background:#fff;border:${midpoint ? "2px solid #B3B3BB" : "3px solid #F27801"};`;
      b.append(dot);
      b.onpointerdown = (e) => {
        drag.current = { index, midpoint };
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      };
      el.append(b);
    };
    points.forEach((p, i) => {
      add(p, i, false);
      const n = points[(i + 1) % points.length];
      add([(p[0] + n[0]) / 2, (p[1] + n[1]) / 2], i + 1, true);
    });
  }

  useEffect(() => {
    if (mode === "edit" && selected?.geometry && tool === null) {
      const r = selected.geometry.coordinates?.[0] ?? [];
      setPoints(r.slice(0, -1));
      setTool("edit");
    }
    if (mode === "view") finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, selectedZoneId]);

  useEffect(() => {
    renderHandles();
    return () => {
      handles.current?.replaceChildren();
      drag.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, points, selectedZoneId, zoom, center, viewport]);

  return (
    <div ref={setupMap} className="relative min-h-[360px] overflow-hidden rounded-2xl border border-ink-100 bg-ink-50" aria-label="Dispatch zone map">
      {/* pan/zoom interaction layer (tiles + polygon overlay) */}
      <div
        className="absolute inset-0 z-0 select-none overflow-hidden"
        style={{ touchAction: "none", cursor: tool === "draw" ? "crosshair" : "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        role="application"
        aria-label="Dispatch zone map"
      >
        {geo?.tiles.map((t) => (
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
        {viewport && (rendered.length > 0 || drawPreview) && (
          <svg width={viewport.w} height={viewport.h} className="pointer-events-none absolute left-0 top-0" aria-hidden="true">
            {rendered.map((r) => (
              <path
                key={r.id}
                d={r.d}
                fill={r.fillColor}
                fillOpacity={r.fillOpacity}
                fillRule="evenodd"
                stroke={r.outlineColor}
                strokeWidth={r.outlineWidth}
                strokeOpacity={r.outlineOpacity}
                strokeLinejoin="round"
              />
            ))}
            {drawPreview && (
              <path d={drawPreview} fill="#F27801" fillOpacity={0.18} fillRule="evenodd" stroke="#F27801" strokeWidth={2} strokeDasharray="4 4" strokeLinejoin="round" />
            )}
          </svg>
        )}
        <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-white/85 px-1.5 py-0.5 text-[9px] font-medium text-ink-500 shadow-sm">
          © OpenStreetMap
        </span>
      </div>

      {/* vertex-handle overlay (edit mode) */}
      <div ref={handles} className="pointer-events-none absolute inset-0 z-20" onPointerMove={moveDrag} onPointerUp={endDrag} />

      {tilesUnavailable && (
        <div className="absolute inset-x-0 top-2 z-20 mx-auto w-fit rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold text-amber-800 shadow-sm">
          Map tiles unavailable — zones still shown
        </div>
      )}

      <div className="absolute left-3 top-3 z-10 rounded-xl border border-ink-100 bg-white p-3 text-xs shadow-[0_2px_8px_rgba(14,14,17,.10)]">
        <strong>Current demand</strong>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {[["#FDB268", "Low"], ["#F27801", "Medium"], ["#DC2626", "High"], ["#991B1B", "Very high"]].map(([c, l]) => (
            <span key={l} className="flex items-center gap-1">
              <i className="size-4 rounded-sm" style={{ background: c }} />
              {l}
            </span>
          ))}
        </div>
      </div>

      {mode !== "view" && (
        <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-xl border border-ink-100 bg-white p-1 shadow">
          <Tool label="Draw polygon" active={tool === "draw"} onClick={() => start("draw")}>＋</Tool>
          <Tool label="Edit zone" active={tool === "edit"} onClick={() => start("edit")}>✎</Tool>
          <Tool label="Delete zone" onClick={() => { if (selectedZoneId) onDeleteZone?.(selectedZoneId); }}>×</Tool>
          <Tool label="Exit editing" onClick={finish}>↩</Tool>
        </div>
      )}

      <div className="absolute bottom-3 right-3 z-10 flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white shadow-[0_2px_8px_rgba(14,14,17,.10)]">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)} className="grid size-9 place-items-center text-lg font-bold text-ink-600 transition-colors hover:bg-ink-50">+</button>
        <span className="h-px bg-ink-100" />
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} className="grid size-9 place-items-center text-lg font-bold text-ink-600 transition-colors hover:bg-ink-50">−</button>
      </div>

      {tool === "draw" && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-xl bg-white p-2 text-xs shadow">
          Tap 3+ points; tap first to close <button className="h-9 rounded-lg border px-3" onClick={finish}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick} className={`h-11 w-11 rounded-xl text-xl ${active ? "bg-[#FFF4EA] text-[#B15000] ring-2 ring-inset ring-[#F27801]" : ""}`}>{children}</button>;
}

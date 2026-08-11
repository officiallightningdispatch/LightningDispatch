/**
 * Live driver map (milestone #3): current positions of checked-in drivers with
 * recent pings, plotted on a lightweight SVG plot scaled by lat/lng bounds
 * (zero new deps — no Leaflet). Stale = last ping older than 2 minutes. The
 * route /owner/drivers renders it; data comes from the org-scoped
 * getDriverLocations server fn (owner/admin/dispatcher).
 */
import { MapPin, Navigation, Radar, RefreshCw, Truck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState } from "~/components/ui";
import { getDriverLocations, type DriverLocationRow } from "~/data/driver-gps";

const STALE_MS = 2 * 60 * 1000; // >2 min since ping → stale marker

const JOB_BADGE: Record<string, { label: string; badge: string }> = {
  offered: { label: "Offered", badge: "bg-amber-100 text-amber-700" },
  accepted: { label: "Accepted", badge: "bg-blue-100 text-blue-700" },
  en_route: { label: "En route", badge: "bg-violet-100 text-violet-700" },
  arrived: { label: "Arrived", badge: "bg-brand-100 text-brand-700" },
  completed: { label: "Done", badge: "bg-emerald-100 text-emerald-700" },
  cancelled: { label: "Cancelled", badge: "bg-danger-100 text-danger-600" },
};

export function LiveDriverMap() {
  const [rows, setRows] = useState<DriverLocationRow[] | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const r = await getDriverLocations();
      setRows(r);
      setLastUpdated(new Date());
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(true);
    const t = setInterval(() => void load(true), 15000); // live view — 15s refresh
    return () => clearInterval(t);
  }, [load]);

  const now = Date.now();
  const fresh = (rows ?? []).filter((r) => now - new Date(r.capturedAt).getTime() <= STALE_MS);
  const stale = (rows ?? []).filter((r) => now - new Date(r.capturedAt).getTime() > STALE_MS);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm text-ink-500">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success-500" /> {fresh.length} live</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-ink-300" /> {stale.length} stale</span>
          {lastUpdated && <span className="text-xs text-ink-400">updated {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load(false)} disabled={loading}>
          <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {rows === null ? (
        <div className="h-80 animate-pulse rounded-2xl bg-ink-100/70" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No driver positions yet"
          body="Once drivers are on a job with the contractor app open, their live position appears here every 20 seconds."
        />
      ) : (
        <DriverPlot rows={rows} now={now} />
      )}

      {(rows?.length ?? 0) > 0 && (
        <Card className="divide-y divide-ink-100">
          {[...fresh, ...stale].map((r) => <DriverRow key={r.driverId} row={r} now={now} />)}
        </Card>
      )}
    </div>
  );
}

/* ------------------------------- the SVG plot ------------------------------- */

function DriverPlot({ rows, now }: { rows: DriverLocationRow[]; now: number }) {
  const W = 800, H = 380, PAD = 36;
  const lats = rows.map((r) => r.lat), lngs = rows.map((r) => r.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // Pad bounds so a single driver is centered, not pinned to a corner; also a
  // floor span so two drivers 5 m apart don't explode the scale.
  let spanLat = maxLat - minLat, spanLng = maxLng - minLng;
  const floorLat = 0.02, floorLng = 0.02;
  if (spanLat < floorLat) spanLat = floorLat;
  if (spanLng < floorLng) spanLng = floorLng;
  const cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
  const xMin = cLng - spanLng / 2 - spanLng * 0.15, xMax = cLng + spanLng / 2 + spanLng * 0.15;
  const yMin = cLat - spanLat / 2 - spanLat * 0.15, yMax = cLat + spanLat / 2 + spanLat * 0.15;
  const px = (lng: number) => PAD + ((lng - xMin) / (xMax - xMin)) * (W - PAD * 2);
  const py = (lat: number) => H - PAD - ((lat - yMin) / (yMax - yMin)) * (H - PAD * 2);
  // Equirectangular grid every ~0.02° (approx 1.4 mi) across the visible box.
  const gridLines = [];
  for (let g = Math.ceil(xMin / 0.02) * 0.02; g <= xMax; g += 0.02) gridLines.push({ x: px(g), vertical: true });
  for (let g = Math.ceil(yMin / 0.02) * 0.02; g <= yMax; g += 0.02) gridLines.push({ y: py(g), vertical: false });
  return (
    <Card className="overflow-hidden p-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-80 w-full bg-ink-50/60" role="img" aria-label="Live driver map">
        {gridLines.map((l, i) =>
          l.vertical ? <line key={i} x1={l.x} y1={PAD} x2={l.x} y2={H - PAD} stroke="#e4e7ec" strokeWidth="1" />
            : <line key={i} x1={PAD} y1={l.y} x2={W - PAD} y2={l.y} stroke="#e4e7ec" strokeWidth="1" />,
        )}
        {rows.map((r) => {
          const isStale = now - new Date(r.capturedAt).getTime() > STALE_MS;
          const x = px(r.lng), y = py(r.lat);
          const color = isStale ? "#9aa3af" : "#10b981";
          return (
            <g key={r.driverId} role="img" aria-label={`${r.driverName}${isStale ? " (stale)" : ""}`}>
              {!isStale && <circle cx={x} cy={y} r={16} fill={color} opacity={0.15} />}
              <circle cx={x} cy={y} r={7} fill={color} stroke="#fff" strokeWidth={2.5} />
              <text x={x} y={y - 13} textAnchor="middle" fontSize={12} fontWeight={700} fill="#334155">{r.driverName.split(" ")[0]}</text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-4 border-t border-ink-100 px-4 py-2.5 text-[11px] font-medium text-ink-500">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-success-500 ring-2 ring-success-100" /> live (ping &lt; 2 min)</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full bg-ink-300 ring-2 ring-ink-100" /> stale (no ping &gt; 2 min)</span>
        <span className="ml-auto flex items-center gap-1"><MapPin className="size-3.5" /> scaled by GPS bounds — no map tiles</span>
      </div>
    </Card>
  );
}

/* --------------------------------- the list --------------------------------- */

function timeAgoLabel(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function DriverRow({ row, now }: { row: DriverLocationRow; now: number }) {
  const isStale = now - new Date(row.capturedAt).getTime() > STALE_MS;
  const jobMeta = row.jobStatus ? (JOB_BADGE[row.jobStatus] ?? { label: row.jobStatus, badge: "bg-ink-100 text-ink-600" }) : null;
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-500">
        <Truck className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold text-ink-800">
          {row.driverName}
          {isStale
            ? <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-bold text-ink-500">STALE</span>
            : <span className="flex items-center gap-1 rounded-full bg-success-50 px-2 py-0.5 text-[11px] font-bold text-success-700"><span className="size-1.5 animate-pulse rounded-full bg-success-500" /> LIVE</span>}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-500">
          {row.lat.toFixed(5)}, {row.lng.toFixed(5)}
          {row.accuracy != null ? ` · ±${Math.round(row.accuracy)} m` : ""}
          {" "}· pinged {timeAgoLabel(row.capturedAt, now)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {jobMeta ? (
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${jobMeta.badge}`}>
            <Navigation className="size-3" /> {jobMeta.label}
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-ink-50 px-2.5 py-1 text-xs font-semibold text-ink-400">No active job</span>
        )}
        {row.jobCustomer && <p className="mt-1 max-w-40 truncate text-[11px] text-ink-400">{row.jobCustomer}</p>}
      </div>
    </div>
  );
}

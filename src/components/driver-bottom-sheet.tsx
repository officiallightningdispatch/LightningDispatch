/**
 * DriverBottomSheet — the Uber-style draggable bottom sheet (driver portal R2,
 * spec §b/§c item 5). Zero-dependency (no headless-ui), like the map.
 *
 * Controlled snap: the page owns `snapIndex` (so tapping the map can expand
 * the sheet), the sheet owns the drag gesture. Snap fractions are viewport
 * heights (e.g. [0.38, 0.78]); the sheet floats ABOVE the bottom tab bar and
 * never covers it. On md+ the sheet becomes a static card in flow (desktop
 * "map + sheet" column look) and dragging is disabled.
 *
 * The mobile bottom offset accounts for the FULL tab-bar height including the
 * iOS safe area: 44px content (min-h-11) + 8px padding (p-1) + safe-area, i.e.
 * calc(3.25rem + env(safe-area-inset-bottom)). The drag clamp uses the same
 * total (NAV_BAR_CONTENT_PX + measured safe-area) so dragging can never pull
 * the sheet over the nav row.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Nav-bar content height above the safe area: 44px (min-h-11) + 8px (p-1) = 52px.
 *  The safe-area portion is added at runtime via env(safe-area-inset-bottom) and
 *  its JS measurement (see safeAreaInsetBottomPx). */
const NAV_BAR_CONTENT_PX = 52;

let safeAreaMeasured = false;
let cachedSafeAreaPx = 0;
/** Read the real iOS bottom safe-area inset in px (0 elsewhere). Measured once
 *  per page via a hidden probe using env(safe-area-inset-bottom), so the drag
 *  clamp matches the CSS `bottom` offset exactly on every iPhone size. */
function safeAreaInsetBottomPx(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 0;
  if (!safeAreaMeasured) {
    safeAreaMeasured = true;
    try {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;pointer-events:none;height:env(safe-area-inset-bottom);";
      document.body.appendChild(probe);
      cachedSafeAreaPx = probe.getBoundingClientRect().height || 0;
      probe.remove();
    } catch {
      cachedSafeAreaPx = 0;
    }
  }
  return cachedSafeAreaPx;
}

/** Total bottom offset the sheet must sit above, in px (matches the CSS). */
function navBarTotalOffsetPx(): number {
  return NAV_BAR_CONTENT_PX + safeAreaInsetBottomPx();
}

export function DriverBottomSheet({
  snapPoints,
  snapIndex,
  onSnapChange,
  children,
  className = "",
  label = "Job details",
}: {
  /** Ascending viewport fractions, e.g. [0.38, 0.78]. */
  snapPoints: number[];
  snapIndex: number;
  onSnapChange: (index: number) => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [dragPx, setDragPx] = useState<number | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<{ startY: number; startPx: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const fraction = snapPoints[snapIndex] ?? snapPoints[0] ?? 0.4;

  const onHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    const root = rootRef.current;
    if (!root) return;
    gestureRef.current = { startY: e.clientY, startPx: root.getBoundingClientRect().height };
    root.setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g) return;
    const next = g.startPx + (e.clientY - g.startY);
    const maxPx = window.innerHeight - navBarTotalOffsetPx(); // keep above the full tab bar (incl. safe area)
    setDragPx(Math.max(120, Math.min(maxPx, next)));
  };
  const onHandlePointerUp = (_e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || isDesktop) return;
    const endPx = dragPx ?? g.startPx;
    const pxPerSnap = snapPoints.map((f) => f * window.innerHeight);
    let target = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pxPerSnap.length; i++) {
      const d = Math.abs(pxPerSnap[i] - endPx);
      if (d < best) { best = d; target = i; }
    }
    setDragPx(null);
    if (target !== snapIndex) onSnapChange(target);
  };
  const onHandleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && snapIndex !== 0) {
      e.preventDefault();
      onSnapChange(0);
    }
  };

  const mobileHeight = dragPx != null ? dragPx : `calc(${fraction * 100}dvh)`;
  return (
    <div
      ref={rootRef}
      aria-label={label}
      className={`rounded-t-3xl bg-surface shadow-[0_-8px_24px_rgba(14,14,17,0.10)] ${
        isDesktop
          ? "static mx-auto mb-8 mt-4 w-full max-w-3xl rounded-2xl shadow-card"
          : "fixed inset-x-0 z-30"
      } ${className}`}
      style={
        isDesktop
          ? undefined
          : {
              height: mobileHeight,
              bottom: `calc(${NAV_BAR_CONTENT_PX}px + env(safe-area-inset-bottom))`,
              transition: dragPx != null ? "none" : "height .25s ease",
            }
      }
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={snapIndex > 0}
        aria-label={`${label} — ${snapIndex > 0 ? "expanded" : "collapsed"}`}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={() => { gestureRef.current = null; setDragPx(null); }}
        onKeyDown={onHandleKeyDown}
        className="flex shrink-0 touch-none items-center justify-center py-2.5"
        style={{ touchAction: "none" }}
      >
        <span className="h-1 w-8 rounded-full bg-ink-200" />
      </div>
      <div className={`min-h-0 overflow-y-auto px-4 pb-4 ${isDesktop ? "pb-2" : ""}`} style={{ height: "calc(100% - 2.5rem)" }}>
        {children}
      </div>
    </div>
  );
}

/** Small helper: read the current snap fraction a page needs (not exported as
 *  state — the page already owns snapIndex). Kept for symmetry/docs. */
export const bottomSheetSnapFraction = (snapPoints: number[], index: number): number =>
  snapPoints[index] ?? snapPoints[0] ?? 0.4;

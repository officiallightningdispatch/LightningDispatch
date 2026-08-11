/**
 * DriverBottomSheet — the Uber-style draggable bottom sheet (driver portal R2,
 * spec §b/§c item 5). Zero-dependency (no headless-ui), like the map.
 *
 * Controlled snap: the page owns `snapIndex` (so tapping the map can expand
 * the sheet), the sheet owns the drag gesture. Snap fractions are viewport
 * heights (e.g. [0.38, 0.78]); the sheet floats ABOVE the bottom tab bar
 * (bottom-16) and never covers it. On md+ the sheet becomes a static card in
 * flow (desktop "map + sheet" column look) and dragging is disabled.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

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
    const maxPx = window.innerHeight - 72; // keep above the tab bar
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
          : "fixed inset-x-0 bottom-16 z-30"
      } ${className}`}
      style={isDesktop ? undefined : { height: mobileHeight, transition: dragPx != null ? "none" : "height .25s ease" }}
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

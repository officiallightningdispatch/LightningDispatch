/**
 * NavigateMenu — driver-portal feature batch 6 (owner-directed 2026-08-12):
 * the "navigate to customer" action opens IN-APP NAVIGATION as the DEFAULT
 * (platform-native scheme — Apple Maps on iOS, geo: on Android), with Google
 * Maps / Apple Maps / Waze as explicit options in a small bottom sheet/menu.
 *
 * Used from the trip sheet's Navigate button and the ETA hero while en route.
 * Mobile-first: a modal bottom sheet (overlay + rounded panel, floats above
 * the tab bar); on md+ it becomes a centered popover-style card.
 */
import { ExternalLink, Navigation } from "lucide-react";
import { useEffect, useState } from "react";
import { buildNavOptions } from "~/lib/navigation";

export type NavigateMenuProps = {
  open: boolean;
  onClose: () => void;
  lat: number;
  lng: number;
  /** Optional display address shown under the header. */
  address?: string;
  /** Optional title (defaults to "Navigate to customer"). */
  title?: string;
};

export function NavigateMenu({ open, onClose, lat, lng, address = "", title = "Navigate to customer" }: NavigateMenuProps) {
  const [ua, setUa] = useState("");
  useEffect(() => {
    if (typeof navigator !== "undefined") setUa(navigator.userAgent);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const options = buildNavOptions(lat, lng, ua);
  const [primary, ...rest] = options;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-950/40 backdrop-blur-[2px] md:items-center" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-t-3xl bg-surface shadow-[0_-8px_24px_rgba(14,14,17,0.16)] md:mb-0 md:rounded-2xl md:shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink-900">{title}</p>
            {address && <p className="truncate text-xs text-ink-500">{address}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-ink-100 text-ink-500 transition-colors hover:bg-ink-200"
          >
            ✕
          </button>
        </div>

        <div className="p-3">
          {primary && (
            <a
              href={primary.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 rounded-2xl bg-brand-500 p-3.5 text-white shadow-card transition-transform active:scale-[0.99]"
            >
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/20">
                <Navigation className="size-5" strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{primary.label}</span>
                <span className="block truncate text-xs text-white/85">{primary.sub}</span>
              </span>
              <ExternalLink className="size-4 shrink-0 opacity-80" aria-hidden="true" />
            </a>
          )}
          <div className="mt-2 divide-y divide-ink-100 rounded-2xl border border-ink-100">
            {rest.map((o) => (
              <a
                key={o.id}
                href={o.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-hover active:bg-ink-100/70"
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-ink-50 text-ink-600">
                  <Navigation className="size-4" strokeWidth={2} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink-800">{o.label}</span>
                  <span className="block truncate text-xs text-ink-500">{o.sub}</span>
                </span>
                <ExternalLink className="size-4 shrink-0 text-ink-400" aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

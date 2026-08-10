import {
  BatteryCharging,
  Disc3,
  Fuel,
  KeyRound,
  Truck,
  type LucideIcon,
} from "lucide-react";
import type { JobStatus, ServiceType } from "~/data/seed";

/**
 * Human labels + design-system tokens for every job lifecycle status
 * (design-spec §1). `badge` is the tinted pill pair, `dot` the small status
 * dot, `step` the stepper current-circle fill.
 */
export const JOB_STATUS_META: Record<
  JobStatus,
  { label: string; badge: string; dot: string; step: string; ring: string }
> = {
  new: {
    label: "New",
    badge: "bg-brand-50 text-brand-700",
    dot: "bg-brand-500",
    step: "bg-brand-500 border-brand-500 text-white",
    ring: "ring-brand-100",
  },
  offered: {
    label: "Offered",
    badge: "bg-accent-50 text-accent-700",
    dot: "bg-accent-500",
    step: "bg-accent-500 border-accent-500 text-white",
    ring: "ring-accent-100",
  },
  accepted: {
    label: "Accepted",
    badge: "bg-ink-100 text-ink-600",
    dot: "bg-ink-400",
    step: "bg-ink-400 border-ink-400 text-white",
    ring: "ring-ink-100",
  },
  en_route: {
    label: "En route",
    badge: "bg-info-50 text-info-700",
    dot: "bg-info-500",
    step: "bg-info-500 border-info-500 text-white",
    ring: "ring-info-100",
  },
  arrived: {
    label: "Arrived",
    badge: "bg-success-50 text-success-700",
    dot: "bg-success-500",
    step: "bg-success-500 border-success-500 text-white",
    ring: "ring-success-100",
  },
  completed: {
    label: "Completed",
    badge: "bg-ink-50 text-ink-500",
    dot: "bg-ink-300",
    step: "bg-ink-300 border-ink-300 text-white",
    ring: "ring-ink-100",
  },
};

/** Ordered lifecycle — index in this array is the job's position on the stepper. */
export const JOB_LIFECYCLE: JobStatus[] = [
  "new",
  "offered",
  "accepted",
  "en_route",
  "arrived",
  "completed",
];
export const ACTIVE_STATUSES: JobStatus[] = ["offered", "accepted", "en_route", "arrived"];
export const SERVICE_LABELS: Record<ServiceType, string> = {
  jump_start: "Jump start",
  tire_change: "Tire change",
  lockout: "Lockout",
  flatbed_tow: "Flatbed tow",
  fuel_delivery: "Fuel delivery",
};

/** Lucide icon components per service type (design-spec §4 — no emoji). */
export const SERVICE_ICONS: Record<ServiceType, LucideIcon> = {
  jump_start: BatteryCharging,
  tire_change: Disc3,
  lockout: KeyRound,
  flatbed_tow: Truck,
  fuel_delivery: Fuel,
};

export const CONFIDENCE_META: Record<
  "low" | "medium" | "high",
  { label: string; badge: string }
> = {
  high: { label: "High confidence", badge: "bg-success-100 text-success-700" },
  medium: { label: "Medium confidence", badge: "bg-accent-100 text-accent-700" },
  low: { label: "Low confidence", badge: "bg-ink-100 text-ink-600" },
};

export function nextStatus(status: JobStatus): JobStatus | null {
  const i = JOB_LIFECYCLE.indexOf(status);
  if (i < 0 || i >= JOB_LIFECYCLE.length - 1) return null;
  return JOB_LIFECYCLE[i + 1];
}

/** "just now", "3 min ago", "1 h ago", "2 d ago" */
export function timeAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const diffMs = now - new Date(iso).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "38 min" | "1 h 12 m" */
export function fmtDuration(fromIso: string | undefined, toIso: string | undefined): string {
  if (!fromIso || !toIso) return "";
  const mins = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} m`;
}

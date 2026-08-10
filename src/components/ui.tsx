import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/* --------------------------------- cards ---------------------------------- */

export function Card({
  className,
  interactive,
  children,
}: {
  className?: string;
  /** Interactive cards get a hover shadow. */
  interactive?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl border border-ink-100 bg-surface shadow-card ${
        interactive ? "transition-shadow duration-150 hover:shadow-card-hover" : ""
      } ${className ?? ""}`}
    >
      {children}
    </div>
  );
}

/* --------------------------------- buttons -------------------------------- */

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 font-semibold transition-colors duration-150 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none";

export const BTN_VARIANTS = {
  primary: "bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700",
  secondary:
    "bg-surface border border-ink-200 text-ink-700 hover:bg-hover active:scale-[0.99]",
  ghost: "text-ink-500 hover:bg-ink-50 hover:text-ink-700 active:scale-[0.99]",
  danger: "bg-danger-600 text-white hover:bg-danger-700",
  "danger-ghost": "text-danger-600 hover:bg-danger-50 active:scale-[0.99]",
} as const;

export type ButtonVariant = keyof typeof BTN_VARIANTS;

const BTN_SIZES = {
  md: "h-11 px-4 text-sm rounded-xl",
  sm: "h-9 px-3 text-[13px] rounded-lg",
  icon: "h-11 w-11 rounded-xl",
} as const;

export type ButtonSize = keyof typeof BTN_SIZES;

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`${BTN_BASE} ${BTN_VARIANTS[variant]} ${BTN_SIZES[size]} ${className ?? ""}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && (
        <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      )}
      {/* Keep the label in the layout while loading so the button doesn't jump. */}
      <span className={loading ? "invisible" : ""}>{children}</span>
    </button>
  );
}

/* ------------------------------ status badge ------------------------------ */

export function StatusBadge({
  className,
  dot,
  children,
}: {
  className: string;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex min-h-[22px] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${className}`}
    >
      {dot && <span aria-hidden="true" className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

/* -------------------------------- avatar ---------------------------------- */

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={`grid size-9 shrink-0 place-items-center rounded-full bg-ink-800 text-sm font-bold text-white ${className ?? ""}`}
    >
      {name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}

/* ------------------------------ empty state ------------------------------- */

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-200 bg-canvas/60 p-8 text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-brand-50 text-brand-600">
        <Icon className="size-6" strokeWidth={2} aria-hidden="true" />
      </span>
      <p className="text-sm font-semibold text-ink-700">{title}</p>
      {body && <p className="max-w-xs text-xs leading-relaxed text-ink-400">{body}</p>}
      {action}
    </div>
  );
}

/* ------------------------------- skeletons -------------------------------- */

export function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-2xl bg-ink-100 motion-reduce:animate-none ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}

/** Full-board loading placeholder matching the app layout. */
export function BoardSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[92px]" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonBlock key={`row-${i}`} className="h-40" />
      ))}
    </div>
  );
}

/* -------------------------------- KPI card -------------------------------- */

export function StatCard({
  label,
  value,
  detail,
  topBar,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  /** 3px brand top bar — allow on exactly ONE card per screen. */
  topBar?: boolean;
}) {
  return (
    <div className="relative rounded-2xl border border-ink-100 bg-surface p-4 shadow-card">
      {topBar && (
        <span
          aria-hidden="true"
          className="absolute left-0 right-0 top-0 h-[3px] rounded-t-2xl bg-brand-500"
        />
      )}
      <p className="text-xs font-medium text-ink-400">{label}</p>
      <p className="mt-2 text-[28px] font-extrabold leading-none tracking-tight tabular-nums text-ink-900">
        {value}
      </p>
      {detail && <p className="mt-1.5 text-[11px] text-ink-400">{detail}</p>}
    </div>
  );
}

/* ------------------------------ demo data chip ---------------------------- */

/** Yellow "demo data" chip — one of the four allowed accent usages. */
export function DemoChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-100 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-accent-700">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-accent-500" />
      {children}
    </span>
  );
}

/* --------------------------------- alerts -------------------------------- */

const ALERT_VARIANTS = {
  warning: "border-accent-200 bg-accent-50 text-accent-800",
  info: "border-info-100 bg-info-50 text-info-700",
  success: "border-success-100 bg-success-50 text-success-700",
  danger: "border-danger-100 bg-danger-50 text-danger-700",
} as const;

export function Alert({
  variant,
  children,
}: {
  variant: keyof typeof ALERT_VARIANTS;
  children: ReactNode;
}) {
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      className={`flex gap-2.5 rounded-xl border p-3.5 text-sm ${ALERT_VARIANTS[variant]}`}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/* ---------------------------------- toast --------------------------------- */

interface ToastItem {
  id: number;
  message: string;
}

const ToastContext = createContext<(message: string) => void>(() => {});
/** Fire a success toast (auto-dismisses after 3s). */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <ToastContainer toasts={toasts} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex items-center gap-2 rounded-xl bg-ink-950 px-4 py-3 text-sm font-medium text-white shadow-lg animate-[toast-in_0.2s_ease-out] motion-reduce:animate-none"
        >
          <CheckCircle2 className="size-4 shrink-0 text-brand-500" aria-hidden="true" />
          {t.message}
        </div>
      ))}
    </div>
  );
}

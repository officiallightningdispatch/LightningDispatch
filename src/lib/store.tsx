import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Contractor, ContractorStatus, Job } from "~/data/seed";
import {
  advanceJob as advanceJobServer,
  assignJob as assignJobServer,
  declineJob as declineJobServer,
  getDispatchData,
  resetDemo as resetDemoServer,
  setContractorStatus as setContractorStatusServer,
  type CommandResult,
  type DispatchData,
} from "~/data/server";
import { JOB_LIFECYCLE } from "~/lib/job-ui";

/**
 * Shared client-side store for the whole demo (dispatcher, contractor, owner).
 *
 * - Initialized ONCE from the server (`getDispatchData`) on first use.
 * - Holds the full mutable app state (contractors + jobs with all status
 *   fields). Every mutation in the app goes through the actions below.
 * - In DATABASE mode every mutation is awaited against the server command
 *   layer, which enforces the job state machine and returns structured
 *   errors. In demo mode (no DATABASE_URL) mutations apply locally through
 *   the same validation rules so both modes behave identically.
 *
 * Mutation UX: each action has a per-target pending flag and a last error
 * (keyed by mutationKey()) — buttons disable while pending and show the error
 * inline with a retry path (re-invoking the action retries).
 *
 * Timestamps: re-anchoring (so the demo always looks "live") applies ONLY in
 * demo mode. In database mode the persisted timestamps are real and are shown
 * exactly as stored — never shifted.
 */

const STORAGE_KEY = "lightning-dispatch-store-v1";

export interface DispatchState {
  contractors: Contractor[];
  jobs: Job[];
}

type DispatchAction =
  | { type: "hydrate"; payload: DispatchState }
  | { type: "assignJob"; jobId: string; contractorId: string }
  | { type: "advanceJob"; jobId: string }
  | { type: "declineJob"; jobId: string }
  | { type: "setContractorStatus"; contractorId: string; status: ContractorStatus }
  | { type: "clear" };

const EMPTY: DispatchState = { contractors: [], jobs: [] };

function nowIso() {
  return new Date().toISOString();
}

/** Shift every job timestamp by the same delta so the newest job is ~2 min old. */
function reanchorTimes(jobs: Job[]): Job[] {
  const now = Date.now();
  if (!jobs.length) return jobs;
  const newestSeed = Math.max(...jobs.map((j) => new Date(j.createdAt).getTime()));
  const delta = now - 2 * 60_000 - newestSeed;
  const shift = (iso?: string) =>
    iso ? new Date(new Date(iso).getTime() + delta).toISOString() : undefined;
  return jobs.map((j) => ({
    ...j,
    createdAt: shift(j.createdAt)!,
    assignedAt: shift(j.assignedAt),
    arrivedAt: shift(j.arrivedAt),
    completedAt: shift(j.completedAt),
  }));
}

function reducer(state: DispatchState, action: DispatchAction): DispatchState {
  switch (action.type) {
    case "hydrate":
      return action.payload;
    case "clear":
      return EMPTY;
    case "assignJob":
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.id === action.jobId
            ? {
                ...j,
                status: "offered",
                assignedContractorId: action.contractorId,
                assignedAt: nowIso(),
              }
            : j,
        ),
      };
    case "advanceJob":
      return {
        ...state,
        jobs: state.jobs.map((j) => {
          if (j.id !== action.jobId) return j;
          const i = JOB_LIFECYCLE.indexOf(j.status);
          const next = i >= 0 && i < JOB_LIFECYCLE.length - 1 ? JOB_LIFECYCLE[i + 1] : null;
          if (!next) return j;
          return {
            ...j,
            status: next,
            arrivedAt: next === "arrived" ? nowIso() : j.arrivedAt,
            completedAt: next === "completed" ? nowIso() : j.completedAt,
          };
        }),
      };
    case "declineJob":
      // Contractor turns down an offer: return the job to the unassigned queue
      // (status "new", no contractor) so the dispatcher sees it as incoming
      // again and the AI re-recommends.
      return {
        ...state,
        jobs: state.jobs.map((j) =>
          j.id === action.jobId
            ? { ...j, status: "new", assignedContractorId: undefined, assignedAt: undefined }
            : j,
        ),
      };
    case "setContractorStatus":
      return {
        ...state,
        contractors: state.contractors.map((c) =>
          c.id === action.contractorId ? { ...c, status: action.status } : c,
        ),
      };
    default:
      return state;
  }
}

/* ------------------------- mutation key helpers ------------------------- */

export const mutationKey = {
  assign: (jobId: string) => `assign:${jobId}`,
  advance: (jobId: string) => `advance:${jobId}`,
  decline: (jobId: string) => `decline:${jobId}`,
  status: (contractorId: string) => `status:${contractorId}`,
  reset: () => "reset",
};

/* -------------------- demo-mode validation (mirrors server) -------------------- */

function demoAssignError(state: DispatchState, jobId: string, contractorId: string): string | null {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return "Job not found — refresh to resync.";
  if (job.status !== "new") {
    return `Job ${jobId} is no longer new (${job.status}) — only new jobs can be assigned.`;
  }
  const con = state.contractors.find((c) => c.id === contractorId);
  if (!con) return "Contractor not found.";
  if (con.status !== "online" && state.contractors.some((c) => c.status === "online")) {
    return `${con.name} is offline — only online contractors can take jobs while others are available.`;
  }
  return null;
}

function demoAdvanceError(state: DispatchState, jobId: string): string | null {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return "Job not found — refresh to resync.";
  if (job.status === "new") return "This job has not been assigned yet — assign it to a contractor first.";
  if (job.status === "completed") return "This job is already completed and cannot be advanced further.";
  return null;
}

function demoDeclineError(state: DispatchState, jobId: string): string | null {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return "Job not found — refresh to resync.";
  if (job.status !== "offered") {
    return `Only offered jobs can be declined — this job is ${job.status}.`;
  }
  if (!job.assignedContractorId) return "This job has no assigned contractor, so it cannot be declined.";
  return null;
}

/* --------------------------------- store --------------------------------- */

export interface DispatchStoreValue {
  state: DispatchState;
  loading: boolean;
  /** True when running the localStorage fixture mode. */
  isDemoMode: boolean;
  /** Per-action in-flight flags, keyed by mutationKey(). */
  pending: Record<string, boolean>;
  /** Per-action last error message, keyed by mutationKey() (null = none). */
  errors: Record<string, string | null>;
  /** True while the mutation for `key` is in flight. */
  isPending: (key: string) => boolean;
  /** Last error message for `key`, or null. */
  getError: (key: string) => string | null;
  /** Clear the stored error for `key` (e.g. on dismiss). */
  clearError: (key: string) => void;
  /** Assign a job to a contractor: status -> offered, assignedContractorId set. */
  assignJob: (jobId: string, contractorId: string) => Promise<boolean>;
  /** Move a job to the next lifecycle status (offered → accepted → en_route → arrived → completed). */
  advanceJob: (jobId: string) => Promise<boolean>;
  /** Contractor turns down an offer: back to status "new", unassigned, so the dispatcher re-dispatches. */
  declineJob: (jobId: string) => Promise<boolean>;
  setContractorStatus: (contractorId: string, status: ContractorStatus) => Promise<boolean>;
  /** Wipe persisted state and reload the pristine server seed. */
  resetDemo: () => Promise<boolean>;
}

const DispatchStoreContext = createContext<DispatchStoreValue | null>(null);

export function DispatchStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [loading, setLoading] = useState(true);
  const [isDemoMode, setIsDemoMode] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const loadedOnce = useRef(false);
  const dbMode = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Pending guard mirror so callbacks always read fresh in-flight state.
  const pendingRef = useRef<Record<string, boolean>>({});

  /** Apply a server payload — re-anchor ONLY in demo mode. */
  const hydrateFromServer = useCallback((data: DispatchData) => {
    const payload: DispatchState = {
      contractors: data.contractors,
      jobs: dbMode.current ? data.jobs : reanchorTimes(data.jobs),
    };
    dispatch({ type: "hydrate", payload });
    if (!dbMode.current) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch { /* demo still works in memory */ }
    }
  }, []);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    if (typeof window === "undefined") return; // SSR first paint — client effect hydrates
    void (async () => {
      // Ask the server first so a configured database always wins over stale browser state.
      let response: Awaited<ReturnType<typeof getDispatchData>>;
      try {
        response = await getDispatchData();
      } catch {
        // Server unreachable — fall back to any persisted demo state, else empty.
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as DispatchState;
            if (Array.isArray(parsed.contractors) && Array.isArray(parsed.jobs)) {
              dispatch({ type: "hydrate", payload: { contractors: parsed.contractors, jobs: reanchorTimes(parsed.jobs) } });
              setLoading(false);
              return;
            }
          }
        } catch { /* ignore */ }
        setLoading(false);
        return;
      }
      dbMode.current = response.mode === "database";
      setIsDemoMode(!dbMode.current);
      if (!dbMode.current) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as DispatchState;
            if (Array.isArray(parsed.contractors) && Array.isArray(parsed.jobs)) {
              dispatch({ type: "hydrate", payload: { contractors: parsed.contractors, jobs: reanchorTimes(parsed.jobs) } });
              setLoading(false);
              return;
            }
          }
        } catch { /* corrupt local state falls through to seed */ }
      }
      hydrateFromServer(response.data);
      setLoading(false);
    })();
  }, [hydrateFromServer]);

  // Persist every change in demo mode so refresh keeps them. In database mode
  // the database is the source of truth — nothing is written to localStorage.
  useEffect(() => {
    if (loading || !state.jobs.length || dbMode.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state, loading]);

  /** Run a mutation with pending/error bookkeeping; no-ops if already pending. */
  const run = useCallback(async (key: string, work: () => Promise<boolean>): Promise<boolean> => {
    if (pendingRef.current[key]) return false;
    pendingRef.current = { ...pendingRef.current, [key]: true };
    setPending(pendingRef.current);
    setErrors((e) => ({ ...e, [key]: null }));
    try {
      return await work();
    } finally {
      pendingRef.current = { ...pendingRef.current, [key]: false };
      setPending(pendingRef.current);
    }
  }, []);

  const fail = useCallback((key: string, message: string) => {
    setErrors((e) => ({ ...e, [key]: message }));
  }, []);

  const assignJob = useCallback(
    (jobId: string, contractorId: string) =>
      run(mutationKey.assign(jobId), async () => {
        if (dbMode.current) {
          const res: CommandResult = await assignJobServer({ data: { jobId, contractorId } });
          if (!res.ok) { fail(mutationKey.assign(jobId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        const demoErr = demoAssignError(stateRef.current, jobId, contractorId);
        if (demoErr) { fail(mutationKey.assign(jobId), demoErr); return false; }
        dispatch({ type: "assignJob", jobId, contractorId });
        return true;
      }),
    [run, hydrateFromServer, fail],
  );

  const advanceJob = useCallback(
    (jobId: string) =>
      run(mutationKey.advance(jobId), async () => {
        if (dbMode.current) {
          const res: CommandResult = await advanceJobServer({ data: { jobId } });
          if (!res.ok) { fail(mutationKey.advance(jobId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        const demoErr = demoAdvanceError(stateRef.current, jobId);
        if (demoErr) { fail(mutationKey.advance(jobId), demoErr); return false; }
        dispatch({ type: "advanceJob", jobId });
        return true;
      }),
    [run, hydrateFromServer, fail],
  );

  const declineJob = useCallback(
    (jobId: string) =>
      run(mutationKey.decline(jobId), async () => {
        if (dbMode.current) {
          const job = stateRef.current.jobs.find((j) => j.id === jobId);
          const contractorId = job?.assignedContractorId;
          if (!contractorId) { fail(mutationKey.decline(jobId), "This job has no assigned contractor, so it cannot be declined."); return false; }
          const res: CommandResult = await declineJobServer({ data: { jobId, contractorId } });
          if (!res.ok) { fail(mutationKey.decline(jobId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        const demoErr = demoDeclineError(stateRef.current, jobId);
        if (demoErr) { fail(mutationKey.decline(jobId), demoErr); return false; }
        dispatch({ type: "declineJob", jobId });
        return true;
      }),
    [run, hydrateFromServer, fail],
  );

  const setContractorStatus = useCallback(
    (contractorId: string, status: ContractorStatus) =>
      run(mutationKey.status(contractorId), async () => {
        if (dbMode.current) {
          const res: CommandResult = await setContractorStatusServer({ data: { contractorId, status } });
          if (!res.ok) { fail(mutationKey.status(contractorId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        if (status !== "online" && status !== "offline") {
          fail(mutationKey.status(contractorId), "Invalid status — use online or offline.");
          return false;
        }
        dispatch({ type: "setContractorStatus", contractorId, status });
        return true;
      }),
    [run, hydrateFromServer, fail],
  );

  const resetDemo = useCallback(
    () =>
      run(mutationKey.reset(), async () => {
        if (dbMode.current) {
          const res: CommandResult = await resetDemoServer({ data: { confirm: true } });
          if (!res.ok) { fail(mutationKey.reset(), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        dispatch({ type: "clear" });
        try {
          const response = await getDispatchData();
          const payload: DispatchState = {
            contractors: response.data.contractors,
            jobs: reanchorTimes(response.data.jobs),
          };
          dispatch({ type: "hydrate", payload });
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch { /* ignore */ }
          return true;
        } catch {
          fail(mutationKey.reset(), "Reset failed — could not reload the demo seed. Refresh the page and try again.");
          return false;
        }
      }),
    [run, hydrateFromServer, fail],
  );

  const clearError = useCallback(
    (key: string) => setErrors((e) => ({ ...e, [key]: null })),
    [],
  );

  const value = useMemo<DispatchStoreValue>(
    () => ({
      state,
      loading,
      isDemoMode,
      pending,
      errors,
      isPending: (key: string) => Boolean(pending[key]),
      getError: (key: string) => errors[key] ?? null,
      clearError,
      assignJob,
      advanceJob,
      declineJob,
      setContractorStatus,
      resetDemo,
    }),
    [state, loading, isDemoMode, pending, errors, clearError, assignJob, advanceJob, declineJob, setContractorStatus, resetDemo],
  );

  return <DispatchStoreContext.Provider value={value}>{children}</DispatchStoreContext.Provider>;
}

export function useDispatchStore(): DispatchStoreValue {
  const ctx = useContext(DispatchStoreContext);
  if (!ctx) throw new Error("useDispatchStore must be used inside <DispatchStoreProvider>");
  return ctx;
}

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
import type { Contractor, Job, JobStatus } from "~/data/seed";
import { useLocation } from "@tanstack/react-router";
import {
  advanceJob as advanceJobServer,
  assignJob as assignJobServer,
  declineJob as declineJobServer,
  getDispatchData,
  reassignJob as reassignJobServer,
  setJobStatus as setJobStatusServer,
  type CommandResult,
  type DispatchData,
  type StatusPushOutcome,
} from "~/data/server";

/**
 * Shared client-side store for the database-backed dispatch UI (dispatcher, contractor, owner).
 *
 * - Initialized ONCE from the server (`getDispatchData`) on first use.
 * - Holds the full mutable app state (contractors + jobs with all status
 *   fields). Every mutation in the app goes through the actions below.
 * - In DATABASE mode every mutation is awaited against the server command
 *   layer, which enforces the job state machine and returns structured
 *   the same validation rules so both modes behave identically.
 *
 * Mutation UX: each action has a per-target pending flag and a last error
 * (keyed by mutationKey()) — buttons disable while pending and show the error
 * inline with a retry path (re-invoking the action retries).
 *
 * demo mode. In database mode the persisted timestamps are real and are shown
 * exactly as stored — never shifted.
 */


export interface DispatchState {
  contractors: Contractor[];
  jobs: Job[];
}

const EMPTY: DispatchState = { contractors: [], jobs: [] };

/** Shift every job timestamp by the same delta so the newest job is ~2 min old. */
/* ------------------------- mutation key helpers ------------------------- */

export const mutationKey = {
  assign: (jobId: string) => `assign:${jobId}`,
  reassign: (jobId: string) => `reassign:${jobId}`,
  advance: (jobId: string) => `advance:${jobId}`,
  setStatus: (jobId: string) => `set-status:${jobId}`,
  decline: (jobId: string) => `decline:${jobId}`,
  status: (contractorId: string) => `status:${contractorId}`,
  reset: () => "reset",
};

export interface DispatchStoreValue {
  state: DispatchState;
  loading: boolean;
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
  /** Owner/admin: change which contractor is on a job (owner-directed
   *  2026-08-13). The status is unchanged — only the assignment moves; the
   *  server writes Towbook + DB + audit and pushes the NEW driver. */
  reassignJob: (jobId: string, contractorId: string) => Promise<boolean>;
  /** Move a job to the next lifecycle status (offered → accepted → en_route → arrived → completed). */
  advanceJob: (jobId: string) => Promise<boolean>;
  /** Set a job to an EXACT lifecycle status (owner/admin/dispatcher) — the
   *  chosen status lands in dispatch_jobs and is pushed to Towbook; the push
   *  outcome (verified/skipped/reason) is available via getPushResult(key). */
  setJobStatus: (jobId: string, status: JobStatus) => Promise<boolean>;
  /** Last exact-status push outcome for a mutation key (from setJobStatus),
   *  or null when no push result has been recorded yet. */
  getPushResult: (key: string) => StatusPushOutcome | null;
  /** Contractor turns down an offer: back to status "new", unassigned, so the dispatcher re-dispatches. */
  declineJob: (jobId: string) => Promise<boolean>;
  /** Re-fetch org data and re-hydrate the database-backed store. */
  refresh: () => Promise<DispatchData | null>;
}

const DispatchStoreContext = createContext<DispatchStoreValue | null>(null);

export function DispatchStoreProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [state, dispatch] = useReducer(
    (current: DispatchState, action: { type: "hydrate"; payload: DispatchState }) =>
      action.type === "hydrate" ? action.payload : current,
    EMPTY,
  );
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const loadedOnce = useRef(false);
  const dbMode = useRef(false);
  // Pending guard mirror so callbacks always read fresh in-flight state.
  const pendingRef = useRef<Record<string, boolean>>({});

  /** Apply a database payload. */
  const hydrateFromServer = useCallback((data: DispatchData) => {
    const payload: DispatchState = {
      contractors: data.contractors,
      jobs: data.jobs,
    };
    dispatch({ type: "hydrate", payload });
  }, []);

  useEffect(() => {
    const publicPath = location.pathname === "/" || location.pathname === "/login" || location.pathname === "/403" || location.pathname === "/logout";
    // The dispatch store is not needed by public/auth screens. Avoid a full
    // dispatch snapshot request while the user is signing in; protected routes
    // still initialize on their first visit after authentication.
    if (publicPath) { setLoading(false); return; }
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    if (typeof window === "undefined") return; // SSR first paint — client effect hydrates
    void (async () => {
      // Ask the server first so a configured database always wins over stale browser state.
      let response: Awaited<ReturnType<typeof getDispatchData>>;
      try {
        response = await getDispatchData();
      } catch {
        dbMode.current = true;
        setLoading(false);
        return;
      }
      dbMode.current = response.mode === "database";
      if (response.mode !== "database") { setLoading(false); return; }
      hydrateFromServer(response.data);
      setLoading(false);
    })();
  }, [hydrateFromServer, location.pathname]);

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
        fail(mutationKey.assign(jobId), "Database mode is not active — this action is unavailable.");
        return false;
      }),
    [run, hydrateFromServer, fail],
  );

  const reassignJob = useCallback(
    (jobId: string, contractorId: string) =>
      run(mutationKey.reassign(jobId), async () => {
        if (dbMode.current) {
          const res: CommandResult = await reassignJobServer({ data: { jobId, contractorId } });
          if (!res.ok) { fail(mutationKey.reassign(jobId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        fail(mutationKey.reassign(jobId), "Database mode is not active — this action is unavailable.");
        return false;
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
        fail(mutationKey.advance(jobId), "Database mode is not active — this action is unavailable.");
        return false;
      }),
    [run, hydrateFromServer, fail],
  );

  // Push outcomes from the exact-status selector (setJobStatus) — kept in a ref
  // so the UI can read the outcome synchronously right after the awaited action.
  const pushRef = useRef<Record<string, StatusPushOutcome | null>>({});

  const setJobStatus = useCallback(
    (jobId: string, status: JobStatus) =>
      run(mutationKey.setStatus(jobId), async () => {
        if (dbMode.current) {
          const res = await setJobStatusServer({ data: { jobId, status } });
          if (!res.ok) { fail(mutationKey.setStatus(jobId), res.error.message); return false; }
          const outcome: StatusPushOutcome | null = "push" in res ? res.push : null;
          pushRef.current = { ...pushRef.current, [mutationKey.setStatus(jobId)]: outcome };
          hydrateFromServer(res.data);
          return true;
        }
        fail(mutationKey.setStatus(jobId), "Database mode is not active — this action is unavailable.");
        return false;
      }),
    [run, hydrateFromServer, fail],
  );

  const getPushResult = useCallback((key: string) => pushRef.current[key] ?? null, []);

  const declineJob = useCallback(
    (jobId: string) =>
      run(mutationKey.decline(jobId), async () => {
        if (dbMode.current) {
          const job = state.jobs.find((candidate) => candidate.id === jobId);
          const contractorId = job?.assignedContractorId;
          if (!contractorId) { fail(mutationKey.decline(jobId), "This job has no assigned contractor, so it cannot be declined."); return false; }
          const res: CommandResult = await declineJobServer({ data: { jobId, contractorId } });
          if (!res.ok) { fail(mutationKey.decline(jobId), res.error.message); return false; }
          hydrateFromServer(res.data);
          return true;
        }
        fail(mutationKey.decline(jobId), "Database mode is not active — this action is unavailable.");
        return false;
      }),
    [run, hydrateFromServer, fail],
  );

  const clearError = useCallback(
    (key: string) => setErrors((e) => ({ ...e, [key]: null })),
    [],
  );

  /** Live refresh (notification poll + live queue): database mode only.
   *  Demo mode returns null and never touches the local fixture. */
  const refresh = useCallback(async (): Promise<DispatchData | null> => {
    if (!dbMode.current) return null;
    try {
      const response = await getDispatchData();
      if (response.mode !== "database") return null;
      hydrateFromServer(response.data);
      return response.data;
    } catch {
      return null;
    }
  }, [hydrateFromServer]);

  const value = useMemo<DispatchStoreValue>(
    () => ({
      state,
      loading,
      pending,
      errors,
      isPending: (key: string) => Boolean(pending[key]),
      getError: (key: string) => errors[key] ?? null,
      clearError,
      assignJob,
      reassignJob,
      advanceJob,
      setJobStatus,
      getPushResult,
      declineJob,
      refresh,
    }),
    [state, loading, pending, errors, clearError, assignJob, reassignJob, advanceJob, setJobStatus, getPushResult, declineJob, refresh],
  );

  return <DispatchStoreContext.Provider value={value}>{children}</DispatchStoreContext.Provider>;
}

export function useDispatchStore(): DispatchStoreValue {
  const ctx = useContext(DispatchStoreContext);
  if (!ctx) throw new Error("useDispatchStore must be used inside <DispatchStoreProvider>");
  return ctx;
}

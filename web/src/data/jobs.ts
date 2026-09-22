import { isSampleWorkspace } from "./navigation.ts";
import { appFetch } from "./request.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { isActiveJob, type DashboardJob, type JobRequest } from "../../../src/dashboard/jobs/types.ts";

class LocalRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function localJson<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await appFetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-agentdiff": "local", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new LocalRequestError(result.error ?? `Request failed (${response.status}).`, response.status);
  return result as T;
}

export function useJobs() {
  const [job, setJob] = useState<DashboardJob | null>(null);
  const [busy, setBusy] = useState(true);
  const [checking, setChecking] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<DashboardJob | null>(null);
  const revision = useRef(0);
  const pending = useRef(false);
  const accept = useCallback((next: DashboardJob | null, locked: boolean) => {
    current.current = next;
    setJob(next);
    setBusy(locked);
    setError("");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const generation = revision.current;
      try {
        if (!pending.current) {
          const active = current.current;
          const result = isActiveJob(active)
            ? await localJson<DashboardJob>(`/api/jobs/${active!.id}`, undefined, controller.signal)
                .then((job) => ({ job, busy: isActiveJob(job) }))
                .catch((error) => {
                  // A restarted server has no in-memory job history. Rediscover its
                  // current state instead of polling an expired id indefinitely.
                  if (error instanceof LocalRequestError && error.status === 404)
                    return localJson<{ job: DashboardJob | null; busy: boolean }>(
                      "/api/jobs/status",
                      undefined,
                      controller.signal,
                    );
                  throw error;
                })
            : await localJson<{ job: DashboardJob | null; busy: boolean }>(
                "/api/jobs/status",
                undefined,
                controller.signal,
              );
          if (!controller.signal.aborted && generation === revision.current) {
            accept(result.job, result.busy);
            setChecking(false);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted && generation === revision.current) {
          setError(e instanceof Error ? e.message : "Could not check job status.");
          setChecking(false);
          setBusy(true);
        }
      } finally {
        if (!controller.signal.aborted && !isSampleWorkspace()) timer = setTimeout(poll, 1500);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accept]);
  const start = useCallback(
    async (request: JobRequest) => {
      if (pending.current) throw new Error("A job request is already being sent.");
      pending.current = true;
      revision.current++;
      setStarting(true);
      try {
        const next = await localJson<DashboardJob>(`/api/jobs/${request.kind}`, request.options);
        accept(next, isActiveJob(next));
        return next;
      } finally {
        pending.current = false;
        setStarting(false);
      }
    },
    [accept],
  );
  const cancel = useCallback(async () => {
    if (!current.current || pending.current) return;
    pending.current = true;
    revision.current++;
    try {
      const next = await localJson<DashboardJob>(`/api/jobs/${current.current.id}/cancel`, {});
      accept(next, isActiveJob(next));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancellation could not be confirmed. Checking job status…");
    } finally {
      pending.current = false;
    }
  }, [accept]);
  return { job, busy: busy || starting, checking, starting, error, start, cancel };
}
export type JobControls = ReturnType<typeof useJobs>;

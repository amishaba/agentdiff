import { isSampleWorkspace } from "./navigation.ts";
import { RequestError, requestJson } from "./request.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isActiveJob, type DashboardJob, type JobRequest } from "../../../src/dashboard/jobs/types.ts";

/** A dashboard API call; the header marks it as coming from the local page (see trustedRequest). */
export function localJson<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(url, { body, signal, headers: { "x-agentdiff": "local" } });
}

interface JobState {
  job: DashboardJob | null;
  busy: boolean;
}

const JOB_KEY = ["job"] as const;

/** The job being watched, or whatever the server is running now. */
async function fetchJobState(watched: DashboardJob | null, signal: AbortSignal): Promise<JobState> {
  if (watched && isActiveJob(watched)) {
    try {
      const job = await localJson<DashboardJob>(`/api/jobs/${watched.id}`, undefined, signal);
      return { job, busy: isActiveJob(job) };
    } catch (error) {
      // A restarted server has no in-memory job history. Rediscover its
      // current state instead of polling an expired id indefinitely.
      if (!(error instanceof RequestError && error.status === 404)) throw error;
    }
  }
  return localJson<JobState>("/api/jobs/status", undefined, signal);
}

/** The workspace's one running job: polled while the page is open, started and cancelled from here. */
export function useJobs() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: JOB_KEY,
    queryFn: ({ signal }) => fetchJobState(queryClient.getQueryData<JobState>(JOB_KEY)?.job ?? null, signal),
    refetchInterval: isSampleWorkspace() ? false : 1500,
    retry: false,
  });
  const sending = useRef(false);
  const [starting, setStarting] = useState(false);
  const [cancelError, setCancelError] = useState("");
  useEffect(() => setCancelError(""), [status.dataUpdatedAt]);
  // A start or cancel answers with the job's newest state; a poll still in flight would overwrite it with an older one.
  const accept = useCallback(
    async (job: DashboardJob) => {
      await queryClient.cancelQueries({ queryKey: JOB_KEY });
      queryClient.setQueryData<JobState>(JOB_KEY, { job, busy: isActiveJob(job) });
    },
    [queryClient],
  );
  const start = useCallback(
    async (request: JobRequest) => {
      if (sending.current) throw new Error("A job request is already being sent.");
      sending.current = true;
      setStarting(true);
      try {
        const next = await localJson<DashboardJob>(`/api/jobs/${request.kind}`, request.options);
        await accept(next);
        return next;
      } finally {
        sending.current = false;
        setStarting(false);
      }
    },
    [accept],
  );
  const cancel = useCallback(async () => {
    const job = queryClient.getQueryData<JobState>(JOB_KEY)?.job;
    if (!job || sending.current) return;
    sending.current = true;
    try {
      await accept(await localJson<DashboardJob>(`/api/jobs/${job.id}/cancel`, {}));
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : "Cancellation could not be confirmed. Checking job status…");
    } finally {
      sending.current = false;
    }
  }, [accept, queryClient]);
  // Until the server has answered, and while it can't be reached, assume a job may be running.
  const busy = !status.data || status.isError || status.data.busy || starting;
  return {
    job: status.data?.job ?? null,
    busy,
    checking: status.isPending,
    starting,
    error: status.error?.message ?? cancelError,
    start,
    cancel,
  };
}
export type JobControls = ReturnType<typeof useJobs>;

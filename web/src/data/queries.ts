import { QueryClient, useQuery } from "@tanstack/react-query";
import { loadExample } from "./examples.ts";
import { listRuns, loadDataset } from "./load.ts";
import { RequestError } from "./request.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retry only a server that briefly wasn't there; its own refusals and unreadable data won't change on retry.
      retry: (count, error) => error instanceof RequestError && error.failure === "unreachable" && count < 2,
      // Saved runs are local files, not shared state; refetching them on every tab switch is just load.
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  runs: ["runs"] as const,
  dataset: (dir: string | undefined) => ["dataset", dir] as const,
  example: (name: string) => ["example", name] as const,
};

/** Saved comparisons, newest first. */
export function useRuns() {
  return useQuery({ queryKey: queryKeys.runs, queryFn: listRuns });
}

/**
 * One saved comparison with its runs and grades. A compare folder isn't
 * rewritten once saved (except its explanation, which invalidates it), so
 * switching back to one is instant.
 */
export function useDataset(dir: string | undefined) {
  return useQuery({
    queryKey: queryKeys.dataset(dir),
    queryFn: () => loadDataset(dir),
    enabled: !!dir,
    staleTime: Infinity,
  });
}

/** A recorded example; baked into the build, so it never goes stale. */
export function useExample(name: string) {
  return useQuery({ queryKey: queryKeys.example(name), queryFn: () => loadExample(name), staleTime: Infinity });
}

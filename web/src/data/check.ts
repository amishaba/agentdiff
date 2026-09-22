// The check page's API: saved checks, and one check with every run.
import type { CheckRun, CheckRunSummary } from "../../../src/dashboard/check/types.ts";
import { localJson } from "./jobs.ts";

export const listChecks = () => localJson<CheckRunSummary[]>("/api/checks");

export const readCheck = (dir: string) => localJson<CheckRun>(`/api/checks/run?dir=${encodeURIComponent(dir)}`);

// The page reads the same shapes the CLI writes — imported from the CLI's own
// types so the two can't drift.
export type {
  Comparison,
  RunRecord,
  SequenceCount,
  TestComparison,
  Version,
  VersionStats,
} from "../../../src/types.ts";
import type { Comparison, RunRecord, Version } from "../../../src/types.ts";

/** One line of grades.json. */
export interface GradeRecord {
  test: string;
  version: Version;
  run: number;
  score: number;
  reason: string;
}

export type { RunSummary } from "../../../src/dashboard/runs-contract.ts";

export type Mode = "demo" | "live";

/** One run of one test on one side: what a trace drawer opens. */
export interface RunRef {
  test: string;
  version: Version;
  run: number;
}

/** Everything one screen needs, whether it came from the fixture or the API. */
export interface Dataset {
  mode: Mode;
  dir: string;
  comparison: Comparison;
  grades: GradeRecord[];
  traces: { old: RunRecord[]; new: RunRecord[] };
  explanation: string;
  /** Demo only: where the baked run came from. */
  source?: {
    dir: string;
    bakedAt: string;
    origin: string;
    /** Tests left out of a baked example. */ without?: string[];
  };
}

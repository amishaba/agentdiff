// A run's steps as the page prints them: repeats folded, handoffs and checks
// named. Pure.
import { checkIdOf, isCheckStep, NO_REPLY, stepLabel, stepsOf } from "../../../src/compare/steps.ts";
import type { RunRecord } from "../data/types.ts";

export const isHandoff = (step: string) => step.startsWith("transfer_to_");

/** A step as it's drawn: repeats in a row are one step with a count. */
export interface Step {
  step: string;
  count: number;
}

/** `hide`: checks only one version has; the tree leaves them out so both paths line up. */
export function foldedSteps(r: RunRecord, hide: readonly string[] = []): Step[] {
  const out: Step[] = [];
  for (const step of stepsOf(r).filter((s) => !hide.includes(checkIdOf(s) ?? ""))) {
    const last = out.at(-1);
    if (last && last.step === step && !isHandoff(step) && !isCheckStep(step)) last.count++;
    else out.push({ step, count: 1 });
  }
  return out;
}

export function stepText(s: Step): string {
  const base = isHandoff(s.step)
    ? `→ ${s.step.slice("transfer_to_".length)}`
    : s.step === NO_REPLY
      ? "no reply"
      : stepLabel(s.step);
  return s.count > 1 ? `${base} ×${s.count}` : base;
}

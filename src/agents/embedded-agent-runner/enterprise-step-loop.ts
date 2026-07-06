/**
 * Drives enterprise workflow step advancement from the agent loop, so the active
 * workflow node tracks turns that have actually executed. Two seams:
 *
 * - `transformContext` runs at the start of every provider turn; the hook points
 *   the active node at the step for the current executed-turn count.
 * - `prepareNextTurn` runs after a turn's `turn_end` — only after the model truly
 *   responded — so the hook counts a completed turn there. A preflight failure
 *   (convertToLlm/apiKey/stream throwing before a response) fires neither the
 *   turn_end nor this seam, so the retry re-runs the same step instead of
 *   skipping it; a run resumed after real progress lands on the next step.
 *
 * The hook only attaches for governed runs; unmediated or guidance-free runs get
 * a no-op disposer and the agent's seams are left untouched. Both wrappers
 * capture-and-delegate to any prior hook.
 */
import {
  enterpriseRunTracksSteps,
  recordEnterpriseTurnExecuted,
  setEnterpriseStepForTurn,
} from "../../enterprise/runtime.js";

type StepLoopTransformContext = (
  messages: unknown[],
  signal: AbortSignal,
) => unknown[] | Promise<unknown[]>;

type StepLoopPrepareNextTurn = (signal?: AbortSignal) => unknown;

type StepLoopAgentRecord = {
  transformContext?: StepLoopTransformContext;
  prepareNextTurn?: StepLoopPrepareNextTurn;
};

/** Attach the step-advancement hook; returns a disposer that restores prior state. */
export function installEnterpriseStepLoopHook(params: {
  agent: object;
  runId: string;
}): () => void {
  if (!enterpriseRunTracksSteps(params.runId)) {
    return () => {};
  }
  const record = params.agent as StepLoopAgentRecord;
  const originalTransform = record.transformContext;
  const originalPrepare = record.prepareNextTurn;
  record.transformContext = async (messages, signal) => {
    const result = originalTransform
      ? await originalTransform.call(record, messages, signal)
      : messages;
    setEnterpriseStepForTurn(params.runId);
    return result;
  };
  record.prepareNextTurn = (signal) => {
    recordEnterpriseTurnExecuted(params.runId);
    return originalPrepare?.call(record, signal);
  };
  return () => {
    record.transformContext = originalTransform;
    record.prepareNextTurn = originalPrepare;
  };
}

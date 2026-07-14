import type { RoutePlanner, RoutePlannerDecision } from "@openclaw/enterprise-planner";
/**
 * Model-backed route planner: given a workflow tree and a request, pick the
 * smallest set of nodes that answers it.
 *
 * This is the only place enterprise mediation talks to a provider. It lives in
 * src/agents (not src/enterprise) so the enterprise core stays provider-free and
 * unit-testable; @openclaw/enterprise-planner owns the prompt inputs, the parsing
 * contract, and route→node resolution.
 *
 * Every failure path returns null, which the caller reads as "no opinion" and
 * plans the whole tree. A wrong-but-narrow route would silently drop governance
 * scopes; a whole-tree plan is only less precise, never less governed.
 */
import { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSecrets } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

const log = createSubsystemLogger("enterprise");

const ROUTE_PLANNER_MAX_TOKENS = 400;
const ROUTE_PLANNER_TIMEOUT_MS = 20_000;
const PLANNER_TIMEOUT = Symbol("enterprise-route-planner-timeout");
const PLANNER_ABORTED = Symbol("enterprise-route-planner-aborted");

/** Resolves as soon as the run is cancelled, so an await can lose to the abort. */
function abortedSignalPromise(signal: AbortSignal): Promise<typeof PLANNER_ABORTED> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(PLANNER_ABORTED);
      return;
    }
    signal.addEventListener("abort", () => resolve(PLANNER_ABORTED), { once: true });
  });
}

const responseSchema = z.object({
  routes: z.array(z.string()),
  rationale: z.string().optional(),
});

const SYSTEM_PROMPT = [
  "You route a request into a governed workflow tree.",
  "",
  "You are given the tree's nodes as dotted ids with titles. Select the MINIMUM set",
  "of nodes whose subtrees answer the request. Selecting a node runs its entire",
  "subtree, so:",
  "- Prefer the DEEPEST node that still covers the request. Selecting a parent drags",
  "  in every sibling branch under it.",
  "- Return several nodes only when the request genuinely spans separate branches.",
  "- Never invent an id. Copy ids exactly as given.",
  "- Sibling branches are often near-synonyms; read the titles and pick by meaning,",
  "  not by keyword overlap.",
  "",
  'Reply with JSON only: {"routes": ["<node.id>", ...], "rationale": "<one sentence>"}',
].join("\n");

type RoutePlannerDeps = {
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/** Parse a planner reply. Exported: the parsing contract is the risky part. */
export function parseRoutePlannerResponse(text: string): RoutePlannerDecision {
  const stripped = stripJsonFence(text);
  // Models like to wrap the object in prose; take the outermost object.
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return {
    routes: result.data.routes,
    ...(result.data.rationale ? { rationale: result.data.rationale } : {}),
  };
}

/** A provider failure surfaces as stopReason "error", not as a rejected promise. */
function extractCompletionError(
  result: Awaited<ReturnType<typeof completeWithPreparedSimpleCompletionModel>>,
): string | undefined {
  if (!("stopReason" in result) || result.stopReason !== "error") {
    return undefined;
  }
  return "errorMessage" in result && typeof result.errorMessage === "string"
    ? result.errorMessage
    : "model returned an error";
}

async function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | typeof PLANNER_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof PLANNER_TIMEOUT>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(PLANNER_TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** Build the planner that mediation injects, or undefined when unavailable. */
export function createModelRoutePlanner(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  /** The model ref the RUN selected; routing must not silently use another. */
  modelRef?: string;
  /**
   * The auth profile the RUN dispatches with. In multi-profile setups the same
   * provider/model can resolve to a different account or tenant, so routing must
   * use the run's profile rather than the default one.
   */
  authProfileId?: string;
  deps?: RoutePlannerDeps;
}): RoutePlanner | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }
  const agentId = params.agentId ?? "main";
  const modelRef = params.modelRef;
  const authProfileId = params.authProfileId;
  const prepareModel =
    params.deps?.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent;
  const complete =
    params.deps?.completeWithPreparedSimpleCompletionModel ??
    completeWithPreparedSimpleCompletionModel;

  return async ({ tree, requestText, candidates, signal }) => {
    // A run cancelled before planning starts must never reach a provider.
    if (signal?.aborted) {
      return null;
    }
    // Wire cancellation BEFORE model preparation: installing the listener only
    // afterwards would let an abort that lands during preparation still send the
    // request text to the model.
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Race preparation against the abort as well as the timeout: merely
      // CHECKING the signal afterwards would leave Stop hanging behind slow
      // auth/model preparation for the full timeout.
      const prepared = await raceTimeout(
        Promise.race([
          prepareModel({
            cfg,
            agentId,
            ...(modelRef ? { modelRef } : {}),
            // Same account/tenant the run itself dispatches with: in a
            // multi-profile setup the default profile can be a different account.
            ...(authProfileId ? { preferredProfile: authProfileId } : {}),
            allowMissingApiKeyModes: ["aws-sdk"],
          }),
          abortedSignalPromise(controller.signal),
        ]),
        ROUTE_PLANNER_TIMEOUT_MS,
      );
      if (prepared === PLANNER_ABORTED) {
        return null;
      }
      if (prepared === PLANNER_TIMEOUT) {
        log.warn("enterprise route planner: model preparation timed out; planning the whole tree");
        return null;
      }
      if ("error" in prepared) {
        log.warn(`enterprise route planner: model unavailable (${prepared.error})`);
        return null;
      }
      // The run may have been cancelled while the model was being prepared.
      if (controller.signal.aborted) {
        return null;
      }
      const result = await raceTimeout(
        Promise.race([
          abortedSignalPromise(controller.signal),
          complete({
            model: prepared.model,
            auth: prepared.auth,
            cfg,
            context: {
              systemPrompt: SYSTEM_PROMPT,
              messages: [
                {
                  role: "user",
                  content: [
                    `Workflow tree: ${tree.id} — ${tree.name}`,
                    "",
                    "Nodes:",
                    candidates,
                    "",
                    "Request:",
                    requestText,
                  ].join("\n"),
                  timestamp: Date.now(),
                },
              ],
            },
            options: {
              maxTokens: ROUTE_PLANNER_MAX_TOKENS,
              temperature: 0,
              signal: controller.signal,
            },
          }),
        ]),
        ROUTE_PLANNER_TIMEOUT_MS,
        () => controller.abort(),
      );
      if (result === PLANNER_ABORTED) {
        // Stop must unwind now, not after the planner's own timeout: a provider
        // that ignores the AbortSignal would otherwise hold the run open.
        return null;
      }
      if (result === PLANNER_TIMEOUT) {
        log.warn("enterprise route planner: timed out; planning the whole tree");
        return null;
      }
      // A provider error arrives as a RESULT with stopReason "error" and no text
      // blocks, not as a throw. Without this the caller would only see an
      // "unparseable reply" for what is actually an auth/quota/provider failure.
      const completionError = extractCompletionError(result);
      if (completionError) {
        log.warn(
          `enterprise route planner: model call failed (${completionError}); planning the whole tree`,
        );
        return null;
      }
      const text = result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      const decision = parseRoutePlannerResponse(text);
      if (!decision) {
        // Include a bounded, redacted head of the reply: without it an operator
        // cannot tell a truncated answer from a refusal or a wrong shape.
        log.warn(
          `enterprise route planner: unparseable reply; planning the whole tree (got ${text.length} chars: ${redactSecrets(text).slice(0, 200)})`,
        );
      }
      return decision;
    } catch (err) {
      log.warn(
        `enterprise route planner failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
}

/**
 * @openclaw/enterprise-planner — which workflow tree governs a request, and
 * which part of it runs.
 *
 * Pure and provider-free: the prompt inputs, the decision contract, and the
 * route -> node resolution live here; the model call is injected by the host.
 * That boundary is the point — the host owns providers and governance, the
 * package owns the planning algorithm.
 */
export {
  buildPlanCandidateDigest,
  buildRouteCandidateDigest,
  countTreeNodes,
  failClosedWorkflowSelection,
  resolveRouteNodeIds,
  selectWorkflowPlan,
  type EnterpriseRouteSelection,
  type EnterpriseWorkflowSelection,
  type WorkflowPlanDecision,
  type WorkflowPlanner,
  type WorkflowTreeSource,
} from "./route-planner.js";
export type { PlannableNode, PlannableTree } from "./types.js";

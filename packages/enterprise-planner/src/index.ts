/**
 * @openclaw/enterprise-planner — route selection inside a workflow tree.
 *
 * Pure and provider-free: the prompt inputs, the decision contract, and the
 * route -> node resolution live here; the model call is injected by the host.
 * That boundary is the point — the host owns providers and governance, the
 * package owns the planning algorithm.
 */
export {
  buildRouteCandidateDigest,
  countTreeNodes,
  resolveRouteNodeIds,
  selectWorkflowRoute,
  type EnterpriseRouteSelection,
  type RoutePlanner,
  type RoutePlannerDecision,
} from "./route-planner.js";
export type { PlannableNode, PlannableTree } from "./types.js";

/**
 * The minimal tree shape route planning needs.
 *
 * Structural on purpose: the planner is about SHAPE (ids, titles, parent/child),
 * not about the enterprise ontology. Core's richer WorkflowTreeDefinition
 * satisfies this without the package having to depend on core — which is what
 * lets the planner be developed, tested, and reasoned about on its own.
 */
export type PlannableNode = {
  id: string;
  title: string;
  description?: string;
  children?: PlannableNode[];
};

export type PlannableTree = {
  id: string;
  name: string;
  root: PlannableNode;
};

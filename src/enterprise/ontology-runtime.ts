/**
 * What the ontology tools may see from where the run currently stands.
 *
 * This is the whole point of a per-node ontology: at the active node, the agent
 * sees the object types, links, actions, and functions declared on the root→node
 * path, and nothing else. A type declared on a sibling branch is not part of this
 * node's contract, so it is not addressable — the model cannot search it, walk
 * into it, or act on it, whatever it may have inferred from the prompt.
 *
 * The scope is derived from the run registry (keyed by runId) rather than
 * threaded through the tool call, because a tool handler only ever gets its
 * closure. Same lookup `knowledge_search` uses.
 */
import { findPlanNode, resolvePlanNodePath } from "./plan.js";
import { getEnterpriseActiveRun } from "./runtime.js";
import type {
  EnterpriseId,
  OntologyAction,
  OntologyEntity,
  OntologyFunction,
  OntologyRelationship,
} from "./types.js";

export type NodeOntologyScope = {
  treeId: EnterpriseId;
  nodeId: EnterpriseId;
  /** Enforce mode blocks; observe mode records and lets the call through. */
  enforce: boolean;
  entities: Map<EnterpriseId, OntologyEntity>;
  relationships: Map<EnterpriseId, OntologyRelationship>;
  actions: Map<EnterpriseId, OntologyAction>;
  functions: Map<EnterpriseId, OntologyFunction>;
};

/**
 * Merge the ontology down the root→active path.
 *
 * Merging (rather than reading the leaf alone) mirrors governance, which ANDs
 * the tool scope of every ancestor: a step operates inside the contract its
 * ancestors declared, so it can also see the object types they introduced.
 * Returns null when the run is not enterprise-mediated at all.
 */
export function resolveActiveOntologyScope(runId: string): NodeOntologyScope | null {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return null;
  }
  const node = findPlanNode(run.plan, run.plan.activeNodeId);
  if (!node) {
    return null;
  }
  const scope: NodeOntologyScope = {
    treeId: run.plan.treeId,
    nodeId: node.nodeId,
    enforce: run.plan.mode === "enforce",
    entities: new Map(),
    relationships: new Map(),
    actions: new Map(),
    functions: new Map(),
  };
  // Root first, so a deeper node's redeclaration of the same id wins.
  for (const step of resolvePlanNodePath(run.plan, node.nodeId)) {
    for (const entity of step.ontology.entities ?? []) {
      scope.entities.set(entity.id, mergeEntity(scope.entities.get(entity.id), entity));
    }
    for (const relationship of step.ontology.relationships ?? []) {
      scope.relationships.set(relationship.id, relationship);
    }
    for (const action of step.ontology.actions ?? []) {
      scope.actions.set(action.id, action);
    }
    for (const fn of step.ontology.functions ?? []) {
      scope.functions.set(fn.id, fn);
    }
  }
  return scope;
}

/**
 * An object type is TREE-scoped: a child may extend one its ancestor introduced,
 * adding properties without repeating the primaryKey. Schema validation merges
 * declarations across nodes to check them, and the UI graph merges them to draw
 * them — so the runtime has to merge them too. Replacing the ancestor's record
 * with the child's would drop the primary key and make the type unaddressable
 * (compute_function would report a type it can plainly see as "not addressable").
 */
function mergeEntity(base: OntologyEntity | undefined, extension: OntologyEntity): OntologyEntity {
  if (!base) {
    return extension;
  }
  const properties = new Map((base.properties ?? []).map((property) => [property.id, property]));
  for (const property of extension.properties ?? []) {
    // Merge the FIELDS, not the property object: a descendant that restates an
    // existing property (say, to add a description) without repeating
    // `primaryKey: true` would otherwise drop the flag, and the object type would
    // report itself unaddressable at that step.
    //
    // The identity flags are OR-ed, not overwritten: a restatement carrying
    // `primaryKey: false` (or omitting it) must not clear an identity the ancestor
    // established. A redeclaration extends a type; it does not un-declare it.
    const existing = properties.get(property.id);
    if (!existing) {
      properties.set(property.id, property);
      continue;
    }
    properties.set(property.id, {
      ...existing,
      ...property,
      ...(existing.primaryKey || property.primaryKey ? { primaryKey: true } : {}),
      ...(existing.required || property.required ? { required: true } : {}),
    });
  }
  return {
    ...base,
    ...extension,
    ...(properties.size > 0 ? { properties: [...properties.values()] } : {}),
  };
}

/**
 * Does this run's tree declare an object graph at all?
 *
 * Enterprise mode is on by DEFAULT, and the stock built-in trees are deliberately
 * guidance-free — they exist to keep every run traced, not to model a domain. So
 * "the run is mediated" is not a reason to hand the model ontology tools: it would
 * add three useless tools to the stock tool list, which is exactly the prompt-byte
 * regression the built-ins are shaped to avoid.
 *
 * The plan is fixed for the run, so this is stable from tool construction to the
 * last turn — the model-visible tool list never changes mid-run.
 */
export function runDeclaresOntology(runId: string): boolean {
  const run = getEnterpriseActiveRun(runId);
  if (!run) {
    return false;
  }
  return run.plan.nodes.some(
    (node) =>
      (node.ontology.entities?.length ?? 0) > 0 || (node.ontology.functions?.length ?? 0) > 0,
  );
}

/** The object type's identifying property, or null when it declares none. */
export function primaryKeyOf(entity: OntologyEntity): string | null {
  return entity.properties?.find((property) => property.primaryKey)?.id ?? null;
}

/**
 * A denial the model can act on: it names what it asked for and what it may
 * actually address here. A bare "not found" would read as "the data is missing"
 * and send the model looking for another way in, rather than telling it the type
 * is outside this step's contract.
 */
export function outOfScopeMessage(
  kind: "object type" | "link type" | "function" | "action",
  requested: string,
  available: Iterable<string>,
): string {
  const options = [...available].toSorted();
  return `${kind} "${requested}" is not in the ontology of this workflow step. Available ${kind}s: ${
    options.length > 0 ? options.join(", ") : "(none)"
  }`;
}

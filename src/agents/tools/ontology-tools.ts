/**
 * The ontology read tools: search_objects, get_neighbors, compute_function.
 *
 * They let the model work ON the typed object graph its workflow step declares,
 * instead of inferring it from prose in the prompt. Every one of them is scoped
 * to the ontology of the ACTIVE node's root→leaf path: an object type declared on
 * a sibling branch is not addressable here, so what the model can touch is a
 * function of where the run stands, not of what it decided to try.
 *
 * They are assembled once per mediated run and stay in the tool list for its
 * whole life (prompt-cache stability: the model-visible tool list must not change
 * as the run walks the tree). Per-node narrowing happens HERE, at execution, and
 * in the before-tool-call governance gate — never by hiding the tool.
 */
import { Type } from "typebox";
import {
  getOntologyNeighbors,
  getOntologyObject,
  runOntologyObjectWrite,
  searchOntologyObjects,
} from "../../enterprise/object-store.sqlite.js";
import { invokeOntologyAction } from "../../enterprise/ontology-actions.js";
import {
  evaluateOntologyExpression,
  ontologyExpressionProperties,
  parseOntologyExpression,
} from "../../enterprise/ontology-expression.js";
import {
  outOfScopeMessage,
  primaryKeyOf,
  resolveActiveOntologyScope,
} from "../../enterprise/ontology-runtime.js";
import { recordEnterpriseActionInvoked } from "../../enterprise/runtime.js";
import type { OntologyEntity, OntologyValue } from "../../enterprise/types.js";
import {
  asToolParamsRecord,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  type AnyAgentTool,
} from "./common.js";

const OBJECT_SEARCH_MAX_LIMIT = 50;
const OBJECT_SEARCH_DEFAULT_LIMIT = 10;
const NEIGHBOR_MAX_LIMIT = 50;
const NEIGHBOR_DEFAULT_LIMIT = 20;

/**
 * A run that is not enterprise-mediated has no ontology to address. This is a
 * result, not a throw: the model reads it and moves on, the same way a governance
 * denial arrives as a tool result.
 */
function unmediated(): ReturnType<typeof jsonResult> {
  return jsonResult({
    error: "this run is not governed by a workflow tree, so it has no ontology",
  });
}

/** Property ids this step may read on an object type (its scoped declaration). */
function visiblePropertiesOf(entity: OntologyEntity): string[] {
  return (entity.properties ?? []).map((property) => property.id);
}

const SearchObjectsSchema = Type.Object({
  entity: Type.String({
    description: "Object type id to search, as declared by the current workflow step.",
  }),
  match: Type.Optional(
    Type.String({ description: "Case-insensitive substring to match against property values." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: OBJECT_SEARCH_MAX_LIMIT,
      description: `Max objects to return (default ${OBJECT_SEARCH_DEFAULT_LIMIT}).`,
    }),
  ),
});

export function createSearchObjectsTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Ontology",
    name: "search_objects",
    description:
      "Search instances of an object type declared by the current workflow step. Returns typed objects with their properties.",
    parameters: SearchObjectsSchema,
    execute: async (_toolCallId, params) => {
      const scope = resolveActiveOntologyScope(opts.runId);
      if (!scope) {
        return unmediated();
      }
      const record = asToolParamsRecord(params);
      const entity = readStringParam(record, "entity", { required: true });
      const match = readStringParam(record, "match");
      const limit =
        readPositiveIntegerParam(record, "limit", { max: OBJECT_SEARCH_MAX_LIMIT }) ??
        OBJECT_SEARCH_DEFAULT_LIMIT;

      const declared = scope.entities.get(entity);
      if (!declared) {
        return jsonResult({
          error: outOfScopeMessage("object type", entity, scope.entities.keys()),
        });
      }
      // Only the properties THIS step declares. An object type is tree-scoped, so
      // a stored row can carry fields a sibling branch added, and returning them
      // (or letting `match` probe them) would reach past the step's contract.
      const objects = searchOntologyObjects({
        treeId: scope.treeId,
        entity,
        ...(match ? { match } : {}),
        properties: visiblePropertiesOf(declared),
        limit,
      });
      return jsonResult({
        entity,
        count: objects.length,
        objects: objects.map((object) => ({
          objectId: object.objectId,
          properties: object.properties,
        })),
      });
    },
  };
}

const GetNeighborsSchema = Type.Object({
  entity: Type.String({ description: "Object type id of the object to start from." }),
  objectId: Type.String({ description: "Primary-key value of the object to start from." }),
  relationship: Type.Optional(
    Type.String({ description: "Restrict to one link type; omit to traverse every link." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: NEIGHBOR_MAX_LIMIT,
      description: `Max neighbors to return (default ${NEIGHBOR_DEFAULT_LIMIT}).`,
    }),
  ),
});

export function createGetNeighborsTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Ontology",
    name: "get_neighbors",
    description:
      "Walk the links from one object to the objects related to it, in either direction.",
    parameters: GetNeighborsSchema,
    execute: async (_toolCallId, params) => {
      const scope = resolveActiveOntologyScope(opts.runId);
      if (!scope) {
        return unmediated();
      }
      const record = asToolParamsRecord(params);
      const entity = readStringParam(record, "entity", { required: true });
      const objectId = readStringParam(record, "objectId", { required: true });
      const relationship = readStringParam(record, "relationship");
      const limit =
        readPositiveIntegerParam(record, "limit", { max: NEIGHBOR_MAX_LIMIT }) ??
        NEIGHBOR_DEFAULT_LIMIT;

      if (!scope.entities.has(entity)) {
        return jsonResult({
          error: outOfScopeMessage("object type", entity, scope.entities.keys()),
        });
      }
      if (relationship && !scope.relationships.has(relationship)) {
        return jsonResult({
          error: outOfScopeMessage("link type", relationship, scope.relationships.keys()),
        });
      }
      // Traverse only the link types this step declares, and only into object
      // types it can address. Without the bound, an entity shared from an ancestor
      // would walk edges a SIBLING branch declared and hand back that branch's
      // objects — straight through the node boundary this tool exists to hold.
      const neighbors = getOntologyNeighbors({
        treeId: scope.treeId,
        entity,
        objectId,
        ...(relationship ? { relationship } : {}),
        relationships: [...scope.relationships.keys()],
        visibleProperties: new Map(
          [...scope.entities].map(([id, declared]) => [id, visiblePropertiesOf(declared)]),
        ),
        limit,
      });
      return jsonResult({
        from: { entity, objectId },
        count: neighbors.length,
        neighbors: neighbors.map((neighbor) => ({
          relationship: neighbor.link.relationship,
          direction: neighbor.direction,
          entity:
            neighbor.direction === "outbound" ? neighbor.link.toEntity : neighbor.link.fromEntity,
          objectId:
            neighbor.direction === "outbound"
              ? neighbor.link.toObjectId
              : neighbor.link.fromObjectId,
          properties: neighbor.object?.properties ?? null,
        })),
      });
    },
  };
}

const ComputeFunctionSchema = Type.Object({
  function: Type.String({
    description: "Function id to evaluate, as declared by the current workflow step.",
  }),
  objectId: Type.String({ description: "Primary-key value of the object to compute over." }),
});

export function createComputeFunctionTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Ontology",
    name: "compute_function",
    description:
      "Evaluate a derived value declared by the current workflow step against one object.",
    parameters: ComputeFunctionSchema,
    execute: async (_toolCallId, params) => {
      const scope = resolveActiveOntologyScope(opts.runId);
      if (!scope) {
        return unmediated();
      }
      const record = asToolParamsRecord(params);
      const functionId = readStringParam(record, "function", { required: true });
      const objectId = readStringParam(record, "objectId", { required: true });

      const fn = scope.functions.get(functionId);
      if (!fn) {
        return jsonResult({
          error: outOfScopeMessage("function", functionId, scope.functions.keys()),
        });
      }
      const entity = scope.entities.get(fn.entity);
      if (!entity || !primaryKeyOf(entity)) {
        // Import validation rejects this shape, so reaching it means the tree was
        // written straight into the store.
        return jsonResult({
          error: `object type "${fn.entity}" is not addressable from this workflow step`,
        });
      }
      const object = getOntologyObject({ treeId: scope.treeId, entity: fn.entity, objectId });
      if (!object) {
        return jsonResult({ error: `no "${fn.entity}" object with id "${objectId}"` });
      }
      // The expression was parsed and type-checked at IMPORT; re-parsing here is
      // just rehydration, and a failure means the stored tree was tampered with.
      const parsed = parseOntologyExpression(fn.expression);
      if (!parsed.ok) {
        return jsonResult({ error: `function "${fn.id}" no longer parses: ${parsed.error}` });
      }
      // A function is validated against the MERGED tree-wide object type, so one
      // inherited from an ancestor may reference a property only a SIBLING branch
      // declares. Evaluating it here would let compute_function derive a value that
      // search_objects and get_neighbors deliberately withhold — the scalar it
      // returns is still the hidden data. Refuse rather than leak it sideways.
      const visible = new Set(visiblePropertiesOf(entity));
      const hidden = ontologyExpressionProperties(parsed.expression).filter(
        (property) => !visible.has(property),
      );
      if (hidden.length > 0) {
        return jsonResult({
          error: `function "${fn.id}" reads ${hidden
            .map((property) => `"$${property}"`)
            .join(", ")}, which object type "${fn.entity}" does not declare in this workflow step`,
        });
      }
      // Evaluate over the SCOPED view of the object, not the stored row.
      const scoped = Object.fromEntries(
        Object.entries(object.properties).filter(([property]) => visible.has(property)),
      );
      const evaluated = evaluateOntologyExpression(parsed.expression, scoped);
      if (!evaluated.ok) {
        return jsonResult({ error: `function "${fn.id}" failed: ${evaluated.error}` });
      }
      return jsonResult({
        function: fn.id,
        entity: fn.entity,
        objectId,
        returns: fn.returns,
        value: evaluated.value,
      });
    },
  };
}

const InvokeActionSchema = Type.Object({
  action: Type.String({
    description: "Action id to run, as declared by the current workflow step.",
  }),
  args: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "The action's declared parameters, by id. The parameter matching an affected object type's primary key identifies the object to write.",
      },
    ),
  ),
});

/**
 * The write tool. Its effects are the authorization: it may only touch the object
 * types the action's `effects` name, only in the way they name, and only from a
 * step that declares the action. Governance sees the ACTION (not just the tool),
 * so a policy scoped to one action can deny or require approval for exactly that
 * one.
 */
export function createInvokeActionTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Ontology",
    name: "invoke_action",
    description:
      "Run an action declared by the current workflow step. Writes to the objects the action's effects name.",
    parameters: InvokeActionSchema,
    execute: async (_toolCallId, params) => {
      const scope = resolveActiveOntologyScope(opts.runId);
      if (!scope) {
        return unmediated();
      }
      const record = asToolParamsRecord(params);
      const actionId = readStringParam(record, "action", { required: true });
      const rawArgs = record.args;
      if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null)) {
        return jsonResult({
          error: '"args" must be an object of the action\'s declared parameters',
        });
      }
      const args = (rawArgs ?? {}) as Record<string, OntologyValue>;

      const action = scope.actions.get(actionId);
      if (!action) {
        // An action the step does not declare is not performable here, whatever
        // the model inferred. This is the ontology's own boundary.
        return jsonResult({
          error: outOfScopeMessage("action", actionId, scope.actions.keys()),
        });
      }

      const result = runOntologyObjectWrite((database) =>
        invokeOntologyAction(database, { scope, action, args }),
      );
      if (!result.ok) {
        return jsonResult({ error: result.error });
      }
      // The governance decision recorded that the call was ALLOWED; this records
      // what it did. Without it the trail cannot say which object changed.
      recordEnterpriseActionInvoked(opts.runId, {
        actionId: action.id,
        writes: result.writes,
        context: result.unmappedParameters,
      });
      return jsonResult({
        action: action.id,
        writes: result.writes,
      });
    },
  };
}

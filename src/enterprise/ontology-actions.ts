/**
 * Running an ontology action: the write path.
 *
 * `effects` are the AUTHORIZATION, not a description. An action may only touch
 * the object types its effects name, and only in the way they name — an action
 * declaring `kind: read` cannot write, and one declaring `update customer`
 * cannot delete an account. Before this, effects were rendered into the prompt
 * and nothing checked them, so "write-scoped action" was the naming convention
 * the types file claimed it wasn't.
 *
 * The parameter→property mapping is declarative, not model discretion: a
 * parameter whose id matches a property of an effect's object type is written to
 * that property, and the parameter matching the type's primaryKey identifies
 * which object. Parameters that match nothing (a rationale, a reason code) are
 * inputs to the decision, not to the store, and land in the audit trail instead.
 *
 * PLAN, THEN APPLY. Every effect is resolved and checked before ANY of them
 * writes. An action that fails halfway through would otherwise commit the writes
 * it had already made (the caller's transaction sees a returned error, not a
 * throw, so it commits) and report failure — leaving the object graph in a state
 * no action ever authorized, with nothing in the audit trail to explain it.
 */
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  deleteOntologyObject,
  getOntologyObjectIn,
  upsertOntologyObject,
} from "./object-store.sqlite.js";
import { ontologyValueMatchesType } from "./ontology-expression.js";
import { primaryKeyOf, type NodeOntologyScope } from "./ontology-runtime.js";
import type {
  OntologyAction,
  OntologyActionEffect,
  OntologyEntity,
  OntologyValue,
} from "./types.js";

/** One write an action performed, as the audit trail records it. */
export type OntologyWrite = {
  entity: string;
  objectId: string;
  kind: "create" | "update" | "delete";
};

export type OntologyActionResult =
  | { ok: true; writes: OntologyWrite[]; unmappedParameters: Record<string, OntologyValue> }
  | { ok: false; error: string };

/** A single resolved, fully-checked write, ready to apply. */
type PlannedWrite = {
  entity: OntologyEntity;
  entityId: string;
  objectId: string;
  kind: "create" | "update" | "delete";
  /** Full property set to persist (absent for a delete). */
  properties?: Record<string, OntologyValue>;
};

/**
 * Check the call against the action's declared parameters.
 *
 * A declaration nothing validates is decoration. `required` means the call fails
 * without it, and the declared type means a string cannot arrive where the
 * ontology says a number lives.
 */
function validateParameters(
  action: OntologyAction,
  args: Record<string, OntologyValue>,
): string | null {
  const parameters = action.parameters ?? [];
  const declared = new Map(parameters.map((parameter) => [parameter.id, parameter]));
  if (declared.size !== parameters.length) {
    // A Map keeps the LAST declaration, so a duplicate id would silently drop an
    // earlier `required` or stricter type. The schema does not reject duplicates,
    // so the write path must refuse to guess which one the operator meant.
    return `action "${action.id}" declares the same parameter more than once`;
  }
  for (const name of Object.keys(args)) {
    if (!declared.has(name)) {
      return `action "${action.id}" does not declare a parameter "${name}"; it declares: ${
        [...declared.keys()].toSorted().join(", ") || "(none)"
      }`;
    }
  }
  for (const parameter of declared.values()) {
    const value = args[parameter.id];
    if (value === undefined || value === null) {
      if (parameter.required) {
        return `action "${action.id}" requires the parameter "${parameter.id}"`;
      }
      continue;
    }
    if (!ontologyValueMatchesType(value, parameter.type)) {
      return `parameter "${parameter.id}" of action "${action.id}" is declared "${parameter.type}" but got ${typeof value}`;
    }
  }
  return null;
}

/**
 * Resolve one effect into a checked write.
 *
 * The value is validated against the TARGET PROPERTY's ontology type, not just
 * the action's parameter type. Those are two different declarations and a tree
 * may disagree with itself — an action can declare `amount` a string while
 * `claim.amount` is a number. The store is the ontology's, so the property wins:
 * persisting the parameter's type would put an object in the graph that every
 * later read and every function assumes is typed differently.
 */
function planEffect(
  effect: OntologyActionEffect & { kind: "create" | "update" | "delete" },
  params: {
    database: OpenClawStateDatabase;
    scope: NodeOntologyScope;
    action: OntologyAction;
    args: Record<string, OntologyValue>;
    consumed: Set<string>;
  },
): PlannedWrite | string {
  const { database, scope, action, args, consumed } = params;
  const entity = scope.entities.get(effect.entity);
  if (!entity) {
    // Import validation resolves effect entities tree-wide, so this means the
    // action's object type is not on THIS step's path — the action is not
    // performable from where the run stands.
    return `action "${action.id}" writes object type "${effect.entity}", which this workflow step does not declare`;
  }
  const primaryKey = primaryKeyOf(entity);
  if (!primaryKey) {
    return `object type "${effect.entity}" declares no primaryKey, so an action cannot address an instance of it`;
  }
  const identity = args[primaryKey];
  if (typeof identity !== "string" && typeof identity !== "number") {
    return `action "${action.id}" must pass "${primaryKey}" to identify the "${effect.entity}" object it ${effect.kind}s`;
  }
  // Import rejects blank and padded identities on SEEDED objects; an action must
  // not be able to create one through the other door. The tools read objectId
  // through the trimming param reader, so a row stored as "" or " C-2 " comes
  // back from search_objects with an id nothing can look up again.
  if (typeof identity === "string" && identity !== identity.trim()) {
    return `"${primaryKey}" must not have leading or trailing whitespace: the ontology tools would trim it and lose the object`;
  }
  if (typeof identity === "string" && identity.length === 0) {
    return `"${primaryKey}" must not be blank: a blank identity cannot be addressed or traversed`;
  }
  // Type-check the identity against the primary-key PROPERTY here, before the
  // delete branch returns: an action may declare its key parameter with the wrong
  // type, and a delete would otherwise stringify a number and remove the row an
  // update or create would have refused to touch.
  const primaryKeyProperty = (entity.properties ?? []).find(
    (property) => property.id === primaryKey,
  );
  if (primaryKeyProperty && !ontologyValueMatchesType(identity, primaryKeyProperty.type)) {
    return `property "${primaryKey}" of "${effect.entity}" is declared "${primaryKeyProperty.type}", but action "${action.id}" passed ${typeof identity}`;
  }
  const objectId = String(identity);
  consumed.add(primaryKey);

  // Same handle the write will use: reading the process-default database here
  // would make a valid update look missing whenever the transaction runs against
  // another state DB.
  const existing = getOntologyObjectIn(database, {
    treeId: scope.treeId,
    entity: effect.entity,
    objectId,
  });
  if (effect.kind === "delete") {
    if (!existing) {
      return `no "${effect.entity}" object with id "${objectId}"`;
    }
    return { entity, entityId: effect.entity, objectId, kind: "delete" };
  }
  if (effect.kind === "update" && !existing) {
    return `no "${effect.entity}" object with id "${objectId}" to update`;
  }
  if (effect.kind === "create" && existing) {
    return `a "${effect.entity}" object with id "${objectId}" already exists`;
  }

  // Declarative mapping: a parameter named like one of the object type's
  // properties writes that property. Anything else is an input to the decision.
  const properties: Record<string, OntologyValue> = { ...existing?.properties };
  for (const property of entity.properties ?? []) {
    const value = args[property.id];
    if (value === undefined) {
      continue;
    }
    consumed.add(property.id);
    if (!ontologyValueMatchesType(value, property.type)) {
      return `property "${property.id}" of "${effect.entity}" is declared "${property.type}", but action "${action.id}" would write ${value === null ? "null" : typeof value}`;
    }
    if (value === null && property.required) {
      // An optional parameter must not be able to null out a required property:
      // the object would then violate the type every later read assumes.
      return `property "${property.id}" of "${effect.entity}" is required, so action "${action.id}" cannot clear it`;
    }
    properties[property.id] = value;
  }
  // The store KEY is a string (object_id is TEXT), but the primary-key PROPERTY
  // keeps its declared type: writing the stringified key back would persist a
  // `number` id as "7", and every later read and function would then see an
  // object that violates the ontology it was validated against.
  properties[primaryKey] = identity;

  // TREE-WIDE required, not just this path's: objects are stored tree-wide, so an
  // object created here must satisfy the shape every branch declares. A sibling
  // that marks a property required would otherwise read back an object violating
  // its own type.
  const requiredIds = new Set([
    ...(entity.properties ?? [])
      .filter((property) => property.required)
      .map((property) => property.id),
    ...(scope.treeRequiredProperties.get(effect.entity) ?? []),
  ]);
  const missing = [...requiredIds]
    .filter((id) => properties[id] === undefined || properties[id] === null)
    .toSorted();
  if (missing.length > 0) {
    // The written object must satisfy its own type, or search_objects would hand
    // the model an instance the ontology says cannot exist.
    return effect.kind === "create"
      ? `creating a "${effect.entity}" needs its required properties: ${missing.join(", ")}`
      : `updating this "${effect.entity}" would leave its required properties unset: ${missing.join(", ")}`;
  }

  return { entity, entityId: effect.entity, objectId, kind: effect.kind, properties };
}

/**
 * Apply one action's declared effects to the object store, inside the caller's
 * write transaction.
 *
 * Every failure is a result, never a throw: a bad action call is something the
 * model must read and correct, not something that kills the run. Which is
 * exactly why the whole plan is checked before the first write — a returned
 * error does not roll the caller's transaction back.
 */
export function invokeOntologyAction(
  database: OpenClawStateDatabase,
  params: {
    scope: NodeOntologyScope;
    action: OntologyAction;
    args: Record<string, OntologyValue>;
    now?: number;
  },
): OntologyActionResult {
  const { scope, action, args } = params;
  const parameterError = validateParameters(action, args);
  if (parameterError) {
    return { ok: false, error: parameterError };
  }

  // A type predicate, not a bare filter: "read" must not survive into a write.
  const writeEffects = (action.effects ?? []).filter(
    (effect): effect is OntologyActionEffect & { kind: "create" | "update" | "delete" } =>
      effect.kind !== "read",
  );
  if (writeEffects.length === 0) {
    // The effects ARE the write scope. An action that declares none (or only
    // reads) is read-only, and saying so is more useful than silently doing
    // nothing.
    return {
      ok: false,
      error: `action "${action.id}" declares no write effects, so it cannot change any object`,
    };
  }

  // PLAN: resolve and check every effect before any of them writes.
  const consumed = new Set<string>();
  const planned: PlannedWrite[] = [];
  const targets = new Set<string>();
  for (const effect of writeEffects) {
    const outcome = planEffect(effect, { database, scope, action, args, consumed });
    if (typeof outcome === "string") {
      return { ok: false, error: outcome };
    }
    // Every effect is planned against the ORIGINAL state, so two effects on the
    // SAME object cannot be composed: `delete` then `update` would delete the row
    // and then recreate it, turning a delete action into a no-op and an update
    // into a create. The ontology has no way to order effects, so an action that
    // touches one object twice is a definition bug rather than a sequence.
    const target = `${outcome.entityId}/${outcome.objectId}`;
    if (targets.has(target)) {
      return {
        ok: false,
        error: `action "${action.id}" declares more than one effect on "${target}"; effects are not ordered, so one object may be written once`,
      };
    }
    targets.add(target);
    planned.push(outcome);
  }

  // APPLY: nothing below can fail on the ontology's terms.
  const writes: OntologyWrite[] = [];
  for (const write of planned) {
    if (write.kind === "delete") {
      deleteOntologyObject(database, {
        treeId: scope.treeId,
        entity: write.entityId,
        objectId: write.objectId,
      });
    } else {
      upsertOntologyObject(database, {
        treeId: scope.treeId,
        entity: write.entityId,
        objectId: write.objectId,
        properties: write.properties ?? {},
        ...(params.now !== undefined ? { now: params.now } : {}),
      });
    }
    writes.push({ entity: write.entityId, objectId: write.objectId, kind: write.kind });
  }

  // Parameters that mapped to no property are the action's rationale/context:
  // the operator's evidence for WHY the write happened, so they belong in the
  // trace rather than being dropped.
  const unmappedParameters = Object.fromEntries(
    Object.entries(args).filter(([name]) => !consumed.has(name)),
  );
  return { ok: true, writes, unmappedParameters };
}

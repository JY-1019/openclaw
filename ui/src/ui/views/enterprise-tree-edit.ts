// Pure helpers for the operator "add child node" affordance. They operate on the
// parsed nested WorkflowTreeDefinition — what enterprise.trees.export serializes
// and enterprise.trees.import consumes — so creating a node stays a splice-then-
// reimport over the ONE existing write path, with no node-level gateway method.

// Dotted lowercase segments, mirroring ENTERPRISE_ID_PATTERN in
// src/enterprise/schema.ts (the import validator rejects anything else). Kept in
// sync by hand: if the core pattern widens, widen here too or valid ids get
// refused in the form before they ever reach the server.
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

/** A node in the nested definition. Unknown fields (ontology) pass through. */
export interface EditableTreeNode {
  id: string;
  title: string;
  description?: string;
  ontology?: unknown;
  children?: EditableTreeNode[];
}

/** The nested definition envelope; non-root keys (schema/id/version/...) pass through. */
export interface EditableTreeDefinition {
  root: EditableTreeNode;
  [key: string]: unknown;
}

/** Every node id in the tree (root + descendants), for uniqueness checks. */
export function collectDefinitionNodeIds(definition: EditableTreeDefinition): Set<string> {
  const ids = new Set<string>();
  const walk = (node: EditableTreeNode): void => {
    ids.add(node.id);
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(definition.root);
  return ids;
}

export type NodeIdIssue = "empty" | "pattern" | "duplicate";

/**
 * Validate a proposed node id against the import contract: non-empty, dotted-
 * lowercase shape, and tree-wide uniqueness (src/enterprise/schema.ts rejects an
 * id that fails any of these). Returns the failing reason, or null when accepted.
 */
export function newNodeIdIssue(id: string, existingIds: ReadonlySet<string>): NodeIdIssue | null {
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (!NODE_ID_PATTERN.test(trimmed)) {
    return "pattern";
  }
  if (existingIds.has(trimmed)) {
    return "duplicate";
  }
  return null;
}

export type InsertChildResult =
  | { ok: true; definition: EditableTreeDefinition }
  | { ok: false; reason: "parent-not-found" | "duplicate-id" };

/**
 * Return a NEW definition with `child` appended under the node identified by
 * `parentId`. Immutable (structuredClone), so a failed splice leaves the caller's
 * definition untouched; every other field — the node's ontology, the envelope
 * keys — is preserved verbatim. The added node is bare (id + title); the operator
 * fills in its ontology in the editor before saving.
 */
export function insertChildNode(
  definition: EditableTreeDefinition,
  parentId: string,
  child: { id: string; title: string },
): InsertChildResult {
  if (collectDefinitionNodeIds(definition).has(child.id)) {
    return { ok: false, reason: "duplicate-id" };
  }
  const next = structuredClone(definition);
  const parent = findNode(next.root, parentId);
  if (!parent) {
    return { ok: false, reason: "parent-not-found" };
  }
  parent.children = [...(parent.children ?? []), { id: child.id, title: child.title }];
  return { ok: true, definition: next };
}

function findNode(node: EditableTreeNode, id: string): EditableTreeNode | null {
  if (node.id === id) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}

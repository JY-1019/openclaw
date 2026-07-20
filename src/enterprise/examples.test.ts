import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowTreeContent } from "./tree-io.js";
import type { WorkflowNodeDefinition } from "./types.js";

const EXAMPLES_DIR = join(process.cwd(), "examples", "enterprise");

function exampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR).filter((file) => file.endsWith(".yaml"));
}

function walk(node: WorkflowNodeDefinition, depth: number): { count: number; maxDepth: number } {
  let count = 1;
  let maxDepth = depth;
  for (const child of node.children ?? []) {
    const sub = walk(child, depth + 1);
    count += sub.count;
    maxDepth = Math.max(maxDepth, sub.maxDepth);
  }
  return { count, maxDepth };
}

function flatten(node: WorkflowNodeDefinition): WorkflowNodeDefinition[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

type NodeScope = { entities: Set<string>; relationships: Set<string> };

/**
 * The object + link types each node can actually address: its own declarations
 * merged with every ancestor's, which is how governance merges the root→node
 * path (src/enterprise/governance.ts) and what the Control UI node inspector
 * renders (collectNodeOntologyGraph). Declaring a type at the root therefore
 * puts it on EVERY node's scope, which is what these tests exist to catch.
 */
function scopesByNode(root: WorkflowNodeDefinition): Map<string, NodeScope> {
  const scopes = new Map<string, NodeScope>();
  const visit = (node: WorkflowNodeDefinition, inherited: NodeScope): void => {
    const scope: NodeScope = {
      entities: new Set(inherited.entities),
      relationships: new Set(inherited.relationships),
    };
    for (const entity of node.ontology?.entities ?? []) {
      scope.entities.add(entity.id);
    }
    for (const relationship of node.ontology?.relationships ?? []) {
      scope.relationships.add(relationship.id);
    }
    scopes.set(node.id, scope);
    for (const child of node.children ?? []) {
      visit(child, scope);
    }
  };
  visit(root, { entities: new Set(), relationships: new Set() });
  return scopes;
}

describe("shipped enterprise example trees", () => {
  it("every example under examples/enterprise validates", () => {
    const files = exampleFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const result = parseWorkflowTreeContent(
        readFileSync(join(EXAMPLES_DIR, file), "utf8"),
        "yaml",
      );
      if (!result.ok) {
        throw new Error(`${file} failed to validate: ${JSON.stringify(result.issues, null, 2)}`);
      }
      expect(result.ok).toBe(true);
    }
  });

  it("keeps the financial-operations tree at route-finding scale", () => {
    // This fixture exists to make route selection a real problem: a shallow or
    // small tree would let any planner look correct. Guard the scale so a future
    // edit cannot quietly shrink it back into a toy.
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { count, maxDepth } = walk(result.tree.root, 0);
    expect(result.tree.id).toBe("acme.financial-operations");
    expect(count).toBeGreaterThanOrEqual(40);
    expect(maxDepth).toBeGreaterThanOrEqual(5);
    // The four top-level domains are what make cross-domain confusion possible.
    expect(result.tree.root.children).toHaveLength(4);
  });

  it("declares a Palantir-style ontology: typed object properties, link cardinality, action effects", () => {
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Object types are declared by the domain that owns them, not at the root,
    // so look tree-wide rather than at root.ontology.
    const nodes = flatten(result.tree.root);
    const entities = nodes.flatMap((node) => node.ontology?.entities ?? []);
    const relationships = nodes.flatMap((node) => node.ontology?.relationships ?? []);
    const claim = entities.find((entity) => entity.id === "claim");
    expect(claim?.properties?.some((property) => property.primaryKey)).toBe(true);
    expect(relationships.length).toBeGreaterThan(0);
    expect(relationships.every((relationship) => relationship.cardinality)).toBe(true);

    // The money-movement step is the one governance must be able to gate, so its
    // action has to declare what it writes.
    const payment = nodes.find((node) => node.id === "finops.claims.settlement.payment");
    const issue = payment?.ontology?.actions?.find((action) => action.id === "issue-claim-payment");
    expect(issue?.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ entity: "payment", kind: "create" })]),
    );
    expect(issue?.preconditions?.length).toBeGreaterThan(0);
  });

  it("scopes the ontology per domain instead of hoisting it onto the root", () => {
    // Regression: every object type used to be declared on the root, so all 40
    // nodes resolved to one identical scope — the node inspector showed the same
    // graph everywhere and the documented sibling isolation was not demonstrated
    // at all (docs/concepts/clawworks-enterprise.md, "the typed object model").
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    const signatures = new Set(
      [...scopes.values()].map((scope) =>
        JSON.stringify([[...scope.entities].toSorted(), [...scope.relationships].toSorted()]),
      ),
    );
    expect(signatures.size).toBeGreaterThanOrEqual(5);

    // The root declares no object types: one that lived here would be addressable
    // from all 40 steps, which is the collapse this test guards.
    expect(result.tree.root.ontology?.entities ?? []).toHaveLength(0);
    expect(result.tree.root.ontology?.relationships ?? []).toHaveLength(0);
  });

  it("keeps sibling domains unable to address each other's object types", () => {
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    // Each case is a confusable pair the tree was built around: the step must
    // reach its own types and must NOT reach the sibling's.
    const cases = [
      {
        node: "finops.claims.settlement.payment",
        reaches: ["payment", "claim"],
        blocked: ["sar", "credit-report", "alert"],
      },
      {
        node: "finops.risk.monitoring.alert-triage",
        reaches: ["alert", "transaction"],
        blocked: ["payment", "claim", "policy"],
      },
      {
        node: "finops.risk.underwriting.scoring",
        reaches: ["credit-report", "customer"],
        blocked: ["claim", "payment", "sar"],
      },
      {
        node: "finops.customer.onboarding.account-opening",
        reaches: ["account", "customer"],
        blocked: ["claim", "alert", "payment"],
      },
      {
        node: "finops.reporting.regulatory",
        reaches: ["regulatory-report", "sar"],
        blocked: ["payment", "policy", "credit-report"],
      },
      // Same domain, one level apart: monitoring cannot see underwriting's bureau data.
      {
        node: "finops.risk.monitoring.investigation.link-analysis",
        reaches: ["customer", "account"],
        blocked: ["credit-report"],
      },
    ];
    for (const { node, reaches, blocked } of cases) {
      const scope = scopes.get(node);
      expect(scope, `${node} is missing from the tree`).toBeDefined();
      for (const entity of reaches) {
        expect([...(scope?.entities ?? [])], `${node} must reach ${entity}`).toContain(entity);
      }
      for (const entity of blocked) {
        expect([...(scope?.entities ?? [])], `${node} must NOT reach ${entity}`).not.toContain(
          entity,
        );
      }
    }
  });

  it("keeps every action effect inside the declaring node's own scope", () => {
    // The schema only checks that an effect's entity is declared SOMEWHERE in the
    // tree, so a mis-scoped action passes import and then cannot resolve its own
    // object type at runtime. This closes that gap for the shipped example.
    const content = readFileSync(join(EXAMPLES_DIR, "financial-operations.clawworks.yaml"), "utf8");
    const result = parseWorkflowTreeContent(content, "yaml");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const scopes = scopesByNode(result.tree.root);
    const unresolved: string[] = [];
    for (const node of flatten(result.tree.root)) {
      const scope = scopes.get(node.id);
      for (const action of node.ontology?.actions ?? []) {
        for (const effect of action.effects ?? []) {
          if (!scope?.entities.has(effect.entity)) {
            unresolved.push(`${node.id} → ${action.id} → ${effect.entity}`);
          }
        }
      }
    }
    expect(unresolved).toEqual([]);
  });
});

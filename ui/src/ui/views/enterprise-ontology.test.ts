import { describe, expect, it } from "vitest";
import type { EnterpriseTreeDetail } from "../../../../packages/gateway-protocol/src/index.js";
import { collectOntologyGraph, nodeObjectEntityIds } from "./enterprise-ontology-graph.ts";

type TreeNode = EnterpriseTreeDetail["nodes"][number];

function tree(nodes: TreeNode[]): EnterpriseTreeDetail {
  return {
    id: "acme.t",
    version: "1.0.0",
    name: "T",
    source: "imported",
    nodes,
  } as EnterpriseTreeDetail;
}

function node(id: string, ontology: TreeNode["ontology"], depth = 0): TreeNode {
  return { id, parentId: depth === 0 ? null : "root", depth, title: id, ontology } as TreeNode;
}

describe("collectOntologyGraph", () => {
  it("unions object types across nodes and extends properties declared deeper", () => {
    const result = collectOntologyGraph(
      tree([
        node("root", {
          entities: [{ id: "claim", title: "Claim", properties: [{ id: "claim-id", type: "id" }] }],
        }),
        node(
          "root.step",
          { entities: [{ id: "claim", properties: [{ id: "amount", type: "number" }] }] },
          1,
        ),
      ]),
    );
    const claim = result.entities.find((entity) => entity.id === "claim");
    expect(claim?.title).toBe("Claim");
    expect(claim?.properties?.map((property) => property.id)).toEqual(["claim-id", "amount"]);
  });

  it("folds a re-declared property so a later primaryKey/required still shows", () => {
    // The schema permits re-declaring a field as long as the type agrees, and the
    // later declaration may be the one that finally marks it a primary key.
    const result = collectOntologyGraph(
      tree([
        node("root", { entities: [{ id: "claim", properties: [{ id: "claim-id", type: "id" }] }] }),
        node(
          "root.step",
          {
            entities: [
              {
                id: "claim",
                properties: [{ id: "claim-id", type: "id", primaryKey: true, required: true }],
              },
            ],
          },
          1,
        ),
      ]),
    );
    const claimId = result.entities
      .find((entity) => entity.id === "claim")
      ?.properties?.find((property) => property.id === "claim-id");
    expect(claimId?.primaryKey).toBe(true);
    expect(claimId?.required).toBe(true);
    // Still one property, not two.
    expect(result.entities.find((entity) => entity.id === "claim")?.properties).toHaveLength(1);
  });

  it("synthesizes link endpoints that were never declared as object types", () => {
    const result = collectOntologyGraph(
      tree([
        node("root", {
          entities: [{ id: "claim" }],
          relationships: [{ id: "claim-against-policy", from: "claim", to: "policy" }],
        }),
      ]),
    );
    expect(result.entities.map((entity) => entity.id).toSorted()).toEqual(["claim", "policy"]);
  });

  it("dedupes a link re-declared on parent and child", () => {
    const relationship = { id: "claim-against-policy", from: "claim", to: "policy" };
    const result = collectOntologyGraph(
      tree([
        node("root", {
          entities: [{ id: "claim" }, { id: "policy" }],
          relationships: [relationship],
        }),
        node("root.step", { relationships: [relationship] }, 1),
      ]),
    );
    expect(result.relationships).toHaveLength(1);
  });

  it("fills in link metadata a deeper step declares on an ancestor's bare link", () => {
    // The schema permits a child to add cardinality/inverse the ancestor omitted;
    // keeping only the first declaration would render the bare link.
    const result = collectOntologyGraph(
      tree([
        node("root", {
          entities: [{ id: "customer" }, { id: "account" }],
          relationships: [{ id: "customer-holds-account", from: "customer", to: "account" }],
        }),
        node(
          "root.step",
          {
            relationships: [
              {
                id: "customer-holds-account",
                from: "customer",
                to: "account",
                cardinality: "one-to-many",
                inverse: "account-owned-by",
              },
            ],
          },
          1,
        ),
      ]),
    );
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0].cardinality).toBe("one-to-many");
    expect(result.relationships[0].inverse).toBe("account-owned-by");
  });

  it("keeps link cardinality and inverse (the parts that make it a link type)", () => {
    const result = collectOntologyGraph(
      tree([
        node("root", {
          entities: [{ id: "customer" }, { id: "account" }],
          relationships: [
            {
              id: "customer-holds-account",
              from: "customer",
              to: "account",
              cardinality: "one-to-many",
              inverse: "account-owned-by",
            },
          ],
        }),
      ]),
    );
    expect(result.relationships[0].cardinality).toBe("one-to-many");
    expect(result.relationships[0].inverse).toBe("account-owned-by");
  });
});

describe("nodeObjectEntityIds", () => {
  it("offers a chip only for object types that declare a primaryKey", () => {
    const result = nodeObjectEntityIds(
      tree([
        node("root", {
          entities: [
            { id: "claim", properties: [{ id: "cid", type: "id", primaryKey: true }] },
            // Descriptive properties but no primaryKey: instances can't be addressed.
            { id: "note", properties: [{ id: "text", type: "string" }] },
            // No properties at all.
            { id: "policy" },
          ],
        }),
      ]),
      "root",
    );
    expect(result).toEqual(["claim"]);
  });

  it("counts a primaryKey a deeper step marks on an ancestor's bare property", () => {
    const result = nodeObjectEntityIds(
      tree([
        node("root", { entities: [{ id: "claim", properties: [{ id: "cid", type: "id" }] }] }),
        node(
          "root.step",
          {
            entities: [{ id: "claim", properties: [{ id: "cid", type: "id", primaryKey: true }] }],
          },
          1,
        ),
      ]),
      "root.step",
    );
    // The path merge folds the later primaryKey in, so the node scope sees it.
    expect(result).toEqual(["claim"]);
  });
});

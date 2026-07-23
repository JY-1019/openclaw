/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { EnterpriseRunDetail } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawChatRouteCard } from "./route-card.ts";
import "./route-card.ts";

function runDetail(): EnterpriseRunDetail {
  return {
    executionId: "exec-1",
    runId: "run-1",
    sessionKey: null,
    agentId: null,
    treeId: "acme.support",
    treeVersion: "1.0.0",
    treeName: "Support",
    mode: "enforce",
    status: "completed",
    matchedBy: "planner",
    requestSummary: "help",
    activeNodeId: "support",
    nodes: [{ nodeId: "support", parentId: null, seq: 0, title: "Support", ontology: {} }],
    events: [],
    executionCount: 1,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
  };
}

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

describe("openclaw-chat-route-card expand", () => {
  it("opens the route graph in a modal on expand, and closes on cancel", async () => {
    container = document.createElement("div");
    document.body.append(container);
    render(
      html`<openclaw-chat-route-card .run=${runDetail()}></openclaw-chat-route-card>`,
      container,
    );
    const element = container.querySelector<OpenClawChatRouteCard>("openclaw-chat-route-card");
    if (!element) {
      throw new Error("route card did not mount");
    }
    await element.updateComplete;
    // No modal until the user asks for one.
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();

    const expandButton = element.shadowRoot?.querySelector<HTMLButtonElement>("button.expand");
    expandButton?.click();
    await element.updateComplete;
    const modal = element.shadowRoot?.querySelector("openclaw-modal-dialog");
    expect(modal).not.toBeNull();
    // The modal reuses the same tree-graph component for the larger view.
    expect(modal?.querySelector("openclaw-workflow-tree-graph")).not.toBeNull();

    modal?.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
  });
});

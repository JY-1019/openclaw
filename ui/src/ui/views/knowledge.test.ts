/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { type KnowledgeProps, renderKnowledge } from "./knowledge.ts";

function buildProps(overrides?: Partial<KnowledgeProps>): KnowledgeProps {
  const props: KnowledgeProps = {
    phase: "ready",
    foundations: [],
    connections: {},
    error: null,
    onRefresh: vi.fn(),
    onTestConnection: vi.fn(),
  };
  return { ...props, ...overrides };
}

function renderInto(props: KnowledgeProps): HTMLElement {
  const container = document.createElement("div");
  render(renderKnowledge(props), container);
  return container;
}

function foundation(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme.kb",
    kind: "remote" as const,
    displayName: "Acme KB",
    referencedBy: [],
    ...overrides,
  } as KnowledgeProps["foundations"][number];
}

describe("renderKnowledge", () => {
  it("shows the empty state once loading has finished", () => {
    const container = renderInto(buildProps());
    expect(container.textContent).toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none while the first load is in flight", () => {
    // Asserting "none registered" before the answer arrives would be wrong.
    const container = renderInto(buildProps({ phase: "loading" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none before any load has started", () => {
    // Deep-linking to /knowledge renders before the tab dispatches its load.
    const container = renderInto(buildProps({ phase: "unloaded" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
  });

  it("does not claim there are none when the load failed", () => {
    // A failed load says nothing about how many exist; the error explains it.
    const container = renderInto(buildProps({ phase: "failed", error: "nope" }));
    expect(container.textContent).not.toContain("No knowledge foundations are registered");
    expect(container.querySelector(".callout.danger")?.textContent).toContain("nope");
  });

  it("renders the display name, id, detail, and kind badge", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation({ kind: "local", detail: "http://kb:9621" })],
      }),
    );
    expect(container.textContent).toContain("Acme KB");
    expect(container.textContent).toContain("acme.kb");
    expect(container.textContent).toContain("http://kb:9621");
    expect(container.textContent).toContain("local");
  });

  it("calls back with the foundation id when test connection is clicked", () => {
    const onTestConnection = vi.fn();
    const container = renderInto(buildProps({ foundations: [foundation()], onTestConnection }));
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Test connection"),
    );
    button?.click();
    expect(onTestConnection).toHaveBeenCalledWith("acme.kb");
  });

  it("disables the button and shows progress while a probe is in flight", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "testing" } },
      }),
    );
    const button = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Testing"),
    );
    expect(button).toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders each probe status with its own label", () => {
    const cases = [
      { status: "ok", label: "Reachable" },
      { status: "failed", label: "Unreachable" },
      { status: "unsupported", label: "Not checkable" },
      { status: "not-registered", label: "No longer registered" },
    ] as const;
    for (const { status, label } of cases) {
      const container = renderInto(
        buildProps({
          foundations: [foundation()],
          connections: { "acme.kb": { phase: "done", status } },
        }),
      );
      expect(container.textContent).toContain(label);
    }
  });

  it("does not color a non-failure status as an error", () => {
    // "cannot check" is not the server being down; red would misreport it.
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "done", status: "unsupported" } },
      }),
    );
    const chip = [...container.querySelectorAll("span.chip")].find((candidate) =>
      candidate.textContent?.includes("Not checkable"),
    );
    expect(chip?.getAttribute("style")).not.toContain("--danger");
  });

  it("shows the failure detail next to the status", () => {
    const container = renderInto(
      buildProps({
        foundations: [foundation()],
        connections: { "acme.kb": { phase: "done", status: "failed", detail: "ECONNREFUSED" } },
      }),
    );
    expect(container.textContent).toContain("ECONNREFUSED");
  });

  it("calls out a foundation no workflow step references", () => {
    const container = renderInto(buildProps({ foundations: [foundation()] }));
    expect(container.textContent).toContain("Not referenced by any workflow step");
  });

  it("lists the referencing steps with their tree", () => {
    const container = renderInto(
      buildProps({
        foundations: [
          foundation({
            referencedBy: [
              { treeId: "t.one", treeName: "Support", nodeId: "n.one", nodeTitle: "Answer" },
              { treeId: "t.one", treeName: "Support", nodeId: "n.two", nodeTitle: "Escalate" },
            ],
          }),
        ],
      }),
    );
    expect(container.textContent).toContain("Referenced by 2 step(s)");
    expect(container.textContent).toContain("Answer");
    expect(container.textContent).toContain("Escalate");
  });

  it("surfaces a tab-level error", () => {
    const container = renderInto(buildProps({ error: "boom" }));
    expect(container.querySelector(".callout.danger")?.textContent).toContain("boom");
  });
});

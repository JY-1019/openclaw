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
    canManageFiles: true,
    filesOpenFor: null,
    documents: {},
    uploadingFor: null,
    documentConfirm: null,
    documentNotice: null,
    onRefresh: vi.fn(),
    onTestConnection: vi.fn(),
    onOpenFiles: vi.fn(),
    onCloseFiles: vi.fn(),
    onUpload: vi.fn(),
    onRequestRemove: vi.fn(),
    onCancelRemove: vi.fn(),
    onConfirmRemove: vi.fn(),
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

describe("renderKnowledge files section", () => {
  const local = (overrides: Record<string, unknown> = {}) =>
    foundation({ kind: "local", ...overrides });

  function findButton(container: HTMLElement, text: string) {
    return [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(text),
    );
  }

  it("offers files only for a foundation this deployment administers", () => {
    // A remote foundation is read-only by contract, so the control would be a
    // dead affordance that fails on click.
    const remote = renderInto(buildProps({ foundations: [foundation({ kind: "remote" })] }));
    expect(findButton(remote, "Show files")).toBeUndefined();

    const localised = renderInto(buildProps({ foundations: [local()] }));
    expect(findButton(localised, "Show files")).toBeDefined();
  });

  it("opens the files section with the foundation id", () => {
    const onOpenFiles = vi.fn();
    const container = renderInto(buildProps({ foundations: [local()], onOpenFiles }));
    findButton(container, "Show files")?.click();
    expect(onOpenFiles).toHaveBeenCalledWith("acme.kb");
  });

  it("does not claim there are no documents while the list is loading", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "loading" } },
      }),
    );
    expect(container.textContent).not.toContain("No documents have been uploaded yet");
  });

  it("renders documents with status, chunk count, and summary", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": {
            phase: "ready",
            documents: [
              {
                id: "d1",
                name: "handbook.pdf",
                status: "indexed",
                summary: "Company handbook",
                chunkCount: 12,
              },
            ],
          },
        },
      }),
    );
    expect(container.textContent).toContain("handbook.pdf");
    expect(container.textContent).toContain("Indexed");
    expect(container.textContent).toContain("12 chunk(s)");
    expect(container.textContent).toContain("Company handbook");
  });

  it("explains that a store exposes no preview instead of rendering blank", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
      }),
    );
    expect(container.textContent).toContain("exposes no preview");
  });

  it("shows a failed document's indexing error", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": {
            phase: "ready",
            documents: [{ id: "d1", name: "bad.md", status: "failed", error: "parse error" }],
          },
        },
      }),
    );
    expect(container.textContent).toContain("Failed");
    expect(container.textContent).toContain("parse error");
  });

  it("explains each unavailable reason distinctly", () => {
    const cases = [
      { status: "read-only", text: "operated elsewhere" },
      { status: "unsupported", text: "does not expose document management" },
      { status: "not-registered", text: "no longer registered" },
      { status: "failed", text: "Could not load documents" },
    ] as const;
    for (const { status, text } of cases) {
      const container = renderInto(
        buildProps({
          foundations: [local()],
          filesOpenFor: "acme.kb",
          documents: { "acme.kb": { phase: "unavailable", status } },
        }),
      );
      expect(container.textContent).toContain(text);
    }
  });

  it("hides upload and remove controls without admin scope", () => {
    const container = renderInto(
      buildProps({
        canManageFiles: false,
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
      }),
    );
    expect(container.textContent).not.toContain("Upload document");
    expect(findButton(container, "Remove")).toBeUndefined();
  });

  it("offers upload for a ready, admin-managed local foundation", () => {
    // Guards the negative cases below from over-correcting into "never shown".
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
      }),
    );
    expect(container.textContent).toContain("Upload document");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input?.disabled).toBe(false);
  });

  it("blocks upload while another foundation's upload is in flight", () => {
    // Uploads are serialized tab-wide, so an enabled-looking control on a
    // second foundation would silently no-op when picked.
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
        uploadingFor: "other.kb",
      }),
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);
    // The busy label belongs to the foundation actually uploading.
    expect(container.textContent).not.toContain("Uploading");
  });

  it("hides upload until the document list has answered", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "loading" } },
      }),
    );
    expect(container.textContent).not.toContain("Upload document");
  });

  it("hides upload when the store reports it cannot manage documents", () => {
    // Offering upload here would hand the user a control whose only outcome is
    // a refusal from the gateway.
    for (const status of ["unsupported", "not-registered", "failed"] as const) {
      const container = renderInto(
        buildProps({
          foundations: [local()],
          filesOpenFor: "acme.kb",
          documents: { "acme.kb": { phase: "unavailable", status } },
        }),
      );
      expect(container.textContent).not.toContain("Upload document");
    }
  });

  it("asks for confirmation before removing rather than deleting on click", () => {
    const onRequestRemove = vi.fn();
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: {
          "acme.kb": { phase: "ready", documents: [{ id: "d1", name: "a.md", status: "indexed" }] },
        },
        onRequestRemove,
      }),
    );
    findButton(container, "Remove")?.click();
    expect(onRequestRemove).toHaveBeenCalledWith({
      foundationId: "acme.kb",
      documentId: "d1",
      documentName: "a.md",
    });
  });

  it("warns that removal is irreversible in the confirm dialog", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        documentConfirm: {
          foundationId: "acme.kb",
          documentId: "d1",
          documentName: "handbook.pdf",
        },
      }),
    );
    expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(container.textContent).toContain("Remove handbook.pdf?");
    expect(container.textContent).toContain("cannot be undone");
  });

  it("surfaces the last file-action notice", () => {
    const container = renderInto(
      buildProps({
        foundations: [local()],
        filesOpenFor: "acme.kb",
        documents: { "acme.kb": { phase: "ready", documents: [] } },
        documentNotice: "Removal of a.md started. It runs in the background.",
      }),
    );
    expect(container.textContent).toContain("started");
  });
});

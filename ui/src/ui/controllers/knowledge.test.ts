import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError } from "../gateway.ts";
import {
  cancelKnowledgeDocumentRemoval,
  confirmKnowledgeDocumentRemoval,
  type KnowledgeState,
  loadKnowledgeDocuments,
  loadKnowledgeFoundations,
  openKnowledgeFiles,
  requestKnowledgeDocumentRemoval,
  testKnowledgeFoundationConnection,
  uploadKnowledgeDocument,
} from "./knowledge.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): {
  state: KnowledgeState;
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const request = vi.fn<TestRequest>();
  const state: KnowledgeState = {
    client: { request } as unknown as KnowledgeState["client"],
    connected: true,
    knowledgePhase: "unloaded",
    knowledgeFoundations: [],
    knowledgeConnections: {},
    knowledgeError: null,
    knowledgeFilesOpenFor: null,
    knowledgeDocuments: {},
    knowledgeUploadingFor: null,
    knowledgeDocumentConfirm: null,
    knowledgeDocumentNotice: null,
  };
  return { state, request };
}

function foundation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "remote" as const,
    displayName: id,
    referencedBy: [],
    ...overrides,
  };
}

describe("loadKnowledgeFoundations", () => {
  let ctx: ReturnType<typeof createState>;

  beforeEach(() => {
    ctx = createState();
  });

  it("loads foundations and marks the list ready", async () => {
    ctx.request.mockResolvedValue({ foundations: [foundation("acme.kb")] });

    await loadKnowledgeFoundations(ctx.state);

    expect(ctx.request).toHaveBeenCalledWith("enterprise.knowledge.foundations.list", {});
    expect(ctx.state.knowledgeFoundations.map((entry) => entry.id)).toEqual(["acme.kb"]);
    expect(ctx.state.knowledgePhase).toBe("ready");
    expect(ctx.state.knowledgeError).toBeNull();
  });

  it("does nothing while disconnected", async () => {
    ctx.state.connected = false;
    await loadKnowledgeFoundations(ctx.state);
    expect(ctx.request).not.toHaveBeenCalled();
  });

  it("lets a newer load supersede an in-flight one", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    ctx.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const stalled = loadKnowledgeFoundations(ctx.state);

    ctx.request.mockResolvedValue({ foundations: [foundation("new.kb")] });
    await loadKnowledgeFoundations(ctx.state);
    expect(ctx.state.knowledgeFoundations.map((entry) => entry.id)).toEqual(["new.kb"]);

    // The stale response resolves last and must not overwrite the newer one.
    releaseFirst?.({ foundations: [foundation("old.kb")] });
    await stalled;
    expect(ctx.state.knowledgeFoundations.map((entry) => entry.id)).toEqual(["new.kb"]);
    expect(ctx.state.knowledgePhase).toBe("ready");
  });

  it("drops probe results for foundations that disappeared from the list", async () => {
    ctx.request.mockResolvedValue({ status: "ok" });
    await testKnowledgeFoundationConnection(ctx.state, "gone.kb");
    expect(ctx.state.knowledgeConnections["gone.kb"]).toEqual({ phase: "done", status: "ok" });

    ctx.request.mockResolvedValue({ foundations: [foundation("acme.kb")] });
    await loadKnowledgeFoundations(ctx.state);

    // A deactivated plugin's last known status must not linger on a stale row.
    expect(ctx.state.knowledgeConnections).toEqual({});
  });

  it("wipes governed data and explains the failure when operator.read is missing", async () => {
    ctx.state.knowledgeFoundations = [foundation("acme.kb")];
    ctx.request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await loadKnowledgeFoundations(ctx.state);

    expect(ctx.state.knowledgeFoundations).toEqual([]);
    expect(ctx.state.knowledgeConnections).toEqual({});
    expect(ctx.state.knowledgePhase).toBe("failed");
    expect(ctx.state.knowledgeError).toMatch(/operator\.read/);
  });

  it("stays unloaded until a load starts, so the view cannot claim there are none", () => {
    // A deep link into the tab renders before its load is dispatched; an empty
    // array plus a false loading flag would read as "none registered".
    expect(ctx.state.knowledgePhase).toBe("unloaded");
  });

  it("does not resurrect a probe whose foundation the reload removed", async () => {
    let releaseProbe: ((value: unknown) => void) | undefined;
    ctx.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        }),
    );
    const probe = testKnowledgeFoundationConnection(ctx.state, "kb-a");

    ctx.request.mockResolvedValue({ foundations: [foundation("kb-b")] });
    await loadKnowledgeFoundations(ctx.state);

    releaseProbe?.({ status: "ok" });
    await probe;

    // Without dropping kb-a's request token the late probe would re-add a
    // hidden entry that a future foundation reusing the id would inherit.
    expect(ctx.state.knowledgeConnections).toEqual({});
  });

  it("does not let a removed foundation's status reappear when the id comes back", async () => {
    ctx.request.mockResolvedValue({ status: "failed", detail: "was down" });
    await testKnowledgeFoundationConnection(ctx.state, "kb-a");

    ctx.request.mockResolvedValue({ foundations: [] });
    await loadKnowledgeFoundations(ctx.state);

    ctx.request.mockResolvedValue({ foundations: [foundation("kb-a")] });
    await loadKnowledgeFoundations(ctx.state);

    expect(ctx.state.knowledgeConnections["kb-a"]).toBeUndefined();
  });
});

describe("testKnowledgeFoundationConnection", () => {
  let ctx: ReturnType<typeof createState>;

  beforeEach(() => {
    ctx = createState();
  });

  it("records the probe status and detail", async () => {
    ctx.request.mockResolvedValue({ status: "failed", detail: "ECONNREFUSED" });

    await testKnowledgeFoundationConnection(ctx.state, "acme.kb");

    expect(ctx.request).toHaveBeenCalledWith("enterprise.knowledge.foundations.testConnection", {
      foundationId: "acme.kb",
    });
    expect(ctx.state.knowledgeConnections["acme.kb"]).toEqual({
      phase: "done",
      status: "failed",
      detail: "ECONNREFUSED",
    });
  });

  it("marks the row as testing while the probe is in flight", async () => {
    let release: ((value: unknown) => void) | undefined;
    ctx.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const pending = testKnowledgeFoundationConnection(ctx.state, "acme.kb");
    expect(ctx.state.knowledgeConnections["acme.kb"]).toEqual({ phase: "testing" });

    release?.({ status: "ok" });
    await pending;
    expect(ctx.state.knowledgeConnections["acme.kb"]).toEqual({ phase: "done", status: "ok" });
  });

  it("lets a second probe of the same foundation supersede the first", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    ctx.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const stalled = testKnowledgeFoundationConnection(ctx.state, "acme.kb");

    ctx.request.mockResolvedValue({ status: "ok" });
    await testKnowledgeFoundationConnection(ctx.state, "acme.kb");
    expect(ctx.state.knowledgeConnections["acme.kb"]).toEqual({ phase: "done", status: "ok" });

    releaseFirst?.({ status: "failed", detail: "stale" });
    await stalled;
    expect(ctx.state.knowledgeConnections["acme.kb"]).toEqual({ phase: "done", status: "ok" });
  });

  it("keeps concurrent probes of different foundations independent", async () => {
    const releases: Record<string, (value: unknown) => void> = {};
    ctx.request.mockImplementation(
      (_method, payload) =>
        new Promise((resolve) => {
          releases[(payload as { foundationId: string }).foundationId] = resolve;
        }),
    );

    const a = testKnowledgeFoundationConnection(ctx.state, "a.kb");
    const b = testKnowledgeFoundationConnection(ctx.state, "b.kb");

    // b started later, so a shared counter would treat a's response as stale.
    releases["a.kb"]?.({ status: "ok" });
    releases["b.kb"]?.({ status: "failed", detail: "down" });
    await Promise.all([a, b]);

    expect(ctx.state.knowledgeConnections["a.kb"]).toEqual({ phase: "done", status: "ok" });
    expect(ctx.state.knowledgeConnections["b.kb"]).toEqual({
      phase: "done",
      status: "failed",
      detail: "down",
    });
  });

  it("releases its request token so the tracking map does not grow unbounded", async () => {
    ctx.request.mockResolvedValue({ status: "ok" });
    for (const id of ["a.kb", "b.kb", "c.kb"]) {
      await testKnowledgeFoundationConnection(ctx.state, id);
    }

    // A completed probe owns nothing, so a later reload that prunes ids has
    // nothing stale to clean up and long sessions do not accumulate entries.
    ctx.request.mockResolvedValue({ foundations: [] });
    await loadKnowledgeFoundations(ctx.state);
    expect(ctx.state.knowledgeConnections).toEqual({});
  });

  it("marks only the probed row failed on a transport error", async () => {
    ctx.state.knowledgeFoundations = [foundation("acme.kb"), foundation("other.kb")];
    ctx.request.mockRejectedValue(new Error("socket closed"));

    await testKnowledgeFoundationConnection(ctx.state, "acme.kb");

    // The tab stays usable: one failed probe is not a tab-level error.
    expect(ctx.state.knowledgeError).toBeNull();
    expect(ctx.state.knowledgeFoundations).toHaveLength(2);
    expect(ctx.state.knowledgeConnections["acme.kb"]).toMatchObject({
      phase: "done",
      status: "failed",
    });
  });

  it("escalates a scope failure to the tab-level error", async () => {
    ctx.state.knowledgeFoundations = [foundation("acme.kb")];
    ctx.request.mockRejectedValue(
      new GatewayRequestError({ code: "UNAUTHORIZED", message: "missing scope: operator.read" }),
    );

    await testKnowledgeFoundationConnection(ctx.state, "acme.kb");

    expect(ctx.state.knowledgeError).toMatch(/operator\.read/);
    expect(ctx.state.knowledgeFoundations).toEqual([]);
    expect(ctx.state.knowledgeConnections).toEqual({});
  });
});

describe("knowledge documents", () => {
  let ctx: ReturnType<typeof createState>;

  beforeEach(() => {
    ctx = createState();
  });

  function fakeFile(name: string, contents: string, size?: number): File {
    const bytes = new TextEncoder().encode(contents);
    return {
      name,
      size: size ?? bytes.byteLength,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  it("loads documents when a files section opens", async () => {
    ctx.request.mockResolvedValue({
      status: "ok",
      documents: [{ id: "d1", name: "a.md", status: "indexed" }],
    });

    await openKnowledgeFiles(ctx.state, "local.kb");

    expect(ctx.state.knowledgeFilesOpenFor).toBe("local.kb");
    expect(ctx.request).toHaveBeenCalledWith("enterprise.knowledge.documents.list", {
      foundationId: "local.kb",
    });
    expect(ctx.state.knowledgeDocuments["local.kb"]).toEqual({
      phase: "ready",
      documents: [{ id: "d1", name: "a.md", status: "indexed" }],
    });
  });

  it("records a non-ok list status instead of showing an empty file list", async () => {
    ctx.request.mockResolvedValue({ status: "read-only", documents: [] });
    await loadKnowledgeDocuments(ctx.state, "remote.kb");
    expect(ctx.state.knowledgeDocuments["remote.kb"]).toEqual({
      phase: "unavailable",
      status: "read-only",
    });
  });

  it("lets a newer document load supersede an in-flight one", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    ctx.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const stalled = loadKnowledgeDocuments(ctx.state, "local.kb");

    ctx.request.mockResolvedValue({
      status: "ok",
      documents: [{ id: "new", name: "new.md", status: "indexed" }],
    });
    await loadKnowledgeDocuments(ctx.state, "local.kb");

    releaseFirst?.({ status: "ok", documents: [{ id: "old", name: "old.md", status: "indexed" }] });
    await stalled;

    const documents = ctx.state.knowledgeDocuments["local.kb"];
    expect(documents.phase === "ready" && documents.documents.map((d) => d.id)).toEqual(["new"]);
  });

  it("rejects an oversized file locally without sending it over the socket", async () => {
    await uploadKnowledgeDocument(
      ctx.state,
      "local.kb",
      fakeFile("big.bin", "x", ENTERPRISE_KNOWLEDGE_DOCUMENT_MAX_BYTES + 1),
    );

    expect(ctx.request).not.toHaveBeenCalled();
    expect(ctx.state.knowledgeDocumentNotice).toMatch(/larger than/);
  });

  it("uploads as base64 and reloads so the pending row appears", async () => {
    ctx.request.mockImplementation(async (method) => {
      if (method === "enterprise.knowledge.documents.upload") {
        return { status: "accepted", trackingId: "job-1" };
      }
      return {
        status: "ok",
        documents: [{ id: "d1", name: "notes.md", status: "pending" }],
      };
    });

    await uploadKnowledgeDocument(ctx.state, "local.kb", fakeFile("notes.md", "hello"));

    const uploadCall = ctx.request.mock.calls.find(
      ([method]) => method === "enterprise.knowledge.documents.upload",
    );
    const uploadPayload = uploadCall?.[1] as { contentBase64: string } | undefined;
    expect(uploadPayload?.contentBase64).toBe(btoa("hello"));
    expect(ctx.state.knowledgeDocumentNotice).toMatch(/uploaded/);
    // Indexing is async, so the list is reloaded to reveal the pending row.
    const documents = ctx.state.knowledgeDocuments["local.kb"];
    expect(documents.phase === "ready" && documents.documents[0].status).toBe("pending");
    expect(ctx.state.knowledgeUploadingFor).toBeNull();
  });

  it("explains a duplicate upload without reloading the list", async () => {
    ctx.request.mockResolvedValue({ status: "duplicate", detail: "already there" });

    await uploadKnowledgeDocument(ctx.state, "local.kb", fakeFile("notes.md", "hi"));

    expect(ctx.state.knowledgeDocumentNotice).toMatch(/already exists/);
    expect(ctx.request).toHaveBeenCalledTimes(1);
  });

  it("ignores a second upload while one is already in flight", async () => {
    ctx.request.mockImplementation(() => new Promise(() => {}));
    void uploadKnowledgeDocument(ctx.state, "local.kb", fakeFile("a.md", "a"));
    await uploadKnowledgeDocument(ctx.state, "local.kb", fakeFile("b.md", "b"));
    expect(ctx.request).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before removing and clears it on cancel", async () => {
    requestKnowledgeDocumentRemoval(ctx.state, {
      foundationId: "local.kb",
      documentId: "d1",
      documentName: "a.md",
    });
    expect(ctx.state.knowledgeDocumentConfirm).not.toBeNull();

    cancelKnowledgeDocumentRemoval(ctx.state);
    expect(ctx.state.knowledgeDocumentConfirm).toBeNull();
    expect(ctx.request).not.toHaveBeenCalled();
  });

  it("reports that a removal started rather than that it finished", async () => {
    ctx.request.mockImplementation(async (method) =>
      method === "enterprise.knowledge.documents.remove"
        ? { status: "started" }
        : { status: "ok", documents: [] },
    );
    requestKnowledgeDocumentRemoval(ctx.state, {
      foundationId: "local.kb",
      documentId: "d1",
      documentName: "a.md",
    });

    await confirmKnowledgeDocumentRemoval(ctx.state);

    // The store deletes in the background; "removed" would be a claim the next
    // reload could contradict.
    expect(ctx.state.knowledgeDocumentNotice).toMatch(/started/);
    expect(ctx.state.knowledgeDocumentConfirm).toBeNull();
  });

  it("surfaces a busy store on removal", async () => {
    ctx.request.mockImplementation(async (method) =>
      method === "enterprise.knowledge.documents.remove"
        ? { status: "busy" }
        : { status: "ok", documents: [] },
    );
    requestKnowledgeDocumentRemoval(ctx.state, {
      foundationId: "local.kb",
      documentId: "d1",
      documentName: "a.md",
    });

    await confirmKnowledgeDocumentRemoval(ctx.state);
    expect(ctx.state.knowledgeDocumentNotice).toMatch(/busy/);
  });

  it("closes an open files section when its foundation leaves the list", async () => {
    ctx.request.mockResolvedValue({ status: "ok", documents: [] });
    await openKnowledgeFiles(ctx.state, "gone.kb");

    ctx.request.mockResolvedValue({ foundations: [foundation("other.kb")] });
    await loadKnowledgeFoundations(ctx.state);

    // Leaving it open would render a panel for a foundation with no row.
    expect(ctx.state.knowledgeFilesOpenFor).toBeNull();
    expect(ctx.state.knowledgeDocuments).toEqual({});
  });

  it("drops a pending remove confirm when its foundation leaves the list", async () => {
    requestKnowledgeDocumentRemoval(ctx.state, {
      foundationId: "gone.kb",
      documentId: "d1",
      documentName: "a.md",
    });

    ctx.request.mockResolvedValue({ foundations: [foundation("other.kb")] });
    await loadKnowledgeFoundations(ctx.state);

    expect(ctx.state.knowledgeDocumentConfirm).toBeNull();
  });
});

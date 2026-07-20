import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../gateway.ts";
import {
  type KnowledgeState,
  loadKnowledgeFoundations,
  testKnowledgeFoundationConnection,
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

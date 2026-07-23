import { describe, expect, it } from "vitest";
import { parseLightRagFoundations } from "./config.js";

describe("parseLightRagFoundations", () => {
  it("returns [] for missing/invalid config", () => {
    expect(parseLightRagFoundations(undefined)).toEqual([]);
    expect(parseLightRagFoundations({})).toEqual([]);
    expect(parseLightRagFoundations({ foundations: "nope" })).toEqual([]);
  });

  it("parses valid foundations, defaults mode/kind, and drops entries missing id/serverUrl", () => {
    const result = parseLightRagFoundations({
      foundations: [
        {
          id: "acme.kb",
          serverUrl: "http://localhost:9621",
          kind: "local",
          mode: "hybrid",
          apiKey: "k",
        },
        { id: "acme.default", serverUrl: "http://kb" },
        { id: "", serverUrl: "http://x" }, // blank id dropped
        { serverUrl: "http://y" }, // missing id dropped
        { id: "no.server" }, // missing serverUrl dropped
        { id: "bad.mode", serverUrl: "http://z", mode: "unknown" }, // unknown mode -> default
        { id: "bad.kind", serverUrl: "http://z", kind: "sideways" }, // unknown kind -> default
      ],
    });
    expect(result).toEqual([
      {
        id: "acme.kb",
        serverUrl: "http://localhost:9621",
        kind: "local",
        mode: "hybrid",
        apiKey: "k",
      },
      { id: "acme.default", serverUrl: "http://kb", kind: "remote", mode: "mix" },
      { id: "bad.mode", serverUrl: "http://z", kind: "remote", mode: "mix" },
      { id: "bad.kind", serverUrl: "http://z", kind: "remote", mode: "mix" },
    ]);
  });

  it("parses an optional non-blank description and omits it when blank/absent", () => {
    const result = parseLightRagFoundations({
      foundations: [
        { id: "with.desc", serverUrl: "http://kb", description: "  Support policies  " },
        { id: "blank.desc", serverUrl: "http://kb", description: "   " },
        { id: "no.desc", serverUrl: "http://kb" },
      ],
    });
    expect(result).toEqual([
      {
        id: "with.desc",
        serverUrl: "http://kb",
        kind: "remote",
        mode: "mix",
        description: "Support policies",
      },
      { id: "blank.desc", serverUrl: "http://kb", kind: "remote", mode: "mix" },
      { id: "no.desc", serverUrl: "http://kb", kind: "remote", mode: "mix" },
    ]);
  });

  it("defaults kind to remote so an upgrade never exposes document management", () => {
    // Foundations configured before `kind` existed must stay read-only: the
    // operator has not declared that server as theirs to administer.
    const [foundation] = parseLightRagFoundations({
      foundations: [{ id: "legacy.kb", serverUrl: "http://kb" }],
    });
    expect(foundation.kind).toBe("remote");
  });

  it("drops a non-string apiKey (secret refs are resolved to strings upstream)", () => {
    // The manifest declares foundations.*.apiKey as a secret input, so the
    // secrets runtime materializes any ${ENV}/SecretRef before parsing. A value
    // still shaped like a ref here means resolution failed; drop it rather than
    // hand a non-string to the adapter.
    const result = parseLightRagFoundations({
      foundations: [{ id: "kb", serverUrl: "http://kb", apiKey: { $secret: "lightrag-key" } }],
    });
    expect(result).toEqual([{ id: "kb", serverUrl: "http://kb", kind: "remote", mode: "mix" }]);
  });
});

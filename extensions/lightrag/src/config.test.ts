import { describe, expect, it } from "vitest";
import { parseLightRagFoundations } from "./config.js";

describe("parseLightRagFoundations", () => {
  it("returns [] for missing/invalid config", () => {
    expect(parseLightRagFoundations(undefined)).toEqual([]);
    expect(parseLightRagFoundations({})).toEqual([]);
    expect(parseLightRagFoundations({ foundations: "nope" })).toEqual([]);
  });

  it("parses valid foundations, defaults mode, and drops entries missing id/serverUrl", () => {
    const result = parseLightRagFoundations({
      foundations: [
        { id: "acme.kb", serverUrl: "http://localhost:9621", mode: "hybrid", apiKey: "k" },
        { id: "acme.default", serverUrl: "http://kb" },
        { id: "", serverUrl: "http://x" }, // blank id dropped
        { serverUrl: "http://y" }, // missing id dropped
        { id: "no.server" }, // missing serverUrl dropped
        { id: "bad.mode", serverUrl: "http://z", mode: "unknown" }, // unknown mode -> default
      ],
    });
    expect(result).toEqual([
      { id: "acme.kb", serverUrl: "http://localhost:9621", mode: "hybrid", apiKey: "k" },
      { id: "acme.default", serverUrl: "http://kb", mode: "mix" },
      { id: "bad.mode", serverUrl: "http://z", mode: "mix" },
    ]);
  });

  it("drops a non-string apiKey (secret refs are resolved to strings upstream)", () => {
    // The manifest declares foundations.*.apiKey as a secret input, so the
    // secrets runtime materializes any ${ENV}/SecretRef before parsing. A value
    // still shaped like a ref here means resolution failed; drop it rather than
    // hand a non-string to the adapter.
    const result = parseLightRagFoundations({
      foundations: [{ id: "kb", serverUrl: "http://kb", apiKey: { $secret: "lightrag-key" } }],
    });
    expect(result).toEqual([{ id: "kb", serverUrl: "http://kb", mode: "mix" }]);
  });
});

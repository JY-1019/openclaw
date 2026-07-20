// Parses the `plugins.entries.lightrag.config` block into typed foundation
// descriptors. Validation of shape happens against the manifest configSchema;
// this normalizes/defaults and drops malformed entries defensively.
import type { KnowledgeFoundationKind } from "openclaw/plugin-sdk/enterprise-knowledge-host";
import type { LightRagQueryMode } from "./adapter.js";

const QUERY_MODES: readonly LightRagQueryMode[] = [
  "local",
  "global",
  "hybrid",
  "naive",
  "mix",
  "bypass",
];

const DEFAULT_MODE: LightRagQueryMode = "mix";

const FOUNDATION_KINDS: readonly KnowledgeFoundationKind[] = ["remote", "local"];

// Foundations configured before `kind` existed stay "remote": that is the
// read-only reading, so an upgrade never starts offering document management
// for a server the operator has not declared as theirs to administer.
const DEFAULT_KIND: KnowledgeFoundationKind = "remote";

export type LightRagFoundationDescriptor = {
  id: string;
  serverUrl: string;
  kind: KnowledgeFoundationKind;
  mode: LightRagQueryMode;
  /**
   * Resolved X-API-Key literal. The manifest declares `foundations.*.apiKey` as
   * a secret input, so the secrets runtime materializes any `${ENV}`/SecretRef
   * into a string before this config is read; an unresolved value is dropped.
   */
  apiKey?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Parse the plugin config into valid foundation descriptors (drops invalid ones). */
export function parseLightRagFoundations(pluginConfig: unknown): LightRagFoundationDescriptor[] {
  const raw = asRecord(pluginConfig).foundations;
  if (!Array.isArray(raw)) {
    return [];
  }
  const descriptors: LightRagFoundationDescriptor[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    const id = nonBlankString(record.id);
    const serverUrl = nonBlankString(record.serverUrl);
    if (!id || !serverUrl) {
      continue; // id + serverUrl are required to reach a server
    }
    const mode = QUERY_MODES.find((candidate) => candidate === record.mode) ?? DEFAULT_MODE;
    const kind = FOUNDATION_KINDS.find((candidate) => candidate === record.kind) ?? DEFAULT_KIND;
    const apiKey = nonBlankString(record.apiKey);
    descriptors.push({
      id,
      serverUrl,
      kind,
      mode,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }
  return descriptors;
}

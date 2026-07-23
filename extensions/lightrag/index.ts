// LightRAG plugin entrypoint: registers each configured LightRAG server as a
// ClawWorks enterprise knowledge foundation so `knowledge_search` can query it.
import { registerEnterpriseKnowledgeFoundation } from "openclaw/plugin-sdk/enterprise-knowledge-host";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { LightRagKnowledgeFoundation } from "./src/adapter.js";
import { parseLightRagFoundations } from "./src/config.js";

const PLUGIN_ID = "lightrag";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "LightRAG Knowledge",
  description: "Registers LightRAG servers as ClawWorks enterprise knowledge foundations.",
  register(api: OpenClawPluginApi) {
    // apiKey is already a resolved literal: the manifest declares
    // `foundations.*.apiKey` as a secret input, so the secrets runtime
    // materializes any `${ENV}`/SecretRef before this config reaches us.
    for (const descriptor of parseLightRagFoundations(api.pluginConfig)) {
      registerEnterpriseKnowledgeFoundation(
        descriptor.id,
        new LightRagKnowledgeFoundation({
          foundationId: descriptor.id,
          serverUrl: descriptor.serverUrl,
          kind: descriptor.kind,
          mode: descriptor.mode,
          ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
          ...(descriptor.apiKey !== undefined ? { apiKey: descriptor.apiKey } : {}),
        }),
      );
    }
  },
});

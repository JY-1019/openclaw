/**
 * knowledge_search built-in tool.
 *
 * Searches the enterprise knowledge foundations in scope for the current
 * workflow step. Retrieval is scoped by the active node's ontology allow-list
 * and gated by config governance policies (see resolveEnterpriseKnowledge); the
 * tool is only assembled when enterprise mode is on and a foundation is
 * registered, so stock runs keep an unchanged tool list.
 */
import { Type } from "typebox";
import { resolveEnterpriseKnowledge } from "../../enterprise/knowledge.js";
import {
  asToolParamsRecord,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  type AnyAgentTool,
} from "./common.js";

const KNOWLEDGE_SEARCH_MAX_LIMIT = 20;

const KnowledgeSearchToolSchema = Type.Object({
  query: Type.String({ description: "What to look up in the enterprise knowledge foundations." }),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: KNOWLEDGE_SEARCH_MAX_LIMIT,
      description: "Max snippets per foundation (default 5).",
    }),
  ),
});

export function createKnowledgeSearchTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Knowledge",
    name: "knowledge_search",
    description:
      "Search the enterprise knowledge foundations available to the current workflow step.",
    parameters: KnowledgeSearchToolSchema,
    execute: async (_toolCallId, params, signal) => {
      const record = asToolParamsRecord(params);
      const query = readStringParam(record, "query", { required: true });
      const limit = readPositiveIntegerParam(record, "limit", { max: KNOWLEDGE_SEARCH_MAX_LIMIT });
      const result = await resolveEnterpriseKnowledge({
        runId: opts.runId,
        query,
        ...(limit !== undefined ? { limit } : {}),
        ...(signal ? { signal } : {}),
      });
      return jsonResult({ snippets: result.snippets, skipped: result.skipped });
    },
  };
}

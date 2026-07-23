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
import {
  describeWorkflowKnowledgeFoundations,
  resolveEnterpriseKnowledge,
  type WorkflowKnowledgeFoundation,
} from "../../enterprise/knowledge.js";
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
  foundations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict the search to these foundation ids (see the step's listed knowledge sources); omit to search every foundation available to this step. An empty list searches none. Ids outside the step's allow-list are reported as skipped, never queried.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: KNOWLEDGE_SEARCH_MAX_LIMIT,
      description: "Max snippets per foundation (default 5).",
    }),
  ),
});

/**
 * Tool description with a glossary of the foundations this workflow references
 * (with a short summary each) so the model can route a `foundations` target.
 * Built once per run when the tool is assembled — after runtime plugins register
 * their foundations — so the summaries reflect the live registry and stay stable
 * for the run (prompt cache). Which foundations a given step is scoped to lives
 * in the step digest; retrieval enforces the active step's allow-list.
 */
function knowledgeSearchDescription(runId: string): string {
  const glossary = formatFoundationGlossary(describeWorkflowKnowledgeFoundations(runId));
  return `Search the enterprise knowledge foundations available to the current workflow step.${glossary} When you use a returned snippet in your answer, cite the foundation it came from and its \`source\` when the snippet carries one.`;
}

/** Render the workflow's foundations as a routing glossary, or "" when it has none. */
function formatFoundationGlossary(foundations: readonly WorkflowKnowledgeFoundation[]): string {
  if (foundations.length === 0) {
    return "";
  }
  const entries = foundations.map((foundation) =>
    foundation.description
      ? `${foundation.foundationId} (${foundation.description})`
      : foundation.foundationId,
  );
  return ` Knowledge foundations used by this workflow: ${entries.join("; ")}. Target specific ones with the \`foundations\` argument; each step lists which are in scope.`;
}

export function createKnowledgeSearchTool(opts: { runId: string }): AnyAgentTool {
  return {
    label: "Knowledge",
    name: "knowledge_search",
    description: knowledgeSearchDescription(opts.runId),
    parameters: KnowledgeSearchToolSchema,
    execute: async (_toolCallId, params, signal) => {
      const record = asToolParamsRecord(params);
      const query = readStringParam(record, "query", { required: true });
      // Preserve an explicit (even empty) selection as-is: collapsing an empty
      // array to "omitted" would silently widen the search back to every source.
      // readStringArrayParam does exactly that collapse, so read the raw field.
      const foundationsRaw = record.foundations;
      const foundations = Array.isArray(foundationsRaw)
        ? foundationsRaw
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : undefined;
      const limit = readPositiveIntegerParam(record, "limit", { max: KNOWLEDGE_SEARCH_MAX_LIMIT });
      const result = await resolveEnterpriseKnowledge({
        runId: opts.runId,
        query,
        ...(foundations ? { foundations } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(signal ? { signal } : {}),
      });
      return jsonResult({ snippets: result.snippets, skipped: result.skipped });
    },
  };
}

/**
 * Zod schemas and validation for ClawWorks enterprise definitions.
 * Import/export artifacts (workflow trees) validate against the versioned
 * envelope here; config-declared governance policies share the same shapes.
 */
import { z } from "zod";
import {
  WORKFLOW_TREE_SCHEMA,
  WORKFLOW_TREE_SCHEMA_VERSION,
  type WorkflowTreeDefinition,
} from "./types.js";

/** Dotted stable id: lowercase segments separated by dots (taxonomy style). */
const ENTERPRISE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;

// Blank entries are rejected everywhere a value feeds the tool-policy glob
// matcher or keyword scoring: the matcher normalizes whitespace away, so a
// blank selector would silently widen a scoped policy into match-everything.
const NonBlankStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");

export const EnterpriseIdSchema = z
  .string()
  .regex(
    ENTERPRISE_ID_PATTERN,
    'must be a dotted lowercase id (e.g. "assist.respond"): segments of [a-z0-9-] separated by dots',
  );

const OntologyEntitySchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().optional(),
  })
  .strict();

const OntologyRelationshipSchema = z
  .object({
    id: EnterpriseIdSchema,
    from: EnterpriseIdSchema,
    to: EnterpriseIdSchema,
    description: z.string().optional(),
  })
  .strict();

const OntologyActionSchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().optional(),
    // Omit `tools` to mean "this action covers every tool". An empty array is
    // accepted for load compatibility (it never widens: the governance
    // matcher treats an empty action tool list as covering no tool). Blank
    // entries are still rejected.
    tools: z.array(NonBlankStringSchema).optional(),
  })
  .strict();

const OntologyConstraintSchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().min(1),
  })
  .strict();

export const OntologyBindingSchema = z
  .object({
    entities: z.array(OntologyEntitySchema).optional(),
    relationships: z.array(OntologyRelationshipSchema).optional(),
    actions: z.array(OntologyActionSchema).optional(),
    constraints: z.array(OntologyConstraintSchema).optional(),
    allowedTools: z.array(NonBlankStringSchema).optional(),
    deniedTools: z.array(NonBlankStringSchema).optional(),
    knowledgeFoundations: z.array(EnterpriseIdSchema).optional(),
    contextHints: z.array(NonBlankStringSchema).optional(),
    expectedOutput: z.string().optional(),
    audit: z.boolean().optional(),
  })
  .strict();

type WorkflowNodeShape = {
  id: string;
  title: string;
  description?: string;
  ontology?: z.infer<typeof OntologyBindingSchema>;
  children?: WorkflowNodeShape[];
};

const WorkflowNodeDefinitionSchema: z.ZodType<WorkflowNodeShape> = z.lazy(() =>
  z
    .object({
      id: EnterpriseIdSchema,
      title: z.string().min(1),
      description: z.string().optional(),
      ontology: OntologyBindingSchema.optional(),
      children: z.array(WorkflowNodeDefinitionSchema).optional(),
    })
    .strict(),
);

export const WorkflowTreeTriggerSchema = z.enum(["user", "system", "subagent"]);

const WorkflowTreeMatchSchema = z
  .object({
    // Blank keywords would substring-match every request and hijack selection.
    keywords: z.array(NonBlankStringSchema).min(1).optional(),
    // Empty trigger lists are rejected: omitted means user-triggered, and an
    // empty array would make the tree unselectable for every trigger.
    triggers: z.array(WorkflowTreeTriggerSchema).min(1).optional(),
    priority: z.number().int().optional(),
  })
  .strict();

export const WorkflowTreeDefinitionSchema = z
  .object({
    schema: z.literal(WORKFLOW_TREE_SCHEMA),
    schemaVersion: z.literal(WORKFLOW_TREE_SCHEMA_VERSION),
    id: EnterpriseIdSchema,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    match: WorkflowTreeMatchSchema.optional(),
    root: WorkflowNodeDefinitionSchema,
  })
  .strict()
  .superRefine((tree, ctx) => {
    // Duplicate node ids silently corrupt plan node attribution and per-node
    // trace grouping, so they are a validation error rather than last-wins.
    const seen = new Set<string>();
    const visit = (node: WorkflowNodeShape, path: (string | number)[]) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: `duplicate workflow node id "${node.id}"`,
        });
      }
      seen.add(node.id);
      node.children?.forEach((child, index) => {
        visit(child, [...path, "children", index]);
      });
    };
    visit(tree.root, ["root"]);
  });

export const GovernanceEffectSchema = z.enum(["allow", "deny", "audit", "require_approval"]);

// Empty selector arrays are rejected rather than treated as omitted: the
// evaluator reads missing subject selectors as "run-level policy", so an
// empty array would silently flip a scoped policy into a run-wide one.
const GovernanceSelectorSchema = z
  .array(NonBlankStringSchema)
  .min(1, "omit the selector instead of passing an empty array")
  .optional();

const GovernanceApprovalSettingsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    timeoutBehavior: z.enum(["allow", "deny"]).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  })
  .strict()
  .optional();

export const GovernancePolicySchema = z
  .object({
    id: EnterpriseIdSchema,
    description: z.string().optional(),
    effect: GovernanceEffectSchema,
    trees: GovernanceSelectorSchema,
    nodes: GovernanceSelectorSchema,
    tools: GovernanceSelectorSchema,
    actions: GovernanceSelectorSchema,
    knowledge: GovernanceSelectorSchema,
    approval: GovernanceApprovalSettingsSchema,
  })
  .strict();

export type WorkflowTreeValidationIssue = {
  /** Dot-path to the invalid value (config-issue style). */
  path: string;
  message: string;
};

export type WorkflowTreeValidationResult =
  | { ok: true; tree: WorkflowTreeDefinition }
  | { ok: false; issues: WorkflowTreeValidationIssue[] };

/** Validate an untrusted workflow tree definition (import path, tests, config). */
export function validateWorkflowTreeDefinition(value: unknown): WorkflowTreeValidationResult {
  const parsed = WorkflowTreeDefinitionSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, tree: parsed.data as WorkflowTreeDefinition };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  };
}

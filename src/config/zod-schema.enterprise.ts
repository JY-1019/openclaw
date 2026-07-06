// Defines ClawWorks enterprise-mode Zod schema fragments.
import { z } from "zod";
import { GovernancePolicySchema } from "../enterprise/schema.js";

// Approval prompts are tool-call scoped: a run-level require_approval policy
// would have no interactive channel at run start and mediation treats it as
// a deny, so the schema rejects it up front with a clear message.
const GovernancePolicyWithApprovalScopeSchema = GovernancePolicySchema.superRefine(
  (policy, ctx) => {
    if (policy.effect === "require_approval" && !policy.tools?.length && !policy.actions?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["effect"],
        message:
          "require_approval policies need a tools or actions selector; run-level approvals are not supported",
      });
    }
    if (policy.effect !== "require_approval" && policy.approval) {
      ctx.addIssue({
        code: "custom",
        path: ["approval"],
        message: 'approval settings only apply when effect is "require_approval"',
      });
    }
    if (policy.knowledge?.length && (policy.tools?.length || policy.actions?.length)) {
      ctx.addIssue({
        code: "custom",
        path: ["knowledge"],
        message:
          "a policy targets either tool calls (tools/actions) or knowledge retrieval (knowledge), not both; split them into separate policies",
      });
    }
  },
);

/**
 * Enterprise execution mode:
 * - "enforce": every run binds to a workflow tree; governance denials block.
 * - "observe": runs bind and trace, but denials are recorded, not enforced.
 * - "off": stock OpenClaw behavior with no enterprise mediation.
 */
export const EnterpriseModeSchema = z.enum(["enforce", "observe", "off"]);

const EnterpriseGovernanceSchema = z
  .object({
    policies: z.array(GovernancePolicyWithApprovalScopeSchema).optional(),
  })
  .strict()
  .optional();

export const EnterpriseConfigSchema = z
  .object({
    mode: EnterpriseModeSchema.optional(),
    governance: EnterpriseGovernanceSchema,
  })
  .strict()
  .optional();

export type EnterpriseConfig = z.infer<typeof EnterpriseConfigSchema>;

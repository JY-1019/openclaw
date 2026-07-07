---
summary: "ClawWorks enterprise mode: ontology-driven workflow trees, governance policies, knowledge foundations, and run tracing"
read_when:
  - You want to constrain agent runs with workflow trees and governance policies
  - You are configuring enterprise mode, ontology bindings, or knowledge foundations
  - You are inspecting governed run traces from the CLI, gateway, or Control UI
title: "ClawWorks Enterprise"
---

# ClawWorks Enterprise

ClawWorks adds an ontology-driven execution layer on top of the standard agent
loop. When enterprise mode is active, every agent run is bound to a **workflow
tree** whose nodes carry **ontology bindings** (allowed tools, knowledge
foundations, context hints) and are gated by **governance policies**. Run
lifecycle and governance decisions (denials, approvals, and audited steps) are
written to a SQLite trace you can inspect from the CLI, the gateway, or the
Control UI. Default-allow tool calls are not traced unless a node opts in with
`audit: true`, so stock runs stay quiet.

Enterprise mode is on by default and stays backward compatible: built-in trees
are guidance-free, so a stock install behaves like ordinary OpenClaw until you
import trees or declare policies.

## Modes

Set the mode in the `enterprise` config section:

```jsonc
{
  "enterprise": {
    "mode": "enforce", // enforce | observe | off
  },
}
```

- **enforce** (default): governance denials block tool calls and knowledge
  retrieval, and unreadable trees fail closed.
- **observe**: decisions are recorded but never block; unreadable trees fall
  back to built-ins with a warning.
- **off**: no mediation. Runs behave like ordinary OpenClaw.

`openclaw doctor` migrates older config shapes; the runtime only reads the
current shape.

## Workflow trees

A workflow tree is a versioned, importable definition. Each node is a step; leaf
nodes are the executable steps a run advances through.

```yaml
schema: clawworks.workflow-tree
schemaVersion: 1
id: acme.support
version: 1.0.0
name: Customer support
description: Triage and resolve customer requests.
match:
  keywords: [refund, order, support]
  triggers: [user]
  priority: 10
root:
  id: support
  title: Support
  ontology:
    contextHints:
      - Be concise and cite the order id in every reply.
  children:
    - id: support.triage
      title: Triage the request
      ontology:
        allowedTools: [memory_search, knowledge_search]
        knowledgeFoundations: [acme.support-kb]
        audit: true
    - id: support.resolve
      title: Resolve or escalate
      ontology:
        allowedTools: [memory_search, message]
        deniedTools: [exec, process]
        expectedOutput: A resolution summary or an escalation note.
```

Manage trees with the CLI (see [`openclaw enterprise`](/cli/enterprise)):

```bash
openclaw enterprise trees validate acme-support.yaml
openclaw enterprise trees import acme-support.yaml
openclaw enterprise trees list --json
```

Imported trees override built-in trees with the same id; removing the import
restores the built-in. A running gateway loads trees at startup, so restart it
after imports or removals.

### Ontology bindings

Each node carries executable metadata in its `ontology`:

- `allowedTools` / `deniedTools`: tool name globs. Empty or omitted allows all;
  deny wins over allow. Each node on the root-to-active path is an independent
  gate, so a leaf inherits every ancestor's scope.
- `knowledgeFoundations`: knowledge foundation ids the step may query. Empty or
  omitted allows every configured foundation.
- `contextHints` / `expectedOutput`: compact lines surfaced to the model in the
  step digest so it knows the rules up front.
- `audit`: record a trace event for every tool decision under this node, even
  default allows.

## How a run is mediated

When a request starts an enterprise-mediated run:

1. **Selection** matches the request to a tree by keywords, trigger, and
   priority (or the default tree).
2. **Decomposition** flattens the chosen subtree into a depth-first plan. For
   embedded and CLI runs the whole subtree's guidance is injected once as a
   static step digest so the model sees every step's rules up front (this keeps
   the prompt cache stable). ACP runs own their prompt channel and do not
   receive the digest, so `contextHints` and `expectedOutput` are not
   model-visible there.
3. **Step advancement** moves the active node leaf by leaf as real turns
   execute, so governance always scopes the current step.
4. **The tool-call gate** evaluates each tool call against the active node's
   ontology merged down the root-to-active path, then against config governance
   policies.

Only the embedded agent runtime advances steps; CLI and ACP runs stay on the
root scope as a safe backstop.

## Governance policies

Declare policies under `enterprise.governance.policies`. A policy applies only
when all of its present selectors match.

```jsonc
{
  "enterprise": {
    "governance": {
      "policies": [
        {
          "id": "no-runtime-in-support",
          "effect": "deny",
          "trees": ["acme.support"],
          "tools": ["exec", "process", "browser"],
        },
        {
          "id": "review-escalations",
          "effect": "require_approval",
          "nodes": ["support.resolve"],
          "tools": ["message"],
          "approval": { "timeoutMs": 30000, "timeoutBehavior": "deny" },
        },
      ],
    },
  },
}
```

- **Effects and precedence**: `deny` > `require_approval` > `allow` > `audit`.
  Composition is order independent.
- **Selectors**: `trees` and `nodes` scope where a policy applies; `tools` and
  `actions` scope tool calls; `knowledge` scopes knowledge retrieval. A policy
  targets one scope family. Mixing a tool selector with a knowledge selector in
  one policy is rejected.
- **require_approval** applies to tool and action scopes only. It routes
  through the standard tool-approval flow with the policy's `approval` timeout
  and fail-closed default. Knowledge-scoped policies support `deny` and `audit`
  only, because knowledge retrieval has no interactive approval channel.

## Knowledge foundations

Knowledge foundations are retrieval sources the `knowledge_search` tool can
query, scoped by the active step's `knowledgeFoundations` allow-list and gated
by `knowledge` policies. The tool is only offered when at least one foundation
is registered.

Foundations are registered by adapter plugins. The bundled
[LightRAG plugin](/plugins/reference/lightrag) exposes one or more LightRAG API
servers:

```jsonc
{
  "plugins": {
    "entries": {
      "lightrag": {
        "enabled": true,
        "config": {
          "foundations": [
            {
              "id": "acme.support-kb",
              "serverUrl": "http://localhost:9621",
              "apiKey": "${LIGHTRAG_API_KEY}",
              "mode": "mix",
            },
          ],
        },
      },
    },
  },
}
```

A node references the foundation by id in `knowledgeFoundations`. One
foundation failing (for example a down server) skips that foundation rather
than failing the whole retrieval.

## Inspecting runs

Every mediated execution writes a trace: the selected tree, plan nodes, and an
event log of run lifecycle plus governance decisions.

- **CLI**: `openclaw enterprise runs list` and `openclaw enterprise runs show
<runId>` (see [`openclaw enterprise`](/cli/enterprise)).
- **Gateway**: operator clients call the read-only methods
  `enterprise.trees.list`, `enterprise.runs.list`, and `enterprise.runs.get`
  (keyed by execution id, since one run id can span retries).
- **Control UI**: the **Enterprise** tab lists recent runs and shows a
  per-execution inspector with the plan steps, their ontology scope, and the
  governance trace, alongside the workflow-tree registry.

## Related

- [`openclaw enterprise` CLI](/cli/enterprise)
- [LightRAG knowledge plugin](/plugins/reference/lightrag)
- [Agent loop](/concepts/agent-loop)

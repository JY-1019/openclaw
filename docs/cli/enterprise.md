---
summary: "CLI reference for `openclaw enterprise` (workflow trees and run traces)"
read_when:
  - You want to import, export, or validate ClawWorks workflow trees
  - You are inspecting enterprise run traces and governance decisions
title: "Enterprise"
---

# `openclaw enterprise`

Manage ClawWorks enterprise workflow trees and inspect enterprise run traces.

In enterprise mode (on by default) every agent run binds to a workflow tree
whose nodes carry ontology bindings and governance policies. Trees are
versioned, importable, and exportable so organizations can share them.

## Workflow trees

```bash
openclaw enterprise trees list [--json]
openclaw enterprise trees validate <file>
openclaw enterprise trees import <file>
openclaw enterprise trees export <treeId> [--out <file>] [--format yaml|json]
openclaw enterprise trees remove <treeId>
```

- Definition files use YAML or JSON with the versioned
  `schema: clawworks.workflow-tree` envelope. `validate` prints path-scoped
  issues without importing.
- Imported trees override built-in trees with the same id; removing the
  import restores the built-in definition.
- A running gateway loads tree definitions at startup; restart it after
  imports or removals.

## Run traces

```bash
openclaw enterprise runs list [--limit <n>] [--json]
openclaw enterprise runs show <runId> [--json]
```

`runs show` prints the latest execution for a runId: the selected tree,
plan nodes, and the trace event log (run lifecycle plus governance
decisions per workflow node).

Enterprise mode is configured through the `enterprise` config section
(`mode: enforce | observe | off`, plus `governance.policies`). See
[ClawWorks Enterprise](/concepts/clawworks-enterprise) for the full model:
workflow trees, ontology bindings, governance policies, and knowledge
foundations.

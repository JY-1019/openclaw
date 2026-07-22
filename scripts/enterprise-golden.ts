/**
 * Golden checks for the enterprise execution layer.
 *
 * WHY THIS EXISTS. The prose test cases ask a human to type a request naming an
 * order or a claim and then eyeball the reply. That cannot separate "the layer
 * works" from "the model happened to answer well", and the shipped examples seed
 * no instances, so the ids in those prompts referred to nothing.
 *
 * So this runs the REAL mediation path — the same `beginEnterpriseRun` and tool
 * gate production uses — against a fixture that ships seeded data
 * (`examples/enterprise/golden-orders.clawworks.yaml`), with the planner INJECTED
 * rather than called. No model, no network, no reliance on the machine having
 * planner credentials, and the same answer every run.
 *
 * It is hermetic: `OPENCLAW_STATE_DIR` points at a fresh temp dir, so it never
 * reads or writes the operator's real state database.
 *
 * Usage:
 *   node --import tsx scripts/enterprise-golden.ts          # run the checks
 *   node --import tsx scripts/enterprise-golden.ts --verbose
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Must be set BEFORE the state database module is imported: it resolves the
// store path once, so a later assignment would still hit the real install.
const stateDir = mkdtempSync(path.join(tmpdir(), "clawworks-golden-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const verbose = process.argv.includes("--verbose");

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (verbose) {
    console.log(`${ok ? "pass" : "FAIL"}  ${name}\n      ${detail}`);
  }
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  record(name, a === e, a === e ? a : `expected ${e}, got ${a}`);
}

function printSummary(): void {
  const failed = checks.filter((check) => !check.ok);
  const width = Math.max(...checks.map((check) => check.name.length));
  console.log("");
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
}

const FIXTURE = path.resolve("examples/enterprise/golden-orders.clawworks.yaml");
const TREE_ID = "golden.orders";

async function main(): Promise<number> {
  const { importWorkflowTreeContent } = await import("../src/enterprise/tree-io.js");
  const { invalidateWorkflowTreeRegistry, listWorkflowTreeRegistryEntries } =
    await import("../src/enterprise/tree-registry.js");
  const { beginEnterpriseRun, endEnterpriseRun } =
    await import("../src/enterprise/run-mediation.js");
  const { evaluateEnterpriseToolCall, setEnterpriseStepForTurn, recordEnterpriseTurnExecuted } =
    await import("../src/enterprise/runtime.js");
  const { searchOntologyObjects } = await import("../src/enterprise/object-store.sqlite.js");
  const {
    createComputeFunctionTool,
    createGetNeighborsTool,
    createInvokeActionTool,
    createSearchObjectsTool,
  } = await import("../src/agents/tools/ontology-tools.js");

  // ---- 1. The fixture imports, and its seeded instances land in the store.
  const imported = importWorkflowTreeContent({
    content: readFileSync(FIXTURE, "utf8"),
    format: "yaml",
  });
  record(
    "fixture imports cleanly",
    imported.ok,
    imported.ok ? TREE_ID : JSON.stringify(imported.issues),
  );
  if (!imported.ok) {
    // Print what was captured before bailing: a silent non-zero exit gives CI
    // nothing to act on.
    printSummary();
    return 1;
  }
  invalidateWorkflowTreeRegistry();

  // ---- The seeded data is reachable THROUGH THE PRODUCTION TOOLS. Calling the
  // store and the expression evaluator directly would stay green even if the
  // tools' active-step scoping, argument adapters, or result mapping broke.
  {
    const runId = "golden-reads";
    await beginEnterpriseRun({
      runId,
      prompt: "ORD-5002 조사",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        // investigate is the step that declares all three read tools.
        routes: ["golden.investigate"],
        rationale: "reads",
      }),
    });
    setEnterpriseStepForTurn(runId);

    const search = await createSearchObjectsTool({ runId }).execute("g1", {
      entity: "order",
      limit: 50,
    });
    const searchText = JSON.stringify(search);
    record(
      "search_objects returns the seeded orders",
      ["ORD-5001", "ORD-5002", "ORD-5003"].every((id) => searchText.includes(id)),
      searchText.slice(0, 110),
    );

    const neighbors = await createGetNeighborsTool({ runId }).execute("g2", {
      entity: "ticket",
      objectId: "TKT-77",
    });
    const neighborText = JSON.stringify(neighbors);
    record(
      "get_neighbors traverses a seeded link to its order",
      neighborText.includes("ORD-5002") && neighborText.includes("concerns"),
      neighborText.slice(0, 110),
    );

    const computed = await createComputeFunctionTool({ runId }).execute("g3", {
      function: "auto-refundable-amount",
      objectId: "ORD-5002",
    });
    // Compare the payload's number, not the rendered text: a regression to 1200
    // or 2000 would still contain "200" as a substring.
    const computedValue = (computed as { details?: { value?: unknown } }).details?.value;
    expectEqual(
      "compute_function caps the refundable amount at the limit",
      // ORD-5002 totals 310 and the expression is min($total, 200).
      computedValue,
      200,
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 2. No planner: the DEFAULT tree governs, not this work-map.
  // A request nothing can judge must not inherit a work-map's tool scope.
  {
    const runId = "golden-unplanned";
    const mediation = await beginEnterpriseRun({ runId, prompt: "주문 ORD-5002 환불해줘" });
    expectEqual(
      "no planner -> default tree governs",
      mediation.kind === "mediated"
        ? { tree: mediation.plan.treeId, matchedBy: mediation.plan.matchedBy }
        : { kind: mediation.kind },
      { tree: "clawworks.assist", matchedBy: "unavailable" },
    );
    // ...and its scope is permissive, so an unrelated request is not restricted.
    const verdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
    expectEqual("no planner -> tools stay open", verdict?.blocked ?? false, false);
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 3. Planner picks the work-map and a route: only that branch is planned.
  {
    const runId = "golden-routed";
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "TKT-77 티켓 확인하고 ORD-5002 환불 처리해줘",
      routePlanner: async () => ({
        kind: "decided",
        treeId: TREE_ID,
        routes: ["golden.triage", "golden.resolve"],
        rationale: "golden",
      }),
    });
    const planned =
      mediation.kind === "mediated" ? mediation.plan.nodes.map((node) => node.nodeId) : [];
    expectEqual("planner route narrows to the chosen branches", planned.toSorted(), [
      "golden",
      "golden.resolve",
      "golden.triage",
    ]);
    expectEqual(
      "matchedBy records the model chose",
      mediation.kind === "mediated" ? mediation.plan.matchedBy : null,
      "planner",
    );

    // The digest the model sees must match what the gate enforces. It renders
    // step TITLES, so an unrouted step leaking in would tell the model to do work
    // its tools are about to refuse.
    const digest = mediation.kind === "mediated" ? mediation.promptSection : "";
    const routedInDigest =
      digest.includes("Triage the request") && digest.includes("Resolve or refund");
    const unroutedLeaked = digest.includes("Hand off to a human");
    record(
      "digest carries exactly the routed steps",
      routedInDigest && !unroutedLeaked,
      unroutedLeaked
        ? "an unrouted step leaked into the digest"
        : routedInDigest
          ? `${digest.length} chars, escalate omitted`
          : "a routed step is missing from the digest",
    );
    // The seeded types have to reach the model too, or it cannot name a real id.
    const declaresOrder = digest.includes("order (id*");
    const declaresTicket = digest.includes("ticket (id*");
    record(
      "digest declares the seeded object types",
      declaresOrder && declaresTicket,
      // Name both halves: a detail that says "order + ticket declared" next to a
      // FAIL hides which one actually went missing.
      `order=${declaresOrder} ticket=${declaresTicket}`,
    );

    // ---- 4. The tool gate follows the ACTIVE step, inheriting the root denial.
    setEnterpriseStepForTurn(runId); // enters the first routed leaf: golden.triage
    // "blocked" alone would stay green if inheritance regressed, because the leaf
    // excludes exec through its own allowedTools too. The reason names the step
    // that decided, so assert it is the ROOT.
    const execVerdict = evaluateEnterpriseToolCall({ runId, toolName: "exec" });
    record(
      "root denial is inherited by the step",
      Boolean(execVerdict?.blocked) && execVerdict?.decision.reason.includes('step "golden"'),
      execVerdict?.decision.reason ?? "no verdict",
    );
    expectEqual(
      "the step's own tool is allowed",
      evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
      false,
    );
    expectEqual(
      "a later step's tool is not allowed yet",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      true,
    );

    // ---- 5. Advancing the step moves the scope with it.
    recordEnterpriseTurnExecuted(runId);
    setEnterpriseStepForTurn(runId); // advances to golden.resolve
    expectEqual(
      "after advancing, the next step's tool is allowed",
      evaluateEnterpriseToolCall({ runId, toolName: "invoke_action" })?.blocked ?? false,
      false,
    );
    expectEqual(
      "after advancing, the previous step's tool is closed",
      evaluateEnterpriseToolCall({ runId, toolName: "search_objects" })?.blocked ?? false,
      true,
    );
    // ---- 5b. The declared action executes through the PRODUCTION tool and
    // writes its object. Calling the store helper directly would skip the tool's
    // own argument adapter and scope resolution, so a regression that broke the
    // wired-up tool would still leave this green.
    //
    // A `create` effect also needs the target type's primary key among the
    // action's parameters; without it every invocation fails validation, and a
    // fixture that only LOOKS executable lets the ontology path rot unnoticed.
    const invokeAction = createInvokeActionTool({ runId });
    const invoked = await invokeAction.execute("golden-call", {
      action: "issue-refund",
      args: { id: "REF-9100", "order-id": "ORD-5002", amount: 42 },
    });
    const invokedText = JSON.stringify(invoked);
    record(
      "invoke_action runs the declared action",
      !invokedText.includes('"error"'),
      invokedText.slice(0, 120),
    );
    const refunds = searchOntologyObjects({ treeId: TREE_ID, entity: "refund", limit: 50 });
    expectEqual(
      "the refund it created is readable",
      refunds.map((row) => row.objectId).toSorted(),
      ["REF-9001", "REF-9100"],
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  // ---- 6. A run-level deny blocks the run BEFORE any model contact, even
  // though that same precheck withholds the planner.
  {
    const runId = "golden-denied";
    let deniedPlannerCalls = 0;
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "ORD-5002 환불해줘",
      config: {
        enterprise: {
          governance: { policies: [{ id: "deny.golden", effect: "deny", trees: ["golden.*"] }] },
        },
      } as never,
      routePlanner: async () => {
        deniedPlannerCalls += 1;
        return { kind: "decided", treeId: TREE_ID, routes: [], rationale: "never" };
      },
    });
    expectEqual("a tree-scoped deny still blocks the run", mediation.kind, "blocked");
    // Blocking is not enough: the point of the precheck is that a denied prompt
    // never reaches a provider. A regression that planned first would still end
    // up blocked, so only the call count catches it.
    expectEqual("the denied prompt never reaches the planner", deniedPlannerCalls, 0);
  }

  // ---- 7. Built-in example trees never govern; only imports do.
  {
    const ids = listWorkflowTreeRegistryEntries().map((entry) => entry.tree.id);
    record(
      "the shipped support example stays registered for inspection",
      ids.includes("clawworks.support"),
      ids.join(", "),
    );
    // Wire a planner that WOULD take the built-in example if it were offered.
    // Without one, selection lands on the default tree regardless of whether the
    // example was wrongly admitted, so the check could not see the regression.
    const runId = "golden-builtin";
    let offered: string[] = [];
    const mediation = await beginEnterpriseRun({
      runId,
      prompt: "고객 지원 티켓 절차대로 환불 처리해줘",
      routePlanner: async ({ trees }) => {
        offered = trees.map((tree) => tree.id);
        return { kind: "decided", treeId: "clawworks.support", routes: [], rationale: "support" };
      },
    });
    expectEqual(
      "the shipped example is never offered as a candidate",
      offered.includes("clawworks.support"),
      false,
    );
    expectEqual(
      "the shipped example never binds a run",
      mediation.kind === "mediated" ? mediation.plan.treeId : null,
      // The planner named a tree that is not a candidate, so selection fails
      // closed onto the installed work-map rather than the example.
      TREE_ID,
    );
    endEnterpriseRun({ runId, status: "completed" });
  }

  printSummary();
  return checks.every((check) => check.ok) ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`golden run threw: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  const { closeOpenClawStateDatabase } = await import("../src/state/openclaw-state-db.js");
  closeOpenClawStateDatabase();
  rmSync(stateDir, { recursive: true, force: true });
}
// exitCode, not exit(): under CI or `tee` the summary may still be queued, and
// exiting immediately would drop the diagnostics while keeping the status.
process.exitCode = code;

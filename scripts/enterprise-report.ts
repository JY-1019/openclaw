/**
 * Report the enterprise layer's state on THIS install. READ-ONLY.
 *
 * This deliberately cannot change anything. An earlier version cleared the
 * enterprise tables and re-imported fixtures, but making that safe means
 * excluding a gateway that may start at any moment, and every attempt to detect
 * or exclude one missed a real case (the lock lives under a TMPDIR the managed
 * service does not share; an endpoint probe misses `--port`/`--bind` overrides).
 * Clearing state is left to the product's own commands, listed at the end.
 *
 * Usage:
 *   node --import tsx scripts/enterprise-report.ts
 *   node --import tsx scripts/enterprise-report.ts --runs 20
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { stripAnsi } from "../packages/terminal-core/src/ansi.js";
import { requireNodeSqlite } from "../src/infra/node-sqlite.js";
import { resolveOpenClawStateSqlitePath } from "../src/state/openclaw-state-db.paths.js";

/**
 * Mirrors OPENCLAW_SQLITE_BUSY_TIMEOUT_MS. Kept as a local constant on purpose:
 * importing the state-db module for it initializes the logging stack, which
 * needs a writable OpenClaw temp dir and would make even `--help` throw on the
 * broken installs this command exists to diagnose.
 */
const SQLITE_BUSY_TIMEOUT_MS = 30_000;

const USAGE = `Usage: enterprise-report [--runs <n>]

  --runs <n>   how many recent runs to list (default 10, max 500)

Read-only: this command never writes to the state database.
`;

/** Same ceiling the trace store applies to a run listing. */
const RUNS_LIMIT_MAX = 500;

const argv = process.argv.slice(2);
let earlyExit: number | null = null;
if (argv.some((arg) => arg === "--help" || arg === "-h")) {
  console.log(USAGE);
  earlyExit = 0;
}
const runsFlagIndex = argv.indexOf("--runs");
const runsLimitRaw = runsFlagIndex >= 0 ? argv[runsFlagIndex + 1] : undefined;
// The value slot only exists when --runs is actually present; without this guard
// runsFlagIndex is -1 and index 0 would be mistaken for it, letting the first
// unknown flag through.
const runsValueIndex = runsFlagIndex >= 0 ? runsFlagIndex + 1 : -1;
const unknown = argv.filter(
  (arg, index) => arg !== "--runs" && index !== runsValueIndex && arg.startsWith("-"),
);
if (earlyExit === null && unknown.length > 0) {
  console.error(`unknown argument(s): ${unknown.join(", ")}\n\n${USAGE}`);
  earlyExit = 2;
}
// Default only when the flag is ABSENT. `--runs` with a missing or malformed
// value must fail rather than quietly report a different number of runs.
let runsLimit = 10;
if (earlyExit === null && runsFlagIndex >= 0) {
  const parsed =
    runsLimitRaw !== undefined && /^\d+$/.test(runsLimitRaw) ? Number(runsLimitRaw) : Number.NaN;
  // Digits alone are not enough: a long enough run of them becomes Infinity or
  // exponential notation, which would reach SQLite's LIMIT and fail there as
  // "no such column: Infinity" instead of as an argument error here.
  // Cap it the way listEnterpriseRunRecords does. The trace table is unbounded,
  // so an accidental huge value would materialize the whole thing.
  if (!Number.isSafeInteger(parsed) || parsed > RUNS_LIMIT_MAX) {
    console.error(`--runs expects an integer between 0 and ${RUNS_LIMIT_MAX}\n\n${USAGE}`);
    earlyExit = 2;
  } else {
    runsLimit = parsed;
  }
}

const ENTERPRISE_TABLES = [
  "enterprise_workflow_trees",
  "enterprise_workflow_tree_versions",
  "enterprise_ontology_objects",
  "enterprise_ontology_links",
  "enterprise_runs",
  "enterprise_run_events",
] as const;

/**
 * Make a stored string safe to write to a terminal.
 *
 * Everything this report prints from the database is operator- or user-supplied:
 * request text, and a work-map `version` the schema accepts as any non-empty
 * string. An OSC/ANSI sequence in either would reach the terminal verbatim and
 * could rewrite the screen or the clipboard just by running the report.
 */
function terminalSafe(value: string | null | undefined): string {
  return stripAnsi(value ?? "").replaceAll(/\p{Cc}/gu, " ");
}

/** True when the database has none of the enterprise tables (a fresh install). */
function enterpriseSchemaAbsent(db: DatabaseSync): boolean {
  const present = ENTERPRISE_TABLES.filter((table) => {
    const rows = db
      .prepare("select name from sqlite_master where type = 'table' and name = ?")
      .all(table);
    return rows.length > 0;
  });
  if (present.length === 0) {
    return true;
  }
  if (present.length < ENTERPRISE_TABLES.length) {
    // Some but not all. This is either a schema the product knows how to repair
    // or a real fault, and calling a supported migration state "corruption"
    // would send an operator hunting the wrong problem.
    const missing = ENTERPRISE_TABLES.filter((table) => !present.includes(table));
    throw new Error(
      `enterprise schema is incomplete; missing table(s): ${missing.join(", ")}.\n` +
        "If this database predates the current schema, repair it first:\n" +
        "  openclaw doctor --fix",
    );
  }
  return false;
}

function main(): number {
  const dbPath = resolveOpenClawStateSqlitePath(process.env);
  console.log(`state database: ${dbPath}`);
  if (!existsSync(dbPath)) {
    console.log("  (absent — nothing has been stored yet)");
    return 0;
  }

  // Read-only handle: the canonical opener creates the file, applies schema
  // migrations, and upserts schema_meta, which a report must never do.
  // requireNodeSqlite installs the warning filter first, so a diagnostic run
  // does not open with Node's "SQLite is an experimental feature" notice.
  const db = new (requireNodeSqlite().DatabaseSync)(dbPath, { readOnly: true });
  // The gateway commits while this reads, and node:sqlite defaults to a zero
  // busy timeout, so the first query would fail outright with SQLITE_BUSY.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  // One read transaction for the whole report: separate autocommit reads could
  // each see a different database state while the gateway writes, so the counts,
  // the tree list, and the runs below would describe different moments.
  db.exec("BEGIN DEFERRED");
  try {
    if (enterpriseSchemaAbsent(db)) {
      console.log("  (no enterprise tables yet — nothing has been mediated on this install)");
      return 0;
    }
    console.log("\nrows");
    for (const table of ENTERPRISE_TABLES) {
      const rows = db.prepare(`select count(*) as n from ${table}`).all() as Array<{ n: number }>;
      console.log(`  ${table.padEnd(34)} ${rows[0]?.n ?? 0}`);
    }

    const trees = db
      .prepare("select tree_id, version from enterprise_workflow_trees order by tree_id")
      .all() as Array<{ tree_id: string; version: string }>;
    console.log(`\nimported work-maps (${trees.length})`);
    if (trees.length === 0) {
      console.log(
        "  none. While enterprise mode is on, the trigger's default built-in\n" +
          "  (clawworks.assist, or clawworks.system) is what binds; other built-ins\n" +
          '  ship as examples and never bind until imported. With mode "off" no\n' +
          "  tree binds at all — check enterprise.mode in the config.",
      );
    }
    for (const tree of trees) {
      console.log(`  ${terminalSafe(tree.tree_id)}@${terminalSafe(tree.version)}`);
    }

    if (runsLimit > 0) {
      const runs = db
        .prepare(
          `select datetime(created_at/1000,'unixepoch','localtime') as kst,
                tree_id,
                json_extract(plan_json,'$.matchedBy') as matched_by,
                substr(json_extract(plan_json,'$.treeRationale'), 1, 70) as why,
                substr(request_summary, 1, 46) as req
         from enterprise_runs order by created_at desc limit ${runsLimit}`,
        )
        .all() as Array<{
        kst: string;
        tree_id: string;
        matched_by: string | null;
        why: string | null;
        req: string;
      }>;
      console.log(`\nrecent runs (${runs.length})`);
      if (runs.length === 0) {
        console.log("  none");
      }
      for (const run of runs) {
        console.log(
          `  ${run.kst}  ${terminalSafe(run.matched_by ?? "-").padEnd(15)} ` +
            `${terminalSafe(run.tree_id).padEnd(26)} ${terminalSafe(run.req)}`,
        );
      }
      // matchedBy is the one field that explains WHY a tree bound, and it is not
      // rendered anywhere in the Control UI, so this is the only place to see it.
      // Report the reason the run PERSISTED rather than inferring one. The
      // current registry cannot tell what was imported when a past run bound, and
      // "unavailable" has several causes besides missing credentials — ACP
      // dispatch, a provider-only model choice, a before_model_resolve hook, and
      // some cron paths all skip the planner deliberately.
      const unavailable = runs.filter((run) => run.matched_by === "unavailable");
      if (unavailable.length > 0) {
        console.log(
          `\n  ${unavailable.length} run(s) could not consult a planner, so the trigger's default` +
            "\n  tree bound instead of a model-selected work-map. Recorded reasons:",
        );
        for (const reason of new Set(unavailable.map((run) => terminalSafe(run.why ?? "(none)")))) {
          console.log(`    ${reason}`);
        }
      }
    }
  } finally {
    db.exec("COMMIT");
    db.close();
  }

  console.log(
    "\nto reach a known state, use the product's own commands, in this order:\n" +
      "  openclaw backup create                           # FIRST: removing a tree\n" +
      "                                                   # also drops its objects\n" +
      "  openclaw gateway stop\n" +
      "  openclaw enterprise trees remove <treeId>        # drop an imported work-map\n" +
      "  openclaw enterprise trees import <file>          # restore one\n" +
      "  openclaw gateway restart\n" +
      "\nfor a hermetic check that needs no install state at all:\n" +
      "  pnpm enterprise:golden",
  );
  return 0;
}

// exitCode, not exit(): a piped stdout is buffered, and exiting immediately would
// discard queued rows while still reporting success.
process.exitCode = earlyExit ?? main();

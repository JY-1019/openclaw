/**
 * SQLite persistence for enterprise run traces in the shared state DB.
 * Each mediated execution gets its own execution_id row (runIds recur for
 * fallback retries and recurring cron sessions); events are an append-only
 * (execution_id, seq) log so every governance decision stays attributable to
 * its workflow node.
 */
import { existsSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { EnterpriseRunEventKind, EnterpriseRunPlan, EnterpriseRunStatus } from "./types.js";

export type EnterpriseTraceStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

type EnterpriseTraceDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_runs" | "enterprise_run_events"
>;

export type EnterpriseRunRecord = {
  executionId: string;
  runId: string;
  sessionKey: string | null;
  agentId: string | null;
  treeId: string;
  treeVersion: string;
  mode: string;
  status: EnterpriseRunStatus;
  requestSummary: string;
  plan: EnterpriseRunPlan;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
};

export type EnterpriseRunEventRecord = {
  executionId: string;
  seq: number;
  nodeId: string | null;
  kind: EnterpriseRunEventKind;
  payload: Record<string, unknown>;
  createdAt: number;
};

type EnterpriseRunRow = {
  execution_id: string;
  run_id: string;
  session_key: string | null;
  agent_id: string | null;
  tree_id: string;
  tree_version: string;
  mode: string;
  status: string;
  request_summary: string;
  plan_json: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  ended_at: number | bigint | null;
};

const RUN_STATUSES: readonly EnterpriseRunStatus[] = [
  "running",
  "completed",
  "failed",
  "blocked",
  "aborted",
  "timed_out",
];

const RUN_EVENT_KINDS: readonly EnterpriseRunEventKind[] = [
  "run.started",
  "run.ended",
  "governance.decision",
  "node.entered",
  "node.completed",
];

function requireSqliteNumber(value: number | bigint): number {
  return normalizeSqliteNumber(value) ?? 0;
}

function parseRunStatus(value: string): EnterpriseRunStatus {
  const status = RUN_STATUSES.find((candidate) => candidate === value);
  if (!status) {
    throw new Error(`unknown enterprise run status "${value}"`);
  }
  return status;
}

function parseRunEventKind(value: string): EnterpriseRunEventKind {
  const kind = RUN_EVENT_KINDS.find((candidate) => candidate === value);
  if (!kind) {
    throw new Error(`unknown enterprise run event kind "${value}"`);
  }
  return kind;
}

function rowToRunRecord(row: EnterpriseRunRow): EnterpriseRunRecord {
  return {
    executionId: row.execution_id,
    runId: row.run_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    treeId: row.tree_id,
    treeVersion: row.tree_version,
    mode: row.mode,
    status: parseRunStatus(row.status),
    requestSummary: row.request_summary,
    plan: JSON.parse(row.plan_json) as EnterpriseRunPlan,
    createdAt: requireSqliteNumber(row.created_at),
    updatedAt: requireSqliteNumber(row.updated_at),
    endedAt: row.ended_at === null ? null : requireSqliteNumber(row.ended_at),
  };
}

function stateDatabaseOptions(options: EnterpriseTraceStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

/** Insert the execution row for one mediated run start as "running". */
export function persistEnterpriseRunStart(
  params: {
    executionId: string;
    plan: EnterpriseRunPlan;
    sessionKey?: string;
    agentId?: string;
    now?: number;
  },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  const { plan } = params;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_runs").values({
        execution_id: params.executionId,
        run_id: plan.runId,
        session_key: params.sessionKey ?? null,
        agent_id: params.agentId ?? null,
        tree_id: plan.treeId,
        tree_version: plan.treeVersion,
        mode: plan.mode,
        status: "running",
        request_summary: plan.requestSummary,
        plan_json: JSON.stringify(plan),
        created_at: plan.createdAt,
        updated_at: now,
        ended_at: null,
      }),
    );
  }, stateDatabaseOptions(options));
}

/** Append one trace event. Callers own seq allocation (prepared-facts rule). */
export function appendEnterpriseRunEvent(
  event: EnterpriseRunEventRecord,
  options: EnterpriseTraceStoreOptions = {},
): void {
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_run_events").values({
        execution_id: event.executionId,
        seq: event.seq,
        node_id: event.nodeId,
        kind: event.kind,
        payload_json: JSON.stringify(event.payload),
        created_at: event.createdAt,
      }),
    );
  }, stateDatabaseOptions(options));
}

/**
 * Re-persist plan_json after an in-run mutation. Only the active node advances
 * during a run, so this keeps `enterprise runs show` and the JSON trace
 * reporting the current step instead of the run-start root snapshot.
 */
export function updateEnterpriseRunPlan(
  params: { executionId: string; plan: EnterpriseRunPlan; now?: number },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ plan_json: JSON.stringify(params.plan), updated_at: now })
        .where("execution_id", "=", params.executionId),
    );
  }, stateDatabaseOptions(options));
}

/** Mark the execution terminal with its final status. */
export function finalizeEnterpriseRun(
  params: { executionId: string; status: Exclude<EnterpriseRunStatus, "running">; now?: number },
  options: EnterpriseTraceStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("enterprise_runs")
        .set({ status: params.status, updated_at: now, ended_at: now })
        .where("execution_id", "=", params.executionId),
    );
  }, stateDatabaseOptions(options));
}

/** Read the most recent execution trace for a runId (null when absent). */
export function getEnterpriseRunRecord(
  runId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord | null {
  if (!enterpriseStateDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .orderBy("execution_id", "desc")
      .limit(1),
  ) as EnterpriseRunRow | undefined;
  return row ? rowToRunRecord(row) : null;
}

/** List every execution recorded for a runId, newest first. */
export function listEnterpriseRunExecutions(
  runId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("created_at", "desc")
      .orderBy("execution_id", "desc"),
  ).rows as EnterpriseRunRow[];
  return rows.map(rowToRunRecord);
}

/** List recent execution traces, newest first. */
export function listEnterpriseRunRecords(
  params: { limit?: number } = {},
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const limit = Math.max(1, Math.min(params.limit ?? 50, 500));
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_runs")
      .selectAll()
      .orderBy("created_at", "desc")
      .orderBy("execution_id", "desc")
      .limit(limit),
  ).rows as EnterpriseRunRow[];
  return rows.map(rowToRunRecord);
}

/** List one execution's trace events in seq order. */
export function listEnterpriseRunEvents(
  executionId: string,
  options: EnterpriseTraceStoreOptions = {},
): EnterpriseRunEventRecord[] {
  if (!enterpriseStateDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTraceDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("enterprise_run_events")
      .selectAll()
      .where("execution_id", "=", executionId)
      .orderBy("seq", "asc"),
  ).rows as Array<{
    execution_id: string;
    seq: number | bigint;
    node_id: string | null;
    kind: string;
    payload_json: string;
    created_at: number | bigint;
  }>;
  return rows.map((row) => ({
    executionId: row.execution_id,
    seq: requireSqliteNumber(row.seq),
    nodeId: row.node_id,
    kind: parseRunEventKind(row.kind),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: requireSqliteNumber(row.created_at),
  }));
}

function enterpriseStateDatabaseExists(options: EnterpriseTraceStoreOptions): boolean {
  if (options.stateDatabasePath) {
    return existsSync(options.stateDatabasePath);
  }
  return existsSync(resolveOpenClawStateSqlitePath(options.env ?? process.env));
}

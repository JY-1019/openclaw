/**
 * SQLite persistence for imported enterprise workflow trees in the shared
 * state DB. The canonical runtime source is this table plus the built-in
 * trees; import/export files are exchange artifacts, never runtime state.
 */
import { statSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  type OpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  collectOntologySeed,
  deleteOntologyObjectsForTree,
  replaceSeededOntologyObjects,
} from "./object-store.sqlite.js";
import { validateWorkflowTreeDefinition } from "./schema.js";
import type { WorkflowTreeDefinition } from "./types.js";

export type EnterpriseTreeStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

/** Serialization format the tree was imported from. */
export type WorkflowTreeSourceFormat = "yaml" | "json";

export type ImportedWorkflowTreeRecord = {
  tree: WorkflowTreeDefinition;
  sourceFormat: WorkflowTreeSourceFormat;
  importedAt: number;
  updatedAt: number;
};

type EnterpriseTreeDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_workflow_trees" | "enterprise_workflow_tree_versions"
>;

type EnterpriseTreeRow = {
  tree_id: string;
  version: string;
  name: string;
  definition_json: string;
  source_format: string;
  imported_at: number | bigint;
  updated_at: number | bigint;
};

type EnterpriseTreeVersionRow = {
  tree_id: string;
  revision: number | bigint;
  version: string;
  name: string;
  definition_json: string;
  source_format: string;
  saved_at: number | bigint;
};

/** One recorded revision of a tree definition (newest first in listings). */
export type WorkflowTreeVersionRecord = {
  treeId: string;
  revision: number;
  version: string;
  name: string;
  sourceFormat: WorkflowTreeSourceFormat;
  savedAt: number;
};

/** A restored historical revision: the parsed definition plus its metadata. */
export type WorkflowTreeVersionDetail = {
  tree: WorkflowTreeDefinition;
  sourceFormat: WorkflowTreeSourceFormat;
  revision: number;
  savedAt: number;
};

function parseSourceFormat(value: string): WorkflowTreeSourceFormat {
  if (value === "yaml" || value === "json") {
    return value;
  }
  throw new Error(`unknown workflow tree source format "${value}"`);
}

function rowToRecord(row: EnterpriseTreeRow): ImportedWorkflowTreeRecord {
  const parsed = JSON.parse(row.definition_json) as unknown;
  const validated = validateWorkflowTreeDefinition(parsed);
  if (!validated.ok) {
    // Persisted definitions were validated at import; a failure here means the
    // row was tampered with or written by a newer incompatible schema.
    const first = validated.issues[0];
    throw new Error(
      `stored workflow tree "${row.tree_id}" no longer validates (${first.path}: ${first.message}); re-import it`,
    );
  }
  if (validated.tree.id !== row.tree_id) {
    // The row key is the removal/override handle; a mismatched definition id
    // would register under an id that remove/list cannot address.
    throw new Error(
      `stored workflow tree "${row.tree_id}" contains a definition with mismatched id "${validated.tree.id}"; re-import it`,
    );
  }
  return {
    tree: validated.tree,
    sourceFormat: parseSourceFormat(row.source_format),
    importedAt: normalizeSqliteNumber(row.imported_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

/**
 * Non-throwing form of the `rowToRecord` invariant: a row is restorable only if
 * its JSON parses, validates, and its definition id matches the row key. Used to
 * decide whether a pre-history row is worth backfilling — a corrupt/mismatched
 * one must not enter history, or `history.get` would throw or load the wrong tree.
 */
function isRestorableTreeRow(row: EnterpriseTreeRow): boolean {
  // A corrupt source_format would map fine here but throw later in
  // listEnterpriseWorkflowTreeVersions via parseSourceFormat, breaking history.
  if (row.source_format !== "yaml" && row.source_format !== "json") {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.definition_json);
  } catch {
    return false;
  }
  const validated = validateWorkflowTreeDefinition(parsed);
  return validated.ok && validated.tree.id === row.tree_id;
}

function stateDatabaseOptions(options: EnterpriseTreeStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

/**
 * Distinguish an absent store (healthy: nothing imported yet) from an
 * inaccessible one. A stat failure other than ENOENT throws so registry
 * consumers surface a storeError and enforce mode fails closed instead of
 * treating hidden imports as an empty store.
 */
function treeStoreDatabaseExists(options: EnterpriseTreeStoreOptions): boolean {
  const pathname =
    options.stateDatabasePath ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  try {
    statSync(pathname);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(
      `cannot access enterprise tree store at ${pathname}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Snapshot the current live row into history when it is a restorable definition
 * not already captured as the latest revision — a pre-history upgrade row, or a
 * live row written outside the versioned path. Returns the resulting max
 * revision so callers can number the next snapshot. Runs inside a write txn so
 * both `upsert` (before overwrite) and `delete` (before removal) preserve the
 * definition, honoring the append-only/restorable history contract.
 */
function snapshotCurrentTreeRow(
  database: OpenClawStateDatabase,
  treeId: string,
  fallbackNow: number,
): number {
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const existingRow = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().where("tree_id", "=", treeId),
  ) as EnterpriseTreeRow | undefined;
  const latest = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_workflow_tree_versions")
      .select(["revision", "definition_json"])
      .where("tree_id", "=", treeId)
      .orderBy("revision", "desc")
      .limit(1),
  ) as { revision: number | bigint; definition_json: string } | undefined;
  const maxRevision = latest ? (normalizeSqliteNumber(latest.revision) ?? 0) : 0;
  // Skip a corrupt/mismatched row (unrestorable) and a state already captured by
  // the last save, so history gains no broken or duplicate revisions.
  if (!existingRow || !isRestorableTreeRow(existingRow)) {
    return maxRevision;
  }
  if (latest && latest.definition_json === existingRow.definition_json) {
    return maxRevision;
  }
  const nextRevision = maxRevision + 1;
  executeSqliteQuerySync(
    database.db,
    stateDb.insertInto("enterprise_workflow_tree_versions").values({
      tree_id: existingRow.tree_id,
      revision: nextRevision,
      version: existingRow.version,
      name: existingRow.name,
      definition_json: existingRow.definition_json,
      source_format: existingRow.source_format,
      saved_at: normalizeSqliteNumber(existingRow.updated_at) ?? fallbackNow,
    }),
  );
  return nextRevision;
}

/** Insert or replace one imported workflow tree definition. */
export function upsertEnterpriseWorkflowTree(
  params: {
    tree: WorkflowTreeDefinition;
    sourceFormat: WorkflowTreeSourceFormat;
    now?: number;
  },
  options: EnterpriseTreeStoreOptions = {},
): void {
  const now = params.now ?? Date.now();
  const definitionJson = JSON.stringify(params.tree);
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    // Preserve the definition being overwritten (upgrade/divergence) first.
    const priorRevision = snapshotCurrentTreeRow(database, params.tree.id, now);

    executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("enterprise_workflow_trees")
        .values({
          tree_id: params.tree.id,
          version: params.tree.version,
          name: params.tree.name,
          definition_json: definitionJson,
          source_format: params.sourceFormat,
          imported_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("tree_id").doUpdateSet({
            version: params.tree.version,
            name: params.tree.name,
            definition_json: definitionJson,
            source_format: params.sourceFormat,
            updated_at: now,
          }),
        ),
    );
    // Record this save as the next revision in the append-only history, in the
    // same transaction so the current row and its snapshot never diverge.
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("enterprise_workflow_tree_versions").values({
        tree_id: params.tree.id,
        revision: priorRevision + 1,
        version: params.tree.version,
        name: params.tree.name,
        definition_json: definitionJson,
        source_format: params.sourceFormat,
        saved_at: now,
      }),
    );
    // Materialize the objects the tree declares in the SAME transaction: the
    // definition and its instances must never be half-applied, or a run would
    // plan against a tree whose objects do not exist yet.
    replaceSeededOntologyObjects(database, {
      treeId: params.tree.id,
      seed: collectOntologySeed(params.tree),
      now,
    });
  }, stateDatabaseOptions(options));
}

/**
 * List recorded revisions of a tree, newest first (metadata only). `limit`
 * bounds the rows returned — history is append-only and grows per save, so
 * callers (the Gateway read) must cap it to avoid unbounded work/payloads.
 */
export function listEnterpriseWorkflowTreeVersions(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
  limit?: number,
): WorkflowTreeVersionRecord[] {
  if (!treeStoreDatabaseExists(options)) {
    return [];
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const baseQuery = stateDb
    .selectFrom("enterprise_workflow_tree_versions")
    .select(["tree_id", "revision", "version", "name", "source_format", "saved_at"])
    .where("tree_id", "=", treeId)
    .orderBy("revision", "desc");
  const rows = executeSqliteQuerySync(
    database.db,
    limit === undefined ? baseQuery : baseQuery.limit(limit),
  ).rows as EnterpriseTreeVersionRow[];
  return rows.map((row) => ({
    treeId: row.tree_id,
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    version: row.version,
    name: row.name,
    sourceFormat: parseSourceFormat(row.source_format),
    savedAt: normalizeSqliteNumber(row.saved_at) ?? 0,
  }));
}

/** Read one recorded revision's full definition (null when absent). */
export function getEnterpriseWorkflowTreeVersion(
  treeId: string,
  revision: number,
  options: EnterpriseTreeStoreOptions = {},
): WorkflowTreeVersionDetail | null {
  if (!treeStoreDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_workflow_tree_versions")
      .selectAll()
      .where("tree_id", "=", treeId)
      .where("revision", "=", revision),
  ) as EnterpriseTreeVersionRow | undefined;
  if (!row) {
    return null;
  }
  const parsed = JSON.parse(row.definition_json) as unknown;
  const validated = validateWorkflowTreeDefinition(parsed);
  if (!validated.ok) {
    // History snapshots were validated at save; a failure means a newer,
    // incompatible schema or a tampered row — surface it rather than restore junk.
    const first = validated.issues[0];
    throw new Error(
      `stored workflow tree version "${treeId}"@r${revision} no longer validates (${first.path}: ${first.message})`,
    );
  }
  return {
    tree: validated.tree,
    sourceFormat: parseSourceFormat(row.source_format),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    savedAt: normalizeSqliteNumber(row.saved_at) ?? 0,
  };
}

/** Read one imported tree (null when absent). */
export function getEnterpriseWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): ImportedWorkflowTreeRecord | null {
  if (!treeStoreDatabaseExists(options)) {
    return null;
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().where("tree_id", "=", treeId),
  ) as EnterpriseTreeRow | undefined;
  return row ? rowToRecord(row) : null;
}

export type EnterpriseWorkflowTreeReadResult = {
  records: ImportedWorkflowTreeRecord[];
  /**
   * Imports that exist but no longer load (corrupt/incompatible rows),
   * keyed by the row id so operators can re-import or remove them without
   * losing the healthy imports read alongside.
   */
  rowErrors: Array<{ treeId: string; message: string }>;
};

/** Read every imported tree, ordered by tree id, with per-row error capture. */
export function listEnterpriseWorkflowTrees(
  options: EnterpriseTreeStoreOptions = {},
): EnterpriseWorkflowTreeReadResult {
  if (!treeStoreDatabaseExists(options)) {
    return { records: [], rowErrors: [] };
  }
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb.selectFrom("enterprise_workflow_trees").selectAll().orderBy("tree_id", "asc"),
  ).rows as EnterpriseTreeRow[];
  const records: ImportedWorkflowTreeRecord[] = [];
  const rowErrors: Array<{ treeId: string; message: string }> = [];
  for (const row of rows) {
    try {
      records.push(rowToRecord(row));
    } catch (err) {
      rowErrors.push({
        treeId: row.tree_id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { records, rowErrors };
}

/** Delete one imported tree. Returns true when a row was removed. */
export function deleteEnterpriseWorkflowTree(
  treeId: string,
  options: EnterpriseTreeStoreOptions = {},
): boolean {
  if (!treeStoreDatabaseExists(options)) {
    return false;
  }
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<EnterpriseTreeDatabase>(database.db);
    // Preserve the current definition in history before deleting the live row,
    // so a pre-history tree removed before its first save stays restorable.
    snapshotCurrentTreeRow(database, treeId, Date.now());
    const result = executeSqliteQuerySync(
      database.db,
      stateDb.deleteFrom("enterprise_workflow_trees").where("tree_id", "=", treeId),
    );
    removed = (normalizeSqliteNumber(result.numAffectedRows ?? 0n) ?? 0) > 0;
    if (removed) {
      // There is no FK to cascade from (built-in trees are code, not rows), so
      // this has to be explicit: otherwise the removed tree's objects survive and
      // are inherited by whatever tree next claims the id.
      deleteOntologyObjectsForTree(database, treeId);
    }
  }, stateDatabaseOptions(options));
  return removed;
}

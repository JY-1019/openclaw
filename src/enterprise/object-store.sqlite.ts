/**
 * SQLite persistence for ontology object INSTANCES in the shared state DB.
 *
 * Scoped by treeId, not by agent or run. The object TYPE is declared in the
 * tree's ontology; the tree is global (keyed by tree_id alone, loaded through a
 * process-global registry, edited via operator.admin), and an instance store
 * cannot be scoped narrower than the definition of its own type — a per-agent
 * store would show the same tree a different object graph per agent, and an
 * operator removing a tree could not reach the rows it orphaned.
 *
 * Provenance is the seam between the two writers. `seed` rows are declared BY the
 * tree, so a re-import re-applies them and the definition stays the source of
 * truth for what it declares. `runtime` rows were created by an action during a
 * run and a re-import never touches them.
 */
import { sql } from "kysely";
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
import type {
  EnterpriseId,
  OntologyValue,
  WorkflowNodeDefinition,
  WorkflowTreeDefinition,
} from "./types.js";

export type EnterpriseObjectStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

/** Who wrote the row: the tree definition, or an action during a run. */
export type OntologyProvenance = "seed" | "runtime";

/** One object instance as the tools see it. */
export type OntologyObjectRecord = {
  entity: EnterpriseId;
  objectId: string;
  properties: Record<string, OntologyValue>;
  provenance: OntologyProvenance;
  updatedAt: number;
};

/** One instance-level edge between two objects. */
export type OntologyLinkRecord = {
  relationship: EnterpriseId;
  fromEntity: EnterpriseId;
  fromObjectId: string;
  toEntity: EnterpriseId;
  toObjectId: string;
};

type EnterpriseObjectDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "enterprise_ontology_objects" | "enterprise_ontology_links"
>;

type ObjectRow = {
  tree_id: string;
  entity_id: string;
  object_id: string;
  provenance: string;
  properties_json: string;
  created_at: number | bigint;
  updated_at: number | bigint;
};

type LinkRow = {
  tree_id: string;
  relationship_id: string;
  from_entity_id: string;
  from_object_id: string;
  to_entity_id: string;
  to_object_id: string;
  provenance: string;
  created_at: number | bigint;
};

function stateDatabaseOptions(options: EnterpriseObjectStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function parseProvenance(value: string): OntologyProvenance {
  return value === "runtime" ? "runtime" : "seed";
}

function rowToObject(row: ObjectRow): OntologyObjectRecord {
  const parsed = JSON.parse(row.properties_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Properties were validated against the object type before they were
    // written, so a non-object here means a tampered or foreign row.
    throw new Error(
      `ontology object "${row.entity_id}/${row.object_id}" has malformed properties; re-import the tree`,
    );
  }
  return {
    entity: row.entity_id,
    objectId: row.object_id,
    properties: parsed as Record<string, OntologyValue>,
    provenance: parseProvenance(row.provenance),
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

function rowToLink(row: LinkRow): OntologyLinkRecord {
  return {
    relationship: row.relationship_id,
    fromEntity: row.from_entity_id,
    fromObjectId: row.from_object_id,
    toEntity: row.to_entity_id,
    toObjectId: row.to_object_id,
  };
}

/** Object instances the tree declares, plus the edges between them. */
export type OntologySeedData = {
  objects: Array<{
    entity: EnterpriseId;
    objectId: string;
    properties: Record<string, OntologyValue>;
  }>;
  links: Array<{
    relationship: EnterpriseId;
    fromEntity: EnterpriseId;
    fromObjectId: string;
    toEntity: EnterpriseId;
    toObjectId: string;
  }>;
};

/**
 * Flatten a validated tree's declared instances into rows.
 *
 * Object identity is the VALUE of the object type's primaryKey property — that
 * is what makes `$claim-id` in an expression and `claim/CLM-1042` in the store
 * the same thing. Import validation already proved every seed carries its
 * primaryKey and every link joins two seeded objects, so this walk assumes a
 * valid tree and does no re-checking.
 */
export function collectOntologySeed(tree: WorkflowTreeDefinition): OntologySeedData {
  const primaryKeys = new Map<EnterpriseId, string>();
  const linkEndpoints = new Map<EnterpriseId, { from: EnterpriseId; to: EnterpriseId }>();
  const seeds: Array<{ entity: EnterpriseId; properties: Record<string, OntologyValue> }> = [];
  const declaredLinks: Array<{ relationship: EnterpriseId; from: string; to: string }> = [];

  const walk = (node: WorkflowNodeDefinition): void => {
    for (const entity of node.ontology?.entities ?? []) {
      const primaryKey = entity.properties?.find((property) => property.primaryKey);
      if (primaryKey) {
        primaryKeys.set(entity.id, primaryKey.id);
      }
    }
    for (const relationship of node.ontology?.relationships ?? []) {
      if (!linkEndpoints.has(relationship.id)) {
        linkEndpoints.set(relationship.id, { from: relationship.from, to: relationship.to });
      }
    }
    seeds.push(...(node.ontology?.objects ?? []));
    declaredLinks.push(...(node.ontology?.links ?? []));
    for (const child of node.children ?? []) {
      walk(child);
    }
  };
  walk(tree.root);

  const objects = seeds.flatMap((seed) => {
    const primaryKey = primaryKeys.get(seed.entity);
    const identity = primaryKey ? seed.properties[primaryKey] : undefined;
    if (identity === undefined || identity === null || typeof identity === "boolean") {
      return [];
    }
    return [{ entity: seed.entity, objectId: String(identity), properties: seed.properties }];
  });

  const links = declaredLinks.flatMap((link) => {
    const endpoints = linkEndpoints.get(link.relationship);
    if (!endpoints) {
      return [];
    }
    return [
      {
        relationship: link.relationship,
        fromEntity: endpoints.from,
        fromObjectId: link.from,
        toEntity: endpoints.to,
        toObjectId: link.to,
      },
    ];
  });

  return { objects, links };
}

/**
 * Re-apply a tree's declared instances, inside the caller's import transaction.
 *
 * Seed rows are replaced wholesale (a seed dropped from the definition must
 * disappear, not linger), while `runtime` rows are left alone — a re-import
 * re-states what the tree declares and must not destroy what a run created.
 */
export function replaceSeededOntologyObjects(
  database: OpenClawStateDatabase,
  params: { treeId: string; seed: OntologySeedData; now?: number },
): void {
  const now = params.now ?? Date.now();
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);

  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("enterprise_ontology_objects")
      .where("tree_id", "=", params.treeId)
      .where("provenance", "=", "seed"),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("enterprise_ontology_links")
      .where("tree_id", "=", params.treeId)
      .where("provenance", "=", "seed"),
  );

  for (const object of params.seed.objects) {
    executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("enterprise_ontology_objects")
        .values({
          tree_id: params.treeId,
          entity_id: object.entity,
          object_id: object.objectId,
          provenance: "seed",
          properties_json: JSON.stringify(object.properties),
          created_at: now,
          updated_at: now,
        })
        // A seed whose id collides with a RUNTIME row overwrites it: the tree is
        // the source of truth for what it declares, and leaving both would make
        // the object's identity ambiguous (the primary key is the identity).
        .onConflict((conflict) =>
          conflict.columns(["tree_id", "entity_id", "object_id"]).doUpdateSet({
            provenance: "seed",
            properties_json: JSON.stringify(object.properties),
            updated_at: now,
          }),
        ),
    );
  }

  for (const link of params.seed.links) {
    executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("enterprise_ontology_links")
        .values({
          tree_id: params.treeId,
          relationship_id: link.relationship,
          from_entity_id: link.fromEntity,
          from_object_id: link.fromObjectId,
          to_entity_id: link.toEntity,
          to_object_id: link.toObjectId,
          provenance: "seed",
          created_at: now,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tree_id", "relationship_id", "from_object_id", "to_object_id"])
            .doNothing(),
        ),
    );
  }
}

/**
 * Drop every instance belonging to a tree, inside the caller's write
 * transaction. There is no FK to cascade from (built-in trees are code, not
 * rows), so removal has to be explicit or a removed tree leaves its objects
 * behind to be inherited by the next tree that reuses the id.
 */
export function deleteOntologyObjectsForTree(
  database: OpenClawStateDatabase,
  treeId: string,
): void {
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("enterprise_ontology_objects").where("tree_id", "=", treeId),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb.deleteFrom("enterprise_ontology_links").where("tree_id", "=", treeId),
  );
}

/**
 * Read one object THROUGH an open write transaction.
 *
 * A write path must check existence on the same handle it writes to: reading the
 * process-default database instead would make a valid update look missing (or a
 * create collide) whenever the transaction runs against another state DB.
 */
export function getOntologyObjectIn(
  database: OpenClawStateDatabase,
  params: { treeId: string; entity: EnterpriseId; objectId: string },
): OntologyObjectRecord | null {
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_ontology_objects")
      .selectAll()
      .where("tree_id", "=", params.treeId)
      .where("entity_id", "=", params.entity)
      .where("object_id", "=", params.objectId),
  ) as ObjectRow | undefined;
  return row ? rowToObject(row) : null;
}

/** Read one object by identity (null when absent). */
export function getOntologyObject(
  params: { treeId: string; entity: EnterpriseId; objectId: string },
  options: EnterpriseObjectStoreOptions = {},
): OntologyObjectRecord | null {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("enterprise_ontology_objects")
      .selectAll()
      .where("tree_id", "=", params.treeId)
      .where("entity_id", "=", params.entity)
      .where("object_id", "=", params.objectId),
  ) as ObjectRow | undefined;
  return row ? rowToObject(row) : null;
}

/**
 * Objects of one type in one tree, newest first.
 *
 * `match` filters on property VALUES, in SQL, so a hit is found BEFORE the limit
 * is taken — filtering a limited page in the client would hide matches behind
 * whatever happened to be most recently updated.
 *
 * It walks the JSON with json_each rather than LIKE-ing the serialized text: a
 * substring match over the raw JSON would also hit property NAMES and JSON
 * punctuation, so `match: "status"` would return every object that merely HAS a
 * status property. That is not what the tool promises the model.
 */
export function searchOntologyObjects(
  params: {
    treeId: string;
    entity: EnterpriseId;
    /** Case-insensitive substring match over the object's property values. */
    match?: string;
    /**
     * Property ids the CALLER may see. An object type is tree-scoped, so a stored
     * row can carry properties a sibling branch added — returning them verbatim
     * would leak fields past the active node's contract, and letting `match` run
     * over them would let the model probe values it cannot read. Omit only for
     * trusted internal reads.
     */
    properties?: readonly string[];
    limit: number;
  },
  options: EnterpriseObjectStoreOptions = {},
): OntologyObjectRecord[] {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  let query = stateDb
    .selectFrom("enterprise_ontology_objects")
    .selectAll()
    .where("tree_id", "=", params.treeId)
    .where("entity_id", "=", params.entity);
  const visible = params.properties;
  const match = params.match?.trim();
  if (match) {
    // LIKE is already case-insensitive for ASCII in SQLite. The escape keeps a
    // literal % or _ in the model's query from turning into a wildcard. The
    // pattern is BOUND, never interpolated: it is model-supplied text.
    //
    // Booleans and nulls have to be rendered back to the text the TOOL shows the
    // model: json_each surfaces `false` as integer 0 and `null` as SQL NULL, so
    // matching on the raw value would never find `verified: false` even though
    // that is exactly what search_objects returns.
    const pattern = `%${match.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    // The match runs ONLY over properties the caller may see. Searching the whole
    // stored JSON would let the model probe values from a sibling branch by
    // watching which objects come back.
    const scopeFilter = visible
      ? sql`AND property.key IN (${sql.join(visible.map((property) => sql`${property}`))})`
      : sql``;
    query = query.where(
      sql<boolean>`EXISTS (
        SELECT 1 FROM json_each(enterprise_ontology_objects.properties_json) AS property
        WHERE (CASE property.type
                 WHEN 'true' THEN 'true'
                 WHEN 'false' THEN 'false'
                 WHEN 'null' THEN 'null'
                 ELSE CAST(property.value AS TEXT)
               END) LIKE ${pattern} ESCAPE '\\'
        ${scopeFilter}
      )`,
    );
  }
  const rows = executeSqliteQuerySync(
    database.db,
    query.orderBy("updated_at", "desc").orderBy("object_id", "asc").limit(params.limit),
  ).rows as ObjectRow[];
  return rows.map((row) => projectProperties(rowToObject(row), visible));
}

/**
 * Drop properties the caller may not see. An object type is TREE-scoped, so a
 * stored row can legitimately carry fields a sibling branch declared; returning
 * them would hand the model data from outside its step's contract.
 */
function projectProperties(
  object: OntologyObjectRecord,
  visible: readonly string[] | undefined,
): OntologyObjectRecord {
  if (!visible) {
    return object;
  }
  const allowed = new Set(visible);
  return {
    ...object,
    properties: Object.fromEntries(
      Object.entries(object.properties).filter(([property]) => allowed.has(property)),
    ),
  };
}

/**
 * Edges touching one object, in BOTH directions.
 *
 * A link declared `customer -> account` is equally a fact about the account, so
 * traversing only the declared direction would make half the graph invisible
 * depending on which end the model happened to start from.
 */
export function getOntologyNeighbors(
  params: {
    treeId: string;
    entity: EnterpriseId;
    objectId: string;
    /** Restrict to one link type; omitted traverses every IN-SCOPE link. */
    relationship?: EnterpriseId;
    /**
     * Link types the caller may traverse. Without this, an object type shared
     * from an ancestor would walk edges declared only on a sibling branch and
     * return that branch's objects — straight through the node boundary.
     */
    relationships?: readonly EnterpriseId[];
    /** Property ids visible per neighbor object type. */
    visibleProperties?: ReadonlyMap<EnterpriseId, readonly string[]>;
    limit: number;
  },
  options: EnterpriseObjectStoreOptions = {},
): Array<{
  link: OntologyLinkRecord;
  direction: "outbound" | "inbound";
  object: OntologyObjectRecord | null;
}> {
  const database = openOpenClawStateDatabase(stateDatabaseOptions(options));
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  // An empty in-scope link set can traverse nothing; `in ()` is not valid SQL.
  if (params.relationships && params.relationships.length === 0) {
    return [];
  }

  const select = (direction: "outbound" | "inbound") => {
    const entityColumn = direction === "outbound" ? "from_entity_id" : "to_entity_id";
    const objectColumn = direction === "outbound" ? "from_object_id" : "to_object_id";
    let query = stateDb
      .selectFrom("enterprise_ontology_links")
      .selectAll()
      .where("tree_id", "=", params.treeId)
      .where(entityColumn, "=", params.entity)
      .where(objectColumn, "=", params.objectId);
    if (params.relationship) {
      query = query.where("relationship_id", "=", params.relationship);
    } else if (params.relationships) {
      query = query.where("relationship_id", "in", [...params.relationships]);
    }
    return executeSqliteQuerySync(
      database.db,
      query.orderBy("relationship_id", "asc").limit(params.limit),
    ).rows as LinkRow[];
  };

  const edges = [
    ...select("outbound").map((row) => ({ row, direction: "outbound" as const })),
    ...select("inbound").map((row) => ({ row, direction: "inbound" as const })),
  ].slice(0, params.limit);

  return edges.flatMap(({ row, direction }) => {
    const link = rowToLink(row);
    // The neighbor is the OTHER end of the edge, whichever end we came in on.
    const neighborEntity = direction === "outbound" ? link.toEntity : link.fromEntity;
    const neighborId = direction === "outbound" ? link.toObjectId : link.fromObjectId;
    // An edge whose far end is an object type this step cannot address is not a
    // neighbor it may walk to, even if the link type itself is in scope.
    if (params.visibleProperties && !params.visibleProperties.has(neighborEntity)) {
      return [];
    }
    const object = getOntologyObject(
      { treeId: params.treeId, entity: neighborEntity, objectId: neighborId },
      options,
    );
    const visible = params.visibleProperties?.get(neighborEntity);
    return [
      {
        link,
        direction,
        object: object ? projectProperties(object, visible) : null,
      },
    ];
  });
}

/** Write one object, inside the caller's write transaction. */
export function upsertOntologyObject(
  database: OpenClawStateDatabase,
  params: {
    treeId: string;
    entity: EnterpriseId;
    objectId: string;
    properties: Record<string, OntologyValue>;
    now?: number;
  },
): void {
  const now = params.now ?? Date.now();
  const propertiesJson = JSON.stringify(params.properties);
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb
      .insertInto("enterprise_ontology_objects")
      .values({
        tree_id: params.treeId,
        entity_id: params.entity,
        object_id: params.objectId,
        provenance: "runtime",
        properties_json: propertiesJson,
        created_at: now,
        updated_at: now,
      })
      // An update to a SEEDED object keeps its seed provenance: the tree still
      // declares it, so a re-import must still be able to restate it. Only the
      // values move.
      .onConflict((conflict) =>
        conflict.columns(["tree_id", "entity_id", "object_id"]).doUpdateSet({
          properties_json: propertiesJson,
          updated_at: now,
        }),
      ),
  );
}

/** Delete one object and every edge touching it, inside a write transaction. */
export function deleteOntologyObject(
  database: OpenClawStateDatabase,
  params: { treeId: string; entity: EnterpriseId; objectId: string },
): boolean {
  const stateDb = getNodeSqliteKysely<EnterpriseObjectDatabase>(database.db);
  const result = executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("enterprise_ontology_objects")
      .where("tree_id", "=", params.treeId)
      .where("entity_id", "=", params.entity)
      .where("object_id", "=", params.objectId),
  );
  // Edges touching a deleted object are dangling by definition: get_neighbors
  // would traverse them into nothing, so they go with it. Both directions, since
  // the object can sit on either end of an edge.
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("enterprise_ontology_links")
      .where("tree_id", "=", params.treeId)
      .where("from_entity_id", "=", params.entity)
      .where("from_object_id", "=", params.objectId),
  );
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("enterprise_ontology_links")
      .where("tree_id", "=", params.treeId)
      .where("to_entity_id", "=", params.entity)
      .where("to_object_id", "=", params.objectId),
  );
  return (normalizeSqliteNumber(result.numAffectedRows ?? 0n) ?? 0) > 0;
}

/** Open a write transaction on the shared state DB (for tool handlers). */
export function runOntologyObjectWrite<T>(
  write: (database: OpenClawStateDatabase) => T,
  options: EnterpriseObjectStoreOptions = {},
): T {
  let result!: T;
  runOpenClawStateWriteTransaction((database) => {
    result = write(database);
  }, stateDatabaseOptions(options));
  return result;
}

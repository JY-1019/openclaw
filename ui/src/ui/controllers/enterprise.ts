// Control UI controller manages the enterprise inspection gateway state.
import type {
  EnterpriseObjectsListResult,
  EnterpriseOntologyObject,
  EnterpriseRunDetail,
  EnterpriseRunsGetResult,
  EnterpriseRunsListResult,
  EnterpriseRunSummary,
  EnterpriseTreeDetail,
  EnterpriseTreeImportIssue,
  EnterpriseTreesExportResult,
  EnterpriseTreesGetResult,
  EnterpriseTreesHistoryGetResult,
  EnterpriseTreesHistoryListResult,
  EnterpriseTreesImportResult,
  EnterpriseTreesListResult,
  EnterpriseTreesRemoveResult,
  EnterpriseTreeSummary,
  EnterpriseTreeVersionSummary,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import { nodeObjectEntityIds } from "../views/enterprise-ontology-graph.ts";
import {
  type EditableTreeDefinition,
  insertChildNode,
  newNodeIdIssue,
} from "../views/enterprise-tree-edit.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

/** The pending confirmation the Save/Remove modal is asking the operator about. */
export type EnterpriseTreeConfirm = { kind: "save" } | { kind: "remove"; treeId: string };

export type EnterpriseTreeEditFormat = "yaml" | "json";

/** Why a node-add draft was rejected; the view maps each to an i18n message. */
export type EnterpriseNodeDraftError =
  | "id-empty"
  | "id-pattern"
  | "id-duplicate"
  | "title-empty"
  | "parent-missing"
  | "export-failed";

/**
 * An in-progress "add child node" form. Bound to `treeId` so a draft can never be
 * applied to a different tree that happens to share the parent node id (e.g. a
 * root named `root`); `parentId` is the node the child is added under. null when
 * no form is open. On submit the tree is re-exported, spliced, and loaded into the
 * raw editor for review + Save, so node creation reuses enterprise.trees.import.
 */
export type EnterpriseNodeDraft = {
  treeId: string;
  parentId: string;
  id: string;
  title: string;
  error: EnterpriseNodeDraftError | null;
};

export type EnterpriseState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enterpriseLoading: boolean;
  enterpriseRuns: EnterpriseRunSummary[];
  enterpriseTrees: EnterpriseTreeSummary[];
  enterpriseImportErrors: EnterpriseTreesListResult["importErrors"];
  enterpriseStoreError: string | null;
  enterpriseSelectedExecutionId: string | null;
  enterpriseDetail: EnterpriseRunDetail | null;
  enterpriseDetailLoading: boolean;
  /**
   * The tree the SELECTED RUN bound to. Held separately from the registry
   * selection (enterpriseTreeDetail) so opening a run cannot clobber the tree
   * the operator is browsing, and so the run inspector can draw the full tree
   * with the run's route lit against the branches it did not take.
   */
  enterpriseRunTree: EnterpriseTreeDetail | null;
  enterpriseSelectedTreeId: string | null;
  enterpriseTreeDetail: EnterpriseTreeDetail | null;
  enterpriseTreeLoading: boolean;
  enterpriseTreeIssue: string | null;
  // P4 node inspector: the expanded workflow node, which entity type's instances
  // are shown for it, and those rows. Cleared on tree switch/reload.
  enterpriseSelectedNodeId: string | null;
  enterpriseNodeObjectsEntity: string | null;
  enterpriseNodeObjects: EnterpriseOntologyObject[];
  enterpriseNodeObjectsLoading: boolean;
  enterpriseTreeEditing: boolean;
  // The id being edited, or null for a brand-new tree — distinguishes create
  // from edit so format switches reseed from the right source.
  enterpriseTreeEditTreeId: string | null;
  // The historical revision being edited, or null when editing the current
  // definition or a new tree — so format switches reseed from history.get.
  enterpriseTreeEditRevision: number | null;
  enterpriseTreeEditContent: string;
  enterpriseTreeEditFormat: EnterpriseTreeEditFormat;
  enterpriseTreeSaving: boolean;
  enterpriseTreeSaveIssues: EnterpriseTreeImportIssue[] | null;
  enterpriseTreeSaveError: string | null;
  enterpriseTreeConfirm: EnterpriseTreeConfirm | null;
  enterpriseTreeVersions: EnterpriseTreeVersionSummary[];
  enterpriseTreeVersionsLoading: boolean;
  // P5 dynamic node creation: the open "add child node" form, or null. Splices a
  // child into the tree definition and reuses the editor's import-to-save flow.
  enterpriseNodeDraft: EnterpriseNodeDraft | null;
  enterpriseError: string | null;
};

// Monotonic token so the latest list load wins. A guarded "skip if already
// loading" would make a post-mutation reload a no-op while a tab-load/refresh is
// in flight, leaving the just-saved/removed tree missing; the token instead lets
// the newer load supersede the older, whose stale response is then dropped.
let listRequestSeq = 0;

/** Load the recent-run list and the workflow-tree registry for the tab. */
export async function loadEnterprise(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++listRequestSeq;
  state.enterpriseLoading = true;
  state.enterpriseError = null;
  try {
    const [runs, trees] = await Promise.all([
      state.client.request<EnterpriseRunsListResult>("enterprise.runs.list", {}),
      state.client.request<EnterpriseTreesListResult>("enterprise.trees.list", {}),
    ]);
    if (requestSeq !== listRequestSeq) {
      return;
    }
    state.enterpriseRuns = runs.runs;
    state.enterpriseTrees = trees.trees;
    state.enterpriseImportErrors = trees.importErrors;
    state.enterpriseStoreError = trees.storeError ?? null;
  } catch (err) {
    if (requestSeq !== listRequestSeq) {
      return;
    }
    applyError(state, err);
  } finally {
    if (requestSeq === listRequestSeq) {
      state.enterpriseLoading = false;
    }
  }
}

// Monotonic token so only the latest detail request wins. The selected id alone
// can't disambiguate two in-flight requests for the SAME run (double click, or
// Refresh while a detail load is pending), and gateway responses can resolve out
// of order, so a bare id check would let an older response overwrite a newer one.
let detailRequestSeq = 0;

/** Fetch one execution's plan + governance trace for the inspector panel. */
export async function loadEnterpriseRunDetail(state: EnterpriseState, executionId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++detailRequestSeq;
  state.enterpriseSelectedExecutionId = executionId;
  state.enterpriseDetail = null;
  state.enterpriseRunTree = null;
  state.enterpriseDetailLoading = true;
  state.enterpriseError = null;
  try {
    const res = await state.client.request<EnterpriseRunsGetResult>("enterprise.runs.get", {
      executionId,
    });
    // Drop the response if a newer detail request has since started.
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    state.enterpriseDetail = res.run;
    // The tree picture is secondary to the run detail, so it loads alongside
    // rather than inside it: the steps and governance trace must render even if
    // the tree fetch is slow or fails.
    if (res.run?.treeId) {
      void loadEnterpriseRunTree(
        state,
        { treeId: res.run.treeId, treeHash: res.run.treeHash },
        requestSeq,
      );
    }
  } catch (err) {
    if (requestSeq !== detailRequestSeq) {
      return;
    }
    applyError(state, err);
  } finally {
    // Only the latest request owns the loading flag; an older one clearing it
    // would hide the newer request's in-flight state.
    if (requestSeq === detailRequestSeq) {
      state.enterpriseDetailLoading = false;
    }
  }
}

/**
 * Load the tree the selected run bound to. Guarded by the run-detail token: if a
 * newer run is opened while this is in flight, its response is dropped rather
 * than painting the previous run's tree under the new run.
 */
async function loadEnterpriseRunTree(
  state: EnterpriseState,
  run: { treeId: string; treeHash?: string },
  runSeq: number,
) {
  if (!state.client || !state.connected) {
    return;
  }
  // Without the run's hash (a trace written before hashes existed) we cannot
  // prove the live tree is the one it governed, so the picture is withheld.
  if (!run.treeHash) {
    state.enterpriseRunTree = null;
    return;
  }
  try {
    const res = await state.client.request<EnterpriseTreesGetResult>("enterprise.trees.get", {
      treeId: run.treeId,
    });
    if (runSeq !== detailRequestSeq) {
      return;
    }
    const live = res?.tree ?? null;
    // Identity by CONTENT, not by version or timestamps. `version` is
    // author-controlled and re-importable unchanged, and removing an imported
    // override silently reveals a different built-in — both would pass a version
    // check while the nodes on screen are branches the run never governed. The
    // plan's own step list always renders; only the tree picture is withheld.
    state.enterpriseRunTree = live && live.hash === run.treeHash ? live : null;
  } catch {
    if (runSeq === detailRequestSeq) {
      state.enterpriseRunTree = null;
    }
  }
}

// Separate token: tree-detail loads race independently from run-detail loads.
let treeRequestSeq = 0;

/** Fetch one workflow tree's full definition + ontology for the visualizer. */
export async function loadEnterpriseTreeDetail(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  // A save that imports a NEW tree opens it through this same path, so a node id
  // shared with the prior tree (e.g. "root") must not carry that selection across.
  const previousTreeId = state.enterpriseSelectedTreeId;
  const treeChanged = previousTreeId !== treeId;
  const requestSeq = ++treeRequestSeq;
  state.enterpriseSelectedTreeId = treeId;
  state.enterpriseTreeDetail = null;
  state.enterpriseTreeLoading = true;
  state.enterpriseTreeIssue = null;
  // Clear any prior banner (e.g. a transient runs.get failure); a successful
  // tree load must not render beneath a stale global error.
  state.enterpriseError = null;
  // Drop the prior node selection eagerly on a tree switch — before the async
  // load can fail or be superseded. Clearing only on success would leave the old
  // selection dangling under the just-assigned tree id, where a later retry
  // (now previousTreeId === treeId) would mistake a shared node id for a
  // same-tree refresh and auto-load the wrong tree's rows.
  if (treeChanged) {
    clearEnterpriseNodeSelection(state);
  }
  try {
    const res = await state.client.request<EnterpriseTreesGetResult>("enterprise.trees.get", {
      treeId,
    });
    if (requestSeq !== treeRequestSeq) {
      return;
    }
    state.enterpriseTreeDetail = res.tree;
    // A stale built-in may be returned; surface the failed override/store read.
    state.enterpriseTreeIssue = res.storeError ?? res.importError ?? null;
    // Reconcile only a same-tree refresh that returned an authoritative tree.
    // A fallback (storeError/importError) or a missing tree means the ontology on
    // screen may not match the selection, so drop it rather than load rows.
    const authoritative = !res.storeError && !res.importError;
    if (!treeChanged && authoritative && res.tree) {
      // Same-tree reload (Refresh / re-save): keep the node selection but re-point
      // its instance rows at the freshly loaded ontology so they cannot go stale.
      reconcileNodeSelectionAfterReload(state, res.tree);
    } else {
      clearEnterpriseNodeSelection(state);
    }
  } catch (err) {
    if (requestSeq !== treeRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      // Losing operator.read must clear ALL governed data (runs, trees, open
      // detail, selection), not just the tree — mirror loadEnterprise.
      applyError(state, err);
    } else {
      state.enterpriseTreeIssue = String(err);
    }
  } finally {
    if (requestSeq === treeRequestSeq) {
      state.enterpriseTreeLoading = false;
    }
  }
}

// Separate token so version-history loads race independently from detail loads.
let versionsRequestSeq = 0;

// Monotonic token guarding async editor seeding (export / history.get). A newer
// Edit / New / version-load / format-switch / reset supersedes an in-flight seed
// so a late response never writes stale content into the editor.
let editSeedSeq = 0;

/** Discard any in-progress edit + confirmation without touching the selection. */
function resetTreeEditing(state: EnterpriseState) {
  // Invalidate any in-flight seed so it cannot re-enter edit mode after this.
  editSeedSeq++;
  state.enterpriseTreeEditing = false;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditContent = "";
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeConfirm = null;
}

/** Select a tree for the visualizer/editor: cancel edits, load detail + history. */
export function selectEnterpriseTree(state: EnterpriseState, treeId: string) {
  // Switching trees abandons an unsaved edit of the previous one.
  resetTreeEditing(state);
  // A node selection belongs to the tree it was made in; a different tree's node
  // panel would be nonsense against the new tree's ontology.
  clearEnterpriseNodeSelection(state);
  void loadEnterpriseTreeDetail(state, treeId);
  void loadEnterpriseTreeVersions(state, treeId);
}

// Separate token so a node's object load races independently from tree/detail
// loads: a fast node click while a detail refresh is in flight must not drop.
let nodeObjectsRequestSeq = 0;

// Drop the loaded instance rows and invalidate any in-flight objects request,
// without touching which node is selected. Bumping the token here is what makes
// a late reply from a superseded entity/tree load fall through its own guard.
function clearEnterpriseNodeObjects(state: EnterpriseState) {
  nodeObjectsRequestSeq++;
  state.enterpriseNodeObjectsEntity = null;
  state.enterpriseNodeObjects = [];
  state.enterpriseNodeObjectsLoading = false;
}

function clearEnterpriseNodeSelection(state: EnterpriseState) {
  clearEnterpriseNodeObjects(state);
  state.enterpriseSelectedNodeId = null;
  // A node-add draft belongs to the selected node in its tree; a tree switch,
  // pruned node, or scope loss (every caller of this) invalidates it, so drop it
  // rather than let a stale form reappear under a same-named node elsewhere.
  state.enterpriseNodeDraft = null;
}

/**
 * Refresh and post-save re-import reload the *same* tree in place, so a node's
 * cached instances belong to the pre-reload ontology. Reconcile against the
 * freshly loaded tree: drop the selection if the node vanished, otherwise reload
 * rows for the still-valid entity — keeping the operator's chosen type when it
 * survives the re-import, else the node's default. Without this the inspector
 * shows stale rows until the operator manually re-toggles the node.
 */
function reconcileNodeSelectionAfterReload(state: EnterpriseState, tree: EnterpriseTreeDetail) {
  const nodeId = state.enterpriseSelectedNodeId;
  if (!nodeId) {
    return;
  }
  if (!tree.nodes.some((node) => node.id === nodeId)) {
    clearEnterpriseNodeSelection(state);
    return;
  }
  const entities = nodeObjectEntityIds(tree, nodeId);
  const current = state.enterpriseNodeObjectsEntity;
  const entity = current && entities.includes(current) ? current : entities[0];
  if (entity) {
    void loadEnterpriseNodeObjects(state, nodeId, entity);
  } else {
    // Node survives but no longer scopes any object type: keep its ontology
    // graph up, just clear the now-meaningless rows.
    clearEnterpriseNodeObjects(state);
  }
}

/**
 * Expand (or collapse) a workflow node in the inspector. Selecting a node
 * auto-loads the first object type in its scope so the panel shows live data at
 * once; the entity list and this default derive from the same helper the view
 * renders chips from, so the highlighted chip always matches the loaded rows.
 */
export function selectEnterpriseNode(state: EnterpriseState, nodeId: string | null) {
  if (!nodeId) {
    clearEnterpriseNodeSelection(state);
    return;
  }
  clearEnterpriseNodeSelection(state);
  state.enterpriseSelectedNodeId = nodeId;
  const tree = state.enterpriseTreeDetail;
  const defaultEntity = tree ? nodeObjectEntityIds(tree, nodeId)[0] : undefined;
  if (defaultEntity) {
    void loadEnterpriseNodeObjects(state, nodeId, defaultEntity);
  }
}

/** Switch which entity type's instances the node inspector shows. */
export function selectEnterpriseNodeEntity(state: EnterpriseState, entity: string) {
  const nodeId = state.enterpriseSelectedNodeId;
  if (!nodeId) {
    return;
  }
  void loadEnterpriseNodeObjects(state, nodeId, entity);
}

/** Load one entity type's object instances for the selected node's tree. */
async function loadEnterpriseNodeObjects(state: EnterpriseState, nodeId: string, entity: string) {
  const treeId = state.enterpriseSelectedTreeId;
  if (!state.client || !state.connected || !treeId) {
    return;
  }
  const requestSeq = ++nodeObjectsRequestSeq;
  state.enterpriseNodeObjectsEntity = entity;
  state.enterpriseNodeObjects = [];
  state.enterpriseNodeObjectsLoading = true;
  try {
    const res = await state.client.request<EnterpriseObjectsListResult>("enterprise.objects.list", {
      treeId,
      entity,
    });
    // A node re-selection or entity switch bumps the token; drop the stale reply.
    if (requestSeq !== nodeObjectsRequestSeq || state.enterpriseSelectedNodeId !== nodeId) {
      return;
    }
    state.enterpriseNodeObjects = res.objects;
  } catch (err) {
    if (requestSeq !== nodeObjectsRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      applyError(state, err);
    } else {
      // Instance load failures are non-fatal to the inspector: leave the type
      // graph up and just show no rows rather than tearing down the panel.
      state.enterpriseNodeObjects = [];
    }
  } finally {
    if (requestSeq === nodeObjectsRequestSeq) {
      state.enterpriseNodeObjectsLoading = false;
    }
  }
}

/** Load the saved-revision list for the history panel (bounded server-side). */
export async function loadEnterpriseTreeVersions(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const requestSeq = ++versionsRequestSeq;
  // Drop the previous tree's revisions immediately: otherwise switching trees
  // shows the prior list until this resolves, and a click would history.get the
  // new tree with an old revision number.
  state.enterpriseTreeVersions = [];
  state.enterpriseTreeVersionsLoading = true;
  try {
    const res = await state.client.request<EnterpriseTreesHistoryListResult>(
      "enterprise.trees.history.list",
      { treeId },
    );
    if (requestSeq !== versionsRequestSeq) {
      return;
    }
    state.enterpriseTreeVersions = res.versions;
  } catch (err) {
    if (requestSeq !== versionsRequestSeq) {
      return;
    }
    if (isMissingOperatorReadScopeError(err)) {
      // This may be the first read to observe a downgraded token — clear all
      // governed data like the other read paths, not just the history panel.
      applyError(state, err);
      return;
    }
    // Otherwise history is auxiliary; a load failure just empties the panel.
    state.enterpriseTreeVersions = [];
  } finally {
    if (requestSeq === versionsRequestSeq) {
      state.enterpriseTreeVersionsLoading = false;
    }
  }
}

// scopeCleared marks a missing-operator.read failure already routed through
// applyError (governed data cleared, banner set) so callers skip a saveError.
type SeedResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; scopeCleared?: boolean };

/** Turn a caught error into a SeedResult, clearing governed data on scope loss. */
function seedFailure(state: EnterpriseState, err: unknown): SeedResult {
  if (isMissingOperatorReadScopeError(err)) {
    applyError(state, err);
    return { ok: false, reason: "", scopeCleared: true };
  }
  return { ok: false, reason: String(err) };
}

/** Fetch a tree's current definition serialized in `format` (no state writes). */
async function fetchExportContent(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
): Promise<SeedResult> {
  if (!state.client || !state.connected) {
    return { ok: false, reason: "not connected" };
  }
  try {
    const res = await state.client.request<EnterpriseTreesExportResult>("enterprise.trees.export", {
      treeId,
      format,
    });
    return res.content === null
      ? { ok: false, reason: res.reason ?? "export unavailable" }
      : { ok: true, content: res.content };
  } catch (err) {
    return seedFailure(state, err);
  }
}

/** Fetch a historical revision serialized in `format` (no state writes). */
async function fetchHistoryContent(
  state: EnterpriseState,
  treeId: string,
  revision: number,
  format: EnterpriseTreeEditFormat,
): Promise<SeedResult> {
  if (!state.client || !state.connected) {
    return { ok: false, reason: "not connected" };
  }
  try {
    const res = await state.client.request<EnterpriseTreesHistoryGetResult>(
      "enterprise.trees.history.get",
      { treeId, revision, format },
    );
    return res.content === null
      ? { ok: false, reason: "that revision is no longer available" }
      : { ok: true, content: res.content };
  } catch (err) {
    return seedFailure(state, err);
  }
}

/**
 * Apply an async seed to the editor only if it is still the latest intent. The
 * content and its `format` are set together so Save never sends one format with
 * the other's text; on failure neither changes, keeping them in sync.
 */
function applyEditorSeed(
  state: EnterpriseState,
  seedSeq: number,
  format: EnterpriseTreeEditFormat,
  treeId: string | null,
  revision: number | null,
  result: SeedResult,
) {
  if (seedSeq !== editSeedSeq) {
    return;
  }
  if (!result.ok) {
    // A scope loss already cleared governed data + set the global banner.
    if (!result.scopeCleared) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  state.enterpriseTreeEditFormat = format;
  state.enterpriseTreeEditTreeId = treeId;
  state.enterpriseTreeEditRevision = revision;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeEditContent = result.content;
  state.enterpriseTreeEditing = true;
}

/** Enter edit mode for the selected tree, seeding the editor from its export. */
export async function beginEditEnterpriseTree(state: EnterpriseState) {
  const treeId = state.enterpriseSelectedTreeId;
  if (!treeId) {
    return;
  }
  const format = state.enterpriseTreeEditFormat;
  const seedSeq = ++editSeedSeq;
  const result = await fetchExportContent(state, treeId, format);
  applyEditorSeed(state, seedSeq, format, treeId, null, result);
}

/** Open the editor on a blank template to import a brand-new tree. */
export function beginNewEnterpriseTree(state: EnterpriseState) {
  // Supersede any in-flight seed so it cannot overwrite the new-tree template.
  editSeedSeq++;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  state.enterpriseTreeEditTreeId = null;
  state.enterpriseTreeEditRevision = null;
  state.enterpriseTreeEditContent = treeTemplate(state.enterpriseTreeEditFormat);
  state.enterpriseTreeEditing = true;
}

export function setEnterpriseTreeEditContent(state: EnterpriseState, content: string) {
  // Typing is a newer edit intent than any in-flight async seed; advancing the
  // token drops a late format/history reseed that would clobber this text.
  editSeedSeq++;
  state.enterpriseTreeEditContent = content;
}

const NODE_ID_DRAFT_ERROR: Record<
  ReturnType<typeof newNodeIdIssue> & string,
  EnterpriseNodeDraftError
> = {
  empty: "id-empty",
  pattern: "id-pattern",
  duplicate: "id-duplicate",
};

/** Open the "add child node" form under `parentId` (the selected node). */
export function beginAddEnterpriseNode(state: EnterpriseState, parentId: string) {
  const treeId = state.enterpriseTreeDetail?.id;
  if (!treeId) {
    return;
  }
  state.enterpriseNodeDraft = { treeId, parentId, id: "", title: "", error: null };
}

/** Update the open draft's fields; any prior error clears as the operator edits. */
export function editEnterpriseNodeDraft(
  state: EnterpriseState,
  patch: { id?: string; title?: string },
) {
  const draft = state.enterpriseNodeDraft;
  if (!draft) {
    return;
  }
  state.enterpriseNodeDraft = {
    ...draft,
    ...(patch.id !== undefined ? { id: patch.id } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    error: null,
  };
}

export function cancelAddEnterpriseNode(state: EnterpriseState) {
  state.enterpriseNodeDraft = null;
}

function failNodeDraft(
  state: EnterpriseState,
  draft: EnterpriseNodeDraft,
  error: EnterpriseNodeDraftError,
) {
  state.enterpriseNodeDraft = { ...draft, error };
}

/**
 * Validate the draft, then splice a bare child into the tree's CANONICAL nested
 * definition (re-exported as JSON — the flat detail is lossy and JSON avoids
 * pulling a YAML parser into the UI) and load the result into the raw editor.
 * The operator reviews it and Saves through the existing confirm ->
 * enterprise.trees.import flow, so node creation adds no second write path.
 */
export async function submitAddEnterpriseNode(state: EnterpriseState) {
  const draft = state.enterpriseNodeDraft;
  const tree = state.enterpriseTreeDetail;
  // The draft must belong to the tree on screen (both clear on a tree switch, so a
  // mismatch means a race — abort rather than splice into the wrong tree).
  if (!draft || !tree || draft.treeId !== tree.id) {
    return;
  }
  const id = draft.id.trim();
  const title = draft.title.trim();
  // Validate client-side against the import contract so the common mistakes show
  // in the form, not as a raw-editor issue after a whole-tree-replace attempt.
  const existingIds = new Set(tree.nodes.map((node) => node.id));
  const idIssue = newNodeIdIssue(id, existingIds);
  if (idIssue) {
    failNodeDraft(state, draft, NODE_ID_DRAFT_ERROR[idIssue]);
    return;
  }
  if (title.length === 0) {
    failNodeDraft(state, draft, "title-empty");
    return;
  }
  if (!existingIds.has(draft.parentId)) {
    failNodeDraft(state, draft, "parent-missing");
    return;
  }
  // Claim the editor seed intent: a competing Edit/New/history load started while
  // the export is in flight supersedes this add, and applyEditorSeed re-checks it.
  const seedSeq = ++editSeedSeq;
  const exported = await fetchExportContent(state, tree.id, "json");
  // Every draft mutation (edit/cancel/reopen) REPLACES the object, so an identity
  // check rejects a submit whose form changed during the export — its captured
  // id/title/parent would be stale. The seed token catches a competing editor load.
  if (seedSeq !== editSeedSeq || state.enterpriseNodeDraft !== draft) {
    return;
  }
  if (!exported.ok) {
    // A scope loss already cleared governed data + set the global banner.
    if (!exported.scopeCleared) {
      failNodeDraft(state, draft, "export-failed");
    }
    return;
  }
  const definition = parseTreeDefinition(exported.content);
  if (!definition) {
    failNodeDraft(state, draft, "export-failed");
    return;
  }
  const spliced = insertChildNode(definition, draft.parentId, { id, title });
  if (!spliced.ok) {
    // Lost a race with a concurrent change to the definition since the detail load.
    failNodeDraft(
      state,
      draft,
      spliced.reason === "duplicate-id" ? "id-duplicate" : "parent-missing",
    );
    return;
  }
  state.enterpriseNodeDraft = null;
  applyEditorSeed(state, seedSeq, "json", tree.id, null, {
    ok: true,
    content: `${JSON.stringify(spliced.definition, null, 2)}\n`,
  });
}

function parseTreeDefinition(content: string): EditableTreeDefinition | null {
  try {
    const parsed: unknown = JSON.parse(content);
    // The export is a validated definition, but guard the shape the splice needs.
    if (
      parsed &&
      typeof parsed === "object" &&
      "root" in parsed &&
      typeof (parsed as { root: unknown }).root === "object"
    ) {
      return parsed as EditableTreeDefinition;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Switch the editor exchange format and re-seed the content in that format —
 * the raw editor cannot reliably convert arbitrary in-progress edits. A new-tree
 * draft regenerates the template; an existing edit re-exports; a history draft
 * re-fetches the same revision so it is not silently replaced by the live tree.
 */
export async function setEnterpriseTreeEditFormat(
  state: EnterpriseState,
  format: EnterpriseTreeEditFormat,
) {
  if (state.enterpriseTreeEditFormat === format) {
    // Re-selecting the current format cancels a pending reseed to the other one
    // (the format only flips once its reseed lands, so this catches that click).
    editSeedSeq++;
    return;
  }
  if (!state.enterpriseTreeEditing) {
    // Not editing: record the preferred format for the next edit.
    state.enterpriseTreeEditFormat = format;
    return;
  }
  const editTreeId = state.enterpriseTreeEditTreeId;
  if (editTreeId === null) {
    // New-tree draft: regenerate the template + set the format atomically, and
    // drop diagnostics from the prior content that no longer applies.
    editSeedSeq++;
    state.enterpriseTreeSaveIssues = null;
    state.enterpriseTreeSaveError = null;
    state.enterpriseTreeEditFormat = format;
    state.enterpriseTreeEditContent = treeTemplate(format);
    return;
  }
  // Do NOT change the format until the reseed lands: until then the editor holds
  // the previous-format text, and Save must keep sending the matching format.
  const revision = state.enterpriseTreeEditRevision;
  const seedSeq = ++editSeedSeq;
  const result =
    revision === null
      ? await fetchExportContent(state, editTreeId, format)
      : await fetchHistoryContent(state, editTreeId, revision, format);
  applyEditorSeed(state, seedSeq, format, editTreeId, revision, result);
}

export function cancelEditEnterpriseTree(state: EnterpriseState) {
  resetTreeEditing(state);
}

/** Load a historical revision into the editor to review or restore it. */
export async function loadEnterpriseTreeVersion(
  state: EnterpriseState,
  treeId: string,
  revision: number,
) {
  const format = state.enterpriseTreeEditFormat;
  const seedSeq = ++editSeedSeq;
  const result = await fetchHistoryContent(state, treeId, revision, format);
  applyEditorSeed(state, seedSeq, format, treeId, revision, result);
}

/** Ask the confirmation modal before persisting the current edit. */
export function requestSaveEnterpriseTree(state: EnterpriseState) {
  state.enterpriseTreeConfirm = { kind: "save" };
}

/** Ask the confirmation modal before removing an imported tree. */
export function requestRemoveEnterpriseTree(state: EnterpriseState, treeId: string) {
  state.enterpriseTreeConfirm = { kind: "remove", treeId };
}

export function cancelEnterpriseTreeConfirm(state: EnterpriseState) {
  state.enterpriseTreeConfirm = null;
}

/** Resolve the open confirmation: persist the edit or remove the tree. */
export async function confirmEnterpriseTreeAction(state: EnterpriseState) {
  const confirm = state.enterpriseTreeConfirm;
  if (!confirm) {
    return;
  }
  state.enterpriseTreeConfirm = null;
  if (confirm.kind === "save") {
    await saveEnterpriseTree(state);
  } else {
    await removeEnterpriseTree(state, confirm.treeId);
  }
}

async function saveEnterpriseTree(state: EnterpriseState) {
  if (!state.client || !state.connected) {
    return;
  }
  // Invalidate any in-flight format/history reseed so a late applyEditorSeed
  // cannot swap the textarea content out from under the submitted draft; the
  // resulting token is the edit intent. The tree list / New Tree controls stay
  // usable while the import is in flight, so if the operator moves on we must not
  // clobber that newer editor/selection with this older save's result.
  const editIntent = ++editSeedSeq;
  const superseded = () => editIntent !== editSeedSeq;
  state.enterpriseTreeSaving = true;
  state.enterpriseTreeSaveIssues = null;
  state.enterpriseTreeSaveError = null;
  try {
    const res = await state.client.request<EnterpriseTreesImportResult>("enterprise.trees.import", {
      content: state.enterpriseTreeEditContent,
      format: state.enterpriseTreeEditFormat,
    });
    if (!res.ok) {
      // Schema-invalid content: keep the editor open with the issues shown, but
      // only if the operator is still on the same draft.
      if (!superseded()) {
        state.enterpriseTreeSaveIssues = res.issues ?? [];
      }
      return;
    }
    if (superseded()) {
      // The operator started a different selection/draft; the tree is still
      // saved, so just refresh the registry list in the background.
      await loadEnterprise(state);
      return;
    }
    // resetTreeEditing bumps editSeedSeq; capture a fresh intent to detect the
    // operator moving on during the awaited registry reload below.
    resetTreeEditing(state);
    const openIntent = editSeedSeq;
    // A new tree can change the registry list; reload it, then open the saved tree.
    await loadEnterprise(state);
    // A failed list reload set the banner; opening the saved tree would clear
    // enterpriseError at request start and hide that failure with stale lists.
    if (state.enterpriseError) {
      return;
    }
    if (openIntent !== editSeedSeq) {
      // A selection/draft started during the reload must win over the saved tree.
      return;
    }
    if (res.treeId) {
      await loadEnterpriseTreeDetail(state, res.treeId);
      await loadEnterpriseTreeVersions(state, res.treeId);
    }
  } catch (err) {
    if (!superseded()) {
      state.enterpriseTreeSaveError = String(err);
    }
  } finally {
    state.enterpriseTreeSaving = false;
  }
}

async function removeEnterpriseTree(state: EnterpriseState, treeId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<EnterpriseTreesRemoveResult>("enterprise.trees.remove", {
      treeId,
    });
    // Recompute AFTER the await: removal can come from the import-error banner
    // for a different tree, and the operator may have selected another tree or
    // started a draft while this was in flight — only touch the editor/selection
    // when they still belong to the removed id, or newer work would be discarded.
    const affectsCurrent = state.enterpriseSelectedTreeId === treeId;
    if (!res.removed) {
      // Nothing was deleted (built-in or already-gone id); report it without
      // pretending it succeeded, on whichever surface triggered the removal.
      const message = `no imported tree "${treeId}" to remove`;
      if (affectsCurrent) {
        state.enterpriseTreeIssue = message;
      } else {
        state.enterpriseError = message;
      }
      return;
    }
    if (affectsCurrent) {
      resetTreeEditing(state);
      state.enterpriseSelectedTreeId = null;
      state.enterpriseTreeDetail = null;
      state.enterpriseTreeIssue = null;
      state.enterpriseTreeVersions = [];
    }
    await loadEnterprise(state);
  } catch (err) {
    state.enterpriseError = String(err);
  }
}

/** Export a tree in `format` and trigger a browser download of the artifact. */
export async function exportEnterpriseTree(
  state: EnterpriseState,
  treeId: string,
  format: EnterpriseTreeEditFormat,
) {
  const result = await fetchExportContent(state, treeId, format);
  if (!result.ok) {
    if (!result.scopeCleared) {
      state.enterpriseTreeSaveError = result.reason;
    }
    return;
  }
  // A prior failed export may have left an error banner; a successful retry
  // must clear it before the download.
  state.enterpriseTreeSaveError = null;
  triggerDownload(`${treeId}.${format}`, result.content);
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function treeTemplate(format: EnterpriseTreeEditFormat): string {
  // The template is keyword-scoped on purpose: an unscoped tree (no match) is
  // selected with priority 0 and would beat the built-in assist backstop (-100),
  // hijacking every user request. A placeholder keyword keeps a saved-as-is draft
  // inert until the author narrows the match to real triggers.
  const tree = {
    schema: "clawworks.workflow-tree",
    schemaVersion: 1,
    id: "acme.new-tree",
    version: "1.0.0",
    name: "New workflow tree",
    match: { keywords: ["acme-new-tree"], triggers: ["user"], priority: 0 },
    root: { id: "root", title: "Root step" },
  };
  if (format === "json") {
    return `${JSON.stringify(tree, null, 2)}\n`;
  }
  return [
    "schema: clawworks.workflow-tree",
    "schemaVersion: 1",
    "id: acme.new-tree",
    "version: 1.0.0",
    "name: New workflow tree",
    "match:",
    "  keywords: [acme-new-tree]",
    "  triggers: [user]",
    "  priority: 0",
    "root:",
    "  id: root",
    "  title: Root step",
    "",
  ].join("\n");
}

/**
 * Reload the list + registry and, when open, the selected run detail and tree.
 */
export async function refreshEnterprise(state: EnterpriseState) {
  await loadEnterprise(state);
  // If the list/tree refresh failed, keep its error banner; a following detail
  // reload would clear enterpriseError and hide the stale-list failure. (An auth
  // failure also clears the selection, so the guards below would skip anyway.)
  if (state.enterpriseError) {
    return;
  }
  const selectedRun = state.enterpriseSelectedExecutionId;
  if (selectedRun) {
    await loadEnterpriseRunDetail(state, selectedRun);
    // A failed run-detail reload set the banner; the tree reload below clears
    // enterpriseError at request start, which would hide that failure.
    if (state.enterpriseError) {
      return;
    }
  }
  const selectedTree = state.enterpriseSelectedTreeId;
  if (selectedTree) {
    await loadEnterpriseTreeDetail(state, selectedTree);
    await loadEnterpriseTreeVersions(state, selectedTree);
  }
}

function applyError(state: EnterpriseState, err: unknown) {
  if (isMissingOperatorReadScopeError(err)) {
    // Advance every request token so any in-flight list/run/tree/history response
    // is dropped by its sequence guard — otherwise a load started before the
    // scope loss could resolve afterward and repopulate the data cleared here.
    listRequestSeq++;
    detailRequestSeq++;
    treeRequestSeq++;
    versionsRequestSeq++;
    // Also drop the node inspector: clearing bumps nodeObjectsRequestSeq so an
    // in-flight enterprise.objects.list cannot write governed rows back after
    // the scope loss, the same invariant the other tokens above enforce.
    clearEnterpriseNodeSelection(state);
    // A pending loadEnterprise owns enterpriseLoading; since its token is now
    // stale it will skip its own finally, so clear the flag here.
    state.enterpriseLoading = false;
    // A downgraded/reconnected token without operator.read must not keep prior
    // governed run/tree data on screen under the error banner.
    state.enterpriseRuns = [];
    state.enterpriseTrees = [];
    state.enterpriseImportErrors = [];
    state.enterpriseStoreError = null;
    state.enterpriseSelectedExecutionId = null;
    state.enterpriseDetail = null;
    state.enterpriseRunTree = null;
    state.enterpriseDetailLoading = false;
    state.enterpriseSelectedTreeId = null;
    state.enterpriseTreeDetail = null;
    state.enterpriseTreeLoading = false;
    state.enterpriseTreeIssue = null;
    state.enterpriseTreeVersions = [];
    state.enterpriseTreeVersionsLoading = false;
    resetTreeEditing(state);
    state.enterpriseError = formatMissingOperatorReadScopeMessage("enterprise runs");
    return;
  }
  state.enterpriseError = String(err);
}

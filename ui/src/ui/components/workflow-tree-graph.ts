// Control UI component: the workflow tree drawn as a real node-link tree.
//
// Layout is a tidy top-down pass: leaves are packed left to right, each parent is
// centred over its children. That is deterministic and cannot overlap, which is
// what the previous indented-list rendering could not show at all — the parent →
// child edges of the governance hierarchy are the point, since a leaf inherits
// every ancestor's tool/knowledge scope.
import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";

export type WorkflowTreeOntology = {
  entities?: {
    id: string;
    title?: string;
    description?: string;
    properties?: { id: string; type: string; primaryKey?: boolean; required?: boolean }[];
  }[];
  relationships?: {
    id: string;
    from: string;
    to: string;
    cardinality?: string;
    inverse?: string;
    description?: string;
  }[];
  actions?: {
    id: string;
    title?: string;
    description?: string;
    tools?: string[];
    parameters?: { id: string; type: string; required?: boolean }[];
    preconditions?: string[];
    effects?: { entity: string; kind: string; description?: string }[];
  }[];
  constraints?: { id?: string; description: string }[];
  allowedTools?: string[];
  deniedTools?: string[];
  knowledgeFoundations?: string[];
  contextHints?: string[];
  expectedOutput?: string;
  audit?: boolean;
};

export type WorkflowTreeNode = {
  id: string;
  parentId: string | null;
  depth: number;
  title: string;
  description?: string;
  ontology: WorkflowTreeOntology;
};

type PlacedNode = WorkflowTreeNode & { x: number; y: number; isLeaf: boolean };

const NODE_WIDTH = 196;
const NODE_HEIGHT = 62;
const GAP_X = 28;
const GAP_Y = 56;
const PADDING = 16;
const TITLE_MAX = 22;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Tidy top-down layout. Exported for testing: leaf packing plus parent centring
 * is the whole contract, and it must stay overlap-free as trees grow.
 */
export function layoutWorkflowTree(nodes: WorkflowTreeNode[]): {
  placed: PlacedNode[];
  width: number;
  height: number;
} {
  const childrenOf = new Map<string, WorkflowTreeNode[]>();
  const roots: WorkflowTreeNode[] = [];
  for (const node of nodes) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const siblings = childrenOf.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenOf.set(node.parentId, [node]);
    }
  }

  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  let nextLeafSlot = 0;
  let maxDepth = 0;

  const place = (node: WorkflowTreeNode): PlacedNode => {
    // Reserve the slot BEFORE recursing into children. That makes the function
    // idempotent per id (a node reachable from two seeds is placed once) and it
    // terminates on a malformed cyclic definition instead of recursing forever.
    const existing = byId.get(node.id);
    if (existing) {
      return existing;
    }
    const entry: PlacedNode = {
      ...node,
      x: 0,
      y: node.depth * (NODE_HEIGHT + GAP_Y),
      isLeaf: false,
    };
    byId.set(node.id, entry);
    placed.push(entry);

    const children = childrenOf.get(node.id) ?? [];
    if (children.length === 0) {
      entry.isLeaf = true;
      entry.x = nextLeafSlot * (NODE_WIDTH + GAP_X);
      nextLeafSlot += 1;
    } else {
      const placedChildren = children.map(place);
      const first = placedChildren[0];
      const last = placedChildren[placedChildren.length - 1];
      entry.x = (first.x + last.x) / 2;
    }
    maxDepth = Math.max(maxDepth, node.depth);
    return entry;
  };

  // A tree whose root row is missing (a projection quirk) would otherwise render
  // nothing. Seed from the nodes nothing else can reach: no parent, or a parent
  // that is not in this node set.
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seeds =
    roots.length > 0
      ? roots
      : nodes.filter((node) => node.parentId === null || !nodeIds.has(node.parentId));
  for (const seed of seeds) {
    place(seed);
  }

  const width = Math.max(nextLeafSlot, 1) * (NODE_WIDTH + GAP_X) - GAP_X + PADDING * 2;
  const height = (maxDepth + 1) * (NODE_HEIGHT + GAP_Y) - GAP_Y + PADDING * 2;
  return { placed, width, height };
}

/** Scope badges carry a label, never colour alone: colour is a secondary cue. */
function scopeBadges(ontology: WorkflowTreeOntology): { text: string; tone: string }[] {
  const badges: { text: string; tone: string }[] = [];
  if (ontology.allowedTools?.length) {
    badges.push({ text: `allow ${ontology.allowedTools.length}`, tone: "var(--ok)" });
  }
  if (ontology.deniedTools?.length) {
    badges.push({ text: `deny ${ontology.deniedTools.length}`, tone: "var(--danger)" });
  }
  if (ontology.knowledgeFoundations?.length) {
    badges.push({ text: `kb ${ontology.knowledgeFoundations.length}`, tone: "var(--info)" });
  }
  if (ontology.audit) {
    badges.push({ text: "audit", tone: "var(--warn)" });
  }
  return badges;
}

export class OpenClawWorkflowTreeGraph extends LitElement {
  @property({ attribute: false }) nodes: WorkflowTreeNode[] = [];
  /**
   * Node ids the run actually planned. When set, the tree renders as the whole
   * tree with this route lit and everything else dimmed — the point is to show
   * WHAT WAS NOT TAKEN, which a plan-only view cannot show.
   */
  @property({ attribute: false }) routeNodeIds: string[] | null = null;

  /**
   * Which node is highlighted. Controllable: a parent that owns the selection
   * (the enterprise inspector) feeds its id back so a reload/remount restores the
   * highlight. Uncontrolled callers (read-only route views) let clicks drive it
   * via the optimistic update in {@link selectNode}.
   */
  @property({ attribute: false }) selected: string | null = null;

  static override styles = css`
    :host {
      display: block;
      /* The SVG is as wide as the tree (a 40-node tree is thousands of px). The
         chat bubble lays its children out with align-items: flex-start, which sizes
         them to their CONTENT — so without these the card would inflate to the full
         tree width and spill out of the bubble instead of scrolling inside it. */
      max-width: 100%;
      min-width: 0;
    }

    .tree-shell {
      margin-top: 8px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-accent, var(--card));
      /* Both axes: a full tree overflows horizontally (breadth) and vertically
         (depth). Capped against the viewport so the graph can never outgrow the
         screen — you scroll the tree, not the page. */
      overflow: auto;
      /* border-box so the cap bounds the WHOLE box: with the default content-box
         the padding and border would push the shell past the viewport budget. */
      box-sizing: border-box;
      max-height: min(60vh, 460px);
      /* Reaching the tree's edge must not start scrolling the chat thread behind it. */
      overscroll-behavior: contain;
    }

    svg {
      display: block;
    }

    .node-box {
      cursor: pointer;
    }

    .node-title {
      font-size: 12px;
      font-weight: 600;
      fill: var(--text-strong);
      pointer-events: none;
      user-select: none;
    }

    .node-id {
      font-size: 10px;
      fill: var(--muted);
      pointer-events: none;
      user-select: none;
    }

    .badge-text {
      font-size: 9px;
      pointer-events: none;
      user-select: none;
    }

    .inspector {
      margin-top: 10px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg-accent, var(--card));
    }

    .inspector-title {
      font-weight: 600;
      color: var(--text-strong);
    }

    .inspector-sub {
      margin-top: 2px;
      font-size: 12px;
      color: var(--muted);
    }

    .inspector-row {
      margin-top: 6px;
      font-size: 12px;
      color: var(--text);
    }

    .inspector-row .key {
      color: var(--muted);
    }

    .action {
      margin-top: 8px;
      padding: 7px 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
    }

    .action-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-strong);
    }

    .action-tools {
      padding: 0 6px;
      font-size: 10px;
      font-weight: 400;
      color: var(--muted);
      border: 1px solid var(--border-strong);
      border-radius: 4px;
    }

    .action-sub {
      margin-top: 3px;
      font-size: 11px;
      color: var(--muted);
    }

    /* The write scope is the governance-relevant part; it must not read as
       just another muted line. */
    .action-write {
      margin-top: 3px;
      font-size: 11px;
      color: var(--warn);
    }

    .hint {
      margin-top: 6px;
      font-size: 11px;
      color: var(--muted);
    }
  `;

  /** null means "no route filter": every node renders lit (the registry view). */
  private get routeSet(): Set<string> | null {
    return this.routeNodeIds ? new Set(this.routeNodeIds) : null;
  }

  /**
   * Toggle selection and tell the parent. The parent owns the id (it loads that
   * node's object instances), so we emit the new value; the optimistic local set
   * keeps uncontrolled callers highlighting without a round-trip. null clears.
   */
  private selectNode(nodeId: string): void {
    const next = this.selected === nodeId ? null : nodeId;
    this.selected = next;
    this.dispatchEvent(
      new CustomEvent<{ nodeId: string | null }>("node-select", {
        detail: { nodeId: next },
        bubbles: true,
        composed: true,
      }),
    );
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("nodes") && this.selected) {
      const stillThere = this.nodes.some((node) => node.id === this.selected);
      if (!stillThere) {
        // The selected node was pruned (a route change, a re-import). Clear and
        // tell the parent, or its instance panel would linger on a gone node.
        this.selected = null;
        this.dispatchEvent(
          new CustomEvent<{ nodeId: string | null }>("node-select", {
            detail: { nodeId: null },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }
  }

  override render() {
    if (this.nodes.length === 0) {
      return nothing;
    }
    const { placed, width, height } = layoutWorkflowTree(this.nodes);
    const byId = new Map(placed.map((node) => [node.id, node]));
    return html`
      <div class="tree-shell">
        <svg
          width=${width}
          height=${height}
          viewBox="0 0 ${width} ${height}"
          style="min-width: ${width}px;"
          role="tree"
          aria-label=${t("enterprise.structureTitle")}
        >
          <g transform="translate(${PADDING}, ${PADDING})">
            ${placed.map((node) => this.renderEdge(node, byId))}
            ${placed.map((node) => this.renderNode(node))}
          </g>
        </svg>
      </div>
      <div class="hint">${t("enterprise.selectStep")}</div>
      ${this.renderInspector()}
    `;
  }

  /** Parent bottom-centre → child top-centre, as a vertical cubic. */
  private renderEdge(
    node: PlacedNode,
    byId: Map<string, PlacedNode>,
  ): TemplateResult | typeof nothing {
    if (node.parentId === null) {
      return nothing;
    }
    const parent = byId.get(node.parentId);
    if (!parent) {
      return nothing;
    }
    const x1 = parent.x + NODE_WIDTH / 2;
    const y1 = parent.y + NODE_HEIGHT;
    const x2 = node.x + NODE_WIDTH / 2;
    const y2 = node.y;
    const midY = (y1 + y2) / 2;
    const onPath = this.selected === node.id || this.selected === parent.id;
    // An edge belongs to the route only when both endpoints do; a half-lit edge
    // would imply the run traversed into a branch it never planned.
    const onRoute =
      this.routeSet === null || (this.routeSet.has(node.id) && this.routeSet.has(parent.id));
    const stroke = onPath
      ? "var(--accent)"
      : onRoute && this.routeSet
        ? "var(--accent-2, var(--accent))"
        : "var(--border-hover)";
    return svg`
      <path
        d="M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}"
        fill="none"
        stroke=${stroke}
        stroke-width=${onPath || (onRoute && this.routeSet) ? 2 : 1.5}
        opacity=${onRoute ? 1 : 0.25}
      />
    `;
  }

  private renderNode(node: PlacedNode): TemplateResult {
    const selected = this.selected === node.id;
    const isRoot = node.parentId === null;
    const badges = scopeBadges(node.ontology);
    const onRoute = this.routeSet?.has(node.id) ?? true;
    return svg`
      <g
        class="node-box"
        opacity=${onRoute ? 1 : 0.28}
        role="treeitem"
        tabindex="0"
        aria-level=${node.depth + 1}
        aria-selected=${selected}
        aria-label=${node.description ? `${node.title}: ${node.description}` : node.title}
        @click=${() => {
          this.selectNode(node.id);
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.selectNode(node.id);
          }
        }}
      >
        <rect
          x=${node.x}
          y=${node.y}
          width=${NODE_WIDTH}
          height=${NODE_HEIGHT}
          rx="8"
          fill=${selected ? "var(--accent-subtle)" : "var(--bg-hover, var(--panel-strong))"}
          stroke=${selected ? "var(--accent)" : isRoot ? "var(--accent-2, var(--accent))" : "var(--border-strong)"}
          stroke-width=${selected || isRoot ? 2 : 1.5}
        >
          <title>${node.title}${node.description ? ` — ${node.description}` : ""}</title>
        </rect>
        <text class="node-title" x=${node.x + 12} y=${node.y + 21}>${truncate(node.title, TITLE_MAX)}</text>
        <text class="node-id" x=${node.x + 12} y=${node.y + 36}>${truncate(node.id, TITLE_MAX + 4)}</text>
        ${badges.map((badge, index) => {
          const badgeX = node.x + 12 + index * 52;
          return svg`
            <g>
              <rect
                x=${badgeX}
                y=${node.y + 43}
                width="46"
                height="13"
                rx="6"
                fill="none"
                stroke=${badge.tone}
                stroke-width="1"
              />
              <text
                class="badge-text"
                x=${badgeX + 23}
                y=${node.y + 52}
                text-anchor="middle"
                fill=${badge.tone}
              >${badge.text}</text>
            </g>
          `;
        })}
      </g>
    `;
  }

  private renderInspector(): TemplateResult | typeof nothing {
    const id = this.selected;
    if (!id) {
      return nothing;
    }
    const node = this.nodes.find((entry) => entry.id === id);
    if (!node) {
      return nothing;
    }
    const ontology = node.ontology;
    const rows: TemplateResult[] = [];
    const row = (text: string) => html`<div class="inspector-row">${text}</div>`;
    if (ontology.allowedTools?.length) {
      rows.push(row(t("enterprise.allowedTools", { tools: ontology.allowedTools.join(", ") })));
    }
    if (ontology.deniedTools?.length) {
      rows.push(row(t("enterprise.deniedTools", { tools: ontology.deniedTools.join(", ") })));
    }
    if (ontology.knowledgeFoundations?.length) {
      rows.push(row(t("enterprise.knowledge", { ids: ontology.knowledgeFoundations.join(", ") })));
    }
    // Actions get a block each, not a comma-joined id list: the parameters,
    // preconditions, and write effects ARE the action type, and an operator
    // reviewing a governed step needs to see what it is allowed to write.
    for (const action of ontology.actions ?? []) {
      const parameters = (action.parameters ?? [])
        .map((parameter) => `${parameter.id}: ${parameter.type}${parameter.required ? "*" : ""}`)
        .join(", ");
      const writes = (action.effects ?? [])
        .filter((effect) => effect.kind !== "read")
        .map((effect) => `${effect.kind} ${effect.entity}`)
        .join(", ");
      const reads = (action.effects ?? [])
        .filter((effect) => effect.kind === "read")
        .map((effect) => effect.entity)
        .join(", ");
      rows.push(html`
        <div class="action">
          <div class="action-title">
            ${action.title ?? action.id}
            ${action.tools?.length
              ? html`<span class="action-tools">${action.tools.join(", ")}</span>`
              : nothing}
          </div>
          ${action.description
            ? html`<div class="action-sub">${action.description}</div>`
            : nothing}
          ${parameters ? html`<div class="action-sub">params — ${parameters}</div>` : nothing}
          ${reads ? html`<div class="action-sub">reads — ${reads}</div>` : nothing}
          ${writes ? html`<div class="action-write">writes — ${writes}</div>` : nothing}
          ${(action.preconditions ?? []).map(
            (precondition) => html`<div class="action-sub">requires — ${precondition}</div>`,
          )}
        </div>
      `);
    }
    if (ontology.contextHints?.length) {
      rows.push(row(t("enterprise.contextHints", { hints: ontology.contextHints.join(" · ") })));
    }
    for (const constraint of ontology.constraints ?? []) {
      rows.push(row(t("enterprise.constraint", { text: constraint.description })));
    }
    if (ontology.expectedOutput) {
      rows.push(row(t("enterprise.expectedOutput", { text: ontology.expectedOutput })));
    }
    if (ontology.audit) {
      rows.push(row(t("enterprise.audit")));
    }
    return html`
      <div class="inspector">
        <div class="inspector-title">${node.title}</div>
        <div class="inspector-sub">${node.id}</div>
        ${node.description ? html`<div class="inspector-row">${node.description}</div>` : nothing}
        ${rows.length > 0
          ? rows
          : html`<div class="inspector-row">${t("enterprise.noStepScope")}</div>`}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-workflow-tree-graph")) {
  customElements.define("openclaw-workflow-tree-graph", OpenClawWorkflowTreeGraph);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workflow-tree-graph": OpenClawWorkflowTreeGraph;
  }
}

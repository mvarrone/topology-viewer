import cytoscape from "cytoscape";
import type { Core, EdgeSingular, LayoutOptions, NodeSingular, Position, StylesheetJson } from "cytoscape";
import fcose from "cytoscape-fcose";

import { shortIf } from "../lib/format";
import type { Theme } from "../lib/theme";
import type { Device, Link, Topology } from "../types";
import { glyphUri } from "./glyphs";

cytoscape.use(fcose);

export type LayoutName = "layered" | "organic" | "concentric" | "circle";
/** Legend categories that can be shown alone on the canvas. */
export type LegendFilter = "router" | "switch" | "unregistered" | "onesided" | "down";
export type Selection = { kind: "device"; device: Device } | { kind: "link"; link: Link } | null;

const LAYERS = ["edge", "core", "distribution", "access"];
const EDGE_PICK_PX = 14;
const FRESH_MS = 3500;
const PADDING = 70;
const NODE_GAP = 100;

const layerIndex = (d: Device): number => {
  const i = d.layer ? LAYERS.indexOf(d.layer) : -1;
  return i === -1 ? LAYERS.length : i;
};

/** Registered routers and switches that answer are filled with their color and get a white glyph. */
const filled = (d: Device): boolean => d.registered && d.role !== "unknown" && d.reachable !== false;

const ringColor = (d: Device, t: Theme): string => {
  if (!d.registered || d.role === "unknown") return t.unregistered;
  return d.role === "router" ? t.router : t.switch;
};

const nodeData = (d: Device) => ({ id: d.id, label: d.hostname, role: d.role, registered: d.registered, raw: d });

const edgeData = (l: Link) => ({
  id: l.id,
  source: l.source,
  target: l.target,
  status: l.status,
  confirmed: l.confirmed,
  srcIf: shortIf(l.source_if),
  dstIf: shortIf(l.target_if),
  cpd: 0, // curve offset, set by spreadParallel
  raw: l,
});

/** Distance between parallel links of the same two devices. */
const PARALLEL_STEP = 56;

function buildStyle(t: Theme): StylesheetJson {
  const raw = (e: NodeSingular) => e.data("raw") as Device;
  return [
    { selector: "core", style: { "active-bg-opacity": 0, "selection-box-opacity": 0.1 } },
    {
      selector: "node",
      style: {
        shape: "ellipse",
        width: 34,
        height: 34,
        "background-color": (e: NodeSingular) => (filled(raw(e)) ? ringColor(raw(e), t) : t.surface),
        "border-width": t.ring,
        "border-color": (e: NodeSingular) => ringColor(raw(e), t),
        "background-image": (e: NodeSingular) =>
          glyphUri(raw(e).role, filled(raw(e)) ? "#ffffff" : raw(e).reachable === false ? t.muted : ringColor(raw(e), t)),
        "background-width": "64%",
        "background-height": "64%",
        label: "data(label)",
        color: t.ink,
        "font-family": t.canvasFont,
        "font-weight": 400,
        "font-size": 11,
        "text-valign": "bottom",
        "text-margin-y": 5,
        "text-background-color": t.canvas,
        "text-background-opacity": 0.9,
        "text-background-padding": "2px",
        "text-background-shape": "roundrectangle",
        "overlay-opacity": 0,
        "transition-property": "opacity, border-width, border-color",
        "transition-duration": 0.16,
      },
    },
    { selector: 'node[role = "switch"]', style: { shape: "round-rectangle", width: 36, height: 31 } },
    { selector: "node[!registered]", style: { "border-style": "dashed", color: t.muted } },
    // Grayed out with a thin muted red dashed outline: visible, but not alarming.
    {
      selector: "node.unreachable",
      style: { "border-color": t.unreachable, "border-style": "dashed", "border-width": t.ring, "border-dash-pattern": [4, 3], color: t.muted },
    },
    // Thin ring at rest; a little thicker on hover and when selected.
    { selector: "node.hover", style: { "border-width": t.ring + 0.75 } },
    { selector: "node.fresh", style: { "border-color": t.select, "border-width": t.ring + 1.25 } },
    { selector: "node:selected", style: { "border-color": t.select, "border-width": t.ring + 1.25 } },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": t.edge,
        // Each link gets its own fixed offset (spreadParallel), so parallel links keep their
        // order when one of them is drawn again.
        "curve-style": "unbundled-bezier",
        "control-point-distances": "data(cpd)",
        "control-point-weights": 0.5,
        "font-family": t.canvasFont,
        "font-size": 9,
        color: t.muted,
        "source-text-offset": 30,
        "target-text-offset": 30,
        "text-background-color": t.canvas,
        "text-background-opacity": 1,
        "text-background-padding": "2px",
        "text-background-shape": "roundrectangle",
        "overlay-opacity": 0,
        "transition-property": "opacity, width, line-color",
        "transition-duration": 0.16,
      },
    },
    { selector: 'edge[status = "up"][!confirmed]', style: { "line-style": "dotted" } },
    {
      selector: 'edge[status = "down"]',
      style: { "line-color": t.down, "line-style": "dashed", "line-dash-pattern": [6, 4] },
    },
    // Neither end answered on the last poll: the state is old, so the link is drawn faint.
    { selector: "edge[?stale]", style: { "line-color": t.edge, "line-style": "dashed", "line-dash-pattern": [1.5, 2.5], width: 1.25, opacity: 0.7 } },
    { selector: "edge.ports, edge.focus", style: { "source-label": "data(srcIf)", "target-label": "data(dstIf)" } },
    {
      selector: "edge.hover",
      style: {
        width: 2.5,
        "line-color": (e: EdgeSingular) => (e.data("status") === "down" ? t.down : t.muted),
      },
    },
    { selector: "edge:selected", style: { width: 2.5, "line-color": t.select } },
    { selector: ".filtered-out", style: { opacity: 0.12, events: "no" } },
    { selector: ".faded", style: { opacity: 0, events: "no" } },
  ] as unknown as StylesheetJson;
}

function distToSegment(p: Position, a: Position, b: Position): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export class TopologyGraph {
  readonly cy: Core;
  private theme: Theme;
  private showPorts = true;
  private filter: LegendFilter | null = null;
  private layout: LayoutName = "layered";
  private saved: Record<string, Position> = {};

  constructor(
    container: HTMLElement,
    theme: Theme,
    private readonly onSelect: (selection: Selection) => void,
    private readonly onMove: (positions: Record<string, Position>) => void,
  ) {
    this.theme = theme;
    this.cy = cytoscape({
      container,
      style: buildStyle(theme),
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      boxSelectionEnabled: false,
    });
    this.bindEvents(container);
    // Red crosses at the end of a link whose interface is down, drawn over the canvas.
    this.marks = document.createElement("div");
    this.marks.className = "end-marks";
    this.marks.setAttribute("aria-hidden", "true");
    container.insertAdjacentElement("afterend", this.marks);
    this.cy.on("render", () => this.queueMarks());
  }

  private readonly marks: HTMLDivElement;
  private marksQueued = false;

  private queueMarks(): void {
    if (this.marksQueued) return;
    this.marksQueued = true;
    requestAnimationFrame(() => {
      this.marksQueued = false;
      this.drawMarks();
    });
  }

  /** Link ends whose interface is shut down or has no line protocol, in model coordinates:
   * a little inside the link from the device border. */
  private endMarks(): { x: number; y: number; why: string; state: "" | "hidden" | "dim" }[] {
    const marks: { x: number; y: number; why: string; state: "" | "hidden" | "dim" }[] = [];
    this.cy.edges().forEach((edge) => {
      const link = edge.data("raw") as Link;
      const ends: [string, string, "source" | "target"][] = [
        [link.source, link.source_if, "source"],
        [link.target, link.target_if, "target"],
      ];
      for (const [deviceId, ifName, side] of ends) {
        const device = this.cy.getElementById(deviceId).data("raw") as Device | undefined;
        const ifState = device?.interfaces?.find((i) => i.name === ifName);
        // A device that does not answer has an old state: no cross from it.
        if (device?.reachable === false) continue;
        if (!ifState || (ifState.admin !== "down" && ifState.oper !== "down")) continue;
        const end = side === "source" ? edge.sourceEndpoint() : edge.targetEndpoint();
        const mid = edge.midpoint();
        const dx = mid.x - end.x;
        const dy = mid.y - end.y;
        const len = Math.hypot(dx, dy) || 1;
        const step = 14; // model units from the node border along the link
        marks.push({
          x: end.x + (dx / len) * step,
          y: end.y + (dy / len) * step,
          why: ifState.admin === "down" ? "administratively down" : "operationally down",
          state: edge.hasClass("faded") ? "hidden" : edge.hasClass("filtered-out") ? "dim" : "",
        });
      }
    });
    return marks;
  }

  /** A cross next to each link end whose interface is down, so the side with the problem
   * is visible on the canvas. */
  private drawMarks(): void {
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    this.marks.innerHTML = this.endMarks()
      .map(
        (m) =>
          `<span class="end-mark ${m.state}" style="left:${m.x * zoom + pan.x}px;top:${m.y * zoom + pan.y}px" data-why="${m.why}">✕</span>`,
      )
      .join("");
  }

  // Data

  /** Bring the canvas in line with a topology without moving existing devices. */
  sync(topology: Topology, markFresh: boolean): void {
    const firstLoad = this.cy.nodes().empty();
    const nodeIds = new Set(topology.nodes.map((n) => n.id));
    const linkIds = new Set(topology.links.map((l) => l.id));
    const added: NodeSingular[] = [];

    // A registered device that comes back under another name (renamed) keeps its place:
    // remember where removed devices were, by management address.
    const goneAt = new Map<string, Position>();
    this.cy.nodes().forEach((n) => {
      const raw = n.data("raw") as Device;
      if (!nodeIds.has(n.id()) && raw.registered && raw.mgmt_ip) goneAt.set(raw.mgmt_ip, { ...n.position() });
    });
    const carried: Record<string, Position> = {};

    this.cy.batch(() => {
      this.cy.edges().filter((e) => !linkIds.has(e.id())).remove();
      this.cy.nodes().filter((n) => !nodeIds.has(n.id())).remove();

      for (const device of topology.nodes) {
        let node = this.cy.getElementById(device.id) as NodeSingular;
        if (node.nonempty()) {
          node.data(nodeData(device));
        } else {
          node = this.cy.add({ group: "nodes", data: nodeData(device) }) as unknown as NodeSingular;
          const was = device.mgmt_ip ? goneAt.get(device.mgmt_ip) : undefined;
          if (was) carried[device.id] = was;
          added.push(node);
        }
        node.toggleClass("unreachable", device.reachable === false);
      }
      const answering = new Set(
        topology.nodes.filter((d) => d.registered && d.reachable !== false).map((d) => d.id),
      );
      for (const link of topology.links) {
        const edge = this.cy.getElementById(link.id);
        const data = { ...edgeData(link), stale: !answering.has(link.source) && !answering.has(link.target) };
        if (edge.nonempty()) edge.data(data);
        else this.cy.add({ group: "edges", data, classes: this.showPorts ? "ports" : "" });
      }
    });

    this.spreadParallel();
    this.applyFilter(false); // keep the legend filter across updates

    if (Object.keys(carried).length) {
      this.saved = { ...this.saved, ...carried };
      this.onMove(carried); // stored under the new name
    }

    if (firstLoad) {
      if (added.some((n) => this.saved[n.id()])) {
        this.placeNewNodes(added, false);
        this.cy.fit(undefined, PADDING);
      } else {
        this.runLayout(this.layout);
      }
      return;
    }
    this.placeNewNodes(added, markFresh);
  }

  /** Show only one legend category: devices of a role, unregistered devices, one-sided or down
   * links (with their devices). Everything else is dimmed. null shows everything again.
   * Returns how many devices or links match. */
  setFilter(filter: LegendFilter | null): number {
    this.filter = filter;
    return this.applyFilter(true);
  }

  get activeFilter(): LegendFilter | null {
    return this.filter;
  }

  private applyFilter(fit: boolean): number {
    const cy = this.cy;
    cy.elements().removeClass("filtered-out");
    if (!this.filter) return 0;
    const raw = (n: NodeSingular) => n.data("raw") as Device;
    let keep;
    let count: number;
    if (this.filter === "onesided" || this.filter === "down") {
      const wanted = this.filter;
      const edges = cy.edges().filter((e) =>
        wanted === "down" ? e.data("status") === "down" : e.data("status") === "up" && !e.data("confirmed"),
      );
      keep = edges.union(edges.connectedNodes());
      count = edges.length;
    } else {
      const wanted = this.filter;
      const nodes = cy.nodes().filter((n) =>
        wanted === "unregistered" ? !raw(n).registered : raw(n).role === wanted,
      );
      keep = nodes.union(nodes.edgesWith(nodes));
      count = nodes.length;
    }
    cy.elements().not(keep).addClass("filtered-out");
    if (fit && count) {
      cy.animate({ fit: { eles: keep, padding: PADDING } }, { duration: 350, easing: "ease-in-out-cubic" });
    }
    return count;
  }

  /** Parallel links between the same two devices, sorted by id, get evenly spaced curves.
   * Sources are always the same end of a pair (the backend sorts them), so offsets agree. */
  private spreadParallel(): void {
    const pairs = new Map<string, EdgeSingular[]>();
    this.cy.edges().forEach((e) => {
      const key = [e.data("source"), e.data("target")].sort().join("|");
      pairs.set(key, [...(pairs.get(key) ?? []), e]);
    });
    for (const edges of pairs.values()) {
      edges.sort((a, b) => a.id().localeCompare(b.id()));
      edges.forEach((e, i) => {
        // Same direction for every link of the pair, whichever end Cytoscape calls the source.
        const flip = e.data("source") > e.data("target") ? -1 : 1;
        e.data("cpd", flip * (i - (edges.length - 1) / 2) * PARALLEL_STEP);
      });
    }
  }

  /** Saved positions from the backend, used for devices when they appear on the canvas. */
  setSavedPositions(positions: Record<string, Position>): void {
    this.saved = positions;
  }

  /** Devices with a saved position go there; the rest go next to a placed neighbor. */
  private placeNewNodes(added: NodeSingular[], markFresh: boolean): void {
    const pending = new Set<string>();
    for (const node of added) {
      const saved = this.saved[node.id()];
      if (saved) node.position(saved);
      else pending.add(node.id());
    }
    const placed = pending.size > 0;
    const extent = this.cy.extent();
    for (const node of added) {
      if (pending.has(node.id())) {
        const anchor = node.neighborhood("node").filter((n) => !pending.has(n.id()))[0] as NodeSingular | undefined;
        const base = anchor ? anchor.position() : { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
        node.position(this.freeSpot(base, pending));
        pending.delete(node.id());
      }
      if (markFresh) {
        node.addClass("fresh");
        setTimeout(() => node.removeClass("fresh"), FRESH_MS);
      }
    }
    if (placed) this.emitPositions();
  }

  /** Closest point to base that is at least NODE_GAP away from every placed device, trying below first. */
  private freeSpot(base: Position, unplaced: Set<string>): Position {
    const taken = this.cy
      .nodes()
      .filter((n) => !unplaced.has(n.id()))
      .map((n) => (n as NodeSingular).position());
    const free = (p: Position) => taken.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= NODE_GAP);
    for (let ring = 1; ring <= 12; ring++) {
      const radius = ring * NODE_GAP * 1.3;
      const steps = ring * 8;
      for (let i = 0; i < steps; i++) {
        const side = i % 2 ? 1 : -1;
        const angle = Math.PI / 2 + side * Math.ceil(i / 2) * ((2 * Math.PI) / steps);
        const p = { x: base.x + radius * Math.cos(angle), y: base.y + radius * Math.sin(angle) };
        if (free(p)) return p;
      }
    }
    return { x: base.x, y: base.y + 14 * NODE_GAP };
  }

  private emitPositions(): void {
    const positions: Record<string, Position> = {};
    this.cy.nodes().forEach((n) => {
      const { x, y } = n.position();
      positions[n.id()] = { x: Math.round(x), y: Math.round(y) };
    });
    this.saved = { ...this.saved, ...positions };
    this.onMove(positions);
  }

  linksOf(deviceId: string): Link[] {
    return this.cy
      .getElementById(deviceId)
      .connectedEdges()
      .map((e) => e.data("raw") as Link);
  }

  has(id: string): boolean {
    return this.cy.getElementById(id).nonempty();
  }

  findDevice(query: string): string | null {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const devices = this.cy.nodes().map((n) => n.data("raw") as Device);
    const hit =
      devices.find((d) => d.hostname.toLowerCase() === q || d.mgmt_ip === q) ??
      devices.find((d) => d.hostname.toLowerCase().startsWith(q));
    return hit?.id ?? null;
  }

  // View

  /**
   * Row of each device: its layer when any device has one, otherwise the hop
   * distance from the device with most links (ties by id). Devices not reached
   * go one row below the deepest.
   */
  private layerRows(): Map<string, number> {
    const nodes = this.cy.nodes();
    const rows = new Map<string, number>();
    if (nodes.some((n) => Boolean((n.data("raw") as Device).layer))) {
      nodes.forEach((n) => {
        rows.set(n.id(), layerIndex(n.data("raw") as Device));
      });
      return rows;
    }
    const root = nodes
      .toArray()
      .sort((a, b) => b.connectedEdges().length - a.connectedEdges().length || a.id().localeCompare(b.id()))[0];
    if (!root) return rows;
    rows.set(root.id(), 0);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      const next = rows.get(current.id())! + 1;
      current.neighborhood("node").forEach((n) => {
        if (rows.has(n.id())) return;
        rows.set(n.id(), next);
        queue.push(n);
      });
    }
    const unreached = Math.max(...rows.values()) + 1;
    nodes.forEach((n) => {
      if (!rows.has(n.id())) rows.set(n.id(), unreached);
    });
    return rows;
  }

  runLayout(name: LayoutName): void {
    this.layout = name;
    const options: Record<LayoutName, () => LayoutOptions> = {
      layered: () => {
        const layerRows = this.layerRows();
        const rows = new Map<number, NodeSingular[]>();
        this.cy.nodes().forEach((n) => {
          const row = layerRows.get(n.id())!;
          rows.set(row, [...(rows.get(row) ?? []), n]);
        });
        const positions: Record<string, Position> = {};
        [...rows.keys()].sort((a, b) => a - b).forEach((row, rowIdx) => {
          const group = rows.get(row)!.sort((a, b) => a.id().localeCompare(b.id()));
          group.forEach((n, i) => {
            positions[n.id()] = { x: (i - (group.length - 1) / 2) * 150, y: rowIdx * 140 };
          });
        });
        return { name: "preset", positions: (n: NodeSingular) => positions[n.id()], animate: true,
          animationDuration: 450, fit: true, padding: PADDING } as LayoutOptions;
      },
      organic: () =>
        ({ name: "fcose", animate: true, animationDuration: 600, nodeRepulsion: 9000, idealEdgeLength: 130,
          padding: PADDING }) as LayoutOptions,
      concentric: () => {
        const layerRows = this.layerRows();
        return { name: "concentric", concentric: (n: NodeSingular) => 100 - layerRows.get(n.id())!,
          levelWidth: () => 1, minNodeSpacing: 70, animate: true, padding: PADDING } as LayoutOptions;
      },
      circle: () => ({ name: "circle", animate: true, animationDuration: 450, padding: PADDING }) as LayoutOptions,
    };
    if (this.cy.nodes().empty()) return;
    const layout = this.cy.layout(options[name]());
    layout.one("layoutstop", () => this.emitPositions());
    layout.run();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.cy.style(buildStyle(theme));
  }

  get currentTheme(): Theme {
    return this.theme;
  }

  setPorts(on: boolean): void {
    this.showPorts = on;
    this.cy.edges().toggleClass("ports", on);
  }

  highlightLink(id: string, on: boolean): void {
    this.cy.getElementById(id).toggleClass("hover", on).toggleClass("focus", on);
  }

  fit(): void {
    this.cy.animate({ fit: { eles: this.cy.elements(), padding: PADDING } }, { duration: 350 });
  }

  zoomBy(factor: number): void {
    const center = { x: this.cy.width() / 2, y: this.cy.height() / 2 };
    this.cy.animate({ zoom: { level: this.cy.zoom() * factor, renderedPosition: center } }, { duration: 180 });
  }

  /** PNG of the whole graph, with the crosses of down interfaces drawn in, as a data URL. */
  async exportPng(): Promise<string> {
    const base = this.cy.png({ full: true, scale: 2, bg: this.theme.canvas });
    const marks = this.endMarks().filter((m) => m.state !== "hidden");
    if (!marks.length) return base;
    const img = new Image();
    img.src = base;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    // Cytoscape draws the full image from the bounding box corner, at scale x pixel ratio.
    const bb = this.cy.elements().boundingBox();
    const scale = img.width / Math.ceil(bb.w);
    for (const m of marks) {
      const x = (m.x - bb.x1) * scale;
      const y = (m.y - bb.y1) * scale;
      const r = 9 * scale;
      ctx.globalAlpha = m.state === "dim" ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.canvas;
      ctx.fill();
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = this.theme.down;
      ctx.stroke();
      const a = r * 0.42;
      ctx.lineWidth = 2 * scale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x - a, y - a);
      ctx.lineTo(x + a, y + a);
      ctx.moveTo(x + a, y - a);
      ctx.lineTo(x - a, y + a);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return canvas.toDataURL("image/png");
  }

  // Selection

  select(id: string | null, zoom?: number): void {
    this.cy.elements().unselect();
    if (!id || !this.has(id)) {
      this.onSelect(null);
      return;
    }
    const ele = this.cy.getElementById(id);
    ele.select();
    this.emitSelection(ele);
    this.cy.animate(
      { center: { eles: ele }, zoom: zoom ?? Math.max(this.cy.zoom(), 1.1) },
      { duration: 350, easing: "ease-in-out-cubic" },
    );
  }

  private emitSelection(ele: NodeSingular | EdgeSingular): void {
    if (ele.isNode()) this.onSelect({ kind: "device", device: ele.data("raw") as Device });
    else this.onSelect({ kind: "link", link: ele.data("raw") as Link });
  }

  private nearestEdge(p: Position): EdgeSingular | null {
    let best: EdgeSingular | null = null;
    let bestDistance = EDGE_PICK_PX;
    this.cy.edges().forEach((edge) => {
      if (edge.hasClass("faded")) return;
      const s = edge.source().renderedPosition();
      const t = edge.target().renderedPosition();
      const m = edge.renderedMidpoint();
      const d = Math.min(distToSegment(p, s, m), distToSegment(p, m, t));
      if (d < bestDistance) {
        bestDistance = d;
        best = edge;
      }
    });
    return best;
  }

  // Events

  private bindEvents(container: HTMLElement): void {
    const cy = this.cy;
    cy.on("mouseover", "node", (e) => {
      const keep = e.target.closedNeighborhood();
      cy.elements().not(keep).addClass("faded");
      keep.edges().addClass("focus");
      e.target.addClass("hover");
      container.style.cursor = "pointer";
    });
    cy.on("mouseout", "node", () => {
      cy.elements().removeClass("faded focus hover");
      container.style.cursor = "";
    });
    cy.on("mouseover", "edge", (e) => {
      e.target.addClass("hover focus");
      e.target.connectedNodes().addClass("hover");
      container.style.cursor = "pointer";
    });
    cy.on("mouseout", "edge", (e) => {
      e.target.removeClass("hover focus");
      e.target.connectedNodes().removeClass("hover");
      container.style.cursor = "";
    });

    cy.on("tap", "node, edge", (e) => this.emitSelection(e.target));
    cy.on("tap", (e) => {
      if (e.target !== cy) return;
      const edge = this.nearestEdge(e.renderedPosition);
      if (!edge) {
        this.onSelect(null);
        return;
      }
      // Background taps unselect everything after this handler, so select on the next tick.
      setTimeout(() => {
        cy.elements().unselect();
        edge.select();
        this.emitSelection(edge);
      }, 0);
    });
    cy.on("dbltap", "node", (e) => this.select(e.target.id(), 1.4));
    cy.on("dragfree", "node", () => this.emitPositions());
  }
}

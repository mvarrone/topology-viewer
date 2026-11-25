import type { Device } from "../types";
import type { TopologyGraph } from "./graph";

interface View {
  scale: number;
  ox: number;
  oy: number;
}

/** Overview of the whole topology with the visible area; click or drag to move the view. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private view: View | null = null;
  private queued = false;
  private dragging = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly graph: TopologyGraph,
  ) {
    this.ctx = canvas.getContext("2d")!;
    graph.cy.on("render viewport add remove position select unselect", () => this.queue());
    window.addEventListener("resize", () => this.queue());
    canvas.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.panTo(e);
    });
    canvas.addEventListener("pointermove", (e) => this.dragging && this.panTo(e));
    canvas.addEventListener("pointerup", () => (this.dragging = false));
  }

  queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.queued = false;
    const { cy, currentTheme: theme } = this.graph;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (cy.nodes().empty()) return;

    const bb = cy.nodes().boundingBox({ includeLabels: false });
    const pad = 60;
    const gw = bb.w + pad * 2;
    const gh = bb.h + pad * 2;
    const scale = Math.min((w - 16) / gw, (h - 16) / gh);
    const ox = (w - gw * scale) / 2 - (bb.x1 - pad) * scale;
    const oy = (h - gh * scale) / 2 - (bb.y1 - pad) * scale;
    this.view = { scale, ox, oy };
    const map = (p: { x: number; y: number }): [number, number] => [p.x * scale + ox, p.y * scale + oy];

    ctx.lineWidth = 1;
    cy.edges().forEach((edge) => {
      ctx.strokeStyle = edge.data("status") === "down" ? theme.down : theme.edge;
      ctx.beginPath();
      ctx.moveTo(...map(edge.source().position()));
      // Same curve as on the canvas, so parallel links show as separate lines here too.
      const control = edge.controlPoints()?.[0];
      if (control) ctx.quadraticCurveTo(...map(control), ...map(edge.target().position()));
      else ctx.lineTo(...map(edge.target().position()));
      ctx.stroke();
    });
    cy.nodes().forEach((node) => {
      const d = node.data("raw") as Device;
      const [x, y] = map(node.position());
      ctx.fillStyle = node.selected()
        ? theme.select
        : !d.registered || d.role === "unknown"
          ? theme.unregistered
          : d.role === "router"
            ? theme.router
            : theme.switch;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    const ext = cy.extent();
    const [x1, y1] = map({ x: ext.x1, y: ext.y1 });
    const [x2, y2] = map({ x: ext.x2, y: ext.y2 });
    ctx.save();
    ctx.beginPath();
    ctx.rect(1, 1, w - 2, h - 2);
    ctx.clip();
    // Visible area: a thin neutral frame, no fill.
    ctx.strokeStyle = theme.muted;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private panTo(e: PointerEvent): void {
    if (!this.view) return;
    const { cy } = this.graph;
    const r = this.canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left - this.view.ox) / this.view.scale;
    const my = (e.clientY - r.top - this.view.oy) / this.view.scale;
    const z = cy.zoom();
    cy.pan({ x: cy.width() / 2 - mx * z, y: cy.height() / 2 - my * z });
  }
}

/** Keep the dot grid of the stage aligned with pan and zoom. */
export function syncGrid(stage: HTMLElement, graph: TopologyGraph): void {
  const update = () => {
    const z = graph.cy.zoom();
    const size = 24 * (z < 0.6 ? z * 2 : z);
    const p = graph.cy.pan();
    stage.style.backgroundSize = `${size}px ${size}px`;
    stage.style.backgroundPosition = `${p.x}px ${p.y}px`;
  };
  graph.cy.on("viewport", update);
  update();
}

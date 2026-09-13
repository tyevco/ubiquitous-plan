import type { Passage, Placement, Point, Polygon } from "../types";
import type { Store, Selection } from "../state";
import { accessZones, doorSwing, floorAnchors } from "../engine/analysis";
import { bounds, fmtFtIn, footprint, pointInPolygon, snapTo, type Rect } from "../engine/geometry";
import { idx, passageRect } from "../engine/grid";

/** Bundled drawings that a floor's overlay can reference by name. */
const OVERLAY_IMAGES: Record<string, string> = {
  "plan.png": new URL("../../docs/plan/plan.png", import.meta.url).href,
};

const KIND_COLORS: Record<string, string> = {
  bed: "#c7d7f5",
  nightstand: "#dbe6f7",
  dresser: "#e9d7c0",
  chest: "#e3cba9",
  shelf: "#d9e8d0",
  table: "#f3e4b8",
  cabinet: "#dccbb0",
  sofa: "#d8cfe8",
  desk: "#cfe3e8",
  piano: "#2f2f2f",
  other: "#e2e2e2",
};

type DragState =
  | { kind: "pan"; startX: number; startY: number; tx: number; ty: number }
  | { kind: "placement"; id: string; offX: number; offY: number; moved: boolean }
  | { kind: "vertex"; owner: "room" | "fixture"; id: string; index: number }
  | { kind: "body"; owner: "room" | "fixture"; id: string; last: Point }
  | { kind: "passage-end"; id: string; end: "a" | "b" }
  | { kind: "passage"; id: string; last: Point }
  | { kind: "landing"; id: string; end: "A" | "B" }
  | { kind: "window-end"; id: string; end: "a" | "b" }
  | { kind: "window"; id: string; last: Point };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pts = (poly: Polygon): string => poly.map((p) => `${p.x},${p.y}`).join(" ");
const r4 = (v: number): number => Math.round(v * 4) / 4;

export class PlanCanvas {
  private svg: SVGSVGElement;
  private drag: DragState | null = null;
  private mouse: Point | null = null;
  private overlayCache: { key: string; url: string } | null = null;

  constructor(
    private host: HTMLElement,
    private store: Store,
  ) {
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.classList.add("plan");
    host.appendChild(this.svg);
    this.bind();
    new ResizeObserver(() => this.render()).observe(host);
  }

  /** Fit the active floor in the viewport. */
  fit(): void {
    const f = this.store.floor;
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    const scale = Math.min((w - 40) / f.width, (h - 40) / f.height);
    this.store.views.set(f.id, { scale, tx: (w - f.width * scale) / 2, ty: (h - f.height * scale) / 2 });
    this.store.touch();
  }

  private view() {
    const f = this.store.floor;
    let v = this.store.views.get(f.id);
    if (!v) {
      const w = this.host.clientWidth || 800,
        h = this.host.clientHeight || 600;
      const scale = Math.min((w - 40) / f.width, (h - 40) / f.height);
      v = { scale, tx: (w - f.width * scale) / 2, ty: (h - f.height * scale) / 2 };
      this.store.views.set(f.id, v);
    }
    return v;
  }

  private toPlan(e: { clientX: number; clientY: number }): Point {
    const r = this.svg.getBoundingClientRect();
    const v = this.view();
    return { x: (e.clientX - r.left - v.tx) / v.scale, y: (e.clientY - r.top - v.ty) / v.scale };
  }

  private bind(): void {
    const s = this.store;
    this.svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const v = this.view();
      const r = this.svg.getBoundingClientRect();
      const mx = e.clientX - r.left,
        my = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(20, Math.max(0.3, v.scale * factor));
      v.tx = mx - ((mx - v.tx) * scale) / v.scale;
      v.ty = my - ((my - v.ty) * scale) / v.scale;
      v.scale = scale;
      s.touch();
    }, { passive: false });

    this.svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const target = (e.target as Element).closest<SVGElement>("[data-kind]");
      const p = this.toPlan(e);
      const v = this.view();
      this.svg.setPointerCapture(e.pointerId);
      if (s.placing && e.button === 0) {
        this.placeAt(p);
        return;
      }
      const kind = target?.dataset.kind;
      if (e.button === 1 || !kind || (s.mode === "layout" && kind !== "placement" && kind !== "rotate")) {
        this.drag = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: v.tx, ty: v.ty };
        if (kind !== "placement" && kind !== "rotate" && s.mode === "layout" && e.button === 0) {
          s.selection = null;
          s.touch();
        }
        return;
      }
      const id = target!.dataset.id!;
      if (kind === "rotate") {
        this.rotate(id);
        return;
      }
      if (kind === "placement") {
        const pl = s.placement(id)!;
        s.selection = { type: "placement", id };
        s.beginDrag();
        this.drag = { kind: "placement", id, offX: p.x - pl.x, offY: p.y - pl.y, moved: false };
        s.touch();
        return;
      }
      // Edit mode handles.
      if (kind === "vertex") {
        const owner = target!.dataset.owner as "room" | "fixture";
        s.selection = { type: owner, id };
        s.beginDrag();
        this.drag = { kind: "vertex", owner, id, index: Number(target!.dataset.index) };
      } else if (kind === "room" || kind === "fixture") {
        s.selection = { type: kind, id };
        s.beginDrag();
        this.drag = { kind: "body", owner: kind, id, last: p };
      } else if (kind === "passage-end") {
        s.selection = { type: "passage", id };
        s.beginDrag();
        this.drag = { kind: "passage-end", id, end: target!.dataset.end as "a" | "b" };
      } else if (kind === "passage") {
        s.selection = { type: "passage", id };
        s.beginDrag();
        this.drag = { kind: "passage", id, last: p };
      } else if (kind === "landing") {
        s.selection = { type: "passage", id };
        s.beginDrag();
        this.drag = { kind: "landing", id, end: target!.dataset.end as "A" | "B" };
      } else if (kind === "window-end") {
        s.selection = { type: "window", id };
        s.beginDrag();
        this.drag = { kind: "window-end", id, end: target!.dataset.end as "a" | "b" };
      } else if (kind === "window") {
        s.selection = { type: "window", id };
        s.beginDrag();
        this.drag = { kind: "window", id, last: p };
      } else {
        this.drag = { kind: "pan", startX: e.clientX, startY: e.clientY, tx: v.tx, ty: v.ty };
        return;
      }
      s.touch();
    });

    this.svg.addEventListener("pointermove", (e) => {
      const p = this.toPlan(e);
      this.mouse = p;
      const d = this.drag;
      if (!d) {
        if (s.placing) this.render();
        return;
      }
      const snap = s.project.settings.snap || 1;
      const v = this.view();
      switch (d.kind) {
        case "pan":
          v.tx = d.tx + (e.clientX - d.startX);
          v.ty = d.ty + (e.clientY - d.startY);
          s.touch();
          break;
        case "placement": {
          const pl = s.placement(d.id);
          if (!pl) return;
          const item = s.item(pl.itemId)!;
          let nx = snapTo(p.x - d.offX, snap),
            ny = snapTo(p.y - d.offY, snap);
          const fp = footprint(pl, item);
          [nx, ny] = this.magnet(nx, ny, fp.w, fp.h, pl.id);
          d.moved = true;
          s.updateTransient(() => {
            pl.x = nx;
            pl.y = ny;
          });
          break;
        }
        case "vertex": {
          const poly = this.polygonOf(d.owner, d.id);
          if (!poly) return;
          const nx = snapTo(p.x, snap),
            ny = snapTo(p.y, snap);
          s.updateTransient(() => moveVertex(poly, d.index, nx, ny));
          break;
        }
        case "body": {
          const poly = this.polygonOf(d.owner, d.id);
          if (!poly) return;
          const dx = snapTo(p.x - d.last.x, snap),
            dy = snapTo(p.y - d.last.y, snap);
          if (!dx && !dy) return;
          d.last = { x: d.last.x + dx, y: d.last.y + dy };
          s.updateTransient(() => {
            for (const q of poly) {
              q.x += dx;
              q.y += dy;
            }
          });
          break;
        }
        case "passage-end": {
          const pass = s.floor.passages.find((x) => x.id === d.id);
          if (!pass) return;
          const nx = snapTo(p.x, snap),
            ny = snapTo(p.y, snap);
          s.updateTransient(() => {
            pass[d.end] = { x: nx, y: ny };
            pass.width = r4(Math.hypot(pass.b.x - pass.a.x, pass.b.y - pass.a.y));
          });
          break;
        }
        case "passage": {
          const pass = s.floor.passages.find((x) => x.id === d.id);
          if (!pass) return;
          const dx = snapTo(p.x - d.last.x, snap),
            dy = snapTo(p.y - d.last.y, snap);
          if (!dx && !dy) return;
          d.last = { x: d.last.x + dx, y: d.last.y + dy };
          s.updateTransient(() => {
            pass.a = { x: pass.a.x + dx, y: pass.a.y + dy };
            pass.b = { x: pass.b.x + dx, y: pass.b.y + dy };
          });
          break;
        }
        case "window-end": {
          const w = s.floor.windows.find((x) => x.id === d.id);
          if (!w) return;
          const nx = snapTo(p.x, snap),
            ny = snapTo(p.y, snap);
          s.updateTransient(() => {
            w[d.end] = { x: nx, y: ny };
          });
          break;
        }
        case "window": {
          const w = s.floor.windows.find((x) => x.id === d.id);
          if (!w) return;
          const dx = snapTo(p.x - d.last.x, snap),
            dy = snapTo(p.y - d.last.y, snap);
          if (!dx && !dy) return;
          d.last = { x: d.last.x + dx, y: d.last.y + dy };
          s.updateTransient(() => {
            w.a = { x: w.a.x + dx, y: w.a.y + dy };
            w.b = { x: w.b.x + dx, y: w.b.y + dy };
          });
          break;
        }
        case "landing": {
          const pass = s.project.floors.flatMap((f) => f.passages).find((x) => x.id === d.id);
          if (!pass?.stair) return;
          const nx = snapTo(p.x, snap),
            ny = snapTo(p.y, snap);
          s.updateTransient(() => {
            pass.stair![d.end === "A" ? "landingA" : "landingB"] = { x: nx, y: ny };
          });
          break;
        }
      }
    });

    const finish = (): void => {
      const d = this.drag;
      this.drag = null;
      if (!d || d.kind === "pan") return;
      s.endDrag();
    };
    this.svg.addEventListener("pointerup", finish);
    this.svg.addEventListener("pointercancel", finish);
    this.svg.addEventListener("pointerleave", () => {
      this.mouse = null;
      if (s.placing) this.render();
    });
    this.svg.addEventListener("dblclick", (e) => {
      const target = (e.target as Element).closest<SVGElement>("[data-kind]");
      if (target?.dataset.kind === "placement") this.rotate(target.dataset.id!);
    });
  }

  private polygonOf(owner: "room" | "fixture", id: string): Polygon | undefined {
    const f = this.store.floor;
    return owner === "room" ? f.rooms.find((r) => r.id === id)?.polygon : f.fixtures.find((r) => r.id === id)?.polygon;
  }

  /** Snap footprint edges to nearby room, fixture, and furniture edges. */
  private magnet(x: number, y: number, w: number, h: number, selfId: string): [number, number] {
    const f = this.store.floor;
    const tol = 3;
    const xs: number[] = [],
      ys: number[] = [];
    for (const r of f.rooms) for (const p of r.polygon) (xs.push(p.x), ys.push(p.y));
    for (const r of f.fixtures) for (const p of r.polygon) (xs.push(p.x), ys.push(p.y));
    for (const p of this.store.project.placements) {
      if (p.id === selfId || p.floorId !== f.id) continue;
      const item = this.store.item(p.itemId);
      if (!item) continue;
      const fp = footprint(p, item);
      xs.push(fp.x, fp.x + fp.w);
      ys.push(fp.y, fp.y + fp.h);
    }
    let bx = x,
      bestX = tol + 0.001;
    for (const e of xs) {
      for (const cand of [e, e - w]) {
        const d = Math.abs(cand - x);
        if (d < bestX) (bestX = d), (bx = cand);
      }
    }
    let by = y,
      bestY = tol + 0.001;
    for (const e of ys) {
      for (const cand of [e, e - h]) {
        const d = Math.abs(cand - y);
        if (d < bestY) (bestY = d), (by = cand);
      }
    }
    return [bx, by];
  }

  rotate(id: string): void {
    const s = this.store;
    s.update((p) => {
      const pl = p.placements.find((x) => x.id === id);
      if (!pl) return;
      const item = p.furniture.find((f) => f.id === pl.itemId)!;
      // Rotate about the footprint centre so the piece stays where it is.
      const before = footprint(pl, item);
      const cx = before.x + before.w / 2,
        cy = before.y + before.h / 2;
      pl.rotation = ((pl.rotation + 90) % 360) as Placement["rotation"];
      const after = footprint(pl, item);
      pl.x = snapTo(cx - after.w / 2, p.settings.snap || 1);
      pl.y = snapTo(cy - after.h / 2, p.settings.snap || 1);
    });
  }

  private placeAt(p: Point): void {
    const s = this.store;
    const placing = s.placing;
    if (!placing) return;
    const item = s.item(placing.itemId);
    if (!item) return;
    const snap = s.project.settings.snap || 1;
    const across = placing.rotation % 180 === 0;
    const w = across ? item.w : item.d,
      h = across ? item.d : item.w;
    const id = `pl-${Math.random().toString(36).slice(2, 8)}`;
    s.update((proj) => {
      proj.placements.push({ id, itemId: item.id, floorId: s.floor.id, x: snapTo(p.x - w / 2, snap), y: snapTo(p.y - h / 2, snap), rotation: placing.rotation });
    });
    const placed = s.project.placements.filter((x) => x.itemId === item.id).length;
    s.placing = placed < item.quantity ? placing : null;
    s.selection = { type: "placement", id };
    s.touch();
  }

  // ---------------------------------------------------------------- render

  render(): void {
    const s = this.store;
    const f = s.floor;
    const v = this.view();
    const sel = s.selection;
    const analysis = s.analysis;
    const fa = analysis.floors.get(f.id);
    const hairline = `vector-effect="non-scaling-stroke"`;
    const fs = (px: number): number => px / v.scale;

    const parts: string[] = [];

    // Grid (1 ft).
    if (s.showGrid) {
      const g: string[] = [];
      for (let x = 0; x <= f.width; x += 12) g.push(`M${x},0V${f.height}`);
      for (let y = 0; y <= f.height; y += 12) g.push(`M0,${y}H${f.width}`);
      parts.push(`<path class="grid" d="${g.join("")}" ${hairline}/>`);
    }

    // The builder's drawing under the trace, clipped to the floor.
    if (s.showPlan && f.overlay && OVERLAY_IMAGES[f.overlay.image]) {
      const o = f.overlay;
      parts.push(
        `<clipPath id="floor-clip"><rect x="0" y="0" width="${f.width}" height="${f.height}"/></clipPath>` +
          `<image class="plan-overlay" href="${OVERLAY_IMAGES[o.image]}" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" preserveAspectRatio="none" opacity="${o.opacity ?? 0.55}" clip-path="url(#floor-clip)"/>`,
      );
    }

    // Everything traced from the plan goes in one group so it can be faded to show the drawing beneath.
    parts.push(`<g class="trace" opacity="${s.traceOpacity}">`);
    // Walls: stroke each room polygon 9" wide under the floor fills, so the gaps between rooms
    // read as walls at their traced thickness and exterior walls read about 4.5".
    const drawn = f.rooms.filter((r) => !r.virtual);
    for (const r of drawn) if (!r.outdoor) parts.push(`<polygon class="wall" points="${pts(r.polygon)}" />`);
    for (const r of drawn) {
      const editable = s.mode === "edit";
      const cls = `room${r.outdoor ? " outdoor" : ""}${sel?.type === "room" && sel.id === r.id ? " selected" : ""}`;
      parts.push(`<polygon class="${cls}" points="${pts(r.polygon)}" ${editable ? `data-kind="room" data-id="${r.id}"` : ""} ${hairline}/>`);
    }

    // Openings cut through the walls.
    for (const p of f.passages) {
      if (p.kind === "stair") continue;
      const r = passageRect(p, 3.5);
      parts.push(`<rect class="opening" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`);
    }

    // Windows: a light bar in the wall.
    for (const w of f.windows ?? []) {
      const r = passageRect(w, 3);
      const selected = sel?.type === "window" && sel.id === w.id;
      const attrs = s.mode === "edit" ? `data-kind="window" data-id="${w.id}"` : "";
      parts.push(`<rect class="window${selected ? " selected" : ""}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" ${attrs} ${hairline}/>`);
      parts.push(`<line class="window-line" x1="${w.a.x}" y1="${w.a.y}" x2="${w.b.x}" y2="${w.b.y}" ${hairline}/>`);
    }

    // Fixtures.
    for (const x of f.fixtures) {
      const editable = s.mode === "edit";
      const b = bounds(x.polygon);
      const cls = `fixture ${x.style ?? ""}${sel?.type === "fixture" && sel.id === x.id ? " selected" : ""}`;
      parts.push(`<polygon class="${cls}" points="${pts(x.polygon)}" ${editable ? `data-kind="fixture" data-id="${x.id}"` : ""} ${hairline}/>`);
      if (x.style === "stairs") parts.push(this.treads(b, hairline));
      const isWall = x.style === "halfwall" || x.style === "wall";
      if (!isWall && b.w > 14 && b.h > 10)
        parts.push(`<text class="label fixture-label" x="${b.x + b.w / 2}" y="${b.y + b.h / 2}" font-size="${fs(10)}">${esc(x.name)}</text>`);
    }

    // Room labels, at the polygon's area centroid so L-shaped rooms label their bigger leg.
    for (const r of drawn) {
      const b = bounds(r.polygon);
      const c = areaCentroid(r.polygon);
      const cx = c.x,
        cy = c.y;
      parts.push(
        `<text class="label room-label" x="${cx}" y="${cy - fs(7)}" font-size="${fs(12)}">${esc(r.name)}</text>` +
          `<text class="label room-dim" x="${cx}" y="${cy + fs(8)}" font-size="${fs(10)}">${fmtFtIn(b.w)} × ${fmtFtIn(b.h)}</text>`,
      );
    }

    // Wall lengths: for every room when the toggle is on, else for the selected room in edit mode.
    for (const r of drawn) {
      const show = s.showDimensions || (s.mode === "edit" && sel?.type === "room" && sel.id === r.id);
      if (!show) continue;
      parts.push(this.dimensionLabels(r.polygon, fs, hairline));
    }
    if (s.showDimensions) {
      for (const x of f.fixtures) {
        const b = bounds(x.polygon);
        if (b.w >= 24 && b.h >= 24) parts.push(`<text class="label dim fixture-dim" x="${b.x + b.w / 2}" y="${b.y + b.h - fs(6)}" font-size="${fs(8)}">${fmtFtIn(b.w)} × ${fmtFtIn(b.h)}</text>`);
      }
    }

    // Doors: leaf and swing arc.
    for (const p of f.passages) {
      if (p.kind === "stair") continue;
      const selected = sel?.type === "passage" && sel.id === p.id;
      const editable = s.mode === "edit";
      const attrs = editable ? `data-kind="passage" data-id="${p.id}"` : "";
      const swing = doorSwing(p, f);
      if (swing) {
        const hinge = p.hinge === "a" ? p.a : p.b;
        parts.push(`<polygon class="swing${selected ? " selected" : ""}" points="${pts(swing)}" ${attrs} ${hairline}/>`);
        const tip = swing[swing.length - 1];
        parts.push(`<line class="leaf" x1="${hinge.x}" y1="${hinge.y}" x2="${tip.x}" y2="${tip.y}" ${hairline}/>`);
      } else {
        parts.push(`<line class="passage-line${selected ? " selected" : ""} ${p.kind}" x1="${p.a.x}" y1="${p.a.y}" x2="${p.b.x}" y2="${p.b.y}" ${attrs} ${hairline}/>`);
      }
      if (editable || p.kind === "door" || p.kind === "exterior" || p.kind === "sliding") {
        const mx = (p.a.x + p.b.x) / 2,
          my = (p.a.y + p.b.y) / 2;
        parts.push(`<text class="label door-label" x="${mx}" y="${my}" font-size="${fs(9)}">${p.width}"</text>`);
      }
    }

    // Stair landings.
    for (const a of floorAnchors(s.project, f)) {
      if (a.passage.kind !== "stair") continue;
      const isA = a.passage.stair!.landingA === a.point;
      parts.push(
        `<g class="landing" ${s.mode === "edit" ? `data-kind="landing" data-id="${a.passage.id}" data-end="${isA ? "A" : "B"}"` : ""}>` +
          `<circle cx="${a.point.x}" cy="${a.point.y}" r="${fs(7)}" ${hairline}/>` +
          `<text class="label" x="${a.point.x}" y="${a.point.y + fs(18)}" font-size="${fs(9)}">${esc(a.passage.name)} ${isA ? "↑" : "↓"}</text></g>`,
      );
    }

    parts.push(`</g>`);

    // Walk overlay as a raster image.
    if (s.walkOverlay !== "none" && fa) {
      const url = this.overlayImage(fa.grid.cols, fa.grid.rows, s.walkOverlay === "main" ? fa.mainMask : fa.secondaryMask, s.walkOverlay === "main" ? fa.mainReach : fa.secondaryReach, fa.grid.blocked, `${f.id}:${s.walkOverlay}:${fa.grid.cols}x${fa.grid.rows}:${hash(fa.mainMask)}:${hash(fa.mainReach)}:${hash(fa.secondaryReach)}`);
      parts.push(`<image class="overlay" href="${url}" x="0" y="0" width="${fa.grid.cols * fa.grid.cell}" height="${fa.grid.rows * fa.grid.cell}" preserveAspectRatio="none"/>`);
    }

    // Placements.
    const placements = s.project.placements.filter((p) => p.floorId === f.id);
    const issueByPlacement = new Map<string, "error" | "warning">();
    for (const i of analysis.issues) {
      if (i.floorId !== f.id) continue;
      for (const id of i.placementIds) {
        const cur = issueByPlacement.get(id);
        if (i.severity === "error" || !cur) issueByPlacement.set(id, i.severity === "error" ? "error" : "warning");
      }
    }
    for (const p of placements) {
      const item = s.item(p.itemId);
      if (!item) continue;
      const selected = sel?.type === "placement" && sel.id === p.id;
      if (s.showZones || selected) {
        for (const z of accessZones(p, item, s.project.settings)) {
          parts.push(`<rect class="zone ${z.kind}" x="${z.rect.x}" y="${z.rect.y}" width="${z.rect.w}" height="${z.rect.h}" ${hairline}/>`);
        }
      }
    }
    for (const p of placements) {
      const item = s.item(p.itemId);
      if (!item) continue;
      const fp = footprint(p, item);
      const selected = sel?.type === "placement" && sel.id === p.id;
      const status = issueByPlacement.get(p.id) ?? "";
      const fill = KIND_COLORS[item.kind] ?? KIND_COLORS.other;
      parts.push(`<g class="placement ${item.kind} ${status}${selected ? " selected" : ""}" data-kind="placement" data-id="${p.id}">`);
      parts.push(`<rect x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${fp.h}" fill="${fill}" ${hairline}/>`);
      parts.push(this.frontMark(p, fp, hairline));
      if (item.kind === "bed") parts.push(this.bedDecor(p, fp, hairline));
      const label = fp.w >= fp.h ? `x="${fp.x + fp.w / 2}" y="${fp.y + fp.h / 2}"` : `x="${fp.x + fp.w / 2}" y="${fp.y + fp.h / 2}" transform="rotate(-90 ${fp.x + fp.w / 2} ${fp.y + fp.h / 2})"`;
      const long = Math.max(fp.w, fp.h);
      const size = Math.min(fs(11), long / Math.max(6, item.name.length * 0.62));
      parts.push(`<text class="label item-label" ${label} font-size="${size}">${esc(item.name)}</text>`);
      parts.push(`</g>`);
      if (selected) {
        const r = fs(9);
        parts.push(
          `<g class="handle" data-kind="rotate" data-id="${p.id}"><circle cx="${fp.x + fp.w}" cy="${fp.y}" r="${r}" ${hairline}/><text x="${fp.x + fp.w}" y="${fp.y}" font-size="${fs(11)}">⟳</text></g>`,
        );
        parts.push(this.measurements(fp, fa?.grid, hairline, fs));
      }
    }

    // Ghost while placing.
    if (s.placing && this.mouse) {
      const item = s.item(s.placing.itemId);
      if (item) {
        const across = s.placing.rotation % 180 === 0;
        const w = across ? item.w : item.d,
          h = across ? item.d : item.w;
        const snap = s.project.settings.snap || 1;
        const x = snapTo(this.mouse.x - w / 2, snap),
          y = snapTo(this.mouse.y - h / 2, snap);
        parts.push(`<rect class="ghost" x="${x}" y="${y}" width="${w}" height="${h}" ${hairline}/>`);
        parts.push(`<text class="label item-label" x="${x + w / 2}" y="${y + h / 2}" font-size="${fs(10)}">${esc(item.name)}</text>`);
      }
    }

    // Hovered issue.
    if (s.hoverIssueId) {
      const i = analysis.issues.find((x) => x.id === s.hoverIssueId);
      if (i?.rect && i.floorId === f.id) parts.push(`<rect class="issue-hl ${i.severity}" x="${i.rect.x}" y="${i.rect.y}" width="${i.rect.w}" height="${i.rect.h}" ${hairline}/>`);
    }

    // Edit handles.
    if (s.mode === "edit") {
      const hr = fs(5);
      for (const r of drawn)
        r.polygon.forEach((q, i) =>
          parts.push(`<circle class="vertex" data-kind="vertex" data-owner="room" data-id="${r.id}" data-index="${i}" cx="${q.x}" cy="${q.y}" r="${hr}" ${hairline}/>`),
        );
      for (const r of f.fixtures)
        r.polygon.forEach((q, i) =>
          parts.push(`<circle class="vertex fixture" data-kind="vertex" data-owner="fixture" data-id="${r.id}" data-index="${i}" cx="${q.x}" cy="${q.y}" r="${hr}" ${hairline}/>`),
        );
      for (const p of f.passages) {
        if (p.kind === "stair") continue;
        for (const end of ["a", "b"] as const)
          parts.push(`<circle class="vertex passage" data-kind="passage-end" data-id="${p.id}" data-end="${end}" cx="${p[end].x}" cy="${p[end].y}" r="${hr}" ${hairline}/>`);
      }
      for (const w of f.windows ?? [])
        for (const end of ["a", "b"] as const)
          parts.push(`<circle class="vertex window" data-kind="window-end" data-id="${w.id}" data-end="${end}" cx="${w[end].x}" cy="${w[end].y}" r="${hr}" ${hairline}/>`);
    }

    // Scale bar.
    const bar = `<g class="scalebar" transform="translate(${fs(16)} ${f.height + fs(28)})"><line x1="0" y1="0" x2="60" y2="0" ${hairline}/><line x1="0" y1="${-fs(4)}" x2="0" y2="${fs(4)}" ${hairline}/><line x1="60" y1="${-fs(4)}" x2="60" y2="${fs(4)}" ${hairline}/><text class="label" x="30" y="${fs(14)}" font-size="${fs(10)}">5 ft</text></g>`;
    parts.push(bar);

    this.svg.innerHTML = `<g transform="translate(${v.tx} ${v.ty}) scale(${v.scale})">${parts.join("")}</g>`;
    this.svg.classList.toggle("placing", !!s.placing);
    this.svg.classList.toggle("edit", s.mode === "edit");
  }

  /** Tread lines across the short axis of a stair run, every 10". */
  private treads(b: Rect, hairline: string): string {
    const out: string[] = [];
    if (b.w >= b.h) for (let x = b.x + 10; x < b.x + b.w; x += 10) out.push(`<line class="tread" x1="${x}" y1="${b.y}" x2="${x}" y2="${b.y + b.h}" ${hairline}/>`);
    else for (let y = b.y + 10; y < b.y + b.h; y += 10) out.push(`<line class="tread" x1="${b.x}" y1="${y}" x2="${b.x + b.w}" y2="${y}" ${hairline}/>`);
    return out.join("");
  }

  /** A length label on each wall of a polygon, just inside the room. */
  private dimensionLabels(poly: Polygon, fs: (n: number) => number, hairline: string): string {
    const out: string[] = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i],
        b = poly[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 8) continue;
      const mx = (a.x + b.x) / 2,
        my = (a.y + b.y) / 2;
      // Normal pointing into the room.
      let nx = -(b.y - a.y) / len,
        ny = (b.x - a.x) / len;
      if (!pointInPolygon({ x: mx + nx, y: my + ny }, poly)) {
        nx = -nx;
        ny = -ny;
      }
      const off = fs(9);
      const lx = mx + nx * off,
        ly = my + ny * off;
      const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x);
      const t = fs(5);
      out.push(`<line class="dim-tick" x1="${a.x + nx * t}" y1="${a.y + ny * t}" x2="${b.x + nx * t}" y2="${b.y + ny * t}" ${hairline}/>`);
      out.push(
        `<text class="label dim" x="${lx}" y="${ly}" font-size="${fs(9)}" ${vertical ? `transform="rotate(-90 ${lx} ${ly})"` : ""}>${fmtFtIn(len)}</text>`,
      );
    }
    return out.join("");
  }


  private frontMark(p: Placement, fp: Rect, hairline: string): string {
    const t = 2.5;
    switch (p.rotation) {
      case 0:
        return `<rect class="front" x="${fp.x}" y="${fp.y + fp.h - t}" width="${fp.w}" height="${t}" ${hairline}/>`;
      case 180:
        return `<rect class="front" x="${fp.x}" y="${fp.y}" width="${fp.w}" height="${t}" ${hairline}/>`;
      case 90:
        return `<rect class="front" x="${fp.x}" y="${fp.y}" width="${t}" height="${fp.h}" ${hairline}/>`;
      case 270:
        return `<rect class="front" x="${fp.x + fp.w - t}" y="${fp.y}" width="${t}" height="${fp.h}" ${hairline}/>`;
    }
  }

  /** Pillows at the head (opposite the front/foot). */
  private bedDecor(p: Placement, fp: Rect, hairline: string): string {
    const pw = Math.min(26, fp.w * 0.42),
      ph = 8;
    const out: string[] = [];
    const pillow = (x: number, y: number, w: number, h: number) => out.push(`<rect class="pillow" x="${x}" y="${y}" width="${w}" height="${h}" rx="2" ${hairline}/>`);
    switch (p.rotation) {
      case 0: // head at top
        pillow(fp.x + 4, fp.y + 4, pw, ph);
        pillow(fp.x + fp.w - 4 - pw, fp.y + 4, pw, ph);
        break;
      case 180:
        pillow(fp.x + 4, fp.y + fp.h - 4 - ph, pw, ph);
        pillow(fp.x + fp.w - 4 - pw, fp.y + fp.h - 4 - ph, pw, ph);
        break;
      case 90: {
        const qw = Math.min(26, fp.h * 0.42);
        pillow(fp.x + fp.w - 4 - ph, fp.y + 4, ph, qw);
        pillow(fp.x + fp.w - 4 - ph, fp.y + fp.h - 4 - qw, ph, qw);
        break;
      }
      case 270: {
        const qw = Math.min(26, fp.h * 0.42);
        pillow(fp.x + 4, fp.y + 4, ph, qw);
        pillow(fp.x + 4, fp.y + fp.h - 4 - qw, ph, qw);
        break;
      }
    }
    return out.join("");
  }

  /** Distances from the selected footprint to the nearest obstacle on each side. */
  private measurements(fp: Rect, grid: { cols: number; rows: number; cell: number; blocked: Uint8Array } | undefined, hairline: string, fs: (n: number) => number): string {
    if (!grid) return "";
    const s = this.store;
    // Use a static grid (no furniture) so the measurement is to walls; furniture-to-furniture gaps are visible anyway.
    const fa = s.analysis.floors.get(s.floor.id);
    if (!fa) return "";
    const out: string[] = [];
    const cx = fp.x + fp.w / 2,
      cy = fp.y + fp.h / 2;
    const march = (x: number, y: number, dx: number, dy: number): number => {
      let d = 0;
      for (let i = 0; i < 2000; i++) {
        const px = x + dx * d,
          py = y + dy * d;
        const c = Math.floor(px / grid.cell),
          r = Math.floor(py / grid.cell);
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return d;
        if (fa.grid.blocked[idx(grid, c, r)] && !(px >= fp.x && px <= fp.x + fp.w && py >= fp.y && py <= fp.y + fp.h)) return d;
        d += grid.cell / 2;
      }
      return d;
    };
    const dims: [number, number, number, number, number][] = [
      [cx, fp.y, 0, -1, 0],
      [cx, fp.y + fp.h, 0, 1, 0],
      [fp.x, cy, -1, 0, 1],
      [fp.x + fp.w, cy, 1, 0, 1],
    ];
    for (const [x, y, dx, dy, horiz] of dims) {
      const d = march(x + dx * 0.01, y + dy * 0.01, dx, dy);
      if (d <= 0.5 || d > 240) continue;
      const x2 = x + dx * d,
        y2 = y + dy * d;
      out.push(`<line class="measure" x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" ${hairline}/>`);
      const lx = (x + x2) / 2 + (horiz ? 0 : fs(6)),
        ly = (y + y2) / 2 + (horiz ? -fs(4) : fs(4));
      out.push(`<text class="label measure-label" x="${lx}" y="${ly}" font-size="${fs(10)}">${Math.round(d)}"</text>`);
    }
    return out.join("");
  }

  private overlayImage(cols: number, rows: number, mask: Uint8Array, reach: Uint8Array, blocked: Uint8Array, key: string): string {
    if (this.overlayCache?.key === key) return this.overlayCache.url;
    const c = document.createElement("canvas");
    c.width = cols;
    c.height = rows;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(cols, rows);
    for (let i = 0; i < cols * rows; i++) {
      const o = i * 4;
      if (blocked[i]) continue;
      if (reach[i]) {
        img.data[o] = 40;
        img.data[o + 1] = 170;
        img.data[o + 2] = 90;
        img.data[o + 3] = 110;
      } else if (mask[i]) {
        img.data[o] = 240;
        img.data[o + 1] = 160;
        img.data[o + 2] = 30;
        img.data[o + 3] = 120;
      } else {
        img.data[o] = 220;
        img.data[o + 1] = 60;
        img.data[o + 2] = 60;
        img.data[o + 3] = 45;
      }
    }
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    this.overlayCache = { key, url };
    return url;
  }
}

/** Centroid of a polygon's area (falls back to the bounding-box centre for degenerate shapes). */
function areaCentroid(poly: Polygon): Point {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += cross;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const b = bounds(poly);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Move one vertex; for orthogonal polygons drag the neighbours so edges stay axis-aligned. */
export function moveVertex(poly: Polygon, i: number, x: number, y: number): void {
  const n = poly.length;
  const orth = poly.every((p, k) => {
    const q = poly[(k + 1) % n];
    return p.x === q.x || p.y === q.y;
  });
  const old = { ...poly[i] };
  poly[i] = { x, y };
  if (!orth || n < 4) return;
  const prev = poly[(i - 1 + n) % n],
    next = poly[(i + 1) % n];
  for (const nb of [prev, next]) {
    if (nb.x === old.x && nb.y !== old.y) nb.x = x;
    else if (nb.y === old.y && nb.x !== old.x) nb.y = y;
  }
}

function hash(a: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < a.length; i += 7) h = Math.imul(h ^ a[i], 16777619);
  return h >>> 0;
}

export type { Selection, Passage };

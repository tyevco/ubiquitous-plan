import type { Floor, FurnitureItem, FurnitureKind, Passage, PassageKind, Placement, Point, Project, Room, Fixture, Window } from "../types";
import type { SolveRequest, SolveResult } from "../engine/solver";
import { Store, uid, normalize } from "../state";
import type { PlanCanvas } from "../render/canvas";
import { OUTSIDE, defaultProject } from "../engine/defaults";
import { areaSummary, bounds, footprint, fmtFtIn, rect } from "../engine/geometry";
import { itemFrontClearance } from "../engine/analysis";
import { roomOfPoint } from "../engine/transport";

const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const KINDS: FurnitureKind[] = ["bed", "nightstand", "dresser", "chest", "shelf", "table", "cabinet", "sofa", "desk", "piano", "other"];
const PASSAGE_KINDS: PassageKind[] = ["door", "opening", "sliding", "exterior", "stair"];
const n1 = (v: number): string => String(Math.round(v * 100) / 100);

export class Panels {
  private editingItemId: string | null = null;
  private addingItem = false;
  private open: Record<string, boolean> = { issues: true, inspector: true, solver: false, bring: false, settings: false };
  private last = new Map<HTMLElement, string>();
  private solverRoomId: string | null = null;
  private solverPicks = new Map<string, number>();
  private solverBusy: { done: number; total: number } | null = null;
  private solverMessage = "";
  private worker: Worker | null = null;
  private pendingSolve: { roomId: string; picks: { itemId: string; count: number }[] } | null = null;

  constructor(
    private store: Store,
    private canvas: PlanCanvas,
    private els: { top: HTMLElement; left: HTMLElement; right: HTMLElement },
  ) {
    for (const el of Object.values(els)) {
      el.addEventListener("click", (e) => this.onClick(e));
      el.addEventListener("change", (e) => this.onChange(e));
      el.addEventListener("input", (e) => this.onInput(e));
      el.addEventListener("mouseover", (e) => this.onHover(e, true));
      el.addEventListener("mouseout", (e) => this.onHover(e, false));
      el.addEventListener("toggle", (e) => {
        const d = e.target as HTMLDetailsElement;
        if (d.dataset.section) this.open[d.dataset.section] = d.open;
      }, true);
    }
  }

  render(): void {
    this.set(this.els.top, this.topbar());
    this.set(this.els.left, this.inventory());
    this.set(this.els.right, this.store.mode === "edit" ? this.editor() : this.inspector());
  }

  private set(el: HTMLElement, html: string): void {
    if (this.last.get(el) === html) return;
    // Don't yank focus from an input the user is typing in.
    if (el.contains(document.activeElement) && document.activeElement?.tagName === "INPUT" && (document.activeElement as HTMLInputElement).type === "text") return;
    this.last.set(el, html);
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- views

  private topbar(): string {
    const s = this.store;
    const p = s.project;
    const issues = s.analysis.issues;
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    return `
      <div class="brand"><span class="logo">▦</span><input class="project-name" data-field="project-name" value="${esc(p.name)}" title="Project name"></div>
      <div class="tabs">
        ${p.floors.map((f) => `<button class="tab${f.id === p.activeFloorId ? " active" : ""}" data-action="floor" data-id="${f.id}">${esc(f.name)}</button>`).join("")}
        ${s.mode === "edit" ? `<button class="tab add" data-action="add-floor" title="Add a floor">+</button>` : ""}
      </div>
      <div class="modes">
        <button class="${s.mode === "layout" ? "active" : ""}" data-action="mode" data-id="layout">Layout</button>
        <button class="${s.mode === "edit" ? "active" : ""}" data-action="mode" data-id="edit">Edit plan</button>
      </div>
      <div class="tools">
        <button data-action="undo" ${s.canUndo ? "" : "disabled"} title="Undo (Ctrl+Z)">↶</button>
        <button data-action="redo" ${s.canRedo ? "" : "disabled"} title="Redo (Ctrl+Y)">↷</button>
        <button data-action="fit" title="Fit floor in view">⤢</button>
        <label class="toggle"><input type="checkbox" data-field="showZones" ${s.showZones ? "checked" : ""}> clearances</label>
        <label class="toggle"><input type="checkbox" data-field="showGrid" ${s.showGrid ? "checked" : ""}> grid</label>
        <label class="toggle">walk
          <select data-field="walkOverlay">
            <option value="none" ${s.walkOverlay === "none" ? "selected" : ""}>off</option>
            <option value="main" ${s.walkOverlay === "main" ? "selected" : ""}>${p.settings.mainPathWidth}" paths</option>
            <option value="secondary" ${s.walkOverlay === "secondary" ? "selected" : ""}>${p.settings.secondaryPathWidth}" paths</option>
          </select>
        </label>
      </div>
      <div class="status">
        ${this.areaBadge()}
        <span class="pill error" title="Errors">${errors}</span>
        <span class="pill warning" title="Warnings">${warnings}</span>
      </div>
      <div class="file">
        <button data-action="export">Export</button>
        <label class="btn">Import<input type="file" accept="application/json" data-field="import" hidden></label>
        <button data-action="reset" title="Back to the traced apartment and measured furniture">Reset</button>
      </div>`;
  }

  private areaBadge(): string {
    const p = this.store.project;
    const a = areaSummary(p.floors);
    const target = p.settings.targetSqFt;
    const off = target ? (a.gross - target) / target : 0;
    const cls = !target ? "" : Math.abs(off) <= 0.05 ? "ok" : "warn";
    const per = a.floors.map((f) => `${f.name}: ${Math.round(f.net)} sq ft inside the walls (≈${Math.round(f.gross)} with walls)`).join("\n");
    const tip = `${per}\nTotal ≈ ${Math.round(a.gross)} sq ft with walls, ${Math.round(a.net)} inside the walls.${target ? ` Listed: ${target.toLocaleString()} sq ft (${off >= 0 ? "+" : ""}${Math.round(off * 100)}%).` : ""}\nGarage and patios are not counted; toggle rooms in Edit plan.`;
    return `<span class="area ${cls}" title="${esc(tip)}">≈${Math.round(a.gross).toLocaleString()}${target ? ` / ${target.toLocaleString()}` : ""} sq ft</span>`;
  }

  private inventory(): string {
    const s = this.store;
    const p = s.project;
    const sets = new Map<string, FurnitureItem[]>();
    for (const item of p.furniture) {
      if (!sets.has(item.set)) sets.set(item.set, []);
      sets.get(item.set)!.push(item);
    }
    const placedCount = (id: string): number => p.placements.filter((x) => x.itemId === id).length;
    const rows: string[] = [];
    if (s.placing) {
      const item = s.item(s.placing.itemId);
      rows.push(`<div class="banner">Click the plan to place <b>${esc(item?.name ?? "")}</b>. <kbd>R</kbd> rotates, <kbd>Esc</kbd> cancels. <button data-action="cancel-place">Stop</button></div>`);
    }
    for (const [set, items] of sets) {
      rows.push(`<h3>${esc(set)}</h3>`);
      for (const item of items) {
        if (this.editingItemId === item.id) {
          rows.push(this.itemForm(item));
          continue;
        }
        const placed = placedCount(item.id);
        const badge = this.bringBadge(item);
        rows.push(`
          <div class="item${placed >= item.quantity ? " done" : ""}" data-item="${item.id}">
            <div class="item-main">
              <div class="item-name">${esc(item.name)} ${item.quantity > 1 ? `<span class="qty">${placed}/${item.quantity}</span>` : placed ? `<span class="qty">placed</span>` : ""}</div>
              <div class="item-dims">${n1(item.d)} × ${n1(item.w)} × ${n1(item.h)}" <span class="dim-key">d×w×h</span></div>
            </div>
            ${badge}
            <div class="item-actions">
              <button data-action="place" data-id="${item.id}" ${placed >= item.quantity ? "disabled" : ""} title="Place on the current floor">Place</button>
              <button class="icon" data-action="edit-item" data-id="${item.id}" title="Edit">✎</button>
            </div>
          </div>`);
      }
    }
    rows.push(this.addingItem ? this.itemForm(null) : `<button class="wide" data-action="add-item">+ Add furniture</button>`);
    return `<div class="panel-head"><h2>Furniture</h2><span class="hint">${p.placements.length} placed</span></div>${rows.join("")}`;
  }

  private bringBadge(item: FurnitureItem): string {
    const rep = this.store.analysis.transport.get(item.id);
    if (!rep) return "";
    if (rep.disassembles) return `<span class="badge info" title="Marked as disassembles for the move; transport check skipped">kit</span>`;
    const rooms = this.store.project.floors.flatMap((f) => f.rooms.filter((r) => !r.virtual).map((r) => ({ floor: f, room: r })));
    const bad = rooms.filter(({ room }) => !(rep.rooms.get(room.id)?.ok ?? false));
    if (!bad.length) {
      let tight = Infinity;
      for (const r of rep.rooms.values()) if (r.tightest) tight = Math.min(tight, r.tightest.margin);
      return `<span class="badge ok" title="Fits through every door and up the stairs. Tightest margin ${Math.round(tight)}&quot;">fits</span>`;
    }
    const tip = bad.map(({ room }) => `${room.name}: ${describeFail(rep.rooms.get(room.id))}`).join("\n");
    const allBad = bad.length === rooms.length;
    return `<span class="badge ${allBad ? "error" : "warning"}" title="${esc(tip)}">${allBad ? "won't fit" : `${bad.length} room${bad.length > 1 ? "s" : ""} ✗`}</span>`;
  }

  private itemForm(item: FurnitureItem | null): string {
    const v: Partial<FurnitureItem> & Pick<FurnitureItem, "name" | "set" | "kind" | "d" | "w" | "h" | "quantity"> = item ?? { name: "", set: "Other", kind: "other", d: 20, w: 36, h: 30, quantity: 1 };
    const id = item?.id ?? "new";
    return `
      <form class="item-form" data-item-form="${id}">
        <label>Name <input name="name" value="${esc(v.name)}" required></label>
        <label>Set <input name="set" value="${esc(v.set)}" list="sets"></label>
        <label>Kind <select name="kind">${KINDS.map((k) => `<option ${k === v.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <div class="row3">
          <label>Depth <input name="d" type="number" step="0.25" min="1" value="${v.d}"></label>
          <label>Width <input name="w" type="number" step="0.25" min="1" value="${v.w}"></label>
          <label>Height <input name="h" type="number" step="0.25" min="1" value="${v.h}"></label>
        </div>
        <div class="row3">
          <label>Qty <input name="quantity" type="number" min="1" value="${v.quantity}"></label>
          <label>Front clear <input name="frontClearance" type="number" step="1" min="0" value="${v.frontClearance ?? ""}" placeholder="auto"></label>
        </div>
        <label class="check"><input name="disassembles" type="checkbox" ${v.disassembles ? "checked" : ""}> comes apart for the move</label>
        <label class="check"><input name="allowInBedZone" type="checkbox" ${v.allowInBedZone ? "checked" : ""}> may sit beside a bed</label>
        <label class="check"><input name="keepUpright" type="checkbox" ${(v as FurnitureItem).keepUpright ? "checked" : ""}> must be carried upright (can't tip to fit a door)</label>
        <div class="form-actions">
          <button type="submit" data-action="save-item" data-id="${id}">Save</button>
          <button type="button" data-action="cancel-item">Cancel</button>
          ${item ? `<button type="button" class="danger" data-action="delete-item" data-id="${item.id}">Delete</button>` : ""}
        </div>
      </form>
      <datalist id="sets">${[...new Set(this.store.project.furniture.map((f) => f.set))].map((x) => `<option value="${esc(x)}">`).join("")}</datalist>`;
  }

  private inspector(): string {
    const s = this.store;
    const sel = s.selection;
    const parts: string[] = [];
    parts.push(`<details data-section="inspector" ${this.open.inspector ? "open" : ""}><summary>Selected piece</summary>`);
    if (sel?.type === "placement" && s.placement(sel.id)) parts.push(this.placementInspector(s.placement(sel.id)!));
    else parts.push(`<p class="hint">Click a piece on the plan. Drag to move, <kbd>R</kbd> or double-click to rotate, arrows nudge 1" (<kbd>Shift</kbd> 12"), <kbd>Del</kbd> removes.</p>`);
    parts.push(`</details>`);
    parts.push(this.solverSection());
    parts.push(this.issuesSection());
    parts.push(this.bringSection());
    parts.push(this.settingsSection());
    return parts.join("");
  }

  private placementInspector(pl: Placement): string {
    const s = this.store;
    const item = s.item(pl.itemId);
    if (!item) return "";
    const floor = s.project.floors.find((f) => f.id === pl.floorId)!;
    const fp = footprint(pl, item);
    const roomId = roomOfPoint(floor, fp.x + fp.w / 2, fp.y + fp.h / 2);
    const room = floor.rooms.find((r) => r.id === roomId);
    const rep = s.analysis.transport.get(item.id);
    let transport = "";
    if (rep?.disassembles) transport = `<p class="hint">Comes apart for the move, so no door check.</p>`;
    else if (rep && roomId) {
      const route = rep.rooms.get(roomId);
      if (!route) transport = `<p class="bad">No route into ${esc(room?.name)}.</p>`;
      else
        transport = `<p class="${route.ok ? "good" : "bad"}">${route.ok ? "Can be carried in." : "Can't be carried in."}</p><ol class="route">${route.steps
          .map((st) => `<li class="${st.ok ? "" : "bad"}">${esc(st.passage.name)} — ${st.ok ? `${Math.round(st.margin)}" spare` : `${Math.round(-st.margin)}" short`} <span class="hint">(${esc(st.how)})</span></li>`)
          .join("")}</ol>`;
    }
    const clearance = itemFrontClearance(item, s.project.settings);
    return `
      <div class="insp">
        <div class="insp-title">${esc(item.name)} <span class="hint">${esc(item.set)} · ${item.kind}</span></div>
        <div class="hint">${n1(item.d)}" deep × ${n1(item.w)}" wide × ${n1(item.h)}" tall · in ${esc(room?.name ?? "no room")}</div>
        <div class="row3">
          <label>X <input type="number" step="1" data-pl-field="x" data-id="${pl.id}" value="${n1(pl.x)}"></label>
          <label>Y <input type="number" step="1" data-pl-field="y" data-id="${pl.id}" value="${n1(pl.y)}"></label>
          <label>Facing <select data-pl-field="rotation" data-id="${pl.id}">
            ${[0, 90, 180, 270].map((r) => `<option value="${r}" ${pl.rotation === r ? "selected" : ""}>${{ 0: "down", 90: "left", 180: "up", 270: "right" }[r as 0]}</option>`).join("")}
          </select></label>
        </div>
        <div class="hint">Footprint ${fmtFtIn(fp.w)} × ${fmtFtIn(fp.h)}${item.kind === "bed" ? `; ${s.project.settings.bedSideClearance}" needed each side` : clearance ? `; ${clearance}" needed in front` : ""}</div>
        ${transport}
        <div class="form-actions">
          <button data-action="rotate" data-id="${pl.id}">Rotate</button>
          <button data-action="duplicate" data-id="${pl.id}" ${s.project.placements.filter((x) => x.itemId === item.id).length >= item.quantity ? "disabled" : ""}>Place another</button>
          <button class="danger" data-action="remove" data-id="${pl.id}">Remove</button>
        </div>
      </div>`;
  }

  private solverSection(): string {
    const s = this.store;
    const f = s.floor;
    const rooms = f.rooms.filter((r) => !r.virtual);
    if (!this.solverRoomId || !rooms.some((r) => r.id === this.solverRoomId)) {
      const sel = s.selection;
      let roomId: string | undefined;
      if (sel?.type === "placement") {
        const pl = s.placement(sel.id);
        const item = pl && s.item(pl.itemId);
        if (pl && item) {
          const fp = footprint(pl, item);
          roomId = roomOfPoint(f, fp.x + fp.w / 2, fp.y + fp.h / 2);
        }
      }
      this.solverRoomId = roomId ?? rooms.find((r) => /bed/i.test(r.name))?.id ?? rooms[0]?.id ?? null;
      this.solverPicks = this.picksFromRoom(this.solverRoomId);
    }
    const busy = this.solverBusy;
    const pct = busy ? Math.round((100 * busy.done) / Math.max(1, busy.total)) : 0;
    const pickRows = s.project.furniture
      .map((item) => {
        const n = this.solverPicks.get(item.id) ?? 0;
        return `<label class="pick"><input type="checkbox" data-solver-item="${item.id}" ${n > 0 ? "checked" : ""}> <span>${esc(item.name)} <span class="hint">${esc(item.set)}</span></span>${
          item.quantity > 1 ? `<input type="number" min="1" max="${item.quantity}" data-solver-count="${item.id}" value="${Math.max(1, n || item.quantity)}" ${n > 0 ? "" : "disabled"}>` : ""
        }</label>`;
      })
      .join("");
    return `<details data-section="solver" ${this.open.solver ? "open" : ""}><summary>Auto-arrange</summary>
      <p class="hint">Picks spots for the ticked pieces in one room: heads and backs to walls, nightstands by the bed, doors, swings, walkways, and clearances kept free. Other pieces stay where they are.</p>
      <label>Room <select data-field="solver-room">${rooms.map((r) => `<option value="${r.id}" ${r.id === this.solverRoomId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      <div class="picks">${pickRows}</div>
      <div class="form-actions">
        <button data-action="solve" ${busy ? "disabled" : ""}>${busy ? `Arranging… ${pct}%` : "Arrange"}</button>
        <button data-action="solver-pick-none">Untick all</button>
      </div>
      ${this.solverMessage ? `<p class="hint solver-msg">${esc(this.solverMessage)}</p>` : ""}
    </details>`;
  }

  private picksFromRoom(roomId: string | null): Map<string, number> {
    const picks = new Map<string, number>();
    if (!roomId) return picks;
    const f = this.store.floor;
    for (const pl of this.store.project.placements) {
      if (pl.floorId !== f.id) continue;
      const item = this.store.item(pl.itemId);
      if (!item) continue;
      const fp = footprint(pl, item);
      if (roomOfPoint(f, fp.x + fp.w / 2, fp.y + fp.h / 2) === roomId) picks.set(item.id, (picks.get(item.id) ?? 0) + 1);
    }
    return picks;
  }

  private solve(): void {
    const s = this.store;
    const roomId = this.solverRoomId;
    if (!roomId || this.solverBusy) return;
    const picks = [...this.solverPicks.entries()].filter(([, n]) => n > 0).map(([itemId, count]) => ({ itemId, count }));
    if (!picks.length) {
      this.solverMessage = "Tick at least one piece.";
      s.touch();
      return;
    }
    const req: SolveRequest = { project: JSON.parse(JSON.stringify(s.project)), floorId: s.floor.id, roomId, picks, restarts: 3, seed: Date.now() % 100000 };
    this.solverBusy = { done: 0, total: 1 };
    this.solverMessage = "";
    this.pendingSolve = { roomId, picks };
    s.touch();
    if (!this.worker) {
      this.worker = new Worker(new URL("../engine/solver.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent) => {
        if (e.data.type === "progress") {
          this.solverBusy = { done: e.data.done, total: e.data.total };
          s.touch();
        } else if (e.data.type === "done" && this.pendingSolve) {
          const pending = this.pendingSolve;
          this.pendingSolve = null;
          this.applySolve(e.data.result, pending.roomId, pending.picks);
        }
      };
      this.worker.onerror = (err) => {
        this.solverBusy = null;
        this.solverMessage = `The arranger failed: ${err.message}`;
        s.touch();
      };
    }
    this.worker.postMessage(req);
  }

  private applySolve(result: SolveResult, roomId: string, picks: { itemId: string; count: number }[]): void {
    const s = this.store;
    this.solverBusy = null;
    const picked = new Set(picks.map((p) => p.itemId));
    s.update((p) => {
      p.placements = p.placements.filter((pl) => !picked.has(pl.itemId));
      for (const pl of result.placements) p.placements.push({ ...pl, id: uid("pl") });
    });
    const room = s.floor.rooms.find((r) => r.id === roomId)?.name ?? "the room";
    const placed = result.placements.length;
    const bits = [`Placed ${placed} piece${placed === 1 ? "" : "s"} in ${room}.`];
    if (result.compromises.length) bits.push(`Compromises: ${result.compromises.map((c) => `${c.name} (${c.problems.join("; ")})`).join(" · ")}.`);
    if (result.unplaced.length) bits.push(`Couldn't place: ${result.unplaced.map((u) => `${u.name} (${u.reason})`).join("; ")}.`);
    if (!result.compromises.length && !result.unplaced.length) bits.push("Drag anything you'd rather have elsewhere.");
    this.solverMessage = bits.join(" ");
    this.solverPicks = this.picksFromRoom(roomId);
    s.selection = null;
    s.touch();
  }

  private issuesSection(): string {
    const s = this.store;
    const floorIssues = s.analysis.issues.filter((i) => i.floorId === s.floor.id);
    const other = s.analysis.issues.length - floorIssues.length;
    const list = floorIssues.length
      ? `<ul class="issues">${floorIssues
          .map(
            (i) =>
              `<li class="${i.severity}" data-issue="${i.id}" data-action="focus-issue" data-id="${i.placementIds[0] ?? ""}"><span class="dot"></span>${esc(i.message)}</li>`,
          )
          .join("")}</ul>`
      : `<p class="good">No problems on this floor.</p>`;
    return `<details data-section="issues" ${this.open.issues ? "open" : ""}><summary>Problems on ${esc(s.floor.name)} <span class="count">${floorIssues.length}</span>${other ? ` <span class="hint">+${other} elsewhere</span>` : ""}</summary>${list}</details>`;
  }

  private bringSection(): string {
    const s = this.store;
    const rooms = s.project.floors.flatMap((f) => f.rooms.filter((r) => !r.virtual).map((r) => ({ floor: f, room: r })));
    const rows = s.project.furniture.map((item) => {
      const rep = s.analysis.transport.get(item.id)!;
      if (rep.disassembles) return `<li><b>${esc(item.name)}</b> <span class="hint">(${esc(item.set)})</span>: comes apart, no check.</li>`;
      const bad = rooms.filter(({ room }) => !(rep.rooms.get(room.id)?.ok ?? false));
      if (!bad.length) return `<li class="good"><b>${esc(item.name)}</b> <span class="hint">(${esc(item.set)})</span>: fits everywhere.</li>`;
      return `<li class="${bad.length === rooms.length ? "bad" : "warn"}"><b>${esc(item.name)}</b> <span class="hint">(${esc(item.set)})</span>: can't reach ${bad.map(({ room, floor }) => `${esc(room.name)} (${esc(floor.name.toLowerCase())})`).join(", ")}.<div class="hint">${esc(describeFail(rep.rooms.get(bad[0].room.id)))}</div></li>`;
    });
    return `<details data-section="bring" ${this.open.bring ? "open" : ""}><summary>Can we bring it?</summary><p class="hint">Checks every route from outside through doors and stairs, in any orientation, with ${s.project.settings.transportTolerance}" to spare. Door and stair widths are estimates until you measure them (Edit plan).</p><ul class="bring">${rows.join("")}</ul></details>`;
  }

  private settingsSection(): string {
    const st = this.store.project.settings;
    const num = (key: keyof typeof st, label: string, step = 1) =>
      `<label>${label} <input type="number" step="${step}" data-setting="${key}" value="${st[key] as number}"></label>`;
    return `<details data-section="settings" ${this.open.settings ? "open" : ""}><summary>Rules &amp; tolerances</summary>
      <div class="settings">
        ${num("mainPathWidth", 'Main path width (")')}
        ${num("secondaryPathWidth", 'Squeeze-past width (")')}
        ${num("drawerClearance", 'Drawer pull-out + stand (")')}
        ${num("bedSideClearance", 'Bed side clearance (")')}
        <label class="check"><input type="checkbox" data-setting="bedBothSides" ${st.bedBothSides ? "checked" : ""}> require both sides of a bed</label>
        ${num("tableClearance", 'Chair space around tables (")')}
        ${num("furnitureGap", 'Gap between pieces (")')}
        ${num("transportTolerance", 'Moving margin (")', 0.5)}
        ${num("defaultDoorHeight", 'Default door height (")')}
        ${num("defaultSillHeight", 'Default window sill (")')}
        ${num("targetSqFt", "Listed size (sq ft)")}
        ${num("snap", 'Snap (")', 0.5)}
        ${num("cellSize", 'Analysis cell (")', 0.5)}
      </div></details>`;
  }

  // ---------------------------------------------------------------- plan editor

  private editor(): string {
    const s = this.store;
    const f = s.floor;
    const sel = s.selection;
    const parts: string[] = [];
    parts.push(`<div class="panel-head"><h2>Edit plan</h2></div>
      <p class="hint">Drag corners, walls, and door ends on the plan. Coordinates are inches from the top-left; rooms are drawn to the inside faces of the walls.</p>
      <div class="row3">
        <label>Floor <input type="text" data-floor-field="name" value="${esc(f.name)}"></label>
        <label>W <input type="number" data-floor-field="width" value="${f.width}"></label>
        <label>H <input type="number" data-floor-field="height" value="${f.height}"></label>
      </div>
      <div class="form-actions">
        <button data-action="add-room">+ Room</button>
        <button data-action="add-fixture">+ Fixture</button>
        <button data-action="add-passage">+ Door</button>
        <button data-action="add-window">+ Window</button>
        <button class="danger" data-action="delete-floor" ${s.project.floors.length > 1 ? "" : "disabled"}>Delete floor</button>
      </div>`);
    const li = (type: "room" | "fixture" | "passage" | "window", id: string, name: string, extra = "") =>
      `<li class="${sel?.type === type && sel.id === id ? "selected" : ""}" data-action="select" data-type="${type}" data-id="${id}">${esc(name)}<span class="hint">${extra}</span></li>`;
    const area = areaSummary([f]).floors[0];
    parts.push(`<p class="hint">This floor: ${Math.round(area.net)} sq ft inside the walls, ≈${Math.round(area.gross)} sq ft with walls (rooms that count only).</p>`);
    parts.push(`<h3>Rooms</h3><ul class="list">${f.rooms.map((r) => li("room", r.id, `${r.name}${r.excludeFromArea ? " ·" : ""}`, `${fmtFtIn(bounds(r.polygon).w)} × ${fmtFtIn(bounds(r.polygon).h)}`)).join("")}</ul>`);
    parts.push(`<h3>Fixtures</h3><ul class="list">${f.fixtures.map((r) => li("fixture", r.id, r.name)).join("")}</ul>`);
    parts.push(`<h3>Doors &amp; openings</h3><ul class="list">${f.passages.map((p) => li("passage", p.id, p.name, `${p.kind} ${p.width}"`)).join("")}</ul>`);
    parts.push(`<h3>Windows</h3><ul class="list">${(f.windows ?? []).map((w) => li("window", w.id, w.name ?? "Window", `${Math.round(Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y))}"`)).join("")}</ul>`);
    if (sel?.type === "room") {
      const r = f.rooms.find((x) => x.id === sel.id);
      if (r) parts.push(this.polygonForm("room", r));
    } else if (sel?.type === "fixture") {
      const r = f.fixtures.find((x) => x.id === sel.id);
      if (r) parts.push(this.polygonForm("fixture", r));
    } else if (sel?.type === "passage") {
      const p = f.passages.find((x) => x.id === sel.id);
      if (p) parts.push(this.passageForm(p, f));
    } else if (sel?.type === "window") {
      const w = f.windows.find((x) => x.id === sel.id);
      if (w) parts.push(this.windowForm(w));
    }
    return parts.join("");
  }

  private windowForm(w: Window): string {
    const wf = (field: string, label: string, value: string | number | undefined, type = "number") =>
      `<label>${label} <input type="${type}" step="1" data-win-field="${field}" data-id="${w.id}" value="${value ?? ""}"></label>`;
    return `<div class="insp">
      <div class="insp-title">Window</div>
      ${wf("name", "Name", w.name ?? "", "text")}
      <div class="row4">${wf("ax", "A x", w.a.x)}${wf("ay", "A y", w.a.y)}${wf("bx", "B x", w.b.x)}${wf("by", "B y", w.b.y)}</div>
      ${wf("sill", `Sill height (") — blank uses ${this.store.project.settings.defaultSillHeight}"`, w.sill)}
      <p class="hint">Pieces taller than the sill that stand in front of the window are flagged.</p>
      <div class="form-actions"><button class="danger" data-action="delete-window" data-id="${w.id}">Delete</button></div>
    </div>`;
  }

  private polygonForm(type: "room" | "fixture", r: Room | Fixture): string {
    const b = bounds(r.polygon);
    const isRect = r.polygon.length === 4 && r.polygon.every((p, i) => {
      const q = r.polygon[(i + 1) % 4];
      return p.x === q.x || p.y === q.y;
    });
    return `<div class="insp">
      <div class="insp-title">${type === "room" ? "Room" : "Fixture"}</div>
      <label>Name <input type="text" data-poly-field="name" data-type="${type}" data-id="${r.id}" value="${esc(r.name)}"></label>
      ${
        isRect
          ? `<div class="row4">
          <label>X <input type="number" data-rect-field="x" data-type="${type}" data-id="${r.id}" value="${n1(b.x)}"></label>
          <label>Y <input type="number" data-rect-field="y" data-type="${type}" data-id="${r.id}" value="${n1(b.y)}"></label>
          <label>W <input type="number" data-rect-field="w" data-type="${type}" data-id="${r.id}" value="${n1(b.w)}"></label>
          <label>H <input type="number" data-rect-field="h" data-type="${type}" data-id="${r.id}" value="${n1(b.h)}"></label>
        </div>`
          : ""
      }
      ${type === "room" ? `<label class="check"><input type="checkbox" data-poly-field="counts" data-type="room" data-id="${r.id}" ${(r as Room).excludeFromArea ? "" : "checked"}> counts toward the square footage</label>
      <label class="check"><input type="checkbox" data-poly-field="outdoor" data-type="room" data-id="${r.id}" ${(r as Room).outdoor ? "checked" : ""}> outdoor (railing instead of walls)</label>` : ""}
      <label>Corners (x, y per line)<textarea data-poly-field="points" data-type="${type}" data-id="${r.id}" rows="${Math.min(10, r.polygon.length + 1)}">${r.polygon.map((p) => `${n1(p.x)}, ${n1(p.y)}`).join("\n")}</textarea></label>
      <div class="form-actions">
        <button data-action="duplicate-poly" data-type="${type}" data-id="${r.id}">Duplicate</button>
        <button class="danger" data-action="delete-poly" data-type="${type}" data-id="${r.id}">Delete</button>
      </div></div>`;
  }

  private passageForm(p: Passage, f: Floor): string {
    const allRooms = this.store.project.floors.flatMap((fl) => fl.rooms.map((r) => ({ id: r.id, label: `${r.name} (${fl.name})` })));
    const roomOpts = (cur: string) =>
      [`<option value="${OUTSIDE}" ${cur === OUTSIDE ? "selected" : ""}>Outside</option>`, ...allRooms.map((r) => `<option value="${r.id}" ${cur === r.id ? "selected" : ""}>${esc(r.label)}</option>`)].join("");
    const pf = (field: string, label: string, value: string | number | undefined, type = "number", step = "1") =>
      `<label>${label} <input type="${type}" step="${step}" data-pass-field="${field}" data-id="${p.id}" value="${value ?? ""}"></label>`;
    const stair = p.stair;
    return `<div class="insp">
      <div class="insp-title">Door / opening</div>
      <label>Name <input type="text" data-pass-field="name" data-id="${p.id}" value="${esc(p.name)}"></label>
      <div class="row3">
        <label>Kind <select data-pass-field="kind" data-id="${p.id}">${PASSAGE_KINDS.map((k) => `<option ${k === p.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        ${pf("width", 'Clear width (")', p.width, "number", "0.5")}
        ${pf("height", 'Height (")', p.height)}
      </div>
      <div class="row4">
        ${pf("ax", "A x", p.a.x)}${pf("ay", "A y", p.a.y)}${pf("bx", "B x", p.b.x)}${pf("by", "B y", p.b.y)}
      </div>
      <div class="row3">
        <label>From <select data-pass-field="room0" data-id="${p.id}">${roomOpts(p.rooms[0])}</select></label>
        <label>To <select data-pass-field="room1" data-id="${p.id}">${roomOpts(p.rooms[1])}</select></label>
      </div>
      ${
        p.kind === "door" || p.kind === "exterior"
          ? `<div class="row3">
        <label>Swings into <select data-pass-field="swingInto" data-id="${p.id}">
          <option value="" ${!p.swingInto ? "selected" : ""}>no swing</option>
          ${p.rooms.map((r) => `<option value="${r}" ${p.swingInto === r ? "selected" : ""}>${esc(f.rooms.find((x) => x.id === r)?.name ?? r)}</option>`).join("")}
        </select></label>
        <label>Hinge at <select data-pass-field="hinge" data-id="${p.id}"><option value="a" ${p.hinge !== "b" ? "selected" : ""}>A</option><option value="b" ${p.hinge === "b" ? "selected" : ""}>B</option></select></label>
      </div>`
          : ""
      }
      ${
        p.kind === "stair"
          ? `<h4>Stair</h4><div class="row3">
        ${pf("stairWidth", 'Run width (")', stair?.width ?? 36)}
        ${pf("headroom", 'Headroom (")', stair?.headroom ?? 80)}
      </div>
      <label class="check"><input type="checkbox" data-pass-field="hasTurn" data-id="${p.id}" ${stair?.turn ? "checked" : ""}> has a landing turn</label>
      ${stair?.turn ? `<div class="row3">${pf("turnA", 'Turn width A (")', stair.turn.a)}${pf("turnB", 'Turn width B (")', stair.turn.b)}</div>` : ""}
      <div class="row4">
        ${pf("lax", "Land A x", stair?.landingA.x)}${pf("lay", "Land A y", stair?.landingA.y)}${pf("lbx", "Land B x", stair?.landingB.x)}${pf("lby", "Land B y", stair?.landingB.y)}
      </div>
      <p class="hint">Landing A is where you step off in the "From" room, B in the "To" room. Drag the circles on each floor.</p>`
          : ""
      }
      <div class="form-actions"><button class="danger" data-action="delete-passage" data-id="${p.id}">Delete</button></div>
    </div>`;
  }

  // ---------------------------------------------------------------- events

  private onHover(e: Event, over: boolean): void {
    const li = (e.target as Element).closest<HTMLElement>("[data-issue]");
    if (!li) return;
    const id = over ? li.dataset.issue! : null;
    if (this.store.hoverIssueId !== id) {
      this.store.hoverIssueId = id;
      this.store.touch();
    }
  }

  private onClick(e: Event): void {
    const el = (e.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const s = this.store;
    const id = el.dataset.id ?? "";
    switch (el.dataset.action) {
      case "floor":
        s.update((p) => (p.activeFloorId = id));
        s.selection = null;
        s.touch();
        break;
      case "mode":
        s.mode = el.dataset.id as "layout" | "edit";
        s.selection = null;
        s.placing = null;
        s.touch();
        break;
      case "undo":
        s.undo();
        break;
      case "redo":
        s.redo();
        break;
      case "fit":
        this.canvas.fit();
        break;
      case "export":
        this.export();
        break;
      case "reset":
        if (confirm("Replace everything with the traced apartment and the measured furniture list? Your layout will be lost.")) s.replaceProject(defaultProject());
        break;
      case "place":
        s.placing = { itemId: id, rotation: 0 };
        s.selection = null;
        s.touch();
        break;
      case "cancel-place":
        s.placing = null;
        s.touch();
        break;
      case "edit-item":
        this.editingItemId = id;
        this.addingItem = false;
        s.touch();
        break;
      case "add-item":
        this.addingItem = true;
        this.editingItemId = null;
        s.touch();
        break;
      case "cancel-item":
        this.editingItemId = null;
        this.addingItem = false;
        s.touch();
        break;
      case "save-item":
        e.preventDefault();
        this.saveItem(el.closest("form")!, id);
        break;
      case "delete-item":
        if (confirm("Delete this piece of furniture and its placements?"))
          s.update((p) => {
            p.furniture = p.furniture.filter((f) => f.id !== id);
            p.placements = p.placements.filter((pl) => pl.itemId !== id);
          });
        this.editingItemId = null;
        s.touch();
        break;
      case "rotate":
        this.canvas.rotate(id);
        break;
      case "duplicate": {
        const pl = s.placement(id);
        if (!pl) break;
        const nid = uid("pl");
        s.update((p) => p.placements.push({ ...pl, id: nid, x: pl.x + 12, y: pl.y + 12 }));
        s.selection = { type: "placement", id: nid };
        s.touch();
        break;
      }
      case "remove":
        s.update((p) => (p.placements = p.placements.filter((pl) => pl.id !== id)));
        s.selection = null;
        s.touch();
        break;
      case "focus-issue":
        if (id) {
          s.selection = { type: "placement", id };
          s.touch();
        }
        break;
      case "select":
        s.selection = { type: el.dataset.type as "room", id };
        s.touch();
        break;
      case "add-floor": {
        const fid = uid("floor");
        s.update((p) => {
          p.floors.push({ id: fid, name: `Floor ${p.floors.length + 1}`, width: 258, height: 480, rooms: [{ id: uid("room"), name: "Room", polygon: rect(6, 6, 144, 132) }], fixtures: [], passages: [], windows: [] });
          p.activeFloorId = fid;
        });
        break;
      }
      case "delete-floor":
        if (s.project.floors.length > 1 && confirm(`Delete ${s.floor.name} and everything placed on it?`)) {
          const fid = s.floor.id;
          s.update((p) => {
            p.floors = p.floors.filter((f) => f.id !== fid);
            p.placements = p.placements.filter((pl) => pl.floorId !== fid);
            p.activeFloorId = p.floors[0].id;
          });
          s.selection = null;
          s.touch();
        }
        break;
      case "add-room":
      case "add-fixture": {
        const isRoom = el.dataset.action === "add-room";
        const nid = uid(isRoom ? "room" : "fix");
        const c = this.viewCentre();
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          const poly = isRoom ? rect(c.x - 48, c.y - 48, 96, 96) : rect(c.x - 18, c.y - 12, 36, 24);
          if (isRoom) f.rooms.push({ id: nid, name: "New room", polygon: poly });
          else f.fixtures.push({ id: nid, name: "Fixture", polygon: poly });
        });
        s.selection = { type: isRoom ? "room" : "fixture", id: nid };
        s.touch();
        break;
      }
      case "add-passage": {
        const nid = uid("door");
        const c = this.viewCentre();
        const first = s.floor.rooms[0]?.id ?? OUTSIDE;
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          f.passages.push({ id: nid, name: "New door", kind: "door", floorId: f.id, a: { x: c.x - 15, y: c.y }, b: { x: c.x + 15, y: c.y }, width: 30, height: 80, rooms: [first, OUTSIDE], swingInto: first, hinge: "a" });
        });
        s.selection = { type: "passage", id: nid };
        s.touch();
        break;
      }
      case "delete-poly": {
        const type = el.dataset.type;
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          if (type === "room") f.rooms = f.rooms.filter((r) => r.id !== id);
          else f.fixtures = f.fixtures.filter((r) => r.id !== id);
        });
        s.selection = null;
        s.touch();
        break;
      }
      case "duplicate-poly": {
        const type = el.dataset.type;
        const nid = uid(type === "room" ? "room" : "fix");
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          const list = type === "room" ? f.rooms : f.fixtures;
          const src = list.find((r) => r.id === id);
          if (!src) return;
          list.push({ ...structuredClone(src), id: nid, name: `${src.name} copy`, polygon: src.polygon.map((q) => ({ x: q.x + 12, y: q.y + 12 })) });
        });
        s.selection = { type: type as "room", id: nid };
        s.touch();
        break;
      }
      case "delete-passage":
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          f.passages = f.passages.filter((x) => x.id !== id);
        });
        s.selection = null;
        s.touch();
        break;
      case "add-window": {
        const nid = uid("win");
        const c = this.viewCentre();
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          f.windows.push({ id: nid, name: "Window", a: { x: c.x - 18, y: c.y }, b: { x: c.x + 18, y: c.y } });
        });
        s.selection = { type: "window", id: nid };
        s.touch();
        break;
      }
      case "delete-window":
        s.update((p) => {
          const f = p.floors.find((x) => x.id === s.floor.id)!;
          f.windows = f.windows.filter((x) => x.id !== id);
        });
        s.selection = null;
        s.touch();
        break;
      case "solve":
        this.solve();
        break;
      case "solver-pick-none":
        this.solverPicks = new Map();
        s.touch();
        break;
    }
  }

  private viewCentre(): Point {
    const v = this.store.views.get(this.store.floor.id);
    const host = this.canvas["host"] as HTMLElement;
    if (!v) return { x: this.store.floor.width / 2, y: this.store.floor.height / 2 };
    return { x: (host.clientWidth / 2 - v.tx) / v.scale, y: (host.clientHeight / 2 - v.ty) / v.scale };
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    if (el.dataset.field === "project-name") {
      this.store.project.name = el.value;
      document.title = `${el.value} · Floorplan`;
    }
  }

  private onChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const s = this.store;
    const d = el.dataset;
    if (d.field === "project-name") {
      s.update((p) => (p.name = el.value));
      return;
    }
    if (d.field === "showZones" || d.field === "showGrid") {
      s[d.field] = (el as HTMLInputElement).checked;
      s.touch();
      return;
    }
    if (d.field === "walkOverlay") {
      s.walkOverlay = el.value as "none";
      s.touch();
      return;
    }
    if (d.field === "import") {
      const file = (el as HTMLInputElement).files?.[0];
      if (file) this.import(file);
      return;
    }
    if (d.field === "solver-room") {
      this.solverRoomId = el.value;
      this.solverPicks = this.picksFromRoom(el.value);
      this.solverMessage = "";
      s.touch();
      return;
    }
    if (d.solverItem) {
      const item = s.item(d.solverItem);
      if ((el as HTMLInputElement).checked) this.solverPicks.set(d.solverItem, item?.quantity ?? 1);
      else this.solverPicks.delete(d.solverItem);
      s.touch();
      return;
    }
    if (d.solverCount) {
      const item = s.item(d.solverCount);
      const n = Math.max(1, Math.min(item?.quantity ?? 1, Math.round(Number(el.value) || 1)));
      this.solverPicks.set(d.solverCount, n);
      s.touch();
      return;
    }
    if (d.winField) {
      const id = d.id!;
      s.update((p) => {
        const f = p.floors.find((x) => x.id === s.floor.id)!;
        const w = f.windows.find((x) => x.id === id);
        if (!w) return;
        const num = () => Number(el.value) || 0;
        switch (d.winField) {
          case "name":
            w.name = el.value;
            break;
          case "sill":
            w.sill = el.value === "" ? undefined : Math.max(0, num());
            break;
          case "ax":
            w.a = { ...w.a, x: num() };
            break;
          case "ay":
            w.a = { ...w.a, y: num() };
            break;
          case "bx":
            w.b = { ...w.b, x: num() };
            break;
          case "by":
            w.b = { ...w.b, y: num() };
            break;
        }
      });
      return;
    }
    if (d.setting) {
      const key = d.setting as keyof Project["settings"];
      s.update((p) => {
        if (key === "bedBothSides") p.settings.bedBothSides = (el as HTMLInputElement).checked;
        else (p.settings as unknown as Record<string, number>)[key] = clampNum(el.value, key === "cellSize" ? 0.5 : 0);
      });
      return;
    }
    if (d.plField) {
      const id = d.id!;
      s.update((p) => {
        const pl = p.placements.find((x) => x.id === id);
        if (!pl) return;
        if (d.plField === "rotation") pl.rotation = Number(el.value) as 0;
        else pl[d.plField as "x" | "y"] = Number(el.value) || 0;
      });
      return;
    }
    if (d.floorField) {
      s.update((p) => {
        const f = p.floors.find((x) => x.id === s.floor.id)!;
        if (d.floorField === "name") f.name = el.value;
        else f[d.floorField as "width" | "height"] = Math.max(24, Number(el.value) || 24);
      });
      return;
    }
    if (d.polyField || d.rectField) {
      const type = d.type as "room" | "fixture";
      const id = d.id!;
      s.update((p) => {
        const f = p.floors.find((x) => x.id === s.floor.id)!;
        const target = (type === "room" ? f.rooms : f.fixtures).find((r) => r.id === id);
        if (!target) return;
        if (d.polyField === "name") target.name = el.value;
        else if (d.polyField === "counts") (target as Room).excludeFromArea = !(el as HTMLInputElement).checked || undefined;
        else if (d.polyField === "outdoor") (target as Room).outdoor = (el as HTMLInputElement).checked || undefined;
        else if (d.polyField === "points") {
          const pts = el.value
            .split(/\n/)
            .map((line) => line.split(/[,\s]+/).filter(Boolean).map(Number))
            .filter((xy) => xy.length >= 2 && xy.every((v) => Number.isFinite(v)))
            .map(([x, y]) => ({ x, y }));
          if (pts.length >= 3) target.polygon = pts;
        } else if (d.rectField) {
          const b = bounds(target.polygon);
          const v = Number(el.value) || 0;
          const nb = { ...b, [d.rectField]: d.rectField === "w" || d.rectField === "h" ? Math.max(1, v) : v };
          target.polygon = rect(nb.x, nb.y, nb.w, nb.h);
        }
      });
      return;
    }
    if (d.passField) {
      const id = d.id!;
      s.update((p) => {
        const f = p.floors.find((x) => x.id === s.floor.id)!;
        const pass = f.passages.find((x) => x.id === id);
        if (!pass) return;
        applyPassageField(pass, d.passField!, el);
      });
    }
  }

  private saveItem(form: HTMLFormElement, id: string): void {
    const fd = new FormData(form);
    const num = (k: string, fallback: number) => {
      const v = Number(fd.get(k));
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    const fc = String(fd.get("frontClearance") ?? "").trim();
    const data: Omit<FurnitureItem, "id"> = {
      name: String(fd.get("name") || "Item").trim(),
      set: String(fd.get("set") || "Other").trim(),
      kind: (String(fd.get("kind")) as FurnitureKind) || "other",
      d: num("d", 20),
      w: num("w", 36),
      h: num("h", 30),
      quantity: Math.max(1, Math.round(num("quantity", 1))),
      frontClearance: fc === "" ? undefined : Math.max(0, Number(fc) || 0),
      disassembles: fd.get("disassembles") === "on",
      allowInBedZone: fd.get("allowInBedZone") === "on",
      keepUpright: fd.get("keepUpright") === "on",
    };
    this.store.update((p) => {
      if (id === "new") p.furniture.push({ id: uid("item"), ...data });
      else {
        const item = p.furniture.find((f) => f.id === id);
        if (item) Object.assign(item, data);
        // Drop surplus placements if the quantity went down.
        const placed = p.placements.filter((pl) => pl.itemId === id);
        if (placed.length > data.quantity) {
          const drop = new Set(placed.slice(data.quantity).map((pl) => pl.id));
          p.placements = p.placements.filter((pl) => !drop.has(pl.id));
        }
      }
    });
    this.editingItemId = null;
    this.addingItem = false;
    this.store.touch();
  }

  private export(): void {
    const p = this.store.project;
    const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^\w.-]+/g, "_") || "floorplan"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async import(file: File): Promise<void> {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (!json || !Array.isArray(json.floors)) throw new Error("not a floorplan file");
      this.store.replaceProject(normalize(json));
    } catch (err) {
      alert(`Couldn't import that file: ${(err as Error).message}`);
    }
  }
}

function clampNum(v: string, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, n) : min;
}

function applyPassageField(pass: Passage, field: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const num = () => Number(el.value) || 0;
  switch (field) {
    case "name":
      pass.name = el.value;
      break;
    case "kind":
      pass.kind = el.value as PassageKind;
      if (pass.kind === "stair" && !pass.stair) {
        pass.stair = { width: pass.width || 36, turn: { a: 36, b: 36 }, headroom: 80, landingA: { x: pass.a.x - 24, y: pass.a.y }, landingB: { x: pass.b.x - 24, y: pass.b.y } };
      }
      if (pass.kind !== "door" && pass.kind !== "exterior") pass.swingInto = undefined;
      break;
    case "width":
      pass.width = Math.max(1, num());
      break;
    case "height":
      pass.height = el.value === "" ? undefined : Math.max(1, num());
      break;
    case "ax":
      pass.a = { ...pass.a, x: num() };
      break;
    case "ay":
      pass.a = { ...pass.a, y: num() };
      break;
    case "bx":
      pass.b = { ...pass.b, x: num() };
      break;
    case "by":
      pass.b = { ...pass.b, y: num() };
      break;
    case "room0":
      pass.rooms = [el.value, pass.rooms[1]];
      break;
    case "room1":
      pass.rooms = [pass.rooms[0], el.value];
      break;
    case "swingInto":
      pass.swingInto = el.value || undefined;
      if (pass.swingInto && !pass.hinge) pass.hinge = "a";
      break;
    case "hinge":
      pass.hinge = el.value as "a" | "b";
      break;
    case "stairWidth":
      if (pass.stair) pass.stair.width = Math.max(1, num());
      break;
    case "headroom":
      if (pass.stair) pass.stair.headroom = Math.max(1, num());
      break;
    case "hasTurn":
      if (pass.stair) pass.stair.turn = (el as HTMLInputElement).checked ? { a: pass.stair.width, b: pass.stair.width } : undefined;
      break;
    case "turnA":
      if (pass.stair?.turn) pass.stair.turn.a = Math.max(1, num());
      break;
    case "turnB":
      if (pass.stair?.turn) pass.stair.turn.b = Math.max(1, num());
      break;
    case "lax":
      if (pass.stair) pass.stair.landingA.x = num();
      break;
    case "lay":
      if (pass.stair) pass.stair.landingA.y = num();
      break;
    case "lbx":
      if (pass.stair) pass.stair.landingB.x = num();
      break;
    case "lby":
      if (pass.stair) pass.stair.landingB.y = num();
      break;
  }
  if (["ax", "ay", "bx", "by"].includes(field)) pass.width = Math.round(Math.hypot(pass.b.x - pass.a.x, pass.b.y - pass.a.y) * 4) / 4 || pass.width;
}

function describeFail(route: { ok: boolean; tightest?: { passage: Passage; margin: number; how: string } } | undefined): string {
  if (!route) return "no route";
  const t = route.tightest;
  if (!t) return "no route";
  return `${t.passage.name} is ${Math.round(-t.margin * 10) / 10}" too small (best try: ${t.how})`;
}

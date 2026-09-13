import type { FurnitureItem, Placement, Project, Room } from "../types";
import { accessZones, analyzeFloor, doorSwing, type Issue } from "./analysis";
import { bounds, convexPolygonsOverlap, doorSwingPolygon, footprint, pointInPolygon, rectToPolygon, rectsOverlap, type Rect } from "./geometry";
import { buildGrid, idx, passageRect, type Grid } from "./grid";
import { transportReport } from "./transport";

export interface SolveRequest {
  project: Project;
  floorId: string;
  roomId: string;
  picks: { itemId: string; count: number }[];
  /** Random restarts; more is slower but better. */
  restarts?: number;
  seed?: number;
}

export interface SolveResult {
  placements: Placement[];
  unplaced: { itemId: string; name: string; reason: string }[];
  /** Pieces that could only go somewhere that breaks a rule, with the problems they cause. */
  compromises: { itemId: string; name: string; problems: string[] }[];
  score: number;
}

/** A piece whose best spot adds more than this much penalty is a compromise. */
const STRICT_LIMIT = 50;

export type Progress = (done: number, total: number) => void;

interface Instance {
  key: string;
  item: FurnitureItem;
  priority: number;
}

interface Edge {
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** Inward normal: which way the room is from this wall. */
  nx: number;
  ny: number;
}

const ROT: Placement["rotation"][] = [0, 90, 180, 270];

/** Direction the back of a piece faces at each rotation (front is the opposite). */
const BACK: Record<number, [number, number]> = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };

const HAS_BACK = new Set(["bed", "dresser", "chest", "cabinet", "shelf", "piano", "sofa", "desk", "nightstand"]);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roomEdges(room: Room): Edge[] {
  const poly = room.polygon;
  const out: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (a.x !== b.x && a.y !== b.y) continue; // only axis-aligned walls get wall-hugging candidates
    const mx = (a.x + b.x) / 2,
      my = (a.y + b.y) / 2;
    const horizontal = a.y === b.y;
    const [nx, ny] = horizontal ? (pointInPolygon({ x: mx, y: my + 1 }, poly) ? [0, 1] : [0, -1]) : pointInPolygon({ x: mx + 1, y: my }, poly) ? [1, 0] : [-1, 0];
    out.push({ a, b, nx, ny });
  }
  return out;
}

function staticFree(g: Grid, r: Rect): boolean {
  const x0 = Math.max(0, Math.floor(r.x / g.cell)),
    x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w - 0.01) / g.cell));
  const y0 = Math.max(0, Math.floor(r.y / g.cell)),
    y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h - 0.01) / g.cell));
  if (x1 < x0 || y1 < y0) return false;
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (g.blocked[idx(g, cx, cy)]) return false;
  return true;
}

function staticBlockedFraction(g: Grid, r: Rect): number {
  const x0 = Math.max(0, Math.floor(r.x / g.cell)),
    x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w - 0.01) / g.cell));
  const y0 = Math.max(0, Math.floor(r.y / g.cell)),
    y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h - 0.01) / g.cell));
  let n = 0,
    b = 0;
  for (let cy = y0; cy <= y1; cy++)
    for (let cx = x0; cx <= x1; cx++) {
      n++;
      if (g.blocked[idx(g, cx, cy)]) b++;
    }
  return n ? b / n : 1;
}

const ISSUE_WEIGHT = (i: Issue): number => {
  if (i.severity === "error") return 1000;
  const kind = i.id.split(":")[0];
  switch (kind) {
    case "main":
      return 120;
    case "reach":
      return 90;
    case "swing":
      return 50;
    case "zone":
      return 45;
    case "window":
      return 30;
    default:
      return 40;
  }
};

/**
 * Arrange the picked pieces inside one room. Existing placements of other
 * pieces stay where they are and act as obstacles; existing placements of the
 * picked pieces (on any floor) are replaced.
 */
export function solveRoom(req: SolveRequest, progress?: Progress): SolveResult {
  const project = req.project;
  const s = project.settings;
  const floorMaybe = project.floors.find((f) => f.id === req.floorId);
  const roomMaybe = floorMaybe?.rooms.find((r) => r.id === req.roomId);
  if (!floorMaybe || !roomMaybe) return { placements: [], unplaced: [], compromises: [], score: Infinity };
  const floor = floorMaybe;
  const room = roomMaybe;
  const items = new Map(project.furniture.map((f) => [f.id, f]));
  const picked = new Set(req.picks.map((p) => p.itemId));
  const fixed = project.placements.filter((p) => !picked.has(p.itemId));
  const fixedOnFloor = fixed.filter((p) => p.floorId === floor.id && items.has(p.itemId));
  const staticGrid = buildGrid(floor, s.cellSize, []);
  const edges = roomEdges(room);
  const roomB = bounds(room.polygon);
  const roomCentre = { x: roomB.x + roomB.w / 2, y: roomB.y + roomB.h / 2 };

  // Doors and swings on this floor that must stay clear.
  const doorRects: Rect[] = [];
  const doorZones: Rect[] = [];
  const swings: ReturnType<typeof doorSwingPolygon>[] = [];
  for (const p of floor.passages) {
    if (p.kind === "stair") continue;
    if (p.kind === "opening" && p.width >= 48) continue;
    doorRects.push(passageRect(p, 6));
    doorZones.push(passageRect(p, s.mainPathWidth));
    const sw = doorSwing(p, floor);
    if (sw) swings.push(sw);
  }
  const landings: { x: number; y: number }[] = [];
  const roomIds = new Set(floor.rooms.map((r) => r.id));
  for (const f of project.floors)
    for (const p of f.passages) {
      if (p.kind !== "stair" || !p.stair) continue;
      if (roomIds.has(p.rooms[0])) landings.push(p.stair.landingA);
      if (roomIds.has(p.rooms[1])) landings.push(p.stair.landingB);
    }
  const windows = (floor.windows ?? []).map((w) => ({ rect: passageRect(w, 8), sill: w.sill ?? s.defaultSillHeight }));

  // Instances, checked for transport first.
  const unplaced: SolveResult["unplaced"] = [];
  const instances: Instance[] = [];
  for (const pick of req.picks) {
    const item = items.get(pick.itemId);
    if (!item) continue;
    const rep = transportReport(project.floors, item, s);
    const route = rep.rooms.get(room.id);
    if (!rep.disassembles && (!route || !route.ok)) {
      const t = route?.tightest;
      unplaced.push({ itemId: item.id, name: item.name, reason: t ? `can't be carried in: ${t.passage.name} is ${Math.round(-t.margin)}" too small` : "no route into the room" });
      continue;
    }
    const priority = item.kind === "bed" ? 0 : item.kind === "nightstand" ? 1 : item.kind === "piano" ? 2 : item.kind === "table" || item.kind === "sofa" ? 3 : 5;
    for (let i = 0; i < Math.min(pick.count, item.quantity); i++) instances.push({ key: `${item.id}#${i}`, item, priority });
  }
  instances.sort((a, b) => a.priority - b.priority || b.item.d * b.item.w - a.item.d * a.item.w);
  const nightstandNeed = Math.min(2, instances.filter((i) => i.item.kind === "nightstand").length);

  const restarts = Math.max(1, req.restarts ?? 2);
  const total = restarts * instances.length * 2;
  let done = 0;
  const tick = (): void => {
    done++;
    progress?.(done, total);
  };

  const rand = mulberry32(req.seed ?? 1);
  let best: { placements: Placement[]; unplaced: Instance[]; compromised: Set<string>; score: number } | null = null;

  for (let r = 0; r < restarts; r++) {
    // Shuffle within priority groups so restarts explore different orders.
    const order = [...instances].sort((a, b) => a.priority - b.priority || rand() - 0.5);
    const offset = Math.floor(rand() * 4);
    const state = run(order, offset);
    if (!best || state.unplaced.length < best.unplaced.length || (state.unplaced.length === best.unplaced.length && state.score < best.score)) best = state;
  }

  for (const inst of best!.unplaced) unplaced.push({ itemId: inst.item.id, name: inst.item.name, reason: "no spot that keeps doors, walkways, and clearances free" });

  // Explain the compromises using the real rule messages for the final layout.
  const compromises: SolveResult["compromises"] = [];
  if (best!.compromised.size) {
    const tmp: Project = { ...project, placements: [...fixed, ...best!.placements] };
    const fa = analyzeFloor(tmp, floor, staticGrid);
    for (const key of best!.compromised) {
      const pl = best!.placements.find((p) => p.id === `auto-${key}`);
      if (!pl) continue;
      const item = items.get(pl.itemId)!;
      const problems = fa.issues
        .filter((i) => i.placementIds.includes(pl.id))
        .map((i) => i.message.replace(`${item.name}: `, "").replace(/\.$/, "").replace(/^\w/, (c) => c.toLowerCase()));
      if (problems.length) compromises.push({ itemId: item.id, name: item.name, problems });
    }
  }
  return { placements: best!.placements, unplaced, compromises, score: best!.score };

  // ---------------------------------------------------------------- search

  function run(order: Instance[], offset: number): { placements: Placement[]; unplaced: Instance[]; compromised: Set<string>; score: number } {
    const placed = new Map<string, Placement>();
    const failed: Instance[] = [];
    const compromised = new Set<string>();
    let score = fullScore([]);
    // Round 1: pieces that fit cleanly. Round 2: the rest, best effort, so they don't steal good spots.
    const deferred: Instance[] = [];
    for (const inst of order) {
      const r = placeOne(inst, placed, offset);
      if (r && r.score - score <= STRICT_LIMIT) {
        placed.set(inst.key, r.placement);
        score = r.score;
      } else deferred.push(inst);
      tick();
    }
    for (const inst of deferred) {
      const r = placeOne(inst, placed, offset);
      if (r) {
        placed.set(inst.key, r.placement);
        score = r.score;
        compromised.add(inst.key);
      } else failed.push(inst);
    }
    // One improvement pass: re-seat each piece given all the others.
    for (const inst of order) {
      const cur = placed.get(inst.key);
      if (!cur) {
        tick();
        continue;
      }
      placed.delete(inst.key);
      const without = fullScore([...placed.values()]) + softTotal([...placed.values()], placed);
      const r = placeOne(inst, placed, offset);
      if (r && r.score <= score) {
        placed.set(inst.key, r.placement);
        score = r.score;
        if (r.score - without <= STRICT_LIMIT) compromised.delete(inst.key);
        else compromised.add(inst.key);
      } else placed.set(inst.key, cur);
      tick();
    }
    // Pairing repair: a nightstand stranded away from its bed usually means another
    // piece is sitting where the nightstand's walkway would be. Try moving that
    // piece and re-seating the nightstand together.
    for (const inst of order) {
      if (inst.item.kind !== "nightstand") continue;
      const cur = placed.get(inst.key);
      if (!cur || pairedWithBed(cur, placed)) continue;
      for (const other of order) {
        if (other === inst || other.item.kind === "bed" || other.item.kind === "nightstand") continue;
        const otherCur = placed.get(other.key);
        if (!otherCur) continue;
        placed.delete(inst.key);
        placed.delete(other.key);
        const n = placeOne(inst, placed, offset);
        if (n) placed.set(inst.key, n.placement);
        const o = placeOne(other, placed, offset);
        if (o) placed.set(other.key, o.placement);
        const trial = n && o ? o.score : Infinity;
        if (n && o && pairedWithBed(n.placement, placed) && trial <= score + STRICT_LIMIT) {
          score = trial;
          compromised.delete(inst.key);
          if (o.score - (trial - 0) > STRICT_LIMIT) compromised.add(other.key);
          break;
        }
        placed.set(inst.key, cur);
        placed.set(other.key, otherCur);
      }
    }
    return { placements: [...placed.values()], unplaced: failed, compromised, score };
  }

  function pairedWithBed(ns: Placement, placed: Map<string, Placement>): boolean {
    const fp = footprint(ns, items.get(ns.itemId)!);
    for (const p of placed.values()) {
      const bi = items.get(p.itemId)!;
      if (bi.kind !== "bed") continue;
      const bf = footprint(p, bi);
      if (p.rotation === ns.rotation && rectsOverlap(fp, { x: bf.x - 3, y: bf.y - 3, w: bf.w + 6, h: bf.h + 6 })) return true;
    }
    return false;
  }

  /** Thin strip just behind a piece's back edge; all wall means the piece is backed against a wall. */
  function backStrip(fp: Rect, rotation: Placement["rotation"]): Rect {
    const d = staticGrid.cell;
    switch (rotation) {
      case 0:
        return { x: fp.x, y: fp.y - d, w: fp.w, h: d };
      case 180:
        return { x: fp.x, y: fp.y + fp.h, w: fp.w, h: d };
      case 90:
        return { x: fp.x + fp.w, y: fp.y, w: d, h: fp.h };
      case 270:
        return { x: fp.x - d, y: fp.y, w: d, h: fp.h };
    }
  }

  function backOnWall(fp: Rect, rotation: Placement["rotation"]): boolean {
    const strip = backStrip(fp, rotation);
    if (strip.x < 0 || strip.y < 0 || strip.x + strip.w > floor.width || strip.y + strip.h > floor.height) return true;
    return staticBlockedFraction(staticGrid, strip) >= 0.99;
  }

  /** How many of the wanted nightstand spots beside this bed's head are actually usable. */
  function nightstandSpots(bed: Placement, others: Placement[]): number {
    if (!nightstandNeed) return 0;
    const ns = instances.find((i) => i.item.kind === "nightstand")!.item;
    const bedItem = items.get(bed.itemId)!;
    const bf = footprint(bed, bedItem);
    const rot = bed.rotation;
    const nf = footprint({ id: "", itemId: ns.id, floorId: floor.id, x: 0, y: 0, rotation: rot }, ns);
    const spots: [number, number][] =
      rot === 0
        ? [
            [bf.x - nf.w, bf.y],
            [bf.x + bf.w, bf.y],
          ]
        : rot === 180
          ? [
              [bf.x - nf.w, bf.y + bf.h - nf.h],
              [bf.x + bf.w, bf.y + bf.h - nf.h],
            ]
          : rot === 90
            ? [
                [bf.x + bf.w - nf.w, bf.y - nf.h],
                [bf.x + bf.w - nf.w, bf.y + bf.h],
              ]
            : [
                [bf.x, bf.y - nf.h],
                [bf.x, bf.y + bf.h],
              ];
    // The nightstands themselves don't block their own spots.
    const blockers = others.filter((o) => items.get(o.itemId)?.kind !== "nightstand");
    let n = 0;
    for (const [x, y] of spots) if (hardOk({ id: "", itemId: ns.id, floorId: floor.id, x, y, rotation: rot }, ns, [...blockers, bed])) n++;
    return Math.min(n, nightstandNeed);
  }

  function placeOne(inst: Instance, placed: Map<string, Placement>, offset: number): { placement: Placement; score: number } | null {
    const others = [...fixedOnFloor, ...placed.values()];
    const cands = candidates(inst, placed, offset).filter((c) => hardOk(c, inst.item, others));
    const scored = cands.map((c) => ({ c, s: fastScore(c, inst.item, others, placed) }));
    scored.sort((a, b) => a.s - b.s);
    // Shortlist with variety: skip near-duplicates of a spot already chosen so
    // every wall gets a full evaluation, not just the wall with the most spots.
    const top: typeof scored = [];
    for (const cand of scored) {
      if (top.length >= 8) break;
      const dup = top.some((t) => t.c.rotation === cand.c.rotation && Math.abs(t.c.x - cand.c.x) < 18 && Math.abs(t.c.y - cand.c.y) < 18);
      if (!dup) top.push(cand);
    }
    let bestP: Placement | null = null;
    let bestS = Infinity;
    for (const t of top) {
      const cur = [...placed.values(), t.c];
      const sc = fullScore(cur) + softTotal(cur, placed);
      if (sc < bestS) {
        bestS = sc;
        bestP = t.c;
      }
    }
    return bestP ? { placement: bestP, score: bestS } : null;
  }

  function candidates(inst: Instance, placed: Map<string, Placement>, offset: number): Placement[] {
    const item = inst.item;
    const out: Placement[] = [];
    const mk = (x: number, y: number, rotation: Placement["rotation"]): Placement => ({ id: `auto-${inst.key}`, itemId: item.id, floorId: floor.id, x, y, rotation });
    const withBack = HAS_BACK.has(item.kind);
    const step = 4;

    // Nightstands go beside a bed's head.
    if (item.kind === "nightstand") {
      for (const p of placed.values()) {
        const bedItem = items.get(p.itemId)!;
        if (bedItem.kind !== "bed") continue;
        const bf = footprint(p, bedItem);
        const rot = p.rotation;
        const nf = footprint({ ...mk(0, 0, rot) }, item);
        for (const gap of [0, 2]) {
          switch (rot) {
            case 0:
              out.push(mk(bf.x - nf.w - gap, bf.y, rot), mk(bf.x + bf.w + gap, bf.y, rot));
              break;
            case 180:
              out.push(mk(bf.x - nf.w - gap, bf.y + bf.h - nf.h, rot), mk(bf.x + bf.w + gap, bf.y + bf.h - nf.h, rot));
              break;
            case 90:
              out.push(mk(bf.x + bf.w - nf.w, bf.y - nf.h - gap, rot), mk(bf.x + bf.w - nf.w, bf.y + bf.h + gap, rot));
              break;
            case 270:
              out.push(mk(bf.x, bf.y - nf.h - gap, rot), mk(bf.x, bf.y + bf.h + gap, rot));
              break;
          }
        }
      }
    }

    for (const rot of ROT) {
      const f = footprint(mk(0, 0, rot), item);
      const [bx, by] = BACK[rot];
      const wallCands: Placement[] = [];
      for (const e of edges) {
        // The wall must be on the piece's back side (for pieces that have one).
        if (withBack && !(bx === -e.nx && by === -e.ny)) continue;
        const horizontal = e.a.y === e.b.y;
        if (horizontal) {
          const y = e.ny > 0 ? e.a.y : e.a.y - f.h;
          const x0 = Math.min(e.a.x, e.b.x),
            x1 = Math.max(e.a.x, e.b.x) - f.w;
          for (let x = x0 + offset; x <= x1; x += step) wallCands.push(mk(x, y, rot));
          if (x1 >= x0) wallCands.push(mk(x1, y, rot), mk(x0 + (x1 - x0) / 2, y, rot));
        } else {
          const x = e.nx > 0 ? e.a.x : e.a.x - f.w;
          const y0 = Math.min(e.a.y, e.b.y),
            y1 = Math.max(e.a.y, e.b.y) - f.h;
          for (let y = y0 + offset; y <= y1; y += step) wallCands.push(mk(x, y, rot));
          if (y1 >= y0) wallCands.push(mk(x, y1, rot), mk(x, y0 + (y1 - y0) / 2, rot));
        }
      }
      // A room edge shared with an open-plan neighbour isn't a wall: only keep spots with a real wall behind.
      for (const c of wallCands) if (!withBack || backOnWall(footprint(c, item), rot)) out.push(c);
      // Interior candidates for things that live in the middle of a room, or as a fallback.
      if (!withBack || item.kind === "bed") {
        for (let y = roomB.y + offset; y + f.h <= roomB.y + roomB.h; y += 12)
          for (let x = roomB.x + offset; x + f.w <= roomB.x + roomB.w; x += 12) out.push(mk(x, y, rot));
      }
    }
    return out;
  }

  function hardOk(c: Placement, item: FurnitureItem, others: Placement[]): boolean {
    const fp = footprint(c, item);
    const inset = 0.01;
    const corners = [
      { x: fp.x + inset, y: fp.y + inset },
      { x: fp.x + fp.w - inset, y: fp.y + inset },
      { x: fp.x + fp.w - inset, y: fp.y + fp.h - inset },
      { x: fp.x + inset, y: fp.y + fp.h - inset },
    ];
    if (!corners.every((q) => pointInPolygon(q, room.polygon))) return false;
    if (!staticFree(staticGrid, fp)) return false;
    for (const o of others) if (rectsOverlap(fp, footprint(o, items.get(o.itemId)!), s.furnitureGap)) return false;
    for (const d of doorRects) if (rectsOverlap(fp, d)) return false;
    const poly = rectToPolygon(fp);
    for (const sw of swings) if (convexPolygonsOverlap(poly, sw)) return false;
    for (const l of landings) if (l.x > fp.x - 12 && l.x < fp.x + fp.w + 12 && l.y > fp.y - 12 && l.y < fp.y + fp.h + 12) return false;
    return true;
  }

  /** Cheap heuristic used to shortlist candidates before the full analysis. */
  function fastScore(c: Placement, item: FurnitureItem, others: Placement[], placed: Map<string, Placement>): number {
    let sc = 0;
    const fp = footprint(c, item);
    let sideFailures = 0;
    for (const z of accessZones(c, item, s)) {
      let blocked = staticBlockedFraction(staticGrid, z.rect) > 0.02;
      for (const o of others) {
        const oi = items.get(o.itemId)!;
        if (item.kind === "bed" && oi.allowInBedZone) continue;
        if (rectsOverlap(footprint(o, oi), z.rect)) blocked = true;
      }
      if (!blocked) continue;
      if (item.kind === "bed") {
        sideFailures++;
        if (s.bedBothSides || sideFailures === 2) sc += 60;
      } else sc += 45;
    }
    if (item.kind === "bed") sc += 40 * (nightstandNeed - nightstandSpots(c, others));
    for (const o of others) {
      const oi = items.get(o.itemId)!;
      if (oi.kind === "bed" && item.allowInBedZone) continue;
      for (const z of accessZones(o, oi, s)) if (rectsOverlap(fp, z.rect)) sc += 45;
    }
    for (const w of windows) if (rectsOverlap(fp, w.rect)) sc += item.h > w.sill ? 30 : 5;
    for (const d of doorZones) if (rectsOverlap(fp, d)) sc += 15;
    sc += soft(c, item, placed);
    return sc;
  }

  /** Preferences that aren't rules: hug walls, keep tables central, pair nightstands with the bed. */
  function soft(c: Placement, item: FurnitureItem, placed: Map<string, Placement>): number {
    let sc = 0;
    const fp = footprint(c, item);
    if (HAS_BACK.has(item.kind)) sc += backOnWall(fp, c.rotation) ? -12 : 20;
    if (item.kind === "bed") {
      const others = [...fixedOnFloor, ...[...placed.values()].filter((p) => p.id !== c.id)];
      sc += 40 * (nightstandNeed - nightstandSpots(c, others));
    }
    if (item.kind === "table") sc += 0.15 * Math.hypot(fp.x + fp.w / 2 - roomCentre.x, fp.y + fp.h / 2 - roomCentre.y);
    if (item.kind === "nightstand") {
      let paired = false;
      for (const p of placed.values()) {
        const bi = items.get(p.itemId)!;
        if (bi.kind !== "bed") continue;
        const bf = footprint(p, bi);
        const touching = rectsOverlap(fp, { x: bf.x - 3, y: bf.y - 3, w: bf.w + 6, h: bf.h + 6 });
        if (touching && p.rotation === c.rotation) paired = true;
      }
      sc += paired ? -30 : 15;
    }
    return sc;
  }

  function softTotal(placements: Placement[], placed: Map<string, Placement>): number {
    let sc = 0;
    for (const p of placements) sc += soft(p, items.get(p.itemId)!, placed);
    return sc;
  }

  function fullScore(ours: Placement[]): number {
    const tmp: Project = { ...project, placements: [...fixed, ...ours] };
    const fa = analyzeFloor(tmp, floor, staticGrid);
    const ids = new Set(ours.map((p) => p.id));
    let sc = 0;
    for (const i of fa.issues) {
      const involvesUs = i.placementIds.length === 0 || i.placementIds.some((id) => ids.has(id));
      if (involvesUs) sc += ISSUE_WEIGHT(i);
    }
    return sc;
  }
}

import type { Floor, FurnitureItem, Passage, Settings } from "../types";
import { OUTSIDE } from "./defaults";

export interface PassageCheck {
  passage: Passage;
  ok: boolean;
  /** Smallest margin (inches) across the constraints that passed; negative when it fails. */
  margin: number;
  /** Human description of how the item goes through: "upright, 20" x 48" cross-section". */
  how: string;
}

export interface RouteResult {
  ok: boolean;
  /** Passages along the best route, in order from outside. */
  steps: PassageCheck[];
  /** The tightest passage on the route (or the one that fails). */
  tightest?: PassageCheck;
}

export interface TransportReport {
  item: FurnitureItem;
  disassembles: boolean;
  /** Room id -> route. Only rooms reachable by at least a failing route are listed. */
  rooms: Map<string, RouteResult>;
}

/**
 * Longest rectangle of width `d` that turns a right-angle corner between
 * corridors of widths `a` and `b`. Derived from the classic ladder-around-the-
 * corner problem with the inner edge pivoting on the inside corner:
 * L(θ) = a/sinθ + b/cosθ − d/(sinθ·cosθ), minimised over θ.
 */
export function maxLengthAroundCorner(a: number, b: number, d: number): number {
  if (d >= Math.min(a, b)) return 0;
  let best = Infinity;
  const steps = 720;
  for (let i = 1; i < steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    const s = Math.sin(t),
      c = Math.cos(t);
    const L = a / s + b / c - d / (s * c);
    if (L < best) best = L;
  }
  return Math.max(0, best);
}

/** All (crossWidth, crossHeight, length) orientations of a box. */
function orientations(item: FurnitureItem): { w: number; h: number; l: number; label: string }[] {
  const dims: [number, string][] = [
    [item.d, "depth"],
    [item.w, "width"],
    [item.h, "height"],
  ];
  const out: { w: number; h: number; l: number; label: string }[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      if (i === j) continue;
      // Upright-only pieces keep their height vertical.
      if (item.keepUpright && j !== 2) continue;
      const k = 3 - i - j;
      const [w] = dims[i],
        [h] = dims[j],
        [l, lLabel] = dims[k];
      const upright = j === 2 && k === 0; // height vertical, moving along its depth: normal carry
      out.push({ w, h, l, label: upright ? "upright" : `${lLabel} leading` });
    }
  return out;
}

function checkPassage(p: Passage, item: FurnitureItem, s: Settings): PassageCheck {
  let best: PassageCheck | undefined;
  for (const o of orientations(item)) {
    let margin: number;
    if (p.kind === "stair" && p.stair) {
      const st = p.stair;
      const height = st.headroom ?? s.defaultDoorHeight;
      const m1 = st.width - o.w;
      const m2 = height - o.h;
      let m3 = Infinity;
      if (st.turn) m3 = maxLengthAroundCorner(st.turn.a, st.turn.b, o.w) - o.l;
      margin = Math.min(m1, m2, m3);
    } else {
      // An open-plan boundary imposes no height limit unless one is given (a cased opening with a header).
      const hLimit = p.height ?? (p.kind === "opening" ? Infinity : s.defaultDoorHeight);
      margin = Math.min(p.width - o.w, hLimit - o.h);
    }
    const check: PassageCheck = {
      passage: p,
      ok: margin >= s.transportTolerance,
      margin,
      how: `${o.label}, ${fmt(o.w)} × ${fmt(o.h)} cross-section${p.kind === "stair" && p.stair?.turn ? `, ${fmt(o.l)} long` : ""}`,
    };
    if (!best || check.margin > best.margin) best = check;
  }
  return best!;
}

const fmt = (v: number): string => `${Math.round(v * 10) / 10}"`;

/**
 * Search for the best route from outside to every room, where "best" maximises
 * the tightest margin on the way (widest-path / bottleneck search).
 */
export function transportReport(floors: Floor[], item: FurnitureItem, s: Settings): TransportReport {
  const rooms = new Map<string, RouteResult>();
  if (item.disassembles) return { item, disassembles: true, rooms };

  const passages = floors.flatMap((f) => f.passages);
  const checks = new Map<string, PassageCheck>();
  for (const p of passages) checks.set(p.id, checkPassage(p, item, s));

  // Dijkstra variant: maximise the minimum margin.
  const bestMargin = new Map<string, number>();
  const prev = new Map<string, { room: string; passage: Passage }>();
  bestMargin.set(OUTSIDE, Infinity);
  const open = new Set<string>([OUTSIDE]);
  while (open.size) {
    let cur = "";
    let curM = -Infinity;
    for (const r of open) {
      const m = bestMargin.get(r)!;
      if (m > curM) {
        curM = m;
        cur = r;
      }
    }
    open.delete(cur);
    for (const p of passages) {
      if (!p.rooms.includes(cur)) continue;
      const next = p.rooms[0] === cur ? p.rooms[1] : p.rooms[0];
      const m = Math.min(curM, checks.get(p.id)!.margin);
      if (m > (bestMargin.get(next) ?? -Infinity)) {
        bestMargin.set(next, m);
        prev.set(next, { room: cur, passage: p });
        open.add(next);
      }
    }
  }

  for (const [room] of bestMargin) {
    if (room === OUTSIDE) continue;
    const steps: PassageCheck[] = [];
    let r = room;
    while (r !== OUTSIDE) {
      const link = prev.get(r);
      if (!link) break;
      steps.unshift(checks.get(link.passage.id)!);
      r = link.room;
    }
    let tightest: PassageCheck | undefined;
    for (const st of steps) if (!tightest || st.margin < tightest.margin) tightest = st;
    rooms.set(room, { ok: steps.every((st) => st.ok), steps, tightest });
  }
  return { item, disassembles: false, rooms };
}

export function roomOfPoint(floor: Floor, x: number, y: number): string | undefined {
  for (const r of floor.rooms) {
    if (r.virtual) continue;
    const poly = r.polygon;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const pi = poly[i],
        pj = poly[j];
      if (pi.y > y !== pj.y > y && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
    }
    if (inside) return r.id;
  }
  return undefined;
}

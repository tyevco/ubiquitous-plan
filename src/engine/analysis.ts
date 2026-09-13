import type { Floor, FurnitureItem, Passage, Placement, Project, Settings } from "../types";
import {
  bounds,
  convexPolygonsOverlap,
  doorSwingPolygon,
  footprint,
  frontAccessPoint,
  frontZone,
  pointInPolygon,
  rectIntersection,
  rectToPolygon,
  rectsOverlap,
  sideZones,
  type Rect,
} from "./geometry";
import { buildGrid, cellOf, flood, idx, nearestPassable, passableMask, passageRect, type Grid } from "./grid";
import { transportReport, roomOfPoint, type TransportReport } from "./transport";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  id: string;
  severity: Severity;
  floorId: string;
  /** Placements involved, for highlighting. */
  placementIds: string[];
  /** Optional highlight region. */
  rect?: Rect;
  message: string;
}

export interface FloorAnalysis {
  floorId: string;
  grid: Grid;
  mainMask: Uint8Array;
  mainReach: Uint8Array;
  secondaryMask: Uint8Array;
  secondaryReach: Uint8Array;
  issues: Issue[];
}

export interface Analysis {
  floors: Map<string, FloorAnalysis>;
  transport: Map<string, TransportReport>;
  issues: Issue[];
}

export function itemFrontClearance(item: FurnitureItem, s: Settings): number {
  if (item.frontClearance !== undefined) return item.frontClearance;
  switch (item.kind) {
    case "dresser":
    case "chest":
    case "cabinet":
      return item.d + s.drawerClearance;
    case "nightstand":
      return s.drawerClearance;
    case "shelf":
      return s.secondaryPathWidth;
    case "sofa":
    case "desk":
      return s.tableClearance;
    case "table":
      return s.tableClearance;
    case "piano":
      // Bench plus the player.
      return 42;
    case "bed":
      return 0;
    default:
      return s.secondaryPathWidth;
  }
}

/** Zones around an item that should stay free, with a label for messages. */
export function accessZones(p: Placement, item: FurnitureItem, s: Settings): { rect: Rect; label: string; kind: "front" | "side" | "table" }[] {
  const zones: { rect: Rect; label: string; kind: "front" | "side" | "table" }[] = [];
  if (item.kind === "bed") {
    const [l, r] = sideZones(p, item, s.bedSideClearance);
    zones.push({ rect: l, label: "left side", kind: "side" }, { rect: r, label: "right side", kind: "side" });
    return zones;
  }
  if (item.kind === "table") {
    const f = footprint(p, item);
    const c = s.tableClearance;
    zones.push(
      { rect: { x: f.x - c, y: f.y, w: c, h: f.h }, label: "left side", kind: "table" },
      { rect: { x: f.x + f.w, y: f.y, w: c, h: f.h }, label: "right side", kind: "table" },
      { rect: { x: f.x, y: f.y - c, w: f.w, h: c }, label: "top side", kind: "table" },
      { rect: { x: f.x, y: f.y + f.h, w: f.w, h: c }, label: "bottom side", kind: "table" },
    );
    return zones;
  }
  const depth = itemFrontClearance(item, s);
  if (depth > 0) zones.push({ rect: frontZone(p, item, depth), label: "front", kind: "front" });
  return zones;
}

function staticBlockedInRect(g: Grid, r: Rect, floor: Floor): boolean {
  // Any static (wall/fixture) cell inside r? Static cells are the ones blocked in a furniture-free grid.
  const x0 = Math.max(0, Math.floor(r.x / g.cell)),
    x1 = Math.min(g.cols - 1, Math.floor((r.x + r.w - 0.01) / g.cell));
  const y0 = Math.max(0, Math.floor(r.y / g.cell)),
    y1 = Math.min(g.rows - 1, Math.floor((r.y + r.h - 0.01) / g.cell));
  if (x1 < x0 || y1 < y0) return true;
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (g.blocked[idx(g, cx, cy)]) return true;
  // Also outside the floor bbox.
  return r.x < 0 || r.y < 0 || r.x + r.w > floor.width || r.y + r.h > floor.height;
}

function fractionStaticBlocked(g: Grid, r: Rect): number {
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

export function analyzeFloor(project: Project, floor: Floor, staticGridIn?: Grid): FloorAnalysis {
  const s = project.settings;
  const items = new Map(project.furniture.map((f) => [f.id, f]));
  const placements = project.placements.filter((p) => p.floorId === floor.id && items.has(p.itemId));
  const issues: Issue[] = [];

  const staticGrid = staticGridIn ?? buildGrid(floor, s.cellSize, []);
  const furnPolys = placements.map((p) => rectToPolygon(footprint(p, items.get(p.itemId)!)));
  const grid = buildGrid(floor, s.cellSize, furnPolys);

  const nameOf = (p: Placement): string => items.get(p.itemId)!.name;

  // 1. Furniture over walls / fixtures / outside rooms.
  for (const p of placements) {
    const fp = footprint(p, items.get(p.itemId)!);
    const frac = fractionStaticBlocked(staticGrid, fp);
    if (frac > 0.02) {
      issues.push({
        id: `wall:${p.id}`,
        severity: "error",
        floorId: floor.id,
        placementIds: [p.id],
        rect: fp,
        message: `${nameOf(p)} overlaps a wall or built-in fixture.`,
      });
    }
  }

  // 2. Furniture overlaps.
  for (let i = 0; i < placements.length; i++)
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i],
        b = placements[j];
      const fa = footprint(a, items.get(a.itemId)!),
        fb = footprint(b, items.get(b.itemId)!);
      if (rectsOverlap(fa, fb, s.furnitureGap)) {
        issues.push({
          id: `overlap:${a.id}:${b.id}`,
          severity: "error",
          floorId: floor.id,
          placementIds: [a.id, b.id],
          rect: rectIntersection(fa, fb) ?? fa,
          message: `${nameOf(a)} overlaps ${nameOf(b)}${s.furnitureGap ? ` (need ${s.furnitureGap}" between pieces)` : ""}.`,
        });
      }
    }

  // 3. Door swings and passage openings must stay clear.
  for (const pass of floor.passages) {
    // Open-plan boundaries between rooms aren't doorways; nothing to keep clear.
    if (pass.kind === "stair" || pass.kind === "opening") continue;
    const open = passageRect(pass, 6);
    const swing = doorSwing(pass, floor);
    for (const p of placements) {
      const fp = footprint(p, items.get(p.itemId)!);
      const poly = rectToPolygon(fp);
      if (rectsOverlap(fp, open)) {
        issues.push({
          id: `door:${pass.id}:${p.id}`,
          severity: "error",
          floorId: floor.id,
          placementIds: [p.id],
          rect: open,
          message: `${nameOf(p)} blocks the ${pass.name}.`,
        });
      } else if (swing && convexPolygonsOverlap(poly, swing)) {
        issues.push({
          id: `swing:${pass.id}:${p.id}`,
          severity: "warning",
          floorId: floor.id,
          placementIds: [p.id],
          rect: bounds(swing),
          message: `${nameOf(p)} is in the swing of the ${pass.name}.`,
        });
      }
    }
  }

  // 4. Access zones (drawer clearance, bed sides, table chairs).
  for (const p of placements) {
    const item = items.get(p.itemId)!;
    const zones = accessZones(p, item, s);
    const isBed = item.kind === "bed";
    let sideFailures = 0;
    const fp0 = footprint(p, item);
    const roomId = roomOfPoint(floor, fp0.x + fp0.w / 2, fp0.y + fp0.h / 2);
    const roomBounds = roomId ? bounds(floor.rooms.find((r) => r.id === roomId)!.polygon) : undefined;
    for (const z of zones) {
      const blockers: string[] = [];
      if (staticBlockedInRect(staticGrid, z.rect, floor)) blockers.push("a wall or fixture");
      // Furniture only counts if it's in the part of the zone inside this room (not through a wall).
      const inRoom = roomBounds ? rectIntersection(z.rect, roomBounds) : z.rect;
      for (const q of placements) {
        if (q === p || !inRoom) continue;
        const qi = items.get(q.itemId)!;
        if (isBed && qi.allowInBedZone) continue;
        if (rectsOverlap(footprint(q, qi), inRoom)) blockers.push(qi.name);
      }
      if (!blockers.length) continue;
      if (isBed) {
        sideFailures++;
        if (s.bedBothSides || sideFailures === 2) {
          issues.push({
            id: `zone:${p.id}:${z.label}`,
            severity: "warning",
            floorId: floor.id,
            placementIds: [p.id],
            rect: z.rect,
            message: `${item.name}: the ${z.label} needs ${s.bedSideClearance}" clear but is blocked by ${uniq(blockers).join(", ")}.`,
          });
        }
        continue;
      }
      const need = z.kind === "table" ? s.tableClearance : itemFrontClearance(item, s);
      issues.push({
        id: `zone:${p.id}:${z.label}`,
        severity: "warning",
        floorId: floor.id,
        placementIds: [p.id],
        rect: z.rect,
        message: `${item.name}: ${z.kind === "front" ? `${need}" in front` : `${need}" on the ${z.label}`} is blocked by ${uniq(blockers).join(", ")}.`,
      });
    }
  }

  // 4b. Tall pieces in front of windows.
  for (const w of floor.windows ?? []) {
    const wr = passageRect(w, 8);
    const sill = w.sill ?? s.defaultSillHeight;
    for (const p of placements) {
      const item = items.get(p.itemId)!;
      if (item.h <= sill) continue;
      if (!rectsOverlap(footprint(p, item), wr)) continue;
      issues.push({
        id: `window:${w.id}:${p.id}`,
        severity: "warning",
        floorId: floor.id,
        placementIds: [p.id],
        rect: wr,
        message: `${item.name} (${item.h}" tall) blocks the ${w.name ?? "window"} (sill at ${sill}").`,
      });
    }
  }

  // 5. Walkability: main path between the floor's doors, secondary path to each item.
  const mainMask = passableMask(grid, s.mainPathWidth, floor);
  const secondaryMask = passableMask(grid, s.secondaryPathWidth, floor);
  const anchors = floorAnchors(project, floor);
  const seedsFor = (mask: Uint8Array): { id: string; name: string; cell: number }[] =>
    anchors.map((a) => ({ id: a.passage.id, name: a.passage.name, cell: nearestPassable(grid, mask, a.point.x, a.point.y, a.radius) }));

  const mainSeeds = seedsFor(mainMask);
  const primary = mainSeeds.find((x) => x.cell >= 0);
  const mainReach = flood(grid, mainMask, primary ? [primary.cell] : []);
  if (primary) {
    for (const sd of mainSeeds) {
      if (sd === primary) continue;
      const ok = sd.cell >= 0 && mainReach[sd.cell];
      if (!ok) {
        const anchor = anchors.find((a) => a.passage.id === sd.id)!;
        issues.push({
          id: `main:${sd.id}`,
          severity: "warning",
          floorId: floor.id,
          placementIds: [],
          rect: anchor.passage.kind === "stair" ? { x: anchor.point.x - 12, y: anchor.point.y - 12, w: 24, h: 24 } : passageRect(anchor.passage, 12),
          message: `No ${s.mainPathWidth}" wide path from the ${primary.name} to the ${sd.name}.`,
        });
      }
    }
  }

  const secSeeds = seedsFor(secondaryMask).filter((x) => x.cell >= 0);
  const secondaryReach = flood(
    grid,
    secondaryMask,
    secSeeds.map((x) => x.cell),
  );
  for (const p of placements) {
    const item = items.get(p.itemId)!;
    const zones = accessZones(p, item, s);
    const probes: { x: number; y: number }[] = [];
    if (item.kind === "bed") {
      for (const z of zones) probes.push({ x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 });
    } else if (item.kind === "table") {
      for (const z of zones) probes.push({ x: z.rect.x + z.rect.w / 2, y: z.rect.y + z.rect.h / 2 });
    } else {
      probes.push(frontAccessPoint(p, item, s.secondaryPathWidth / 2 + 1));
    }
    const reached = probes.some((pt) => {
      const c = nearestPassable(grid, secondaryMask, pt.x, pt.y, s.secondaryPathWidth / 2 + 4);
      return c >= 0 && secondaryReach[c];
    });
    if (!reached) {
      const [cx, cy] = cellOf(grid, probes[0].x, probes[0].y);
      issues.push({
        id: `reach:${p.id}`,
        severity: "warning",
        floorId: floor.id,
        placementIds: [p.id],
        rect: { x: cx * grid.cell - 12, y: cy * grid.cell - 12, w: 24, h: 24 },
        message: `${item.name} can't be reached by a ${s.secondaryPathWidth}" wide path from a door.`,
      });
    }
  }

  return { floorId: floor.id, grid, mainMask, mainReach, secondaryMask, secondaryReach, issues };
}

/** Doors, exterior doors, and stair landings on this floor: the points a walking path must connect. */
export function floorAnchors(project: Project, floor: Floor): { passage: Passage; point: { x: number; y: number }; radius: number }[] {
  const out: { passage: Passage; point: { x: number; y: number }; radius: number }[] = [];
  const roomIds = new Set(floor.rooms.map((r) => r.id));
  for (const p of floor.passages) {
    if (p.kind === "opening" || p.kind === "stair") continue;
    out.push({ passage: p, point: { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, radius: project.settings.mainPathWidth });
  }
  for (const f of project.floors)
    for (const p of f.passages) {
      if (p.kind !== "stair" || !p.stair) continue;
      if (roomIds.has(p.rooms[0])) out.push({ passage: p, point: p.stair.landingA, radius: 24 });
      if (roomIds.has(p.rooms[1])) out.push({ passage: p, point: p.stair.landingB, radius: 24 });
    }
  return out;
}

/**
 * The door's swing sector, opening toward whichever side of the wall lies inside
 * the room it swings into (probed just off the door's midpoint, so L-shaped rooms
 * whose bounding-box centre is on the wrong side still get the right answer).
 */
export function doorSwing(pass: Passage, floor: Floor): ReturnType<typeof doorSwingPolygon> | undefined {
  if (!pass.swingInto || !pass.hinge) return undefined;
  const room = floor.rooms.find((r) => r.id === pass.swingInto);
  const mid = { x: (pass.a.x + pass.b.x) / 2, y: (pass.a.y + pass.b.y) / 2 };
  const len = Math.hypot(pass.b.x - pass.a.x, pass.b.y - pass.a.y) || 1;
  const nx = -(pass.b.y - pass.a.y) / len,
    ny = (pass.b.x - pass.a.x) / len;
  let into = { x: mid.x + nx * 8, y: mid.y + ny * 8 };
  if (room) {
    const inside = (p: { x: number; y: number }) => pointInPolygon(p, room.polygon);
    if (!inside(into)) {
      const other = { x: mid.x - nx * 8, y: mid.y - ny * 8 };
      if (inside(other)) into = other;
      else {
        const b = bounds(room.polygon);
        into = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      }
    }
  }
  return doorSwingPolygon(pass.a, pass.b, pass.hinge === "a" ? pass.a : pass.b, into);
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

export function analyze(project: Project): Analysis {
  const floors = new Map<string, FloorAnalysis>();
  const issues: Issue[] = [];
  for (const f of project.floors) {
    const fa = analyzeFloor(project, f);
    floors.set(f.id, fa);
    issues.push(...fa.issues);
  }
  const transport = new Map<string, TransportReport>();
  const items = new Map(project.furniture.map((f) => [f.id, f]));
  for (const item of project.furniture) transport.set(item.id, transportReport(project.floors, item, project.settings));

  // 6. Placed items that can't be brought to their room.
  for (const p of project.placements) {
    const item = items.get(p.itemId);
    if (!item) continue;
    const floor = project.floors.find((f) => f.id === p.floorId);
    if (!floor) continue;
    const fp = footprint(p, item);
    const roomId = roomOfPoint(floor, fp.x + fp.w / 2, fp.y + fp.h / 2);
    if (!roomId) continue;
    const rep = transport.get(item.id)!;
    if (rep.disassembles) continue;
    const route = rep.rooms.get(roomId);
    if (!route || !route.ok) {
      const t = route?.tightest;
      issues.push({
        id: `transport:${p.id}`,
        severity: "error",
        floorId: p.floorId,
        placementIds: [p.id],
        rect: fp,
        message: t
          ? `${item.name} can't get to ${floor.rooms.find((r) => r.id === roomId)?.name}: ${t.passage.name} is ${Math.round(-t.margin)}" too small (best try: ${t.how}).`
          : `${item.name} has no route into ${floor.rooms.find((r) => r.id === roomId)?.name}.`,
      });
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { floors, transport, issues };
}

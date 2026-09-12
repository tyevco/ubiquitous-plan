import { describe, expect, it } from "vitest";
import { maxLengthAroundCorner, transportReport } from "../src/engine/transport";
import { solveRoom } from "../src/engine/solver";
import { defaultProject } from "../src/engine/defaults";
import { analyze, analyzeFloor } from "../src/engine/analysis";
import { buildGrid, passableMask, flood, nearestPassable } from "../src/engine/grid";
import { footprint, frontZone, sideZones, doorSwingPolygon, convexPolygonsOverlap, rect, areaSummary, rectsOverlap, parseLength, parseSize, setEdgeLength } from "../src/engine/geometry";
import type { Placement, Project } from "../src/types";

describe("corner formula", () => {
  it("reduces to the ladder problem when the rectangle is a line", () => {
    // (a^(2/3) + b^(2/3))^(3/2) with a = b = 36 -> 36 * 2^(3/2) ≈ 101.8
    expect(maxLengthAroundCorner(36, 36, 0)).toBeCloseTo(36 * Math.pow(2, 1.5), 0);
  });
  it("shrinks as the piece gets wider and is zero when it can't fit at all", () => {
    expect(maxLengthAroundCorner(36, 36, 20)).toBeLessThan(maxLengthAroundCorner(36, 36, 10));
    expect(maxLengthAroundCorner(36, 36, 36)).toBe(0);
  });
});

describe("transport", () => {
  const project = defaultProject();
  it("gets a nightstand anywhere", () => {
    const rep = transportReport(project.floors, project.furniture.find((f) => f.id === "m-night")!, project.settings);
    expect(rep.rooms.get("bed1")?.ok).toBe(true);
    expect(rep.rooms.get("bed2")?.ok).toBe(true);
  });
  it("skips beds because they come apart", () => {
    const rep = transportReport(project.floors, project.furniture.find((f) => f.id === "m-bed")!, project.settings);
    expect(rep.disassembles).toBe(true);
  });
  it("routes the dining table upstairs via the stairs and finds the tightest opening", () => {
    const rep = transportReport(project.floors, project.furniture.find((f) => f.id === "d-table")!, project.settings);
    const den = rep.rooms.get("den")!;
    expect(den.steps.map((s) => s.passage.id)).toContain("stairs");
    expect(den.ok).toBe(true);
    expect(den.tightest?.passage.id).toBe("front-door");
  });
  it("makes a landing turn the bottleneck when the stairs have one", () => {
    const p = defaultProject();
    const stairs = p.floors[0].passages.find((x) => x.id === "stairs")!;
    stairs.stair!.turn = { a: 36, b: 36 };
    const rep = transportReport(p.floors, p.furniture.find((f) => f.id === "d-table")!, p.settings);
    expect(rep.rooms.get("den")?.ok).toBe(false);
    expect(rep.rooms.get("den")?.tightest?.passage.id).toBe("stairs");
  });
  it("refuses a piece wider than every door in all orientations", () => {
    const rep = transportReport(project.floors, { id: "x", name: "Crate", set: "t", kind: "other", d: 40, w: 40, h: 40, quantity: 1 }, project.settings);
    expect(rep.rooms.get("bed1")?.ok).toBe(false);
    expect(rep.rooms.get("garage")?.ok).toBe(true);
  });
});

describe("geometry", () => {
  const item = { id: "i", name: "i", set: "s", kind: "dresser" as const, d: 20, w: 36, h: 48, quantity: 1 };
  it("rotates footprints", () => {
    const p: Placement = { id: "p", itemId: "i", floorId: "f", x: 10, y: 10, rotation: 0 };
    expect(footprint(p, item)).toEqual({ x: 10, y: 10, w: 36, h: 20 });
    expect(footprint({ ...p, rotation: 90 }, item)).toEqual({ x: 10, y: 10, w: 20, h: 36 });
  });
  it("puts the front zone on the facing side", () => {
    const p: Placement = { id: "p", itemId: "i", floorId: "f", x: 10, y: 10, rotation: 180 };
    expect(frontZone(p, item, 18)).toEqual({ x: 10, y: -8, w: 36, h: 18 });
    expect(frontZone({ ...p, rotation: 270 }, item, 18)).toEqual({ x: 30, y: 10, w: 18, h: 36 });
  });
  it("side zones flank the long axis", () => {
    const bed = { ...item, kind: "bed" as const, d: 80, w: 60 };
    const p: Placement = { id: "p", itemId: "i", floorId: "f", x: 100, y: 100, rotation: 0 };
    const [l, r] = sideZones(p, bed, 24);
    expect(l).toEqual({ x: 76, y: 100, w: 24, h: 80 });
    expect(r).toEqual({ x: 160, y: 100, w: 24, h: 80 });
  });
  it("door swing sector overlaps a box in front of the door", () => {
    const swing = doorSwingPolygon({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 0 }, { x: 15, y: 50 });
    expect(convexPolygonsOverlap(swing, rect(5, 5, 10, 10))).toBe(true);
    expect(convexPolygonsOverlap(swing, rect(5, -20, 10, 10))).toBe(false);
  });
});

describe("walkability grid", () => {
  const project = defaultProject();
  const first = project.floors[0];
  it("connects the front door to the bedroom door with a 36-inch path in the empty apartment", () => {
    const a = analyzeFloor(project, first);
    expect(a.issues.filter((i) => i.id.startsWith("main:"))).toEqual([]);
  });
  it("walls are blocked and room interiors are free", () => {
    const g = buildGrid(first, 2, []);
    const mask = passableMask(g, 24, first);
    // Centre of bedroom 1
    const c = nearestPassable(g, mask, 78, 72, 2);
    expect(c).toBeGreaterThanOrEqual(0);
    // Inside the wall between bedroom and entry
    expect(nearestPassable(g, mask, 153, 20, 1)).toBe(-1);
    const reach = flood(g, mask, [c]);
    expect(reach.reduce((n, v) => n + v, 0)).toBeGreaterThan(1000);
  });
});

describe("analysis on placements", () => {
  function withPlacements(ps: Placement[]): Project {
    const p = defaultProject();
    p.placements = ps;
    return p;
  }
  it("flags overlapping furniture", () => {
    const a = analyze(
      withPlacements([
        { id: "a", itemId: "m-dresser", floorId: "first", x: 20, y: 20, rotation: 0 },
        { id: "b", itemId: "m-chest", floorId: "first", x: 30, y: 25, rotation: 0 },
      ]),
    );
    expect(a.issues.some((i) => i.id === "overlap:a:b")).toBe(true);
  });
  it("flags a dresser pushed into a wall and one blocking a door", () => {
    const a = analyze(
      withPlacements([
        { id: "a", itemId: "m-dresser", floorId: "first", x: 0, y: 20, rotation: 0 },
        { id: "b", itemId: "m-chest", floorId: "first", x: 140, y: 60, rotation: 0 },
      ]),
    );
    expect(a.issues.some((i) => i.id === "wall:a")).toBe(true);
    expect(a.issues.some((i) => i.id === "door:bed1-door:b")).toBe(true);
  });
  it("accepts a dresser against a wall facing into the room", () => {
    const a = analyze(withPlacements([{ id: "a", itemId: "m-dresser", floorId: "first", x: 60, y: 6, rotation: 0 }]));
    expect(a.issues.filter((i) => i.placementIds.includes("a"))).toEqual([]);
  });
  it("warns when a bed is against the wall on one side", () => {
    const a = analyze(withPlacements([{ id: "bed", itemId: "m-bed", floorId: "first", x: 6, y: 20, rotation: 0 }]));
    expect(a.issues.some((i) => i.id.startsWith("zone:bed:"))).toBe(true);
  });
  it("flags a piece placed in a room it can't be carried into", () => {
    const p = withPlacements([{ id: "c", itemId: "crate", floorId: "first", x: 60, y: 40, rotation: 0 }]);
    p.furniture.push({ id: "crate", name: "Crate", set: "t", kind: "other", d: 40, w: 40, h: 40, quantity: 1 });
    const a = analyze(p);
    expect(a.issues.some((i) => i.id === "transport:c")).toBe(true);
  });
});

describe("windows and upright pieces", () => {
  it("warns when a tall piece stands in front of a window", () => {
    const p = defaultProject();
    p.placements = [{ id: "a", itemId: "m-gent", floorId: "first", x: 6, y: 50, rotation: 270 }];
    const a = analyze(p);
    expect(a.issues.some((i) => i.id === "window:w1-bed:a")).toBe(true);
  });
  it("does not warn for a piece below the sill", () => {
    const p = defaultProject();
    p.placements = [{ id: "a", itemId: "m-night", floorId: "first", x: 6, y: 50, rotation: 270 }];
    const a = analyze(p);
    expect(a.issues.some((i) => i.id.startsWith("window:"))).toBe(false);
  });
  it("only carries an upright-only piece standing up", () => {
    const p = defaultProject();
    const piano = p.furniture.find((f) => f.id === "piano")!;
    const rep = transportReport(p.floors, piano, p.settings);
    // 25.5" deep fits a 30" door upright; a 40" door would still take it.
    expect(rep.rooms.get("bed1")?.ok).toBe(true);
    const tall = { ...piano, id: "tall", h: 85 };
    const rep2 = transportReport(p.floors, tall, p.settings);
    // Too tall for an 80" door and not allowed to tip.
    expect(rep2.rooms.get("bed1")?.ok).toBe(false);
    const rep3 = transportReport(p.floors, { ...tall, keepUpright: false }, p.settings);
    expect(rep3.rooms.get("bed1")?.ok).toBe(true);
  });
});

describe("solver", () => {
  it("arranges the main bedroom set without errors", () => {
    const p = defaultProject();
    const res = solveRoom({ project: p, floorId: "first", roomId: "bed1", picks: [{ itemId: "m-bed", count: 1 }, { itemId: "m-night", count: 2 }, { itemId: "m-dresser", count: 1 }], restarts: 1 });
    expect(res.placements.length + res.unplaced.length).toBe(4);
    expect(res.placements.length).toBeGreaterThanOrEqual(3);
    p.placements = res.placements;
    const a = analyze(p);
    expect(a.issues.filter((i) => i.severity === "error")).toEqual([]);
    // The bed's head should be against a wall.
    const bed = res.placements.find((x) => x.itemId === "m-bed")!;
    const fp = footprint(bed, p.furniture.find((f) => f.id === "m-bed")!);
    const touchesWall = fp.x === 6 || fp.y === 6 || fp.x + fp.w === 150 || fp.y + fp.h === 138;
    expect(touchesWall).toBe(true);
  });
  it("reports pieces that can't be carried into the room", () => {
    const p = defaultProject();
    p.furniture.push({ id: "crate", name: "Crate", set: "t", kind: "other", d: 40, w: 40, h: 40, quantity: 1 });
    const res = solveRoom({ project: p, floorId: "first", roomId: "bed1", picks: [{ itemId: "crate", count: 1 }], restarts: 1 });
    expect(res.placements).toEqual([]);
    expect(res.unplaced[0].reason).toMatch(/carried/);
  });
});

describe("area", () => {
  it("leaves the garage and patios out and lands near the listed size", () => {
    const p = defaultProject();
    const a = areaSummary(p.floors);
    expect(a.net).toBeGreaterThan(900);
    expect(a.gross).toBeLessThan(1300);
    expect(a.floors.map((f) => f.id)).toEqual(["first", "second"]);
    // Counting the garage would blow past the listing.
    p.floors[0].rooms.find((r) => r.id === "garage")!.excludeFromArea = false;
    expect(areaSummary(p.floors).gross).toBeGreaterThan(1500);
  });
});

describe("solver pairs nightstands", () => {
  it("keeps both of Zara's nightstands beside the bed", () => {
    const p = defaultProject();
    const res = solveRoom({ project: p, floorId: "second", roomId: "bed2", picks: [{ itemId: "z-bed", count: 1 }, { itemId: "z-night", count: 2 }, { itemId: "z-dresser", count: 1 }, { itemId: "z-shelf", count: 1 }], restarts: 1, seed: 1 });
    const bed = res.placements.find((x) => x.itemId === "z-bed")!;
    const bf = footprint(bed, p.furniture.find((f) => f.id === "z-bed")!);
    const ns = res.placements.filter((x) => x.itemId === "z-night");
    expect(ns).toHaveLength(2);
    for (const n of ns) {
      const nf = footprint(n, p.furniture.find((f) => f.id === "z-night")!);
      expect(n.rotation).toBe(bed.rotation);
      expect(rectsOverlap(nf, { x: bf.x - 3, y: bf.y - 3, w: bf.w + 6, h: bf.h + 6 })).toBe(true);
    }
  });
});

describe("raster edges", () => {
  it("accepts a piece flush against a wall that sits at an odd inch", () => {
    const p = defaultProject();
    // Bedroom 2's left wall is at x = 103.
    p.placements = [{ id: "a", itemId: "z-shelf", floorId: "second", x: 103, y: 360, rotation: 270 }];
    const a = analyze(p);
    expect(a.issues.filter((i) => i.id === "wall:a")).toEqual([]);
  });
});

describe("measuring", () => {
  it("parses feet-and-inches", () => {
    expect(parseLength(`12'2"`)).toBe(146);
    expect(parseLength("12' 2")).toBe(146);
    expect(parseLength("146")).toBe(146);
    expect(parseLength("10.5'")).toBe(126);
    expect(parseLength("abc")).toBeNull();
    expect(parseSize(`12'2" x 10'6"`)).toEqual({ w: 146, d: 126 });
  });
  it("stretches an orthogonal polygon when a wall length changes", () => {
    const poly = rect(10, 10, 100, 50);
    setEdgeLength(poly, 0, 120); // top wall, left to right
    expect(poly).toEqual([{ x: 10, y: 10 }, { x: 130, y: 10 }, { x: 130, y: 60 }, { x: 10, y: 60 }]);
    setEdgeLength(poly, 1, 40); // right wall, top to bottom
    expect(poly[2]).toEqual({ x: 130, y: 50 });
    expect(poly[3]).toEqual({ x: 10, y: 50 });
    // An L-shape: lengthening the top-left leg moves the notch and everything right of it.
    const L = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 80 }, { x: 0, y: 80 }];
    setEdgeLength(L, 0, 60);
    expect(L[1]).toEqual({ x: 60, y: 0 });
    expect(L[3]).toEqual({ x: 110, y: 20 });
    expect(L[5]).toEqual({ x: 0, y: 80 });
  });
});

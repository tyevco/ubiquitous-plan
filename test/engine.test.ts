import { describe, expect, it } from "vitest";
import { maxLengthAroundCorner, transportReport } from "../src/engine/transport";
import { defaultProject } from "../src/engine/defaults";
import { analyze, analyzeFloor } from "../src/engine/analysis";
import { buildGrid, passableMask, flood, nearestPassable } from "../src/engine/grid";
import { footprint, frontZone, sideZones, doorSwingPolygon, convexPolygonsOverlap, rect } from "../src/engine/geometry";
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
  it("finds the stairs are the bottleneck for the dining table upstairs", () => {
    const rep = transportReport(project.floors, project.furniture.find((f) => f.id === "d-table")!, project.settings);
    const den = rep.rooms.get("den")!;
    expect(den.steps.map((s) => s.passage.id)).toContain("stairs");
    expect(den.tightest?.passage.id).toBe("stairs");
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

import type { Floor, FurnitureItem, Point, Polygon, Project, Settings } from "../types";
import { rect } from "./geometry";

/*
 * The apartment as traced from the builder's marketing floorplan. The only
 * dimensions printed on it are the room labels (Bedroom 1 12'x11', Living
 * 13'x12', Den 9'x9', Bedroom 2 14'x13'), and the drawing doesn't agree with
 * them, so rooms are traced to the drawing's proportions (the building is
 * 258" wide overall) with the labels kept as `listed` for the measure check.
 * Everything should be verified on site with a tape.
 * Walls are 6" thick; rooms are drawn to their inside faces. The building's
 * top-right corner is recessed on both floors: a porch in front of the entry
 * downstairs and the living-room patio above it. Bath 1 is an en-suite off
 * Bedroom 1.
 */

export const OUTSIDE = "outside";

/*
 * Both floors are traced from docs/plan/plan.png by pixel measurement. Each
 * floor maps the inside faces of its outer walls in the image onto the same
 * 277" x 508" footprint (265" x 496" inside the walls), so positions follow the
 * drawing's proportions exactly. Interior walls are drawn 6" and doors are
 * given standard widths centred on the gaps the drawing shows. Printed room
 * sizes are kept as `listed` for the measure check: the drawing doesn't quite
 * agree with them (Bedroom 1 draws wider, Bedroom 2 narrower).
 */
const INSIDE_W = 265;
const INSIDE_H = 496;

interface Mapper {
  x: (px: number) => number;
  y: (py: number) => number;
  pt: (px: number, py: number) => Point;
  rect: (x0: number, y0: number, x1: number, y1: number) => Polygon;
}

function mapper(ox: number, oy: number, pxWide: number, pxTall: number): Mapper {
  const sx = INSIDE_W / pxWide;
  const sy = INSIDE_H / pxTall;
  const r = (v: number): number => Math.round(v * 2) / 2;
  const x = (px: number): number => r(6 + (px - ox) * sx);
  const y = (py: number): number => r(6 + (py - oy) * sy);
  return { x, y, pt: (px, py) => ({ x: x(px), y: y(py) }), rect: (x0, y0, x1, y1) => rect(x(x0), y(y0), x(x1) - x(x0), y(y1) - y(y0)) };
}

/** Door on a vertical wall: wall centre px, gap top..bottom px, standard width centred on the gap. */
function vDoor(m: Mapper, wallPx: number, y0: number, y1: number, width: number): { a: Point; b: Point } {
  const cy = (m.y(y0) + m.y(y1)) / 2;
  return { a: { x: m.x(wallPx), y: cy - width / 2 }, b: { x: m.x(wallPx), y: cy + width / 2 } };
}
function hDoor(m: Mapper, wallPy: number, x0: number, x1: number, width: number): { a: Point; b: Point } {
  const cx = (m.x(x0) + m.x(x1)) / 2;
  return { a: { x: cx - width / 2, y: m.y(wallPy) }, b: { x: cx + width / 2, y: m.y(wallPy) } };
}

// First floor: inside faces x 13..431, y 12..780 in the image.
const m1 = mapper(13, 12, 418, 768);
const first: Floor = {
  id: "first",
  name: "First floor",
  width: 277,
  height: 508,
  rooms: [
    { id: "bed1", name: "Bedroom 1", polygon: m1.rect(13, 12, 265, 215), listed: { w: 144, d: 132 } },
    { id: "closet1", name: "Walk-in closet", polygon: m1.rect(13, 220, 109, 328) },
    { id: "bath1", name: "Bath 1", polygon: m1.rect(114, 220, 271, 328) },
    {
      id: "entry",
      name: "Entry",
      // Wraps the stair run, the block under it, and the storage closet.
      polygon: [m1.pt(276, 63), m1.pt(431, 63), m1.pt(431, 118), m1.pt(364, 118), m1.pt(364, 216), m1.pt(345, 216), m1.pt(345, 328), m1.pt(276, 328)],
    },
    { id: "storage", name: "Storage", polygon: m1.rect(350, 268, 431, 328) },
    { id: "garage", name: "2-car garage", polygon: m1.rect(17, 338, 436, 780), excludeFromArea: true },
    { id: "porch", name: "Porch", polygon: m1.rect(276, 5, 431, 54), excludeFromArea: true, outdoor: true },
  ],
  fixtures: [
    { id: "stairs1", name: "Stairs up", polygon: m1.rect(372, 118, 431, 216), style: "stairs" },
    { id: "stair-rail1", name: "Stair half wall", polygon: m1.rect(364, 118, 372, 216), style: "halfwall", height: 36 },
    { id: "stair-block1", name: "Under the stairs", polygon: m1.rect(345, 216, 372, 268), style: "wall" },
    { id: "wh", name: "Water heater", polygon: m1.rect(22, 345, 58, 381) },
    { id: "wd", name: "W/D", polygon: m1.rect(74, 345, 124, 392) },
    { id: "gshelf", name: "Shelf", polygon: m1.rect(136, 341, 231, 370) },
    { id: "linen1", name: "Linen", polygon: m1.rect(13, 220, 36, 246) },
    { id: "vanity1", name: "Vanity", polygon: m1.rect(114, 220, 150, 266) },
    { id: "toilet1", name: "Toilet", polygon: m1.rect(120, 277, 156, 320) },
    { id: "tub1", name: "Tub", polygon: m1.rect(216, 221, 271, 327) },
  ],
  windows: [
    { id: "w1-bed-a", name: "Bedroom 1 window", a: m1.pt(75, 9.5), b: m1.pt(132, 9.5) },
    { id: "w1-bed-b", name: "Bedroom 1 window", a: m1.pt(144, 9.5), b: m1.pt(202, 9.5) },
    { id: "w1-garage", name: "Garage window", a: m1.pt(438.5, 443), b: m1.pt(438.5, 483), sill: 42 },
  ],
  passages: [
    { id: "front-door", name: "Front door", kind: "exterior", floorId: "first", ...hDoor(m1, 58.5, 307, 365, 36), width: 36, height: 80, rooms: ["porch", "entry"], swingInto: "entry", hinge: "a" },
    { id: "porch-steps", name: "Porch", kind: "opening", floorId: "first", a: m1.pt(276, 5), b: m1.pt(431, 5), width: 98, rooms: [OUTSIDE, "porch"] },
    { id: "bed1-door", name: "Bedroom 1 door", kind: "door", floorId: "first", ...vDoor(m1, 267.5, 151, 206, 32), width: 32, height: 80, rooms: ["entry", "bed1"], swingInto: "bed1", hinge: "b" },
    { id: "closet1-door", name: "Closet 1 door", kind: "door", floorId: "first", ...hDoor(m1, 217.5, 56, 102, 30), width: 30, height: 80, rooms: ["bed1", "closet1"], swingInto: "closet1", hinge: "a" },
    { id: "bath1-door", name: "Bath 1 door", kind: "door", floorId: "first", ...hDoor(m1, 217.5, 154, 208, 30), width: 30, height: 80, rooms: ["bed1", "bath1"], swingInto: "bath1", hinge: "a" },
    { id: "garage-door", name: "Garage entry door", kind: "door", floorId: "first", ...hDoor(m1, 333, 283, 338, 32), width: 32, height: 80, rooms: ["entry", "garage"], swingInto: "entry", hinge: "a" },
    { id: "storage-door", name: "Storage door", kind: "door", floorId: "first", ...vDoor(m1, 347.5, 275, 322, 30), width: 30, height: 80, rooms: ["entry", "storage"], swingInto: "storage", hinge: "a" },
    { id: "garage-overhead", name: "Garage overhead door", kind: "exterior", floorId: "first", a: m1.pt(69, 793), b: m1.pt(379, 793), width: 192, height: 84, rooms: [OUTSIDE, "garage"] },
    {
      id: "stairs",
      name: "Stairs",
      kind: "stair",
      floorId: "first",
      a: m1.pt(401, 216),
      b: m1.pt(401, 118),
      width: 42,
      rooms: ["entry", "hall"],
      // One straight flight (confirmed in the tour): on at the north end downstairs, off at the south end upstairs.
      stair: { width: 42, headroom: 80, landingA: m1.pt(330, 125), landingB: { x: 0, y: 0 } },
    },
  ],
};

// Second floor: inside faces x 575..992, y 14..797 in the image.
const m2 = mapper(575, 14, 417, 783);
const second: Floor = {
  id: "second",
  name: "Second floor",
  width: 277,
  height: 508,
  rooms: [
    { id: "living", name: "Living", polygon: m2.rect(575, 14, 826, 246), listed: { w: 156, d: 144 } },
    {
      id: "hall-n",
      name: "Stair side",
      // Between the living room and the stairs, under the patio notch.
      polygon: [m2.pt(831, 63), m2.pt(992, 63), m2.pt(992, 140), m2.pt(870, 140), m2.pt(870, 246), m2.pt(826, 246), m2.pt(826, 63)],
    },
    { id: "patioA", name: "Patio", polygon: m2.rect(831, 14, 992, 57), excludeFromArea: true, outdoor: true },
    { id: "kitchen", name: "Kitchen", polygon: m2.rect(575, 246, 736, 464) },
    {
      id: "hall",
      name: "Stair landing",
      polygon: [m2.pt(736, 246), m2.pt(870, 246), m2.pt(870, 380), m2.pt(992, 380), m2.pt(992, 416), m2.pt(736, 416)],
    },
    { id: "hall2", name: "Bedroom hall", polygon: m2.rect(736, 416, 805, 551) },
    { id: "den", name: "Den / dining", polygon: m2.rect(810, 416, 992, 551), listed: { w: 108, d: 108 } },
    { id: "bath2", name: "Bath 2", polygon: m2.rect(575, 469, 730, 645) },
    { id: "closet2", name: "Walk-in closet", polygon: m2.rect(575, 651, 730, 797) },
    { id: "bed2", name: "Bedroom 2", polygon: m2.rect(742, 556, 992, 797), listed: { w: 168, d: 156 } },
  ],
  fixtures: [
    { id: "stairs2", name: "Stairs down", polygon: m2.rect(885, 145, 992, 380), style: "stairs" },
    {
      id: "stair-wall",
      name: "Stair half wall",
      style: "halfwall",
      height: 42,
      polygon: [m2.pt(870, 140), m2.pt(992, 140), m2.pt(992, 145), m2.pt(885, 145), m2.pt(885, 380), m2.pt(870, 380)],
    },
    { id: "pantry", name: "Pantry", polygon: m2.rect(575, 239, 613, 306) },
    { id: "counter-w1", name: "Counter", polygon: m2.rect(575, 306, 615, 330) },
    { id: "range", name: "Range", polygon: m2.rect(575, 330, 615, 380) },
    { id: "counter-w2", name: "Counter", polygon: m2.rect(575, 380, 615, 440) },
    { id: "pier", name: "Wall", polygon: m2.rect(575, 440, 599, 493), style: "wall" },
    { id: "counter-s", name: "Counter", polygon: m2.rect(599, 425, 690, 464) },
    { id: "fridge", name: "Fridge", polygon: m2.rect(690, 415, 736, 464) },
    { id: "fridge-wall", name: "Wall", polygon: m2.rect(730, 416, 736, 469), style: "wall" },
    { id: "island", name: "Island", polygon: m2.rect(682, 245, 740, 350) },
    { id: "vanity2", name: "Vanity", polygon: m2.rect(599, 500, 640, 570) },
    { id: "toilet2", name: "Toilet", polygon: m2.rect(580, 590, 622, 640) },
    { id: "tub-wall", name: "Tub alcove wall", polygon: m2.rect(671, 534, 735, 539), style: "wall" },
    { id: "tub2", name: "Tub", polygon: m2.rect(675, 543, 730, 645) },
    { id: "linen2", name: "Linen", polygon: m2.rect(676, 651, 730, 678) },
  ],
  windows: [
    { id: "w2-living-a", name: "Living window", a: m2.pt(636, 11), b: m2.pt(694, 11) },
    { id: "w2-living-b", name: "Living window", a: m2.pt(705, 11), b: m2.pt(763, 11) },
    { id: "w2-stair", name: "Stairwell window", a: m2.pt(997, 164), b: m2.pt(997, 213), sill: 42 },
    { id: "w2-landing", name: "Landing window", a: m2.pt(997, 299), b: m2.pt(997, 349), sill: 42 },
    { id: "w2-den", name: "Den window", a: m2.pt(997, 435), b: m2.pt(997, 484) },
    { id: "w2-bed-e", name: "Bedroom 2 side window", a: m2.pt(997, 570), b: m2.pt(997, 620) },
    { id: "w2-bed-s", name: "Bedroom 2 window", a: m2.pt(757, 799.5), b: m2.pt(815, 799.5) },
  ],
  passages: [
    { id: "living-halln", name: "Living ↔ stair side", kind: "opening", floorId: "second", a: m2.pt(826, 63), b: m2.pt(826, 246), width: m2.y(246) - m2.y(63), rooms: ["living", "hall-n"] },
    { id: "living-kitchen", name: "Living ↔ kitchen", kind: "opening", floorId: "second", a: m2.pt(613, 246), b: m2.pt(736, 246), width: m2.x(736) - m2.x(613), rooms: ["living", "kitchen"] },
    { id: "living-hall", name: "Living ↔ stair landing", kind: "opening", floorId: "second", a: m2.pt(736, 246), b: m2.pt(826, 246), width: m2.x(826) - m2.x(736), rooms: ["living", "hall"] },
    { id: "halln-hall", name: "Stair side ↔ stair landing", kind: "opening", floorId: "second", a: m2.pt(826, 246), b: m2.pt(870, 246), width: m2.x(870) - m2.x(826), rooms: ["hall-n", "hall"] },
    { id: "kitchen-hall", name: "Kitchen ↔ stair landing", kind: "opening", floorId: "second", a: m2.pt(736, 246), b: m2.pt(736, 416), width: m2.y(416) - m2.y(246), rooms: ["kitchen", "hall"] },
    { id: "hall-hall2", name: "Stair landing ↔ bedroom hall", kind: "opening", floorId: "second", a: m2.pt(736, 416), b: m2.pt(805, 416), width: m2.x(805) - m2.x(736), rooms: ["hall", "hall2"] },
    { id: "hall-den", name: "Stair landing ↔ den", kind: "opening", floorId: "second", a: m2.pt(810, 416), b: m2.pt(992, 416), width: m2.x(992) - m2.x(810), rooms: ["hall", "den"] },
    { id: "patioA-door", name: "Living patio door", kind: "exterior", floorId: "second", ...hDoor(m2, 60, 872, 921, 32), width: 32, height: 80, rooms: ["hall-n", "patioA"], swingInto: "hall-n", hinge: "a" },
    { id: "bath2-door", name: "Bath 2 door", kind: "door", floorId: "second", ...vDoor(m2, 733, 474, 530, 30), width: 30, height: 80, rooms: ["hall2", "bath2"], swingInto: "bath2", hinge: "a" },
    { id: "bed2-door", name: "Bedroom 2 door", kind: "door", floorId: "second", ...hDoor(m2, 553.5, 742, 797, 32), width: 32, height: 80, rooms: ["hall2", "bed2"], swingInto: "bed2", hinge: "a" },
    { id: "closet2-door", name: "Closet 2 door", kind: "door", floorId: "second", ...vDoor(m2, 733, 713, 759, 30), width: 30, height: 80, rooms: ["bed2", "closet2"], swingInto: "closet2", hinge: "a" },
  ],
};
// The top of the stairs opens onto the landing strip south of the treads.
first.passages.find((p) => p.id === "stairs")!.stair!.landingB = m2.pt(940, 400);

export const defaultSettings: Settings = {
  mainPathWidth: 36,
  secondaryPathWidth: 24,
  drawerClearance: 18,
  bedSideClearance: 24,
  bedBothSides: true,
  transportTolerance: 1,
  defaultDoorHeight: 80,
  snap: 1,
  cellSize: 2,
  furnitureGap: 0,
  tableClearance: 36,
  defaultSillHeight: 30,
  targetSqFt: 1219,
};

// From the measuring sheet: depth x width x height, inches.
export const defaultFurniture: FurnitureItem[] = [
  { id: "m-bed", name: "Bed", set: "Main bedroom", kind: "bed", d: 96, w: 80, h: 53, quantity: 1, disassembles: true },
  { id: "m-night", name: "Nightstand", set: "Main bedroom", kind: "nightstand", d: 18, w: 24, h: 26, quantity: 2, allowInBedZone: true },
  { id: "m-dresser", name: "Dresser", set: "Main bedroom", kind: "dresser", d: 20, w: 36, h: 48, quantity: 1 },
  { id: "m-chest", name: "Chest of drawers", set: "Main bedroom", kind: "chest", d: 21, w: 62, h: 37.5, quantity: 1 },
  { id: "m-gent", name: "Gentleman's chest", set: "Main bedroom", kind: "chest", d: 20, w: 48, h: 68, quantity: 1 },
  { id: "m-dresser-old", name: "Dresser (old)", set: "Main bedroom", kind: "dresser", d: 18, w: 40, h: 50, quantity: 1 },
  { id: "m-gent-old", name: "Gentleman's chest (old)", set: "Main bedroom", kind: "chest", d: 19.5, w: 50, h: 52, quantity: 1 },
  { id: "z-bed", name: "Bed", set: "Zara", kind: "bed", d: 86, w: 64, h: 60, quantity: 1, disassembles: true },
  { id: "z-night", name: "Nightstand", set: "Zara", kind: "nightstand", d: 20.5, w: 23.5, h: 25, quantity: 2, allowInBedZone: true },
  { id: "z-dresser", name: "Dresser", set: "Zara", kind: "dresser", d: 20.5, w: 54, h: 34, quantity: 1 },
  { id: "z-shelf", name: "Shelf", set: "Zara", kind: "shelf", d: 16, w: 34, h: 56.5, quantity: 1 },
  { id: "s-glass", name: "Shelf (glass)", set: "Shelves", kind: "shelf", d: 15, w: 47.5, h: 47.5, quantity: 2 },
  { id: "s-plain", name: "Shelf (plain)", set: "Shelves", kind: "shelf", d: 15, w: 32, h: 47.5, quantity: 4 },
  { id: "s-curves", name: "Shelf (curves)", set: "Shelves", kind: "shelf", d: 16, w: 36, h: 74, quantity: 1 },
  { id: "d-table", name: "Table", set: "Dining", kind: "table", d: 73.5, w: 45, h: 30, quantity: 1 },
  { id: "d-china", name: "China cabinet", set: "Dining", kind: "cabinet", d: 17.5, w: 39, h: 80, quantity: 1 },
  { id: "d-side", name: "Sideboard", set: "Dining", kind: "cabinet", d: 20, w: 72, h: 42, quantity: 1 },
  // Yamaha U3 upright: 131 cm tall, 153 cm wide, 65 cm deep, about 240 kg.
  { id: "piano", name: "Piano (Yamaha U3)", set: "Living", kind: "piano", d: 25.5, w: 60, h: 51.5, quantity: 1, keepUpright: true, notes: "About 530 lb. Keep off exterior walls and away from windows and vents if you can." },
];

export function defaultProject(): Project {
  return structuredClone({
    version: 1 as const,
    name: "New apartment",
    floors: [first, second],
    furniture: defaultFurniture,
    placements: [],
    settings: defaultSettings,
    activeFloorId: "first",
  });
}

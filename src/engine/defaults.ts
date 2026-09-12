import type { Floor, FurnitureItem, Project, Settings } from "../types";
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

const first: Floor = {
  id: "first",
  name: "First floor",
  width: 258,
  height: 480,
  rooms: [
    { id: "bed1", name: "Bedroom 1", polygon: rect(6, 6, 146, 122), listed: { w: 144, d: 132 } },
    { id: "closet1", name: "Walk-in closet", polygon: rect(6, 134, 53, 65) },
    { id: "bath1", name: "Bath 1", polygon: rect(65, 134, 87, 65) },
    { id: "entry", name: "Entry", polygon: rect(158, 35, 94, 164) },
    { id: "garage", name: "2-car garage", polygon: rect(6, 205, 246, 269), excludeFromArea: true },
    { id: "porch", name: "Porch", polygon: rect(158, 3, 94, 26), excludeFromArea: true, outdoor: true },
  ],
  fixtures: [
    { id: "stairs1", name: "Stairs up", polygon: rect(199, 76, 53, 80), style: "stairs" },
    { id: "storage1", name: "Storage", polygon: rect(196, 156, 56, 43) },
    { id: "wh", name: "Water heater", polygon: rect(6, 206, 22, 22) },
    { id: "wd", name: "W/D", polygon: rect(33, 206, 35, 35) },
    { id: "gshelf", name: "Shelf", polygon: rect(73, 206, 63, 15) },
    { id: "vanity1", name: "Vanity", polygon: rect(65, 134, 26, 24) },
    { id: "toilet1", name: "Toilet", polygon: rect(66, 170, 20, 26) },
    { id: "tub1", name: "Tub", polygon: rect(122, 134, 30, 65) },
  ],
  windows: [
    { id: "w1-bed", name: "Bedroom 1 window", a: { x: 3, y: 38 }, b: { x: 3, y: 114 } },
    { id: "w1-stair", name: "Stairwell window", a: { x: 255, y: 76 }, b: { x: 255, y: 126 }, sill: 42 },
  ],
  passages: [
    {
      id: "front-door",
      name: "Front door",
      kind: "exterior",
      floorId: "first",
      a: { x: 178, y: 32 },
      b: { x: 214, y: 32 },
      width: 36,
      height: 80,
      rooms: ["porch", "entry"],
      swingInto: "entry",
      hinge: "a",
    },
    {
      id: "porch-steps",
      name: "Porch",
      kind: "opening",
      floorId: "first",
      a: { x: 158, y: 3 },
      b: { x: 252, y: 3 },
      width: 94,
      rooms: [OUTSIDE, "porch"],
    },
    {
      id: "bed1-door",
      name: "Bedroom 1 door",
      kind: "door",
      floorId: "first",
      a: { x: 155, y: 62 },
      b: { x: 155, y: 92 },
      width: 30,
      height: 80,
      rooms: ["entry", "bed1"],
      swingInto: "bed1",
      hinge: "a",
    },
    {
      id: "bath1-door",
      name: "Bath 1 door",
      kind: "door",
      floorId: "first",
      a: { x: 90, y: 131 },
      b: { x: 120, y: 131 },
      width: 30,
      height: 80,
      rooms: ["bed1", "bath1"],
      swingInto: "bath1",
      hinge: "a",
    },
    {
      id: "closet1-door",
      name: "Closet 1 door",
      kind: "door",
      floorId: "first",
      a: { x: 26, y: 131 },
      b: { x: 56, y: 131 },
      width: 30,
      height: 80,
      rooms: ["bed1", "closet1"],
      swingInto: "closet1",
      hinge: "a",
    },
    {
      id: "garage-door",
      name: "Garage entry door",
      kind: "door",
      floorId: "first",
      a: { x: 160, y: 202 },
      b: { x: 192, y: 202 },
      width: 32,
      height: 80,
      rooms: ["entry", "garage"],
      swingInto: "entry",
      hinge: "a",
    },
    {
      id: "garage-overhead",
      name: "Garage overhead door",
      kind: "exterior",
      floorId: "first",
      a: { x: 30, y: 477 },
      b: { x: 222, y: 477 },
      width: 192,
      height: 84,
      rooms: [OUTSIDE, "garage"],
    },
    {
      id: "stairs",
      name: "Stairs",
      kind: "stair",
      floorId: "first",
      a: { x: 225, y: 156 },
      b: { x: 225, y: 76 },
      width: 42,
      rooms: ["entry", "living"],
      // A straight run: you step on at the north end downstairs and off at the
      // south end upstairs. No landing turn, so only width and headroom limit
      // what can be carried up.
      stair: { width: 42, headroom: 80, landingA: { x: 178, y: 80 }, landingB: { x: 226, y: 236 } },
    },
  ],
};

const second: Floor = {
  id: "second",
  name: "Second floor",
  width: 300,
  height: 480,
  rooms: [
    {
      id: "living",
      name: "Living",
      polygon: [
        { x: 6, y: 6 },
        { x: 152, y: 6 },
        { x: 152, y: 42 },
        { x: 252, y: 42 },
        { x: 252, y: 138 },
        { x: 6, y: 138 },
      ],
      listed: { w: 156, d: 144 },
    },
    { id: "kitchen", name: "Kitchen", polygon: rect(6, 138, 135, 133) },
    { id: "hall", name: "Stair landing", polygon: rect(141, 138, 55, 84) },
    {
      id: "den",
      name: "Den / dining",
      // The top of the stairs opens straight into the den's north-east corner.
      polygon: [
        { x: 146, y: 228 },
        { x: 201, y: 228 },
        { x: 201, y: 222 },
        { x: 252, y: 222 },
        { x: 252, y: 326 },
        { x: 146, y: 326 },
      ],
      listed: { w: 108, d: 108 },
    },
    // A 38" corridor off the kitchen's south-east corner, entered through a
    // cased opening beside the fridge; the bath door is on its west side and
    // the bedroom door at its south end.
    { id: "hall2", name: "Bedroom hall", polygon: rect(103, 277, 38, 47) },
    { id: "bath2", name: "Bath 2", polygon: rect(6, 277, 91, 107) },
    { id: "closet2", name: "Walk-in closet", polygon: rect(6, 390, 91, 84) },
    { id: "bed2", name: "Bedroom 2", polygon: rect(103, 330, 149, 144), listed: { w: 168, d: 156 } },
    { id: "patioA", name: "Patio", polygon: rect(158, 6, 68, 30), excludeFromArea: true, outdoor: true },
    { id: "patioB", name: "Patio", polygon: rect(258, 236, 34, 81), excludeFromArea: true, outdoor: true },
  ],
  fixtures: [
    // The stairwell: treads along the east wall, a half-height pony wall along
    // their inner side that returns to the wall at the far (north) end, and
    // the top of the stairs open at the south end by the newel post.
    { id: "stairs2", name: "Stairs down", polygon: rect(201, 85, 51, 137), style: "stairs" },
    {
      id: "stair-wall",
      name: "Stair half wall",
      style: "halfwall",
      height: 42,
      polygon: [
        { x: 196, y: 80 },
        { x: 252, y: 80 },
        { x: 252, y: 85 },
        { x: 201, y: 85 },
        { x: 201, y: 222 },
        { x: 196, y: 222 },
      ],
    },
    { id: "pantry", name: "Pantry", polygon: rect(6, 141, 22, 35) },
    { id: "counter-l", name: "Range / counter", polygon: rect(6, 176, 22, 95) },
    { id: "island", name: "Island", polygon: rect(68, 146, 41, 58) },
    { id: "counter-b", name: "Counter", polygon: rect(28, 251, 40, 20) },
    { id: "fridge", name: "Fridge", polygon: rect(68, 251, 28, 20) },
    { id: "vanity2", name: "Vanity", polygon: rect(6, 300, 24, 30) },
    { id: "toilet2", name: "Toilet", polygon: rect(8, 349, 18, 26) },
    { id: "tub2", name: "Tub", polygon: rect(66, 330, 30, 60) },
    { id: "linen2", name: "Linen", polygon: rect(60, 396, 20, 16) },
  ],
  windows: [
    { id: "w2-living-top", name: "Living window", a: { x: 36, y: 3 }, b: { x: 146, y: 3 } },
    { id: "w2-living-left", name: "Living side window", a: { x: 3, y: 57 }, b: { x: 3, y: 126 } },
    { id: "w2-stair", name: "Stairwell window", a: { x: 255, y: 97 }, b: { x: 255, y: 117 }, sill: 42 },
    { id: "w2-bed-right", name: "Bedroom 2 side window", a: { x: 255, y: 338 }, b: { x: 255, y: 362 } },
    { id: "w2-bed-a", name: "Bedroom 2 window", a: { x: 132, y: 477 }, b: { x: 164, y: 477 } },
    { id: "w2-bed-b", name: "Bedroom 2 window", a: { x: 193, y: 477 }, b: { x: 233, y: 477 } },
  ],
  passages: [
    { id: "living-kitchen", name: "Living ↔ kitchen", kind: "opening", floorId: "second", a: { x: 6, y: 138 }, b: { x: 141, y: 138 }, width: 135, rooms: ["living", "kitchen"] },
    { id: "living-hall", name: "Living ↔ stair landing", kind: "opening", floorId: "second", a: { x: 141, y: 138 }, b: { x: 196, y: 138 }, width: 55, rooms: ["living", "hall"] },
    { id: "kitchen-hall", name: "Kitchen ↔ stair landing", kind: "opening", floorId: "second", a: { x: 141, y: 138 }, b: { x: 141, y: 222 }, width: 84, rooms: ["kitchen", "hall"] },
    { id: "hall-den", name: "Stair landing ↔ den", kind: "opening", floorId: "second", a: { x: 146, y: 225 }, b: { x: 201, y: 225 }, width: 55, rooms: ["hall", "den"] },
    { id: "kitchen-den", name: "Kitchen ↔ den", kind: "opening", floorId: "second", a: { x: 143.5, y: 228 }, b: { x: 143.5, y: 251 }, width: 23, rooms: ["kitchen", "den"] },
    { id: "kitchen-hall2", name: "Bedroom hall opening", kind: "opening", floorId: "second", a: { x: 104, y: 274 }, b: { x: 140, y: 274 }, width: 36, height: 82, rooms: ["kitchen", "hall2"] },
    {
      id: "bath2-door",
      name: "Bath 2 door",
      kind: "door",
      floorId: "second",
      a: { x: 100, y: 285 },
      b: { x: 100, y: 315 },
      width: 30,
      height: 80,
      rooms: ["hall2", "bath2"],
      swingInto: "bath2",
      hinge: "a",
    },
    {
      id: "bed2-door",
      name: "Bedroom 2 door",
      kind: "door",
      floorId: "second",
      a: { x: 106, y: 327 },
      b: { x: 136, y: 327 },
      width: 30,
      height: 80,
      rooms: ["hall2", "bed2"],
      swingInto: "bed2",
      hinge: "a",
    },
    {
      id: "closet2-door",
      name: "Closet 2 door",
      kind: "door",
      floorId: "second",
      a: { x: 100, y: 410 },
      b: { x: 100, y: 440 },
      width: 30,
      height: 80,
      rooms: ["bed2", "closet2"],
      swingInto: "closet2",
      hinge: "a",
    },
    {
      id: "patioA-door",
      name: "Living patio door",
      kind: "exterior",
      floorId: "second",
      a: { x: 173, y: 39 },
      b: { x: 209, y: 39 },
      width: 36,
      height: 80,
      rooms: ["living", "patioA"],
      swingInto: "living",
      hinge: "a",
    },
    {
      id: "patioB-door",
      name: "Den patio door",
      kind: "exterior",
      floorId: "second",
      a: { x: 255, y: 256 },
      b: { x: 255, y: 292 },
      width: 36,
      height: 80,
      rooms: ["den", "patioB"],
      swingInto: "den",
      hinge: "a",
    },
  ],
};

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

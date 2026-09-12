// All lengths are in inches. Coordinates are plan coordinates with the origin
// at the top-left corner of a floor's bounding box, x to the right, y down.

export interface Point {
  x: number;
  y: number;
}

export type Polygon = Point[];

/** A walkable area: a bedroom, the living room, a hallway, the garage. */
export interface Room {
  id: string;
  name: string;
  polygon: Polygon;
  /** Rooms that exist only to route through (e.g. "outside") are never drawn. */
  virtual?: boolean;
  /** Leave out of the square-footage total (garage, patios, porch). */
  excludeFromArea?: boolean;
  /** Outside space (patio, porch): drawn with a railing edge instead of walls. */
  outdoor?: boolean;
  /** Size printed on the builder's plan, inches (width × depth). */
  listed?: { w: number; d: number };
  /** Size you measured on site, inches (width × depth). */
  measured?: { w: number; d: number };
  /** Every wall of this room has been checked with a tape. */
  verified?: boolean;
}

/** Something built in that furniture can't occupy: an island, a tub, the stairs. */
export interface Fixture {
  id: string;
  name: string;
  polygon: Polygon;
  /** Height in inches; 0 or undefined means full height. */
  height?: number;
  /** How to draw it: a built-in (default), a half-height pony wall, a full wall segment, or stair treads. */
  style?: "halfwall" | "wall" | "stairs";
}

export type PassageKind =
  | "door" // hinged door with a swing zone that must stay clear
  | "opening" // cased opening, arch, or the boundary between open-plan rooms
  | "sliding" // sliding/pocket door: no swing, half the frame is passable
  | "exterior" // front door, patio door, garage door
  | "stair"; // connects two floors; has its own transport rules

/**
 * A connection between two rooms. `a`→`b` is the segment across the wall gap on
 * the plan (its length is the clear width). Stairs connect rooms on different
 * floors and carry their own geometry.
 */
export interface Passage {
  id: string;
  name: string;
  kind: PassageKind;
  floorId: string;
  a: Point;
  b: Point;
  /** Clear width of the opening. Usually |a-b|; stored explicitly so the user can override. */
  width: number;
  /** Clear height. Standard interior door is 80". */
  height?: number;
  /** The two rooms this connects. "outside" is a virtual room for exterior doors. */
  rooms: [string, string];
  /** For hinged doors: which room the door swings into, and which endpoint holds the hinge. */
  swingInto?: string;
  hinge?: "a" | "b";
  /** Stairs: the run width and, if there is a landing turn, the two corridor widths at the turn. */
  stair?: {
    width: number;
    turn?: { a: number; b: number };
    /** Headroom above the treads; taller cross-sections can't tip to fit. */
    headroom?: number;
    /** Where you step off the stairs in rooms[0] and rooms[1] respectively. */
    landingA: Point;
    landingB: Point;
  };
}

/** A window in a wall. Furniture taller than the sill in front of it blocks the light. */
export interface Window {
  id: string;
  name?: string;
  a: Point;
  b: Point;
  /** Height of the sill above the floor; falls back to the settings default. */
  sill?: number;
}

export interface Floor {
  id: string;
  name: string;
  /** Bounding box of the floor drawing, inches. */
  width: number;
  height: number;
  rooms: Room[];
  fixtures: Fixture[];
  passages: Passage[];
  windows: Window[];
  /** The builder's drawing laid under/over the trace: where the whole image sits, in plan inches. */
  overlay?: { image: string; x: number; y: number; w: number; h: number; opacity?: number };
}

export type FurnitureKind =
  | "bed"
  | "nightstand"
  | "dresser"
  | "chest"
  | "shelf"
  | "table"
  | "cabinet"
  | "sofa"
  | "desk"
  | "piano"
  | "other";

/** A model of furniture you own. `quantity` copies can be placed. */
export interface FurnitureItem {
  id: string;
  name: string;
  set: string;
  kind: FurnitureKind;
  /** Depth (front to back), width (side to side), height. Matches the measuring sheet. */
  d: number;
  w: number;
  h: number;
  quantity: number;
  /** Clearance needed in front to open drawers/doors or to sit. Falls back to the settings default per kind. */
  frontClearance?: number;
  /** Can this be taken apart for the move? Skips the transport check. */
  disassembles?: boolean;
  /** May stand inside another item's access zone (e.g. nightstand beside a bed). */
  allowInBedZone?: boolean;
  /** Must be carried standing up (a piano): can't be tipped on its side or end to fit an opening. */
  keepUpright?: boolean;
  notes?: string;
}

export interface Placement {
  id: string;
  itemId: string;
  floorId: string;
  /** Top-left of the unrotated footprint. */
  x: number;
  y: number;
  /** 0, 90, 180, 270 degrees clockwise. At 0 the item faces "down" the page (front edge is the bottom edge). */
  rotation: 0 | 90 | 180 | 270;
}

export interface Settings {
  /** Width of the primary routes between doors. */
  mainPathWidth: number;
  /** Width needed to squeeze past furniture to reach it. */
  secondaryPathWidth: number;
  /** Default space needed in front of drawers, doors, and seats. */
  drawerClearance: number;
  /** Space required along each long side of a bed. */
  bedSideClearance: number;
  /** Both sides, or only one? */
  bedBothSides: boolean;
  /** Minimum margin between an item and an opening for the "can we bring it" check. */
  transportTolerance: number;
  /** Assumed door height when a passage doesn't specify one. */
  defaultDoorHeight: number;
  /** Snap placements to this grid. */
  snap: number;
  /** Raster cell size for the walkability analysis. Smaller = slower, more accurate. */
  cellSize: number;
  /** Extra padding required between pieces of furniture (0 = touching is fine). */
  furnitureGap: number;
  /** Chair pull-out space required on every side of a table. */
  tableClearance: number;
  /** Sill height assumed for windows that don't specify one. */
  defaultSillHeight: number;
  /** The listed size of the apartment, for checking the trace against. 0 disables. */
  targetSqFt: number;
}

export interface Project {
  version: 1;
  name: string;
  floors: Floor[];
  furniture: FurnitureItem[];
  placements: Placement[];
  settings: Settings;
  /** The floor the plan opens on. */
  activeFloorId: string;
}

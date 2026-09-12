import type { Point, Polygon, Placement, FurnitureItem } from "../types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rectToPolygon = (r: Rect): Polygon => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

export const rect = (x: number, y: number, w: number, h: number): Polygon =>
  rectToPolygon({ x, y, w, h });

export function bounds(poly: Polygon): Rect {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export function pointInPolygon(p: Point, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i],
      pj = poly[j];
    const intersect = pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export function polygonArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(s / 2);
}

export function centroid(poly: Polygon): Point {
  const b = bounds(poly);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Separating-axis test for two convex polygons (all our footprints are rectangles). */
export function convexPolygonsOverlap(a: Polygon, b: Polygon): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      const nx = q.y - p.y,
        ny = p.x - q.x;
      let minA = Infinity,
        maxA = -Infinity,
        minB = Infinity,
        maxB = -Infinity;
      for (const v of a) {
        const d = v.x * nx + v.y * ny;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const v of b) {
        const d = v.x * nx + v.y * ny;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

/** Footprint of a placement on the plan (axis aligned since rotations are multiples of 90°). */
export function footprint(p: Placement, item: FurnitureItem): Rect {
  const across = p.rotation % 180 === 0;
  return { x: p.x, y: p.y, w: across ? item.w : item.d, h: across ? item.d : item.w };
}

/**
 * Zone in front of an item's front face. At rotation 0 the front faces +y (down the page);
 * 90 faces -x (left); 180 faces -y (up); 270 faces +x (right).
 */
export function frontZone(p: Placement, item: FurnitureItem, depth: number): Rect {
  const f = footprint(p, item);
  switch (p.rotation) {
    case 0:
      return { x: f.x, y: f.y + f.h, w: f.w, h: depth };
    case 180:
      return { x: f.x, y: f.y - depth, w: f.w, h: depth };
    case 90:
      return { x: f.x - depth, y: f.y, w: depth, h: f.h };
    case 270:
      return { x: f.x + f.w, y: f.y, w: depth, h: f.h };
  }
}

/** The two zones along the long sides of a bed. A bed's "front" is its foot; the sides are perpendicular. */
export function sideZones(p: Placement, item: FurnitureItem, depth: number): [Rect, Rect] {
  const f = footprint(p, item);
  if (p.rotation % 180 === 0) {
    // Item runs top-to-bottom (d along y): long sides are left and right.
    return [
      { x: f.x - depth, y: f.y, w: depth, h: f.h },
      { x: f.x + f.w, y: f.y, w: depth, h: f.h },
    ];
  }
  return [
    { x: f.x, y: f.y - depth, w: f.w, h: depth },
    { x: f.x, y: f.y + f.h, w: f.w, h: depth },
  ];
}

/** Front-face midpoint, pushed `offset` inches out in front of the item. */
export function frontAccessPoint(p: Placement, item: FurnitureItem, offset: number): Point {
  const z = frontZone(p, item, offset);
  switch (p.rotation) {
    case 0:
      return { x: z.x + z.w / 2, y: z.y + z.h };
    case 180:
      return { x: z.x + z.w / 2, y: z.y };
    case 90:
      return { x: z.x, y: z.y + z.h / 2 };
    case 270:
      return { x: z.x + z.w, y: z.y + z.h / 2 };
  }
}

/** Quarter-circle door swing as a polygon, for drawing and for keep-clear tests. */
export function doorSwingPolygon(a: Point, b: Point, hinge: Point, into: Point, segments = 10): Polygon {
  // Radius is the door width; the arc goes from the free jamb toward the room the door opens into.
  const r = dist(a, b);
  const free = hinge.x === a.x && hinge.y === a.y ? b : a;
  const ux = (free.x - hinge.x) / r,
    uy = (free.y - hinge.y) / r;
  // Perpendicular pointing into the room.
  let px = -uy,
    py = ux;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if ((into.x - mid.x) * px + (into.y - mid.y) * py < 0) {
    px = -px;
    py = -py;
  }
  const pts: Polygon = [{ x: hinge.x, y: hinge.y }];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * (Math.PI / 2);
    pts.push({
      x: hinge.x + r * (ux * Math.cos(t) + px * Math.sin(t)),
      y: hinge.y + r * (uy * Math.cos(t) + py * Math.sin(t)),
    });
  }
  return pts;
}

export const snapTo = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v);

export function fmtIn(v: number): string {
  const r = Math.round(v * 4) / 4;
  return Number.isInteger(r) ? `${r}"` : `${r}"`;
}

export function fmtFtIn(v: number): string {
  const ft = Math.floor(v / 12);
  const inch = Math.round((v - ft * 12) * 4) / 4;
  if (ft === 0) return `${inch}"`;
  if (inch === 0) return `${ft}'`;
  return `${ft}' ${inch}"`;
}

export function polygonPerimeter(poly: Polygon): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) p += dist(poly[i], poly[(i + 1) % poly.length]);
  return p;
}

export interface AreaSummary {
  /** Net floor area inside the walls, square feet. */
  net: number;
  /** Net plus half the surrounding wall (3"), which is roughly how listings measure. */
  gross: number;
  floors: { id: string; name: string; net: number; gross: number }[];
}

/** Square footage of the rooms that count, per floor and in total. */
export function areaSummary(floors: { id: string; name: string; rooms: { polygon: Polygon; virtual?: boolean; excludeFromArea?: boolean }[] }[]): AreaSummary {
  const out: AreaSummary = { net: 0, gross: 0, floors: [] };
  for (const f of floors) {
    let net = 0,
      gross = 0;
    for (const r of f.rooms) {
      if (r.virtual || r.excludeFromArea) continue;
      const a = polygonArea(r.polygon);
      net += a;
      gross += a + 3 * polygonPerimeter(r.polygon) + 36;
    }
    out.floors.push({ id: f.id, name: f.name, net: net / 144, gross: gross / 144 });
    out.net += net / 144;
    out.gross += gross / 144;
  }
  return out;
}

/** Parse 12'2", 12' 2", 12.5', 146, or 146" into inches. Returns null if it doesn't parse. */
export function parseLength(text: string): number | null {
  const t = text.trim().replace(/[\u2019\u2032]/g, "'").replace(/[\u201d\u2033]/g, '"');
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (m) return Number(m[1]) * 12 + (m[2] ? Number(m[2]) : 0);
  const n = t.match(/^(-?\d+(?:\.\d+)?)\s*(?:"|in)?$/);
  if (n) return Number(n[1]);
  const ftOnly = t.match(/^(-?\d+(?:\.\d+)?)\s*ft$/);
  if (ftOnly) return Number(ftOnly[1]) * 12;
  return null;
}

/** Parse "12'2\" x 10'6\"" style pairs. */
export function parseSize(text: string): { w: number; d: number } | null {
  const parts = text.split(/[x××by]+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  const w = parseLength(parts[0]),
    d = parseLength(parts[1]);
  if (w === null || d === null || w <= 0 || d <= 0) return null;
  return { w, d };
}

export const isOrthogonal = (poly: Polygon): boolean =>
  poly.every((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return p.x === q.x || p.y === q.y;
  });

/**
 * Set the length of edge i (from vertex i to i+1) of an orthogonal polygon.
 * Everything on the far side of the edge's end moves with it, so the rest of
 * the room stretches rather than skewing.
 */
export function setEdgeLength(poly: Polygon, i: number, length: number): void {
  const n = poly.length;
  const a = poly[i],
    b = poly[(i + 1) % n];
  if (!isOrthogonal(poly) || length <= 0) return;
  if (a.y === b.y) {
    const dir = Math.sign(b.x - a.x) || 1;
    const delta = (length - Math.abs(b.x - a.x)) * dir;
    const edge = b.x;
    for (const v of poly) if (dir > 0 ? v.x >= edge : v.x <= edge) v.x += delta;
  } else {
    const dir = Math.sign(b.y - a.y) || 1;
    const delta = (length - Math.abs(b.y - a.y)) * dir;
    const edge = b.y;
    for (const v of poly) if (dir > 0 ? v.y >= edge : v.y <= edge) v.y += delta;
  }
}

/** Resize a polygon to a new bounding size, anchored at its top-left corner. */
export function resizeToBounds(poly: Polygon, w: number, d: number): void {
  const b = bounds(poly);
  if (b.w <= 0 || b.h <= 0) return;
  for (const v of poly) {
    v.x = Math.round((b.x + ((v.x - b.x) * w) / b.w) * 4) / 4;
    v.y = Math.round((b.y + ((v.y - b.y) * d) / b.h) * 4) / 4;
  }
}

/** Names for the walls of an orthogonal polygon, clockwise from the first corner. */
export function edgeLabel(poly: Polygon, i: number): string {
  const a = poly[i],
    b = poly[(i + 1) % poly.length];
  if (a.y === b.y) return b.x > a.x ? "top (left→right)" : "bottom (right→left)";
  return b.y > a.y ? "right (top→bottom)" : "left (bottom→top)";
}

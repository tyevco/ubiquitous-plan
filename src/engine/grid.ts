import type { Floor, Passage } from "../types";
import { bounds, pointInPolygon, type Rect } from "./geometry";
import type { Polygon } from "../types";

/**
 * Raster of a floor. Each cell is `cell` inches square; `blocked[i]` is 1 when
 * the cell centre is not walkable floor (wall, fixture, or furniture).
 */
export interface Grid {
  cell: number;
  cols: number;
  rows: number;
  blocked: Uint8Array;
  /** Distance (inches) from each cell centre to the nearest blocked cell centre. */
  dist: Float32Array;
}

export const idx = (g: { cols: number }, cx: number, cy: number): number => cy * g.cols + cx;

export function cellOf(g: Grid, x: number, y: number): [number, number] {
  return [Math.min(g.cols - 1, Math.max(0, Math.floor(x / g.cell))), Math.min(g.rows - 1, Math.max(0, Math.floor(y / g.cell)))];
}

function rasterPolygon(g: { cols: number; rows: number; cell: number }, poly: Polygon, fn: (i: number) => void): void {
  const b = bounds(poly);
  const x0 = Math.max(0, Math.floor(b.x / g.cell));
  const y0 = Math.max(0, Math.floor(b.y / g.cell));
  const x1 = Math.min(g.cols - 1, Math.ceil((b.x + b.w) / g.cell));
  const y1 = Math.min(g.rows - 1, Math.ceil((b.y + b.h) / g.cell));
  const isRect = poly.length === 4 && poly.every((p, i) => {
    const q = poly[(i + 1) % 4];
    return p.x === q.x || p.y === q.y;
  });
  for (let cy = y0; cy <= y1; cy++) {
    const py = (cy + 0.5) * g.cell;
    for (let cx = x0; cx <= x1; cx++) {
      const px = (cx + 0.5) * g.cell;
      const inside = isRect
        ? px > b.x && px < b.x + b.w && py > b.y && py < b.y + b.h
        : pointInPolygon({ x: px, y: py }, poly);
      if (inside) fn(cy * g.cols + cx);
    }
  }
}

/** Rectangle covering a passage's opening across the wall it sits in. */
export function passageRect(p: Passage, reach = 8): Rect {
  const horizontal = Math.abs(p.b.x - p.a.x) >= Math.abs(p.b.y - p.a.y);
  const minX = Math.min(p.a.x, p.b.x),
    maxX = Math.max(p.a.x, p.b.x);
  const minY = Math.min(p.a.y, p.b.y),
    maxY = Math.max(p.a.y, p.b.y);
  return horizontal
    ? { x: minX, y: minY - reach, w: maxX - minX, h: maxY - minY + 2 * reach }
    : { x: minX - reach, y: minY, w: maxX - minX + 2 * reach, h: maxY - minY };
}

/**
 * Build the static raster for a floor (walls + fixtures), then stamp any extra
 * blocked polygons (furniture) on top and compute the distance field.
 */
export function buildGrid(floor: Floor, cell: number, extraBlocked: Polygon[]): Grid {
  const cols = Math.ceil(floor.width / cell);
  const rows = Math.ceil(floor.height / cell);
  const g = { cols, rows, cell };
  const blocked = new Uint8Array(cols * rows).fill(1);
  for (const r of floor.rooms) if (!r.virtual) rasterPolygon(g, r.polygon, (i) => (blocked[i] = 0));
  for (const p of floor.passages) {
    if (p.kind === "stair") continue;
    const r = passageRect(p);
    rasterPolygon(
      g,
      [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
      ],
      (i) => (blocked[i] = 0),
    );
  }
  for (const f of floor.fixtures) rasterPolygon(g, f.polygon, (i) => (blocked[i] = 1));
  for (const poly of extraBlocked) rasterPolygon(g, poly, (i) => (blocked[i] = 1));
  const dist = distanceTransform(cols, rows, blocked, cell);
  return { cell, cols, rows, blocked, dist };
}

/** Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), in inches. */
export function distanceTransform(cols: number, rows: number, blocked: Uint8Array, cell: number): Float32Array {
  const INF = 1e12;
  const n = cols * rows;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = blocked[i] ? 0 : INF;
  const out = new Float64Array(n);
  const len = Math.max(cols, rows);
  const line = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);

  const edt1d = (m: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < m; q++) {
      let s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (line[q] + q * q - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < m; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + line[v[k]];
    }
  };

  // Columns first.
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) line[y] = f[y * cols + x];
    edt1d(rows);
    for (let y = 0; y < rows; y++) out[y * cols + x] = d[y];
  }
  // Then rows.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) line[x] = out[y * cols + x];
    edt1d(cols);
    for (let x = 0; x < cols; x++) out[y * cols + x] = d[x];
  }
  const res = new Float32Array(n);
  for (let i = 0; i < n; i++) res[i] = Math.sqrt(out[i]) * cell;
  return res;
}

/**
 * Cells a person of `width` can occupy: distance to the nearest obstacle at
 * least width/2. Door zones relax the threshold to the door's own clear width
 * so a 30" door doesn't fail a 36" corridor rule on its own; the door's width
 * is reported separately.
 */
export function passableMask(g: Grid, width: number, floor: Floor, extraTolerance = 0.75): Uint8Array {
  const need = width / 2 - extraTolerance;
  const mask = new Uint8Array(g.cols * g.rows);
  for (let i = 0; i < mask.length; i++) mask[i] = !g.blocked[i] && g.dist[i] >= need ? 1 : 0;
  for (const p of floor.passages) {
    if (p.kind === "stair") continue;
    const zone = passageRect(p, width / 2 + 2);
    const localNeed = Math.min(need, p.width / 2 - extraTolerance);
    const x0 = Math.max(0, Math.floor(zone.x / g.cell)),
      x1 = Math.min(g.cols - 1, Math.ceil((zone.x + zone.w) / g.cell));
    const y0 = Math.max(0, Math.floor(zone.y / g.cell)),
      y1 = Math.min(g.rows - 1, Math.ceil((zone.y + zone.h) / g.cell));
    for (let cy = y0; cy <= y1; cy++)
      for (let cx = x0; cx <= x1; cx++) {
        const i = idx(g, cx, cy);
        if (!g.blocked[i] && g.dist[i] >= localNeed) mask[i] = 1;
      }
  }
  return mask;
}

/** Flood fill over a passable mask from a set of seed cells. Returns the reached-cell labels (1 = reached). */
export function flood(g: Grid, mask: Uint8Array, seeds: number[]): Uint8Array {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0,
    tail = 0;
  for (const s of seeds) {
    if (s < 0 || s >= mask.length || !mask[s] || seen[s]) continue;
    seen[s] = 1;
    queue[tail++] = s;
  }
  while (head < tail) {
    const i = queue[head++];
    const cx = i % g.cols,
      cy = (i / g.cols) | 0;
    if (cx > 0) visit(i - 1);
    if (cx < g.cols - 1) visit(i + 1);
    if (cy > 0) visit(i - g.cols);
    if (cy < g.rows - 1) visit(i + g.cols);
  }
  function visit(j: number): void {
    if (mask[j] && !seen[j]) {
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return seen;
}

/** Nearest passable cell to a point within `radius` inches, or -1. */
export function nearestPassable(g: Grid, mask: Uint8Array, x: number, y: number, radius: number): number {
  const [cx, cy] = cellOf(g, x, y);
  const r = Math.ceil(radius / g.cell);
  let best = -1,
    bestD = Infinity;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const x2 = cx + dx,
        y2 = cy + dy;
      if (x2 < 0 || y2 < 0 || x2 >= g.cols || y2 >= g.rows) continue;
      const i = idx(g, x2, y2);
      if (!mask[i]) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  return best;
}

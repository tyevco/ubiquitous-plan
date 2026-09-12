# Floorplan layout manager

A small browser app for planning where the furniture goes in the new apartment,
and for finding out before moving day whether each piece can actually get there.

It runs entirely in the browser with no backend. Layouts save to the browser's
local storage automatically, and **Export** / **Import** move a layout between
computers as a JSON file, so both of you can work on the same plan.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests (geometry, walkability, transport)
npm run build      # static site in dist/
```

The workflow in `.github/workflows/deploy.yml` builds and tests on every push
and publishes `main` to GitHub Pages once Pages is enabled for the repository
(Settings → Pages → Source: GitHub Actions).

## What it does

**Layout mode**

- Both floors are pre-traced from the builder's floorplan, with every piece from
  the measuring sheet already in the furniture list (depth × width × height).
- Click **Place** on a piece, then click on the plan. Drag to move, `R` or
  double-click to rotate, arrow keys nudge 1" (`Shift` for 12"), `Del` removes,
  `Ctrl+Z` undoes. Pieces snap to walls and to each other.
- Selecting a piece shows its distance to the nearest wall on each side, the
  room it's in, and the route it would take to get there.
- The **Problems** list checks, live:
  - pieces overlapping each other, walls, or built-ins;
  - pieces blocking a doorway or standing in a door's swing;
  - drawer and door clearance in front of dressers, chests, and cabinets
    (item depth + 18" by default), chair space around tables, and 24" along
    both sides of each bed (nightstands are allowed there);
  - a 36" walking path between every door and stair landing on the floor;
  - a 24" path from a door to the front of every piece.
- The **walk** overlay paints where a person of the chosen width can stand
  (green = reachable from a door, orange = wide enough but cut off, red = too
  tight).

**Can we bring it?**

Every piece is checked against every route from outside: through the front or
garage door, up the stairs (width, headroom, and the landing turn), and through
each interior door, in every orientation including on its side or end. The
inventory badge shows whether it fits everywhere, only in some rooms, or
nowhere, and the panel explains which opening is the bottleneck and by how much.
Beds are marked as coming apart, which skips the check.

**Edit plan mode**

The floorplan image only states the room sizes, so wall positions, door widths,
and the stair geometry are estimates (interior doors 30", entry 36", stairs 36"
with a 36" × 36" landing turn). Edit mode lets you drag corners, walls, door
ends, and stair landings, or type exact numbers, once you have measured on site.
Rooms can be any polygon; fixtures (island, tub, water heater) are obstacles.

**Rules & tolerances** are all adjustable in the right-hand panel.

## Layout of the code

- `src/engine/geometry.ts` – rectangles, polygons, footprints, door swings.
- `src/engine/grid.ts` – rasterises a floor, exact distance transform, flood fill.
- `src/engine/analysis.ts` – the clearance and walkability rules.
- `src/engine/transport.ts` – fits-through-doors and around-the-stair-turn check.
- `src/engine/defaults.ts` – the traced apartment and the measured furniture.
- `src/render/canvas.ts` – SVG drawing and mouse interaction.
- `src/ui/panels.ts` – inventory, inspector, problems, settings, plan editor.

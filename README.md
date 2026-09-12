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
and publishes the repository's default branch to GitHub Pages at
https://tyevco.github.io/ubiquitous-plan/ (it enables Pages on first run).

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
- Windows are drawn in the walls; a piece taller than the sill standing in
  front of one is flagged.

**Auto-arrange**

Pick a room and tick the pieces that should go in it, and the arranger finds
spots for them: beds with their head to a wall and both sides free, nightstands
beside the bed, dressers and shelves backed against real walls, tables central,
doors, swings, stair landings, and walkways kept clear. It searches candidate
spots with the same rules the Problems list uses, so a clean result has no
warnings. Pieces that only fit by breaking a rule are placed last and listed as
compromises; pieces that can't fit at all (or can't be carried into the room)
are left out and the reason is given. Other pieces stay where they are and act
as obstacles, so you can arrange one room at a time or re-run after moving
something by hand. The search runs in a web worker and takes a second or two.

**Can we bring it?**

Every piece is checked against every route from outside: through the front or
garage door, up the stairs (width, headroom, and the landing turn), and through
each interior door, in every orientation including on its side or end. The
inventory badge shows whether it fits everywhere, only in some rooms, or
nowhere, and the panel explains which opening is the bottleneck and by how much.
Beds are marked as coming apart, which skips the check. The piano is marked
"must be carried upright", so it's only allowed through on its feet or a dolly,
never tipped on its side.

**Edit plan mode**

The floorplan image only states the room sizes, so wall positions, door widths,
and the stair geometry are estimates (interior doors 30", entry and patio
doors 36", a straight 42" stair with 80" headroom). Edit mode lets you drag corners, walls, door
ends, and stair landings, or type exact numbers, once you have measured on site.
Rooms can be any polygon; fixtures (island, tub, water heater) are obstacles.

The top bar shows the traced square footage next to the listed size (1,219
sq ft). Walls are counted the way listings do, the garage and patios are left
out, and any room can be toggled in or out of the total in Edit plan mode. If
the number drifts more than 5% from the listing after you correct the rooms,
the badge turns amber.

**Rules & tolerances** are all adjustable in the right-hand panel.

## Checking the trace against the plan

`docs/plan/plan.png` is the builder's plan. `docs/compare/` holds room-by-room
sheets with the app's trace beside the same window of the plan, and
`tools/room-compare/` regenerates them (see its README).

## Layout of the code

- `src/engine/geometry.ts` – rectangles, polygons, footprints, door swings.
- `src/engine/grid.ts` – rasterises a floor, exact distance transform, flood fill.
- `src/engine/analysis.ts` – the clearance and walkability rules.
- `src/engine/transport.ts` – fits-through-doors and around-the-stair-turn check.
- `src/engine/solver.ts` – the auto-arranger (runs in `solver.worker.ts`).
- `src/engine/defaults.ts` – the traced apartment and the measured furniture.
- `src/render/canvas.ts` – SVG drawing and mouse interaction.
- `src/ui/panels.ts` – inventory, inspector, problems, settings, plan editor.

# Room-by-room comparison

Renders every room from the app and crops the same window out of the marketing
plan (`docs/plan/plan.png`), then lays them out side by side.

```sh
npm run build && npx vite preview --port 4173 &       # the app the script zooms
CHROME_PATH=/path/to/chrome node tools/room-compare/crop-rooms.mjs
node tools/room-compare/make-sheet.mjs first
node tools/room-compare/make-sheet.mjs second living,hall-n,kitchen,hall,den a
node tools/room-compare/make-sheet.mjs second hall2,bath2,closet2,bed2 b
```

Output lands in `tools/room-compare/out/`. The plan image is registered to the
trace by each floor's outer outline (`REG` in `crop-rooms.mjs`, pixel
coordinates of the inside of the thick outer wall), so the crops line up as
well as the drawing's proportions allow. Needs `playwright-core` (a dev
dependency) and a Chromium binary via `CHROME_PATH`.

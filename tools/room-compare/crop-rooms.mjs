import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("tools/room-compare/out", { recursive: true }); process.chdir("tools/room-compare/out"); mkdirSync("rooms", { recursive: true }); mkdirSync("plan", { recursive: true });
const PAD = 30; // inches of context
// Plan image registration: the building outline (inside the thick outer line) per floor, in image pixels.
const REG = { first: { x0: 10, x1: 442, y0: 8, y1: 805 }, second: { x0: 572, x1: 1002, y0: 8, y1: 805 } };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await page.goto(process.env.APP_URL ?? "http://localhost:4173/");
await page.waitForTimeout(400);
await page.evaluate(() => localStorage.removeItem("ubiquitous-plan:v1"));
await page.reload();
await page.waitForTimeout(500);
await page.evaluate(() => { document.querySelector('[data-field=showGrid]').click(); });
const floors = await page.evaluate(() => window.__plan.store.project.floors.map((f) => ({ id: f.id, name: f.name, width: f.width, height: f.height, rooms: f.rooms.filter((r) => !r.virtual && !r.outdoor).map((r) => { const xs = r.polygon.map((p) => p.x), ys = r.polygon.map((p) => p.y); return { id: r.id, name: r.name, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }) })));
const meta = [];
for (const f of floors) {
  for (const r of f.rooms) {
    const win = { x: r.x - PAD, y: r.y - PAD, w: r.w + 2 * PAD, h: r.h + 2 * PAD };
    // App crop: fit the window in the canvas, then clip to it.
    const clip = await page.evaluate(({ f, win }) => {
      const { store } = window.__plan;
      store.update((p) => (p.activeFloorId = f.id));
      store.selection = null;
      const host = document.getElementById("canvas");
      const scale = Math.min(host.clientWidth / win.w, host.clientHeight / win.h);
      const tx = host.clientWidth / 2 - (win.x + win.w / 2) * scale, ty = host.clientHeight / 2 - (win.y + win.h / 2) * scale;
      store.views.set(f.id, { scale, tx, ty });
      store.touch();
      const b = host.getBoundingClientRect();
      return { x: b.left + tx + win.x * scale, y: b.top + ty + win.y * scale, width: win.w * scale, height: win.h * scale };
    }, { f, win });
    await page.waitForTimeout(200);
    const appFile = `rooms/${f.id}-${r.id}.png`;
    await page.screenshot({ path: appFile, clip });
    meta.push({ floorId: f.id, floorName: f.name, id: r.id, name: r.name, w: r.w, h: r.h, win, file: appFile, plan: `plan/${f.id}-${r.id}.png` });
  }
}
// Plan crops: draw the registered window from the image onto a canvas.
const planPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await planPage.goto("file://" + process.cwd() + "/../../../docs/plan/plan.png");
await planPage.waitForTimeout(300);
for (const m of meta) {
  const f = floors.find((x) => x.id === m.floorId);
  const reg = REG[m.floorId];
  const sx = (reg.x1 - reg.x0) / f.width, sy = (reg.y1 - reg.y0) / f.height;
  const src = { x: reg.x0 + m.win.x * sx, y: reg.y0 + m.win.y * sy, w: m.win.w * sx, h: m.win.h * sy };
  const dataUrl = await planPage.evaluate((src) => {
    const img = document.querySelector("img");
    const scale = 900 / src.w;
    const c = document.createElement("canvas");
    c.width = Math.round(src.w * scale); c.height = Math.round(src.h * scale);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, src.x, src.y, src.w, src.h, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  }, src);
  writeFileSync(m.plan, Buffer.from(dataUrl.split(",")[1], "base64"));
}
writeFileSync("rooms/meta.json", JSON.stringify(meta, null, 1));
console.log(`${meta.length} rooms`);
await browser.close();

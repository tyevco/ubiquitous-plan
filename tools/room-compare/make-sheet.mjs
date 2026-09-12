import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
process.chdir("tools/room-compare/out");
const floorFilter = process.argv[2];
const only = process.argv[3] ? process.argv[3].split(",") : null;
const meta = JSON.parse(readFileSync("rooms/meta.json", "utf8")).filter((m) => (!floorFilter || m.floorId === floorFilter) && (!only || only.includes(m.id)));
const suffix = (floorFilter || "all") + (process.argv[4] ? "-" + process.argv[4] : "");
const ftin = (v) => { const ft = Math.floor(v / 12), i = Math.round(v - ft * 12); return i ? `${ft}' ${i}"` : `${ft}'`; };
const rows = meta.map((m) => {
  const plan = `plan/${m.floorId}-${m.id}.png`;
  const planCell = existsSync(plan) ? `<img src="${plan}">` : `<div class="missing">Plan crop pending<br><span>needs the floor plan image in the repo</span></div>`;
  return `<section><h2>${m.name} <span>${m.floorName} · traced ${ftin(m.w)} × ${ftin(m.h)}</span></h2><div class="pair"><figure><img src="${m.file}"><figcaption>App</figcaption></figure><figure>${planCell}<figcaption>Marketing plan</figcaption></figure></div></section>`;
}).join("");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#fff;font-family:system-ui,sans-serif;color:#1f2328}
.wrap{width:1400px;padding:20px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 4px} p.sub{margin:0 0 12px;color:#555;font-size:13px}
section{border-top:1px solid #ddd;padding:12px 0}
h2{font-size:16px;margin:0 0 8px} h2 span{font-weight:400;color:#666;font-size:13px;margin-left:8px}
.pair{display:flex;gap:16px} figure{margin:0;flex:1;min-width:0}
figure img{width:100%;border:1px solid #ddd;border-radius:6px;background:#f4f2ee}
figcaption{font-size:12px;color:#666;margin-top:4px;text-align:center}
.missing{height:320px;border:1px dashed #bbb;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#888;font-size:14px;background:#fafafa}
.missing span{font-size:12px;color:#aaa;margin-top:4px}
</style></head><body><div class="wrap"><h1>Room by room: app trace vs marketing plan (${floorFilter === "first" ? "first floor" : floorFilter === "second" ? "second floor" : "both floors"})</h1><p class="sub">Left: the app zoomed to the room (30" of context around it). Right: the same room cropped from the marketing plan, once that image is available as a file.</p>${rows}</div></body></html>`;
writeFileSync(`compare-${suffix}.html`, html);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1.25 });
await page.goto("file://" + process.cwd() + `/compare-${suffix}.html`);
await page.waitForTimeout(800);
await page.locator(".wrap").screenshot({ path: `room-comparison-${suffix}.png` });
await browser.close();
console.log("sheet ok");

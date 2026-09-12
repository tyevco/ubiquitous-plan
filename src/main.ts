import "./styles.css";
import { Store } from "./state";
import { PlanCanvas } from "./render/canvas";
import { Panels } from "./ui/panels";
import { footprint } from "./engine/geometry";

const store = new Store();
const canvasHost = document.getElementById("canvas")!;
const canvas = new PlanCanvas(canvasHost, store);
const panels = new Panels(store, canvas, {
  top: document.getElementById("topbar")!,
  left: document.getElementById("left")!,
  right: document.getElementById("right")!,
});

let scheduled = false;
const render = (): void => {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    canvas.render();
    panels.render();
  });
};
store.subscribe(render);
document.title = `${store.project.name} · Floorplan`;
render();
requestAnimationFrame(() => canvas.fit());

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
  const sel = store.selection;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    store.redo();
    return;
  }
  if (e.key === "Escape") {
    store.placing = null;
    store.selection = null;
    store.touch();
    return;
  }
  if (e.key.toLowerCase() === "r") {
    if (store.placing) {
      store.placing.rotation = ((store.placing.rotation + 90) % 360) as 0;
      store.touch();
    } else if (sel?.type === "placement") canvas.rotate(sel.id);
    return;
  }
  if (sel?.type === "placement") {
    if (e.key === "Delete" || e.key === "Backspace") {
      store.update((p) => (p.placements = p.placements.filter((x) => x.id !== sel.id)));
      store.selection = null;
      store.touch();
      return;
    }
    const step = e.shiftKey ? 12 : 1;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const d = delta[e.key];
    if (d) {
      e.preventDefault();
      store.update((p) => {
        const pl = p.placements.find((x) => x.id === sel.id);
        if (!pl) return;
        pl.x += d[0];
        pl.y += d[1];
        // Keep it on the sheet.
        const item = p.furniture.find((f) => f.id === pl.itemId);
        const floor = p.floors.find((f) => f.id === pl.floorId);
        if (item && floor) {
          const fp = footprint(pl, item);
          pl.x = Math.min(Math.max(pl.x, -fp.w), floor.width);
          pl.y = Math.min(Math.max(pl.y, -fp.h), floor.height);
        }
      });
    }
  }
});

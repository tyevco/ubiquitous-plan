import type { FurnitureItem, Placement, Project, Settings } from "./types";
import { defaultProject, defaultSettings } from "./engine/defaults";
import { analyze, type Analysis } from "./engine/analysis";

export type Mode = "layout" | "edit";
export type Selection =
  | { type: "placement"; id: string }
  | { type: "room"; id: string }
  | { type: "fixture"; id: string }
  | { type: "passage"; id: string }
  | null;

export interface View {
  scale: number; // screen px per inch
  tx: number;
  ty: number;
}

export type WalkOverlay = "none" | "main" | "secondary";

const STORAGE_KEY = "ubiquitous-plan:v1";

export const uid = (prefix = "id"): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

export class Store {
  project: Project;
  mode: Mode = "layout";
  selection: Selection = null;
  /** Item being placed with the next click on the canvas. */
  placing: { itemId: string; rotation: Placement["rotation"] } | null = null;
  hoverIssueId: string | null = null;
  showZones = true;
  showGrid = true;
  walkOverlay: WalkOverlay = "none";
  views = new Map<string, View>();

  private listeners = new Set<() => void>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private dragSnapshot: string | null = null;
  private analysisCache: { version: number; value: Analysis } | null = null;
  private version = 0;

  constructor() {
    const stored = load();
    this.project = stored ?? defaultProject();
    if (!stored) save(this.project);
  }

  get floor() {
    return this.project.floors.find((f) => f.id === this.project.activeFloorId) ?? this.project.floors[0];
  }

  get analysis(): Analysis {
    if (!this.analysisCache || this.analysisCache.version !== this.version) {
      this.analysisCache = { version: this.version, value: analyze(this.project) };
    }
    return this.analysisCache.value;
  }

  item(id: string): FurnitureItem | undefined {
    return this.project.furniture.find((f) => f.id === id);
  }

  placement(id: string): Placement | undefined {
    return this.project.placements.find((p) => p.id === id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** UI-only change (selection, mode, view): notify without touching history. */
  touch(): void {
    for (const l of this.listeners) l();
  }

  /** Undoable project mutation. */
  update(mutate: (p: Project) => void): void {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    mutate(this.project);
    this.commit();
  }

  /** Start a drag: remember the state once, then call `updateTransient` per move and `endDrag` at the end. */
  beginDrag(): void {
    this.dragSnapshot = JSON.stringify(this.project);
  }

  updateTransient(mutate: (p: Project) => void): void {
    mutate(this.project);
    this.version++;
    this.touch();
  }

  endDrag(): void {
    if (this.dragSnapshot === null) return;
    const before = this.dragSnapshot;
    this.dragSnapshot = null;
    if (before !== JSON.stringify(this.project)) {
      this.undoStack.push(before);
      this.redoStack = [];
    }
    this.commit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.validateSelection();
    this.commit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.validateSelection();
    this.commit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  replaceProject(p: Project): void {
    this.undoStack.push(JSON.stringify(this.project));
    this.redoStack = [];
    this.project = normalize(p);
    this.selection = null;
    this.placing = null;
    this.commit();
  }

  private validateSelection(): void {
    const s = this.selection;
    if (!s) return;
    const floor = this.floor;
    const exists =
      s.type === "placement"
        ? this.project.placements.some((p) => p.id === s.id)
        : s.type === "room"
          ? floor.rooms.some((r) => r.id === s.id)
          : s.type === "fixture"
            ? floor.fixtures.some((r) => r.id === s.id)
            : floor.passages.some((r) => r.id === s.id);
    if (!exists) this.selection = null;
  }

  private commit(): void {
    this.version++;
    save(this.project);
    this.touch();
  }
}

function load(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function save(p: Project): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable; the app still works for the session */
  }
}

/** Fill in anything missing from an older or hand-edited file. */
export function normalize(p: Project): Project {
  const settings: Settings = { ...defaultSettings, ...(p.settings ?? {}) };
  const project: Project = {
    version: 1,
    name: p.name ?? "Apartment",
    floors: p.floors ?? [],
    furniture: p.furniture ?? [],
    placements: p.placements ?? [],
    settings,
    activeFloorId: p.activeFloorId ?? p.floors?.[0]?.id ?? "",
  };
  if (!project.floors.some((f) => f.id === project.activeFloorId)) project.activeFloorId = project.floors[0]?.id ?? "";
  for (const f of project.floors) {
    f.rooms ??= [];
    f.fixtures ??= [];
    f.passages ??= [];
  }
  return project;
}

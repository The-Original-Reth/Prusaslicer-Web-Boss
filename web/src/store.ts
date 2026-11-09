// The page's state, and the websocket to this tab's project on the server

import { create } from "zustand";
import { uploadThumbnails } from "./thumbnails";
import type { CatalogVendor, Changes, Choices, Mode, Plate, Presets, PresetType, Schema, Settings, SliceResult, UserPrinter, Value } from "./types";

export type Gizmo = "move" | "rotate" | "scale";
// The plater's two views, then the three settings tabs, as in BOSS's top bar
export type View = "3d" | "preview" | PresetType;
export type PresetChoice = Partial<Presets> & { vendor: string; printer: string };

interface Notice {
  id: number;
  kind: "error" | "info";
  text: string;
}

interface State {
  connected: boolean;
  sessionId: string | null;
  catalog: CatalogVendor[] | null;
  plate: Plate | null;
  choices: Choices;
  userPrinters: UserPrinter[];
  selected: number | null;
  // A part or modifier of the selected object, when one is selected rather than the object
  selectedVolume: number | null;
  gizmo: Gizmo;
  view: View;
  busy: string | null;
  progress: { percent: number; text: string } | null;
  slice: (SliceResult & { version: number }) | null;
  // The plate or settings changed since the last slice
  stale: boolean;
  notices: Notice[];
  schema: Schema | null;
  settings: Settings | null;
  // Which settings the tabs show: BOSS's Simple / Advanced / Expert mode
  mode: Mode;
  // A preset switch waiting for "transfer or discard the changes?"
  pendingSwitch: { presets: PresetChoice; types: PresetType[] } | null;
}

const MODE_KEY = "psw-mode";

function savedMode(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "simple" || m === "advanced" || m === "expert") return m;
  } catch {
    // storage may be unavailable
  }
  return "expert";
}

export const useStore = create<State>(() => ({
  connected: false,
  sessionId: null,
  catalog: null,
  schema: null,
  settings: null,
  mode: savedMode(),
  pendingSwitch: null,
  plate: null,
  choices: { prints: [], filaments: [], user: [] },
  userPrinters: [],
  selected: null,
  selectedVolume: null,
  gizmo: "move",
  view: "3d",
  busy: null,
  progress: null,
  slice: null,
  stale: true,
  notices: [],
}));

const set = useStore.setState;
const get = useStore.getState;

let noticeId = 0;
export function notify(text: string, kind: Notice["kind"] = "error") {
  const id = ++noticeId;
  set((s) => ({ notices: [...s.notices, { id, kind, text }] }));
  setTimeout(() => dismiss(id), kind === "error" ? 12000 : 5000);
}
export function dismiss(id: number) {
  set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

// ---- the websocket ----

let ws: WebSocket | null = null;
let nextId = 0;
const pending = new Map<string, { resolve: (m: any) => void; reject: (e: Error) => void }>();
const SESSION_KEY = "psw-session";
const PRESETS_KEY = "psw-presets";

export function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const session = sessionStorage.getItem(SESSION_KEY);
  const url = `${proto}//${location.host}/api/ws${session ? `?session=${encodeURIComponent(session)}` : ""}`;
  ws = new WebSocket(url);
  ws.onmessage = (e) => receive(JSON.parse(e.data));
  ws.onclose = () => {
    set({ connected: false });
    for (const p of pending.values()) p.reject(new Error("lost the connection to the server"));
    pending.clear();
    setTimeout(connect, 1500);
  };
}

// Sends a command to the engine; resolves with its reply, rejects with its error
export function send(cmd: string, fields: Record<string, unknown> = {}): Promise<any> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected to the server"));
  const id = `b${++nextId}`;
  ws.send(JSON.stringify({ cmd, id, ...fields }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// Like send, but shows errors instead of throwing them
export async function run(cmd: string, fields: Record<string, unknown> = {}) {
  try {
    return await send(cmd, fields);
  } catch (e) {
    notify((e as Error).message);
    return null;
  }
}

function receive(msg: any) {
  switch (msg.event) {
    case "session":
      sessionStorage.setItem(SESSION_KEY, msg.id);
      set({ sessionId: msg.id, connected: true });
      void start();
      return;
    case "progress":
      set({ progress: { percent: msg.percent, text: msg.text } });
      return;
    case "engine_stopped":
      notify("The slicing engine stopped unexpectedly. Reload the page to start a new project.");
      return;
  }
  // The whole plate (for a new tab), or what a command changed
  if (msg.state) applyPlate(msg.state, false);
  if (msg.settings) set({ settings: msg.settings });
  if (msg.changes) applyChanges(msg.changes);
  if (msg.event === "slice") {
    set((s) => ({ slice: { ...msg, version: (s.slice?.version ?? 0) + 1 }, stale: false }));
  }
  const p = typeof msg.id === "string" ? pending.get(msg.id) : undefined;
  if (p) {
    pending.delete(msg.id);
    if (msg.event === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  } else if (msg.event === "error") {
    notify(msg.message);
  }
}

// Every tab of the project gets every change. A tab that missed one (it has no plate yet,
// or the order names an object it doesn't know) reads the whole plate instead.
function applyChanges(c: Changes) {
  const plate = get().plate;
  if (!plate) return;
  const known = new Map(plate.objects.map((o) => [o.id, o]));
  for (const o of c.objects) known.set(o.id, o);
  if (c.order.some((id) => !known.has(id))) {
    void run("state");
    return;
  }
  if (c.settings !== undefined) set({ settings: c.settings });
  applyPlate({ ...plate, ...c.plate, objects: c.order.map((id) => known.get(id)!) }, c.stale);
}

function applyPlate(plate: Plate, changed: boolean) {
  set((s) => {
    const next: Partial<State> = { plate };
    if (plate.choices) {
      next.choices = plate.choices;
      if (plate.choices.printers) next.userPrinters = plate.choices.printers;
    }
    const object = plate.objects.find((o) => o.id === s.selected);
    if (s.selected !== null && !object) next.selected = null;
    if (s.selectedVolume !== null && !object?.volumes.some((v) => v.id === s.selectedVolume)) next.selectedVolume = null;
    if (changed) next.stale = true;
    return next;
  });
  if (plate.presets) localStorage.setItem(PRESETS_KEY, JSON.stringify(plate.presets));
}

// A new (or reloaded) tab: fetch the plate, and give a new project presets
async function start() {
  const reply = await run("state");
  if (!reply) return;
  if (!get().catalog) {
    const res = await fetch("/api/catalog");
    if (!res.ok) {
      notify("Could not load the printer profiles.");
      return;
    }
    set({ catalog: (await res.json()).vendors });
  }
  if (!get().schema) {
    const res = await fetch("/api/schema");
    if (res.ok) set({ schema: await res.json() });
    else notify("Could not load the settings definitions.");
  }
  if (!reply.state.presets) {
    // A printer remembered from an older version may not exist any more
    const saved = savedPresets();
    if (!saved || !(await selectPresets(saved))) await selectPresets(defaultPresets());
  }
}

function savedPresets(): PresetChoice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "null");
    if (saved?.vendor && saved?.printer) return saved;
  } catch {
    // ignore a bad saved value
  }
  return null;
}

function defaultPresets(): PresetChoice {
  const catalog = get().catalog ?? [];
  const vendor = catalog.find((v) => v.id === "PrusaResearch") ?? catalog[0];
  const model = vendor?.models.find((m) => m.id === "MK4S") ?? vendor?.models[0];
  const printer = model?.printers.find((p) => p.variant === "0.4") ?? model?.printers[0];
  return { vendor: vendor?.id ?? "", printer: printer?.name ?? "" };
}

// Resolves false (after showing why) when the engine refuses the presets
export async function selectPresets(p: PresetChoice, transfer = false) {
  set({ busy: "Loading profiles…" });
  try {
    await send("select_presets", { ...p, transfer });
    return true;
  } catch (e) {
    notify((e as Error).message);
    return false;
  } finally {
    set({ busy: null });
  }
}

// Switches presets, first asking what to do with changes to the presets being replaced,
// like BOSS's "unsaved changes" dialog
export function requestPresets(p: PresetChoice) {
  const s = get();
  const current = s.plate?.presets;
  if (!current || !s.settings) return selectPresets(p);
  const printerChanges = p.vendor !== current.vendor || p.printer !== current.printer;
  // A new printer may also bring a new print and filament, when the old ones don't fit it
  const changing: PresetType[] = [];
  if (printerChanges) changing.push("printer");
  if (printerChanges || (p.print && p.print !== current.print)) changing.push("print");
  if (printerChanges || (p.filament && p.filament !== current.filament)) changing.push("filament");
  const types = changing.filter((t) => s.settings!.modified[t].length > 0);
  if (types.length === 0) return selectPresets(p);
  set({ pendingSwitch: { presets: p, types } });
}

export function answerPendingSwitch(answer: "transfer" | "discard" | "cancel") {
  const pending = get().pendingSwitch;
  set({ pendingSwitch: null });
  if (pending && answer !== "cancel") void selectPresets(pending.presets, answer === "transfer");
}

export function setMode(mode: Mode) {
  set({ mode });
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // the mode just won't be remembered
  }
}

// One setting of a preset: a value, a whole vector, or one extruder's value of a vector.
// Resolves false (after showing why) when the engine refuses it.
export async function editSetting(preset: PresetType, key: string, value: Value | { index: number; value: string }) {
  try {
    await send("set", { preset, config: { [key]: value } });
    return true;
  } catch (e) {
    notify((e as Error).message);
    return false;
  }
}

// Saves a preset's current values under a name (BOSS's "Save preset"); it becomes selected.
// BOSS 3.0 has no way to delete one.
export async function savePreset(preset: PresetType, name: string) {
  try {
    await send("save_preset", { preset, name });
    notify(`Saved “${name}”.`, "info");
    return true;
  } catch (e) {
    notify((e as Error).message);
    return false;
  }
}

// Back to the preset's values: some settings ("key" or "key#extruder"), or all of them
export function resetSettings(preset: PresetType, keys?: string[]) {
  return run("reset", keys ? { preset, keys } : { preset });
}

// ---- actions ----

export async function uploadModels(files: FileList | File[]) {
  const sid = get().sessionId;
  if (!sid) return;
  for (const file of Array.from(files)) {
    set({ busy: `Loading ${file.name}…` });
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/sessions/${sid}/models`, { method: "POST", body });
      const reply = await res.json();
      // What the model changed reaches every tab through the websocket
      if (!res.ok) throw new Error(reply.detail ?? res.statusText);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      set({ busy: null });
    }
  }
}

export async function slice() {
  const s = get();
  if (s.busy) return;
  set({ busy: "Slicing…", progress: { percent: 0, text: "" } });
  try {
    // The G-code's thumbnails are drawn here; a failure only costs the pictures
    if (s.plate && s.sessionId && s.stale)
      await uploadThumbnails(s.plate, s.settings, s.sessionId).catch((e) => notify(`No thumbnails: ${(e as Error).message}`));
    await send("slice");
  } catch (e) {
    notify((e as Error).message);
  } finally {
    set({ busy: null, progress: null });
  }
}

export function fileUrl(name: string, query = "") {
  return `/api/sessions/${get().sessionId}/files/${name}${query}`;
}

// Deletes the selected part or modifier, or else the selected object
export async function deleteSelected() {
  const { selected, selectedVolume } = get();
  if (selected === null) return;
  if (selectedVolume !== null) await run("delete_volume", { object: selected, volume: selectedVolume });
  else await run("delete", { object: selected });
}

export function select(object: number | null, volume: number | null = null) {
  set({ selected: object, selectedVolume: object === null ? null : volume });
}

// Adds a part, modifier, negative volume or support enforcer/blocker, and selects it
export async function addVolume(object: number, type: string, shape: string) {
  const reply = await run("add_volume", { object, type, shape });
  if (reply?.added !== undefined) select(object, reply.added);
}

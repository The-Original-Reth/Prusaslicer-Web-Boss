import { useEffect, useRef, useState } from "react";
import { PreviewOverlay } from "./PreviewOverlay";
import { Scene } from "./Scene";
import { SettingsView, UnsavedChangesDialog } from "./Settings";
import { Sidebar } from "./Sidebar";
import { deleteSelected, dismiss, run, select, slice, uploadModels, useStore, type Gizmo, type View } from "./store";

const MODEL_TYPES = ".stl,.3mf,.obj,.amf";
const TABS: { view: View; label: string }[] = [
  { view: "3d", label: "3D view" },
  { view: "preview", label: "Preview" },
  { view: "print", label: "Print Settings" },
  { view: "filament", label: "Filament Settings" },
  { view: "printer", label: "Printer Settings" },
];

// Switching to Preview slices first when the plate changed, like BOSS
function showView(view: View) {
  const s = useStore.getState();
  useStore.setState({ view });
  if (view === "preview" && s.stale && !s.busy && (s.plate?.objects.length ?? 0) > 0) void slice();
}

export function App() {
  const view = useStore((s) => s.view);
  const connected = useStore((s) => s.connected);
  const [dragging, setDragging] = useState(false);
  const settingsTab = view === "print" || view === "filament" || view === "printer";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, select, textarea, .modal")) return;
      const s = useStore.getState();
      const gizmos: Record<string, Gizmo> = { m: "move", r: "rotate", s: "scale" };
      const plater = s.view === "3d" || s.view === "preview";
      if (plater && e.key === "Tab") showView(s.view === "3d" ? "preview" : "3d");
      else if (!plater) return;
      else if (s.view === "3d" && (e.key === "Delete" || e.key === "Backspace")) void deleteSelected();
      else if (s.view === "3d" && e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey) void run("arrange");
      else if (s.view === "3d" && gizmos[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) useStore.setState({ gizmo: gizmos[e.key.toLowerCase()] });
      else if (e.key === "Escape") select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Prusaslicer - <b>Web Boss</b>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.view} className={view === t.view ? "active" : ""} onClick={() => showView(t.view)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className={`status${connected ? " ok" : ""}`}>{connected ? "Connected" : "Connecting…"}</div>
      </header>
      {settingsTab && <SettingsView key={view} type={view} />}
      <main
        // The 3D scene stays alive behind the settings tabs, so coming back is instant
        hidden={settingsTab}
        className={`stage${dragging ? " dropping" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) {
            useStore.setState({ view: "3d" });
            void uploadModels(e.dataTransfer.files);
          }
        }}
      >
        <Scene />
        {view === "3d" && <PlaterToolbars />}
        {view === "preview" && <PreviewOverlay />}
        {!settingsTab && <Notices />}
        {dragging && <div className="drop-hint">Drop models to add them to the plate</div>}
      </main>
      {!settingsTab && <Sidebar />}
      {settingsTab && <Notices />}
      <UnsavedChangesDialog />
    </div>
  );
}

function PlaterToolbars() {
  const file = useRef<HTMLInputElement>(null);
  const gizmo = useStore((s) => s.gizmo);
  const hasSelection = useStore((s) => s.selected !== null);
  const hasObjects = useStore((s) => (s.plate?.objects.length ?? 0) > 0);
  const busy = useStore((s) => !!s.busy);
  const tool = (g: Gizmo, label: string, key: string, icon: string) => (
    <button className={gizmo === g ? "active" : ""} title={`${label} [${key}]`} onClick={() => useStore.setState({ gizmo: g })}>
      {icon}
    </button>
  );
  return (
    <>
      <div className="toolbar top">
        <button title="Add models (STL, 3MF, OBJ, AMF)" disabled={busy} onClick={() => file.current?.click()}>＋</button>
        <button title="Delete [Del]" disabled={!hasSelection} onClick={() => void deleteSelected()}>🗑</button>
        <button title="Delete all" disabled={!hasObjects} onClick={() => void run("clear")}>⨯</button>
        <span className="sep" />
        <button title="Arrange [A]" disabled={!hasObjects} onClick={() => void run("arrange")}>▦</button>
        <input
          ref={file}
          type="file"
          multiple
          accept={MODEL_TYPES}
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void uploadModels(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <div className="toolbar left">
        {tool("move", "Move", "M", "✥")}
        {tool("rotate", "Rotate", "R", "⟳")}
        {tool("scale", "Scale", "S", "⤢")}
      </div>
    </>
  );
}

function Notices() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="notices">
      {notices.map((n) => (
        <div key={n.id} className={`notice ${n.kind}`}>
          <span>{n.text}</span>
          <button className="icon" onClick={() => dismiss(n.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

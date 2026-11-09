// The plater's right-hand side, laid out like BOSS's: presets, the common print
// settings, the object list, the selected object's numbers, and slicing.

import { Fragment, useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { PrinterPicker } from "./PrinterPicker";
import { ObjectSettings, VOLUME_KINDS } from "./ObjectSettings";
import { PresetOptions } from "./Settings";
import { fileUrl, requestPresets, run, select, slice, useStore } from "./store";
import type { OptionDef, PlateObject } from "./types";

export function Sidebar() {
  return (
    <aside className="sidebar">
      <Presets />
      <ObjectList />
      <Manipulation />
      <SliceInfo />
      <Actions />
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

const SUPPORTS = [
  { label: "None", values: { support_material: "0", support_material_auto: "1", support_material_buildplate_only: "0" } },
  { label: "Support on build plate only", values: { support_material: "1", support_material_auto: "1", support_material_buildplate_only: "1" } },
  { label: "For support enforcers only", values: { support_material: "1", support_material_auto: "0", support_material_buildplate_only: "0" } },
  { label: "Everywhere", values: { support_material: "1", support_material_auto: "1", support_material_buildplate_only: "0" } },
];
const INFILLS = ["0%", "5%", "10%", "15%", "20%", "25%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"];

function supportsIndex(s: Record<string, string>) {
  if (s.support_material !== "1") return 0;
  if (s.support_material_auto !== "1") return 2;
  return s.support_material_buildplate_only === "1" ? 1 : 3;
}

// BOSS 3.0 makes "Generate supports" one choice (Off / Manual only / On); "build plate
// only" stays a separate switch
function supportChoices(def: OptionDef | undefined, buildplate: boolean) {
  if (def?.type !== "enum" || !def.enum_values) return null;
  const choices = def.enum_values.map((v, i) => ({
    label: def.enum_labels?.[i] ?? v,
    values: { support_material: v, ...(buildplate ? { support_material_buildplate_only: "0" } : {}) } as Record<string, string>,
  }));
  const on = def.enum_values.find((v) => v === "everywhere");
  if (buildplate && on) choices.push({ label: "On, build plate only", values: { support_material: on, support_material_buildplate_only: "1" } });
  return choices;
}

function Presets() {
  const presets = useStore((s) => s.plate?.presets);
  const settings = useStore((s) => s.plate?.settings ?? {});
  const choices = useStore((s) => s.choices);
  const busy = useStore((s) => s.busy);
  const modified = useStore((s) => s.settings?.modified);
  const [picking, setPicking] = useState(false);

  const change = (field: "print" | "filament", value: string) => {
    if (presets) void requestPresets({ ...presets, [field]: value });
  };
  const infill = settings.fill_density ?? "";
  const infills = INFILLS.includes(infill) || !infill ? INFILLS : [...INFILLS, infill];
  const supportDef = useStore((s) => s.schema?.options.support_material);
  const supports = supportChoices(supportDef, "support_material_buildplate_only" in settings) ?? SUPPORTS;
  // The choice whose values all match the current settings
  const supportIndex = supportChoices(supportDef, "support_material_buildplate_only" in settings)
    ? Math.max(0, supports.findIndex((c) => Object.entries(c.values).every(([k, v]) => (settings[k] ?? "0") === v)))
    : supportsIndex(settings);
  // Like BOSS's combo boxes: a preset with unsaved changes says so
  const name = (preset: string | undefined, type: "print" | "filament" | "printer") =>
    preset && modified?.[type].length ? `${preset} (modified)` : preset;

  return (
    <Section title="Presets">
      <label className="field">
        <span>Print settings</span>
        <select value={presets?.print ?? ""} disabled={!presets || !!busy} onChange={(e) => change("print", e.target.value)}>
          <PresetOptions names={choices.prints} user={choices.user} label={(p) => (p === presets?.print ? name(p, "print")! : p)} />
        </select>
      </label>
      <label className="field">
        <span>Filament</span>
        <select value={presets?.filament ?? ""} disabled={!presets || !!busy} onChange={(e) => change("filament", e.target.value)}>
          <PresetOptions names={choices.filaments} user={choices.user} label={(f) => (f === presets?.filament ? name(f, "filament")! : f)} />
        </select>
      </label>
      <div className="field">
        <span>Printer</span>
        <button className="picker-button" disabled={!!busy} onClick={() => setPicking(true)} title={presets?.printer}>
          {name(presets?.printer, "printer") ?? "Choose a printer…"}
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>Supports</span>
          <select
            value={supportIndex}
            disabled={!presets}
            onChange={(e) => void run("set", { preset: "print", config: supports[+e.target.value].values })}
          >
            {supports.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Infill</span>
          <select value={infill} disabled={!presets} onChange={(e) => void run("set", { preset: "print", config: { fill_density: e.target.value } })}>
            {infills.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="field check">
          <input
            type="checkbox"
            disabled={!presets}
            checked={parseFloat(settings.brim_width ?? "0") > 0}
            onChange={(e) => void run("set", { preset: "print", config: { brim_width: e.target.checked ? "5" : "0" } })}
          />
          <span>Brim</span>
        </label>
      </div>
      {picking && <PrinterPicker onClose={() => setPicking(false)} />}
    </Section>
  );
}

function ObjectList() {
  const objects = useStore((s) => s.plate?.objects ?? []);
  const selected = useStore((s) => s.selected);
  const selectedVolume = useStore((s) => s.selectedVolume);
  return (
    <Section title={`Objects (${objects.length})`}>
      {objects.length === 0 ? (
        <p className="hint">Add a model with the + button, or drop STL, 3MF, OBJ or AMF files on the bed.</p>
      ) : (
        <ul className="object-list">
          {objects.map((o) => (
            <Fragment key={o.id}>
              <li className={o.id === selected && selectedVolume === null ? "selected" : ""} onClick={() => select(o.id)}>
                <span className="name" title={o.name}>{o.name || "Object"}</span>
                {o.instances.length > 1 && <span className="count">×{o.instances.length}</span>}
                {Object.keys(o.settings ?? {}).length > 0 && (
                  <span className="has-settings" title={`Own settings: ${Object.keys(o.settings).length}`}>⚙</span>
                )}
                <span className="dims">{o.size.map((v) => v.toFixed(1)).join(" × ")}</span>
                <button
                  className="icon"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void run("delete", { object: o.id });
                  }}
                >
                  ×
                </button>
              </li>
              {/* Like BOSS, an object's volumes are listed once it has more than one */}
              {o.volumes.length > 1 &&
                o.volumes.map((v) => (
                  <li
                    key={v.id}
                    className={`volume ${v.type}${v.id === selectedVolume ? " selected" : ""}`}
                    onClick={() => select(o.id, v.id)}
                  >
                    <span className="volume-icon" title={VOLUME_KINDS[v.type].label}>{VOLUME_KINDS[v.type].icon}</span>
                    <span className="name" title={`${VOLUME_KINDS[v.type].label}: ${v.name}`}>{v.name || VOLUME_KINDS[v.type].label}</span>
                    {Object.keys(v.settings).length > 0 && <span className="has-settings">⚙</span>}
                    <button
                      className="icon"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void run("delete_volume", { object: o.id, volume: v.id });
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
            </Fragment>
          ))}
        </ul>
      )}
    </Section>
  );
}

// The selected object's first instance, taken apart into BOSS's object manipulation fields
function decompose(m: number[]) {
  const position = new THREE.Vector3(), q = new THREE.Quaternion(), scale = new THREE.Vector3();
  new THREE.Matrix4().fromArray(m).decompose(position, q, scale);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  const deg = THREE.MathUtils.radToDeg;
  return { position, rotation: new THREE.Vector3(deg(e.x), deg(e.y), deg(e.z)), scale };
}

function compose(position: THREE.Vector3, rotation: THREE.Vector3, scale: THREE.Vector3) {
  const rad = THREE.MathUtils.degToRad;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(rotation.x), rad(rotation.y), rad(rotation.z), "XYZ"));
  return new THREE.Matrix4().compose(position, q, scale).toArray();
}

function Manipulation() {
  const object = useStore((s) => s.plate?.objects.find((o) => o.id === s.selected));
  const volumeId = useStore((s) => s.selectedVolume);
  if (!object) return null;
  const volume = object.volumes.find((v) => v.id === volumeId);
  return (
    <>
      {!volume && <ManipulationFields key={object.id} object={object} />}
      <ObjectSettings key={`settings-${object.id}-${volume?.id ?? ""}`} object={object} volume={volume} />
    </>
  );
}

function ManipulationFields({ object }: { object: PlateObject }) {
  const [uniform, setUniform] = useState(true);
  const { position, rotation, scale } = useMemo(() => decompose(object.instances[0].matrix), [object]);
  const size = object.size;
  const send = (p: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3) =>
    void run("transform", { object: object.id, instance: 0, matrix: compose(p, r, s) });

  const setPosition = (axis: number, v: number) => {
    const p = position.clone();
    p.setComponent(axis, v);
    send(p, rotation, scale);
  };
  const setRotation = (axis: number, v: number) => {
    const r = rotation.clone();
    r.setComponent(axis, v);
    send(position, r, scale);
  };
  const setScale = (axis: number, factor: number) => {
    if (!(factor > 0)) return;
    const s = scale.clone();
    if (uniform) s.multiplyScalar(factor / s.getComponent(axis));
    else s.setComponent(axis, factor);
    send(position, rotation, s);
  };

  return (
    <Section title="Object manipulation">
      <div className="manip">
        <span />
        <span className="axis x">X</span>
        <span className="axis y">Y</span>
        <span className="axis z">Z</span>
        <span />
        <span className="row-label">Position</span>
        {[0, 1, 2].map((a) => (
          <NumberField key={a} value={position.getComponent(a)} readOnly={a === 2} onCommit={(v) => setPosition(a, v)} />
        ))}
        <span className="unit">mm</span>
        <span className="row-label">Rotation</span>
        {[0, 1, 2].map((a) => (
          <NumberField key={a} value={rotation.getComponent(a)} onCommit={(v) => setRotation(a, v)} />
        ))}
        <span className="unit">°</span>
        <span className="row-label">Scale</span>
        {[0, 1, 2].map((a) => (
          <NumberField key={a} value={scale.getComponent(a) * 100} onCommit={(v) => setScale(a, v / 100)} />
        ))}
        <span className="unit">%</span>
        <span className="row-label">Size</span>
        {[0, 1, 2].map((a) => (
          <NumberField
            key={a}
            value={size[a]}
            onCommit={(v) => size[a] > 0 && setScale(a, (scale.getComponent(a) * v) / size[a])}
          />
        ))}
        <span className="unit">mm</span>
      </div>
      <label className="field check">
        <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} />
        <span>Uniform scale</span>
      </label>
    </Section>
  );
}

function NumberField({ value, onCommit, readOnly }: { value: number; onCommit: (v: number) => void; readOnly?: boolean }) {
  const shown = (Math.abs(value) < 0.005 ? 0 : value).toFixed(2);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const v = parseFloat(text);
    if (Number.isFinite(v) && v.toFixed(2) !== shown) onCommit(v);
    else setText(shown);
  };
  return (
    <input
      className="num"
      value={text}
      readOnly={readOnly}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function SliceInfo() {
  const result = useStore((s) => s.slice);
  const stale = useStore((s) => s.stale);
  if (!result) return null;
  const st = result.stats;
  const seconds = (result.ms.process + result.ms.export) / 1000;
  // BOSS 2.9's engine said which slicing steps it reused; 3.0's service layer doesn't
  const steps = result.reused && result.recomputed
    ? `Reused ${result.reused.length} of ${result.reused.length + result.recomputed.length} slicing steps; ${seconds} s on the server.`
    : `${seconds} s on the server.`;
  return (
    <Section title={stale ? "Sliced info (out of date)" : "Sliced info"}>
      <dl className={`info${stale ? " stale" : ""}`}>
        <dt>Used filament (m)</dt>
        <dd>{(st.filament_mm / 1000).toFixed(2)}</dd>
        <dt>Used filament (g)</dt>
        <dd>{st.filament_g.toFixed(2)}</dd>
        {st.cost > 0 && (
          <>
            <dt>Cost</dt>
            <dd>{st.cost.toFixed(2)}</dd>
          </>
        )}
        <dt>Estimated printing time</dt>
        <dd>{st.print_time}</dd>
        <dt>Layers</dt>
        <dd>{st.layers}</dd>
      </dl>
      <p className="hint">
        {result.apply_status === "unchanged" ? "Nothing changed, nothing re-sliced." : steps}
      </p>
    </Section>
  );
}

function Actions() {
  const busy = useStore((s) => s.busy);
  const progress = useStore((s) => s.progress);
  const result = useStore((s) => s.slice);
  const stale = useStore((s) => s.stale);
  const hasObjects = useStore((s) => (s.plate?.objects.length ?? 0) > 0);
  return (
    <div className="actions">
      {busy && (
        <div className="progress">
          <div className="bar" style={{ width: `${progress?.percent ?? 0}%` }} />
          <span>{progress?.text || busy}</span>
        </div>
      )}
      {!stale && result ? (
        <a className="primary" href={fileUrl(result.gcode, `?download=${encodeURIComponent(result.output_name)}`)}>
          Export G-code
        </a>
      ) : (
        <button className="primary" disabled={!hasObjects || !!busy} onClick={() => void slice()}>
          Slice now
        </button>
      )}
    </div>
  );
}

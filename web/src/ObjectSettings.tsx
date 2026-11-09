// The selected object's (or part's, or modifier's) own settings, overriding the print preset
// for it only, like BOSS's object settings. The offered options are the ones BOSS lets an
// object or part override (their "overrides_in"). Also BOSS's "Add part / modifier / negative
// volume / support enforcer / blocker" menu, with its cube, cylinder and sphere.

import { useMemo, useState } from "react";
import { ScalarEditor } from "./Settings";
import { addVolume, notify, send, useStore } from "./store";
import type { OptionDef, PlateObject, PlateVolume, Schema, VolumeType } from "./types";

// How BOSS's object list labels the kinds of volume
export const VOLUME_KINDS: Record<VolumeType, { label: string; icon: string }> = {
  part: { label: "Part", icon: "◼" },
  negative: { label: "Negative volume", icon: "◻" },
  modifier: { label: "Modifier", icon: "◈" },
  support_enforcer: { label: "Support enforcer", icon: "▲" },
  support_blocker: { label: "Support blocker", icon: "⊘" },
};

const SHAPES = [
  { shape: "box", label: "Box" },
  { shape: "cylinder", label: "Cylinder" },
  { shape: "sphere", label: "Sphere" },
];

// "Extruders" and "Wipe options" only mean something with several extruders; parts and
// modifiers can't have support settings (is_improper_category)
function offered(schema: Schema, extruders: number, part: boolean) {
  return (part ? schema.part_options : schema.object_options).filter((k) => {
    const c = schema.options[k]?.category;
    return c && !(extruders === 1 && (c === "Extruders" || c === "Wipe options")) && !(part && c === "Support material");
  });
}

function labelOf(def: OptionDef | undefined, key: string) {
  return def ? def.full_label || def.label : key;
}

export function ObjectSettings({ object, volume }: { object: PlateObject; volume?: PlateVolume }) {
  const schema = useStore((s) => s.schema);
  const global = useStore((s) => s.settings?.values.print);
  const nozzles = useStore((s) => s.settings?.values.printer.nozzle_diameter);
  const [adding, setAdding] = useState(false);
  if (!schema || !global) return null;
  const extruders = Array.isArray(nozzles) ? nozzles.length : 1;
  const options = offered(schema, extruders, !!volume);
  const overrides = volume ? volume.settings : object.settings;
  // Holes and support enforcers/blockers have no settings of their own
  const configurable = !volume || volume.type === "part" || volume.type === "modifier";
  const target = volume ? { cmd: "volume_config", fields: { object: object.id, volume: volume.id } } : { cmd: "object_config", fields: { object: object.id } };
  const change = (fields: Record<string, unknown>) => send(target.cmd, { ...target.fields, ...fields });

  // New overrides start from the print preset's value
  const add = (keys: string[]) => {
    const set: Record<string, string> = {};
    for (const k of keys) {
      if (k in overrides || !options.includes(k)) continue;
      const v = global[k];
      set[k] = Array.isArray(v) ? v[0] ?? "" : v ?? schema.options[k]?.default ?? "";
    }
    if (Object.keys(set).length) change({ set }).catch((e) => notify((e as Error).message));
  };
  const keys = Object.keys(overrides);
  // Listed by category, like BOSS's object list
  const byCategory = new Map<string, string[]>();
  for (const k of keys) {
    const c = schema.options[k]?.category || "Other";
    byCategory.set(c, [...(byCategory.get(c) ?? []), k]);
  }
  const what = volume ? VOLUME_KINDS[volume.type].label.toLowerCase() : "object";

  return (
    <section className="section">
      <h3>{volume ? `${VOLUME_KINDS[volume.type].label}: ${volume.name || "unnamed"}` : "Settings for this object"}</h3>
      {volume && (
        <p className="hint">
          Move, rotate or scale it with the tools on the left.{" "}
          {configurable ? "" : volume.type === "negative" ? "It cuts its shape out of the object." : "It changes where supports go."}
        </p>
      )}
      {configurable && keys.length === 0 && <p className="hint">Uses the print settings. Add a setting to change it for this {what} only.</p>}
      {[...byCategory].map(([category, list]) => (
        <div key={category} className="object-settings">
          <h4>{category}</h4>
          {list.map((k) => (
            <Override key={k} name={k} value={overrides[k]} def={schema.options[k]} change={change} />
          ))}
        </div>
      ))}
      {configurable && (
        <div className="bundle-buttons">
          {schema.layout.object_bundles
            .filter((b) => b.keys.some((k) => options.includes(k) && !(k in overrides)))
            .map((b) => (
              <button key={b.title} className="text-button small" title={`Add: ${b.keys.map((k) => labelOf(schema.options[k], k)).join(", ")}`} onClick={() => add(b.keys)}>
                + {b.title}
              </button>
            ))}
          <button className="text-button small" onClick={() => setAdding(true)}>+ Other setting…</button>
        </div>
      )}
      <AddVolumeMenu object={object} />
      {adding && <AddSettingsDialog schema={schema} options={options} current={keys} what={what} onAdd={add} onClose={() => setAdding(false)} />}
    </section>
  );
}

// BOSS's object menu: a part, negative volume, modifier, support enforcer or blocker in one
// of the generic shapes
function AddVolumeMenu({ object }: { object: PlateObject }) {
  const types: VolumeType[] = ["part", "negative", "modifier", "support_enforcer", "support_blocker"];
  return (
    <select
      className="add-volume"
      value=""
      onChange={(e) => {
        const [type, shape] = e.target.value.split(":");
        if (type && shape) void addVolume(object.id, type, shape);
      }}
    >
      <option value="" disabled>Add part, modifier, hole, support enforcer…</option>
      {types.map((t) => (
        <optgroup key={t} label={`Add ${VOLUME_KINDS[t].label.toLowerCase()}`}>
          {SHAPES.map((s) => (
            <option key={s.shape} value={`${t}:${s.shape}`}>
              {VOLUME_KINDS[t].label}: {s.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Override({ name, value, def, change }: {
  name: string; value: string; def?: OptionDef; change: (fields: Record<string, unknown>) => Promise<unknown>;
}) {
  const commit = async (v: string) => {
    try {
      await change({ set: { [name]: v } });
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  };
  return (
    <div className="object-setting" title={def ? `${labelOf(def, name)}\n\n${def.tooltip}\n\nparameter name: ${name}` : name}>
      <span className="object-setting-label">{labelOf(def, name)}</span>
      <span className="opt-field">
        {def ? <ScalarEditor name={name} value={value} def={def} option={{ key: name }} disabled={false} onCommit={commit} /> : value}
        {def?.sidetext && def.type !== "bool" && <span className="sidetext">{def.sidetext}</span>}
      </span>
      <button
        className="icon"
        title="Remove: use the print settings' value"
        onClick={() => change({ remove: [name] }).catch((e) => notify((e as Error).message))}
      >
        ×
      </button>
    </div>
  );
}

// BOSS's "Add settings" dialog: every option this object (or part) can override, by
// category, with a search
function AddSettingsDialog({ schema, options, current, what, onAdd, onClose }: {
  schema: Schema; options: string[]; current: string[]; what: string; onAdd: (keys: string[]) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, string[]>();
    for (const k of options) {
      if (current.includes(k)) continue;
      const def = schema.options[k];
      if (q && !k.includes(q) && !labelOf(def, k).toLowerCase().includes(q)) continue;
      map.set(def.category, [...(map.get(def.category) ?? []), k]);
    }
    return [...map];
  }, [schema, options, current, query]);
  const toggle = (k: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal add-settings" role="dialog" aria-label="Add settings">
        <header>
          <h2>Add settings for this {what}</h2>
          <input autoFocus placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </header>
        <div className="add-settings-body">
          {groups.length === 0 && <p className="hint">Nothing matches.</p>}
          {groups.map(([category, keys]) => (
            <fieldset key={category}>
              <legend>{category}</legend>
              {keys.map((k) => (
                <label key={k} className="field check" title={schema.options[k].tooltip}>
                  <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
                  <span>{labelOf(schema.options[k], k)}</span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <footer>
          <button className="text-button" onClick={onClose}>Cancel</button>
          <button
            className="primary inline"
            disabled={picked.size === 0}
            onClick={() => {
              onAdd([...picked]);
              onClose();
            }}
          >
            Add {picked.size || ""}
          </button>
        </footer>
      </div>
    </div>
  );
}

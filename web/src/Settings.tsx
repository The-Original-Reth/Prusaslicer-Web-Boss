// The Print / Filament / Printer Settings tabs. Pages, groups and lines follow BOSS's own
// tabs (read from its source when the image is built); each option's label, tooltip, units,
// limits and Simple/Advanced/Expert mode come from its definition in libslic3r. Edits go to
// the selected preset at once, marked like BOSS does: an orange arrow on what differs from
// the preset (click it to go back), a lock on what doesn't.

import { useEffect, useMemo, useState } from "react";
import { PrinterPicker } from "./PrinterPicker";
import { answerPendingSwitch, editSetting, notify, requestPresets, resetSettings, savePreset, setMode, useStore } from "./store";
import type { LayoutGroup, LayoutLine, LayoutOption, LayoutPage, Mode, OptionDef, PresetType, Schema, Settings, Value } from "./types";

const TITLES: Record<PresetType, string> = { print: "Print settings", filament: "Filament", printer: "Printer" };
const MODES: { mode: Mode; label: string }[] = [
  { mode: "simple", label: "Simple" },
  { mode: "advanced", label: "Advanced" },
  { mode: "expert", label: "Expert" },
];
const MODE_RANK: Record<Mode, number> = { simple: 0, advanced: 1, expert: 2 };
const HELP_URL = "https://help.prusa3d.com/en/article/";

// G-code flavors with a "Machine limits" page, and what that page offers for them
// (TabPrinter::build_unregular_pages and update_fff)
const LIMITS_FLAVORS = ["marlin", "marlin2", "reprapfirmware", "klipper"];
const CONDITIONS: Record<string, (flavor: string) => boolean> = {
  supports_travel_acceleration: (f) => f === "marlin2" || f === "reprapfirmware",
  supports_min_feedrates: (f) => f === "marlin2" || f === "marlin",
};

// A page as shown: extruder pages and the machine limits page carry which values they edit
interface Page extends LayoutPage {
  extruder?: number;
  limits?: boolean;
}

function scalar(v: Value | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

// The printer tab's pages depend on the printer, as in BOSS: General and Custom G-code, then
// Machine limits (for some firmwares), one page per extruder, the single extruder
// multi-material page, Notes and Dependencies
function printerPages(schema: Schema, values: Record<string, Value>): Page[] {
  // BOSS 3.0's layout already lists every printer page
  if (!schema.layout.printer_extruder || !schema.layout.printer_machine_limits || !schema.layout.printer_single_extruder_mm)
    return schema.layout.printer;
  const [general, gcode, ...rest] = schema.layout.printer;
  const pages: Page[] = [general, gcode];
  if (LIMITS_FLAVORS.includes(scalar(values.gcode_flavor))) pages.push({ ...schema.layout.printer_machine_limits, limits: true });
  const extruders = Array.isArray(values.nozzle_diameter) ? values.nozzle_diameter.length : 1;
  for (let i = 0; i < extruders; i++)
    pages.push({ ...schema.layout.printer_extruder, title: `Extruder ${i + 1}`, extruder: i });
  if (extruders > 1 && scalar(values.single_extruder_multi_material) === "1") pages.push(schema.layout.printer_single_extruder_mm);
  return [...pages, ...rest];
}

function pagesOf(type: PresetType, schema: Schema, values: Record<string, Value>): Page[] {
  return type === "printer" ? printerPages(schema, values) : schema.layout[type];
}

// ---- which lines show ----

interface Context {
  type: PresetType;
  schema: Schema;
  settings: Settings;
  values: Record<string, Value>;
  mode: Mode;
  flavor: string;
}

function lineVisible(line: LayoutLine, ctx: Context) {
  if (line.when && !CONDITIONS[line.when]?.(ctx.flavor)) return false;
  return line.options.some((o) => {
    const def = defOf(o.key, ctx.schema);
    return !!def && MODE_RANK[def.mode] <= MODE_RANK[ctx.mode] && (o.key in ctx.values || o.key === "extruders_count");
  });
}

function visibleGroups(page: Page, ctx: Context, query: string): LayoutGroup[] {
  return page.groups
    .filter((g) => !g.when || CONDITIONS[g.when]?.(ctx.flavor))
    .map((g) => ({
      ...g,
      lines: g.lines.filter((l) => (query ? lineMatches(l, ctx, query) : lineVisible(l, ctx))),
    }))
    .filter((g) => g.lines.length > 0);
}

// Search finds options in every mode, like BOSS's search
function lineMatches(line: LayoutLine, ctx: Context, query: string) {
  const q = query.toLowerCase();
  if (line.label?.toLowerCase().includes(q)) return true;
  return line.options.some((o) => {
    const def = defOf(o.key, ctx.schema);
    return o.key.includes(q) || def?.label.toLowerCase().includes(q) || def?.full_label.toLowerCase().includes(q);
  });
}

function defOf(key: string, schema: Schema): OptionDef | undefined {
  return schema.options[key];
}

// ---- the tab ----

export function SettingsView({ type }: { type: PresetType }) {
  const schema = useStore((s) => s.schema);
  const settings = useStore((s) => s.settings);
  const mode = useStore((s) => s.mode);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  if (!schema || !settings) return <div className="settings"><p className="hint pad">Loading settings…</p></div>;
  const values = settings.values[type];
  const ctx: Context = { type, schema, settings, values, mode, flavor: scalar(settings.values.printer.gcode_flavor) };
  const pages = pagesOf(type, schema, values).filter((p) => visibleGroups(p, ctx, "").length > 0);
  const page = pages.find((p) => p.title === pageTitle) ?? pages[0];
  const q = query.trim();

  return (
    <div className="settings">
      <SettingsHeader type={type} query={query} setQuery={setQuery} />
      <div className="settings-body">
        <nav className="settings-pages">
          {pages.map((p) => (
            <button
              key={p.title}
              className={!q && p === page ? "active" : ""}
              onClick={() => {
                setQuery("");
                setPageTitle(p.title);
              }}
            >
              <PageIcon icon={p.icon} />
              {p.title}
              {pageModified(p, ctx) && <span className="dot" title="Changed from the preset" />}
            </button>
          ))}
        </nav>
        <div className="settings-page" key={q ? "search" : page?.title}>
          {q
            ? <SearchResults pages={pages} ctx={ctx} query={q} />
            : page && visibleGroups(page, ctx, "").map((g, i) => <Group key={`${g.title}-${i}`} group={g} page={page} ctx={ctx} />)}
        </div>
      </div>
    </div>
  );
}

function pageModified(page: Page, ctx: Context) {
  const modified = ctx.settings.modified[ctx.type];
  if (modified.length === 0) return false;
  return page.groups.some((g) => g.lines.some((l) => l.options.some((o) => indexesOf(o, page, ctx).some((i) => isModified(o.key, i, ctx)))));
}

function SearchResults({ pages, ctx, query }: { pages: Page[]; ctx: Context; query: string }) {
  const found = pages.flatMap((p) => visibleGroups(p, ctx, query).map((g) => ({ page: p, group: g })));
  if (found.length === 0) return <p className="hint pad">No setting matches “{query}”.</p>;
  return (
    <>
      {found.map(({ page, group }, i) => (
        <Group key={i} group={{ ...group, title: `${page.title} › ${group.title || "…"}` }} page={page} ctx={ctx} />
      ))}
    </>
  );
}

function SettingsHeader({ type, query, setQuery }: { type: PresetType; query: string; setQuery: (q: string) => void }) {
  const presets = useStore((s) => s.plate?.presets);
  const choices = useStore((s) => s.choices);
  const busy = useStore((s) => s.busy);
  const mode = useStore((s) => s.mode);
  const modified = useStore((s) => s.settings?.modified[type].length ?? 0);
  const hasModes = useStore((s) => s.schema?.modes !== false);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!presets) return null;

  const list = type === "print" ? choices.prints : choices.filaments;
  const isUser = !!presets.user?.[type];
  return (
    <header className="settings-header">
      <div className="preset-choice">
        <span className="preset-label">{TITLES[type]}</span>
        {type === "printer" ? (
          <button className="picker-button" disabled={!!busy} onClick={() => setPicking(true)}>
            {presets.printer}
          </button>
        ) : (
          <select
            value={presets[type]}
            disabled={!!busy}
            onChange={(e) => void requestPresets({ ...presets, [type]: e.target.value })}
          >
            <PresetOptions names={list} user={choices.user} />
          </select>
        )}
        {modified > 0 && <span className="modified-tag">(modified)</span>}
        <button className="text-button" disabled={!!busy} title="Save these settings as a preset of your own" onClick={() => setSaving(true)}>
          <SaveIcon /> Save…
        </button>
        <button
          className="text-button"
          disabled={modified === 0}
          title="Go back to the preset's values for every setting on this tab"
          onClick={() => void resetSettings(type)}
        >
          <UndoIcon /> Reset all
        </button>
      </div>
      <div className="settings-tools">
        <input
          className="search"
          placeholder="Search settings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
        />
        {/* BOSS 3.0 has no Simple / Advanced / Expert modes */}
        {hasModes && (
          <div className="modes" role="radiogroup" aria-label="Mode">
            {MODES.map((m) => (
              <button
                key={m.mode}
                role="radio"
                aria-checked={mode === m.mode}
                className={`mode-${m.mode}${mode === m.mode ? " active" : ""}`}
                onClick={() => setMode(m.mode)}
              >
                <span className="mode-dot" />
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {picking && <PrinterPicker onClose={() => setPicking(false)} />}
      {saving && <SavePresetDialog type={type} current={presets[type]} isUser={isUser} onClose={() => setSaving(false)} />}
    </header>
  );
}

// A preset list, with the user's own presets apart as in BOSS's combo boxes
export function PresetOptions({ names, user, label }: { names: string[]; user: string[]; label?: (name: string) => string }) {
  const option = (n: string) => <option key={n} value={n}>{label ? label(n) : n}</option>;
  const mine = names.filter((n) => user.includes(n));
  if (mine.length === 0) return <>{names.map(option)}</>;
  return (
    <>
      <optgroup label="System presets">{names.filter((n) => !user.includes(n)).map(option)}</optgroup>
      <optgroup label="User presets">{mine.map(option)}</optgroup>
    </>
  );
}

// BOSS's "Save preset" dialog: a new name makes a preset of your own based on this one; the
// name of one of yours overwrites it
function SavePresetDialog({ type, current, isUser, onClose }: { type: PresetType; current: string; isUser: boolean; onClose: () => void }) {
  const choices = useStore((s) => s.choices);
  const userPrinters = useStore((s) => s.userPrinters);
  // BOSS starts from the preset's short name: what comes before "@" (the printer it's for)
  const [name, setName] = useState(isUser ? current : current.split("@")[0].trim());
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const mine = type === "printer" ? userPrinters.map((p) => p.name) : choices.user;
  const others = type === "print" ? choices.prints : type === "filament" ? choices.filaments : [];
  let problem = "";
  if (!trimmed) problem = "Give the preset a name.";
  else if (/[<>[\]:"/\\|?*@]/.test(trimmed)) problem = "A name can't contain any of < > [ ] : \" / \\ | ? * @";
  else if (others.includes(trimmed) && !mine.includes(trimmed)) problem = "That's the name of a system preset.";
  const overwrite = !problem && mine.includes(trimmed);

  const save = async () => {
    if (problem || busy) return;
    setBusy(true);
    if (await savePreset(type, trimmed)) onClose();
    else setBusy(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal unsaved" role="dialog" aria-label="Save preset">
        <header>
          <h2>Save {TITLES[type].toLowerCase()} preset</h2>
        </header>
        <div className="unsaved-body">
          <label className="field">
            <span>Name</span>
            <input
              className="opt-input wide"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") onClose();
              }}
            />
          </label>
          {problem && <p className="form-error">{problem}</p>}
          {overwrite && <p className="hint">This replaces your preset “{trimmed}”.</p>}
          {!problem && !overwrite && <p className="hint">Saved on this server, for everyone who uses it.</p>}
        </div>
        <footer>
          <button className="text-button" onClick={onClose}>Cancel</button>
          <button className="primary inline" disabled={!!problem || busy} onClick={() => void save()}>
            {overwrite ? "Replace" : "Save"}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---- groups and lines ----

// Which values of an option a line edits: one per extruder page, normal + stealth on the
// machine limits page, the first (or only) one elsewhere
function indexesOf(o: LayoutOption, page: Page, ctx: Context): number[] {
  if (page.extruder !== undefined) return [page.extruder];
  if (o.columns) return scalar(ctx.values.silent_mode) === "1" ? [0, 1] : [0];
  return [0];
}

function isModified(key: string, index: number, ctx: Context) {
  const m = ctx.settings.modified[ctx.type];
  return m.includes(key) || m.includes(`${key}#${index}`) || (key === "extruders_count" && m.includes("nozzle_diameter"));
}

function isDisabled(key: string, index: number, ctx: Context) {
  return ctx.settings.disabled.includes(key) || ctx.settings.disabled.includes(`${key}#${index}`);
}

function Group({ group, page, ctx }: { group: LayoutGroup; page: Page; ctx: Context }) {
  const legend = page.limits && scalar(ctx.values.silent_mode) === "1";
  return (
    <section className={`opt-group${group.no_labels ? " no-labels" : ""}`}>
      {group.title && <h3>{group.title}</h3>}
      {legend && group.lines.some((l) => l.options.some((o) => o.columns)) && (
        <div className="opt-line legend-line">
          <span />
          <span />
          <div className="opt-fields">
            <span className="column-title" title="Values in this column are for Normal mode">Normal</span>
            <span className="column-title" title="Values in this column are for Stealth mode">Stealth</span>
          </div>
        </div>
      )}
      {group.lines.map((line, i) => <Line key={i} line={line} page={page} ctx={ctx} noLabel={!!group.no_labels} />)}
    </section>
  );
}

function Line({ line, page, ctx, noLabel }: { line: LayoutLine; page: Page; ctx: Context; noLabel: boolean }) {
  const options = line.options.filter((o) => o.key === "extruders_count" || (o.key in ctx.values && defOf(o.key, ctx.schema)));
  if (options.length === 0) return null;
  const first = defOf(options[0].key, ctx.schema);
  const single = options.length === 1;
  const label = line.label ?? (first ? first.label || first.full_label : options[0].key);
  // Every value this line edits, for its modified / lock marker
  const parts = options.flatMap((o) => indexesOf(o, page, ctx).map((i) => ({ key: o.key, index: i, def: defOf(o.key, ctx.schema) })));
  const modified = parts.filter((p) => isModified(p.key, p.index, ctx));
  const tooltip = single && first ? tooltipOf(options[0].key, first) : undefined;
  const wide = options.some((o) => o.full_width || defOf(o.key, ctx.schema)?.full_width);

  return (
    <div className={`opt-line${wide || noLabel ? " wide" : ""}`}>
      <Marker modified={modified.length > 0} onReset={() => void resetSettings(ctx.type, modified.map(resetKey))} />
      {!noLabel && (
        <span className="opt-label" title={tooltip}>
          {label}
          {label && ":"}
          {line.help && (
            <a className="help" href={HELP_URL + line.help} target="_blank" rel="noreferrer" title="Open BOSS's help for this setting">?</a>
          )}
        </span>
      )}
      <div className="opt-fields">
        {options.map((o) =>
          indexesOf(o, page, ctx).map((i) => (
            <OptionField key={`${o.key}#${i}`} option={o} index={i} ctx={ctx} showLabel={!single && !o.columns} />
          )),
        )}
      </div>
    </div>
  );
}

// Vector values that differ as a whole (bed shape, scripts) reset as a whole
function resetKey(p: { key: string; index: number; def?: OptionDef }) {
  if (p.key === "extruders_count") return "nozzle_diameter";
  return p.def?.vector && !p.def.whole ? `${p.key}#${p.index}` : p.key;
}

function tooltipOf(key: string, def: OptionDef) {
  return `${def.full_label}\n\n${def.tooltip}${def.tooltip ? "\n\n" : ""}parameter name: ${key}`;
}

function Marker({ modified, onReset }: { modified: boolean; onReset: () => void }) {
  return modified ? (
    <button className="marker modified" title="Changed from the preset. Click to go back to the preset's value." onClick={onReset}>
      <UndoIcon />
    </button>
  ) : (
    <span className="marker" title="Same as the preset">
      <LockIcon />
    </span>
  );
}

// ---- one option's editor ----

function OptionField({ option, index, ctx, showLabel }: { option: LayoutOption; index: number; ctx: Context; showLabel: boolean }) {
  const key = option.key;
  if (key === "extruders_count") return <ExtrudersCount ctx={ctx} />;
  const def = defOf(key, ctx.schema)!;
  const raw = ctx.values[key];
  const disabled = isDisabled(key, index, ctx) || !!def.readonly;
  const whole = !def.vector || def.whole;
  const value = whole ? raw : Array.isArray(raw) ? raw[index] ?? raw[0] ?? "" : raw;
  const commit = (v: string) => editSetting(ctx.type, key, whole ? v : { index, value: v });

  let editor: React.ReactNode;
  if (option.widget === "bed_shape") editor = <BedShape value={raw as string[]} ctx={ctx} />;
  else if (option.widget === "compatible_printers" || option.widget === "compatible_prints")
    editor = <ReadOnlyList values={raw as string[]} empty="All" />;
  else if (def.whole && def.type === "string")
    editor = <LinesEditor values={raw as string[]} def={def} option={option} disabled={disabled} onCommit={(lines) => editSetting(ctx.type, key, lines)} />;
  else editor = <ScalarEditor name={key} value={scalar(value)} def={def} option={option} disabled={disabled} onCommit={commit} />;

  const field = (
    <span className={`opt-field${disabled ? " disabled" : ""}`} title={tooltipOf(key, def)}>
      {showLabel && def.label && <span className="sub-label">{def.label}:</span>}
      {editor}
      {def.sidetext && def.type !== "bool" && <span className="sidetext">{def.sidetext}</span>}
    </span>
  );
  if (option.widget === "override" || def.nullable) return <Override def={def} keyName={key} value={scalar(value)} index={index} ctx={ctx} disabled={isDisabled(key, index, ctx)}>{field}</Override>;
  return field;
}

// Filament overrides: a checkbox turns BOSS's per-filament value on (a value) or off (nil,
// meaning the printer's value is used)
function Override({ def, keyName, value, index, ctx, disabled, children }: {
  def: OptionDef; keyName: string; value: string; index: number; ctx: Context; disabled: boolean; children: React.ReactNode;
}) {
  const on = value !== "nil";
  const toggle = (checked: boolean) => {
    let v = "nil";
    if (checked) {
      // Start from the printer's own value, as BOSS does
      const printer = ctx.settings.values.printer[keyName.replace(/^filament_/, "")];
      v = printer !== undefined ? scalar(printer) : def.default && def.default !== "nil" ? def.default : "0";
    }
    void editSetting(ctx.type, keyName, def.vector ? { index, value: v } : v);
  };
  return (
    <span className={`override${on ? "" : " off"}`}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => toggle(e.target.checked)} title="Override the printer's value for this filament" />
      {on ? children : <span className="opt-field disabled"><span className="nil">uses the printer's value</span></span>}
    </span>
  );
}

export function ScalarEditor({ name, value, def, option, disabled, onCommit }: {
  name: string; value: string; def: OptionDef; option: LayoutOption; disabled: boolean; onCommit: (v: string) => Promise<boolean>;
}) {
  if (def.type === "bool")
    return <input type="checkbox" checked={value === "1"} disabled={disabled} onChange={(e) => void onCommit(e.target.checked ? "1" : "0")} />;

  if (def.type === "enum" || def.gui_type === "select_close") {
    const values = def.enum_values ?? [];
    const labels = def.enum_labels ?? values;
    return (
      <select className="opt-select" value={value} disabled={disabled} onChange={(e) => void onCommit(e.target.value)}>
        {!values.includes(value) && <option value={value}>{value}</option>}
        {values.map((v, i) => <option key={v} value={v}>{labels[i] ?? v}</option>)}
      </select>
    );
  }

  // Only an extruder's color can be cleared: it then shows the filament's color
  if (def.gui_type === "color")
    return <ColorEditor value={value} clearable={name === "extruder_colour"} disabled={disabled} onCommit={onCommit} />;
  if (def.type === "point") return <PointEditor value={value} disabled={disabled} onCommit={onCommit} />;

  const multiline = def.multiline || option.height !== undefined;
  if (def.type === "string" && multiline) {
    const rows = Math.max(3, Math.round((option.height ?? def.height ?? 5) * 0.8));
    return <TextEditor value={value} rows={rows} code={!!(option.is_code || def.is_code)} disabled={disabled} onCommit={onCommit} />;
  }
  return <TextInput name={name} value={value} def={def} disabled={disabled} wide={!!(option.full_width || def.full_width) || def.type === "string"} onCommit={onCommit} />;
}

// Numbers are checked here first, the way BOSS's fields do, so the message names the setting
function check(text: string, def: OptionDef): string | null {
  const t = text.trim();
  const percent = t.endsWith("%");
  const number = percent ? t.slice(0, -1) : t;
  const label = def.full_label || def.label;
  if (def.type === "int" || def.type === "float" || def.type === "percent" || def.type === "float_or_percent") {
    if (def.gui_type === "f_enum_open" || def.gui_type === "i_enum_open") {
      if (def.enum_values?.includes(t)) return null;
    }
    if (number === "" || !Number.isFinite(Number(number))) return `${label}: “${text}” is not a number.`;
    if (percent && def.type !== "percent" && def.type !== "float_or_percent") return `${label} can't be a percentage.`;
    if (def.type === "int" && !Number.isInteger(Number(number))) return `${label} must be a whole number.`;
    const n = Number(number);
    if (!percent && def.min !== undefined && n < def.min) return `${label} can't be less than ${def.min}.`;
    if (!percent && def.max !== undefined && n > def.max) return `${label} can't be more than ${def.max}.`;
  }
  return null;
}

function TextInput({ name, value, def, disabled, wide, onCommit }: {
  name: string; value: string; def: OptionDef; disabled: boolean; wide: boolean; onCommit: (v: string) => Promise<boolean>;
}) {
  // Percentages show without their "%" when the units already say so (fill density)
  const hidePercent = def.type === "percent" && def.sidetext === "%";
  const shown = hidePercent ? value.replace(/%$/, "") : value;
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  // Open enums (fill density, infill anchor) suggest BOSS's usual values
  const listId = def.enum_values && def.gui_type?.endsWith("enum_open") ? `choices-${name}` : undefined;

  const commit = async () => {
    if (text === shown) return;
    const error = check(text, def);
    if (error) {
      notify(error);
      setText(shown);
      return;
    }
    let v = text.trim();
    if (hidePercent && !v.endsWith("%")) v += "%";
    if (!(await onCommit(v))) setText(shown);
  };
  return (
    <>
      <input
        className={`opt-input${wide ? " wide" : ""}${def.type === "string" ? "" : " number"}`}
        value={text}
        disabled={disabled}
        list={listId}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(shown);
        }}
      />
      {listId && (
        <datalist id={listId}>
          {def.enum_values!.map((v, i) => <option key={v} value={v}>{def.enum_labels?.[i]}</option>)}
        </datalist>
      )}
    </>
  );
}

function TextEditor({ value, rows, code, disabled, onCommit }: {
  value: string; rows: number; code: boolean; disabled: boolean; onCommit: (v: string) => Promise<boolean>;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <textarea
      className={`opt-text${code ? " code" : ""}`}
      rows={rows}
      value={text}
      disabled={disabled}
      spellCheck={!code}
      onChange={(e) => setText(e.target.value)}
      onBlur={async () => {
        if (text !== value && !(await onCommit(text))) setText(value);
      }}
    />
  );
}

// Vectors edited as a whole, one element per line (post-processing scripts, substitutions)
function LinesEditor({ values, def, option, disabled, onCommit }: {
  values: string[]; def: OptionDef; option: LayoutOption; disabled: boolean; onCommit: (v: string[]) => Promise<boolean>;
}) {
  const joined = (values ?? []).join("\n");
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  return (
    <textarea
      className="opt-text code"
      rows={Math.max(3, Math.round((option.height ?? def.height ?? 4) * 0.8))}
      value={text}
      disabled={disabled}
      spellCheck={false}
      placeholder="One per line"
      onChange={(e) => setText(e.target.value)}
      onBlur={async () => {
        if (text === joined) return;
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!(await onCommit(lines))) setText(joined);
      }}
    />
  );
}

function ReadOnlyList({ values, empty }: { values: string[]; empty: string }) {
  return <span className="readonly-list">{values?.length ? values.join(", ") : empty}</span>;
}

function ColorEditor({ value, clearable, disabled, onCommit }: {
  value: string; clearable: boolean; disabled: boolean; onCommit: (v: string) => Promise<boolean>;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <span className="color-field">
      <input type="color" value={valid ? value : "#000000"} disabled={disabled} onChange={(e) => void onCommit(e.target.value.toUpperCase())} />
      <span className="color-text">{value || "filament color"}</span>
      {clearable && value && !disabled && (
        <button className="text-button" onClick={() => void onCommit("")}>Reset to filament color</button>
      )}
    </span>
  );
}

function PointEditor({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (v: string) => Promise<boolean> }) {
  const [x, y] = value.split("x");
  const set = (axis: 0 | 1, text: string) => {
    const n = Number(text);
    if (!Number.isFinite(n)) return notify(`“${text}” is not a number.`);
    void onCommit(axis === 0 ? `${n}x${y}` : `${x}x${n}`);
  };
  return (
    <span className="point-field">
      X <NumberBox value={x} disabled={disabled} onCommit={(t) => set(0, t)} />
      Y <NumberBox value={y} disabled={disabled} onCommit={(t) => set(1, t)} />
    </span>
  );
}

function NumberBox({ value, disabled, onCommit }: { value: string; disabled?: boolean; onCommit: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className="opt-input number"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text.trim())}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

// BOSS's bed shape dialog, for the common case: a rectangle with its size and where the
// origin sits. Other shapes are shown as they are.
function BedShape({ value, ctx }: { value: string[]; ctx: Context }) {
  const points = (value ?? []).map((p) => p.split("x").map(Number) as [number, number]);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const rectangle = points.length === 4 && points.every(([x, y]) => (x === x0 || x === x1) && (y === y0 || y === y1));
  if (!rectangle) return <span className="readonly-list">Custom shape, {points.length} points</span>;

  const update = (w: number, d: number, ox: number, oy: number) => {
    if (!(w > 0 && d > 0)) return notify("The bed size must be more than 0.");
    const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
    const corners = [[-ox, -oy], [w - ox, -oy], [w - ox, d - oy], [-ox, d - oy]];
    void editSetting(ctx.type, "bed_shape", corners.map(([x, y]) => `${fmt(x)}x${fmt(y)}`));
  };
  const w = x1 - x0, d = y1 - y0, ox = -x0, oy = -y0;
  const num = (t: string) => Number(t);
  return (
    <span className="bed-shape">
      <span>Size</span>
      <NumberBox value={String(w)} onCommit={(t) => update(num(t), d, ox, oy)} />×
      <NumberBox value={String(d)} onCommit={(t) => update(w, num(t), ox, oy)} /> mm
      <span>Origin</span>
      <NumberBox value={String(ox)} onCommit={(t) => update(w, d, num(t), oy)} />,
      <NumberBox value={String(oy)} onCommit={(t) => update(w, d, ox, num(t))} /> mm
    </span>
  );
}

// The number of extruders isn't stored as such: BOSS edits the length of every
// per-extruder setting
function ExtrudersCount({ ctx }: { ctx: Context }) {
  const n = Array.isArray(ctx.values.nozzle_diameter) ? ctx.values.nozzle_diameter.length : 1;
  return (
    <span className="opt-field" title="Number of extruders of the printer.">
      <NumberBox
        value={String(n)}
        onCommit={(t) => {
          const v = Number(t);
          if (!Number.isInteger(v) || v < 1 || v > 256) return notify("Extruders must be a whole number from 1 to 256.");
          void editSetting("printer", "extruders_count", String(v));
        }}
      />
    </span>
  );
}

// ---- icons ----

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M6 3 2 7l4 4M2.5 7H10a4 4 0 0 1 0 8H7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <path d="M2.5 2.5h9l2 2v9h-11z M5 2.5v4h6v-4 M5 13.5v-4h6v4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// BOSS's page icons, as simple glyphs
const ICONS: Record<string, string> = {
  layers: "≡", infill: "▦", "skirt+brim": "◎", support: "⊥", time: "⏱", funnel: "▽", wrench: "⚙",
  "output+page_white": "⎙", note: "✎", spool: "◉", cooling: "❄", cog: "⚙", printer: "⎚",
};

function PageIcon({ icon }: { icon: string }) {
  return <span className="page-icon" aria-hidden>{ICONS[icon] ?? "•"}</span>;
}

// ---- switching presets with changes ----

export function UnsavedChangesDialog() {
  const pending = useStore((s) => s.pendingSwitch);
  const settings = useStore((s) => s.settings);
  const schema = useStore((s) => s.schema);
  const lists = useMemo(() => {
    if (!pending || !settings || !schema) return [];
    return pending.types.map((t) => ({
      type: t,
      items: settings.modified[t].map((k) => {
        const [key, index] = k.split("#");
        const def = schema.options[key];
        const name = def ? def.full_label || def.label : key;
        return index !== undefined && t === "printer" ? `${name} (extruder ${Number(index) + 1})` : name;
      }),
    }));
  }, [pending, settings, schema]);
  if (!pending) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal unsaved" role="dialog" aria-label="Unsaved changes">
        <header>
          <h2>Unsaved changes</h2>
        </header>
        <div className="unsaved-body">
          <p>You changed these settings. Keep them on the new preset, or discard them?</p>
          {lists.map((l) => (
            <div key={l.type}>
              <h4>{TITLES[l.type]}</h4>
              <ul>{[...new Set(l.items)].map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          ))}
        </div>
        <footer>
          <button className="text-button" onClick={() => answerPendingSwitch("cancel")}>Cancel</button>
          <button className="text-button" onClick={() => answerPendingSwitch("discard")}>Discard</button>
          <button className="primary inline" onClick={() => answerPendingSwitch("transfer")}>Transfer</button>
        </footer>
      </div>
    </div>
  );
}

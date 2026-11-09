// Shapes of what the engine sends (see engine/src/main.cpp)

export interface CatalogPrinter {
  name: string;
  variant: string;
}
export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  printers: CatalogPrinter[];
}
export interface CatalogVendor {
  id: string;
  name: string;
  models: CatalogModel[];
}

export interface Presets {
  vendor: string;
  printer: string;
  print: string;
  filament: string;
  // Which of these are the user's own saved presets
  user?: Record<"print" | "filament" | "printer", boolean>;
}

export interface UserPrinter {
  vendor: string;
  name: string;
}

export type VolumeType = "part" | "negative" | "modifier" | "support_enforcer" | "support_blocker";

// A part, modifier, negative volume or support enforcer/blocker of an object
export interface PlateVolume {
  id: number;
  name: string;
  type: VolumeType;
  mesh: string;
  // In the object's coordinates, column-major
  matrix: number[];
  settings: Record<string, string>;
}

export interface PlateObject {
  id: number;
  name: string;
  volumes: PlateVolume[];
  instances: { matrix: number[] }[];
  size: [number, number, number];
  // The object's own settings, overriding the print preset (as in a .ini)
  settings: Record<string, string>;
}

export interface Plate {
  presets: Presets | null;
  bed: { shape: [number, number][]; max_height: number };
  settings: Record<string, string>;
  objects: PlateObject[];
  choices?: Choices;
  // The printer's G-code thumbnails setting, e.g. "16x16/QOI, 313x173/QOI"
  thumbnails?: string;
}

// What a command changed, as BOSS reported it (every reply but "state" may carry one): the
// changed objects, whole; every object's id in order (an object missing from it is gone);
// the plate's own fields and the settings tabs when presets or settings changed; and whether
// the last slice no longer matches the plate
export interface Changes {
  objects: PlateObject[];
  order: number[];
  stale: boolean;
  plate?: Omit<Plate, "objects">;
  settings?: Settings | null;
}

// Presets that fit the selected printer; "user" names the user's own among them, "printers"
// lists every printer preset users saved
export interface Choices {
  prints: string[];
  filaments: string[];
  user: string[];
  printers?: UserPrinter[];
}

// ---- the settings tabs (engine/src/settings.cpp) ----

export type PresetType = "print" | "filament" | "printer";
export type Mode = "simple" | "advanced" | "expert";

export interface OptionDef {
  type: "float" | "int" | "string" | "percent" | "float_or_percent" | "point" | "point3" | "bool" | "enum" | "none";
  label: string;
  full_label: string;
  tooltip: string;
  sidetext: string;
  mode: Mode;
  category: string;
  // A vector holds one value per extruder, unless it's "whole" (edited as one thing)
  vector?: boolean;
  whole?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  multiline?: boolean;
  full_width?: boolean;
  is_code?: boolean;
  readonly?: boolean;
  height?: number;
  ratio_over?: string;
  gui_flags?: string;
  gui_type?: string;
  default?: string;
  enum_values?: string[];
  enum_labels?: string[];
}

export interface LayoutOption {
  key: string;
  full_width?: boolean;
  is_code?: boolean;
  height?: number;
  // A special editor BOSS draws for this option (bed_shape, compatible_printers, override, ...)
  widget?: string;
  // Machine limits: values for normal (0) and stealth (1) mode
  columns?: number;
}
export interface LayoutLine {
  label?: string;
  options: LayoutOption[];
  help?: string;
  when?: string;
}
export interface LayoutGroup {
  title: string;
  lines: LayoutLine[];
  no_labels?: boolean;
  when?: string;
}
export interface LayoutPage {
  title: string;
  icon: string;
  groups: LayoutGroup[];
}

export interface Schema {
  layout: Record<PresetType, LayoutPage[]> & {
    // BOSS 2.9's printer tab built these pages per printer; 3.0's layout lists every page
    printer_machine_limits?: LayoutPage;
    printer_extruder?: LayoutPage;
    printer_single_extruder_mm?: LayoutPage;
    // Quick-add groups of BOSS's object settings menu
    object_bundles: { title: string; keys: string[] }[];
  };
  options: Record<string, OptionDef>;
  // false when the slicer has no Simple / Advanced / Expert modes (BOSS 3.0)
  modes?: boolean;
  // Settings an object, or one of its parts, can override
  object_options: string[];
  part_options: string[];
}

export type Value = string | string[];

export interface Settings {
  values: Record<PresetType, Record<string, Value>>;
  // Changed from the selected preset: "key", or "key#extruder" for one value of a vector
  modified: Record<PresetType, string[]>;
  // Greyed out for the current values, as in BOSS's tabs
  disabled: string[];
}

export interface SliceResult {
  apply_status: "unchanged" | "changed" | "invalidated";
  // Only from engines that report slicing steps
  reused?: string[];
  recomputed?: string[];
  ms: { apply: number; process: number; export: number };
  gcode: string;
  output_name: string;
  preview: { file: string; segments: number; layers: number };
  stats: { print_time: string; filament_mm: number; filament_g: number; cost: number; layers: number };
}

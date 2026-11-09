# Prusaslicer - Web Boss: design

A web page that works like [PrusaSlicer BOSS](https://github.com/mjonuschat/PrusaSlicer)
3.0, following its [nightly build](https://github.com/mjonuschat/PrusaSlicer/releases/tag/nightly).
The browser draws the 3D scene. The server does the slicing with BOSS's own code.
The project is built on BOSS 3.0 only.

This document describes how BOSS 3.0 is built, and how the web slicer fits onto that structure.

## 1. BOSS 3.0's architecture

3.0 is not 2.9 with a new interface. The GUI was rewritten, and most of what used to be GUI code (`src/slic3r/GUI`) is now a
service layer that has no window code in it. The old `src/slic3r/` tree is still in the repository, but nothing
builds it.

### Layers

```
slic3r-base          logging, paths, asserts (already has Emscripten code paths)
slic3r-domain        pure data: Workbench, Project, ConfigContainer, Bed/BedInstance, Model,
                     ConfigItemDef/ConfigPack/ConfigBox, presets, MatDb types, virtual extruders
slic3r-biz-*         algorithms, CGAL, placeholder parser, crypto, arrange, Lua engine
libslic3r, libpgcode slicing engine (+ libslic3r/boss), G-code processor
slic3r-render        RHI over OpenGL + imgui                  ← first GL dependency
slic3r-platform      PlatformServices, main-thread dispatcher, JobManager, listeners
libvgcode            G-code viewer (GL)
slic3r-shared        Biz/  interactors: the application logic, no presentation
                     App/  presenters, imgui/Yoga UI, scene graph, gizmos, undo, Lua plugins
slic3r-platform-wx,  wxWidgets windows and dialogs, then the desktop app
slic3r-shared-wx, slic3r-app-desktop
slic3r-app-cli       headless runner built on slic3r-shared + arrange
```

The application logic lives in `slic3r-shared/Biz`. Its entry point is `Biz::ProjectInteractor`, which
owns the other interactors:

| Interactor | What it does |
|---|---|
| PresetInteractor | Selects and edits presets. Also covers object settings and macro overrides. |
| SceneInteractor | Objects, instances, volumes, beds and the selection. Painting, layer ranges and the layer height profile are changed through it. |
| SlicingInteractor | One background process per bed. Auto-slicing. StatusCache and FDMResultCache. |
| ArrangeInteractor | Arranging objects on the beds. |
| ObjectListInteractor | The tree of printer groups, beds, objects and volumes. |
| PrintModeInteractor | Print modes (see below). |
| VirtualExtruderInteractor | Virtual extruders. |
| MatDbInteractor | The material database. |
| PhysicalPrinterInteractor | Physical printers. |
| ExportDestinationInteractor | Where results are exported to. |
| PresetUpdaterInteractor | Updates to the preset repositories. |
| FileOpeningInteractor | Opening files. |
| BackupStore | Backups and crash recovery. |

The desktop app connects these to imgui and wx. The CLI connects them to nothing.

### The GUI boundary

CMake refuses a build without the GUI (`FATAL_ERROR "Non-GUI build is not supported yet"`). `slic3r-shared`
links render and platform, which are OpenGL and imgui. A comment says splitting it is planned.

A few Biz headers still include App code, which blocks a clean split:

- Emboss includes imgui truetype and the App scene.
- `MeshRaycaster` includes the App scene.
- `ValueMapBuilder` includes `App/Platform/KeyCode`.

The READMEs plan an SDL platform and a "webviewer" app. Neither exists in the tree yet.

### How the UI stays in sync

Everything the interface shows is pushed to it by listeners. Classes inherit `WithListeners<L...>`, and listeners fire on
the main thread. Background work posts its results back through `IMainThreadDispatcher`. The listeners that matter
to a remote client are:

| Source | Listeners |
|---|---|
| ProjectInteractor | projects added, removed, loaded and saved; selected project; selected printer group; printer-group and bed lists changed |
| SceneInteractor | `ISceneChangedListener` for instances and volumes (added, removed, transformed, mesh, type, facets); wipe tower; bed instances; selection; slicing input changed |
| PresetInteractor | `IPresetChangedListener` for selection, value changed and discarded changes; macro overrides |
| StatusCache, FDMResultCache | slicing status, progress, warnings and errors, and finished results, per `SlicingId` |
| Others | print modes, virtual extruders, colours, arrange, physical printers, backups |

Lists such as the object list and settings rows are `ObservableList<T>`s whose `IListObserver` reports
inserts, removes, updates and resets by index. That makes them cheap to mirror as diffs.

Dialogs are callbacks too: `IDialogManager`, `IMessageDialogProvider` and `FileOpeningInteractor::set_archive_dialog`.

### Projects, printer groups and beds

- A **Workbench** holds several open projects. They are tabs in the desktop app. All of them share one preset bundle.
- A **Project** holds its Model and a list of **ConfigContainers**, which the UI calls *printer groups*. Each printer group has:
  - its own selected printer, print and material presets (`SelectedPreset`, plus print-mode macro overrides);
  - project settings (colours, wiping volumes);
  - virtual extruders;
  - a physical printer;
  - its own list of **BedInstances**.
- A **BedInstance** is one plate placed in the scene, with a transform, its objects, a wipe tower and custom G-code.
  Objects belong to whichever plate's outline they sit inside (`BedTracking`). Objects outside every plate are
  "out of bed".
- Each bed is sliced on its own (`SlicingId{project, bed}`, one background process each). `slice_all` slices them one after another.

### What 3.0 adds

- **Print modes**: vase mode, breakaway or soluble supports, and others. Lua plugins provide them
  (`resources/lua/com.prusa3d.slicer.printmodes`, with an API in `doc/Plugin_API.md`), and the result is stored as config
  overrides on the printer group. The provider is App-layer (`App/Lua/PrintModePlugins`). The CLI doesn't wire it up,
  so a headless host gets no print modes unless it creates the plugin system itself.
- **Lua plugins** in general: signed bundles, a marketplace client, and calibration bundles (flow tower, temperature tower).
- **Virtual extruders**: colour mixes of real extruders, optionally with a Z gradient.
- **MatDb**: a local material database you can query, linked to presets and to Connect favourites.
- **Physical printers and print hosts**: OctoPrint, PrusaLink, Connect, Moonraker, Duet and others, plus user accounts (OAuth, MQTT).
- **Preset updater**: repository selection, local zip repositories, and reconfiguration checks.
- **Undo/redo**: `IUndoProvider` defines about 40 snapshot types. The Store that implements it is App-layer (cereal snapshots of the
  Model, printer groups and selection). ProjectInteractor defaults to a no-op provider.
- **Backups and crash recovery**: `BackupStore`.

### BOSS's own features

`src/boss` holds about 30 features, among them aligned rear seam, crosshatch, flowsnake, nip-tuck seam, structured fuzzy skin,
Klipper SCV cornering and small-area flow compensation. Each is declared by a `boss-feature.json` manifest that a generator turns into
registries at build time. Every feature is slicing engine or config only. None touches `slic3r-shared` or App.
Their options carry a category and option group in their `ConfigItemDef`, so they show up in the settings tree like any
other option. **The web UI gets every BOSS feature for free.**

## 2. How the web slicer maps onto it

```
browser (React + three.js)           gateway (Python)              engine (C++, one per project)
 3D bed, gizmos, painting      ⇄     sessions, uploads,       ⇄    hosts Biz::ProjectInteractor
 settings from ConfigItemDefs        presets on disk,              like slic3r-app-cli does;
 G-code preview, thumbnails          starts/stops engines          JSON lines on stdin/stdout
```

### The engine is a third front end

The engine is a front end to the Biz layer, built the same way `slic3r-app-cli` is: `PlatformServices`, a `StdMainThreadDispatcher`
pumped by the command loop, `JobManager`, then `ProjectInteractor`. It takes JSON commands, calls interactors, and waits on their
listeners. The engine never calls `libslic3r` (`Print::apply`) directly. Calling the interactors means it gets BOSS's own
behaviour for incremental re-slicing, bed tracking, presets and export. A setting change re-slices only what it affects,
because SlicingInteractor keeps each bed's process alive.

Where the desktop app connects a listener to a widget, the engine connects it to an **event**:

| Biz listener | What the page gets | Web |
|---|---|---|
| ISceneChangedListener | `changes.objects` (each changed object, whole) and `changes.order` | 3D scene, object list |
| IPresetChangedListener | `changes.plate` (presets, sidebar values, bed) and `changes.settings` | settings tabs, sidebar |
| ISlicingInputChangedListener (scene and presets) | `changes.stale` | "out of date" marks |
| IStatusCacheChangedListener (planned) | `progress`, `warning` | progress bar |
| IFDMResultCacheChangedListener (planned) | `slice` (stats, preview ready) | preview, export |
| IPrintModesChangedListener (planned) | `print_modes` | print-mode switches |

**Done:** the engine's `ChangeTracker` subscribes to the scene, preset and slicing-input listeners. Every reply but
`state` carries a `changes` diff of what they reported during the command, failed commands included. The diff is
idempotent: changed objects are sent whole, and `order` lists every object, so a missing id means the object is gone.
Every tab of a project gets every message. A tab that missed a change (it sees an id it doesn't know) reads the whole
`state` again. The slice is "out of date" exactly when BOSS says its slicing input changed. Undo and multiple beds need
this, because there one command changes things the command didn't name.

Progress and results still come with the `slice` reply, because the engine only runs BOSS's main-thread work while a
command runs. Auto-slicing in the background would need the engine to pump the dispatcher between commands too.

Dialogs become requests to the browser:

- **Done:** `HeadlessDialogManager` answers file and wipe dialogs.
- **Planned:** message dialogs and preset-name prompts become an `ask` event that the page answers.

### Process model

One engine process per open project. This matters more in 3.0, because ProjectInteractor leans on process-wide singletons
(`PlatformServices::instance()`, the secret store, app-instance messages). The gateway owns the processes, uploads, and
the data folder (`$DATA_DIR/boss`, passed in as `ENGINE_DATA_DIR`). That folder has BOSS's own layout, so presets and app config
are where BOSS expects them. Desktop-only services are left unwired or stubbed: removable drives, app-instance messaging,
the Printables downloader, the user account and Connect MQTT.

### Build

The image builds BOSS's tree with the GUI libraries, as required, and links the engine against `slic3r-app-cli`. The
runtime image therefore carries the GTK, GL and WebKit shared libraries, although nothing opens a window.

- When the split of `slic3r-shared` lands upstream, the engine moves to the Biz-only library, and those libraries leave the image.
- BOSS is pinned to a nightly commit that has been tried here (`SLICER_COMMIT`); moving the pin re-fetches the source.
- Servers run from a checkout of this repo and update with `sudo sh update.sh` (pull, rebuild what changed, restart).
- The dependency stage only depends on `deps/` and `cmake/`, so it stays cached between nightlies.

### Feature by feature

| Feature | 3.0 building block | Design |
|---|---|---|
| Printer catalogue | `get_printer_configs`, vendor bundles | grouped by vendor and model; BOSS's default print and material |
| Presets | PresetInteractor `select_*`, `set_item_value` | the engine keeps a snapshot for change marks; switching presets transfers or discards edits |
| Saved presets | preset save goes through `IPresetDialogManager`; names checked by `NameValidator` | the engine answers the name prompt with the name the page sent; BOSS 3.0 offers no delete (its `delete_preset` is private and only used when overwriting), so neither does the page |
| Settings tabs | `get_defs_fdm()` `ConfigItemDef`: category, option group, order, units, limits, enum defs | generated entirely from definitions; no layout script; 3.0 has no Simple/Advanced/Expert |
| Greyed-out options | not ported in 3.0 itself yet | follow upstream when it lands |
| Objects, instances, volumes | SceneInteractor | meshes go to the browser as binary files with matrices; the engine stays the source of truth for placement |
| Per-object settings | `ObjectSettingsInteractor`, reached through PresetInteractor's `set_item_override` / `set_item_value` at the Object or Volume location | the engine selects the object or volume in BOSS's scene, then edits, as BOSS's sidebar does; it takes undo snapshots, so the engine installs BOSS's `NoopUndoProvider` |
| Parts and modifiers | SceneInteractor `add_volume_to_active_object`, `set_element_transforms`, `delete_selected_elements` | BOSS's unit cube, cylinder and sphere, sized and placed as its object menu does |
| Layer ranges, variable layer height | `modify_layer_config_ranges`, `modify_layer_height_profile`, `Biz/Algorithms/LayerHeight` | adaptive and smoothing run in the engine; the curve editor runs in the browser |
| Painting (supports, seams, MMU, fuzzy skin) | `modify_facets_annotations`, TriangleSelector | ray picking is App-layer, so the browser picks and paints, and sends facet states |
| Cut | `Biz/Utils/CutUtils` | the plane and connectors come from the browser; the result is applied like the cut gizmo does |
| Measure | App-layer only | browser-side |
| Arrange | ArrangeInteractor | as the CLI does it |
| Multiple beds and printer groups | BedInstance, ConfigContainer, `SlicingId` | `scene` events carry beds; slicing and preview per bed; a bed picker in the page |
| Slicing | SlicingInteractor + StatusCache | auto-slice per bed; progress from the cache |
| Preview | libpgcode `MoveVertex` list from the FDM result | drawn by three.js; works for binary G-code |
| Thumbnails | `IThumbnailImageGenerator` | the browser renders RGBA, and the engine's generator flips it and hands it to export |
| Export | `do_result_export`, `ExportNameParser` | file download; `.bgcode` when the printer wants binary G-code |
| Print modes | PrintModeInteractor + Lua `PrintModePlugins` | the engine creates the plugin system (App code, no UI) and wires the provider; switches in the sidebar |
| Undo/redo | `IUndoProvider` | port the App Store, which is serialisation code, into the engine, or write a smaller provider |
| Virtual extruders, MatDb | their interactors | later; MatDb queries proxied through the gateway |
| Physical printers, print hosts | PhysicalPrinterInteractor, PrintHost | later; uploads run from the server, so the server needs network access to the printer |
| 3MF projects | `save_project` / `load_project` | save works; legacy (2.x) 3MF is not supported upstream yet |

## 3. Plan

Working on 3.0 today:

- printer catalogue and presets;
- settings tabs with change marks, reset and transfer;
- load, add shapes, transform, arrange;
- incremental slicing, preview and statistics;
- binary G-code with browser thumbnails;
- saved presets (no delete: BOSS 3.0 has none);
- per-object settings, parts and modifiers.

Next, in order:

1. (done) **Saved presets, per-object settings, parts and modifiers**, built on PresetInteractor, ObjectSettingsInteractor and SceneInteractor.
2. (done) **Listener-driven events**: replies carry diffs from BOSS's scene, preset and slicing-input listeners. Status
   events from the background (auto-slicing) come with step 3.
3. **Multiple beds and printer groups**: a bed picker, per-bed slicing and preview.
4. **Print modes and plugins**: the bundled print-mode and calibration plugins.
5. **Undo/redo**: bring BOSS's undo Store into the engine.
6. **Painting, layer ranges, variable layer height, cut, measure.**
7. **3MF project save and load.**
8. **Later**: virtual extruders, MatDb, physical printers and print hosts.

## 4. Risks

- **3.0 is alpha, and Biz is not a public API.** A new nightly can need engine changes. So the image is pinned to a
  nightly commit that has been tried here, and the pin only moves after a new nightly builds and passes the tests.
- **GUI libraries in a headless image.** This holds until upstream splits `slic3r-shared`.
- **App-layer pieces the engine needs**: the print-mode provider, the undo Store and the thumbnail generator. The engine either links App code
  without its UI, or reimplements it.
- **Process-wide singletons.** These rule out several projects in one process, so the design stays at one process per project.
- **Private or dialog-driven APIs.** Preset delete and preset naming either need small upstream changes or workarounds.

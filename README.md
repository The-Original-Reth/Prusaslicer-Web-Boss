# Prusaslicer - Web Boss

> [!WARNING]
> **Work in progress.** This is an early, unfinished project, not ready for real use. Features
> are missing or incomplete, things will break, and settings or saved presets may change
> without notice between versions. It follows BOSS 3.0's nightly build, which is itself alpha
> software.

[PrusaSlicer BOSS](https://github.com/mjonuschat/PrusaSlicer) 3.0 (its [nightly build](https://github.com/mjonuschat/PrusaSlicer/releases/tag/nightly)) in a web
page. Slicing runs on the server with BOSS's own slicing library; the 3D view and the
G-code preview are drawn in your browser. See [docs/DESIGN.md](docs/DESIGN.md).

## Run it

```bash
docker compose up -d --build
```

Then open http://localhost:8960. The first build compiles BOSS's dependencies and slicing
library, which takes a while (30+ minutes with 4 jobs); later builds reuse them.

### On a server

The server runs from a checkout of this repo (with Docker installed). To install it:

```bash
git clone https://github.com/The-Original-Reth/Prusaslicer-Web-Boss.git /opt/prusaslicer-web-boss
```

To update it to the latest version on GitHub (pull, rebuild what changed, restart; data in
`./data` is kept):

```bash
cd /opt/prusaslicer-web-boss && sudo sh update.sh
```

### Updating BOSS

BOSS is pinned to one of its nightly builds (`SLICER_COMMIT` in the Dockerfile), so a server
only gets a new BOSS once it has been tried here. To move to a newer nightly: build with
`--build-arg SLICER_COMMIT=<the nightly's commit>`, run the engine tests and try the page,
fix what the new nightly broke, then change the pin and push. Servers pick it up with
`update.sh`; their first build after a BOSS change takes an hour or more.

## What works

- Add STL, 3MF, OBJ and AMF models (button or drag and drop), move, rotate and scale them
  on the bed, arrange, delete.
- Choose any printer bundled with BOSS, with the print and filament profiles that fit it.
- Supports, infill and brim from the sidebar, like BOSS's plater.
- Print, Filament and Printer Settings tabs with every setting, laid out as in BOSS (its
  categories and option groups), including BOSS's own features. Changes are marked and can
  be undone per setting or per tab; switching presets asks whether to transfer or discard them.
- Slice, see used filament and print time, preview the toolpaths by feature and layer, and
  download the G-code. Re-slicing only redoes the steps a change affects.
- G-code thumbnails for printers that show them (the sizes and formats in the printer's
  "G-code thumbnails" setting), drawn by the page.
- Save your changes as presets of your own (Save… in each settings tab) with BOSS's own name
  rules; saved printers appear under "My printers". They're kept in BOSS's data folder
  (`data/boss/`) and shared by everyone using the server. BOSS 3.0 has no way to delete one yet.
- Per-object settings: select an object to override any setting BOSS lets an object override.
- Parts, modifiers, negative volumes (holes), support enforcers and blockers: cube, cylinder
  or sphere, added from the object's panel as BOSS places them, moved / rotated / scaled with
  the gizmos, with their own settings for parts and modifiers.

Not yet: greyed-out options (BOSS 3.0 hasn't ported them itself), undo, multiple beds. See the
plan in [docs/DESIGN.md](docs/DESIGN.md).

## Pieces

| Folder | What | Runs as |
|---|---|---|
| `engine/` | C++ program built inside BOSS's source tree; one per open project | JSON lines on stdin/stdout |
| `gateway/` | Python (FastAPI) server: web page, uploads, websocket to each project's engine | port 8080 in the container |
| `web/` | React + three.js page | served by the gateway |

Engine alone, for tests: `docker build --target engine -t prusaslicer-web-engine .`, then
pipe commands into `docker run -i --rm prusaslicer-web-engine` (examples in `engine/test/`:
`plate.jsonl` for the plate and slicing, `settings.jsonl` for editing presets,
`presets.jsonl` for saving them, `objects.jsonl` for per-object settings, and `volumes.jsonl`
for modifiers and holes).

Developing the page: run the container, then `npm run dev` in `web/` (it proxies `/api` to
port 8080, so publish that port, e.g. `docker run -p 8080:8080 prusaslicer-web-boss`).

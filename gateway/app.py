"""Prusaslicer - Web Boss: the gateway.

Serves the web page, and gives each open project (a "session") its own engine process
(engine/src/main.cpp), talking JSON lines to it. The browser keeps a websocket per
session: its commands go to the engine, and everything the engine says (replies,
progress, errors) goes back to every socket of that session. Model files arrive by
upload, and the files the engine writes (meshes, toolpaths, G-code) are served from the
session's folder. The browser never names a path on the server.
"""

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ENGINE_BIN = os.environ.get("ENGINE_BIN", "prusaslicer-web-engine")
WEB_DIR = os.environ.get("WEB_DIR")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
# BOSS 3.0's own data folder (its preset copies, the presets users save, logs)
BOSS_DATA_DIR = DATA_DIR / "boss"
# How long a project is kept after its last browser tab closes (seconds)
SESSION_TTL = int(os.environ.get("SESSION_TTL", 15 * 60))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_MB", 500)) * 1024 * 1024

MODEL_SUFFIXES = {".stl", ".3mf", ".obj", ".amf"}
# Commands the browser may send, and the fields each may carry ("id" is always allowed)
BROWSER_COMMANDS = {
    "state": set(),
    "select_presets": {"vendor", "printer", "print", "filament", "transfer"},
    "set": {"preset", "config"},
    "reset": {"preset", "keys"},
    "settings": set(),
    "save_preset": {"preset", "name"},
    "add_shape": {"shape", "size"},
    "transform": {"object", "instance", "matrix"},
    "object_config": {"object", "set", "remove"},
    "add_volume": {"object", "type", "shape"},
    "volume_transform": {"object", "volume", "matrix"},
    "volume_config": {"object", "volume", "set", "remove"},
    "delete_volume": {"object", "volume"},
    "delete": {"object"},
    "clear": set(),
    "arrange": set(),
    "slice": set(),
}
SERVED_FILE = re.compile(r"^(mesh-\d+\.bin|preview\.bin|output\.b?gcode)$")
GATEWAY_ID = "gw:"

log = logging.getLogger("gateway")


class EngineError(Exception):
    pass


class Engine:
    """One engine process. Replies to the gateway's own requests (ids starting with
    "gw:") resolve their futures; every message is also passed to on_message."""

    def __init__(self, workdir: Path, on_message=None):
        self.workdir = workdir
        self.on_message = on_message
        self.proc = None
        self.pending: dict[str, asyncio.Future] = {}
        self.next_id = 0
        self.reader = None

    async def start(self):
        self.proc = await asyncio.create_subprocess_exec(
            ENGINE_BIN,
            cwd=self.workdir,
            # BOSS's data folder (its presets, including the ones users save) is shared by
            # every project on this server
            env={**os.environ, "ENGINE_DATA_DIR": str(BOSS_DATA_DIR)},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # The catalog and states can be long lines
            limit=64 * 1024 * 1024,
        )
        self.reader = asyncio.create_task(self._read())

    @property
    def alive(self):
        return self.proc is not None and self.proc.returncode is None

    def send(self, msg: dict):
        if not self.alive:
            raise EngineError("the engine has stopped")
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())

    async def request(self, msg: dict) -> dict:
        self.next_id += 1
        rid = f"{GATEWAY_ID}{self.next_id}"
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        try:
            self.send({**msg, "id": rid})
            reply = await future
        finally:
            self.pending.pop(rid, None)
        if reply.get("event") == "error":
            raise EngineError(reply.get("message", "engine error"))
        return reply

    async def _read(self):
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                log.warning("engine said something that isn't JSON: %r", line[:200])
                continue
            future = self.pending.get(msg.get("id")) if isinstance(msg.get("id"), str) else None
            if future and not future.done():
                future.set_result(msg)
            if self.on_message:
                await self.on_message(msg)
        await self.proc.wait()
        for future in self.pending.values():
            if not future.done():
                future.set_exception(EngineError("the engine has stopped"))
        if self.on_message:
            await self.on_message({"event": "engine_stopped", "code": self.proc.returncode})

    async def stop(self):
        if self.alive:
            try:
                self.send({"cmd": "quit"})
                await asyncio.wait_for(self.proc.wait(), 5)
            except (EngineError, asyncio.TimeoutError, ConnectionError):
                self.proc.kill()
                await self.proc.wait()


class Session:
    """One open project: a folder, an engine, and the browser tabs showing it."""

    def __init__(self):
        self.id = secrets.token_urlsafe(16)
        self.dir = DATA_DIR / "sessions" / self.id
        self.sockets: set[WebSocket] = set()
        self.last_seen = time.monotonic()
        self.engine = Engine(self.dir, self.broadcast)

    async def start(self):
        (self.dir / "uploads").mkdir(parents=True)
        await self.engine.start()

    async def broadcast(self, msg: dict):
        # The gateway's own request ids mean nothing to the browser
        if isinstance(msg.get("id"), str) and msg["id"].startswith(GATEWAY_ID):
            msg = {k: v for k, v in msg.items() if k != "id"}
        for ws in list(self.sockets):
            try:
                await ws.send_json(msg)
            except Exception:
                self.sockets.discard(ws)

    async def close(self):
        await self.engine.stop()
        shutil.rmtree(self.dir, ignore_errors=True)


sessions: dict[str, Session] = {}
catalog_task: asyncio.Task | None = None

app = FastAPI(title="Prusaslicer - Web Boss")
app.add_middleware(GZipMiddleware, minimum_size=1024)


async def load_catalog() -> dict:
    """Every FFF printer of every bundled vendor, and the settings tabs' layout and option
    definitions, from a short-lived engine. Neither changes while the app runs."""
    workdir = DATA_DIR / "catalog"
    workdir.mkdir(parents=True, exist_ok=True)
    engine = Engine(workdir)
    await engine.start()
    try:
        started = time.monotonic()
        vendors = (await engine.request({"cmd": "catalog"}))["vendors"]
        log.info("printer catalog loaded in %.1fs", time.monotonic() - started)
        try:
            schema = await engine.request({"cmd": "schema"})
        except EngineError as e:
            # An engine without the settings tabs still slices
            log.warning("no settings definitions: %s", e)
            return {"vendors": vendors, "schema": None}
        if schema.get("missing"):
            log.warning("settings without a definition: %s", ", ".join(schema["missing"]))
        for key in ("missing", "event", "id"):
            schema.pop(key, None)
        return {"vendors": vendors, "schema": schema}
    finally:
        await engine.stop()


async def reap_sessions():
    """Closes projects no tab has shown for SESSION_TTL seconds, and dead engines."""
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        for sid, s in list(sessions.items()):
            if not s.engine.alive or (not s.sockets and now - s.last_seen > SESSION_TTL):
                sessions.pop(sid, None)
                await s.close()


@app.on_event("startup")
async def startup():
    global catalog_task
    shutil.rmtree(DATA_DIR / "sessions", ignore_errors=True)
    (DATA_DIR / "sessions").mkdir(parents=True, exist_ok=True)
    catalog_task = asyncio.create_task(load_catalog())
    asyncio.create_task(reap_sessions())


@app.on_event("shutdown")
async def shutdown():
    for s in list(sessions.values()):
        await s.close()


def get_session(sid: str) -> Session:
    s = sessions.get(sid)
    if not s or not s.engine.alive:
        raise HTTPException(404, "no such project (it may have expired); reload the page")
    return s


@app.get("/api/health")
async def health():
    return {"ok": True, "sessions": len(sessions)}


@app.get("/api/catalog")
async def catalog():
    try:
        return {"vendors": (await asyncio.shield(catalog_task))["vendors"]}
    except EngineError as e:
        raise HTTPException(500, f"could not load printer profiles: {e}")


@app.get("/api/schema")
async def schema():
    try:
        schema = (await asyncio.shield(catalog_task))["schema"]
    except EngineError as e:
        raise HTTPException(500, f"could not load the settings definitions: {e}")
    if schema is None:
        raise HTTPException(503, "the settings tabs aren't available with this engine yet")
    return schema


@app.websocket("/api/ws")
async def websocket(ws: WebSocket, session: str | None = None):
    await ws.accept()
    s = sessions.get(session) if session else None
    if not s or not s.engine.alive:
        s = Session()
        await s.start()
        sessions[s.id] = s
    s.sockets.add(ws)
    await ws.send_json({"event": "session", "id": s.id})
    try:
        while True:
            msg = await ws.receive_json()
            cmd = msg.get("cmd") if isinstance(msg, dict) else None
            if cmd not in BROWSER_COMMANDS:
                await ws.send_json({"event": "error", "message": f"unknown command: {cmd}"})
                continue
            clean = {k: v for k, v in msg.items() if k in BROWSER_COMMANDS[cmd]}
            clean["cmd"] = cmd
            rid = msg.get("id")
            if rid is not None and not (isinstance(rid, str) and rid.startswith(GATEWAY_ID)):
                clean["id"] = rid
            try:
                s.engine.send(clean)
            except EngineError as e:
                await ws.send_json({"event": "error", "cmd": cmd, "id": rid, "message": str(e)})
    except WebSocketDisconnect:
        pass
    finally:
        s.sockets.discard(ws)
        s.last_seen = time.monotonic()


@app.post("/api/sessions/{sid}/models")
async def upload_model(sid: str, file: UploadFile):
    s = get_session(sid)
    name = Path(file.filename or "model").name
    suffix = Path(name).suffix.lower()
    if suffix not in MODEL_SUFFIXES:
        raise HTTPException(400, f"{name}: only {', '.join(sorted(MODEL_SUFFIXES))} files can be added")
    # Keep the name (BOSS uses it for the object and the G-code file), made safe
    safe = re.sub(r"[^\w.\- ()]+", "_", Path(name).stem)[:100] or "model"
    target = s.dir / "uploads" / f"{safe}{suffix}"
    n = 1
    while target.exists():
        n += 1
        target = s.dir / "uploads" / f"{safe} ({n}){suffix}"
    size = 0
    with target.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                out.close()
                target.unlink()
                raise HTTPException(413, f"{name} is larger than {MAX_UPLOAD // (1024 * 1024)} MB")
            out.write(chunk)
    try:
        return await s.engine.request({"cmd": "load", "path": str(target)})
    except EngineError as e:
        raise HTTPException(400, f"{name}: {e}")


MAX_THUMBNAIL = 2048


@app.put("/api/sessions/{sid}/thumbnails/{width:int}x{height:int}")
async def upload_thumbnail(sid: str, width: int, height: int, request: Request):
    """A G-code thumbnail the browser drew: raw RGBA, bottom row first (see the engine's
    browser_thumbnails). The engine reads it when it writes the G-code."""
    s = get_session(sid)
    if not (0 < width <= MAX_THUMBNAIL and 0 < height <= MAX_THUMBNAIL):
        raise HTTPException(400, "thumbnail size out of range")
    body = await request.body()
    if len(body) != width * height * 4:
        raise HTTPException(400, f"a {width}x{height} thumbnail is {width * height * 4} bytes of RGBA")
    (s.dir / f"thumb-{width}x{height}.rgba").write_bytes(body)
    return {"ok": True}


@app.get("/api/sessions/{sid}/files/{name}")
async def session_file(sid: str, name: str, download: str | None = None):
    s = get_session(sid)
    if not SERVED_FILE.match(name):
        raise HTTPException(404)
    path = s.dir / name
    if not path.is_file():
        raise HTTPException(404, f"{name} doesn't exist yet")
    # Meshes never change under the same name; toolpaths and G-code change with every slice
    cache = "private, max-age=86400, immutable" if name.startswith("mesh-") else "no-store"
    filename = Path(download).name if download else None
    return FileResponse(path, filename=filename, headers={"Cache-Control": cache},
                        media_type="text/plain" if name.endswith(".gcode") else "application/octet-stream")


class WebFiles(StaticFiles):
    """The page. index.html is checked on every load, so a new version shows at once; the
    assets it names have their content's hash in their names, so they never change."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache")
        return response


if WEB_DIR:
    app.mount("/", WebFiles(directory=WEB_DIR, html=True), name="web")

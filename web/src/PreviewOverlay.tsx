// Preview controls over the 3D view: the feature legend (click to hide/show) and the
// vertical layer range slider (arrow keys move its top handle, like BOSS)

import { useEffect, useMemo, useRef } from "react";
import { FEATURES, MOVE_EXTRUDE } from "./files";
import { useStore } from "./store";
import { usePreview } from "./Toolpaths3D";

export function PreviewOverlay() {
  const toolpaths = usePreview((s) => s.toolpaths);
  const stale = useStore((s) => s.stale);
  const busy = useStore((s) => s.busy);
  if (!toolpaths) return busy ? null : <div className="preview-empty">Nothing sliced yet. Press Slice now.</div>;
  return (
    <>
      <Legend />
      <LayerSlider />
      {stale && !busy && <div className="preview-stale">The plate changed since this preview. Slice again to update it.</div>}
    </>
  );
}

function Legend() {
  const toolpaths = usePreview((s) => s.toolpaths)!;
  const hidden = usePreview((s) => s.hidden);
  const travel = usePreview((s) => s.travel);
  // Only the features this print has
  const present = useMemo(() => {
    const seen = new Set<number>();
    for (let i = 0; i < toolpaths.count; i++) if (toolpaths.type[i] === MOVE_EXTRUDE) seen.add(toolpaths.feature[i]);
    return FEATURES.map((f, i) => ({ ...f, i })).filter((f) => seen.has(f.i));
  }, [toolpaths]);
  const toggle = (i: number) =>
    usePreview.setState((s) => {
      const next = new Set(s.hidden);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return { hidden: next };
    });
  return (
    <div className="legend">
      <div className="legend-title">Feature type</div>
      {present.map((f) => (
        <button key={f.i} className={`legend-row${hidden.has(f.i) ? " off" : ""}`} onClick={() => toggle(f.i)}>
          <span className="swatch" style={{ background: f.color }} />
          {f.name}
        </button>
      ))}
      <button className={`legend-row${travel ? "" : " off"}`} onClick={() => usePreview.setState({ travel: !travel })}>
        <span className="swatch" style={{ background: "#385bd9" }} />
        Travel
      </button>
    </div>
  );
}

function LayerSlider() {
  const layerZ = usePreview((s) => s.toolpaths!.layerZ);
  const [lo, hi] = usePreview((s) => s.layers);
  const track = useRef<HTMLDivElement>(null);
  const top = Math.max(0, layerZ.length - 1);
  const setLayers = (a: number, b: number) =>
    usePreview.setState({ layers: [Math.max(0, Math.min(a, b, top)), Math.min(top, Math.max(a, b, 0))] });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest("input, select, textarea")) return;
      const [a, b] = usePreview.getState().layers;
      if (e.key === "ArrowUp") setLayers(a, Math.min(top, b + 1));
      else if (e.key === "ArrowDown") setLayers(a, Math.max(a, b - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const layerAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const f = 1 - (clientY - r.top) / r.height;
    return Math.round(Math.max(0, Math.min(1, f)) * top);
  };
  const drag = (which: "lo" | "hi") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const l = layerAt(ev.clientY);
      const [a, b] = usePreview.getState().layers;
      if (which === "hi") setLayers(a, Math.max(a, l));
      else setLayers(Math.min(l, b), b);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const pct = (l: number) => (top === 0 ? 0 : (l / top) * 100);

  return (
    <div className="layer-slider">
      <div className="layer-label">
        {layerZ[hi]?.toFixed(2)}
        <small>{hi + 1}</small>
      </div>
      <div className="layer-track" ref={track} onPointerDown={(e) => setLayers(lo, Math.max(lo, layerAt(e.clientY)))}>
        <div className="layer-fill" style={{ bottom: `${pct(lo)}%`, top: `${100 - pct(hi)}%` }} />
        <div className="layer-thumb" style={{ bottom: `${pct(hi)}%` }} onPointerDown={(e) => { e.stopPropagation(); drag("hi")(e); }} />
        <div className="layer-thumb low" style={{ bottom: `${pct(lo)}%` }} onPointerDown={(e) => { e.stopPropagation(); drag("lo")(e); }} />
      </div>
      <div className="layer-label">
        {layerZ[lo]?.toFixed(2)}
        <small>{lo + 1}</small>
      </div>
    </div>
  );
}

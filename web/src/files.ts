// Readers for the binary files the engine writes (formats in engine/src/main.cpp)

import * as THREE from "three";
import { fileUrl } from "./store";

const meshes = new Map<string, Promise<THREE.BufferGeometry>>();

// An object's mesh, in its own coordinates. Each file is fetched once per tab.
export function loadMesh(name: string): Promise<THREE.BufferGeometry> {
  let p = meshes.get(name);
  if (!p) {
    p = fetch(fileUrl(name)).then(async (res) => {
      if (!res.ok) throw new Error(`could not load ${name}`);
      const buf = await res.arrayBuffer();
      if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "PSWM") throw new Error(`${name} is not a mesh`);
      const [vertices, triangles] = new Uint32Array(buf, 4, 2);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, 12, vertices * 3), 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 12 + vertices * 12, triangles * 3), 1));
      g.computeBoundingBox();
      return g;
    });
    p.catch(() => meshes.delete(name));
    meshes.set(name, p);
  }
  return p;
}

// Move types and features, in the engine's order (EMoveType, GCodeExtrusionRole)
export const MOVE_TRAVEL = 8;
export const MOVE_WIPE = 9;
export const MOVE_EXTRUDE = 10;

export const FEATURES = [
  { name: "Unknown", color: "#e6b3b3" },
  { name: "Perimeter", color: "#ffe64d" },
  { name: "External perimeter", color: "#ff7d38" },
  { name: "Overhang perimeter", color: "#1f1fff" },
  { name: "Internal infill", color: "#b03029" },
  { name: "Solid infill", color: "#9654cc" },
  { name: "Top solid infill", color: "#f04040" },
  { name: "Ironing", color: "#ff8c69" },
  { name: "Bridge infill", color: "#4d80ba" },
  { name: "Gap fill", color: "#ffffff" },
  { name: "Skirt/Brim", color: "#00876e" },
  { name: "Support material", color: "#00ff00" },
  { name: "Support material interface", color: "#008000" },
  { name: "Wipe tower", color: "#b3e3ab" },
  { name: "Custom", color: "#5ed194" },
];
const FEATURE_CUSTOM = 14;

export interface Toolpaths {
  count: number;
  start: Float32Array; // xyz per segment
  end: Float32Array;
  width: Float32Array;
  height: Float32Array;
  feedrate: Float32Array;
  layer: Uint32Array;
  type: Uint8Array;
  feature: Uint8Array;
  extruder: Uint8Array;
  // Top Z of each layer
  layerZ: number[];
}

export async function loadToolpaths(name: string, version: number): Promise<Toolpaths> {
  const res = await fetch(fileUrl(name, `?v=${version}`));
  if (!res.ok) throw new Error("could not load the preview");
  const buf = await res.arrayBuffer();
  if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== "PSWP") throw new Error("the preview file is damaged");
  const [, n] = new Uint32Array(buf, 4, 2);
  let at = 12;
  const floats = (k: number) => {
    const a = new Float32Array(buf, at, n * k);
    at += n * k * 4;
    return a;
  };
  const start = floats(3), end = floats(3), width = floats(1), height = floats(1), feedrate = floats(1);
  const layer = new Uint32Array(buf, at, n);
  at += n * 4;
  const type = new Uint8Array(buf, at, n);
  const feature = new Uint8Array(buf, at + n, n);
  const extruder = new Uint8Array(buf, at + 2 * n, n);

  // Heights come from the print's own extrusions: start G-code ("Custom") can extrude
  // anywhere, e.g. purging high above the bed while heating
  const layerZ: number[] = [];
  for (let i = 0; i < n; i++) {
    if (type[i] !== MOVE_EXTRUDE || feature[i] === FEATURE_CUSTOM) continue;
    const l = layer[i], z = end[i * 3 + 2];
    if (layerZ[l] === undefined || z > layerZ[l]) layerZ[l] = z;
  }
  // Layers without extrusions take the height below them
  for (let l = 0; l < layerZ.length; l++) if (layerZ[l] === undefined) layerZ[l] = layerZ[l - 1] ?? 0;
  return { count: n, start, end, width, height, feedrate, layer, type, feature, extruder, layerZ };
}

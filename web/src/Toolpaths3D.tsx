// The sliced toolpaths, drawn on the GPU: every extrusion is one instance of a box,
// stretched between its start and end and sized by its width and height in the vertex
// shader. Layer range and hidden features are uniforms, so dragging the layer slider
// doesn't rebuild anything.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { create } from "zustand";
import { FEATURES, MOVE_EXTRUDE, MOVE_TRAVEL, loadToolpaths, type Toolpaths } from "./files";
import { notify, useStore } from "./store";

interface PreviewState {
  toolpaths: Toolpaths | null;
  loadedVersion: number;
  layers: [number, number];
  hidden: Set<number>;
  travel: boolean;
}

export const usePreview = create<PreviewState>(() => ({
  toolpaths: null,
  loadedVersion: 0,
  layers: [0, 0],
  hidden: new Set(),
  travel: false,
}));

// Fetches the toolpaths of the latest slice while Preview is open
export function usePreviewLoader() {
  const slice = useStore((s) => s.slice);
  const view = useStore((s) => s.view);
  useEffect(() => {
    if (view !== "preview" || !slice || usePreview.getState().loadedVersion === slice.version) return;
    let live = true;
    loadToolpaths(slice.preview.file, slice.version)
      .then((t) => {
        if (!live) return;
        const top = Math.max(0, t.layerZ.length - 1);
        const prev = usePreview.getState();
        // Keep the slider at the top unless the user moved it
        const wasAtTop = !prev.toolpaths || prev.layers[1] >= prev.toolpaths.layerZ.length - 1;
        usePreview.setState({
          toolpaths: t,
          loadedVersion: slice.version,
          layers: [Math.min(prev.layers[0], top), wasAtTop ? top : Math.min(prev.layers[1], top)],
        });
      })
      .catch((e) => notify(e.message));
    return () => {
      live = false;
    };
  }, [slice, view]);
}

const VERTEX = /* glsl */ `
attribute vec4 aStart;  // xyz, width
attribute vec4 aEnd;    // xyz, height
attribute vec2 aInfo;   // feature, layer
uniform vec3 uColors[${FEATURES.length}];
uniform float uHidden[${FEATURES.length}];
uniform vec2 uLayers;
uniform float uTop;
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  int f = int(aInfo.x + 0.5);
  vec3 d = aEnd.xyz - aStart.xyz;
  float len = length(d);
  if (len < 1e-5 || uHidden[f] > 0.5 || aInfo.y < uLayers.x - 0.5 || aInfo.y > uLayers.y + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 dir = d / len;
  vec3 c = cross(vec3(0.0, 0.0, 1.0), dir);
  vec3 side = length(c) < 1e-4 ? vec3(1.0, 0.0, 0.0) : normalize(c);
  vec3 up = cross(dir, side);
  float w = aStart.w, h = aEnd.w;
  // Unit box: x 0..1 along the move, y -0.5..0.5 across, z -1..0 down from the nozzle.
  // Stretched by half a height at each end so corners close.
  vec3 p = aStart.xyz + dir * (position.x * (len + h) - 0.5 * h) + side * (position.y * w) + up * (position.z * h);
  vNormal = normalize(normalMatrix * (dir * normal.x + side * normal.y + up * normal.z));
  // Layers below the top one are drawn a little darker, like BOSS
  vColor = uColors[f] * (aInfo.y < uTop - 0.5 ? 0.85 : 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  float light = 0.35 + 0.5 * max(dot(n, normalize(vec3(-0.3, 0.4, 1.0))), 0.0)
                     + 0.2 * max(dot(n, normalize(vec3(0.6, -0.2, 0.5))), 0.0);
  gl_FragColor = vec4(vColor * light, 1.0);
}`;

const TRAVEL_VERTEX = /* glsl */ `
attribute float aLayer;
uniform vec2 uLayers;
void main() {
  if (aLayer < uLayers.x - 0.5 || aLayer > uLayers.y + 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const TRAVEL_FRAGMENT = /* glsl */ `
void main() { gl_FragColor = vec4(0.22, 0.36, 0.85, 1.0); }`;

export function Toolpaths3D() {
  usePreviewLoader();
  const toolpaths = usePreview((s) => s.toolpaths);
  const layers = usePreview((s) => s.layers);
  const hidden = usePreview((s) => s.hidden);
  const travel = usePreview((s) => s.travel);

  const extrusions = useMemo(() => (toolpaths ? buildExtrusions(toolpaths) : null), [toolpaths]);
  const travels = useMemo(() => (toolpaths && travel ? buildTravels(toolpaths) : null), [toolpaths, travel]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uColors: { value: FEATURES.map((f) => new THREE.Color(f.color)) },
          uHidden: { value: FEATURES.map(() => 0) },
          uLayers: { value: new THREE.Vector2(0, 0) },
          uTop: { value: 0 },
        },
      }),
    [],
  );
  const travelMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: TRAVEL_VERTEX,
        fragmentShader: TRAVEL_FRAGMENT,
        uniforms: { uLayers: { value: new THREE.Vector2(0, 0) } },
      }),
    [],
  );

  material.uniforms.uLayers.value.set(layers[0], layers[1]);
  material.uniforms.uTop.value = layers[1];
  material.uniforms.uHidden.value = FEATURES.map((_, i) => (hidden.has(i) ? 1 : 0));
  travelMaterial.uniforms.uLayers.value.set(layers[0], layers[1]);

  useEffect(() => () => extrusions?.dispose(), [extrusions]);
  useEffect(() => () => travels?.dispose(), [travels]);

  return (
    <>
      {extrusions && <mesh geometry={extrusions} material={material} frustumCulled={false} />}
      {travels && <lineSegments geometry={travels} material={travelMaterial} frustumCulled={false} />}
    </>
  );
}

function buildExtrusions(t: Toolpaths): THREE.InstancedBufferGeometry {
  let n = 0;
  for (let i = 0; i < t.count; i++) if (t.type[i] === MOVE_EXTRUDE) n++;
  const start = new Float32Array(n * 4), end = new Float32Array(n * 4), info = new Float32Array(n * 2);
  for (let i = 0, j = 0; i < t.count; i++) {
    if (t.type[i] !== MOVE_EXTRUDE) continue;
    start.set([t.start[i * 3], t.start[i * 3 + 1], t.start[i * 3 + 2], t.width[i]], j * 4);
    end.set([t.end[i * 3], t.end[i * 3 + 1], t.end[i * 3 + 2], t.height[i]], j * 4);
    info[j * 2] = t.feature[i];
    info[j * 2 + 1] = t.layer[i];
    j++;
  }
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0, -0.5);
  const g = new THREE.InstancedBufferGeometry();
  g.index = box.index;
  g.setAttribute("position", box.getAttribute("position"));
  g.setAttribute("normal", box.getAttribute("normal"));
  g.setAttribute("aStart", new THREE.InstancedBufferAttribute(start, 4));
  g.setAttribute("aEnd", new THREE.InstancedBufferAttribute(end, 4));
  g.setAttribute("aInfo", new THREE.InstancedBufferAttribute(info, 2));
  g.instanceCount = n;
  return g;
}

function buildTravels(t: Toolpaths): THREE.BufferGeometry {
  let n = 0;
  for (let i = 0; i < t.count; i++) if (t.type[i] === MOVE_TRAVEL) n++;
  const pos = new Float32Array(n * 6), layer = new Float32Array(n * 2);
  for (let i = 0, j = 0; i < t.count; i++) {
    if (t.type[i] !== MOVE_TRAVEL) continue;
    pos.set(t.start.subarray(i * 3, i * 3 + 3), j * 6);
    pos.set(t.end.subarray(i * 3, i * 3 + 3), j * 6 + 3);
    layer[j * 2] = layer[j * 2 + 1] = t.layer[i];
    j++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aLayer", new THREE.BufferAttribute(layer, 1));
  return g;
}

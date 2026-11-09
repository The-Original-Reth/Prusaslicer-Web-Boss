// G-code thumbnails. BOSS draws them with OpenGL when it exports G-code; the engine has no
// screen, so the page draws them here, the way BOSS does (GLCanvas3D::_render_thumbnail_internal):
// the printable objects only, seen from BOSS's default camera direction, zoomed to fit,
// in the extruder's color, on a transparent background. The pixels go to the server
// bottom row first, as glReadPixels gives them to BOSS, and libslic3r encodes them.

import * as THREE from "three";
import { loadMesh } from "./files";
import type { Plate, Settings } from "./types";

// "16x16/QOI, 313x173/QOI, 300x300/PNG": BOSS's thumbnails setting
export function thumbnailSizes(setting: string): [number, number][] {
  const sizes: [number, number][] = [];
  for (const part of setting.split(",")) {
    const m = part.trim().match(/^(\d+)\s*x\s*(\d+)/i);
    if (!m) continue;
    const w = Number(m[1]), h = Number(m[2]);
    if (w > 0 && h > 0 && w <= 2048 && h <= 2048 && !sizes.some(([a, b]) => a === w && b === h)) sizes.push([w, h]);
  }
  return sizes;
}

// The color BOSS gives objects: the extruder's color if set, else the filament's
function objectColor(settings: Settings | null) {
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) as string | undefined;
  const valid = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
  return valid(first(settings?.values.printer.extruder_colour)) ?? valid(first(settings?.values.filament.filament_colour)) ?? "#ffcc00";
}

// Draws every size and uploads it; resolves when the server has them all
export async function uploadThumbnails(plate: Plate, settings: Settings | null, sessionId: string) {
  const sizes = thumbnailSizes(String(settings?.values.printer.thumbnails ?? plate.thumbnails ?? ""));
  if (sizes.length === 0 || plate.objects.length === 0) return;

  // BOSS's "gouraud_light" shader: ambient light, plus a top and a front light fixed to the
  // camera (directions in eye space)
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight("#ffffff", 1.0));
  const lights = [
    { light: new THREE.DirectionalLight("#ffffff", 2.4), eye: new THREE.Vector3(-0.4574957, 0.4574957, 0.7624929) },
    { light: new THREE.DirectionalLight("#ffffff", 0.9), eye: new THREE.Vector3(0.6985074, 0.1397015, 0.6985074) },
  ];
  for (const { light } of lights) scene.add(light);
  const material = new THREE.MeshPhongMaterial({ color: objectColor(settings), flatShading: true, shininess: 20 });

  // Objects entirely inside the bed (printable_only); BOSS leaves the others out
  const bed = new THREE.Box2();
  for (const [x, y] of plate.bed.shape) bed.expandByPoint(new THREE.Vector2(x, y));
  const box = new THREE.Box3();
  for (const object of plate.objects) {
    // Parts only (parts_only): no modifiers, holes or support enforcers/blockers
    const parts = await Promise.all(
      object.volumes.filter((v) => v.type === "part").map(async (v) => ({ geometry: await loadMesh(v.mesh), matrix: new THREE.Matrix4().fromArray(v.matrix) })),
    );
    for (const instance of object.instances) {
      const placed = parts.map((p) => ({ geometry: p.geometry, matrix: new THREE.Matrix4().fromArray(instance.matrix).multiply(p.matrix) }));
      const b = new THREE.Box3();
      for (const p of placed) b.union(p.geometry.boundingBox!.clone().applyMatrix4(p.matrix));
      if (b.min.x < bed.min.x - 0.01 || b.min.y < bed.min.y - 0.01 || b.max.x > bed.max.x + 0.01 || b.max.y > bed.max.y + 0.01) continue;
      for (const p of placed) {
        const mesh = new THREE.Mesh(p.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(p.matrix);
        scene.add(mesh);
      }
      box.union(b);
    }
  }
  if (box.isEmpty()) return;

  // BOSS's default camera, orthographic: 45° from straight down, from the front left
  // (Camera::set_default_orientation)
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const direction = new THREE.Vector3(-0.5, -0.5, Math.SQRT1_2).normalize();
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  // BOSS clears to gray with zero alpha
  renderer.setClearColor(new THREE.Color(0.4, 0.4, 0.4), 0);

  try {
    for (const [w, h] of sizes) {
      renderer.setSize(w, h, false);
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, radius * 8);
      camera.up.set(0, 0, 1);
      camera.position.copy(center).addScaledVector(direction, radius * 3);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      for (const { light, eye } of lights) {
        light.position.copy(center).add(eye.clone().applyQuaternion(camera.quaternion).multiplyScalar(radius * 4));
        light.target.position.copy(center);
        light.target.updateMatrixWorld();
      }

      // Zoom to the objects' box, keeping the picture's proportions (Camera::zoom_to_box)
      const view = new THREE.Box3();
      const corner = new THREE.Vector3();
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        view.expandByPoint(corner.applyMatrix4(camera.matrixWorldInverse));
      }
      const margin = 1.05;
      let halfW = ((view.max.x - view.min.x) / 2) * margin, halfH = ((view.max.y - view.min.y) / 2) * margin;
      if (halfW / halfH < w / h) halfW = (halfH * w) / h;
      else halfH = (halfW * h) / w;
      const cx = (view.max.x + view.min.x) / 2, cy = (view.max.y + view.min.y) / 2;
      Object.assign(camera, { left: cx - halfW, right: cx + halfW, top: cy + halfH, bottom: cy - halfH });
      camera.updateProjectionMatrix();

      renderer.render(scene, camera);
      const gl = renderer.getContext();
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const res = await fetch(`/api/sessions/${sessionId}/thumbnails/${w}x${h}`, { method: "PUT", body: pixels });
      if (!res.ok) throw new Error(`could not upload the ${w}×${h} thumbnail`);
    }
  } finally {
    material.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }
}

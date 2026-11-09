// The 3D view: the bed, the objects on it (with move/rotate/scale gizmos) or, in
// Preview, the sliced toolpaths. Z is up, in millimetres, like BOSS.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
import { loadMesh } from "./files";
import { run, select, useStore } from "./store";
import type { PlateObject, PlateVolume, VolumeType } from "./types";
import { Toolpaths3D } from "./Toolpaths3D";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const COLOR = "#e8c547";
const COLOR_HOVER = "#f5dd85";
const COLOR_SELECTED = "#ed6b21";
const COLOR_OUTSIDE = "#5b8bd6";

export function Scene() {
  const view = useStore((s) => s.view);
  // Where the last press started: releasing after a drag (orbiting, or a gizmo) isn't
  // a click on empty space, so it keeps the selection
  const down = useRef({ x: 0, y: 0 });
  return (
    <Canvas
      camera={{ fov: 35, near: 1, far: 10000, position: [125, -260, 260] }}
      gl={{ antialias: true }}
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
      onPointerMissed={(e) => {
        const moved = Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y);
        if (e.button === 0 && moved < 4) select(null);
      }}
    >
      <color attach="background" args={["#2d3036"]} />
      <hemisphereLight args={["#ffffff", "#3a3d44", 1.4]} />
      <directionalLight position={[-200, -300, 500]} intensity={1.6} />
      <directionalLight position={[300, 200, 200]} intensity={0.5} />
      <Bed />
      {view === "3d" ? <Objects /> : <Toolpaths3D />}
      <OrbitControls makeDefault enableDamping={false} />
      <CameraFit />
    </Canvas>
  );
}

function useBedBox() {
  const shape = useStore((s) => s.plate?.bed.shape);
  return useMemo(() => {
    const box = new THREE.Box2();
    for (const [x, y] of shape ?? [[0, 0], [250, 210]]) box.expandByPoint(new THREE.Vector2(x, y));
    return box;
  }, [shape]);
}

// Aims the camera at the bed whenever its size changes
function CameraFit() {
  const bed = useBedBox();
  const { camera, controls } = useThree();
  useEffect(() => {
    const c = bed.getCenter(new THREE.Vector2());
    const size = Math.max(bed.max.x - bed.min.x, bed.max.y - bed.min.y);
    camera.position.set(c.x, c.y - size * 1.25, size * 1.1);
    camera.lookAt(c.x, c.y, 0);
    const orbit = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (orbit) {
      orbit.target.set(c.x, c.y, 0);
      orbit.update();
    }
  }, [bed, camera, controls]);
  return null;
}

function Bed() {
  const shape = useStore((s) => s.plate?.bed.shape);
  const bed = useBedBox();
  const { surface, outline, grid } = useMemo(() => {
    const pts = (shape ?? [[0, 0], [250, 0], [250, 210], [0, 210]]).map(([x, y]) => new THREE.Vector2(x, y));
    const surface = new THREE.ShapeGeometry(new THREE.Shape(pts));
    const outline = new THREE.BufferGeometry().setFromPoints([...pts, pts[0]].map((p) => new THREE.Vector3(p.x, p.y, 0.02)));
    const lines: number[] = [];
    for (let x = Math.ceil(bed.min.x / 10) * 10; x <= bed.max.x; x += 10) lines.push(x, bed.min.y, 0.01, x, bed.max.y, 0.01);
    for (let y = Math.ceil(bed.min.y / 10) * 10; y <= bed.max.y; y += 10) lines.push(bed.min.x, y, 0.01, bed.max.x, y, 0.01);
    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    return { surface, outline, grid };
  }, [shape, bed]);
  return (
    <group>
      <mesh geometry={surface} receiveShadow>
        <meshStandardMaterial color="#45484f" roughness={0.9} transparent opacity={0.92} side={THREE.DoubleSide} />
      </mesh>
      <lineSegments geometry={grid}>
        <lineBasicMaterial color="#5d616a" />
      </lineSegments>
      <line>
        <primitive object={outline} attach="geometry" />
        <lineBasicMaterial color="#9aa0aa" />
      </line>
      <axesHelper args={[20]} position={[bed.min.x, bed.min.y, 0.03]} />
    </group>
  );
}

function Objects() {
  const objects = useStore((s) => s.plate?.objects ?? []);
  return (
    <>
      {objects.map((o) => o.instances.map((_, i) => <ObjectInstance key={`${o.id}:${i}`} object={o} instance={i} />))}
    </>
  );
}

// Modifiers, holes and support enforcers/blockers are see-through, colored by kind as in BOSS
const VOLUME_LOOK: Record<Exclude<VolumeType, "part">, { color: string; opacity: number }> = {
  modifier: { color: "#e3e98c", opacity: 0.4 },
  negative: { color: "#9aa0aa", opacity: 0.5 },
  support_enforcer: { color: "#4aa3ff", opacity: 0.45 },
  support_blocker: { color: "#ff5a5a", opacity: 0.45 },
};

// Loads each volume's mesh once; the map fills in as they arrive
function useVolumeGeometries(volumes: PlateVolume[]) {
  const [geometries, setGeometries] = useState(new Map<number, THREE.BufferGeometry>());
  const files = volumes.map((v) => `${v.id}:${v.mesh}`).join(",");
  useEffect(() => {
    let live = true;
    for (const v of volumes)
      loadMesh(v.mesh)
        .then((g) => live && setGeometries((m) => (m.get(v.id) === g ? m : new Map(m).set(v.id, g))))
        .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);
  return geometries;
}

function ObjectInstance({ object, instance }: { object: PlateObject; instance: number }) {
  const geometries = useVolumeGeometries(object.volumes);
  const [hover, setHover] = useState(false);
  const group = useRef<THREE.Group>(null!);
  const selected = useStore((s) => s.selected === object.id);
  const selectedVolume = useStore((s) => (s.selected === object.id ? s.selectedVolume : null));
  const gizmo = useStore((s) => s.gizmo);
  const bed = useBedBox();
  const maxHeight = useStore((s) => s.plate?.bed.max_height ?? 0);
  const matrix = object.instances[instance].matrix;
  const loaded = geometries.size > 0;

  // The engine's matrix is the truth; gizmos edit position/rotation/scale until released
  useEffect(() => {
    new THREE.Matrix4().fromArray(matrix).decompose(group.current.position, group.current.quaternion, group.current.scale);
  }, [matrix, loaded]);

  // Outside the bed: any part sticking out (modifiers don't count)
  const outside = useMemo(() => {
    const box = new THREE.Box3();
    const m = new THREE.Matrix4().fromArray(matrix);
    for (const v of object.volumes) {
      const g = geometries.get(v.id);
      if (v.type === "part" && g?.boundingBox)
        box.union(g.boundingBox.clone().applyMatrix4(m.clone().multiply(new THREE.Matrix4().fromArray(v.matrix))));
    }
    if (box.isEmpty()) return false;
    const eps = 0.01;
    return box.min.x < bed.min.x - eps || box.min.y < bed.min.y - eps || box.max.x > bed.max.x + eps ||
      box.max.y > bed.max.y + eps || (maxHeight > 0 && box.max.z > maxHeight + eps);
  }, [geometries, object.volumes, matrix, bed, maxHeight]);

  const commit = () => {
    group.current.updateMatrix();
    void run("transform", { object: object.id, instance, matrix: group.current.matrix.toArray() });
  };

  // The selected volume's mesh, for its gizmo. The gizmo has to live outside the group:
  // inside, the instance's transformation would be applied to it twice.
  const meshes = useRef(new Map<number, THREE.Mesh>());
  const [volumeTarget, setVolumeTarget] = useState<THREE.Mesh | null>(null);
  const volumeOfTarget = object.volumes.find((v) => v.id === selectedVolume);
  useEffect(() => {
    setVolumeTarget(selectedVolume !== null && geometries.has(selectedVolume) ? meshes.current.get(selectedVolume) ?? null : null);
  }, [selectedVolume, geometries]);
  const commitVolume = () => {
    if (!volumeTarget || !volumeOfTarget) return;
    volumeTarget.updateMatrix();
    void run("volume_transform", { object: object.id, volume: volumeOfTarget.id, matrix: volumeTarget.matrix.toArray() });
  };

  const color = selected && selectedVolume === null ? COLOR_SELECTED : outside ? COLOR_OUTSIDE : hover ? COLOR_HOVER : COLOR;
  return (
    <>
      <group ref={group}>
        {object.volumes.map((v) => (
          <VolumeMesh
            key={v.id}
            object={object}
            volume={v}
            geometry={geometries.get(v.id) ?? null}
            color={v.type === "part" ? (selectedVolume === v.id ? COLOR_SELECTED : color) : undefined}
            selected={selectedVolume === v.id}
            register={(m) => (m ? meshes.current.set(v.id, m) : meshes.current.delete(v.id))}
            onHover={setHover}
          />
        ))}
      </group>
      {selected && selectedVolume === null && loaded && (
        <TransformControls
          object={group}
          mode={gizmo === "move" ? "translate" : gizmo}
          showZ={gizmo !== "move"}
          size={0.8}
          onMouseUp={commit}
        />
      )}
      {volumeTarget && (
        <TransformControls object={volumeTarget} mode={gizmo === "move" ? "translate" : gizmo} size={0.7} onMouseUp={commitVolume} />
      )}
    </>
  );
}

// One part or modifier, placed in its object by its own matrix. Clicking a part selects the
// object; clicking a modifier, hole or enforcer/blocker selects it.
function VolumeMesh({ object, volume, geometry, color, selected, register, onHover }: {
  object: PlateObject; volume: PlateVolume; geometry: THREE.BufferGeometry | null; color?: string;
  selected: boolean; register: (mesh: THREE.Mesh | null) => void; onHover: (hover: boolean) => void;
}) {
  const mesh = useRef<THREE.Mesh>(null!);
  useEffect(() => {
    new THREE.Matrix4().fromArray(volume.matrix).decompose(mesh.current.position, mesh.current.quaternion, mesh.current.scale);
  }, [volume.matrix, geometry]);
  useEffect(() => {
    register(mesh.current);
    return () => register(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const look = volume.type === "part" ? null : VOLUME_LOOK[volume.type];
  return (
    <>
      <mesh
        ref={mesh}
        geometry={geometry ?? undefined}
        visible={geometry !== null}
        renderOrder={look ? 1 : 0}
        onClick={(e) => {
          e.stopPropagation();
          // The end of a drag (a gizmo, orbiting) isn't a click
          if (e.delta > 4) return;
          select(object.id, volume.type === "part" ? null : volume.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHover(true);
        }}
        onPointerOut={() => onHover(false)}
      >
        {look ? (
          <meshStandardMaterial
            color={selected ? COLOR_SELECTED : look.color}
            transparent
            opacity={selected ? Math.min(1, look.opacity + 0.2) : look.opacity}
            depthWrite={false}
            flatShading
            roughness={0.6}
          />
        ) : (
          <meshStandardMaterial color={color} flatShading roughness={0.6} metalness={0.05} />
        )}
      </mesh>
    </>
  );
}

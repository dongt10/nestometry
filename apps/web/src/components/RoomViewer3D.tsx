'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type RefObject
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  Html,
  Lightformer,
  OrbitControls,
  OrthographicCamera,
  PointerLockControls,
  useGLTF
} from '@react-three/drei';
import {
  ACESFilmicToneMapping,
  Box3,
  MOUSE,
  Plane,
  Raycaster,
  TOUCH,
  Vector2,
  Vector3,
  type Color,
  type Material,
  type Object3D,
  type OrthographicCamera as ThreeOrthographicCamera,
  type PerspectiveCamera as ThreePerspectiveCamera
} from 'three';
import { EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing';

// The imperative handles of drei's <OrbitControls> / <PointerLockControls>
// (three-stdlib's impl classes), resolved from the components themselves so we
// don't import three-stdlib directly.
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;
type PointerLockControlsImpl = ComponentRef<typeof PointerLockControls>;
import type { RoomManifestItem, Room } from '../data/assetManifest';
import {
  contactShadowKey,
  shouldShowDimensionBadges,
  type ArrangementAction,
  type ArrangementFinishReason,
  type ArrangementState
} from '../data/arrangementState';
import {
  collectArrangeInstances,
  collectFurnitureGroups,
  DECOR_GROUP,
  FURNITURE_GROUP_LABELS,
  groupForNodeName,
  type FurnitureGroup
} from '../data/furnitureGroups';
import { groupBadgeLabel, shellBadgeLabels } from '../data/dimensionBadges';

export type ViewMode = '3d' | '2d' | 'walk';
/** DOM zoom buttons call this; populated by the in-Canvas ZoomBridge. */
export type ZoomFn = (direction: 1 | -1) => void;

// Room center the camera orbits around (matches the GLB layout: origin-centred).
const TARGET = new Vector3(0, 1, 0);

// --- First-person walk mode tuning ---
/** Standing eye height in metres (1 Blender unit = 1 m). */
const WALK_EYE_HEIGHT = 1.55;
/** Walking speed in m/s; Shift bumps it to the fast speed. */
const WALK_SPEED = 2;
const WALK_SPEED_FAST = 4;
/** Keep the walker this far inside the room's inner floor bounds. */
const WALK_WALL_INSET = 0.25;
/** Clamp fallback (half-extents, metres) until the GLB floor has resolved. */
const WALK_FALLBACK_HALF = 1.8;
/** Wider first-person FOV than the dollhouse camera so the room reads indoors. */
const WALK_FOV = 65;

// --- Arrange (move-furniture) mode tuning ---
/** Keep a dragged instance's centre this far inside the room's floor bounds. */
const ARRANGE_WALL_INSET = 0.15;
/** Subtle gold hover tint applied via per-mesh material CLONES (GLB materials
    are shared across instances; mutating them would tint every sibling). */
const ARRANGE_HOVER_EMISSIVE = 0xc99700;
const ARRANGE_HOVER_INTENSITY = 0.18;

const WORLD_UP = new Vector3(0, 1, 0);

/** Loaded GLB meshes, as seen while walking an Object3D graph. */
type ArrangeMesh = Object3D & { isMesh?: boolean; material: Material | Material[] };
/** Materials that support the hover tint (standard/physical/lambert/phong). */
type EmissiveMaterial = Material & { emissive: Color; emissiveIntensity: number };

function DormModel({
  path,
  hiddenGroups,
  onGroupsDiscovered,
  onSceneReady
}: {
  path: string;
  hiddenGroups: Set<FurnitureGroup>;
  onGroupsDiscovered: (groups: FurnitureGroup[]) => void;
  onSceneReady: (scene: Object3D) => void;
}) {
  const gltf = useGLTF(path);

  const groups = useMemo(
    () => collectFurnitureGroups(gltf.scene),
    [gltf.scene]
  );

  // Report which groups exist so the parent can render the right checkboxes.
  useEffect(() => {
    onGroupsDiscovered(Array.from(groups.keys()));
  }, [groups, onGroupsDiscovered]);

  // Open dollhouse: hide the ceiling only. Walls stay fully OPAQUE — the
  // camera-facing ones are removed per frame by WallCuller, so the interior is
  // visible from any orbit without the old translucency. Both ceiling and walls
  // remain in the GLB/schema; this is presentation only.
  // Keyed on gltf.scene only (onSceneReady is a stable setter) so this runs once
  // per loaded model and never loops.
  useEffect(() => {
    gltf.scene.traverse((node) => {
      if (node.name === 'ceiling') {
        node.visible = false;
      }
      // Loaded GLB meshes carry no shadow flags by default. Enable them here so
      // the key light produces real contact/cast shadows. The floor only
      // receives (casting from it would self-shadow the ground plane).
      const mesh = node as Object3D & { isMesh?: boolean };
      if (mesh.isMesh) {
        mesh.castShadow = node.name !== 'floor';
        mesh.receiveShadow = true;
      }
    });
    onSceneReady(gltf.scene);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf.scene]);

  // Apply group visibility whenever the hidden set changes. We recompute ALL
  // groups every time so decor stays in sync with the furniture it sits on:
  // toggling e.g. "Bunk bed" must also update its attached duvet/pillows.
  //
  // Compound rule for the decor group — a decor node is visible only if:
  //   1. the Decor master switch is on (decor group not hidden), AND
  //   2. if the node carries an `attached_to` furniture prefix (in glTF extras,
  //      surfaced as node.userData.attached_to), that furniture group is also
  //      not hidden. Rug/curtains have no attached_to and follow the master only.
  // Non-decor groups keep the plain "hidden set" behavior.
  useEffect(() => {
    const decorHidden = hiddenGroups.has(DECOR_GROUP);
    for (const [group, nodes] of groups) {
      if (group === DECOR_GROUP) {
        for (const node of nodes) {
          const attachedTo = node.userData?.attached_to;
          const attachedHidden =
            typeof attachedTo === 'string'
              ? hiddenGroups.has(groupForNodeName(attachedTo) ?? (attachedTo as FurnitureGroup))
              : false;
          node.visible = !decorHidden && !attachedHidden;
        }
        continue;
      }
      const visible = !hiddenGroups.has(group);
      for (const node of nodes) {
        node.visible = visible;
      }
    }
  }, [groups, hiddenGroups]);

  return <primitive object={gltf.scene} />;
}

/**
 * Open-dollhouse wall culling. Each `wall_*` node's outward direction is derived
 * from its position relative to the room centre (not hardcoded to a side). Each
 * frame we hide the 1-2 walls whose outward normal faces the camera, so the
 * viewer always sees into the room; far walls render fully opaque.
 *
 * In the 2D top-down view the camera looks straight down, so no side wall faces
 * it and all walls stay visible — they read as the floor-plan outline. In walk
 * mode the camera is inside the room, so culling is disabled entirely: every
 * wall stays up around the walker. Orbit (3D) culling resumes on exit.
 */
function WallCuller({ scene, mode }: { scene: Object3D | null; mode: ViewMode }) {
  const walls = useMemo(() => {
    if (!scene) return [] as { node: Object3D; outward: Vector3 }[];
    const found: { node: Object3D; outward: Vector3 }[] = [];
    for (const node of scene.children) {
      if (!node.name.startsWith('wall_')) continue;
      // Outward direction = horizontal position relative to room centre.
      const outward = new Vector3(node.position.x, 0, node.position.z);
      if (outward.lengthSq() < 1e-6) continue;
      outward.normalize();
      found.push({ node, outward });
    }
    return found;
  }, [scene]);

  const camDir = useRef(new Vector3());
  const frame = useRef(0);

  useFrame(({ camera }) => {
    if (walls.length === 0) return;
    // Top-down 2D (floor-plan outline) and first-person walk (inside the room):
    // keep every wall visible; only the 3D orbit dollhouse culls.
    if (mode !== '3d') {
      for (const { node } of walls) node.visible = true;
      return;
    }
    // Throttle to every 3rd frame — culling need not be per-frame precise.
    frame.current = (frame.current + 1) % 3;
    if (frame.current !== 0) return;

    // Horizontal view direction from camera toward the room centre.
    camDir.current.set(TARGET.x - camera.position.x, 0, TARGET.z - camera.position.z).normalize();
    for (const { node, outward } of walls) {
      // A wall faces the camera when its outward normal points back toward the
      // camera, i.e. opposite the view direction (dot with view dir < 0).
      node.visible = outward.dot(camDir.current) >= -0.15;
    }
  });

  return null;
}

/**
 * Anchored dimension badges. One navy pill per furniture group at the group's
 * bounding-box top centre (schema width value), plus room-shell pills along the
 * top edges of the room. All values follow the honesty rules: estimated shows
 * "~x m · est.", unknown shows "unknown" — never a bare number for null.
 */
function DimensionOverlay({
  scene,
  room,
  hiddenGroups,
  mode
}: {
  scene: Object3D | null;
  room: Room;
  hiddenGroups: Set<FurnitureGroup>;
  mode: ViewMode;
}) {
  // distanceFactor scales <Html> by camera distance — correct for the
  // perspective (3D) camera, but it mis-projects under the orthographic (2D)
  // camera, so we omit it in 2D and let badges anchor in plain screen space.
  const groupFactor = mode === '3d' ? 8 : undefined;
  const shellFactor = mode === '3d' ? 9 : undefined;
  const groupAnchors = useMemo(() => {
    if (!scene) return [] as { group: FurnitureGroup; pos: [number, number, number]; text: string }[];
    const groups = collectFurnitureGroups(scene);
    const box = new Box3();
    const center = new Vector3();
    const out: { group: FurnitureGroup; pos: [number, number, number]; text: string }[] = [];
    for (const [group, nodes] of groups) {
      const label = groupBadgeLabel(room, group);
      if (!label) continue; // groups without a matching schema object get no badge
      box.makeEmpty();
      for (const node of nodes) box.expandByObject(node);
      if (box.isEmpty()) continue;
      box.getCenter(center);
      out.push({
        group,
        pos: [center.x, box.max.y + 0.12, center.z],
        text: label.text
      });
    }
    return out;
  }, [scene, room]);

  // Room-shell pills anchored above the top wall edges. Extents come from the
  // wall node positions in the loaded scene (presentation anchors only; the
  // labels themselves are the honest schema values, all "unknown" today).
  const shellAnchors = useMemo(() => {
    if (!scene) return [] as { key: string; pos: [number, number, number]; label: string }[];
    let maxX = 0;
    let maxZ = 0;
    let topY = 2.4;
    for (const node of scene.children) {
      if (!node.name.startsWith('wall_')) continue;
      maxX = Math.max(maxX, Math.abs(node.position.x));
      maxZ = Math.max(maxZ, Math.abs(node.position.z));
      topY = Math.max(topY, node.position.y + 1.3);
    }
    const labels = shellBadgeLabels(room);
    // width along the back edge, depth along a side edge, height at a top corner.
    const byKey = Object.fromEntries(labels.map((l) => [l.key, l.label]));
    return [
      { key: 'width', pos: [0, topY, -maxZ] as [number, number, number], label: byKey.width },
      { key: 'depth', pos: [maxX, topY, 0] as [number, number, number], label: byKey.depth },
      { key: 'height', pos: [-maxX, topY, -maxZ] as [number, number, number], label: byKey.height }
    ];
  }, [scene, room]);

  return (
    <>
      {groupAnchors.map(({ group, pos, text }) =>
        hiddenGroups.has(group) ? null : (
          <Html key={`grp-${group}`} position={pos} center distanceFactor={groupFactor} zIndexRange={[10, 0]}>
            <span className="dim3d-badge">{text}</span>
          </Html>
        )
      )}
      {shellAnchors.map(({ key, pos, label }) => (
        <Html key={`shell-${key}`} position={pos} center distanceFactor={shellFactor} zIndexRange={[10, 0]}>
          <span className="dim3d-badge dim3d-badge--shell">{label}</span>
        </Html>
      ))}
    </>
  );
}

/**
 * Bridges the DOM zoom buttons to the active camera. Perspective (3D): move the
 * camera along its view vector toward/away from the target. Orthographic (2D):
 * scale camera.zoom. Populates zoomRef with the handler each render.
 */
function ZoomBridge({
  zoomRef,
  controlsRef
}: {
  zoomRef: RefObject<ZoomFn | null>;
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    zoomRef.current = (direction) => {
      if ((camera as ThreePerspectiveCamera).isPerspectiveCamera) {
        // Dolly along the view direction; clamp distance so we can't cross the target.
        const dir = new Vector3().subVectors(camera.position, TARGET);
        const dist = dir.length();
        const factor = direction === 1 ? 0.85 : 1.18; // in = closer
        const next = Math.min(Math.max(dist * factor, 2.2), 14);
        dir.setLength(next);
        camera.position.copy(TARGET).add(dir);
      } else {
        // Orthographic: zoom the projection.
        const cam = camera as unknown as { zoom: number; updateProjectionMatrix: () => void };
        const factor = direction === 1 ? 1.2 : 1 / 1.2;
        cam.zoom = Math.min(Math.max(cam.zoom * factor, 20), 260);
        cam.updateProjectionMatrix();
      }
      controlsRef.current?.update();
    };
    return () => {
      zoomRef.current = null;
    };
  }, [camera, zoomRef, controlsRef]);
  return null;
}

function SceneContent({
  item,
  mode,
  dimsOn,
  arrangeOn,
  hiddenGroups,
  onGroupsDiscovered,
  onWalkExit,
  onWalkLockChange,
  arrangementState,
  onArrangementAction,
  resetLayoutRef,
  zoomRef
}: {
  item: RoomManifestItem;
  mode: ViewMode;
  dimsOn: boolean;
  arrangeOn: boolean;
  hiddenGroups: Set<FurnitureGroup>;
  onGroupsDiscovered: (groups: FurnitureGroup[]) => void;
  onWalkExit: () => void;
  onWalkLockChange: (locked: boolean) => void;
  arrangementState: ArrangementState;
  onArrangementAction: (action: ArrangementAction) => void;
  resetLayoutRef: RefObject<(() => void) | null>;
  zoomRef: RefObject<ZoomFn | null>;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  // Loaded scene root, stored in state so overlays re-render once it resolves.
  const [scene, setScene] = useState<Object3D | null>(null);
  const { isDragging, arrangementRevision } = arrangementState;

  // Stable setter: guard against redundant state updates for the same scene so
  // DormModel's effect can never trigger a render loop.
  const handleSceneReady = useCallback((next: Object3D) => {
    setScene((prev) => (prev === next ? prev : next));
  }, []);

  // Walk mode is inside the room, so the dollhouse's hidden ceiling must come
  // back while walking; every other mode restores the open-dollhouse look.
  useEffect(() => {
    const ceiling = scene?.getObjectByName('ceiling');
    if (ceiling) ceiling.visible = mode === 'walk';
  }, [scene, mode]);

  // The scene is static outside arrange drags, so the key light's 2048^2
  // shadow map doesn't need re-rendering every frame (it re-draws every
  // caster otherwise — a large hidden orbit-fps cost). Bake it, and re-bake
  // whenever anything shadow-relevant changes; keep live updates only while
  // the user is actively rearranging furniture.
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.shadowMap.autoUpdate = isDragging;
    gl.shadowMap.needsUpdate = true;
  }, [gl, isDragging, scene, mode, hiddenGroups, arrangementRevision]);

  useEffect(() => {
    return () => {
      gl.shadowMap.autoUpdate = true;
      gl.shadowMap.needsUpdate = true;
    };
  }, [gl]);

  return (
    <>
      <ambientLight intensity={0.25} />
      {/* Key light: casts the room's real shadows. Tight ortho shadow frustum
          around the ~room extents keeps the 1024² map sharp; bias/normalBias
          tuned to avoid acne + peter-panning on the traversed meshes. */}
      <directionalLight
        position={[4, 8, 3]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={1}
        shadow-camera-far={30}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
      />
      {/* Dim, shadowless fill from the opposite side to lift the darkest faces. */}
      <directionalLight position={[-5, 4, -4]} intensity={0.5} />

      <Suspense fallback={<Html center>Loading room model…</Html>}>
        <DormModel
          path={item.glbPath}
          hiddenGroups={hiddenGroups}
          onGroupsDiscovered={onGroupsDiscovered}
          onSceneReady={handleSceneReady}
        />
        {/* Procedural one-frame IBL: keeps PBR reflections while avoiding the
            network fetch used by Drei's hosted environment presets. */}
        <Environment resolution={128} frames={1}>
          <color attach="background" args={['#dbe4ef']} />
          <Lightformer
            form="rect"
            color="#fff4df"
            intensity={2.4}
            position={[0, 5, 0]}
            scale={[5, 5]}
            target={[0, 0, 0]}
          />
          <Lightformer
            form="rect"
            color="#dcecff"
            intensity={1.6}
            position={[4, 2, 2]}
            scale={[3, 3]}
            target={[0, 1, 0]}
          />
          <Lightformer
            form="rect"
            color="#ffffff"
            intensity={1.2}
            position={[-4, 1, -3]}
            scale={[2, 2]}
            target={[0, 1, 0]}
          />
        </Environment>
      </Suspense>

      <WallCuller scene={scene} mode={mode} />
      {/* Dimension badges are suppressed while walking (they crowd a
          first-person view) and while dragging (their anchors are deliberately
          recomputed once on release instead of on every pointermove). */}
      {shouldShowDimensionBadges(dimsOn, mode, arrangementState) ? (
        <DimensionOverlay
          key={`dimensions-${item.id}-${arrangementRevision}`}
          scene={scene}
          room={item.room}
          hiddenGroups={hiddenGroups}
          mode={mode}
        />
      ) : null}

      {/* ContactShadows is a ground plane; in the top-down 2D view it would face
          the camera and cover the floor plan, so we render it in 3D and walk.
          It is hidden during a live drag, when the directional shadow is live.
          frames={1} BAKES the shadow once instead of re-rendering the whole
          scene from below every frame (a large hidden per-frame cost); the key
          re-bakes it whenever the furniture set or arrangement changes. */}
      {mode !== '2d' && !isDragging ? (
        <ContactShadows
          key={contactShadowKey(item.id, hiddenGroups, arrangementState)}
          frames={1}
          position={[0, -0.02, 0]}
          opacity={0.25}
          scale={12}
          blur={2}
          far={6}
          resolution={512}
          smooth={false}
        />
      ) : null}

      {/* Postprocessing: AO grounds furniture, SMAA cleans edges, a soft vignette
          focuses the room. Perspective modes only (3D orbit + walk, gated exactly
          like ContactShadows) — under the ortho 2D camera the AO/vignette would
          fight the flat plan read. halfRes + reduced sample counts keep the AO
          pass well under a 60 fps frame budget on high-DPI screens. */}
      {mode !== '2d' ? (
        <EffectComposer multisampling={0}>
          <N8AO aoRadius={0.6} intensity={2.5} distanceFalloff={1} halfRes
                aoSamples={8} denoiseSamples={4} denoiseRadius={12} />
          <SMAA />
          <Vignette offset={0.3} darkness={0.35} eskil={false} />
        </EffectComposer>
      ) : null}

      {/* Camera + controls are mode-specific. Re-keyed so R3F swaps the default
          camera cleanly and OrbitControls re-binds to it. */}
      {mode === '2d' ? (
        <TopDownRig controlsRef={controlsRef} />
      ) : mode === 'walk' ? (
        <WalkRig scene={scene} onExit={onWalkExit} onLockChange={onWalkLockChange} />
      ) : (
        <OrbitControls
          key="orbit-3d"
          ref={controlsRef}
          makeDefault
          enableDamping
          target={[0, 1, 0]}
          minDistance={2.2}
          maxDistance={14}
          maxPolarAngle={Math.PI / 2 - 0.05}
        />
      )}
      <ZoomBridge zoomRef={zoomRef} controlsRef={controlsRef} />
      {/* Always mounted so recorded originals survive Arrange/mode toggles;
          the pointer plumbing itself only runs in the 3D orbit view. */}
      <ArrangeController
        key={`arrange-${item.id}`}
        scene={scene}
        enabled={mode === '3d' && arrangeOn}
        controlsRef={controlsRef}
        onArrangementAction={onArrangementAction}
        resetRef={resetLayoutRef}
      />
    </>
  );
}

/**
 * Locked top-down orthographic rig for 2D mode. The ortho camera sits directly
 * above the room with `up` set to -Z so looking straight down is a stable,
 * non-degenerate orientation. OrbitControls is bound explicitly to this camera
 * with rotation disabled (pan + zoom only).
 */
function TopDownRig({
  controlsRef
}: {
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const camRef = useRef<ThreeOrthographicCamera | null>(null);
  const [cam, setCam] = useState<ThreeOrthographicCamera | null>(null);

  useEffect(() => {
    const c = camRef.current;
    if (!c) return;
    c.up.set(0, 0, -1); // north = -Z, so top-down is non-degenerate
    c.position.set(0, 12, 0);
    c.lookAt(0, 0, 0);
    c.updateProjectionMatrix();
    setCam(c);
  }, []);

  return (
    <>
      <OrthographicCamera ref={camRef} makeDefault position={[0, 12, 0]} zoom={80} near={0.1} far={100} />
      {cam ? (
        <OrbitControls
          key="orbit-2d"
          ref={controlsRef}
          camera={cam}
          makeDefault
          enableRotate={false}
          enableDamping
          target={[0, 0, 0]}
          // Floor-plan feel: left-drag / one-finger pans instead of rotating.
          mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
          touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }}
        />
      ) : null}
    </>
  );
}

/**
 * First-person walk rig for walk mode. Pointer lock drives the look direction;
 * WASD/arrow keys walk on the floor plane at standing eye height (Shift =
 * faster). Each frame the camera is clamped inside the room's inner floor
 * bounds — the GLB 'floor' mesh AABB inset by WALK_WALL_INSET — so the walker
 * cannot leave the shell. Furniture is deliberately walk-through: inspection
 * matters more than physics here. On exit the pre-walk camera pose (position,
 * orientation, FOV) is restored so the orbit dollhouse resumes untouched.
 */
function WalkRig({
  scene,
  onExit,
  onLockChange
}: {
  scene: Object3D | null;
  onExit: () => void;
  onLockChange: (locked: boolean) => void;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const controlsRef = useRef<PointerLockControlsImpl | null>(null);
  // three-stdlib dispatches 'unlock' for ANY pointerlockchange that isn't a
  // grant — including a straight denial that never locked. Walking must only
  // exit on a real lock → unlock transition (ESC), otherwise a refused request
  // would bounce the user straight back out of walk mode.
  const everLocked = useRef(false);

  // Inner walkable bounds from the loaded GLB floor. Falls back to a small
  // safe square if walk mode is entered before the model resolves.
  const bounds = useMemo(() => {
    const floor = scene?.getObjectByName('floor');
    if (!floor) {
      return {
        minX: -WALK_FALLBACK_HALF,
        maxX: WALK_FALLBACK_HALF,
        minZ: -WALK_FALLBACK_HALF,
        maxZ: WALK_FALLBACK_HALF
      };
    }
    const box = new Box3().setFromObject(floor);
    return {
      minX: box.min.x + WALK_WALL_INSET,
      maxX: box.max.x - WALK_WALL_INSET,
      minZ: box.min.z + WALK_WALL_INSET,
      maxZ: box.max.z - WALK_WALL_INSET
    };
  }, [scene]);

  // Enter: save the dollhouse pose, widen the FOV and spawn at eye height near
  // the entry (+z) side looking toward the window wall. Exit: release a
  // still-held pointer lock (buttons can exit walk via keyboard focus while
  // locked) and restore the saved pose so OrbitControls resumes cleanly.
  useEffect(() => {
    const prevPosition = camera.position.clone();
    const prevQuaternion = camera.quaternion.clone();
    const persp = camera as ThreePerspectiveCamera;
    const prevFov = persp.isPerspectiveCamera ? persp.fov : null;
    if (persp.isPerspectiveCamera) {
      persp.fov = WALK_FOV;
      persp.updateProjectionMatrix();
    }
    const centerX = (bounds.minX + bounds.maxX) / 2;
    camera.position.set(centerX, WALK_EYE_HEIGHT, Math.max(bounds.minZ, bounds.maxZ - 0.4));
    camera.lookAt(centerX, WALK_EYE_HEIGHT, bounds.minZ);
    const dom = gl.domElement;
    return () => {
      if (dom.ownerDocument.pointerLockElement === dom) {
        dom.ownerDocument.exitPointerLock();
      }
      camera.position.copy(prevPosition);
      camera.quaternion.copy(prevQuaternion);
      if (prevFov !== null && persp.isPerspectiveCamera) {
        persp.fov = prevFov;
        persp.updateProjectionMatrix();
      }
    };
    // Mount/unmount only: `bounds` is read once to pick the spawn point —
    // re-spawning when the model resolves mid-walk would teleport the walker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl]);

  // Entering walk requests pointer lock right away — the Walk-button click that
  // mounted this rig is the required user gesture. Browsers may still refuse
  // (e.g. Chrome's cooldown right after an ESC exit); the drei controls' canvas
  // click handler (selector below) then locks instead, and the hint says so.
  useEffect(() => {
    try {
      void Promise.resolve(gl.domElement.requestPointerLock()).catch(() => {});
    } catch {
      // Pointer lock unsupported or refused — a canvas click will lock instead.
    }
  }, [gl]);

  // Movement keys currently held. e.code so WASD works on any keyboard layout;
  // keys are only captured while the pointer is locked so the surrounding UI
  // (selects, buttons) keeps normal keyboard behavior otherwise.
  const keys = useRef({ forward: false, back: false, left: false, right: false, fast: false });
  useEffect(() => {
    const apply = (event: KeyboardEvent, down: boolean) => {
      if (!controlsRef.current?.isLocked) return;
      switch (event.code) {
        case 'KeyW':
        case 'ArrowUp':
          keys.current.forward = down;
          break;
        case 'KeyS':
        case 'ArrowDown':
          keys.current.back = down;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          keys.current.left = down;
          break;
        case 'KeyD':
        case 'ArrowRight':
          keys.current.right = down;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          keys.current.fast = down;
          break;
        default:
          return;
      }
      event.preventDefault(); // arrows would otherwise scroll/move focus
    };
    const onKeyDown = (event: KeyboardEvent) => apply(event, true);
    const onKeyUp = (event: KeyboardEvent) => apply(event, false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // Per-frame scratch vectors (same idiom as WallCuller's camDir).
  const forward = useRef(new Vector3());
  const rightward = useRef(new Vector3());
  const step = useRef(new Vector3());

  useFrame((_, delta) => {
    if (!controlsRef.current?.isLocked) return;
    const k = keys.current;
    const ahead = (k.forward ? 1 : 0) - (k.back ? 1 : 0);
    const strafe = (k.right ? 1 : 0) - (k.left ? 1 : 0);
    if (ahead !== 0 || strafe !== 0) {
      // Forward = look direction flattened onto the floor plane (no flying).
      camera.getWorldDirection(forward.current);
      forward.current.y = 0;
      if (forward.current.lengthSq() > 1e-6) {
        forward.current.normalize();
        rightward.current.crossVectors(forward.current, WORLD_UP);
        step.current
          .set(0, 0, 0)
          .addScaledVector(forward.current, ahead)
          .addScaledVector(rightward.current, strafe);
        // Cap delta so a backgrounded tab can't teleport the walker.
        const speed = k.fast ? WALK_SPEED_FAST : WALK_SPEED;
        step.current.normalize().multiplyScalar(speed * Math.min(delta, 0.1));
        camera.position.add(step.current);
      }
    }
    // Stay at eye height, inside the room shell (furniture is walk-through).
    camera.position.y = WALK_EYE_HEIGHT;
    camera.position.x = Math.min(Math.max(camera.position.x, bounds.minX), bounds.maxX);
    camera.position.z = Math.min(Math.max(camera.position.z, bounds.minZ), bounds.maxZ);
  });

  return (
    <PointerLockControls
      ref={controlsRef}
      makeDefault
      // Scope click-to-lock to the canvas only. drei's default (no selector)
      // binds document-wide, which would re-request the lock on the very
      // top-bar clicks that exit walk mode.
      selector=".stage-scene canvas"
      onLock={() => {
        everLocked.current = true;
        onLockChange(true);
      }}
      onUnlock={() => {
        // Pointer lock lost (ESC) ends the walk entirely — back to the orbit.
        onLockChange(false);
        if (everLocked.current) onExit();
      }}
    />
  );
}

/**
 * Arrange (move-furniture) mode, orbit view only. Pointer-down on a movable
 * furniture instance (chairs/desks/dressers/microchill/beds — never closets,
 * doors, windows or the shell) starts a drag that slides every top-level node
 * of that instance along the floor plane (each node keeps its own y), with the
 * instance centre clamped inside the floor's inner bounds. Decor that belongs
 * to the instance (bed dressing, desk staging) rides along; freestanding decor
 * stays put. Overlaps are allowed — this is a what-if layout tool, not physics.
 *
 * OrbitControls is disabled only while a drag is live, so empty-space drags
 * still orbit. Original positions are recorded once per node at its first drag
 * and `resetRef` restores them all. Everything is session-only: useGLTF caches
 * scenes per path, so on scene swap the cleanup restores the official layout
 * before the cached GLB can leak a custom arrangement into the next visit.
 */
function ArrangeController({
  scene,
  enabled,
  controlsRef,
  onArrangementAction,
  resetRef
}: {
  scene: Object3D | null;
  enabled: boolean;
  controlsRef: RefObject<OrbitControlsImpl | null>;
  onArrangementAction: (action: ArrangementAction) => void;
  resetRef: RefObject<(() => void) | null>;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  // Instance prefix -> top-level nodes (furniture parts + riding decor).
  const instances = useMemo(
    () => (scene ? collectArrangeInstances(scene) : new Map<string, Object3D[]>()),
    [scene]
  );
  const nodeToInstance = useMemo(() => {
    const map = new Map<Object3D, string>();
    for (const [instance, nodes] of instances) {
      for (const node of nodes) map.set(node, instance);
    }
    return map;
  }, [instances]);

  // Inner floor bounds (same derivation as WalkRig, arrange inset).
  const bounds = useMemo(() => {
    const floor = scene?.getObjectByName('floor');
    if (!floor) {
      return {
        minX: -WALK_FALLBACK_HALF,
        maxX: WALK_FALLBACK_HALF,
        minZ: -WALK_FALLBACK_HALF,
        maxZ: WALK_FALLBACK_HALF
      };
    }
    const box = new Box3().setFromObject(floor);
    return {
      minX: box.min.x + ARRANGE_WALL_INSET,
      maxX: box.max.x - ARRANGE_WALL_INSET,
      minZ: box.min.z + ARRANGE_WALL_INSET,
      maxZ: box.max.z - ARRANGE_WALL_INSET
    };
  }, [scene]);

  // Original position per moved node, recorded once at its first drag. Dirty
  // mirrors "anything displaced" and drives the honesty note + Reset pill.
  const originals = useRef(new Map<Object3D, Vector3>());
  const dirtyRef = useRef(false);
  // Hover tint state: per-mesh {original, tinted clone} pairs, reused across
  // hovers and disposed on scene swap; plus the currently tinted meshes.
  const tintCache = useRef(new Map<ArrangeMesh, { original: Material; tinted: EmissiveMaterial }>());
  const hoveredMeshes = useRef<ArrangeMesh[]>([]);
  const hoveredInstance = useRef<string | null>(null);

  const clearHover = useCallback(() => {
    for (const mesh of hoveredMeshes.current) {
      const entry = tintCache.current.get(mesh);
      if (entry) mesh.material = entry.original;
    }
    hoveredMeshes.current = [];
    hoveredInstance.current = null;
  }, []);

  // Expose "restore every recorded original" to the DOM Reset-layout pill.
  useEffect(() => {
    resetRef.current = () => {
      for (const [node, position] of originals.current) {
        node.position.copy(position);
      }
      originals.current.clear();
      dirtyRef.current = false;
      onArrangementAction({ type: 'reset' });
    };
    return () => {
      resetRef.current = null;
    };
  }, [resetRef, onArrangementAction]);

  // Scene lifecycle: when the scene goes away (room switch/unmount), restore
  // the official layout into the CACHED scene graph, drop the originals and
  // dispose the hover-material clones. This is what makes room switches
  // "naturally reset" despite useGLTF's cache returning the same Object3Ds.
  useEffect(() => {
    if (!scene) return;
    const sceneOriginals = originals.current;
    const sceneTintCache = tintCache.current;
    return () => {
      clearHover();
      for (const [node, position] of sceneOriginals) {
        node.position.copy(position);
      }
      sceneOriginals.clear();
      for (const { tinted } of sceneTintCache.values()) tinted.dispose();
      sceneTintCache.clear();
      dirtyRef.current = false;
    };
  }, [scene, clearHover]);

  // Pointer plumbing. Listeners bind straight to the canvas so the drag can
  // coexist with OrbitControls: on furniture pointer-down we flip
  // controls.enabled off (the drei/TransformControls idiom — OrbitControls
  // checks it per move), then back on at release.
  useEffect(() => {
    if (!enabled || !scene || instances.size === 0) return;
    const dom = gl.domElement;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const planeHit = new Vector3();

    let drag: {
      pointerId: number;
      nodes: Object3D[];
      startPositions: Vector3[];
      startCenter: Vector3;
      plane: Plane;
      startPoint: Vector3;
      moved: boolean;
    } | null = null;

    const castAt = (event: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(ndc, camera);
    };

    // Movable instance under the pointer. Roots are filtered by visibility so
    // furniture hidden via the Furniture toggles can't be hovered or dragged.
    const pick = (event: PointerEvent): { instance: string; point: Vector3 } | null => {
      castAt(event);
      const roots: Object3D[] = [];
      for (const nodes of instances.values()) {
        for (const node of nodes) {
          if (node.visible) roots.push(node);
        }
      }
      const [hit] = raycaster.intersectObjects(roots, true);
      if (!hit) return null;
      let node: Object3D | null = hit.object;
      while (node && !nodeToInstance.has(node)) node = node.parent;
      const instance = node ? nodeToInstance.get(node) : undefined;
      return instance ? { instance, point: hit.point } : null;
    };

    const applyHover = (instance: string) => {
      const meshes: ArrangeMesh[] = [];
      for (const node of instances.get(instance) ?? []) {
        node.traverse((child) => {
          const mesh = child as ArrangeMesh;
          if (!mesh.isMesh || Array.isArray(mesh.material)) return;
          let entry = tintCache.current.get(mesh);
          if (!entry) {
            const original = mesh.material;
            if (!('emissive' in original)) return;
            const tinted = original.clone() as EmissiveMaterial;
            tinted.emissive.setHex(ARRANGE_HOVER_EMISSIVE);
            tinted.emissiveIntensity = ARRANGE_HOVER_INTENSITY;
            entry = { original, tinted };
            tintCache.current.set(mesh, entry);
          }
          mesh.material = entry.tinted;
          meshes.push(mesh);
        });
      }
      hoveredMeshes.current = meshes;
      hoveredInstance.current = instance;
    };

    const endDrag = (reason: ArrangementFinishReason) => {
      if (!drag) return;
      const ended = drag;
      // Clear first so a synchronous event raised by releasing capture cannot
      // commit the same drag twice.
      drag = null;
      try {
        if (dom.hasPointerCapture(ended.pointerId)) {
          dom.releasePointerCapture(ended.pointerId);
        }
      } catch {
        // Capture may already be gone after cancellation or canvas teardown;
        // controls and revision state still need to settle below.
      }
      if (controlsRef.current) controlsRef.current.enabled = true;
      onArrangementAction({ type: 'drag-end', moved: ended.moved, reason });
      dom.style.cursor = hoveredInstance.current ? 'grab' : '';
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // A second pointer (e.g. a touch on a fine-pointer touchscreen laptop)
      // must not hijack a live drag: it would orphan the first pointer's drag
      // and leave OrbitControls disabled until the second pointer lifts.
      if (drag) return;
      const hit = pick(event);
      if (!hit) return; // empty space / shell: OrbitControls orbits as usual
      const nodes = instances.get(hit.instance);
      if (!nodes || nodes.length === 0) return;
      for (const node of nodes) {
        if (!originals.current.has(node)) {
          originals.current.set(node, node.position.clone());
        }
      }
      const box = new Box3();
      for (const node of nodes) box.expandByObject(node);
      drag = {
        pointerId: event.pointerId,
        nodes,
        startPositions: nodes.map((node) => node.position.clone()),
        startCenter: box.getCenter(new Vector3()),
        // Horizontal plane through the grab point: the piece tracks under the
        // cursor with no depth jump, and every node keeps its own y.
        plane: new Plane(new Vector3(0, 1, 0), -hit.point.y),
        startPoint: hit.point.clone(),
        moved: false
      };
      if (controlsRef.current) controlsRef.current.enabled = false;
      onArrangementAction({ type: 'drag-start' });
      try {
        dom.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a nicety (keeps the drag alive off-canvas); a pointer
        // that can't be captured still drags via the canvas listeners.
      }
      dom.style.cursor = 'grabbing';
    };

    const onPointerMove = (event: PointerEvent) => {
      const active = drag;
      if (active) {
        // Only the dragging pointer steers the drag; a concurrent touch's
        // moves would compute a delta against the OTHER pointer's grab point
        // and teleport the furniture.
        if (event.pointerId !== active.pointerId) return;
        castAt(event);
        if (!raycaster.ray.intersectPlane(active.plane, planeHit)) return;
        const rawX = active.startCenter.x + (planeHit.x - active.startPoint.x);
        const rawZ = active.startCenter.z + (planeHit.z - active.startPoint.z);
        // Clamp the INSTANCE CENTRE inside the inner floor bounds; overlaps
        // between furniture are allowed on purpose.
        const clampedX = Math.min(Math.max(rawX, bounds.minX), bounds.maxX) - active.startCenter.x;
        const clampedZ = Math.min(Math.max(rawZ, bounds.minZ), bounds.maxZ) - active.startCenter.z;
        // Collapse floating-point ray noise to zero so a stationary click
        // cannot mutate transforms, dirty the layout, or advance the revision.
        const dx = Math.abs(clampedX) > 1e-6 ? clampedX : 0;
        const dz = Math.abs(clampedZ) > 1e-6 ? clampedZ : 0;
        const moved = dx !== 0 || dz !== 0;
        active.nodes.forEach((node, index) => {
          const start = active.startPositions[index];
          node.position.set(start.x + dx, start.y, start.z + dz);
        });
        if (moved) active.moved = true;
        if (!dirtyRef.current && moved) {
          dirtyRef.current = true;
          onArrangementAction({ type: 'drag-move' });
        }
        return;
      }
      // Hover cue: pointer cursor + subtle emissive tint on the instance.
      const instance = pick(event)?.instance ?? null;
      if (instance === hoveredInstance.current) return;
      clearHover();
      if (instance) applyHover(instance);
      dom.style.cursor = instance ? 'grab' : '';
    };

    const onPointerUp = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointerId) endDrag('pointer-up');
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (drag && event.pointerId === drag.pointerId) endDrag('pointer-cancel');
    };

    const onPointerLeave = () => {
      if (drag) return; // pointer capture keeps move/up flowing during a drag
      clearHover();
      dom.style.cursor = '';
    };

    dom.addEventListener('pointerdown', onPointerDown);
    dom.addEventListener('pointermove', onPointerMove);
    dom.addEventListener('pointerup', onPointerUp);
    dom.addEventListener('pointercancel', onPointerCancel);
    dom.addEventListener('pointerleave', onPointerLeave);
    return () => {
      dom.removeEventListener('pointerdown', onPointerDown);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerCancel);
      dom.removeEventListener('pointerleave', onPointerLeave);
      endDrag('cleanup'); // mid-drag mode switch/toggle-off: re-enable orbiting
      clearHover();
      dom.style.cursor = '';
    };
  }, [
    enabled,
    scene,
    instances,
    nodeToInstance,
    bounds,
    camera,
    gl,
    controlsRef,
    onArrangementAction,
    clearHover
  ]);

  // SceneContent keys this controller by room. Its pointer cleanup commits a
  // moved in-flight drag first; this final cleanup then clears dirty state so
  // a cached transform can never leak its honesty notice into the next room.
  useEffect(() => {
    return () => onArrangementAction({ type: 'room-switch' });
  }, [onArrangementAction]);

  return null;
}

export function RoomViewer3D({
  room: item,
  mode,
  dimsOn,
  arrangeOn,
  arrangementState,
  hiddenGroups,
  onGroupsDiscovered,
  onWalkExit,
  onArrangementAction,
  resetLayoutRef,
  zoomRef
}: {
  room: RoomManifestItem;
  mode: ViewMode;
  dimsOn: boolean;
  arrangeOn: boolean;
  arrangementState: ArrangementState;
  hiddenGroups: Set<FurnitureGroup>;
  onGroupsDiscovered: (groups: FurnitureGroup[]) => void;
  onWalkExit: () => void;
  onArrangementAction: (action: ArrangementAction) => void;
  resetLayoutRef: RefObject<(() => void) | null>;
  zoomRef: RefObject<ZoomFn | null>;
}) {
  // Walk-mode hint state. walkLocked mirrors the pointer-lock state so the hint
  // can prompt for the first canvas click when the browser refused the
  // automatic lock request. Both reset when leaving walk mode, so the hint
  // re-arms on the next walk.
  const [walkLocked, setWalkLocked] = useState(false);
  const [walkHintDismissed, setWalkHintDismissed] = useState(false);
  useEffect(() => {
    if (mode !== 'walk') {
      setWalkLocked(false);
      setWalkHintDismissed(false);
    }
  }, [mode]);

  return (
    <div className="stage-scene">
      <Canvas
        camera={{ position: [3.4, 7.2, 4.8], fov: 48 }}
        shadows="basic"
        // dpr capped at 1.75: on 2-3x displays the full ratio quadruples the
        // shaded pixel count for no visible gain at room-viewer distances —
        // the single biggest lever for maintaining 60 fps while orbiting.
        dpr={[1, 1.75]}
        gl={{
          antialias: true,
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1.0
        }}
      >
        <SceneContent
          item={item}
          mode={mode}
          dimsOn={dimsOn}
          arrangeOn={arrangeOn}
          hiddenGroups={hiddenGroups}
          onGroupsDiscovered={onGroupsDiscovered}
          onWalkExit={onWalkExit}
          onWalkLockChange={setWalkLocked}
          arrangementState={arrangementState}
          onArrangementAction={onArrangementAction}
          resetLayoutRef={resetLayoutRef}
          zoomRef={zoomRef}
        />
      </Canvas>
      {/* Dismissable walk-mode hint, top-centre under the top bar. */}
      {mode === 'walk' && !walkHintDismissed ? (
        <div className="walk-hint" role="status">
          <div className="walk-hint-lines">
            <span className="walk-hint-keys">WASD / arrows to move - mouse to look - ESC to exit</span>
            {!walkLocked ? <span className="walk-hint-sub">Click the room to start walking</span> : null}
          </div>
          <button
            type="button"
            className="walk-hint-close"
            onClick={() => setWalkHintDismissed(true)}
            aria-label="Dismiss walk hint"
          >
            ×
          </button>
        </div>
      ) : null}
      {/* Honesty note while any furniture is displaced from the GLB layout.
          Clears on Reset layout or a room switch; the accuracy chip below is
          untouched. */}
      {arrangementState.layoutDirty ? (
        <div className="stage-arrange-note" role="status">
          Custom arrangement — not the official layout
        </div>
      ) : null}
      {/* Always-visible honesty chip floating over the stage. */}
      <div className="stage-accuracy-chip">
        {mode === '2d'
          ? 'Top-down view. Estimated dimensions must be verified before fit-critical decisions.'
          : 'Representative model. Estimated dimensions must be verified before fit-critical decisions.'}
      </div>
    </div>
  );
}

/**
 * Furniture group toggles, styled for the top-bar popover. Rendered outside the
 * Canvas.
 */
export function FurnitureToggles({
  availableGroups,
  hiddenGroups,
  onToggle
}: {
  availableGroups: FurnitureGroup[];
  hiddenGroups: Set<FurnitureGroup>;
  onToggle: (group: FurnitureGroup, visible: boolean) => void;
}) {
  if (availableGroups.length === 0) {
    return <p className="furniture-empty">Furniture appears once the model loads.</p>;
  }
  // Decor is a master switch pinned above the grid, not a furniture chip. Split
  // it out so it never renders as a duplicate entry in the chip grid.
  const hasDecor = availableGroups.includes(DECOR_GROUP);
  const furnitureGroups = availableGroups.filter((group) => group !== DECOR_GROUP);
  const decorOn = !hiddenGroups.has(DECOR_GROUP);
  return (
    <div className="furniture-toggle-panel">
      {hasDecor ? (
        <label className={`decor-master-chip${decorOn ? ' is-on' : ''}`}>
          <input
            type="checkbox"
            checked={decorOn}
            onChange={(event) => onToggle(DECOR_GROUP, event.target.checked)}
          />
          <span className="decor-master-track" aria-hidden="true">
            <span className="decor-master-knob" />
          </span>
          <span className="decor-master-label">Decor (illustrative)</span>
        </label>
      ) : null}
      <div className="furniture-chip-grid" role="group" aria-label="Furniture visibility">
        {furnitureGroups.map((group) => {
          const visible = !hiddenGroups.has(group);
          return (
            <label key={group} className={`furniture-chip${visible ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                checked={visible}
                onChange={(event) => onToggle(group, event.target.checked)}
              />
              {FURNITURE_GROUP_LABELS[group]}
            </label>
          );
        })}
      </div>
    </div>
  );
}

import { z } from 'zod';
import type { ClearanceZone, Room } from '@nestometry/room-schema';
import type {
  CustomBlock,
  PlannerInstance,
  PlannerPose,
  SceneDocument
} from './plannerDocument';

export const SOLID_CONFLICT_TOLERANCE_M = 0.002;

const FiniteNumberSchema = z.number().finite();

export const LocalBoxColliderSchema = z
  .object({
    id: z.string().min(1).max(160),
    center_m: z
      .object({ x: FiniteNumberSchema, y: FiniteNumberSchema, z: FiniteNumberSchema })
      .strict(),
    size_m: z
      .object({
        width: z.number().positive(),
        depth: z.number().positive(),
        height: z.number().positive()
      })
      .strict(),
    rotation_deg: FiniteNumberSchema.optional()
  })
  .strict();

export const SceneColliderManifestSchema = z
  .object({
    manifest_version: z.literal(1),
    room_id: z.string().min(1).max(160),
    scene_revision: z.string().min(1).max(160),
    asset_sha256: z.string().regex(/^[a-f\d]{64}$/u),
    instances: z.array(
      z
        .object({
          instance_id: z.string().min(1).max(160),
          colliders: z.array(LocalBoxColliderSchema).min(1).max(32)
        })
        .strict()
    )
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    manifest.instances.forEach((instance, index) => {
      if (ids.has(instance.instance_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['instances', index, 'instance_id'],
          message: `duplicate collider instance id: ${instance.instance_id}`
        });
      }
      ids.add(instance.instance_id);
    });
  });

export type ColliderSize = z.infer<typeof LocalBoxColliderSchema>['size_m'];
export type LocalBoxCollider = z.infer<typeof LocalBoxColliderSchema>;
export type SceneColliderManifest = z.infer<typeof SceneColliderManifestSchema>;

export async function loadSceneColliderManifest(
  input: string | URL | Request,
  init?: RequestInit
): Promise<SceneColliderManifest> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`collider manifest request failed with ${response.status}`);
  }
  return SceneColliderManifestSchema.parse(await response.json());
}

export type PlannerShell = {
  width_m: number;
  depth_m: number;
  height_m: number;
};

export type RectangleClearanceGeometry = Extract<
  ClearanceZone['geometry'],
  { shape: 'rectangle' }
>;
export type SectorClearanceGeometry = Extract<
  ClearanceZone['geometry'],
  { shape: 'sector' }
>;
export type PlannerClearanceZone = ClearanceZone;

export type PlannerConflict = {
  id: string;
  kind: 'solid_overlap' | 'wall_crossing' | 'door_swing' | 'circulation';
  severity: 'error' | 'warning';
  instance_ids: string[];
  zone_id?: string;
  penetration_m?: number;
  message: string;
};

export function plannerShellFromRoom(room: Room): PlannerShell {
  return {
    width_m: room.visualization_shell.width.value_m,
    depth_m: room.visualization_shell.depth.value_m,
    height_m: room.visualization_shell.height.value_m
  };
}

export function plannerClearanceZonesFromRoom(room: Room): PlannerClearanceZone[] {
  return room.visualization_scene.clearance_zones.map((zone) => structuredClone(zone));
}

type Point = { x: number; y: number };

type WorldBox = {
  instance_id: string;
  instance_role: PlannerInstance['role'] | 'custom';
  collider_id: string;
  center: Point;
  half_width: number;
  half_depth: number;
  min_z: number;
  max_z: number;
  angle_rad: number;
};

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function rotate(point: Point, angleRad: number): Point {
  const cosine = Math.cos(angleRad);
  const sine = Math.sin(angleRad);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine
  };
}

export type PlannerFootprint = {
  center_m: Point;
  size_m: { width: number; depth: number };
  rotation_deg: number;
};

/**
 * Collapse detailed root-local colliders into one conservative, oriented 2D
 * footprint. The local aggregate keeps protrusions and off-centre geometry;
 * the instance yaw then moves that aggregate into the room coordinate frame.
 */
export function plannerInstanceFootprint(
  instance: PlannerInstance,
  colliders: readonly LocalBoxCollider[]
): PlannerFootprint | null {
  if (colliders.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const collider of colliders) {
    const angle = radians(collider.rotation_deg ?? 0);
    const halfWidth = collider.size_m.width / 2;
    const halfDepth = collider.size_m.depth / 2;
    for (const x of [-halfWidth, halfWidth]) {
      for (const y of [-halfDepth, halfDepth]) {
        const corner = rotate({ x, y }, angle);
        const localX = collider.center_m.x + corner.x;
        const localY = collider.center_m.y + corner.y;
        minX = Math.min(minX, localX);
        maxX = Math.max(maxX, localX);
        minY = Math.min(minY, localY);
        maxY = Math.max(maxY, localY);
      }
    }
  }

  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const worldOffset = rotate(localCenter, radians(instance.pose.rotation_deg.z));
  return {
    center_m: {
      x: instance.pose.position_m.x + worldOffset.x,
      y: instance.pose.position_m.y + worldOffset.y
    },
    size_m: { width: maxX - minX, depth: maxY - minY },
    rotation_deg: instance.pose.rotation_deg.z
  };
}

function worldBox(
  instanceId: string,
  instanceRole: WorldBox['instance_role'],
  pose: PlannerPose,
  collider: LocalBoxCollider
): WorldBox {
  const poseAngle = radians(pose.rotation_deg.z);
  const localCenter = rotate(
    { x: collider.center_m.x, y: collider.center_m.y },
    poseAngle
  );
  const centerZ = pose.position_m.z + collider.center_m.z;
  return {
    instance_id: instanceId,
    instance_role: instanceRole,
    collider_id: collider.id,
    center: {
      x: pose.position_m.x + localCenter.x,
      y: pose.position_m.y + localCenter.y
    },
    half_width: collider.size_m.width / 2,
    half_depth: collider.size_m.depth / 2,
    min_z: centerZ - collider.size_m.height / 2,
    max_z: centerZ + collider.size_m.height / 2,
    angle_rad: poseAngle + radians(collider.rotation_deg ?? 0)
  };
}

function customBlockCollider(block: CustomBlock): WorldBox {
  return worldBox(block.id, 'custom', block.pose, {
    id: `${block.id}_box`,
    center_m: { x: 0, y: 0, z: block.dimensions_m.height / 2 },
    size_m: block.dimensions_m
  });
}

function boxAxes(box: WorldBox): [Point, Point] {
  const cosine = Math.cos(box.angle_rad);
  const sine = Math.sin(box.angle_rad);
  return [
    { x: cosine, y: sine },
    { x: -sine, y: cosine }
  ];
}

function projectionRadius(box: WorldBox, axis: Point): number {
  const [widthAxis, depthAxis] = boxAxes(box);
  return (
    box.half_width * Math.abs(widthAxis.x * axis.x + widthAxis.y * axis.y) +
    box.half_depth * Math.abs(depthAxis.x * axis.x + depthAxis.y * axis.y)
  );
}

function planarPenetration(left: WorldBox, right: WorldBox): number {
  let minimum = Number.POSITIVE_INFINITY;
  const centerDelta = {
    x: right.center.x - left.center.x,
    y: right.center.y - left.center.y
  };
  for (const axis of [...boxAxes(left), ...boxAxes(right)]) {
    const centerDistance = Math.abs(centerDelta.x * axis.x + centerDelta.y * axis.y);
    const overlap = projectionRadius(left, axis) + projectionRadius(right, axis) - centerDistance;
    if (overlap <= 0) return 0;
    minimum = Math.min(minimum, overlap);
  }
  return minimum;
}

function solidPenetration(left: WorldBox, right: WorldBox): number {
  const planar = planarPenetration(left, right);
  if (planar <= 0) return 0;
  const vertical = Math.min(left.max_z, right.max_z) - Math.max(left.min_z, right.min_z);
  return vertical <= 0 ? 0 : Math.min(planar, vertical);
}

function boxCorners(box: WorldBox): Point[] {
  return [
    { x: -box.half_width, y: -box.half_depth },
    { x: box.half_width, y: -box.half_depth },
    { x: box.half_width, y: box.half_depth },
    { x: -box.half_width, y: box.half_depth }
  ].map((corner) => {
    const rotated = rotate(corner, box.angle_rad);
    return { x: box.center.x + rotated.x, y: box.center.y + rotated.y };
  });
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
  const epsilon = 1e-9;
  return (
    point.x <= Math.max(a.x, b.x) + epsilon &&
    point.x >= Math.min(a.x, b.x) - epsilon &&
    point.y <= Math.max(a.y, b.y) + epsilon &&
    point.y >= Math.min(a.y, b.y) - epsilon
  );
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if ((first > 0) !== (second > 0) && (third > 0) !== (fourth > 0)) return true;
  const epsilon = 1e-9;
  return (
    (Math.abs(first) <= epsilon && onSegment(a, b, c)) ||
    (Math.abs(second) <= epsilon && onSegment(a, b, d)) ||
    (Math.abs(third) <= epsilon && onSegment(c, d, a)) ||
    (Math.abs(fourth) <= epsilon && onSegment(c, d, b))
  );
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current];
    const b = polygon[previous];
    const crosses =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonsIntersect(left: Point[], right: Point[]): boolean {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftNext = (leftIndex + 1) % left.length;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightNext = (rightIndex + 1) % right.length;
      if (
        segmentsIntersect(
          left[leftIndex],
          left[leftNext],
          right[rightIndex],
          right[rightNext]
        )
      ) {
        return true;
      }
    }
  }
  return pointInPolygon(left[0], right) || pointInPolygon(right[0], left);
}

function transformZoneGeometry(
  zone: PlannerClearanceZone,
  instances: Map<string, PlannerInstance>
): RectangleClearanceGeometry | SectorClearanceGeometry {
  if (!zone.anchor_instance_id) return zone.geometry;
  const anchor = instances.get(zone.anchor_instance_id);
  if (!anchor) return zone.geometry;
  const original = anchor.original_pose;
  const current = anchor.pose;
  const rotationDelta = current.rotation_deg.z - original.rotation_deg.z;
  const relativeCenter = {
    x: zone.geometry.center_m.x - original.position_m.x,
    y: zone.geometry.center_m.y - original.position_m.y
  };
  const rotated = rotate(relativeCenter, radians(rotationDelta));
  const center_m = {
    x: current.position_m.x + rotated.x,
    y: current.position_m.y + rotated.y
  };
  if (zone.geometry.shape === 'rectangle') {
    return {
      ...zone.geometry,
      center_m,
      rotation_deg: zone.geometry.rotation_deg + rotationDelta
    };
  }
  return {
    ...zone.geometry,
    center_m,
    start_angle_deg: zone.geometry.start_angle_deg + rotationDelta,
    end_angle_deg: zone.geometry.end_angle_deg + rotationDelta
  };
}

function clearancePolygon(geometry: RectangleClearanceGeometry | SectorClearanceGeometry): Point[] {
  if (geometry.shape === 'rectangle') {
    const box: WorldBox = {
      instance_id: 'clearance',
      instance_role: 'custom',
      collider_id: 'clearance',
      center: geometry.center_m,
      half_width: geometry.size_m.width / 2,
      half_depth: geometry.size_m.depth / 2,
      min_z: 0,
      max_z: 0,
      angle_rad: radians(geometry.rotation_deg)
    };
    return boxCorners(box);
  }

  let end = geometry.end_angle_deg;
  while (end < geometry.start_angle_deg) end += 360;
  const sweep = Math.min(360, end - geometry.start_angle_deg);
  const segments = Math.max(2, Math.ceil(sweep / 5));
  const points: Point[] = [geometry.center_m];
  for (let index = 0; index <= segments; index += 1) {
    const angle = radians(geometry.start_angle_deg + (sweep * index) / segments);
    points.push({
      x: geometry.center_m.x + Math.cos(angle) * geometry.radius_m,
      y: geometry.center_m.y + Math.sin(angle) * geometry.radius_m
    });
  }
  return points;
}

function activeWorldBoxes(
  document: SceneDocument,
  manifest: SceneColliderManifest
): WorldBox[] {
  const removed = new Set(document.layout.removed_instance_ids);
  const instances = new Map(document.layout.instances.map((instance) => [instance.id, instance]));
  const boxes: WorldBox[] = [];
  for (const manifestInstance of manifest.instances) {
    if (removed.has(manifestInstance.instance_id)) continue;
    const instance = instances.get(manifestInstance.instance_id);
    if (!instance) continue;
    for (const collider of manifestInstance.colliders) {
      if (
        collider.size_m.width <= 0 ||
        collider.size_m.depth <= 0 ||
        collider.size_m.height <= 0
      ) {
        continue;
      }
      boxes.push(worldBox(instance.id, instance.role, instance.pose, collider));
    }
  }
  for (const block of document.layout.custom_blocks) boxes.push(customBlockCollider(block));
  return boxes;
}

function isInstalledOpening(instanceId: string): boolean {
  return instanceId === 'door' || instanceId === 'window' || /^(?:door|window)_\d+$/u.test(instanceId);
}

function poseMatchesOriginal(instance: PlannerInstance): boolean {
  return (
    instance.pose.position_m.x === instance.original_pose.position_m.x &&
    instance.pose.position_m.y === instance.original_pose.position_m.y &&
    instance.pose.position_m.z === instance.original_pose.position_m.z &&
    instance.pose.rotation_deg.x === instance.original_pose.rotation_deg.x &&
    instance.pose.rotation_deg.y === instance.original_pose.rotation_deg.y &&
    instance.pose.rotation_deg.z === instance.original_pose.rotation_deg.z
  );
}

function isCanonicalOpeningContact(
  left: WorldBox,
  right: WorldBox,
  instances: ReadonlyMap<string, PlannerInstance>
): boolean {
  if (!isInstalledOpening(left.instance_id) && !isInstalledOpening(right.instance_id)) {
    return false;
  }
  const nonOpeningId = isInstalledOpening(left.instance_id)
    ? right.instance_id
    : left.instance_id;
  const nonOpening = instances.get(nonOpeningId);
  return Boolean(nonOpening && poseMatchesOriginal(nonOpening));
}

function validateManifest(document: SceneDocument, manifest: SceneColliderManifest): void {
  if (
    manifest.room_id !== document.room_id ||
    manifest.scene_revision !== document.scene_revision
  ) {
    throw new Error('collider manifest does not match the active room scene');
  }
}

export function evaluatePlannerConflicts(input: {
  document: SceneDocument;
  shell: PlannerShell;
  collider_manifest: SceneColliderManifest;
  clearance_zones: PlannerClearanceZone[];
}): PlannerConflict[] {
  validateManifest(input.document, input.collider_manifest);
  const boxes = activeWorldBoxes(input.document, input.collider_manifest);
  const instances = new Map(
    input.document.layout.instances.map((instance) => [instance.id, instance] as const)
  );
  const conflicts = new Map<string, PlannerConflict>();

  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    const left = boxes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const right = boxes[rightIndex];
      if (left.instance_id === right.instance_id) continue;
      // Some representative furniture intentionally touches the window frame.
      // Preserve only that unchanged canonical contact; moved furniture and
      // custom blocks must still treat door/window geometry as an obstacle.
      if (isCanonicalOpeningContact(left, right, instances)) continue;
      const penetration = solidPenetration(left, right);
      if (penetration <= SOLID_CONFLICT_TOLERANCE_M) continue;
      const ids = [left.instance_id, right.instance_id].sort();
      const key = `solid_overlap:${ids.join(':')}`;
      const previous = conflicts.get(key);
      if (!previous || penetration > (previous.penetration_m ?? 0)) {
        conflicts.set(key, {
          id: key,
          kind: 'solid_overlap',
          severity: 'error',
          instance_ids: ids,
          penetration_m: penetration,
          message: `${ids[0]} overlaps ${ids[1]}`
        });
      }
    }
  }

  const halfWidth = input.shell.width_m / 2;
  const halfDepth = input.shell.depth_m / 2;
  for (const box of boxes) {
    if (box.instance_role === 'attached' || box.instance_role === 'built_in') continue;
    const horizontalCrossing = Math.max(
      0,
      ...boxCorners(box).flatMap((corner) => [
        Math.abs(corner.x) - halfWidth,
        Math.abs(corner.y) - halfDepth
      ])
    );
    const verticalCrossing = Math.max(0, -box.min_z, box.max_z - input.shell.height_m);
    const crossing = Math.max(horizontalCrossing, verticalCrossing);
    if (crossing <= SOLID_CONFLICT_TOLERANCE_M) continue;
    const key = `wall_crossing:${box.instance_id}`;
    const previous = conflicts.get(key);
    if (!previous || crossing > (previous.penetration_m ?? 0)) {
      conflicts.set(key, {
        id: key,
        kind: 'wall_crossing',
        severity: 'error',
        instance_ids: [box.instance_id],
        penetration_m: crossing,
        message: `${box.instance_id} crosses the room boundary`
      });
    }
  }

  for (const zone of input.clearance_zones) {
    const zonePolygon = clearancePolygon(transformZoneGeometry(zone, instances));
    for (const box of boxes) {
      if (box.instance_id === zone.anchor_instance_id) continue;
      if (!polygonsIntersect(boxCorners(box), zonePolygon)) continue;
      const key = `${zone.type}:${zone.id}:${box.instance_id}`;
      conflicts.set(key, {
        id: key,
        kind: zone.type,
        severity: 'warning',
        instance_ids: [box.instance_id],
        zone_id: zone.id,
        message:
          zone.type === 'door_swing'
            ? `${box.instance_id} enters a door swing`
            : `${box.instance_id} enters an estimated access zone`
      });
    }
  }

  return [...conflicts.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function hasErrorSeverityConflict(conflicts: PlannerConflict[]): boolean {
  // Even error-severity geometry remains advisory: this helper selects the red
  // visual treatment and never grants or denies permission to move or share.
  return conflicts.some((conflict) => conflict.severity === 'error');
}

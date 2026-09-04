import { z } from 'zod';
import { ConfidenceSchema, type Room } from '@nestometry/room-schema';

export const PLANNER_DOCUMENT_VERSION = 1 as const;
export const PLANNER_HISTORY_LIMIT = 100;
export const CUSTOM_BLOCK_LIMIT = 20;
export const SNAP_INCREMENT_M = 0.05;

const FiniteNumberSchema = z.number().finite();

export const PlannerVec3Schema = z
  .object({
    x: FiniteNumberSchema,
    y: FiniteNumberSchema,
    z: FiniteNumberSchema
  })
  .strict();

export const PlannerPoseSchema = z
  .object({
    position_m: PlannerVec3Schema,
    rotation_deg: PlannerVec3Schema
  })
  .strict();

export const PlannerInstanceSchema = z
  .object({
    id: z.string().min(1).max(120),
    object_id: z.string().min(1).max(120),
    label: z.string().min(1).max(200),
    role: z.enum(['movable', 'attached', 'built_in']),
    removable: z.boolean(),
    confidence: ConfidenceSchema,
    placement_basis: z.enum([
      'official_published_3d',
      'official_description',
      'visual_scale_estimate',
      'representative_assumption'
    ]),
    source_id: z.string().min(1).max(160),
    notes: z.string().max(4000),
    pose: PlannerPoseSchema,
    original_pose: PlannerPoseSchema
  })
  .strict();

export const CustomBlockSchema = z
  .object({
    id: z.string().min(1).max(120),
    label: z.string().min(1).max(80),
    dimensions_m: z
      .object({
        width: z.number().positive().max(20),
        depth: z.number().positive().max(20),
        height: z.number().positive().max(20)
      })
      .strict(),
    pose: PlannerPoseSchema,
    material: z.literal('translucent_neutral')
  })
  .strict();

export const SceneLayoutSchema = z
  .object({
    instances: z.array(PlannerInstanceSchema).max(200),
    removed_instance_ids: z.array(z.string().min(1).max(120)).max(200),
    custom_blocks: z.array(CustomBlockSchema).max(CUSTOM_BLOCK_LIMIT)
  })
  .strict();

const OrbitCameraSchema = z
  .object({
    position_m: PlannerVec3Schema,
    target_m: PlannerVec3Schema,
    fov_deg: z.number().positive().max(179)
  })
  .strict();

const PlanCameraSchema = z
  .object({
    position_m: PlannerVec3Schema,
    target_m: PlannerVec3Schema,
    orthographic_size_m: z.number().positive().max(100)
  })
  .strict();

export const SceneViewSchema = z
  .object({
    mode: z.enum(['3d', '2d', 'walk']),
    orbit_camera: OrbitCameraSchema,
    plan_camera: PlanCameraSchema,
    hidden_group_ids: z.array(z.string().min(1).max(120)).max(100),
    dimensions_visible: z.boolean(),
    staging_visible: z.boolean(),
    confidence_visible: z.boolean(),
    wall_fade_enabled: z.boolean(),
    units: z.enum(['imperial', 'metric']),
    snap_enabled: z.boolean(),
    render_profile: z.enum(['auto', 'low', 'balanced', 'high'])
  })
  .strict();

export const SceneDocumentSchema = z
  .object({
    document_version: z.literal(PLANNER_DOCUMENT_VERSION),
    room_id: z.string().min(1).max(160),
    scene_revision: z.string().min(1).max(160),
    layout: SceneLayoutSchema,
    view: SceneViewSchema
  })
  .strict()
  .superRefine((document, ctx) => {
    const instanceIds = new Set<string>();
    document.layout.instances.forEach((instance, index) => {
      if (instanceIds.has(instance.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'instances', index, 'id'],
          message: `duplicate planner instance id: ${instance.id}`
        });
      }
      instanceIds.add(instance.id);
    });

    const customIds = new Set<string>();
    document.layout.custom_blocks.forEach((block, index) => {
      if (instanceIds.has(block.id) || customIds.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'custom_blocks', index, 'id'],
          message: `duplicate planner object id: ${block.id}`
        });
      }
      customIds.add(block.id);
    });

    const removedIds = new Set<string>();
    document.layout.removed_instance_ids.forEach((id, index) => {
      const instance = document.layout.instances.find((candidate) => candidate.id === id);
      if (!instance || !instance.removable || removedIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['layout', 'removed_instance_ids', index],
          message: `removed instance must exist, be removable, and appear once: ${id}`
        });
      }
      removedIds.add(id);
    });
  });

export type PlannerVec3 = z.infer<typeof PlannerVec3Schema>;
export type PlannerPose = z.infer<typeof PlannerPoseSchema>;
export type PlannerInstance = z.infer<typeof PlannerInstanceSchema>;
export type CustomBlock = z.infer<typeof CustomBlockSchema>;
export type SceneLayout = z.infer<typeof SceneLayoutSchema>;
export type SceneView = z.infer<typeof SceneViewSchema>;
export type SceneDocument = z.infer<typeof SceneDocumentSchema>;

/** The schema-backed Room 0.3 record consumed by the planner adapter. */
export type CanonicalPlannerRoom = Room;

export type PlannerState = {
  document: SceneDocument;
  past: SceneLayout[];
  future: SceneLayout[];
};

export type PlannerAction =
  | { type: 'set-instance-pose'; instance_id: string; pose: PlannerPose }
  | { type: 'move-instance'; instance_id: string; position_m: PlannerVec3 }
  | { type: 'rotate-instance'; instance_id: string; direction?: 1 | -1 }
  | { type: 'remove-instance'; instance_id: string }
  | { type: 'restore-instance'; instance_id: string }
  | { type: 'add-custom-block'; block: CustomBlock }
  | { type: 'move-custom-block'; block_id: string; position_m: PlannerVec3 }
  | { type: 'rotate-custom-block'; block_id: string; direction?: 1 | -1 }
  | { type: 'update-custom-block'; block_id: string; block: CustomBlock }
  | { type: 'remove-custom-block'; block_id: string }
  | { type: 'reset-layout' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'load-document'; document: SceneDocument }
  | { type: 'set-mode'; mode: SceneView['mode'] }
  | { type: 'set-orbit-camera'; camera: SceneView['orbit_camera'] }
  | { type: 'set-plan-camera'; camera: SceneView['plan_camera'] }
  | { type: 'set-hidden-groups'; group_ids: string[] }
  | { type: 'set-dimensions-visible'; visible: boolean }
  | { type: 'set-staging-visible'; visible: boolean }
  | { type: 'set-confidence-visible'; visible: boolean }
  | { type: 'set-wall-fade-enabled'; enabled: boolean }
  | { type: 'set-units'; units: SceneView['units'] }
  | { type: 'set-snap-enabled'; enabled: boolean }
  | { type: 'set-render-profile'; profile: SceneView['render_profile'] };

export type CustomBlockPresetId = 'storage-bin' | 'mini-fridge' | 'bookcase' | 'table';

export const CUSTOM_BLOCK_PRESETS: Readonly<
  Record<CustomBlockPresetId, Pick<CustomBlock, 'label' | 'dimensions_m'>>
> = {
  'storage-bin': {
    label: 'storage bin',
    dimensions_m: { width: 0.6, depth: 0.4, height: 0.35 }
  },
  'mini-fridge': {
    label: 'mini fridge',
    dimensions_m: { width: 0.48, depth: 0.52, height: 0.84 }
  },
  bookcase: {
    label: 'bookcase',
    dimensions_m: { width: 0.76, depth: 0.31, height: 1.22 }
  },
  table: {
    label: 'table',
    dimensions_m: { width: 1.22, depth: 0.61, height: 0.76 }
  }
};

function cloneVec3(vector: PlannerVec3): PlannerVec3 {
  return { x: vector.x, y: vector.y, z: vector.z };
}

export function clonePlannerPose(pose: PlannerPose): PlannerPose {
  return {
    position_m: cloneVec3(pose.position_m),
    rotation_deg: cloneVec3(pose.rotation_deg)
  };
}

export function createSceneDocumentFromRoom(room: CanonicalPlannerRoom): SceneDocument {
  const scene = room.visualization_scene;
  const document: SceneDocument = {
    document_version: PLANNER_DOCUMENT_VERSION,
    room_id: room.room_id,
    scene_revision: scene.revision,
    layout: {
      instances: scene.instances.map((instance) => ({
        id: instance.id,
        object_id: instance.object_id,
        label: instance.label,
        role: instance.role,
        removable: instance.removable,
        confidence: instance.confidence,
        placement_basis: instance.placement_basis,
        source_id: instance.source_id,
        notes: instance.notes,
        pose: clonePlannerPose(instance.pose),
        original_pose: clonePlannerPose(instance.pose)
      })),
      removed_instance_ids: [],
      custom_blocks: []
    },
    view: {
      mode: '3d',
      orbit_camera: {
        position_m: cloneVec3(scene.cameras.orbit.position_m),
        target_m: cloneVec3(scene.cameras.orbit.target_m),
        fov_deg: scene.cameras.orbit.fov_deg
      },
      plan_camera: {
        position_m: cloneVec3(scene.cameras.plan.position_m),
        target_m: cloneVec3(scene.cameras.plan.target_m),
        orthographic_size_m: scene.cameras.plan.orthographic_size_m
      },
      hidden_group_ids: [],
      dimensions_visible: false,
      staging_visible: false,
      confidence_visible: false,
      wall_fade_enabled: true,
      units: 'imperial',
      snap_enabled: false,
      render_profile: 'auto'
    }
  };

  return SceneDocumentSchema.parse(document);
}

export function createPlannerState(document: SceneDocument): PlannerState {
  return { document: SceneDocumentSchema.parse(document), past: [], future: [] };
}

export function createCustomBlock(
  id: string,
  input: {
    label: string;
    dimensions_m: CustomBlock['dimensions_m'];
    position_m?: PlannerVec3;
    rotation_deg?: PlannerVec3;
  }
): CustomBlock {
  return CustomBlockSchema.parse({
    id,
    label: input.label.toLocaleLowerCase(),
    dimensions_m: input.dimensions_m,
    pose: {
      position_m: input.position_m ?? { x: 0, y: 0, z: 0 },
      rotation_deg: input.rotation_deg ?? { x: 0, y: 0, z: 0 }
    },
    material: 'translucent_neutral'
  });
}

export function createCustomBlockFromPreset(
  id: string,
  preset: CustomBlockPresetId,
  position_m: PlannerVec3 = { x: 0, y: 0, z: 0 }
): CustomBlock {
  return createCustomBlock(id, { ...CUSTOM_BLOCK_PRESETS[preset], position_m });
}

export function nextCustomBlockId(document: SceneDocument): string {
  const existing = new Set([
    ...document.layout.instances.map((instance) => instance.id),
    ...document.layout.custom_blocks.map((block) => block.id)
  ]);
  let index = 1;
  while (existing.has(`custom_${index}`)) index += 1;
  return `custom_${index}`;
}

export function snapMeters(value: number): number {
  const snapped = Math.round(value / SNAP_INCREMENT_M) * SNAP_INCREMENT_M;
  return Number(snapped.toFixed(8));
}

export function snapPlannerPose(pose: PlannerPose): PlannerPose {
  return {
    ...clonePlannerPose(pose),
    position_m: {
      x: snapMeters(pose.position_m.x),
      y: snapMeters(pose.position_m.y),
      z: snapMeters(pose.position_m.z)
    }
  };
}

function normalizedDegrees(value: number): number {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function samePose(left: PlannerPose, right: PlannerPose): boolean {
  return (
    left.position_m.x === right.position_m.x &&
    left.position_m.y === right.position_m.y &&
    left.position_m.z === right.position_m.z &&
    left.rotation_deg.x === right.rotation_deg.x &&
    left.rotation_deg.y === right.rotation_deg.y &&
    left.rotation_deg.z === right.rotation_deg.z
  );
}

/**
 * Whether the editable layout differs from the representative room record.
 * View preferences and command history are deliberately excluded: the
 * honesty notice describes furniture/custom-item placement only.
 */
export function isPlannerLayoutDirty(document: SceneDocument): boolean {
  return (
    document.layout.removed_instance_ids.length > 0 ||
    document.layout.custom_blocks.length > 0 ||
    document.layout.instances.some(
      (instance) => !samePose(instance.pose, instance.original_pose)
    )
  );
}

function commitLayout(state: PlannerState, layout: SceneLayout): PlannerState {
  if (layout === state.document.layout) return state;
  return {
    document: { ...state.document, layout },
    past: [...state.past, state.document.layout].slice(-PLANNER_HISTORY_LIMIT),
    future: []
  };
}

function updateView(state: PlannerState, view: SceneView): PlannerState {
  if (view === state.document.view) return state;
  return { ...state, document: { ...state.document, view } };
}

function poseForDocument(document: SceneDocument, pose: PlannerPose): PlannerPose {
  return document.view.snap_enabled ? snapPlannerPose(pose) : clonePlannerPose(pose);
}

export function isLayoutAction(action: PlannerAction): boolean {
  return [
    'set-instance-pose',
    'move-instance',
    'rotate-instance',
    'remove-instance',
    'restore-instance',
    'add-custom-block',
    'move-custom-block',
    'rotate-custom-block',
    'update-custom-block',
    'remove-custom-block',
    'reset-layout',
    'undo',
    'redo'
  ].includes(action.type);
}

export function plannerReducer(state: PlannerState, action: PlannerAction): PlannerState {
  const layout = state.document.layout;

  switch (action.type) {
    case 'set-instance-pose':
    case 'move-instance': {
      const index = layout.instances.findIndex((instance) => instance.id === action.instance_id);
      const instance = layout.instances[index];
      if (
        !instance ||
        instance.role !== 'movable' ||
        layout.removed_instance_ids.includes(instance.id)
      ) {
        return state;
      }
      const requestedPose =
        action.type === 'set-instance-pose'
          ? action.pose
          : { ...clonePlannerPose(instance.pose), position_m: action.position_m };
      const pose = poseForDocument(state.document, requestedPose);
      if (samePose(instance.pose, pose)) return state;
      const instances = [...layout.instances];
      instances[index] = { ...instance, pose };
      return commitLayout(state, { ...layout, instances });
    }

    case 'rotate-instance': {
      const index = layout.instances.findIndex((instance) => instance.id === action.instance_id);
      const instance = layout.instances[index];
      if (
        !instance ||
        instance.role !== 'movable' ||
        layout.removed_instance_ids.includes(instance.id)
      ) {
        return state;
      }
      const direction = action.direction ?? 1;
      const pose = clonePlannerPose(instance.pose);
      pose.rotation_deg.z = normalizedDegrees(pose.rotation_deg.z + direction * 90);
      const instances = [...layout.instances];
      instances[index] = { ...instance, pose };
      return commitLayout(state, { ...layout, instances });
    }

    case 'remove-instance': {
      const instance = layout.instances.find((candidate) => candidate.id === action.instance_id);
      if (!instance?.removable || layout.removed_instance_ids.includes(instance.id)) return state;
      return commitLayout(state, {
        ...layout,
        removed_instance_ids: [...layout.removed_instance_ids, instance.id]
      });
    }

    case 'restore-instance': {
      if (!layout.removed_instance_ids.includes(action.instance_id)) return state;
      return commitLayout(state, {
        ...layout,
        removed_instance_ids: layout.removed_instance_ids.filter((id) => id !== action.instance_id)
      });
    }

    case 'add-custom-block': {
      if (layout.custom_blocks.length >= CUSTOM_BLOCK_LIMIT) return state;
      if (
        layout.instances.some((instance) => instance.id === action.block.id) ||
        layout.custom_blocks.some((block) => block.id === action.block.id)
      ) {
        return state;
      }
      const block = CustomBlockSchema.parse(action.block);
      const pose = poseForDocument(state.document, block.pose);
      return commitLayout(state, {
        ...layout,
        custom_blocks: [...layout.custom_blocks, { ...block, pose }]
      });
    }

    case 'move-custom-block':
    case 'rotate-custom-block': {
      const index = layout.custom_blocks.findIndex((block) => block.id === action.block_id);
      const block = layout.custom_blocks[index];
      if (!block) return state;
      const pose = clonePlannerPose(block.pose);
      if (action.type === 'move-custom-block') {
        pose.position_m = cloneVec3(action.position_m);
      } else {
        pose.rotation_deg.z = normalizedDegrees(
          pose.rotation_deg.z + (action.direction ?? 1) * 90
        );
      }
      const committedPose = poseForDocument(state.document, pose);
      if (samePose(block.pose, committedPose)) return state;
      const customBlocks = [...layout.custom_blocks];
      customBlocks[index] = { ...block, pose: committedPose };
      return commitLayout(state, { ...layout, custom_blocks: customBlocks });
    }

    case 'update-custom-block': {
      const index = layout.custom_blocks.findIndex((block) => block.id === action.block_id);
      if (index === -1 || action.block.id !== action.block_id) return state;
      const block = CustomBlockSchema.parse(action.block);
      const customBlocks = [...layout.custom_blocks];
      customBlocks[index] = {
        ...block,
        label: block.label.toLocaleLowerCase(),
        pose: poseForDocument(state.document, block.pose)
      };
      if (JSON.stringify(customBlocks[index]) === JSON.stringify(layout.custom_blocks[index])) {
        return state;
      }
      return commitLayout(state, { ...layout, custom_blocks: customBlocks });
    }

    case 'remove-custom-block': {
      if (!layout.custom_blocks.some((block) => block.id === action.block_id)) return state;
      return commitLayout(state, {
        ...layout,
        custom_blocks: layout.custom_blocks.filter((block) => block.id !== action.block_id)
      });
    }

    case 'reset-layout': {
      const resetLayout: SceneLayout = {
        instances: layout.instances.map((instance) => ({
          ...instance,
          pose: clonePlannerPose(instance.original_pose)
        })),
        removed_instance_ids: [],
        custom_blocks: []
      };
      const alreadyReset =
        layout.removed_instance_ids.length === 0 &&
        layout.custom_blocks.length === 0 &&
        layout.instances.every((instance) => samePose(instance.pose, instance.original_pose));
      return alreadyReset ? state : commitLayout(state, resetLayout);
    }

    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        document: { ...state.document, layout: previous },
        past: state.past.slice(0, -1),
        future: [state.document.layout, ...state.future].slice(0, PLANNER_HISTORY_LIMIT)
      };
    }

    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        document: { ...state.document, layout: next },
        past: [...state.past, state.document.layout].slice(-PLANNER_HISTORY_LIMIT),
        future: state.future.slice(1)
      };
    }

    case 'load-document':
      return createPlannerState(action.document);

    case 'set-mode':
      return action.mode === state.document.view.mode
        ? state
        : updateView(state, { ...state.document.view, mode: action.mode });
    case 'set-orbit-camera':
      return updateView(state, { ...state.document.view, orbit_camera: action.camera });
    case 'set-plan-camera':
      return updateView(state, { ...state.document.view, plan_camera: action.camera });
    case 'set-hidden-groups': {
      const groupIds = [...new Set(action.group_ids)].sort();
      return updateView(state, { ...state.document.view, hidden_group_ids: groupIds });
    }
    case 'set-dimensions-visible':
      return updateView(state, { ...state.document.view, dimensions_visible: action.visible });
    case 'set-staging-visible':
      return updateView(state, { ...state.document.view, staging_visible: action.visible });
    case 'set-confidence-visible':
      return updateView(state, { ...state.document.view, confidence_visible: action.visible });
    case 'set-wall-fade-enabled':
      return updateView(state, { ...state.document.view, wall_fade_enabled: action.enabled });
    case 'set-units':
      return updateView(state, { ...state.document.view, units: action.units });
    case 'set-snap-enabled':
      return updateView(state, { ...state.document.view, snap_enabled: action.enabled });
    case 'set-render-profile':
      return updateView(state, { ...state.document.view, render_profile: action.profile });
  }
}

/**
 * Restores mutable state from a compatible save/share while retaining canonical
 * roles, labels, provenance, and original poses from the current room record.
 */
export function reconcileDocumentWithCanonical(
  canonical: SceneDocument,
  candidate: SceneDocument
): SceneDocument | null {
  const parsedCandidate = SceneDocumentSchema.safeParse(candidate);
  if (!parsedCandidate.success) return null;
  const savedDocument = parsedCandidate.data;

  if (
    savedDocument.room_id !== canonical.room_id ||
    savedDocument.scene_revision !== canonical.scene_revision
  ) {
    return null;
  }

  // A saved/share document may change mutable poses, inventory, custom
  // blocks, and view state, but it cannot redefine the canonical inventory.
  // Requiring an exact id set also closes a subtle collision: a crafted,
  // otherwise schema-valid candidate could omit a canonical instance and use
  // that now-vacant id for a custom block. Reintroducing the canonical
  // instance below would then make the reconciled document invalid.
  const canonicalIds = new Set(
    canonical.layout.instances.map((instance) => instance.id)
  );
  const savedIds = new Set(
    savedDocument.layout.instances.map((instance) => instance.id)
  );
  if (
    canonicalIds.size !== savedIds.size ||
    [...canonicalIds].some((id) => !savedIds.has(id)) ||
    savedDocument.layout.custom_blocks.some((block) => canonicalIds.has(block.id))
  ) {
    return null;
  }

  const candidateById = new Map(
    savedDocument.layout.instances.map((instance) => [instance.id, instance] as const)
  );
  const instances = canonical.layout.instances.map((canonicalInstance) => {
    const saved = candidateById.get(canonicalInstance.id);
    return {
      ...canonicalInstance,
      pose:
        saved && canonicalInstance.role === 'movable'
          ? clonePlannerPose(saved.pose)
          : clonePlannerPose(canonicalInstance.pose),
      original_pose: clonePlannerPose(canonicalInstance.original_pose)
    };
  });
  const removableIds = new Set(
    instances.filter((instance) => instance.removable).map((instance) => instance.id)
  );

  const reconciled = SceneDocumentSchema.safeParse({
    ...canonical,
    layout: {
      instances,
      removed_instance_ids: savedDocument.layout.removed_instance_ids.filter((id) =>
        removableIds.has(id)
      ),
      custom_blocks: savedDocument.layout.custom_blocks.slice(0, CUSTOM_BLOCK_LIMIT)
    },
    view: {
      ...savedDocument.view,
      // Walk requires a new user gesture for pointer lock and is never restored.
      mode: savedDocument.view.mode === 'walk' ? '3d' : savedDocument.view.mode
    }
  });
  return reconciled.success ? reconciled.data : null;
}

import type { SceneColliderManifest } from './plannerCollisions';
import {
  SceneDocumentSchema,
  type PlannerInstance,
  type SceneDocument
} from './plannerDocument';

function instance(
  id: string,
  role: PlannerInstance['role'],
  removable: boolean,
  x: number
): PlannerInstance {
  const pose = {
    position_m: { x, y: 0, z: 0 },
    rotation_deg: { x: 0, y: 0, z: 0 }
  };
  return {
    id,
    object_id: `${id}_object`,
    label: id.replaceAll('_', ' '),
    role,
    removable,
    confidence: 'medium',
    placement_basis: 'official_published_3d',
    source_id: 'official_source',
    notes: 'representative placement',
    pose: structuredClone(pose),
    original_pose: structuredClone(pose)
  };
}

export function plannerTestDocument(): SceneDocument {
  return SceneDocumentSchema.parse({
    document_version: 1,
    room_id: 'unit-3-test',
    scene_revision: 'scene-test-1',
    layout: {
      instances: [
        instance('chair_1', 'movable', true, -0.75),
        instance('desk_1', 'movable', true, 0.75),
        instance('closet_1', 'built_in', false, 1.65)
      ],
      removed_instance_ids: [],
      custom_blocks: []
    },
    view: {
      mode: '3d',
      orbit_camera: {
        position_m: { x: 4, y: -4, z: 3 },
        target_m: { x: 0, y: 0, z: 0.8 },
        fov_deg: 45
      },
      plan_camera: {
        position_m: { x: 0, y: 0, z: 8 },
        target_m: { x: 0, y: 0, z: 0 },
        orthographic_size_m: 5
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
  });
}

export function plannerTestManifest(): SceneColliderManifest {
  return {
    manifest_version: 1,
    room_id: 'unit-3-test',
    scene_revision: 'scene-test-1',
    asset_sha256: 'a'.repeat(64),
    instances: [
      {
        instance_id: 'chair_1',
        colliders: [
          {
            id: 'chair_box',
            center_m: { x: 0, y: 0, z: 0.5 },
            size_m: { width: 0.5, depth: 0.5, height: 1 }
          }
        ]
      },
      {
        instance_id: 'desk_1',
        colliders: [
          {
            id: 'desk_box',
            center_m: { x: 0, y: 0, z: 0.5 },
            size_m: { width: 1, depth: 0.6, height: 1 }
          }
        ]
      },
      {
        instance_id: 'closet_1',
        colliders: [
          {
            id: 'closet_box',
            center_m: { x: 0, y: 0, z: 1 },
            size_m: { width: 0.6, depth: 0.6, height: 2 }
          }
        ]
      }
    ]
  };
}

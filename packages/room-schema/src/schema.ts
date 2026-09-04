import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low', 'unknown']);
export const DimensionStatusSchema = z.enum(['verified', 'estimated', 'unknown', 'not_applicable']);
export const AccuracyTierSchema = z.enum([
  'conceptual',
  'official_representative',
  'measured_representative',
  'drawing_verified',
  'room_specific_digital_twin'
]);

export const SourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z
    .string()
    .url()
    .refine((url) => new URL(url).protocol === 'https:', {
      message: 'Public source URLs must use HTTPS.'
    })
    .optional(),
  source_type: z.enum([
    'official_housing_page',
    'official_video',
    'virtual_tour_reference',
    'facilities_drawing',
    'authorized_measurement',
    'vendor_page',
    'student_reference',
    'other'
  ]),
  used_for: z.array(z.enum(['layout', 'furniture', 'dimension', 'material', 'warning', 'visual_reference'])),
  confidence: ConfidenceSchema,
  notes: z.string().optional()
});

export const DimensionSchema = z.object({
  value_m: z.number().positive().nullable(),
  status: DimensionStatusSchema,
  estimated: z.boolean(),
  source_id: z.string().nullable(),
  confidence: ConfidenceSchema,
  notes: z.string().optional()
}).superRefine((dim, ctx) => {
  if (dim.status === 'verified' && (dim.value_m === null || !dim.source_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Verified dimensions require a numeric value_m and source_id.'
    });
  }
  if (dim.value_m === null && dim.status !== 'unknown') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Null dimensions should use status unknown.'
    });
  }
});

// Geometry needs a numeric shell even while the public, measurement-backed
// room_shell remains unknown. These values are intentionally stricter than a
// general Dimension: they may only be sourced, explicitly estimated values.
export const VisualizationDimensionSchema = z.object({
  value_m: z.number().positive(),
  uncertainty_m: z.number().positive(),
  status: z.literal('estimated'),
  estimated: z.literal(true),
  source_id: z.string().min(1),
  confidence: ConfidenceSchema,
  notes: z.string().min(1)
});

export const Vec3Schema = z.object({
  x: DimensionSchema,
  y: DimensionSchema,
  z: DimensionSchema
});

export const LayoutConstraintSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  source_id: z.string().nullable(),
  confidence: ConfidenceSchema,
  relation_type: z.enum([
    'adjacent_to',
    'opposite',
    'left_of',
    'right_of',
    'under',
    'above',
    'near',
    'faces',
    'centered_on',
    'inferred'
  ]),
  subject: z.string().min(1),
  object: z.string().min(1)
});

export const RoomObjectSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'room_shell',
    'floor',
    'wall',
    'ceiling',
    'door',
    'window',
    'closet',
    'twin_xl_bed',
    'loft_bed',
    'bunk_bed',
    'desk',
    'chair',
    'dresser',
    'microchill',
    'bathroom_fixture',
    'label',
    'other'
  ]),
  label: z.string().min(1),
  count: z.number().int().positive().default(1),
  dimensions_m: Vec3Schema.optional(),
  position_hint: z.string().optional(),
  source_id: z.string().nullable(),
  confidence: ConfidenceSchema,
  dimension_status: DimensionStatusSchema,
  notes: z.string().optional()
});

export const NeedMeasurementSchema = z.object({
  id: z.string().min(1),
  item: z.string().min(1),
  why_needed: z.string().min(1),
  best_source: z.enum(['facilities_drawing', 'housing_spec', 'authorized_manual_measurement', 'authorized_scan', 'vendor_spec', 'other']),
  priority: z.enum(['high', 'medium', 'low'])
});

const ShellDimensionsSchema = z.object({
  width: DimensionSchema,
  depth: DimensionSchema,
  height: DimensionSchema
});

const VisualizationShellSchema = z.object({
  width: VisualizationDimensionSchema,
  depth: VisualizationDimensionSchema,
  height: VisualizationDimensionSchema
});

export const NumericVec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite()
});

export const NumericVec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite()
});

export const ScenePoseSchema = z.object({
  position_m: NumericVec3Schema,
  rotation_deg: z.object({
    x: z.literal(0),
    y: z.literal(0),
    z: z.number().int().multipleOf(90)
  })
});

export const SceneInstanceSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message: 'Scene instance ids must be lowercase snake_case.'
  }),
  object_id: z.string().min(1),
  instance_index: z.number().int().positive(),
  label: z.string().min(1),
  role: z.enum(['movable', 'attached', 'built_in']),
  removable: z.boolean(),
  pose: ScenePoseSchema,
  source_id: z.string().min(1),
  confidence: ConfidenceSchema,
  placement_basis: z.enum([
    'official_published_3d',
    'official_description',
    'visual_scale_estimate',
    'representative_assumption'
  ]),
  notes: z.string().min(1)
}).superRefine((instance, ctx) => {
  if (instance.removable && instance.role !== 'movable') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Only movable scene instances may be removable.',
      path: ['removable']
    });
  }
});

export const SceneSurfaceSchema = z.object({
  id: z.enum(['floor', 'ceiling', 'wall_entry', 'wall_window', 'wall_left', 'wall_right']),
  kind: z.enum(['floor', 'ceiling', 'wall']),
  pose: ScenePoseSchema,
  size_m: z.object({
    x: z.number().positive(),
    y: z.number().positive(),
    z: z.number().positive()
  }),
  fade_behavior: z.enum(['never', 'smart_orbit']),
  source_id: z.string().min(1),
  confidence: ConfidenceSchema,
  notes: z.string().min(1)
});

const RectangleClearanceGeometrySchema = z.object({
  shape: z.literal('rectangle'),
  center_m: NumericVec2Schema,
  size_m: z.object({
    width: z.number().positive(),
    depth: z.number().positive()
  }),
  rotation_deg: z.number().int().multipleOf(90)
});

const SectorClearanceGeometrySchema = z.object({
  shape: z.literal('sector'),
  center_m: NumericVec2Schema,
  radius_m: z.number().positive(),
  start_angle_deg: z.number().finite(),
  end_angle_deg: z.number().finite()
}).refine((sector) => sector.start_angle_deg !== sector.end_angle_deg, {
  message: 'A sector clearance zone must have a non-zero angle.'
});

export const ClearanceZoneSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, {
    message: 'Clearance zone ids must be lowercase snake_case.'
  }),
  type: z.enum(['door_swing', 'circulation']),
  anchor_instance_id: z.string().min(1).nullable(),
  geometry: z.discriminatedUnion('shape', [
    RectangleClearanceGeometrySchema,
    SectorClearanceGeometrySchema
  ]),
  source_id: z.string().min(1),
  confidence: ConfidenceSchema,
  estimated: z.literal(true),
  notes: z.string().min(1)
});

export const VisualizationSceneSchema = z.object({
  revision: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, {
    message: 'Scene revisions must be stable lowercase identifiers.'
  }),
  coordinate_system: z.object({
    units: z.literal('meters'),
    origin: z.literal('room_center_floor'),
    handedness: z.literal('right_handed'),
    axes: z.object({
      x: z.literal('right'),
      y: z.literal('toward_window'),
      z: z.literal('up')
    })
  }),
  cameras: z.object({
    orbit: z.object({
      position_m: NumericVec3Schema,
      target_m: NumericVec3Schema,
      fov_deg: z.number().min(10).max(120)
    }),
    plan: z.object({
      position_m: NumericVec3Schema,
      target_m: NumericVec3Schema,
      orthographic_size_m: z.number().positive()
    })
  }),
  surfaces: z.array(SceneSurfaceSchema).length(6),
  instances: z.array(SceneInstanceSchema).min(1),
  clearance_zones: z.array(ClearanceZoneSchema).min(1)
});

export const RoomSchema = z.object({
  schema_version: z.literal('0.3.0'),
  room_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Room ids must be lowercase kebab-case.'
  }),
  school: z.literal('UC Berkeley'),
  hall: z.string().min(1),
  building: z.string().nullable(),
  room_type: z.string().min(1),
  display_name: z.string().min(1),
  accuracy_tier: AccuracyTierSchema,
  units: z.literal('meters'),
  representative_model: z.boolean(),
  variation_warning: z.string().nullable(),
  sources: z.array(SourceSchema).min(1),
  room_shell: ShellDimensionsSchema,
  visualization_shell: VisualizationShellSchema,
  visualization_scene: VisualizationSceneSchema,
  layout_constraints: z.array(LayoutConstraintSchema),
  objects: z.array(RoomObjectSchema),
  needs_measurement: z.array(NeedMeasurementSchema),
  public_notes: z.array(z.string()),
  // Despite the legacy name, complete room records are bundled into the
  // public client. This field may contain maintainer context, never secrets or
  // private source notes.
  internal_notes: z.array(z.string()).optional()
}).superRefine((room, ctx) => {
  const sourceIds = new Set<string>();
  const objectIds = new Set<string>();

  room.sources.forEach((source, index) => {
    if (sourceIds.has(source.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate source id: ${source.id}`,
        path: ['sources', index, 'id']
      });
    }
    sourceIds.add(source.id);
  });

  const checkSource = (sourceId: string | null, path: (string | number)[]) => {
    if (sourceId !== null && !sourceIds.has(sourceId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown source_id: ${sourceId}`,
        path
      });
    }
  };

  for (const axis of ['width', 'depth', 'height'] as const) {
    checkSource(room.room_shell[axis].source_id, ['room_shell', axis, 'source_id']);
    checkSource(room.visualization_shell[axis].source_id, [
      'visualization_shell',
      axis,
      'source_id'
    ]);
  }

  room.layout_constraints.forEach((constraint, index) => {
    checkSource(constraint.source_id, ['layout_constraints', index, 'source_id']);
  });

  room.objects.forEach((object, objectIndex) => {
    if (objectIds.has(object.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate object id: ${object.id}`,
        path: ['objects', objectIndex, 'id']
      });
    }
    objectIds.add(object.id);
    checkSource(object.source_id, ['objects', objectIndex, 'source_id']);
    if (!object.dimensions_m) return;
    for (const axis of ['x', 'y', 'z'] as const) {
      checkSource(object.dimensions_m[axis].source_id, [
        'objects',
        objectIndex,
        'dimensions_m',
        axis,
        'source_id'
      ]);
    }
  });

  const instanceIds = new Set<string>();
  const instanceCounts = new Map<string, number>();
  const instanceIndexes = new Map<string, Set<number>>();
  room.visualization_scene.instances.forEach((instance, instanceIndex) => {
    if (instanceIds.has(instance.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate scene instance id: ${instance.id}`,
        path: ['visualization_scene', 'instances', instanceIndex, 'id']
      });
    }
    instanceIds.add(instance.id);
    checkSource(instance.source_id, [
      'visualization_scene',
      'instances',
      instanceIndex,
      'source_id'
    ]);

    const object = room.objects.find((candidate) => candidate.id === instance.object_id);
    if (!object) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown scene object_id: ${instance.object_id}`,
        path: ['visualization_scene', 'instances', instanceIndex, 'object_id']
      });
      return;
    }
    if (instance.instance_index > object.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `instance_index ${instance.instance_index} exceeds ${instance.object_id} count ${object.count}.`,
        path: ['visualization_scene', 'instances', instanceIndex, 'instance_index']
      });
    }
    const indexes = instanceIndexes.get(instance.object_id) ?? new Set<number>();
    if (indexes.has(instance.instance_index)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate instance_index ${instance.instance_index} for ${instance.object_id}.`,
        path: ['visualization_scene', 'instances', instanceIndex, 'instance_index']
      });
    }
    indexes.add(instance.instance_index);
    instanceIndexes.set(instance.object_id, indexes);
    instanceCounts.set(instance.object_id, (instanceCounts.get(instance.object_id) ?? 0) + 1);
  });

  room.objects.forEach((object, objectIndex) => {
    if (object.type === 'room_shell' || !object.dimensions_m) return;
    const count = instanceCounts.get(object.id) ?? 0;
    if (count !== object.count) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Scene must contain ${object.count} independent instance(s) for ${object.id}; found ${count}.`,
        path: ['objects', objectIndex, 'count']
      });
    }
  });

  const surfaceIds = new Set<string>();
  room.visualization_scene.surfaces.forEach((surface, surfaceIndex) => {
    if (surfaceIds.has(surface.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate scene surface id: ${surface.id}`,
        path: ['visualization_scene', 'surfaces', surfaceIndex, 'id']
      });
    }
    surfaceIds.add(surface.id);
    checkSource(surface.source_id, [
      'visualization_scene',
      'surfaces',
      surfaceIndex,
      'source_id'
    ]);
  });

  // Layout constraints may reference a declared room object/group, one exact
  // scene instance, or one named architectural surface. Free-form aggregate
  // names are rejected so evidence relationships cannot silently go stale.
  const constraintTargets = new Set([...objectIds, ...instanceIds, ...surfaceIds]);
  room.layout_constraints.forEach((constraint, constraintIndex) => {
    for (const key of ['subject', 'object'] as const) {
      if (!constraintTargets.has(constraint[key])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown layout constraint ${key}: ${constraint[key]}`,
          path: ['layout_constraints', constraintIndex, key]
        });
      }
    }
  });

  const clearanceIds = new Set<string>();
  room.visualization_scene.clearance_zones.forEach((zone, zoneIndex) => {
    if (clearanceIds.has(zone.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate clearance zone id: ${zone.id}`,
        path: ['visualization_scene', 'clearance_zones', zoneIndex, 'id']
      });
    }
    clearanceIds.add(zone.id);
    checkSource(zone.source_id, [
      'visualization_scene',
      'clearance_zones',
      zoneIndex,
      'source_id'
    ]);
    if (zone.anchor_instance_id !== null && !instanceIds.has(zone.anchor_instance_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown anchor_instance_id: ${zone.anchor_instance_id}`,
        path: ['visualization_scene', 'clearance_zones', zoneIndex, 'anchor_instance_id']
      });
    }
    if (zone.type === 'door_swing' && zone.geometry.shape !== 'sector') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Door-swing clearance zones must use sector geometry.',
        path: ['visualization_scene', 'clearance_zones', zoneIndex, 'geometry']
      });
    }
    if (zone.type === 'circulation' && zone.geometry.shape !== 'rectangle') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Circulation clearance zones must use rectangle geometry.',
        path: ['visualization_scene', 'clearance_zones', zoneIndex, 'geometry']
      });
    }
  });
});

export type Room = z.infer<typeof RoomSchema>;
export type RoomObject = z.infer<typeof RoomObjectSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type NumericVec2 = z.infer<typeof NumericVec2Schema>;
export type NumericVec3 = z.infer<typeof NumericVec3Schema>;
export type ScenePose = z.infer<typeof ScenePoseSchema>;
export type SceneInstance = z.infer<typeof SceneInstanceSchema>;
export type SceneSurface = z.infer<typeof SceneSurfaceSchema>;
export type ClearanceZone = z.infer<typeof ClearanceZoneSchema>;
export type VisualizationScene = z.infer<typeof VisualizationSceneSchema>;

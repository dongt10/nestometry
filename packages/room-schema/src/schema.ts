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

export const RoomSchema = z.object({
  schema_version: z.literal('0.2.0'),
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
  layout_constraints: z.array(LayoutConstraintSchema),
  objects: z.array(RoomObjectSchema),
  needs_measurement: z.array(NeedMeasurementSchema),
  public_notes: z.array(z.string()),
  internal_notes: z.array(z.string()).optional()
}).superRefine((room, ctx) => {
  const sourceIds = new Set<string>();

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
});

export type Room = z.infer<typeof RoomSchema>;
export type RoomObject = z.infer<typeof RoomObjectSchema>;
export type Source = z.infer<typeof SourceSchema>;

/**
 * A single dimension value from the room schema (room_shell.width, objects[].dimensions_m.x, etc.).
 */
export type Dimension = {
  value_m: number | null;
  status: 'verified' | 'estimated' | 'unknown' | 'not_applicable';
  estimated: boolean;
  source_id: string | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  notes?: string;
};

export type DimensionBadge = 'verified' | 'estimated' | 'unknown';

export type FormattedDimension = {
  /** Text to render for the numeric slot. Never a bare number for unknown values. */
  text: string;
  badge: DimensionBadge;
  /** True when this value must not be presented as an exact measurement. */
  approximate: boolean;
};

/**
 * Apply the non-negotiable display rules for a schema dimension:
 * - null value or status 'unknown' -> em dash + "unknown" badge (NEVER a number)
 * - status 'estimated' or estimated:true -> "~<value> m" + "estimated" badge
 * - status 'verified' -> plain "<value> m"
 */
export function formatDimension(dim: Dimension | undefined | null): FormattedDimension {
  if (!dim || dim.value_m === null || dim.status === 'unknown' || dim.status === 'not_applicable') {
    return { text: '—', badge: 'unknown', approximate: true };
  }
  if (dim.status === 'estimated' || dim.estimated) {
    return { text: `~${dim.value_m} m`, badge: 'estimated', approximate: true };
  }
  // verified
  return { text: `${dim.value_m} m`, badge: 'verified', approximate: false };
}

/**
 * Numeric value in meters only when it is safe to use for layout geometry.
 * Returns null for unknown/not_applicable so callers fall back to placeholders.
 */
export function numericMeters(dim: Dimension | undefined | null): number | null {
  if (!dim || dim.value_m === null) return null;
  if (dim.status === 'unknown' || dim.status === 'not_applicable') return null;
  return dim.value_m;
}

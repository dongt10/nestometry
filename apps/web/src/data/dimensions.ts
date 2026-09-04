/**
 * A single dimension value from the room schema (room_shell.width, objects[].dimensions_m.x, etc.).
 */
export type Dimension = {
  value_m: number | null;
  uncertainty_m?: number;
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

export type UnitSystem = 'imperial' | 'metric';

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
    const uncertainty = dim.uncertainty_m
      ? ` ± ${Number(dim.uncertainty_m.toFixed(4))} m`
      : '';
    return { text: `~${dim.value_m} m${uncertainty}`, badge: 'estimated', approximate: true };
  }
  // verified
  return { text: `${dim.value_m} m`, badge: 'verified', approximate: false };
}

function metersToFeetAndInches(valueM: number): string {
  const totalInches = Math.round(valueM * 39.3700787402);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return inches === 0 ? `${feet} ft` : `${feet} ft ${inches} in`;
}

/** Format a dimension in the planner's selected display units. */
export function formatDimensionForUnit(
  dim: Dimension | undefined | null,
  units: UnitSystem
): FormattedDimension {
  const base = formatDimension(dim);
  if (!dim || dim.value_m === null || base.badge === 'unknown') return base;
  const value =
    units === 'imperial'
      ? metersToFeetAndInches(dim.value_m)
      : `${Number(dim.value_m.toFixed(3))} m`;
  const uncertainty = dim.uncertainty_m
    ? ` ± ${units === 'imperial'
      ? metersToFeetAndInches(dim.uncertainty_m)
      : `${Number(dim.uncertainty_m.toFixed(3))} m`}`
    : '';
  return {
    ...base,
    text: `${base.approximate ? '~' : ''}${value}${uncertainty}`
  };
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

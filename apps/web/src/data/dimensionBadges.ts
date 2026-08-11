import type { Room, RoomObject } from './assetManifest';
import { formatDimension } from './dimensions';
import type { FurnitureGroup } from './furnitureGroups';

/**
 * Pill label for a furniture group's headline dimension. We surface the
 * x-dimension (width) as the single anchored badge, following the same honesty
 * rules as the DimensionList: estimated -> "~2.03 m · est.", unknown/null ->
 * "unknown". A number is NEVER shown for an unverified-as-unknown value.
 */
export type BadgeLabel = {
  text: string;
  /** True when this value must not be read as an exact measurement. */
  approximate: boolean;
};

/** Map a furniture group prefix to the schema object type it represents. */
const GROUP_TO_TYPE: Partial<Record<FurnitureGroup, string>> = {
  twin_xl_bed: 'twin_xl_bed',
  loft_bed: 'loft_bed',
  bunk_bed: 'bunk_bed',
  microchill: 'microchill',
  dresser: 'dresser',
  closet: 'closet',
  window: 'window',
  desk: 'desk',
  chair: 'chair',
  door: 'door'
};

function objectForGroup(room: Room, group: FurnitureGroup): RoomObject | undefined {
  if (group === 'bookshelf') {
    return room.objects.find((obj) => obj.id === 'bookshelf_group');
  }
  const type = GROUP_TO_TYPE[group];
  if (!type) return undefined;
  return room.objects.find((obj) => obj.type === type);
}

/**
 * Build the honest badge label for a group's width, or null when the group has
 * no matching schema object. Reuses formatDimension so estimated/unknown
 * handling stays identical to the DimensionList.
 */
export function groupBadgeLabel(room: Room, group: FurnitureGroup): BadgeLabel | null {
  const obj = objectForGroup(room, group);
  if (!obj) return null;
  const formatted = formatDimension(obj.dimensions_m?.x);
  if (formatted.badge === 'unknown') {
    return { text: 'unknown', approximate: true };
  }
  if (formatted.badge === 'estimated') {
    // "~2.03 m" -> "~2.03 m · est."
    return { text: `${formatted.text} · est.`, approximate: true };
  }
  // verified
  return { text: formatted.text, approximate: false };
}

/**
 * Room-shell badge labels for the three shell axes. All are `unknown` in the
 * current schema (room_shell width/depth/height are null), so we show the honest
 * label — never a number.
 */
export function shellBadgeLabels(room: Room): { key: string; label: string }[] {
  const shell = room.room_shell;
  const axes: { key: string; dim: Parameters<typeof formatDimension>[0] }[] = [
    { key: 'width', dim: shell.width },
    { key: 'depth', dim: shell.depth },
    { key: 'height', dim: shell.height }
  ];
  return axes.map(({ key, dim }) => {
    const formatted = formatDimension(dim);
    if (formatted.badge === 'unknown') {
      return { key, label: `${key}: unknown` };
    }
    if (formatted.badge === 'estimated') {
      return { key, label: `${key}: ${formatted.text} · est.` };
    }
    return { key, label: `${key}: ${formatted.text}` };
  });
}

import type { Object3D } from 'three';

/**
 * Furniture group prefixes that Blender export node names begin with, e.g.
 * `loft_bed_1_estimated`, `desk_1_estimated`.
 * Longest-first so multi-word prefixes match before any shorter overlap.
 */
export const FURNITURE_GROUP_PREFIXES = [
  'twin_xl_bed',
  'loft_bed',
  'bunk_bed',
  'microchill',
  'bookshelf',
  'dresser',
  'closet',
  'window',
  'decor',
  'desk',
  'chair',
  'door'
] as const;

export type FurnitureGroup = (typeof FURNITURE_GROUP_PREFIXES)[number];

/**
 * The illustrative-staging group. Its nodes carry glTF extras (`node.userData`)
 * flagging them decorative, and bed-dressing/desk items additionally carry an
 * `attached_to` prefix so their visibility can follow the furniture they sit on.
 * This group is a master switch in the UI, not a normal furniture chip.
 */
export const DECOR_GROUP = 'decor' satisfies FurnitureGroup;

/** Human-readable labels for the toggle checkboxes. */
export const FURNITURE_GROUP_LABELS: Record<FurnitureGroup, string> = {
  twin_xl_bed: 'twin xl beds',
  loft_bed: 'loft bed',
  bunk_bed: 'bunk bed',
  microchill: 'microchill',
  bookshelf: 'bookshelves',
  dresser: 'dressers',
  closet: 'closets',
  window: 'windows',
  decor: 'decor',
  desk: 'desks',
  chair: 'chairs',
  door: 'doors'
};

/**
 * Groups a student may reposition in Arrange mode. Closets are built-ins,
 * doors/windows live inside walls, and decor/shell nodes are not furniture —
 * none of those move.
 */
export const MOVABLE_FURNITURE_GROUPS: ReadonlySet<FurnitureGroup> = new Set<FurnitureGroup>([
  'twin_xl_bed',
  'loft_bed',
  'bunk_bed',
  'microchill',
  'dresser',
  'desk',
  'chair'
]);

/**
 * Instance prefix for a movable furniture node, e.g. `desk_2_top` → `desk_2`,
 * `chair_1_base_spoke_3` → `chair_1`. Null for anything that is not a numbered
 * node of a movable group.
 */
export function movableInstanceForNodeName(name: string): string | null {
  const group = groupForNodeName(name);
  if (!group || !MOVABLE_FURNITURE_GROUPS.has(group)) return null;
  const match = name.slice(group.length).match(/^_(\d+)(?:_|$)/);
  return match ? `${group}_${match[1]}` : null;
}

/**
 * Which movable instance a decor node rides along with in Arrange mode:
 *
 * 1. Bed dressing embeds the exact instance name (`decor_duvet_loft_bed_1_fold`,
 *    `decor_pillow_twin_xl_bed_2_a`) — matched at a `_`/end boundary.
 * 2. Numbered desk staging `decor_notebook_N` / `decor_mug_N` sits on `desk_N`.
 * 3. The unnumbered desk set (lamp parts, laptop, books, the plain mug) is
 *    placed on desk_1 by the generator.
 *
 * Freestanding decor (rug, curtains, wastebasket, mirrors) maps to nothing and
 * stays put.
 */
export function decorRideAlongInstance(
  name: string,
  instances: ReadonlySet<string>
): string | null {
  if (!name.startsWith(`${DECOR_GROUP}_`)) return null;
  for (const instance of instances) {
    const idx = name.indexOf(instance);
    if (idx === -1) continue;
    const end = idx + instance.length;
    if (end === name.length || name[end] === '_') return instance;
  }
  const numbered = name.match(/^decor_(?:notebook|mug)_(\d+)$/);
  if (numbered) {
    const desk = `desk_${numbered[1]}`;
    return instances.has(desk) ? desk : null;
  }
  if (
    name.startsWith('decor_lamp_') ||
    name === 'decor_laptop' ||
    name.startsWith('decor_book_') ||
    name === 'decor_mug'
  ) {
    return instances.has('desk_1') ? 'desk_1' : null;
  }
  return null;
}

/**
 * Scan the scene's TOP-LEVEL children and group every movable furniture node by
 * instance prefix (`desk_2` → all `desk_2_*` nodes), then attach the decor that
 * rides with each instance. Top-level only on purpose: dragging translates
 * whole root nodes, and everything movable (furniture parts + their decor) is a
 * scene-root child in these GLBs — wall-parented nodes (door/window/curtains)
 * are exactly the ones that must not move.
 */
export function collectArrangeInstances(root: Object3D): Map<string, Object3D[]> {
  const map = new Map<string, Object3D[]>();
  for (const node of root.children) {
    const instance = movableInstanceForNodeName(node.name);
    if (!instance) continue;
    const nodes = map.get(instance);
    if (nodes) {
      nodes.push(node);
    } else {
      map.set(instance, [node]);
    }
  }
  const known = new Set(map.keys());
  for (const node of root.children) {
    const instance = decorRideAlongInstance(node.name, known);
    if (instance) map.get(instance)?.push(node);
  }
  return map;
}

/** Match a node name to its furniture group prefix, or null if none applies. */
export function groupForNodeName(name: string): FurnitureGroup | null {
  for (const prefix of FURNITURE_GROUP_PREFIXES) {
    if (name === prefix || name.startsWith(`${prefix}_`)) {
      return prefix;
    }
  }
  return null;
}

/**
 * Walk the whole scene graph and group nodes by furniture prefix. New GLBs parent
 * door/window/trim assemblies under wall nodes, so a flat top-level scan misses
 * them — we recurse instead. When a node matches a group we record it and stop
 * descending into it, so a matched furniture node and its own children can never
 * both be collected: each node lands in exactly one group. Toggling still works
 * because the recorded node is the furniture root (setting `node.visible` on it
 * hides the whole assembly, even when it sits under a wall).
 */
export function collectFurnitureGroups(root: Object3D | Object3D[]): Map<FurnitureGroup, Object3D[]> {
  const groups = new Map<FurnitureGroup, Object3D[]>();
  const roots = Array.isArray(root) ? root : [root];

  const visit = (node: Object3D) => {
    const group = groupForNodeName(node.name);
    if (group) {
      const existing = groups.get(group);
      if (existing) {
        existing.push(node);
      } else {
        groups.set(group, [node]);
      }
      // Don't descend into a matched furniture root — its parts belong to it.
      return;
    }
    for (const child of node.children) visit(child);
  };

  for (const node of roots) visit(node);
  return groups;
}

/**
 * Apply the two independent visibility controls as one operation so an
 * inventory update can never re-show a hidden layer (or vice versa). Decor
 * attached to removed furniture is hidden with its parent even though the GLB
 * stores those staging meshes as separate top-level nodes.
 */
export function applyFurnitureVisibility(
  groups: ReadonlyMap<FurnitureGroup, readonly Object3D[]>,
  hiddenGroups: ReadonlySet<FurnitureGroup>,
  removedInstanceIds: ReadonlySet<string>,
  knownInstanceIds: ReadonlySet<string>
): void {
  const decorHidden = hiddenGroups.has(DECOR_GROUP);
  for (const [group, nodes] of groups) {
    if (group === DECOR_GROUP) {
      for (const node of nodes) {
        const attachedTo = node.userData?.attached_to;
        const attachedGroup =
          typeof attachedTo === 'string'
            ? groupForNodeName(attachedTo) ?? (attachedTo as FurnitureGroup)
            : null;
        const attachedInstance = decorRideAlongInstance(node.name, knownInstanceIds);
        node.visible =
          !decorHidden &&
          !(attachedGroup && hiddenGroups.has(attachedGroup)) &&
          !(attachedInstance && removedInstanceIds.has(attachedInstance));
      }
      continue;
    }

    const groupVisible = !hiddenGroups.has(group);
    for (const node of nodes) {
      const instanceId =
        typeof node.userData?.instance_id === 'string'
          ? node.userData.instance_id
          : node.name;
      node.visible = groupVisible && !removedInstanceIds.has(instanceId);
    }
  }
}

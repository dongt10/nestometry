import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  applyFurnitureVisibility,
  collectFurnitureGroups,
  type FurnitureGroup
} from './furnitureGroups';

function fixture() {
  const scene = new Object3D();
  const desk = new Object3D();
  desk.name = 'desk_1';
  desk.userData.instance_id = 'desk_1';
  const chair = new Object3D();
  chair.name = 'chair_1';
  chair.userData.instance_id = 'chair_1';
  const decor = new Object3D();
  decor.name = 'decor_laptop';
  decor.userData.attached_to = 'desk';
  scene.add(desk, chair, decor);
  return { scene, desk, chair, decor };
}

describe('composed furniture visibility', () => {
  it('does not let inventory changes re-show hidden layers', () => {
    const { scene, desk, chair } = fixture();
    const groups = collectFurnitureGroups(scene);
    const instances = new Set(['desk_1', 'chair_1']);
    const hidden = new Set<FurnitureGroup>(['desk']);

    applyFurnitureVisibility(groups, hidden, new Set(['chair_1']), instances);
    expect(desk.visible).toBe(false);
    expect(chair.visible).toBe(false);

    applyFurnitureVisibility(groups, hidden, new Set(), instances);
    expect(desk.visible).toBe(false);
    expect(chair.visible).toBe(true);
  });

  it('hides ride-along decor with its layer, inventory item, or decor master', () => {
    const { scene, decor } = fixture();
    const groups = collectFurnitureGroups(scene);
    const instances = new Set(['desk_1', 'chair_1']);

    applyFurnitureVisibility(groups, new Set(['desk']), new Set(), instances);
    expect(decor.visible).toBe(false);
    applyFurnitureVisibility(groups, new Set(), new Set(['desk_1']), instances);
    expect(decor.visible).toBe(false);
    applyFurnitureVisibility(groups, new Set(['decor']), new Set(), instances);
    expect(decor.visible).toBe(false);
    applyFurnitureVisibility(groups, new Set(), new Set(), instances);
    expect(decor.visible).toBe(true);
  });
});

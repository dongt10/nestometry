import type { NumericVec2, NumericVec3 } from './schema';

export type SvgPoint = NumericVec2;

export type SvgProjection = {
  roomWidthM: number;
  roomDepthM: number;
  pixelsPerMeter: number;
  originPx?: NumericVec2;
};

/** Blender uses the canonical scene axes directly. */
export function sceneToBlenderPosition(position: NumericVec3): NumericVec3 {
  return { ...position };
}

export function blenderToScenePosition(position: NumericVec3): NumericVec3 {
  return { ...position };
}

/**
 * Canonical room coordinates are Blender-like: X right, Y toward the window,
 * and Z up. glTF/Three keeps X right and Y up, with room-forward on -Z.
 */
export function sceneToThreePosition(position: NumericVec3): NumericVec3 {
  return { x: position.x, y: position.z, z: -position.y };
}

export function threeToScenePosition(position: NumericVec3): NumericVec3 {
  return { x: position.x, y: -position.z, z: position.y };
}

export function sceneYawToThreeRadians(sceneYawDeg: number): number {
  return (sceneYawDeg * Math.PI) / 180;
}

export function threeYRotationToSceneYaw(threeRotationRad: number): number {
  return (threeRotationRad * 180) / Math.PI;
}

export function sceneYawToSvgDegrees(sceneYawDeg: number): number {
  return -sceneYawDeg;
}

export function svgRotationToSceneYaw(svgRotationDeg: number): number {
  return -svgRotationDeg;
}

/**
 * Floor-plan SVGs put the window wall at the top of the canvas. The optional
 * origin is the upper-left corner of the room interior, after any UI padding.
 */
export function sceneToSvgPoint(point: NumericVec2, projection: SvgProjection): SvgPoint {
  const origin = projection.originPx ?? { x: 0, y: 0 };
  return {
    x: origin.x + (point.x + projection.roomWidthM / 2) * projection.pixelsPerMeter,
    y: origin.y + (projection.roomDepthM / 2 - point.y) * projection.pixelsPerMeter
  };
}

export function svgToScenePoint(point: SvgPoint, projection: SvgProjection): NumericVec2 {
  const origin = projection.originPx ?? { x: 0, y: 0 };
  return {
    x: (point.x - origin.x) / projection.pixelsPerMeter - projection.roomWidthM / 2,
    y: projection.roomDepthM / 2 - (point.y - origin.y) / projection.pixelsPerMeter
  };
}

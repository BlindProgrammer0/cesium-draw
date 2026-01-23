import * as Cesium from "cesium";

export function validatePointPosition(position: Cesium.Cartesian3 | null | undefined): string | null {
  if (!position) return "点位无效。";
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
    return "点位坐标无效。";
  }
  return null;
}

import * as Cesium from "cesium";

export function validatePolylinePositions(positions: Cesium.Cartesian3[]): string | null {
  if (!Array.isArray(positions) || positions.length < 2) return "折线至少需要 2 个点。";
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1];
    const b = positions[i];
    if (Cesium.Cartesian3.equalsEpsilon(a, b, 1e-9)) return "折线存在相邻重复点。";
  }
  return null;
}

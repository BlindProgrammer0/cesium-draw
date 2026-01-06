import * as Cesium from "cesium";

export function distancePointToSegment2D(
  p: Cesium.Cartesian2,
  a: Cesium.Cartesian2,
  b: Cesium.Cartesian2
): { dist: number; t: number; proj: Cesium.Cartesian2 } {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) {
    return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0, proj: a };
  }

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) {
    return { dist: Math.hypot(p.x - b.x, p.y - b.y), t: 1, proj: b };
  }

  const t = c1 / c2;
  const px = a.x + t * vx;
  const py = a.y + t * vy;
  return {
    dist: Math.hypot(p.x - px, p.y - py),
    t,
    proj: new Cesium.Cartesian2(px, py),
  };
}

export function closestPointOnSegment3D(
  p: Cesium.Cartesian3,
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3
): { point: Cesium.Cartesian3; t: number } {
  const ab = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
  const ap = Cesium.Cartesian3.subtract(p, a, new Cesium.Cartesian3());
  const ab2 = Cesium.Cartesian3.dot(ab, ab);
  if (ab2 <= 1e-12) return { point: Cesium.Cartesian3.clone(a), t: 0 };

  let t = Cesium.Cartesian3.dot(ap, ab) / ab2;
  t = Math.max(0, Math.min(1, t));
  return {
    t,
    point: Cesium.Cartesian3.add(
      a,
      Cesium.Cartesian3.multiplyByScalar(ab, t, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    ),
  };
}

export function cartographicSnapToGrid(
  cart: Cesium.Cartesian3,
  gridSizeMeters: number,
  ellipsoid: Cesium.Ellipsoid = Cesium.Ellipsoid.WGS84
): Cesium.Cartesian3 {
  const c = ellipsoid.cartesianToCartographic(cart);
  if (!c) return Cesium.Cartesian3.clone(cart);

  const lat = c.latitude;
  // Approx meters per degree
  const metersPerDegLat = 110540; // average
  const metersPerDegLon = 111320 * Math.cos(lat);
  const stepLat = gridSizeMeters / metersPerDegLat;
  const stepLon = gridSizeMeters / Math.max(1e-6, metersPerDegLon);

  const lon2 = Math.round(c.longitude / stepLon) * stepLon;
  const lat2 = Math.round(c.latitude / stepLat) * stepLat;

  const snapped = new Cesium.Cartographic(lon2, lat2, c.height);
  return ellipsoid.cartographicToCartesian(snapped);
}

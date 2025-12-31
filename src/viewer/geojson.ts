import * as Cesium from "cesium";

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};
export type GeoJSONFeature = {
  type: "Feature";
  id?: string;
  properties: Record<string, any>;
  geometry: GeoJSONGeometry;
};
export type GeoJSONGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "Point"; coordinates: number[] };

export function geojsonFeatureCollectionFromEntities(
  entities: Cesium.Entity[]
): GeoJSONFeatureCollection {
  const features: GeoJSONFeature[] = [];

  for (const e of entities) {
    const poly = e.polygon;
    if (!poly) continue;
    const hierarchy = poly.hierarchy?.getValue(Cesium.JulianDate.now()) as
      | Cesium.PolygonHierarchy
      | undefined;
    if (!hierarchy?.positions?.length) continue;

    const ring = hierarchy.positions
      .map(toLonLatAlt)
      .map(([lng, lat]) => [lng, lat]);
    if (ring.length >= 3) {
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    }

    features.push({
      type: "Feature",
      id: e.id,
      properties: { name: e.name ?? "polygon" },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  return { type: "FeatureCollection", features };
}

function toLonLatAlt(cart: Cesium.Cartesian3): [number, number, number] {
  const c = Cesium.Cartographic.fromCartesian(cart);
  return [
    Cesium.Math.toDegrees(c.longitude),
    Cesium.Math.toDegrees(c.latitude),
    Number.isFinite(c.height) ? c.height : 0,
  ];
}

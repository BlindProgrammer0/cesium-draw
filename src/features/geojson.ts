import * as Cesium from "cesium";
import type { Feature, PolygonFeature } from "./types";

// GeoJSON expects lon/lat. We export as Polygon with one ring.
export function geojsonFeatureCollectionFromFeatures(features: Feature[]) {
  return {
    type: "FeatureCollection",
    features: features
      .filter((f) => f.kind === "polygon")
      .map((f) => polygonToGeoJSON(f as PolygonFeature)),
  } as any;
}

function polygonToGeoJSON(f: PolygonFeature) {
  const coords = f.geometry.positions.map((p) => {
    const c = Cesium.Cartographic.fromCartesian(p);
    return [
      Cesium.Math.toDegrees(c.longitude),
      Cesium.Math.toDegrees(c.latitude),
      c.height ?? 0,
    ];
  });

  // Ensure closed ring
  if (coords.length > 0) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (
      first[0] !== last[0] ||
      first[1] !== last[1] ||
      first[2] !== last[2]
    ) {
      coords.push([...first]);
    }
  }

  return {
    type: "Feature",
    id: f.id,
    properties: {
      ...(f.properties ?? {}),
      name: f.meta?.name ?? "polygon",
    },
    geometry: {
      type: "Polygon",
      coordinates: [coords],
    },
  } as any;
}

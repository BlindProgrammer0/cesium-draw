import * as Cesium from "cesium";
import type { Feature, PolygonFeature } from "./types";
import { createPolygonFeature } from "./types";

type GeoJSON = any;

/**
 * Import Polygon/MultiPolygon FeatureCollection (lon/lat[/height]) into PolygonFeatures.
 * - Only the first ring is used (no holes for now).
 * - Height is optional; defaults to 0.
 * - If feature has no id, a GUID is generated.
 */
export function polygonFeaturesFromGeoJSON(input: GeoJSON): PolygonFeature[] {
  const fc = normalizeToFeatureCollection(input);
  const out: PolygonFeature[] = [];

  for (const f of fc.features ?? []) {
    if (!f || f.type !== "Feature") continue;
    const geom = f.geometry;
    if (!geom) continue;

    if (geom.type === "Polygon") {
      const ring = (geom.coordinates?.[0] ?? []) as any[];
      const positions = ringToPositions(ring);
      const id = typeof f.id === "string" ? f.id : undefined;
      const name = f.properties?.name ?? f.properties?.title;
      out.push(createPolygonFeature({ id, positions, name }));
      continue;
    }

    if (geom.type === "MultiPolygon") {
      const polys = geom.coordinates ?? [];
      for (let i = 0; i < polys.length; i++) {
        const ring = (polys[i]?.[0] ?? []) as any[];
        const positions = ringToPositions(ring);
        const baseId = typeof f.id === "string" ? f.id : Cesium.createGuid();
        const id = `${baseId}:${i}`;
        const name = f.properties?.name ?? f.properties?.title;
        out.push(createPolygonFeature({ id, positions, name }));
      }
      continue;
    }
  }

  return out;
}

function normalizeToFeatureCollection(input: GeoJSON): { type: string; features: any[] } {
  if (!input) return { type: "FeatureCollection", features: [] };
  if (input.type === "FeatureCollection") return input;
  if (input.type === "Feature") return { type: "FeatureCollection", features: [input] };
  // Accept Geometry as top-level
  if (typeof input.type === "string") {
    return { type: "FeatureCollection", features: [{ type: "Feature", geometry: input, properties: {} }] };
  }
  return { type: "FeatureCollection", features: [] };
}

function ringToPositions(ring: any[]): Cesium.Cartesian3[] {
  // Ring is array of [lon,lat] or [lon,lat,height]
  const pts: Cesium.Cartesian3[] = [];
  for (const c of ring) {
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const h = Number.isFinite(Number(c[2])) ? Number(c[2]) : 0;
    pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, h));
  }
  // If closed, drop last.
  if (pts.length >= 2) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Cesium.Cartesian3.equalsEpsilon(first, last, Cesium.Math.EPSILON7)) {
      pts.pop();
    }
  }
  return pts;
}

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

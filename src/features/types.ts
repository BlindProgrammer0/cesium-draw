import * as Cesium from "cesium";

export type FeatureId = string;

/** Geometry types are domain-level, rendering is handled by CesiumFeatureLayer. */
export type PointGeometry = {
  type: "Point";
  position: Cesium.Cartesian3;
};

export type PolylineGeometry = {
  type: "Polyline";
  positions: Cesium.Cartesian3[];
};

export type PolygonGeometry = {
  type: "Polygon";
  /** World coordinates (Cartesian3). First ring only (no holes) for now. */
  positions: Cesium.Cartesian3[];
};

export type Geometry = PointGeometry | PolylineGeometry | PolygonGeometry;

export type Feature<
  TGeom extends Geometry = Geometry,
  TProps = Record<string, any>
> = {
  id: FeatureId;
  /** Business kind, used for UI/tool routing. */
  kind: "point" | "polyline" | "polygon";
  geometry: TGeom;
  properties?: TProps;
  meta?: {
    name?: string;
    createdAt: number;
    updatedAt: number;
  };
};

export type PointFeature = Feature<PointGeometry>;
export type PolylineFeature = Feature<PolylineGeometry>;
export type PolygonFeature = Feature<PolygonGeometry>;

export function clonePositions(positions: Cesium.Cartesian3[]) {
  return positions.map((p) => Cesium.Cartesian3.clone(p));
}

export function clonePosition(p: Cesium.Cartesian3) {
  return Cesium.Cartesian3.clone(p);
}

export function createPointFeature(params: {
  id?: string;
  position: Cesium.Cartesian3;
  name?: string;
  properties?: Record<string, any>;
}): PointFeature {
  const now = Date.now();
  const id = params.id ?? Cesium.createGuid();
  return {
    id,
    kind: "point",
    geometry: { type: "Point", position: clonePosition(params.position) },
    properties: params.properties ? { ...params.properties } : undefined,
    meta: { name: params.name ?? "point", createdAt: now, updatedAt: now },
  };
}

export function createPolylineFeature(params: {
  id?: string;
  positions: Cesium.Cartesian3[];
  name?: string;
  properties?: Record<string, any>;
}): PolylineFeature {
  const now = Date.now();
  const id = params.id ?? Cesium.createGuid();
  return {
    id,
    kind: "polyline",
    geometry: { type: "Polyline", positions: clonePositions(params.positions) },
    properties: params.properties ? { ...params.properties } : undefined,
    meta: { name: params.name ?? "polyline", createdAt: now, updatedAt: now },
  };
}

export function createPolygonFeature(params: {
  id?: string;
  positions: Cesium.Cartesian3[];
  name?: string;
  properties?: Record<string, any>;
}): PolygonFeature {
  const now = Date.now();
  const id = params.id ?? Cesium.createGuid();
  return {
    id,
    kind: "polygon",
    geometry: { type: "Polygon", positions: clonePositions(params.positions) },
    properties: params.properties ? { ...params.properties } : undefined,
    meta: { name: params.name ?? "polygon", createdAt: now, updatedAt: now },
  };
}

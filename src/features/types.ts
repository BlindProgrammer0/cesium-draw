import * as Cesium from "cesium";

export type FeatureId = string;

export type PolygonGeometry = {
  type: "Polygon";
  /** World coordinates (Cartesian3). First ring only (no holes) for now. */
  positions: Cesium.Cartesian3[];
};

export type Geometry = PolygonGeometry;

export type Feature<
  TGeom extends Geometry = Geometry,
  TProps = Record<string, any>
> = {
  id: FeatureId;
  kind: "polygon";
  geometry: TGeom;
  properties?: TProps;
  meta?: {
    name?: string;
    createdAt?: number;
    updatedAt?: number;
  };
};

export type PolygonFeature = Feature<PolygonGeometry>;

export function clonePositions(positions: Cesium.Cartesian3[]) {
  return positions.map((p) => Cesium.Cartesian3.clone(p));
}

export function createPolygonFeature(params: {
  id?: string;
  positions: Cesium.Cartesian3[];
  name?: string;
}): PolygonFeature {
  const now = Date.now();
  const id = params.id ?? Cesium.createGuid();
  return {
    id,
    kind: "polygon",
    geometry: { type: "Polygon", positions: clonePositions(params.positions) },
    meta: { name: params.name ?? "polygon", createdAt: now, updatedAt: now },
  };
}

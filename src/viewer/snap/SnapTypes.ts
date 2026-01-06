import * as Cesium from "cesium";

export type SnapType = "vertex" | "midpoint" | "edge" | "grid";

export type SnapTypesEnabled = Record<SnapType, boolean>;

export type SnapSourcesEnabled = {
  /** Snap to other polygons' geometry (vertices / midpoints / edges). */
  polygons: boolean;
  /** Snap to a geodetic grid. */
  grid: boolean;
};

export type SnapPriority = Record<SnapType, number>;

export interface SnapCandidate {
  type: SnapType;
  position: Cesium.Cartesian3;
  distancePx: number;
  /** Larger wins when distances are similar. */
  priority: number;
  /** Optional metadata for edge insertion / debugging. */
  meta?: {
    ownerId?: string;
    /** Edge start index for polygon edges. */
    edgeStartIndex?: number;
    /** Candidate index (vertex index) for vertices. */
    vertexIndex?: number;
  };
}

export interface SnapResult {
  candidate: SnapCandidate;
}

export type SnapQueryOptions = {
  /** Exclude snapping to the polygon being edited. */
  excludeOwnerId?: string;
  /** Exclude a specific vertex index on excludeOwnerId (during vertex drag). */
  excludeIndex?: number;
};

export function defaultSnapTypes(): SnapTypesEnabled {
  return { vertex: true, midpoint: true, edge: true, grid: false };
}

export function defaultSnapSources(): SnapSourcesEnabled {
  return { polygons: true, grid: false };
}

export function defaultSnapPriority(): SnapPriority {
  return { vertex: 100, midpoint: 80, edge: 60, grid: 40 };
}

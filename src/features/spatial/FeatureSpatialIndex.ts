import * as Cesium from "cesium";
import type { FeatureId, PolygonFeature } from "../types";
import type { FeatureStore } from "../store";

export type IndexedVertex = {
  featureId: FeatureId;
  vertexIndex: number;
  position: Cesium.Cartesian3;
};

export type IndexedEdge = {
  featureId: FeatureId;
  edgeStartIndex: number;
  a: Cesium.Cartesian3;
  b: Cesium.Cartesian3;
};

export type SpatialQueryResult = {
  vertices: IndexedVertex[];
  edges: IndexedEdge[];
};

type CellKey = string;

function cellKey(ix: number, iy: number, iz: number): CellKey {
  return `${ix},${iy},${iz}`;
}

/**
 * Very lightweight 3D spatial hash index (ECEF meters) for polygons.
 *
 * Notes:
 * - Index is built in world coordinates, so it is stable across camera movement.
 * - Snapping threshold is in pixels; SnappingEngine converts to an approximate meter radius
 *   (metersPerPixelAt(worldCandidate) * thresholdPx) and queries this index.
 */
export class FeatureSpatialIndex {
  private cellSize = 50; // meters
  private vertexCells = new Map<CellKey, IndexedVertex[]>();
  private edgeCells = new Map<CellKey, IndexedEdge[]>();

  // For incremental updates
  private verticesByFeature = new Map<FeatureId, IndexedVertex[]>();
  private edgesByFeature = new Map<FeatureId, IndexedEdge[]>();

  constructor(private readonly store: FeatureStore, opts?: { cellSizeMeters?: number }) {
    if (opts?.cellSizeMeters) this.cellSize = Math.max(5, Math.min(1000, opts.cellSizeMeters));
    this.rebuildAll();
    this.store.onChange((evt) => {
      if (evt.type === "upsert") {
        if (evt.feature.kind === "polygon") this.upsert(evt.feature as PolygonFeature);
      } else if (evt.type === "remove") {
        this.remove(evt.id);
      } else if (evt.type === "clear") {
        this.clear();
      }
    });
  }

  setCellSizeMeters(v: number) {
    const next = Math.max(5, Math.min(1000, v));
    if (next === this.cellSize) return;
    this.cellSize = next;
    this.rebuildAll();
  }

  getCellSizeMeters() {
    return this.cellSize;
  }

  rebuildAll() {
    this.clear();
    for (const f of this.store.all()) {
      if (f.kind === "polygon") this.upsert(f as PolygonFeature);
    }
  }

  clear() {
    this.vertexCells.clear();
    this.edgeCells.clear();
    this.verticesByFeature.clear();
    this.edgesByFeature.clear();
  }

  remove(featureId: FeatureId) {
    const vs = this.verticesByFeature.get(featureId) ?? [];
    const es = this.edgesByFeature.get(featureId) ?? [];

    for (const v of vs) this.removeFromCells(this.vertexCells, v.position, v);
    for (const e of es) {
      const center = Cesium.Cartesian3.midpoint(e.a, e.b, new Cesium.Cartesian3());
      this.removeFromCells(this.edgeCells, center, e);
    }

    this.verticesByFeature.delete(featureId);
    this.edgesByFeature.delete(featureId);
  }

  upsert(feature: PolygonFeature) {
    // Remove old first
    this.remove(feature.id);

    const positions = feature.geometry.positions;
    if (!positions || positions.length < 2) return;

    const vs: IndexedVertex[] = [];
    const es: IndexedEdge[] = [];

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const v: IndexedVertex = { featureId: feature.id, vertexIndex: i, position: Cesium.Cartesian3.clone(p) };
      vs.push(v);
      this.addToCells(this.vertexCells, v.position, v);

      const a = positions[i];
      const b = positions[(i + 1) % positions.length];
      const e: IndexedEdge = {
        featureId: feature.id,
        edgeStartIndex: i,
        a: Cesium.Cartesian3.clone(a),
        b: Cesium.Cartesian3.clone(b),
      };
      es.push(e);
      const center = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
      this.addToCells(this.edgeCells, center, e);
    }

    this.verticesByFeature.set(feature.id, vs);
    this.edgesByFeature.set(feature.id, es);
  }

  query(worldPos: Cesium.Cartesian3, radiusMeters: number): SpatialQueryResult {
    const cs = this.cellSize;
    const r = Math.max(0, radiusMeters);
    const minX = worldPos.x - r;
    const maxX = worldPos.x + r;
    const minY = worldPos.y - r;
    const maxY = worldPos.y + r;
    const minZ = worldPos.z - r;
    const maxZ = worldPos.z + r;

    const ix0 = Math.floor(minX / cs);
    const ix1 = Math.floor(maxX / cs);
    const iy0 = Math.floor(minY / cs);
    const iy1 = Math.floor(maxY / cs);
    const iz0 = Math.floor(minZ / cs);
    const iz1 = Math.floor(maxZ / cs);

    const vertices: IndexedVertex[] = [];
    const edges: IndexedEdge[] = [];

    const seenV = new Set<string>();
    const seenE = new Set<string>();

    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const k = cellKey(ix, iy, iz);

          const vs = this.vertexCells.get(k);
          if (vs) {
            for (const v of vs) {
              const key = `${v.featureId}:${v.vertexIndex}`;
              if (seenV.has(key)) continue;
              if (Cesium.Cartesian3.distance(v.position, worldPos) <= r) {
                vertices.push(v);
                seenV.add(key);
              }
            }
          }

          const es = this.edgeCells.get(k);
          if (es) {
            for (const e of es) {
              const key = `${e.featureId}:${e.edgeStartIndex}`;
              if (seenE.has(key)) continue;
              // cheap pre-filter: distance to segment endpoints (not exact, but reduces false positives)
              const da = Cesium.Cartesian3.distance(e.a, worldPos);
              const db = Cesium.Cartesian3.distance(e.b, worldPos);
              if (Math.min(da, db) <= r * 2) {
                edges.push(e);
                seenE.add(key);
              }
            }
          }
        }
      }
    }

    return { vertices, edges };
  }

  private addToCells<T>(map: Map<CellKey, T[]>, pos: Cesium.Cartesian3, item: T) {
    const cs = this.cellSize;
    const ix = Math.floor(pos.x / cs);
    const iy = Math.floor(pos.y / cs);
    const iz = Math.floor(pos.z / cs);
    const k = cellKey(ix, iy, iz);
    const arr = map.get(k) ?? [];
    arr.push(item);
    map.set(k, arr);
  }

  private removeFromCells<T>(map: Map<CellKey, T[]>, pos: Cesium.Cartesian3, item: T) {
    const cs = this.cellSize;
    const ix = Math.floor(pos.x / cs);
    const iy = Math.floor(pos.y / cs);
    const iz = Math.floor(pos.z / cs);
    const k = cellKey(ix, iy, iz);
    const arr = map.get(k);
    if (!arr?.length) return;
    const idx = arr.indexOf(item);
    if (idx >= 0) arr.splice(idx, 1);
    if (!arr.length) map.delete(k);
  }
}

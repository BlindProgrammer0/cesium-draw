import * as Cesium from "cesium";
import type { Feature, FeatureId } from "../types";
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

type CellKey = string;

export type SpatialQueryResult = {
  vertices: IndexedVertex[];
  edges: IndexedEdge[];
};

/**
 * Stage 5.5: Lightweight spatial hash index for snapping candidates.
 * - ECEF (Cartesian3) meter-space.
 * - Stores vertices + edges, query by radius to cut candidate count.
 *
 * Notes:
 * - This is not a full R-tree; it's a pragmatic grid hash for real-time snapping.
 * - Index is rebuilt incrementally from FeatureStore events.
 */
export class FeatureSpatialIndex {
  private readonly cellSize: number;

  private vertexCells = new Map<CellKey, IndexedVertex[]>();
  private edgeCells = new Map<CellKey, IndexedEdge[]>();

  private verticesByFeature = new Map<FeatureId, IndexedVertex[]>();
  private edgesByFeature = new Map<FeatureId, IndexedEdge[]>();

  private unsub: (() => void) | null = null;

  constructor(private readonly store: FeatureStore, opts?: { cellSizeMeters?: number }) {
    this.cellSize = Math.max(1, Math.min(10000, opts?.cellSizeMeters ?? 50));
    // Build initial
    for (const f of store.all()) this.upsert(f);
    // Subscribe
    this.unsub = store.on((evt) => {
      if (evt.type === "upsert") this.upsert(evt.feature);
      if (evt.type === "remove") this.remove(evt.id);
      if (evt.type === "clear") this.clear();
    });
  }

  destroy() {
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.clear();
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

  upsert(feature: Feature) {
    // Remove old
    this.remove(feature.id);

    const vs: IndexedVertex[] = [];
    const es: IndexedEdge[] = [];

    const positions = this.getPositions(feature);

    // vertices
    for (let i = 0; i < positions.length; i++) {
      const v: IndexedVertex = {
        featureId: feature.id,
        vertexIndex: i,
        position: Cesium.Cartesian3.clone(positions[i]),
      };
      vs.push(v);
      this.addToCells(this.vertexCells, v.position, v);
    }

    // edges
    if (feature.kind === "polyline") {
      for (let i = 0; i < Math.max(0, positions.length - 1); i++) {
        const a = positions[i];
        const b = positions[i + 1];
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
    } else if (feature.kind === "polygon") {
      for (let i = 0; i < positions.length; i++) {
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
    } else {
      // point: no edges
    }

    this.verticesByFeature.set(feature.id, vs);
    this.edgesByFeature.set(feature.id, es);
  }

  query(worldPos: Cesium.Cartesian3, radiusMeters: number): SpatialQueryResult {
    const cs = this.cellSize;
    const r = Math.max(0.1, radiusMeters);

    const { cx, cy, cz } = this.toCell(worldPos);
    const range = Math.ceil(r / cs) + 1;

    const vertices: IndexedVertex[] = [];
    const edges: IndexedEdge[] = [];

    for (let dx = -range; dx <= range; dx++) {
      for (let dy = -range; dy <= range; dy++) {
        for (let dz = -range; dz <= range; dz++) {
          const key = this.key(cx + dx, cy + dy, cz + dz);
          const vs = this.vertexCells.get(key);
          const es = this.edgeCells.get(key);
          if (vs) vertices.push(...vs);
          if (es) edges.push(...es);
        }
      }
    }

    // Filter by true distance (optional but keeps candidate count sane)
    const vFiltered = vertices.filter((v) => Cesium.Cartesian3.distance(v.position, worldPos) <= r);
    const eFiltered = edges.filter((e) => {
      const c = Cesium.Cartesian3.midpoint(e.a, e.b, new Cesium.Cartesian3());
      return Cesium.Cartesian3.distance(c, worldPos) <= r * 1.5;
    });

    return { vertices: vFiltered, edges: eFiltered };
  }

  private getPositions(feature: Feature): Cesium.Cartesian3[] {
    if (feature.kind === "point") {
      return [(feature as any).geometry.position as Cesium.Cartesian3];
    }
    return ((feature as any).geometry.positions as Cesium.Cartesian3[]) ?? [];
  }

  private toCell(p: Cesium.Cartesian3) {
    const cs = this.cellSize;
    return {
      cx: Math.floor(p.x / cs),
      cy: Math.floor(p.y / cs),
      cz: Math.floor(p.z / cs),
    };
  }

  private key(cx: number, cy: number, cz: number) {
    return `${cx},${cy},${cz}`;
  }

  private addToCells<T>(cells: Map<CellKey, T[]>, p: Cesium.Cartesian3, v: T) {
    const { cx, cy, cz } = this.toCell(p);
    const key = this.key(cx, cy, cz);
    const list = cells.get(key) ?? [];
    list.push(v);
    cells.set(key, list);
  }

  private removeFromCells<T>(cells: Map<CellKey, T[]>, p: Cesium.Cartesian3, v: T) {
    const { cx, cy, cz } = this.toCell(p);
    const key = this.key(cx, cy, cz);
    const list = cells.get(key);
    if (!list) return;
    const idx = list.indexOf(v);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) cells.delete(key);
    else cells.set(key, list);
  }
}

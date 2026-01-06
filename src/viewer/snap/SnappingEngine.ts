import * as Cesium from "cesium";
import type { SnapCandidate, SnapPriority, SnapQueryOptions, SnapResult, SnapSourcesEnabled, SnapTypesEnabled } from "./SnapTypes";
import { defaultSnapPriority, defaultSnapSources, defaultSnapTypes } from "./SnapTypes";
import { cartographicSnapToGrid, closestPointOnSegment3D, distancePointToSegment2D } from "./math";
import type { FeatureSpatialIndex } from "../../features/spatial/FeatureSpatialIndex";

export type SnappingEngineOptions = {
  thresholdPx?: number;
  types?: Partial<SnapTypesEnabled>;
  sources?: Partial<SnapSourcesEnabled>;
  priority?: Partial<SnapPriority>;
  gridSizeMeters?: number;
};

/**
 * Stage-4 snapping engine:
 * - Vertex / Midpoint / Edge / Grid
 * - Optional snap sources
 * - Priority-based selection
 */
export class SnappingEngine {
  private thresholdPx = 12;
  private types: SnapTypesEnabled = defaultSnapTypes();
  private sources: SnapSourcesEnabled = defaultSnapSources();
  private priority: SnapPriority = defaultSnapPriority();
  private gridSizeMeters = 5;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly ds: Cesium.CustomDataSource,
    private readonly index?: FeatureSpatialIndex
  ) {}

  configure(opts: SnappingEngineOptions) {
    if (typeof opts.thresholdPx === "number") this.thresholdPx = Math.max(1, Math.min(64, Math.floor(opts.thresholdPx)));
    if (opts.types) this.types = { ...this.types, ...opts.types };
    if (opts.sources) this.sources = { ...this.sources, ...opts.sources };
    if (opts.priority) this.priority = { ...this.priority, ...opts.priority };
    if (typeof opts.gridSizeMeters === "number") this.gridSizeMeters = Math.max(0.1, Math.min(5000, opts.gridSizeMeters));
  }

  setThresholdPx(v: number) {
    this.thresholdPx = Math.max(1, Math.min(64, Math.floor(v)));
  }
  getThresholdPx() {
    return this.thresholdPx;
  }
  setTypes(v: Partial<SnapTypesEnabled>) {
    this.types = { ...this.types, ...v };
  }
  getTypes() {
    return { ...this.types };
  }
  setSources(v: Partial<SnapSourcesEnabled>) {
    this.sources = { ...this.sources, ...v };
  }
  getSources() {
    return { ...this.sources };
  }
  setGridSizeMeters(v: number) {
    this.gridSizeMeters = Math.max(0.1, Math.min(5000, v));
  }
  getGridSizeMeters() {
    return this.gridSizeMeters;
  }

  /**
   * Compute best snap candidate given current world position and cursor screen position.
   * Returns null when no candidate matches threshold.
   */
  snap(
    worldCandidate: Cesium.Cartesian3,
    cursorScreenPos: Cesium.Cartesian2,
    query?: SnapQueryOptions
  ): SnapResult | null {
    const scene = this.viewer.scene;
    const candidates: SnapCandidate[] = [];

    if (this.sources.polygons) {
      // Prefer spatial index (Stage 5.5) for large datasets.
      if (this.index) {
        const radiusMeters = this.thresholdPx * metersPerPixelAt(scene, worldCandidate);
        const { vertices, edges } = this.index.query(worldCandidate, radiusMeters);

        if (this.types.vertex || this.types.midpoint) {
          for (const v of vertices) {
            const id = String(v.featureId);
            if (query?.excludeOwnerId && id === query.excludeOwnerId) {
              if (query.excludeIndex === undefined) continue; // exclude whole feature
              if (query.excludeIndex === v.vertexIndex) continue;
            }

            if (this.types.vertex) {
              const sp = scene.cartesianToCanvasCoordinates(v.position);
              if (sp) {
                const d = Math.hypot(sp.x - cursorScreenPos.x, sp.y - cursorScreenPos.y);
                if (d <= this.thresholdPx) {
                  candidates.push({
                    type: "vertex",
                    position: Cesium.Cartesian3.clone(v.position),
                    distancePx: d,
                    priority: this.priority.vertex,
                    meta: { ownerId: id, vertexIndex: v.vertexIndex },
                  });
                }
              }
            }
          }
        }

        if (this.types.midpoint || this.types.edge) {
          for (const e of edges) {
            const id = String(e.featureId);
            if (query?.excludeOwnerId && id === query.excludeOwnerId && query.excludeIndex === undefined) continue;

            const a = e.a;
            const b = e.b;

            if (this.types.midpoint) {
              const mid = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
              const sp = scene.cartesianToCanvasCoordinates(mid);
              if (sp) {
                const d = Math.hypot(sp.x - cursorScreenPos.x, sp.y - cursorScreenPos.y);
                if (d <= this.thresholdPx) {
                  candidates.push({
                    type: "midpoint",
                    position: mid,
                    distancePx: d,
                    priority: this.priority.midpoint,
                    meta: { ownerId: id, edgeStartIndex: e.edgeStartIndex },
                  });
                }
              }
            }

            if (this.types.edge) {
              const a2 = scene.cartesianToCanvasCoordinates(a);
              const b2 = scene.cartesianToCanvasCoordinates(b);
              if (a2 && b2) {
                const seg = distancePointToSegment2D(cursorScreenPos, a2, b2);
                if (seg.dist <= this.thresholdPx) {
                  const proj = closestPointOnSegment3D(worldCandidate, a, b);
                  candidates.push({
                    type: "edge",
                    position: proj.point,
                    distancePx: seg.dist,
                    priority: this.priority.edge,
                    meta: { ownerId: id, edgeStartIndex: e.edgeStartIndex },
                  });
                }
              }
            }
          }
        }
      } else {
        // Fallback: scan rendered entities (fine for small datasets).
        for (const e of this.ds.entities.values) {
          if (!e.polygon) continue;
          const id = String(e.id);
          const hierarchy = e.polygon.hierarchy?.getValue(Cesium.JulianDate.now()) as Cesium.PolygonHierarchy | undefined;
          const positions = hierarchy?.positions;
          if (!positions?.length) continue;

          const n = positions.length;
          for (let i = 0; i < n; i++) {
            const a = positions[i];
            const b = positions[(i + 1) % n];

          // Vertex
          if (this.types.vertex) {
            if (
              query?.excludeOwnerId &&
              id === query.excludeOwnerId &&
              (query.excludeIndex === i || query.excludeIndex === undefined)
            ) {
              // - When excludeIndex is set: exclude only that vertex.
              // - When excludeIndex is undefined but excludeOwnerId set: exclude ALL vertices of that polygon.
            } else if (!(query?.excludeOwnerId && id === query.excludeOwnerId && query.excludeIndex === undefined)) {
              const sp = scene.cartesianToCanvasCoordinates(a);
              if (sp) {
                const d = Math.hypot(sp.x - cursorScreenPos.x, sp.y - cursorScreenPos.y);
                if (d <= this.thresholdPx) {
                  candidates.push({
                    type: "vertex",
                    position: Cesium.Cartesian3.clone(a),
                    distancePx: d,
                    priority: this.priority.vertex,
                    meta: { ownerId: id, vertexIndex: i },
                  });
                }
              }
            }
          }

          // Midpoint
          if (this.types.midpoint) {
            if (!(query?.excludeOwnerId && id === query.excludeOwnerId && query.excludeIndex === undefined)) {
              const mid = Cesium.Cartesian3.midpoint(a, b, new Cesium.Cartesian3());
              const sp = scene.cartesianToCanvasCoordinates(mid);
              if (sp) {
                const d = Math.hypot(sp.x - cursorScreenPos.x, sp.y - cursorScreenPos.y);
                if (d <= this.thresholdPx) {
                  candidates.push({
                    type: "midpoint",
                    position: mid,
                    distancePx: d,
                    priority: this.priority.midpoint,
                    meta: { ownerId: id, edgeStartIndex: i },
                  });
                }
              }
            }
          }

          // Edge
          if (this.types.edge) {
            if (!(query?.excludeOwnerId && id === query.excludeOwnerId && query.excludeIndex === undefined)) {
              const a2 = scene.cartesianToCanvasCoordinates(a);
              const b2 = scene.cartesianToCanvasCoordinates(b);
              if (a2 && b2) {
                const seg = distancePointToSegment2D(cursorScreenPos, a2, b2);
                if (seg.dist <= this.thresholdPx) {
                  const proj = closestPointOnSegment3D(worldCandidate, a, b);
                  candidates.push({
                    type: "edge",
                    position: proj.point,
                    distancePx: seg.dist,
                    priority: this.priority.edge,
                    meta: { ownerId: id, edgeStartIndex: i },
                  });
                }
              }
            }
          }
          }
        }
      }
    }

    if (this.sources.grid && this.types.grid) {
      const snapped = cartographicSnapToGrid(worldCandidate, this.gridSizeMeters, this.viewer.scene.globe.ellipsoid);
      const sp = scene.cartesianToCanvasCoordinates(snapped);
      if (sp) {
        const d = Math.hypot(sp.x - cursorScreenPos.x, sp.y - cursorScreenPos.y);
        if (d <= this.thresholdPx) {
          candidates.push({
            type: "grid",
            position: snapped,
            distancePx: d,
            priority: this.priority.grid,
          });
        }
      }
    }

    if (!candidates.length) return null;

    // Pick best: minimal distance, then higher priority.
    candidates.sort((a, b) => {
      if (a.distancePx !== b.distancePx) return a.distancePx - b.distancePx;
      return b.priority - a.priority;
    });

    // If multiple candidates are very close in distance (sub-pixel), prefer priority.
    const bestDist = candidates[0].distancePx;
    const near = candidates.filter((c) => Math.abs(c.distancePx - bestDist) < 0.75);
    if (near.length > 1) near.sort((a, b) => b.priority - a.priority);
    const best = near[0] ?? candidates[0];
    return { candidate: best };
  }
}

function metersPerPixelAt(scene: Cesium.Scene, world: Cesium.Cartesian3): number {
  try {
    const canvas = scene.canvas;
    const bs = new Cesium.BoundingSphere(world, 1.0);
    const px = scene.camera.getPixelSize(bs, canvas.clientWidth, canvas.clientHeight);
    return Number.isFinite(px) && px > 0 ? px : 1;
  } catch {
    return 1;
  }
}

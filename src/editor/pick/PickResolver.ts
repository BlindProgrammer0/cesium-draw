import * as Cesium from "cesium";
import type { ResolvedHit, HandleKind } from "./hitTypes";

/**
 * PickResolver (Stage 6.4)
 *
 * Converts Cesium drillPick hits into a single deterministic result using a
 * priority policy. This isolates "pick ordering" away from tools, enabling
 * future multi-select / box-select without refactoring tool internals.
 *
 * Priority policy (edit mode):
 *  1) Handles (vertex > midpoint > point)
 *  2) Selected feature body
 *  3) Other features (polyline > polygon > point)
 */
export class PickResolver {
  constructor(private readonly viewer: Cesium.Viewer) {}

  resolve(
    screenPos: Cesium.Cartesian2,
    ctx: { selectedId: string | null }
  ): ResolvedHit {
    const scene = this.viewer.scene;
    const picked = scene.drillPick(screenPos, 10) as any[];
    if (!picked || picked.length === 0) return { type: "none" };

    let best: ResolvedHit = { type: "none" };
    let bestScore = -Infinity;

    for (const p of picked) {
      const entity = this.extractEntity(p);
      if (!entity) continue;

      const hit = this.toResolvedHit(entity);
      if (hit.type === "none") continue;

      const score = this.score(hit, ctx);
      if (score > bestScore) {
        best = hit;
        bestScore = score;
      }
    }

    return best;
  }

  private extractEntity(p: any): Cesium.Entity | null {
    if (!p) return null;
    const id = (p as any).id;
    return id instanceof Cesium.Entity ? id : null;
  }

  private toResolvedHit(entity: Cesium.Entity): ResolvedHit {
    const props = entity.properties?.getValue(Cesium.JulianDate.now());

    // Handle entity created by FeatureEditTool overlay
    if (props?.__type === "handle" && typeof props?.__ownerId === "string") {
      const index = typeof props?.__index === "number" ? props.__index : undefined;

      // Stage 6.4: existing handles are vertex handles.
      // Midpoints can be added later without changing the resolver.
      const handleKind: HandleKind = "vertex";

      return { type: "handle", ownerId: props.__ownerId, handleKind, index };
    }

    // Feature body entity rendered by CesiumFeatureLayer
    const fid = props?.__featureId;
    if (typeof fid === "string") {
      const kind = props?.__kind;
      if (kind === "point" || kind === "polyline" || kind === "polygon")
        return { type: "feature", featureId: fid, kind };
      // If kind is missing, treat as lowest-priority feature
      return { type: "feature", featureId: fid, kind: "polygon" };
    }

    return { type: "none" };
  }

  private score(hit: ResolvedHit, ctx: { selectedId: string | null }): number {
    if (hit.type === "none") return -Infinity;

    // 1) Handles
    if (hit.type === "handle") {
      const base = 10000;
      const k =
        hit.handleKind === "vertex" ? 300 : hit.handleKind === "midpoint" ? 200 : 100;
      return base + k;
    }

    // 2) Feature bodies
    const base = 1000;
    const selectedBonus = ctx.selectedId && hit.featureId === ctx.selectedId ? 500 : 0;
    const kindBonus =
      hit.kind === "polyline" ? 300 : hit.kind === "polygon" ? 200 : 100;

    return base + selectedBonus + kindBonus;
  }
}

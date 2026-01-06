import * as Cesium from "cesium";
import type { Feature, FeatureId, PolygonFeature } from "./types";
import type { FeatureStore, FeatureEvent } from "./store";
import { clonePositions } from "./types";

export type PolygonRenderStyle = {
  material?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

/**
 * Renders FeatureStore into Cesium entities.
 * Entity is view; FeatureStore is truth.
 */
export class CesiumFeatureLayer {
  readonly ds: Cesium.CustomDataSource;
  private entityByFeature = new Map<FeatureId, Cesium.Entity>();

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly store: FeatureStore,
    private readonly style: PolygonRenderStyle = {}
  ) {
    this.ds = new Cesium.CustomDataSource("feature-layer");
    this.viewer.dataSources.add(this.ds);
    this.store.onChange((evt) => this.onStoreEvent(evt));
  }

  getEntity(id: FeatureId): Cesium.Entity | undefined {
    return this.entityByFeature.get(id);
  }

  /** For initial sync if needed. */
  syncAllNow() {
    for (const f of this.store.all()) this.applyUpsert(f);
  }

  private onStoreEvent(evt: FeatureEvent) {
    if (evt.type === "upsert") this.applyUpsert(evt.feature);
    if (evt.type === "remove") this.applyRemove(evt.id);
    if (evt.type === "clear") {
      for (const f of evt.removed) this.applyRemove(f.id);
    }
  }

  private applyUpsert(feature: Feature) {
    if (feature.kind !== "polygon") return;
    const poly = feature as PolygonFeature;

    let entity = this.entityByFeature.get(poly.id);
    if (!entity) {
      entity = this.ds.entities.add({
        id: poly.id,
        name: poly.meta?.name ?? "polygon",
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            clonePositions(poly.geometry.positions)
          ),
          material:
            this.style.material ??
            new Cesium.ColorMaterialProperty(
              Cesium.Color.CYAN.withAlpha(0.25)
            ),
          outline: true,
          outlineColor: new Cesium.ColorMaterialProperty(
            (this.style.outlineColor ?? Cesium.Color.CYAN).withAlpha(0.95)
          ),
        },
        properties: {
          __type: "polygon",
          __source: "committed",
          __featureId: poly.id,
        },
      });
      this.entityByFeature.set(poly.id, entity);
      return;
    }

    if (entity.polygon) {
      entity.name = poly.meta?.name ?? entity.name;
      entity.polygon.hierarchy = new Cesium.ConstantProperty(
        new Cesium.PolygonHierarchy(clonePositions(poly.geometry.positions))
      ) as any;
    }
  }

  private applyRemove(id: FeatureId) {
    const e = this.entityByFeature.get(id);
    if (!e) return;
    this.ds.entities.remove(e);
    this.entityByFeature.delete(id);
  }
}

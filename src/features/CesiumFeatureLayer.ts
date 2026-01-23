import * as Cesium from "cesium";
import type {
  Feature,
  FeatureId,
  PointFeature,
  PolylineFeature,
  PolygonFeature,
} from "./types";
import type { FeatureStore, FeatureEvent } from "./store";
import { clonePosition, clonePositions } from "./types";

export type PolygonRenderStyle = {
  material?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

export type PolylineRenderStyle = {
  material?: Cesium.MaterialProperty;
  width?: number;
};

export type PointRenderStyle = {
  color?: Cesium.Color;
  pixelSize?: number;
};

/**
 * Renders FeatureStore into Cesium entities.
 * Entity is view; FeatureStore is truth.
 */
export class CesiumFeatureLayer {
  readonly ds: Cesium.CustomDataSource;

  private unsub: (() => void) | null = null;
  private entityByFeature = new Map<FeatureId, Cesium.Entity>();

  constructor(
    private readonly store: FeatureStore,
    opts?: {
      name?: string;
      polygonStyle?: PolygonRenderStyle;
      polylineStyle?: PolylineRenderStyle;
      pointStyle?: PointRenderStyle;
    },
  ) {
    this.ds = new Cesium.CustomDataSource(opts?.name ?? "feature-layer");

    this.polygonStyle = {
      material:
        opts?.polygonStyle?.material ??
        new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
      outlineColor: opts?.polygonStyle?.outlineColor ?? Cesium.Color.CYAN,
    };

    this.polylineStyle = {
      material:
        opts?.polylineStyle?.material ??
        new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW.withAlpha(0.9)),
      width: opts?.polylineStyle?.width ?? 3,
    };

    this.pointStyle = {
      color: opts?.pointStyle?.color ?? Cesium.Color.YELLOW,
      pixelSize: opts?.pointStyle?.pixelSize ?? 10,
    };
  }

  private polygonStyle: PolygonRenderStyle;
  private polylineStyle: PolylineRenderStyle;
  private pointStyle: PointRenderStyle;

  mount(viewer: Cesium.Viewer) {
    viewer.dataSources.add(this.ds);
    // Initial render
    for (const f of this.store.all()) this.applyUpsert(f);
    // Subscribe to store changes
    this.unsub = this.store.on((evt) => this.onStoreEvent(evt));
    return () => this.unmount(viewer);
  }

  unmount(viewer: Cesium.Viewer) {
    if (this.unsub) this.unsub();
    this.unsub = null;
    viewer.dataSources.remove(this.ds);
  }

  setPolygonStyle(style: Partial<PolygonRenderStyle>) {
    this.polygonStyle = { ...this.polygonStyle, ...style };
    // Re-render polygons only
    for (const f of this.store.all())
      if (f.kind === "polygon") this.applyUpsert(f);
  }
  setPolylineStyle(style: Partial<PolylineRenderStyle>) {
    this.polylineStyle = { ...this.polylineStyle, ...style };
    for (const f of this.store.all())
      if (f.kind === "polyline") this.applyUpsert(f);
  }

  getEntity(id: FeatureId): Cesium.Entity | undefined {
    return this.entityByFeature.get(id);
  }

  private onStoreEvent(evt: FeatureEvent) {
    if (evt.type === "upsert") this.applyUpsert(evt.feature);
    if (evt.type === "remove") this.applyRemove(evt.id);
    if (evt.type === "clear") {
      this.ds.entities.removeAll();
      this.entityByFeature.clear();
    }
  }

  private applyUpsert(feature: Feature) {
    let entity = this.entityByFeature.get(feature.id);
    if (!entity) {
      entity = this.ds.entities.add(new Cesium.Entity());
      this.entityByFeature.set(feature.id, entity);
      entity.properties = new Cesium.PropertyBag({
        __featureId: feature.id,
      }) as any;
    } else {
      // Ensure properties exist
      if (!entity.properties)
        entity.properties = new Cesium.PropertyBag({
          __featureId: feature.id,
        }) as any;
    }

    entity.name = feature.meta?.name ?? entity.name;

    // Clear old graphics to avoid mixed types when kind changes (rare)
    (entity as any).polygon = undefined;
    (entity as any).polyline = undefined;
    (entity as any).point = undefined;

    if (feature.kind === "polygon") {
      const poly = feature as PolygonFeature;
      entity.polygon = new Cesium.PolygonGraphics({
        material: this.polygonStyle.material,
        outline: true,
        outlineColor: this.polygonStyle.outlineColor,
        hierarchy: new Cesium.ConstantProperty(
          new Cesium.PolygonHierarchy(clonePositions(poly.geometry.positions)),
        ) as any,
      });
      return;
    }

    if (feature.kind === "polyline") {
      const line = feature as PolylineFeature;
      entity.polyline = new Cesium.PolylineGraphics({
        positions: new Cesium.ConstantProperty(
          clonePositions(line.geometry.positions),
        ) as any,
        material: this.polylineStyle.material,
        width: this.polylineStyle.width,
      });
      return;
    }

    if (feature.kind === "point") {
      const pt = feature as PointFeature;
      entity.position = new Cesium.ConstantPositionProperty(
        clonePosition(pt.geometry.position),
      ) as any;
      entity.point = new Cesium.PointGraphics({
        color: this.pointStyle.color,
        pixelSize: this.pointStyle.pixelSize,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
      });
      return;
    }
  }

  private applyRemove(id: FeatureId) {
    const e = this.entityByFeature.get(id);
    if (!e) return;
    this.ds.entities.remove(e);
    this.entityByFeature.delete(id);
  }
}

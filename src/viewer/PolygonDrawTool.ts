import * as Cesium from "cesium";
import type { CommandStack } from "./commands/CommandStack";
import { createPolygonFeature } from "../features/types";
import { AddFeatureCommand, ClearAllFeaturesCommand } from "../features/commands";
import type { FeatureStore } from "../features/store";
import { validatePolygonPositions } from "../features/validation";
import type { PickService } from "./PickService";
import type { InteractionLock } from "./InteractionLock";
import {
  BaseDrawTool,
  type BaseDrawToolOptions,
  type DrawState,
} from "./draw/BaseDrawTool";

export type PolygonDrawState = DrawState;

export type PolygonDrawToolOptions = BaseDrawToolOptions & {
  polygonMaterial?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

export class PolygonDrawTool extends BaseDrawTool {
  private readonly toolOpts: PolygonDrawToolOptions;

  constructor(
    viewer: Cesium.Viewer,
    interactionLock: InteractionLock,
    pick: PickService,
    stack: CommandStack,
    store: FeatureStore,
    toolOpts: PolygonDrawToolOptions = {},
  ) {
    super(viewer, interactionLock, pick, stack, store, toolOpts);
    this.toolOpts = toolOpts;
  }

  protected minPoints(): number {
    return 3;
  }

  protected ensurePreviewEntity(): void {
    if (this.previewEntity) return;

    const hierarchyCb = new Cesium.CallbackProperty(() => {
      const pts = [...this.positions];
      if (this.hoverPosition) pts.push(this.hoverPosition);
      if (pts.length < 2) return undefined;
      return new Cesium.PolygonHierarchy(pts);
    }, false);

    this.previewEntity = this.ds.entities.add({
      name: "polygon-preview",
      polygon: {
        hierarchy: hierarchyCb as any,
        material:
          this.toolOpts.polygonMaterial ??
          new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.18)),
        outline: true,
        outlineColor: (this.toolOpts.outlineColor ?? Cesium.Color.CYAN).withAlpha(0.6),
      },
      properties: { __type: "polygon", __source: "preview" },
    });
  }

  protected onLeftClick(p: Cesium.Cartesian3): void {
    super.onLeftClick(Cesium.Cartesian3.clone(p));
  }

  protected commit(): void {
    const snapPositions = this.positions.map((p) => Cesium.Cartesian3.clone(p));
    const v = validatePolygonPositions(snapPositions);
    if (!v.ok) {
      const msg = v.issues[0]?.message ?? "几何校验失败";
      this.toolOpts.onNotice?.(`提交失败：${msg}`);
      return;
    }
    const feature = createPolygonFeature({ positions: snapPositions, name: "polygon" });
    this.stack.push(new AddFeatureCommand(this.store, feature));
  }

  clearAllCommitted() {
    if (this.store.size === 0) return;
    this.stack.push(new ClearAllFeaturesCommand(this.store));
  }

  // Kept for backwards compatibility; committed polygons now live in the feature layer.
  getCommittedEntities(): Cesium.Entity[] {
    return [];
  }
}

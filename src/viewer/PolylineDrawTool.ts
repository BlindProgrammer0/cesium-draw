import * as Cesium from "cesium";
import type { CommandStack } from "./commands/CommandStack";
import type { FeatureStore } from "../features/store";
import { createPolylineFeature } from "../features/types";
import { AddFeatureCommand } from "../features/commands";
import { validatePolylinePositions } from "../features/validation";
import type { PickService } from "./PickService";
import type { InteractionLock } from "./InteractionLock";
import { BaseDrawTool, type BaseDrawToolOptions, type DrawState } from "./draw/BaseDrawTool";

export type PolylineDrawState = DrawState;

export type PolylineDrawToolOptions = BaseDrawToolOptions & {
  lineColor?: Cesium.Color;
  lineWidth?: number;
};

export class PolylineDrawTool extends BaseDrawTool {
  private lineEntity: Cesium.Entity | null = null;

  constructor(
    viewer: Cesium.Viewer,
    interactionLock: InteractionLock,
    pick: PickService,
    stack: CommandStack,
    store: FeatureStore,
    private readonly toolOpts: PolylineDrawToolOptions = {}
  ) {
    super(viewer, interactionLock, pick, stack, store, toolOpts);
  }

  // Backwards-compat for ToolController
  getState() {
    return this.state;
  }

  protected minPoints(): number {
    return 2;
  }

  protected ensurePreviewEntity(): void {
    if (this.previewEntity) return;

    const positionsCb = new Cesium.CallbackProperty(() => {
      const pts = [...this.positions];
      if (this.hoverPosition) pts.push(this.hoverPosition);
      return pts;
    }, false);

    this.previewEntity = this.ds.entities.add({
      name: "polyline-preview",
      polyline: {
        positions: positionsCb as any,
        width: this.toolOpts.lineWidth ?? 3,
        material: new Cesium.ColorMaterialProperty(
          (this.toolOpts.lineColor ?? Cesium.Color.LIME).withAlpha(0.95)
        ),
      },
      properties: { __type: "polyline", __source: "preview" },
    });

    // Keep a ref for clarity (not strictly required)
    this.lineEntity = this.previewEntity;
  }

  protected onLeftClick(p: Cesium.Cartesian3): void {
    super.onLeftClick(Cesium.Cartesian3.clone(p));
  }

  protected commit(): void {
    const snapPositions = this.positions.map((p) => Cesium.Cartesian3.clone(p));
    const err = validatePolylinePositions(snapPositions);
    if (err) {
      this.toolOpts.onNotice?.(`提交失败：${err}`);
      return;
    }
    const feature = createPolylineFeature({ positions: snapPositions, name: "polyline" });
    this.stack.push(new AddFeatureCommand(this.store, feature));
  }

  protected cleanupPreview(): void {
    super.cleanupPreview();
    this.lineEntity = null;
  }
}

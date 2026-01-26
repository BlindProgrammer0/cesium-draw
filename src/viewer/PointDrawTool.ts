import * as Cesium from "cesium";
import type { CommandStack } from "./commands/CommandStack";
import type { FeatureStore } from "../features/store";
import { createPointFeature } from "../features/types";
import { AddFeatureCommand } from "../features/commands";
import { validatePointPosition } from "../features/validation";
import type { PickService } from "./PickService";
import type { InteractionLock } from "./InteractionLock";
import { BaseDrawTool, type BaseDrawToolOptions, type DrawState } from "./draw/BaseDrawTool";

export type PointDrawState = DrawState;

export type PointDrawToolOptions = BaseDrawToolOptions & {
  previewColor?: Cesium.Color;
  pixelSize?: number;
};

export class PointDrawTool extends BaseDrawTool {
  constructor(
    viewer: Cesium.Viewer,
    interactionLock: InteractionLock,
    pick: PickService,
    stack: CommandStack,
    store: FeatureStore,
    private readonly toolOpts: PointDrawToolOptions = {}
  ) {
    super(viewer, interactionLock, pick, stack, store, toolOpts);
  }

  // Backwards-compat for ToolController
  getState() {
    return this.state;
  }

  protected minPoints(): number {
    return 1;
  }

  protected ensurePreviewEntity(): void {
    if (this.previewEntity) return;

    const posCb = new Cesium.CallbackProperty(() => {
      // If user has clicked, show the fixed position; otherwise show hover.
      return this.positions[0] ?? this.hoverPosition ?? undefined;
    }, false);

    this.previewEntity = this.ds.entities.add({
      name: "point-preview",
      position: posCb as any,
      point: {
        pixelSize: this.toolOpts.pixelSize ?? 10,
        color: (this.toolOpts.previewColor ?? Cesium.Color.LIME).withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
      },
      properties: { __type: "point", __source: "preview" },
    });
  }

  protected onLeftClick(p: Cesium.Cartesian3): void {
    const cp = Cesium.Cartesian3.clone(p);
    // Point draw is single-point: replace rather than push.
    this.positions = [cp];
    this.clearPointEntities();
    this.addVertexVisual(cp);
    this.emitPoints();
  }

  // no undo for point
  override undoPoint(): void {
    // noop
  }

  protected commit(): void {
    const pos = this.positions[0] ?? null;
    const err = validatePointPosition(pos);
    if (err) {
      this.toolOpts.onNotice?.(`提交失败：${err}`);
      return;
    }

    const feature = createPointFeature({ position: Cesium.Cartesian3.clone(pos!), name: "point" });
    this.stack.push(new AddFeatureCommand(this.store, feature));
  }
}

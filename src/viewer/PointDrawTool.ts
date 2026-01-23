import * as Cesium from "cesium";
import { PickService } from "./PickService";
import type { CommandStack } from "./commands/CommandStack";
import type { FeatureStore } from "../features/store";
import { createPointFeature } from "../features/types";
import { AddFeatureCommand } from "../features/commands";
import { validatePointPosition } from "../features/validation";
import { SnappingEngine } from "./snap/SnappingEngine";
import { FeatureSpatialIndex } from "../features/spatial/FeatureSpatialIndex";

export type PointDrawState = "idle" | "drawing";

export type PointDrawToolOptions = {
  onNotice?: (msg: string) => void;
};

export class PointDrawTool {
  private handler: Cesium.ScreenSpaceEventHandler;
  private state: PointDrawState = "idle";

  private position: Cesium.Cartesian3 | null = null;
  private preview: Cesium.Entity | null = null;

  private index: FeatureSpatialIndex;
  private snapper: SnappingEngine;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly committedDs: Cesium.CustomDataSource,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly store: FeatureStore,
    private readonly opts?: PointDrawToolOptions
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    this.index = new FeatureSpatialIndex(store, { cellSizeMeters: 60 });
    this.snapper = new SnappingEngine(viewer, this.committedDs, this.index);
    this.snapper.configure({ thresholdPx: 14 });
    this.disable();
  }

  destroy() {
    this.disable();
    this.handler.destroy();
    this.index.destroy();
  }

  getState() {
    return this.state;
  }

  get pointCount() {
    return this.position ? 1 : 0;
  }

  start() {
    if (this.state === "drawing") return;
    this.state = "drawing";
    this.enable();
    this.ensurePreview();
  }

  finish() {
    if (this.state !== "drawing") return;
    const err = validatePointPosition(this.position);
    if (err) {
      this.opts?.onNotice?.(err);
      return;
    }
    const f = createPointFeature({ position: this.position! });
    this.stack.push(new AddFeatureCommand(this.store, f));
    this.cancel();
  }

  cancel() {
    this.state = "idle";
    this.position = null;
    if (this.preview) {
      this.viewer.entities.remove(this.preview);
      this.preview = null;
    }
    this.disable();
  }

  private ensurePreview() {
    if (this.preview) return;
    this.preview = this.viewer.entities.add(
      new Cesium.Entity({
        point: new Cesium.PointGraphics({
          color: Cesium.Color.LIME,
          pixelSize: 10,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        }),
      })
    );
  }

  private enable() {
    this.handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.state !== "drawing") return;
      const picked = this.pick.pickPosition(m.position);
      if (!picked) return;
      const snap = this.snapper.snap(picked, m.position as any);
      this.position = snap?.snappedPosition ?? picked;

      this.ensurePreview();
      this.preview!.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.clone(this.position)) as any;
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction(() => {
      if (this.state !== "drawing") return;
      this.finish();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }

  private disable() {
    this.handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this.handler.removeInputAction(Cesium.ScreenSpaceEventType.RIGHT_CLICK);
  }
}

import * as Cesium from "cesium";
import { PickService } from "./PickService";
import type { CommandStack } from "./commands/CommandStack";
import type { FeatureStore } from "../features/store";
import { createPolylineFeature } from "../features/types";
import { AddFeatureCommand } from "../features/commands";
import { validatePolylinePositions } from "../features/validation";
import { SnappingEngine } from "./snap/SnappingEngine";
import { FeatureSpatialIndex } from "../features/spatial/FeatureSpatialIndex";
import { InteractionLock } from "./InteractionLock";

export type PolylineDrawState = "idle" | "drawing";

export type PolylineDrawToolOptions = {
  onNotice?: (msg: string) => void;
};

export class PolylineDrawTool {
  private handler: Cesium.ScreenSpaceEventHandler;
  private state: PolylineDrawState = "idle";

  private positions: Cesium.Cartesian3[] = [];
  private polylineEntity: Cesium.Entity | null = null;
  private pointEntities: Cesium.Entity[] = [];

  private index: FeatureSpatialIndex;
  private snapper: SnappingEngine;

  private releaseDrawLock: (() => void) | null = null;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly committedDs: Cesium.CustomDataSource,
    private readonly pick: PickService,
    private readonly interactionLock: InteractionLock,
    private readonly stack: CommandStack,
    private readonly store: FeatureStore,
    private readonly opts?: PolylineDrawToolOptions
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    this.index = new FeatureSpatialIndex(store, { cellSizeMeters: 60 });
    this.snapper = new SnappingEngine(viewer, this.committedDs, this.index);
    this.snapper.configure({ thresholdPx: 14 });
    this.disable();
  }

  destroy() {
    this.cancel();
    this.handler.destroy();
    this.index.destroy();
  }

  getState() {
    return this.state;
  }

  get pointCount() {
    return this.positions.length;
  }

  start() {
    if (this.state === "drawing") return;
    this.state = "drawing";
    this.positions = [];
    this.clearPreview();
    this.enable();
    this.ensureLine();

    // Avoid right-drag translate conflicting with RIGHT_CLICK finish.
    if (!this.releaseDrawLock) {
      this.releaseDrawLock = this.interactionLock.acquire("draw", {
        enableTranslate: false,
      });
    }
  }

  undoPoint() {
    if (this.state !== "drawing") return;
    if (this.positions.length === 0) return;
    this.positions.pop();
    const last = this.pointEntities.pop();
    if (last) this.viewer.entities.remove(last);
  }

  finish() {
    if (this.state !== "drawing") return;
    const err = validatePolylinePositions(this.positions);
    if (err) {
      this.opts?.onNotice?.(err);
      return;
    }
    const f = createPolylineFeature({ positions: this.positions });
    this.stack.push(new AddFeatureCommand(this.store, f));
    this.cancel();
  }

  cancel() {
    this.state = "idle";
    this.positions = [];
    this.clearPreview();
    this.disable();

    if (this.releaseDrawLock) {
      const r = this.releaseDrawLock;
      this.releaseDrawLock = null;
      r();
    }
  }

  private ensureLine() {
    if (this.polylineEntity) return;
    this.polylineEntity = this.viewer.entities.add(
      new Cesium.Entity({
        polyline: new Cesium.PolylineGraphics({
          positions: new Cesium.CallbackProperty(() => this.positions, false) as any,
          width: 3,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.LIME),
        }),
      })
    );
  }

  private addPointVisual(p: Cesium.Cartesian3) {
    const e = this.viewer.entities.add(
      new Cesium.Entity({
        position: p,
        point: new Cesium.PointGraphics({
          color: Cesium.Color.LIME,
          pixelSize: 8,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        }),
      })
    );
    this.pointEntities.push(e);
  }

  private clearPreview() {
    if (this.polylineEntity) {
      this.viewer.entities.remove(this.polylineEntity);
      this.polylineEntity = null;
    }
    for (const e of this.pointEntities) this.viewer.entities.remove(e);
    this.pointEntities = [];
  }

  private enable() {
    this.handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.state !== "drawing") return;
      const picked = this.pick.pickPosition(m.position);
      if (!picked) return;

      const snap = this.snapper.snap(picked, m.position as any);
      const p = snap?.snappedPosition ?? picked;

      this.positions.push(Cesium.Cartesian3.clone(p));
      this.addPointVisual(Cesium.Cartesian3.clone(p));
      this.ensureLine();
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

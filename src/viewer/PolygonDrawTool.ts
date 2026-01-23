import * as Cesium from "cesium";
import { PickService } from "./PickService";
import type { CommandStack } from "./commands/CommandStack";
import { createPolygonFeature } from "../features/types";
import { AddFeatureCommand, ClearAllFeaturesCommand } from "../features/commands";
import type { FeatureStore } from "../features/store";
import { validatePolygonPositions } from "../features/validation";
import { InteractionLock } from "./InteractionLock";

export type PolygonDrawState = "idle" | "drawing" | "committed";

export type PolygonDrawToolOptions = {
  onNotice?: (msg: string) => void;

  polygonMaterial?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
  pointColor?: Cesium.Color;
};

type Listener = () => void;

export class PolygonDrawTool {
  public state: PolygonDrawState = "idle";

  private handler: Cesium.ScreenSpaceEventHandler | null = null;
  private positions: Cesium.Cartesian3[] = [];
  private hoverPosition: Cesium.Cartesian3 | null = null;

  private previewEntity: Cesium.Entity | null = null;
  private pointEntities: Cesium.Entity[] = [];

  readonly ds: Cesium.CustomDataSource;

  private onStateListeners: Listener[] = [];
  private onPointListeners: Listener[] = [];
  private onCommittedListeners: Listener[] = [];

  private releaseDrawLock: (() => void) | null = null;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly interactionLock: InteractionLock,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly store: FeatureStore,
    private readonly opts: PolygonDrawToolOptions = {},
  ) {
    this.ds = new Cesium.CustomDataSource("draw-layer");
    this.viewer.dataSources.add(this.ds);
  }

  get pointCount() { return this.positions.length; }
  get committedCount() { return this.store.size; }

  onStateChange(fn: Listener) { this.onStateListeners.push(fn); }
  onPointChange(fn: Listener) { this.onPointListeners.push(fn); }
  onCommittedChange(fn: Listener) { this.onCommittedListeners.push(fn); }

  private emitState() { for (const fn of this.onStateListeners) fn(); }
  private emitPoints() { for (const fn of this.onPointListeners) fn(); }
  private emitCommitted() { for (const fn of this.onCommittedListeners) fn(); }

  start() {
    if (this.state === "drawing") return;

    this.cancel();
    this.state = "drawing";
    this.emitState();

    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);

    // Avoid right-drag translate conflicting with RIGHT_CLICK finish.
    if (!this.releaseDrawLock) {
      this.releaseDrawLock = this.interactionLock.acquire("draw", {
        enableTranslate: false,
      });
    }

    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const p = this.pick.pickPosition(movement.position);
      if (!p) return;
      this.addPoint(p);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (this.state !== "drawing") return;
      this.hoverPosition = this.pick.pickPosition(movement.endPosition);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => this.finish(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    this.ensurePreviewEntity();
  }

  finish() {
    if (this.state !== "drawing") return;
    if (this.positions.length < 3) { alert("Polygon 至少需要 3 个点。"); return; }

    const snapPositions = this.positions.map((p) => Cesium.Cartesian3.clone(p));
    const feature = createPolygonFeature({ positions: snapPositions, name: "polygon" });
    const v = validatePolygonPositions(snapPositions);
    if (!v.ok) {
      const msg = v.issues[0]?.message ?? "几何校验失败";
      this.opts.onNotice?.(`提交失败：${msg}`);
      return;
    }
    this.stack.push(new AddFeatureCommand(this.store, feature));
    this.emitCommitted();

    this.cleanupPreview();
    this.positions = [];
    this.hoverPosition = null;
    this.clearPointEntities();
    this.detachHandler();

    if (this.releaseDrawLock) {
      const r = this.releaseDrawLock;
      this.releaseDrawLock = null;
      r();
    }

    this.state = "committed";
    this.emitState();
    this.emitPoints();

    setTimeout(() => {
      if (this.state === "committed") { this.state = "idle"; this.emitState(); }
    }, 250);
  }

  cancel() {
    this.cleanupPreview();
    this.positions = [];
    this.hoverPosition = null;
    this.clearPointEntities();
    this.detachHandler();
    this.state = "idle";

    if (this.releaseDrawLock) {
      const r = this.releaseDrawLock;
      this.releaseDrawLock = null;
      r();
    }
    this.emitState();
    this.emitPoints();
  }

  undoPoint() {
    if (this.state !== "drawing") return;
    if (this.positions.length === 0) return;

    this.positions.pop();
    const lastPt = this.pointEntities.pop();
    if (lastPt) this.ds.entities.remove(lastPt);
    this.emitPoints();
  }

  clearAllCommitted() {
    if (this.store.size === 0) return;
    this.stack.push(new ClearAllFeaturesCommand(this.store));
    this.emitCommitted();
  }

  // Kept for backwards compatibility; committed polygons now live in the feature layer.
  getCommittedEntities(): Cesium.Entity[] { return []; }

  private addPoint(p: Cesium.Cartesian3) {
    this.positions.push(p);
    const pt = this.ds.entities.add({
      position: p,
      point: {
        pixelSize: 8,
        color: this.opts.pointColor ?? Cesium.Color.YELLOW.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
      },
      properties: { __type: "vertex", __source: "temp" },
    });
    this.pointEntities.push(pt);
    this.emitPoints();
  }

  private ensurePreviewEntity() {
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
        material: this.opts.polygonMaterial ?? new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.18)),
        outline: true,
        outlineColor: (this.opts.outlineColor ?? Cesium.Color.CYAN).withAlpha(0.6),
      },
      properties: { __type: "polygon", __source: "preview" },
    });
  }

  private cleanupPreview() {
    if (!this.previewEntity) return;
    this.ds.entities.remove(this.previewEntity);
    this.previewEntity = null;
  }

  private clearPointEntities() {
    for (const e of this.pointEntities) this.ds.entities.remove(e);
    this.pointEntities = [];
  }

  private detachHandler() {
    if (!this.handler) return;
    this.handler.destroy();
    this.handler = null;
  }
}

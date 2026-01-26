import * as Cesium from "cesium";
import type { PickService } from "../PickService";
import type { CommandStack } from "../commands/CommandStack";
import type { FeatureStore } from "../../features/store";
import type { InteractionLock } from "../InteractionLock";

export type DrawState = "idle" | "drawing" | "committed";

export type BaseDrawToolOptions = {
  onNotice?: (msg: string) => void;
  pointColor?: Cesium.Color;
};

type Listener = () => void;

/**
 * BaseDrawTool
 *
 * A small, opinionated base class aligned with PolygonDrawTool's behavior:
 * - creates its own CustomDataSource for temporary drawing visuals
 * - LEFT_CLICK adds point(s)
 * - MOUSE_MOVE updates hover
 * - RIGHT_CLICK finishes
 * - drag-translate camera lock is handled via InteractionLock
 * - emits state/points/committed events for UI
 */
export abstract class BaseDrawTool {
  public state: DrawState = "idle";

  protected handler: Cesium.ScreenSpaceEventHandler | null = null;
  protected hoverPosition: Cesium.Cartesian3 | null = null;
  protected positions: Cesium.Cartesian3[] = [];

  protected previewEntity: Cesium.Entity | null = null;
  protected pointEntities: Cesium.Entity[] = [];

  readonly ds: Cesium.CustomDataSource;

  private onStateListeners: Listener[] = [];
  private onPointListeners: Listener[] = [];
  private onCommittedListeners: Listener[] = [];

  private releaseDrawLock: (() => void) | null = null;

  constructor(
    protected readonly viewer: Cesium.Viewer,
    protected readonly interactionLock: InteractionLock,
    protected readonly pick: PickService,
    protected readonly stack: CommandStack,
    protected readonly store: FeatureStore,
    protected readonly opts: BaseDrawToolOptions = {}
  ) {
    this.ds = new Cesium.CustomDataSource("draw-layer");
    this.viewer.dataSources.add(this.ds);
  }

  get pointCount() {
    return this.positions.length;
  }

  get committedCount() {
    return this.store.size;
  }

  onStateChange(fn: Listener) {
    this.onStateListeners.push(fn);
  }
  onPointChange(fn: Listener) {
    this.onPointListeners.push(fn);
  }
  onCommittedChange(fn: Listener) {
    this.onCommittedListeners.push(fn);
  }

  protected emitState() {
    for (const fn of this.onStateListeners) fn();
  }
  protected emitPoints() {
    for (const fn of this.onPointListeners) fn();
  }
  protected emitCommitted() {
    for (const fn of this.onCommittedListeners) fn();
  }

  /** Minimum required points before finish() can commit. */
  protected abstract minPoints(): number;

  /** Build or ensure the preview entity exists. */
  protected abstract ensurePreviewEntity(): void;

  /** Create a point visual for each committed vertex. */
  protected addVertexVisual(p: Cesium.Cartesian3) {
    const pt = this.ds.entities.add({
      position: p,
      point: {
        pixelSize: 8,
        color: (this.opts.pointColor ?? Cesium.Color.YELLOW).withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
      },
      properties: { __type: "vertex", __source: "temp" },
    });
    this.pointEntities.push(pt);
  }

  /** Called when LEFT_CLICK happens during drawing. Default: push a new point. */
  protected onLeftClick(p: Cesium.Cartesian3) {
    this.positions.push(p);
    this.addVertexVisual(p);
    this.emitPoints();
  }

  /** Called when MOUSE_MOVE happens during drawing. Default: update hover. */
  protected onMouseMove(p: Cesium.Cartesian3 | null) {
    this.hoverPosition = p;
  }

  /** Commit feature into store using CommandStack. */
  protected abstract commit(): void;

  /** Optional: undo last point. */
  undoPoint() {
    if (this.state !== "drawing") return;
    if (this.positions.length === 0) return;

    this.positions.pop();
    const lastPt = this.pointEntities.pop();
    if (lastPt) this.ds.entities.remove(lastPt);
    this.emitPoints();
  }

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
      this.onLeftClick(p);
      this.ensurePreviewEntity();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (this.state !== "drawing") return;
      const p = this.pick.pickPosition(movement.endPosition);
      this.onMouseMove(p);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    this.handler.setInputAction(() => this.finish(), Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    this.ensurePreviewEntity();
  }

  finish() {
    if (this.state !== "drawing") return;
    if (this.positions.length < this.minPoints()) {
      this.opts.onNotice?.(`至少需要 ${this.minPoints()} 个点。`);
      return;
    }

    this.commit();
    this.emitCommitted();

    this.cleanupTemp();

    this.state = "committed";
    this.emitState();

    setTimeout(() => {
      if (this.state === "committed") {
        this.state = "idle";
        this.emitState();
      }
    }, 250);
  }

  cancel() {
    this.cleanupTemp();
    this.state = "idle";
    this.emitState();
    this.emitPoints();
  }

  protected cleanupTemp() {
    this.positions = [];
    this.hoverPosition = null;
    this.cleanupPreview();
    this.clearPointEntities();
    this.detachHandler();

    if (this.releaseDrawLock) {
      const r = this.releaseDrawLock;
      this.releaseDrawLock = null;
      r();
    }
  }

  protected cleanupPreview() {
    if (!this.previewEntity) return;
    this.ds.entities.remove(this.previewEntity);
    this.previewEntity = null;
  }

  protected clearPointEntities() {
    for (const e of this.pointEntities) this.ds.entities.remove(e);
    this.pointEntities = [];
  }

  protected detachHandler() {
    if (!this.handler) return;
    this.handler.destroy();
    this.handler = null;
  }
}

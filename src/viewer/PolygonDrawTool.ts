import * as Cesium from "cesium";
import { PickService } from "./PickService";

export type PolygonDrawState = "idle" | "drawing" | "committed";

export type PolygonDrawToolOptions = {
  polygonMaterial?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
  pointColor?: Cesium.Color;
};

type Listener = () => void;

export class PolygonDrawTool {
  public state: PolygonDrawState = "idle";

  private handler: Cesium.ScreenSpaceEventHandler | null = null;

  // 当前正在绘制的点
  private positions: Cesium.Cartesian3[] = [];

  // 预览点（鼠标移动更新）
  private hoverPosition: Cesium.Cartesian3 | null = null;

  // 预览实体（动态 polygon）
  private previewEntity: Cesium.Entity | null = null;

  // 绘制过程中的点实体
  private pointEntities: Cesium.Entity[] = [];

  // 完成后提交的 polygon entities
  private committed: Cesium.Entity[] = [];

  private readonly ds: Cesium.CustomDataSource;

  private onStateListeners: Listener[] = [];
  private onPointListeners: Listener[] = [];

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly pick: PickService,
    private readonly opts: PolygonDrawToolOptions = {},
  ) {
    this.ds = new Cesium.CustomDataSource("draw-layer");
    this.viewer.dataSources.add(this.ds);
  }

  get pointCount() {
    return this.positions.length;
  }

  onStateChange(fn: Listener) {
    this.onStateListeners.push(fn);
  }

  onPointChange(fn: Listener) {
    this.onPointListeners.push(fn);
  }

  private emitState() {
    for (const fn of this.onStateListeners) fn();
  }
  private emitPoints() {
    for (const fn of this.onPointListeners) fn();
  }

  start() {
    if (this.state === "drawing") return;

    this.cancel(); // reset any existing drawing session
    this.state = "drawing";
    this.emitState();

    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);

    // 左键：加点
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const p = this.pick.pickPosition(movement.position);
      if (!p) return;
      this.addPoint(p);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 鼠标移动：更新预览点
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (this.state !== "drawing") return;
      const p = this.pick.pickPosition(movement.endPosition);
      this.hoverPosition = p;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 右键：结束
    this.handler.setInputAction(() => {
      this.finish();
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    this.ensurePreviewEntity();
  }

  finish() {
    if (this.state !== "drawing") return;

    if (this.positions.length < 3) {
      alert("Polygon 至少需要 3 个点。");
      return;
    }

    // 固化 polygon
    const entity = this.ds.entities.add({
      name: "polygon",
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy([...this.positions]),
        material: this.opts.polygonMaterial ?? new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
        outline: true,
        outlineColor: this.opts.outlineColor ?? Cesium.Color.CYAN.withAlpha(0.95),
      },
      properties: {
        __type: "polygon",
        __source: "committed",
      },
    });

    this.committed.push(entity);

    // 清理绘制态（但保留已提交图形）
    this.cleanupPreview();
    this.positions = [];
    this.hoverPosition = null;
    this.clearPointEntities();

    this.detachHandler();

    this.state = "committed";
    this.emitState();
    this.emitPoints();

    // 进入 committed 后可以继续 start 新绘制
    setTimeout(() => {
      // 保持状态可见一下
      if (this.state === "committed") {
        this.state = "idle";
        this.emitState();
      }
    }, 400);
  }

  cancel() {
    // 取消当前绘制（不影响已提交）
    this.cleanupPreview();
    this.positions = [];
    this.hoverPosition = null;
    this.clearPointEntities();
    this.detachHandler();
    this.state = "idle";
    this.emitState();
    this.emitPoints();
  }

  undo() {
    if (this.state !== "drawing") return;
    if (this.positions.length === 0) return;

    this.positions.pop();
    const lastPt = this.pointEntities.pop();
    if (lastPt) this.ds.entities.remove(lastPt);

    this.emitPoints();
  }

  clearAll() {
    this.cancel();
    for (const e of this.committed) this.ds.entities.remove(e);
    this.committed = [];
  }

  getCommittedEntities(): Cesium.Entity[] {
    return [...this.committed];
  }

  private addPoint(p: Cesium.Cartesian3) {
    this.positions.push(p);

    // 点实体
    const pt = this.ds.entities.add({
      position: p,
      point: {
        pixelSize: 8,
        color: this.opts.pointColor ?? Cesium.Color.YELLOW.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.NONE,
      },
      properties: {
        __type: "vertex",
        __source: "temp",
      },
    });
    this.pointEntities.push(pt);

    this.emitPoints();
  }

  private ensurePreviewEntity() {
    if (this.previewEntity) return;

    const hierarchyCb = new Cesium.CallbackProperty(() => {
      // 动态层级：positions + hoverPosition
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
      properties: {
        __type: "polygon",
        __source: "preview",
      },
    });
  }

  private cleanupPreview() {
    if (this.previewEntity) {
      this.ds.entities.remove(this.previewEntity);
      this.previewEntity = null;
    }
  }

  private clearPointEntities() {
    for (const e of this.pointEntities) this.ds.entities.remove(e);
    this.pointEntities = [];
  }

  private detachHandler() {
    if (this.handler) {
      this.handler.destroy();
      this.handler = null;
    }
  }
}

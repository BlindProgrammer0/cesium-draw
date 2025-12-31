import * as Cesium from "cesium";
import { PickService } from "../PickService";
import type { CommandStack } from "../commands/CommandStack";
import { RemovePolygonCommand, UpdatePolygonCommand, snapshotPolygonEntity } from "../commands/EntityCommands";

type Listener = () => void;

export class PolygonEditTool {
  private handler: Cesium.ScreenSpaceEventHandler;

  private selectedId: string | null = null;

  private handles: Cesium.Entity[] = [];
  private dragIndex: number | null = null;
  private dragBefore: Cesium.Cartesian3[] | null = null;

  private originalStyle = new Map<string, { material?: Cesium.MaterialProperty; outlineColor?: Cesium.Color }>();

  private listeners: Listener[] = [];

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly ds: Cesium.CustomDataSource,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly isDrawing: () => boolean,
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);

    // 单击：选中 polygon / 取消选中
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.isDrawing()) return;

      const entity = this.pick.pickEntity(movement.position);
      if (!entity) {
        this.deselect();
        return;
      }

      const props = entity.properties?.getValue(Cesium.JulianDate.now());
      if (props?.__type === "handle") return; // handle 不在 click 里处理

      const id = String(entity.id);
      const local = this.ds.entities.getById(id);
      if (!local || !local.polygon) {
        this.deselect();
        return;
      }
      this.select(id);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 按下：命中 handle -> 开始拖拽
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.isDrawing()) return;

      const entity = this.pick.pickEntity(movement.position);
      if (!entity) return;

      const props = entity.properties?.getValue(Cesium.JulianDate.now());
      if (!props || props.__type !== "handle") return;

      const ownerId = String(props.__ownerId);
      const index = Number(props.__index);
      if (!Number.isFinite(index)) return;

      if (this.selectedId !== ownerId) this.select(ownerId);

      const poly = this.ds.entities.getById(ownerId);
      const snap = poly ? snapshotPolygonEntity(poly) : null;
      if (!snap) return;

      this.dragIndex = index;
      this.dragBefore = snap.positions.map((p) => Cesium.Cartesian3.clone(p));

      // 拖动时禁用相机旋转（避免手感冲突）
      this.viewer.scene.screenSpaceCameraController.enableRotate = false;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // 移动：拖拽中更新顶点
    this.handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      if (this.isDrawing()) return;
      if (this.dragIndex === null || !this.selectedId) return;

      const p = this.pick.pickPosition(movement.endPosition);
      if (!p) return;

      this.applyVertexMove(this.dragIndex, p);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 抬起：结束拖拽，push UpdatePolygonCommand
    this.handler.setInputAction(() => {
      if (this.dragIndex === null || !this.selectedId) return;

      const poly = this.ds.entities.getById(this.selectedId);
      const afterSnap = poly ? snapshotPolygonEntity(poly) : null;

      const beforePositions = this.dragBefore;

      this.dragIndex = null;
      this.dragBefore = null;
      this.viewer.scene.screenSpaceCameraController.enableRotate = true;

      if (!poly || !afterSnap || !beforePositions) return;

      const beforeSnap = { ...afterSnap, positions: beforePositions.map((p) => Cesium.Cartesian3.clone(p)) };

      this.stack.push(new UpdatePolygonCommand(
        this.ds,
        this.selectedId,
        beforeSnap,
        afterSnap,
        () => this.refreshHandles(),
      ));
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    // 快捷键：Esc 取消选择；Delete 删除选择（可 Undo）
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.deselect();
      if ((e.key === "Delete" || e.key === "Backspace") && this.selectedId && !this.isDrawing()) {
        this.deleteSelected();
      }
    });
  }

  onChange(fn: Listener) { this.listeners.push(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  get selectedEntityId() { return this.selectedId; }

  select(id: string) {
    if (this.selectedId === id) return;

    this.deselect(false);

    const e = this.ds.entities.getById(id);
    if (!e?.polygon) {
      this.selectedId = null;
      this.emit();
      return;
    }

    // 保存原始样式
    if (!this.originalStyle.has(id)) {
      this.originalStyle.set(id, {
        material: e.polygon.material ?? undefined,
        outlineColor: e.polygon.outlineColor ?? undefined,
      });
    }

    // 高亮（只改 outline/material，不改几何）
    e.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW.withAlpha(0.22));
    e.polygon.outlineColor = Cesium.Color.YELLOW.withAlpha(0.95);

    this.selectedId = id;
    this.refreshHandles();
    this.emit();
  }

  deselect(emit = true) {
    if (this.selectedId) {
      // 恢复样式
      const e = this.ds.entities.getById(this.selectedId);
      const st = this.originalStyle.get(this.selectedId);
      if (e?.polygon && st) {
        if (st.material) e.polygon.material = st.material;
        if (st.outlineColor) e.polygon.outlineColor = st.outlineColor;
      }
    }

    this.selectedId = null;
    this.clearHandles();
    if (emit) this.emit();
  }

  deleteSelected() {
    if (!this.selectedId) return;
    const id = this.selectedId;
    this.deselect(false);

    this.stack.push(new RemovePolygonCommand(
      this.ds,
      id,
      () => { /* removed */ },
      () => { /* restored */ },
    ));

    this.emit();
  }

  /** 重新生成顶点 handles */
  refreshHandles() {
    this.clearHandles();
    if (!this.selectedId) return;

    const e = this.ds.entities.getById(this.selectedId);
    const snap = e ? snapshotPolygonEntity(e) : null;
    if (!snap) return;

    for (let i = 0; i < snap.positions.length; i++) {
      const p = snap.positions[i];
      const h = this.ds.entities.add({
        position: p,
        point: {
          pixelSize: 10,
          color: Cesium.Color.ORANGE.withAlpha(0.95),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          __type: "handle",
          __ownerId: this.selectedId,
          __index: i,
        },
      });
      this.handles.push(h);
    }
  }

  private clearHandles() {
    for (const h of this.handles) this.ds.entities.remove(h);
    this.handles = [];
  }

  private applyVertexMove(index: number, position: Cesium.Cartesian3) {
    if (!this.selectedId) return;

    const e = this.ds.entities.getById(this.selectedId);
    if (!e?.polygon?.hierarchy) return;

    const hierarchy = e.polygon.hierarchy.getValue(Cesium.JulianDate.now()) as Cesium.PolygonHierarchy | undefined;
    if (!hierarchy?.positions?.length) return;

    const positions = hierarchy.positions.map((p) => Cesium.Cartesian3.clone(p));
    if (index < 0 || index >= positions.length) return;

    positions[index] = Cesium.Cartesian3.clone(position);

    // 立即应用（实时预览）
    e.polygon.hierarchy = new Cesium.ConstantProperty(new Cesium.PolygonHierarchy(positions)) as any;

    // 同步 handle
    const handle = this.handles[index];
    if (handle) handle.position = Cesium.Cartesian3.clone(position) as any;
  }
}

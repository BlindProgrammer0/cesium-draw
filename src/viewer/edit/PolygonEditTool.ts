import * as Cesium from "cesium";
import { PickService } from "../PickService";
import type { CommandStack } from "../commands/CommandStack";
import {
  RemovePolygonCommand,
  UpdatePolygonCommand,
  snapshotPolygonEntity,
  clonePositions,
} from "../commands/EntityCommands";
import { SnappingEngine } from "../snap/SnappingEngine";
import { SnapIndicator } from "../snap/SnapIndicator";
import type { SnapSourcesEnabled, SnapTypesEnabled } from "../snap/SnapTypes";
import { defaultSnapSources, defaultSnapTypes } from "../snap/SnapTypes";

type Listener = () => void;
type DragMode = "none" | "vertex" | "translate";

type StyleSnapshot = {
  material?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

export class PolygonEditTool {
  private handler: Cesium.ScreenSpaceEventHandler;

  private selectedId: string | null = null;

  private handles: Cesium.Entity[] = [];
  private activeHandleIndex: number | null = null;

  private dragMode: DragMode = "none";
  private dragIndex: number | null = null;

  private dragBefore: Cesium.Cartesian3[] | null = null;
  private dragStartAnchor: Cesium.Cartesian3 | null = null;

  private originalStyle = new Map<string, StyleSnapshot>();
  private listeners: Listener[] = [];

  private snapEnabled = true;
  private snapThresholdPx = 12;

  private snapTypes: SnapTypesEnabled = defaultSnapTypes();
  private snapSources: SnapSourcesEnabled = defaultSnapSources();
  private gridSizeMeters = 5;

  private readonly snapping: SnappingEngine;
  private readonly snapIndicator: SnapIndicator;

  private readonly camera = this.viewer?.scene
    ?.screenSpaceCameraController as any; // only for field init safety

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly ds: Cesium.CustomDataSource,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly isDrawing: () => boolean
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);

    this.snapping = new SnappingEngine(this.viewer, this.ds);
    this.snapIndicator = new SnapIndicator(this.viewer);
    this.applySnapConfig();

    // 1) Ctrl + LeftDown：插入点（稳定，不依赖 LEFT_CLICK）
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;
        if (!this.selectedId) return;

        const inserted = this.tryInsertPoint(movement.position);
        if (inserted) return;

        // 若未插入成功，继续走普通选中逻辑：这里不做 return
        this.pickAndSelect(movement.position);
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.CTRL
    );

    // 2) 普通 LeftDown：选中 / 开始拖拽（顶点 or 平移）
    this.handler.setInputAction((movement: any) => {
      if (this.isDrawing()) return;

      if (this.dragMode === "none") {
        this.snapIndicator.hide();
      }

      const entity = this.pick.pickEntity(movement.position);
      if (!entity) {
        this.deselect();
        return;
      }

      // Ignore snap indicator entities.
      const ignoreProps = this.getProps(entity);
      if (ignoreProps?.__type === "snap-indicator") return;

      const props = this.getProps(entity);
      if (props?.__type === "snap-indicator") return;
      if (props?.__type === "handle") {
        this.beginVertexDrag(movement.position, props);
        return;
      }

      // Shift + drag on polygon：整体平移
      // 注意：这里依赖 movement.shiftKey 不可靠，所以改成用 modifier 方式注册一个 SHIFT 分支
      // 普通分支只负责选中
      const id = String(entity.id);
      const local = this.ds.entities.getById(id);
      if (!local?.polygon) {
        this.deselect();
        return;
      }
      this.select(id);
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    // 2.1) Shift + LeftDown：开始整体平移（用 modifier 可靠过滤）
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        const entity = this.pick.pickEntity(movement.position);
        if (!entity) return;

        const ignoreProps = this.getProps(entity);
        if (ignoreProps?.__type === "snap-indicator") return;

        const id = String(entity.id);
        const local = this.ds.entities.getById(id);
        if (!local?.polygon) return;

        if (this.selectedId !== id) this.select(id);

        const snap = snapshotPolygonEntity(local);
        if (!snap) return;

        const anchor = this.pick.pickPosition(movement.position);
        if (!anchor) return;

        this.dragMode = "translate";
        this.dragIndex = null;
        this.dragBefore = clonePositions(snap.positions);
        this.dragStartAnchor = Cesium.Cartesian3.clone(anchor);

        this.lockCamera();
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.SHIFT
    );

    // 3) MouseMove：拖拽更新
    this.handler.setInputAction((movement: any) => {
      if (this.isDrawing()) return;

      if (this.dragMode === "vertex") {
        if (this.dragIndex === null || !this.selectedId) return;

        const p = this.pick.pickPosition(movement.endPosition);
        if (!p) return;

        const snapped = this.snapEnabled
          ? this.snapWithEngine(p, movement.endPosition, {
              // do not snap to the polygon being edited
              excludeOwnerId: this.selectedId,
            })
          : p;

        // 仅更新一个顶点 + 对应 handle（不全量 refresh）
        this.applyVertexMove(this.dragIndex, snapped);
        return;
      }

      if (this.dragMode === "translate") {
        if (!this.selectedId || !this.dragStartAnchor || !this.dragBefore)
          return;

        const cur = this.pick.pickPosition(movement.endPosition);
        if (!cur) return;

        let delta = Cesium.Cartesian3.subtract(
          cur,
          this.dragStartAnchor,
          new Cesium.Cartesian3()
        );

        if (this.snapEnabled) {
          const snappedAnchor = this.snapWithEngine(cur, movement.endPosition, {
            excludeOwnerId: this.selectedId,
          });
          delta = Cesium.Cartesian3.subtract(
            snappedAnchor,
            this.dragStartAnchor,
            delta
          );
        }

        const next = this.dragBefore.map((p0) =>
          Cesium.Cartesian3.add(p0, delta, new Cesium.Cartesian3())
        );

        this.applyPositions(next);
        this.updateAllHandlePositions(next); // 增量更新 handle，不重建
      }

      // When idle, still update snap indicator for better GIS-like feedback.
      if (this.snapEnabled && this.selectedId) {
        const w = this.pick.pickPosition(movement.endPosition);
        if (!w) {
          this.snapIndicator.hide();
          return;
        }
        const res = this.snapping.snap(w, movement.endPosition, {
          excludeOwnerId: this.selectedId,
        });
        if (res) this.snapIndicator.show(res.candidate, w);
        else this.snapIndicator.hide();
      } else {
        this.snapIndicator.hide();
      }
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // 4) LeftUp：提交命令（如果发生拖拽）
    this.handler.setInputAction(() => {
      if (this.dragMode === "none" || !this.selectedId) return;

      const poly = this.ds.entities.getById(this.selectedId);
      const afterSnap = poly ? snapshotPolygonEntity(poly) : null;
      const beforePositions = this.dragBefore;

      // 先收敛状态（确保不会残留）
      this.dragMode = "none";
      this.dragIndex = null;
      this.dragBefore = null;
      this.dragStartAnchor = null;
      this.unlockCamera();

      if (!poly || !afterSnap || !beforePositions) return;

      const beforeSnap = {
        ...afterSnap,
        positions: clonePositions(beforePositions),
      };

      this.stack.push(
        new UpdatePolygonCommand(
          this.ds,
          this.selectedId,
          beforeSnap,
          afterSnap,
          () => {
            // 拖拽结束后再全量 refresh 一次，保证 handles 与 hierarchy 同步
            this.refreshHandles();
          }
        )
      );
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.deselect();
      if ((e.key === "Delete" || e.key === "Backspace") && !this.isDrawing()) {
        if (this.selectedId && this.activeHandleIndex !== null)
          this.deleteActiveVertex();
        else if (this.selectedId) this.deleteSelectedPolygon();
      }
    });
  }

  destroy() {
    this.handler?.destroy();
    this.snapIndicator?.destroy();
    // 需要时可移除 keydown 监听（这里略）
  }

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get selectedEntityId() {
    return this.selectedId;
  }
  get activeVertexIndex() {
    return this.activeHandleIndex;
  }

  setSnapEnabled(v: boolean) {
    this.snapEnabled = v;
    if (!v) this.snapIndicator.hide();
  }
  setSnapThresholdPx(v: number) {
    this.snapThresholdPx = Math.max(1, Math.min(64, Math.floor(v)));
    this.applySnapConfig();
  }
  getSnapEnabled() {
    return this.snapEnabled;
  }
  getSnapThresholdPx() {
    return this.snapThresholdPx;
  }

  setSnapTypes(next: Partial<SnapTypesEnabled>) {
    this.snapTypes = { ...this.snapTypes, ...next } as any;
    this.applySnapConfig();
  }
  getSnapTypes() {
    return { ...this.snapTypes };
  }
  setSnapSources(next: Partial<SnapSourcesEnabled>) {
    this.snapSources = { ...this.snapSources, ...next } as any;
    this.applySnapConfig();
  }
  getSnapSources() {
    return { ...this.snapSources };
  }
  setGridSizeMeters(v: number) {
    this.gridSizeMeters = Math.max(0.1, Math.min(5000, v));
    this.applySnapConfig();
  }
  getGridSizeMeters() {
    return this.gridSizeMeters;
  }

  setSnapIndicatorEnabled(v: boolean) {
    this.snapIndicator.setEnabled(v);
  }
  getSnapIndicatorEnabled() {
    return this.snapIndicator.getEnabled();
  }

  // ---------- selection ----------
  private pickAndSelect(screenPos: Cesium.Cartesian2) {
    const entity = this.pick.pickEntity(screenPos);
    if (!entity) {
      this.deselect();
      return;
    }

    const props = this.getProps(entity);
    if (props?.__type === "snap-indicator") return;
    if (props?.__type === "handle") {
      const ownerId = String(props.__ownerId);
      const idx = Number(props.__index);
      if (Number.isFinite(idx)) {
        if (this.selectedId !== ownerId) this.select(ownerId);
        this.setActiveHandle(idx);
      }
      this.emit();
      return;
    }

    const id = String(entity.id);
    const local = this.ds.entities.getById(id);
    if (!local?.polygon) {
      this.deselect();
      return;
    }
    this.select(id);
  }

  select(id: string) {
    if (this.selectedId === id) return;

    this.deselect(false);

    const e = this.ds.entities.getById(id);
    if (!e?.polygon) {
      this.selectedId = null;
      this.emit();
      return;
    }

    if (!this.originalStyle.has(id)) {
      this.originalStyle.set(id, {
        material: e.polygon.material ?? undefined,
        outlineColor: (e.polygon.outlineColor as any) ?? undefined,
      });
    }

    e.polygon.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.YELLOW.withAlpha(0.22)
    );
    e.polygon.outlineColor = new Cesium.ColorMaterialProperty(
      Cesium.Color.YELLOW.withAlpha(0.95)
    );

    this.selectedId = id;
    this.activeHandleIndex = null;
    this.refreshHandles();
    this.emit();
  }

  deselect(emit = true) {
    if (this.selectedId) {
      const e = this.ds.entities.getById(this.selectedId);
      const st = this.originalStyle.get(this.selectedId);
      if (e?.polygon && st) {
        if (st.material) e.polygon.material = st.material;
        if (st.outlineColor) e.polygon.outlineColor = st.outlineColor;
      }
    }
    this.selectedId = null;
    this.activeHandleIndex = null;
    this.clearHandles();
    this.snapIndicator.hide();
    if (emit) this.emit();
  }

  // ---------- delete ----------
  deleteSelectedPolygon() {
    if (!this.selectedId) return;
    const id = this.selectedId;
    this.deselect(false);
    this.stack.push(new RemovePolygonCommand(this.ds, id));
    this.emit();
  }

  deleteActiveVertex() {
    if (!this.selectedId || this.activeHandleIndex === null) return;

    const e = this.ds.entities.getById(this.selectedId);
    const snap = e ? snapshotPolygonEntity(e) : null;
    if (!snap) return;

    if (snap.positions.length <= 3) {
      alert("Polygon 至少需要 3 个顶点。");
      return;
    }

    const before = snap;
    const nextPositions = clonePositions(snap.positions).filter(
      (_, i) => i !== this.activeHandleIndex
    );
    const after = { ...snap, positions: nextPositions };

    this.applyPositions(after.positions);
    this.activeHandleIndex = null;

    this.stack.push(
      new UpdatePolygonCommand(this.ds, this.selectedId, before, after, () =>
        this.refreshHandles()
      )
    );
    this.emit();
  }

  // ---------- insert ----------
  tryInsertPoint(screenPos: Cesium.Cartesian2): boolean {
    if (!this.selectedId) return false;

    const e = this.ds.entities.getById(this.selectedId);
    const snap = e ? snapshotPolygonEntity(e) : null;
    if (!snap) return false;

    const picked = this.pick.pickPosition(screenPos);
    if (!picked) return false;

    const { ok, insertIndex, projected } = this.findClosestEdgeInsertion(
      snap.positions,
      picked,
      screenPos
    );
    if (!ok || insertIndex === null || !projected) return false;

    const before = snap;
    const next = clonePositions(snap.positions);
    next.splice(insertIndex, 0, projected);
    const after = { ...snap, positions: next };

    this.applyPositions(after.positions);
    this.setActiveHandle(insertIndex);

    this.stack.push(
      new UpdatePolygonCommand(this.ds, this.selectedId, before, after, () =>
        this.refreshHandles()
      )
    );
    return true;
  }

  // ---------- handles ----------
  refreshHandles() {
    this.clearHandles();
    if (!this.selectedId) return;

    const e = this.ds.entities.getById(this.selectedId);
    const snap = e ? snapshotPolygonEntity(e) : null;
    if (!snap) return;

    for (let i = 0; i < snap.positions.length; i++) {
      const p = snap.positions[i];
      const isActive = this.activeHandleIndex === i;

      const h = this.ds.entities.add({
        position: p,
        point: {
          pixelSize: isActive ? 12 : 10,
          color: (isActive ? Cesium.Color.RED : Cesium.Color.ORANGE).withAlpha(
            0.95
          ),
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

  private setActiveHandle(index: number) {
    this.activeHandleIndex = index;
    this.refreshHandles();
  }

  private updateAllHandlePositions(positions: Cesium.Cartesian3[]) {
    // 仅更新已有 handle 的 position，避免重建
    if (this.handles.length !== positions.length) {
      this.refreshHandles();
      return;
    }
    for (let i = 0; i < positions.length; i++) {
      const h = this.handles[i];
      if (h) h.position = Cesium.Cartesian3.clone(positions[i]) as any;
    }
  }

  // ---------- drag begin ----------
  private beginVertexDrag(screenPos: Cesium.Cartesian2, props: any) {
    const ownerId = String(props.__ownerId);
    const index = Number(props.__index);
    if (!Number.isFinite(index)) return;

    if (this.selectedId !== ownerId) this.select(ownerId);

    const poly = this.selectedId
      ? this.ds.entities.getById(this.selectedId)
      : null;
    const snap = poly ? snapshotPolygonEntity(poly) : null;
    if (!snap) return;

    this.dragMode = "vertex";
    this.dragIndex = index;
    this.dragBefore = clonePositions(snap.positions);
    this.dragStartAnchor = null;

    this.setActiveHandle(index);
    this.lockCamera();
  }

  // ---------- geometry apply ----------
  private applyVertexMove(index: number, position: Cesium.Cartesian3) {
    if (!this.selectedId) return;

    const e = this.ds.entities.getById(this.selectedId);
    if (!e?.polygon?.hierarchy) return;

    const hierarchy = e.polygon.hierarchy.getValue(Cesium.JulianDate.now()) as
      | Cesium.PolygonHierarchy
      | undefined;
    if (!hierarchy?.positions?.length) return;

    const positions = clonePositions(hierarchy.positions);
    if (index < 0 || index >= positions.length) return;

    positions[index] = Cesium.Cartesian3.clone(position);
    this.applyPositions(positions);

    const handle = this.handles[index];
    if (handle) handle.position = Cesium.Cartesian3.clone(position) as any;
  }

  private applyPositions(positions: Cesium.Cartesian3[]) {
    if (!this.selectedId) return;
    const e = this.ds.entities.getById(this.selectedId);
    if (!e?.polygon) return;

    e.polygon.hierarchy = new Cesium.ConstantProperty(
      new Cesium.PolygonHierarchy(clonePositions(positions))
    ) as any;
  }

  // ---------- snapping (stage 4) ----------
  private applySnapConfig() {
    this.snapping.configure({
      thresholdPx: this.snapThresholdPx,
      types: this.snapTypes,
      sources: this.snapSources,
      gridSizeMeters: this.gridSizeMeters,
    });
  }

  private snapWithEngine(
    candidate: Cesium.Cartesian3,
    cursorScreenPos: Cesium.Cartesian2,
    query?: { excludeOwnerId?: string }
  ): Cesium.Cartesian3 {
    this.applySnapConfig();
    const res = this.snapping.snap(candidate, cursorScreenPos, query);
    if (res) {
      this.snapIndicator.show(res.candidate, candidate);
      return Cesium.Cartesian3.clone(res.candidate.position);
    }
    this.snapIndicator.hide();
    return candidate;
  }

  // ---------- edge insertion ----------
  private findClosestEdgeInsertion(
    positions: Cesium.Cartesian3[],
    picked: Cesium.Cartesian3,
    cursorScreenPos: Cesium.Cartesian2
  ): {
    ok: boolean;
    insertIndex: number | null;
    projected: Cesium.Cartesian3 | null;
  } {
    if (positions.length < 2)
      return { ok: false, insertIndex: null, projected: null };

    const scene = this.viewer.scene;
    let best: {
      edgeStart: number;
      distPx: number;
      proj: Cesium.Cartesian3;
    } | null = null;

    const n = positions.length;
    for (let i = 0; i < n; i++) {
      const a = positions[i];
      const b = positions[(i + 1) % n];

      const a2 = scene.cartesianToCanvasCoordinates(a);
      const b2 = scene.cartesianToCanvasCoordinates(b);
      if (!a2 || !b2) continue;

      const dPx = distancePointToSegment2D(cursorScreenPos, a2, b2);
      if (dPx > this.snapThresholdPx * 2) continue;

      const proj = closestPointOnSegment3D(picked, a, b);
      if (!best || dPx < best.distPx)
        best = { edgeStart: i, distPx: dPx, proj };
    }

    if (!best) return { ok: false, insertIndex: null, projected: null };
    return { ok: true, insertIndex: best.edgeStart + 1, projected: best.proj };
  }

  // ---------- helpers ----------
  private getProps(entity: Cesium.Entity) {
    return entity.properties?.getValue(Cesium.JulianDate.now());
  }

  private lockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = false;
    c.enableTranslate = false;
    c.enableZoom = false;
    c.enableTilt = false;
    c.enableLook = false;
  }

  private unlockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = true;
    c.enableTranslate = true;
    c.enableZoom = true;
    c.enableTilt = true;
    c.enableLook = true;
  }
}

// 下面这两个函数沿用你原来的即可
function distancePointToSegment2D(
  p: Cesium.Cartesian2,
  a: Cesium.Cartesian2,
  b: Cesium.Cartesian2
): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);

  const t = c1 / c2;
  const px = a.x + t * vx;
  const py = a.y + t * vy;
  return Math.hypot(p.x - px, p.y - py);
}

function closestPointOnSegment3D(
  p: Cesium.Cartesian3,
  a: Cesium.Cartesian3,
  b: Cesium.Cartesian3
): Cesium.Cartesian3 {
  const ab = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
  const ap = Cesium.Cartesian3.subtract(p, a, new Cesium.Cartesian3());
  const ab2 = Cesium.Cartesian3.dot(ab, ab);
  if (ab2 <= 1e-12) return Cesium.Cartesian3.clone(a);

  let t = Cesium.Cartesian3.dot(ap, ab) / ab2;
  t = Math.max(0, Math.min(1, t));
  return Cesium.Cartesian3.add(
    a,
    Cesium.Cartesian3.multiplyByScalar(ab, t, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
}

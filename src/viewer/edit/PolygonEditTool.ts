import * as Cesium from "cesium";
import type { CesiumFeatureLayer } from "../../features/CesiumFeatureLayer";
import type { FeatureStore } from "../../features/store";
import { clonePositions } from "../../features/types";
import {
  RemoveFeatureCommand,
  UpdateFeatureCommand,
  snapshotFeature,
} from "../../features/commands";
import { PickService } from "../PickService";
import type { CommandStack } from "../commands/CommandStack";
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

  private overlayDs: Cesium.CustomDataSource;
  private handles: Cesium.Entity[] = [];
  private activeHandleIndex: number | null = null;

  private dragMode: DragMode = "none";
  private dragIndex: number | null = null;

  private dragBeforePositions: Cesium.Cartesian3[] | null = null;
  private dragBeforeFeature: any | null = null;
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

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly layer: CesiumFeatureLayer,
    private readonly store: FeatureStore,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly isDrawing: () => boolean
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);
    this.overlayDs = new Cesium.CustomDataSource("edit-overlay");
    this.viewer.dataSources.add(this.overlayDs);

    this.snapping = new SnappingEngine(this.viewer, this.layer.ds);
    this.snapIndicator = new SnapIndicator(this.viewer);
    this.applySnapConfig();

    // keep handles in sync on undo/redo via store events
    this.store.onChange((evt) => {
      if (!this.selectedId) return;
      if (evt.type === "upsert" && evt.feature.id === this.selectedId) {
        this.refreshHandles();
        this.emit();
      }
      if (evt.type === "remove" && evt.id === this.selectedId) {
        this.deselect();
      }
      if (evt.type === "clear") {
        this.deselect();
      }
    });

    // 1) Ctrl + LeftDown：插入点
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;
        if (!this.selectedId) return;

        const inserted = this.tryInsertPoint(movement.position);
        if (inserted) return;

        // fallback to pick/select
        this.pickAndSelect(movement.position);
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.CTRL
    );

    // 2) 普通 LeftDown：选中 / 开始拖拽（顶点）
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        if (this.dragMode === "none") this.snapIndicator.hide();

        const entity = this.pick.pickEntity(movement.position);
        if (!entity) {
          this.deselect();
          return;
        }

        const props = this.getProps(entity);
        if (props?.__type === "snap-indicator") return;

        if (props?.__type === "handle") {
          this.beginVertexDrag(movement.position, props);
          return;
        }

        // committed polygon
        const fid = props?.__featureId;
        if (typeof fid === "string") {
          this.select(fid);
          return;
        }

        this.deselect();
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN
    );

    // 2.1) Shift + LeftDown：开始整体平移
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        const fid = this.pick.pickFeatureId(movement.position);
        if (!fid) return;

        if (this.selectedId !== fid) this.select(fid);

        const feat = this.store.getPolygon(fid);
        if (!feat) return;

        const anchor = this.pick.pickPosition(movement.position);
        if (!anchor) return;

        this.dragMode = "translate";
        this.dragIndex = null;
        this.dragBeforePositions = clonePositions(feat.geometry.positions);
        this.dragBeforeFeature = snapshotFeature(feat);
        this.dragStartAnchor = Cesium.Cartesian3.clone(anchor);
        this.lockCamera();
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.SHIFT
    );

    // 3) MouseMove：拖拽更新
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        if (this.dragMode === "vertex") {
          if (this.dragIndex === null || !this.selectedId) return;

          const p = this.pick.pickPosition(movement.endPosition);
          if (!p) return;

          const snapped = this.snapEnabled
            ? this.snapWithEngine(p, movement.endPosition, {
                excludeOwnerId: this.selectedId,
                excludeIndex: this.dragIndex,
              })
            : p;

          this.applyVertexMove(this.dragIndex, snapped);
          return;
        }

        if (this.dragMode === "translate") {
          if (
            !this.selectedId ||
            !this.dragStartAnchor ||
            !this.dragBeforePositions
          )
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

          const next = this.dragBeforePositions.map((p0) =>
            Cesium.Cartesian3.add(p0, delta, new Cesium.Cartesian3())
          );

          this.applyPositions(next);
          this.updateAllHandlePositions(next);
        }

        // idle: show snap indicator
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
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE
    );

    // 4) LeftUp：提交命令（如果发生拖拽）
    this.handler.setInputAction(() => {
      if (this.dragMode === "none" || !this.selectedId) return;

      const id = this.selectedId;
      const before = this.dragBeforeFeature;
      const after = this.store.get(id);

      // reset state first
      this.dragMode = "none";
      this.dragIndex = null;
      this.dragBeforePositions = null;
      this.dragBeforeFeature = null;
      this.dragStartAnchor = null;
      this.unlockCamera();

      if (!before || !after) return;
      this.stack.push(new UpdateFeatureCommand(this.store, id, before, snapshotFeature(after)));
      this.refreshHandles();
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

    const fid = props?.__featureId;
    if (typeof fid === "string") {
      this.select(fid);
      return;
    }

    this.deselect();
  }

  select(id: string) {
    if (this.selectedId === id) return;

    this.deselect(false);

    const e = this.layer.getEntity(id);
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
      const e = this.layer.getEntity(this.selectedId);
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
    this.stack.push(new RemoveFeatureCommand(this.store, id));
    this.emit();
  }

  deleteActiveVertex() {
    if (!this.selectedId || this.activeHandleIndex === null) return;

    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return;

    if (feat.geometry.positions.length <= 3) {
      alert("Polygon 至少需要 3 个顶点。");
      return;
    }

    const before = snapshotFeature(feat);
    const nextPositions = clonePositions(feat.geometry.positions).filter(
      (_, i) => i !== this.activeHandleIndex
    );
    const after = {
      ...feat,
      geometry: { ...feat.geometry, positions: nextPositions },
      meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
    } as any;

    // apply live then commit cmd
    this.store.upsert(after);
    this.activeHandleIndex = null;
    this.stack.push(
      new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
    );
    this.refreshHandles();
    this.emit();
  }

  // ---------- insert ----------
  tryInsertPoint(screenPos: Cesium.Cartesian2): boolean {
    if (!this.selectedId) return false;

    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return false;

    const picked = this.pick.pickPosition(screenPos);
    if (!picked) return false;

    const { ok, insertIndex, projected } = this.findClosestEdgeInsertion(
      feat.geometry.positions,
      picked,
      screenPos
    );
    if (!ok || insertIndex === null || !projected) return false;

    const before = snapshotFeature(feat);
    const next = clonePositions(feat.geometry.positions);
    next.splice(insertIndex, 0, projected);
    const after = {
      ...feat,
      geometry: { ...feat.geometry, positions: next },
      meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
    } as any;

    this.store.upsert(after);
    this.setActiveHandle(insertIndex);
    this.stack.push(
      new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
    );
    this.refreshHandles();
    return true;
  }

  // ---------- handles ----------
  refreshHandles() {
    this.clearHandles();
    if (!this.selectedId) return;

    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return;

    for (let i = 0; i < feat.geometry.positions.length; i++) {
      const p = feat.geometry.positions[i];
      const isActive = this.activeHandleIndex === i;

      const h = this.overlayDs.entities.add({
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
    for (const h of this.handles) this.overlayDs.entities.remove(h);
    this.handles = [];
  }

  private setActiveHandle(index: number) {
    this.activeHandleIndex = index;
    this.refreshHandles();
  }

  private updateAllHandlePositions(positions: Cesium.Cartesian3[]) {
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
    if (!this.selectedId) return;

    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return;

    this.dragMode = "vertex";
    this.dragIndex = index;
    this.dragBeforePositions = clonePositions(feat.geometry.positions);
    this.dragBeforeFeature = snapshotFeature(feat);
    this.dragStartAnchor = null;

    this.setActiveHandle(index);
    this.lockCamera();
  }

  // ---------- geometry apply ----------
  private applyVertexMove(index: number, position: Cesium.Cartesian3) {
    if (!this.selectedId) return;
    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return;
    const positions = clonePositions(feat.geometry.positions);
    if (index < 0 || index >= positions.length) return;
    positions[index] = Cesium.Cartesian3.clone(position);
    this.applyPositions(positions);
    const handle = this.handles[index];
    if (handle) handle.position = Cesium.Cartesian3.clone(position) as any;
  }

  private applyPositions(positions: Cesium.Cartesian3[]) {
    if (!this.selectedId) return;
    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return;
    const next = {
      ...feat,
      geometry: { ...feat.geometry, positions: clonePositions(positions) },
      meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
    } as any;
    this.store.upsert(next);
  }

  // ---------- snapping ----------
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
    query?: { excludeOwnerId?: string; excludeIndex?: number }
  ): Cesium.Cartesian3 {
    this.applySnapConfig();
    const res = this.snapping.snap(candidate, cursorScreenPos, query as any);
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

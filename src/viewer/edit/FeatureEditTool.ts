import * as Cesium from "cesium";
import type { CesiumFeatureLayer } from "../../features/CesiumFeatureLayer";
import type { FeatureStore } from "../../features/store";
import {
  RemoveFeatureCommand,
  UpdateFeatureCommand,
  snapshotFeature,
} from "../../features/commands";
import { clonePosition, clonePositions } from "../../features/types";
import { validatePointPosition } from "../../features/validation/point";
import { validatePolylinePositions } from "../../features/validation/polyline";
import { validatePolygonPositions } from "../../features/validation/polygon";
import { FeatureSpatialIndex } from "../../features/spatial/FeatureSpatialIndex";
import { PickService } from "../PickService";
import type { CommandStack } from "../commands/CommandStack";
import { SnapIndicator } from "../snap/SnapIndicator";
import { SnappingEngine } from "../snap/SnappingEngine";
import type { SnapSourcesEnabled, SnapTypesEnabled } from "../snap/SnapTypes";
import { defaultSnapSources, defaultSnapTypes } from "../snap/SnapTypes";

export type FeatureEditToolOptions = {
  onNotice?: (msg: string) => void;
};

type Listener = () => void;

type DragMode = "none" | "vertex" | "translate";

type StyleSnapshot = {
  polygonMaterial?: Cesium.MaterialProperty;
  polygonOutlineColor?: Cesium.Color;
  polylineMaterial?: Cesium.MaterialProperty;
  polylineWidth?: number;
  pointColor?: Cesium.Color;
  pointPixelSize?: number;
};

/**
 * Stage 6.2: unified edit tool for point / polyline / polygon.
 *
 * Notes:
 * - Keeps the Stage 5.4 edit-transaction design: preview during drag, commit once on LEFT_UP.
 * - Reuses SnappingEngine + SnapIndicator.
 * - Handles are rendered into a dedicated overlay data source.
 */
export class FeatureEditTool {
  private handler: Cesium.ScreenSpaceEventHandler;

  private selectedId: string | null = null;
  private selectedKind: "point" | "polyline" | "polygon" | null = null;

  private overlayDs: Cesium.CustomDataSource;
  private handles: Cesium.Entity[] = [];
  private activeHandleIndex: number | null = null;

  private dragMode: DragMode = "none";
  private dragIndex: number | null = null;

  private dragBeforePositions: Cesium.Cartesian3[] | null = null;
  private dragBeforePosition: Cesium.Cartesian3 | null = null;
  private dragBeforeFeature: any | null = null;
  private dragStartAnchor: Cesium.Cartesian3 | null = null;

  private dragPreviewPositions: Cesium.Cartesian3[] | null = null;
  private dragPreviewPosition: Cesium.Cartesian3 | null = null;

  private originalStyle = new Map<string, StyleSnapshot>();
  private listeners: Listener[] = [];

  private snapEnabled = true;
  private snapThresholdPx = 12;

  private snapTypes: SnapTypesEnabled = defaultSnapTypes();
  private snapSources: SnapSourcesEnabled = defaultSnapSources();
  private gridSizeMeters = 5;

  private readonly snapping: SnappingEngine;
  private readonly snapIndicator: SnapIndicator;
  private readonly spatialIndex: FeatureSpatialIndex;

  constructor(
    private readonly viewer: Cesium.Viewer,
    private readonly layer: CesiumFeatureLayer,
    private readonly store: FeatureStore,
    private readonly pick: PickService,
    private readonly stack: CommandStack,
    private readonly isDrawing: () => boolean,
    private readonly opts: FeatureEditToolOptions = {}
  ) {
    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);
    this.overlayDs = new Cesium.CustomDataSource("edit-overlay");
    this.viewer.dataSources.add(this.overlayDs);

    this.spatialIndex = new FeatureSpatialIndex(this.store, { cellSizeMeters: 50 });
    this.snapping = new SnappingEngine(this.viewer, this.layer.ds, this.spatialIndex);
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

    // Ctrl + LeftDown: insert point on polyline/polygon
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;
        if (!this.selectedId || !this.selectedKind) return;

        const inserted =
          this.selectedKind === "polygon"
            ? this.tryInsertPointOnPolygon(movement.position)
            : this.selectedKind === "polyline"
              ? this.tryInsertPointOnPolyline(movement.position)
              : false;
        if (inserted) return;

        // fallback pick/select
        this.pickAndSelect(movement.position);
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.CTRL
    );

    // Normal LeftDown: select / start vertex drag / point drag
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
          this.beginHandleDrag(movement.position, props);
          return;
        }

        const fid = props?.__featureId;
        if (typeof fid === "string") {
          this.select(fid);
          return;
        }

        this.deselect();
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN
    );

    // Shift + LeftDown: translate polyline/polygon (and point as well)
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        const fid = this.pick.pickFeatureId(movement.position);
        if (!fid) return;

        if (this.selectedId !== fid) this.select(fid);
        if (!this.selectedId || !this.selectedKind) return;

        const anchor = this.pick.pickPosition(movement.position);
        if (!anchor) return;

        if (this.selectedKind === "polygon") {
          const feat = this.store.getPolygon(fid);
          if (!feat) return;
          this.dragMode = "translate";
          this.dragIndex = null;
          this.dragBeforePositions = clonePositions(feat.geometry.positions);
          this.dragBeforeFeature = snapshotFeature(feat);
          this.dragStartAnchor = Cesium.Cartesian3.clone(anchor);
          this.lockCamera();
          return;
        }

        if (this.selectedKind === "polyline") {
          const feat = this.store.getPolyline(fid);
          if (!feat) return;
          this.dragMode = "translate";
          this.dragIndex = null;
          this.dragBeforePositions = clonePositions(feat.geometry.positions);
          this.dragBeforeFeature = snapshotFeature(feat);
          this.dragStartAnchor = Cesium.Cartesian3.clone(anchor);
          this.lockCamera();
          return;
        }

        if (this.selectedKind === "point") {
          const feat = this.store.getPoint(fid);
          if (!feat) return;
          this.dragMode = "translate";
          this.dragIndex = null;
          this.dragBeforePosition = Cesium.Cartesian3.clone(feat.geometry.position);
          this.dragBeforeFeature = snapshotFeature(feat);
          this.dragStartAnchor = Cesium.Cartesian3.clone(anchor);
          this.lockCamera();
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
      Cesium.KeyboardEventModifier.SHIFT
    );

    // MouseMove: drag preview + idle snap indicator
    this.handler.setInputAction(
      (movement: any) => {
        if (this.isDrawing()) return;

        if (this.dragMode === "vertex") {
          if (!this.selectedId || !this.selectedKind) return;
          if (this.dragIndex === null) return;

          const p = this.pick.pickPosition(movement.endPosition);
          if (!p) return;

          const snapped = this.snapEnabled
            ? this.snapWithEngine(p, movement.endPosition, {
                excludeOwnerId: this.selectedId,
                excludeIndex: this.selectedKind === "point" ? undefined : this.dragIndex,
              })
            : p;

          if (this.selectedKind === "point") {
            this.applyPointMovePreview(snapped);
          } else {
            this.applyVertexMovePreview(this.dragIndex, snapped);
          }
          return;
        }

        if (this.dragMode === "translate") {
          if (!this.selectedId || !this.selectedKind || !this.dragStartAnchor)
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

          if (this.selectedKind === "point") {
            if (!this.dragBeforePosition) return;
            const next = Cesium.Cartesian3.add(
              this.dragBeforePosition,
              delta,
              new Cesium.Cartesian3()
            );
            this.applyPointMovePreview(next);
            return;
          }

          if (!this.dragBeforePositions) return;
          const next = this.dragBeforePositions.map((p0) =>
            Cesium.Cartesian3.add(p0, delta, new Cesium.Cartesian3())
          );
          this.applyPositionsPreview(next);
          this.updateAllHandlePositions(next);
          return;
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

    // LeftUp: commit drag transaction
    this.handler.setInputAction(() => {
      if (this.dragMode === "none" || !this.selectedId || !this.selectedKind) return;

      const id = this.selectedId;
      const kind = this.selectedKind;
      const before = this.dragBeforeFeature;
      const afterPositions = this.dragPreviewPositions;
      const afterPosition = this.dragPreviewPosition;

      // reset state first
      this.dragMode = "none";
      this.dragIndex = null;
      this.dragBeforePositions = null;
      this.dragBeforePosition = null;
      this.dragBeforeFeature = null;
      this.dragStartAnchor = null;
      this.dragPreviewPositions = null;
      this.dragPreviewPosition = null;
      this.unlockCamera();

      if (!before) return;

      if (kind === "point") {
        if (!afterPosition) return;
        const err = validatePointPosition(afterPosition);
        if (err) {
          this.opts.onNotice?.(`编辑提交失败：${err}`);
          this.store.upsert(before);
          this.refreshHandles();
          return;
        }
        const after = {
          ...before,
          id,
          kind: "point",
          geometry: { ...before.geometry, position: Cesium.Cartesian3.clone(afterPosition) },
          meta: before.meta ? { ...before.meta, updatedAt: Date.now() } : before.meta,
        } as any;
        this.stack.push(new UpdateFeatureCommand(this.store, id, before, snapshotFeature(after)));
        this.refreshHandles();
        return;
      }

      if (!afterPositions) return;
      const err =
        kind === "polygon"
          ? validatePolygonPositions(afterPositions).ok
            ? null
            : validatePolygonPositions(afterPositions).issues[0]?.message ?? "几何校验失败"
          : validatePolylinePositions(afterPositions);

      if (err) {
        this.opts.onNotice?.(`编辑提交失败：${err}`);
        this.store.upsert(before);
        this.refreshHandles();
        return;
      }

      const after = {
        ...before,
        id,
        kind,
        geometry: { ...before.geometry, positions: clonePositions(afterPositions) },
        meta: before.meta ? { ...before.meta, updatedAt: Date.now() } : before.meta,
      } as any;
      this.stack.push(new UpdateFeatureCommand(this.store, id, before, snapshotFeature(after)));
      this.refreshHandles();
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.deselect();
      if ((e.key === "Delete" || e.key === "Backspace") && !this.isDrawing()) {
        if (this.selectedId && this.activeHandleIndex !== null) {
          this.deleteActiveVertex();
        } else if (this.selectedId) {
          this.deleteSelected();
        }
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
  get selectedEntityKind() {
    return this.selectedKind;
  }
  get activeVertexIndex() {
    return this.activeHandleIndex;
  }

  // ---------- snap config ----------
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

  private applySnapConfig() {
    this.snapping.setThresholdPx(this.snapThresholdPx);
    this.snapping.setTypes(this.snapTypes);
    this.snapping.setSources(this.snapSources);
    this.snapping.setGridSizeMeters(this.gridSizeMeters);
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

    const feature = this.store.get(id);
    if (!feature) {
      this.selectedId = null;
      this.selectedKind = null;
      this.emit();
      return;
    }

    const e = this.layer.getEntity(id);
    if (!e) {
      this.selectedId = null;
      this.selectedKind = null;
      this.emit();
      return;
    }

    if (!this.originalStyle.has(id)) {
      this.originalStyle.set(id, {
        polygonMaterial: e.polygon?.material ?? undefined,
        polygonOutlineColor: (e.polygon?.outlineColor as any) ?? undefined,
        polylineMaterial: e.polyline?.material ?? undefined,
        polylineWidth: e.polyline?.width ?? undefined,
        pointColor: e.point?.color ?? undefined,
        pointPixelSize: e.point?.pixelSize ?? undefined,
      });
    }

    // apply highlight
    if (feature.kind === "polygon" && e.polygon) {
      e.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.YELLOW.withAlpha(0.22)
      );
      e.polygon.outlineColor = new Cesium.ColorMaterialProperty(
        Cesium.Color.YELLOW.withAlpha(0.95)
      );
    }
    if (feature.kind === "polyline" && e.polyline) {
      e.polyline.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.YELLOW.withAlpha(0.95)
      );
      e.polyline.width = 4;
    }
    if (feature.kind === "point" && e.point) {
      e.point.color = new Cesium.ConstantProperty(Cesium.Color.YELLOW);
      e.point.pixelSize = new Cesium.ConstantProperty(12);
    }

    this.selectedId = id;
    this.selectedKind = feature.kind;
    this.activeHandleIndex = null;
    this.refreshHandles();
    this.emit();
  }

  deselect(emit = true) {
    if (this.selectedId) {
      const e = this.layer.getEntity(this.selectedId);
      const st = this.originalStyle.get(this.selectedId);
      if (e && st) {
        if (e.polygon) {
          if (st.polygonMaterial) e.polygon.material = st.polygonMaterial;
          if (st.polygonOutlineColor) e.polygon.outlineColor = st.polygonOutlineColor;
        }
        if (e.polyline) {
          if (st.polylineMaterial) e.polyline.material = st.polylineMaterial;
          if (typeof st.polylineWidth === "number") e.polyline.width = st.polylineWidth;
        }
        if (e.point) {
          if (st.pointColor) e.point.color = st.pointColor;
          if (typeof st.pointPixelSize === "number") e.point.pixelSize = st.pointPixelSize;
        }
      }
    }

    this.selectedId = null;
    this.selectedKind = null;
    this.activeHandleIndex = null;
    this.clearHandles();
    this.snapIndicator.hide();
    if (emit) this.emit();
  }

  // ---------- delete ----------
  deleteSelected() {
    if (!this.selectedId) return;
    const id = this.selectedId;
    this.deselect(false);
    this.stack.push(new RemoveFeatureCommand(this.store, id));
    this.emit();
  }

  deleteActiveVertex() {
    if (!this.selectedId || !this.selectedKind || this.activeHandleIndex === null) return;

    if (this.selectedKind === "point") return;

    if (this.selectedKind === "polygon") {
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
      const v = validatePolygonPositions(nextPositions);
      if (!v.ok) {
        const msg = v.issues[0]?.message ?? "几何校验失败";
        this.opts.onNotice?.(`删点失败：${msg}`);
        return;
      }
      const after = {
        ...feat,
        geometry: { ...feat.geometry, positions: nextPositions },
        meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
      } as any;
      this.activeHandleIndex = null;
      this.stack.push(
        new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
      );
      this.refreshHandles();
      this.emit();
      return;
    }

    if (this.selectedKind === "polyline") {
      const feat = this.store.getPolyline(this.selectedId);
      if (!feat) return;
      if (feat.geometry.positions.length <= 2) {
        alert("Polyline 至少需要 2 个点。");
        return;
      }
      const before = snapshotFeature(feat);
      const nextPositions = clonePositions(feat.geometry.positions).filter(
        (_, i) => i !== this.activeHandleIndex
      );
      const err = validatePolylinePositions(nextPositions);
      if (err) {
        this.opts.onNotice?.(`删点失败：${err}`);
        return;
      }
      const after = {
        ...feat,
        geometry: { ...feat.geometry, positions: nextPositions },
        meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
      } as any;
      this.activeHandleIndex = null;
      this.stack.push(
        new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
      );
      this.refreshHandles();
      this.emit();
    }
  }

  // ---------- handles ----------
  refreshHandles() {
    this.clearHandles();
    if (!this.selectedId || !this.selectedKind) return;

    if (this.selectedKind === "point") {
      const feat = this.store.getPoint(this.selectedId);
      if (!feat) return;
      const h = this.createHandle(feat.geometry.position, this.selectedId, 0);
      this.handles.push(h);
      return;
    }

    const positions =
      this.selectedKind === "polygon"
        ? this.store.getPolygon(this.selectedId)?.geometry.positions
        : this.store.getPolyline(this.selectedId)?.geometry.positions;
    if (!positions) return;

    for (let i = 0; i < positions.length; i++) {
      const h = this.createHandle(positions[i], this.selectedId, i);
      this.handles.push(h);
    }
  }

  private clearHandles() {
    this.overlayDs.entities.removeAll();
    this.handles = [];
  }

  private createHandle(pos: Cesium.Cartesian3, ownerId: string, index: number) {
    const e = this.overlayDs.entities.add(
      new Cesium.Entity({
        position: Cesium.Cartesian3.clone(pos),
        point: new Cesium.PointGraphics({
          color: Cesium.Color.ORANGE.withAlpha(0.95),
          pixelSize: 10,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
        }),
      })
    );
    e.properties = new Cesium.PropertyBag({
      __type: "handle",
      __ownerId: ownerId,
      __index: index,
    }) as any;
    return e;
  }

  private setActiveHandle(index: number | null) {
    this.activeHandleIndex = index;
    // style update
    for (const h of this.handles) {
      const p = this.getProps(h);
      const idx = Number(p?.__index);
      if (!Number.isFinite(idx)) continue;
      const isActive = index !== null && idx === index;
      if (h.point) {
        h.point.color = new Cesium.ConstantProperty(
          isActive ? Cesium.Color.RED : Cesium.Color.ORANGE.withAlpha(0.95)
        ) as any;
      }
    }
  }

  // ---------- drag begin helpers ----------
  private beginHandleDrag(screenPos: Cesium.Cartesian2, props: any) {
    const ownerId = String(props.__ownerId);
    const idx = Number(props.__index);
    if (!Number.isFinite(idx)) return;

    if (this.selectedId !== ownerId) this.select(ownerId);
    if (!this.selectedId || !this.selectedKind) return;

    const p = this.pick.pickPosition(screenPos);
    if (!p) return;

    this.dragMode = "vertex";
    this.dragIndex = this.selectedKind === "point" ? 0 : idx;
    this.setActiveHandle(idx);

    if (this.selectedKind === "point") {
      const feat = this.store.getPoint(ownerId);
      if (!feat) return;
      this.dragBeforeFeature = snapshotFeature(feat);
      this.dragBeforePosition = Cesium.Cartesian3.clone(feat.geometry.position);
      this.lockCamera();
      return;
    }

    const feat =
      this.selectedKind === "polygon"
        ? this.store.getPolygon(ownerId)
        : this.store.getPolyline(ownerId);
    if (!feat) return;
    this.dragBeforeFeature = snapshotFeature(feat);
    this.dragBeforePositions = clonePositions(feat.geometry.positions);
    this.lockCamera();
  }

  // ---------- preview apply ----------
  private applyPointMovePreview(next: Cesium.Cartesian3) {
    if (!this.selectedId) return;
    const e = this.layer.getEntity(this.selectedId);
    if (!e) return;
    e.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.clone(next)) as any;
    this.dragPreviewPosition = Cesium.Cartesian3.clone(next);
    // handle
    if (this.handles[0]) this.handles[0].position = Cesium.Cartesian3.clone(next) as any;
  }

  private applyVertexMovePreview(index: number, next: Cesium.Cartesian3) {
    if (!this.selectedId || !this.selectedKind) return;
    const e = this.layer.getEntity(this.selectedId);
    if (!e) return;
    const positions = this.getCommittedPositions();
    if (!positions) return;
    const nextPositions = clonePositions(positions);
    nextPositions[index] = Cesium.Cartesian3.clone(next);
    this.applyPositionsPreview(nextPositions);
    this.updateAllHandlePositions(nextPositions);
  }

  private applyPositionsPreview(nextPositions: Cesium.Cartesian3[]) {
    if (!this.selectedId || !this.selectedKind) return;
    const e = this.layer.getEntity(this.selectedId);
    if (!e) return;

    if (this.selectedKind === "polygon" && e.polygon) {
      e.polygon.hierarchy = new Cesium.ConstantProperty(
        new Cesium.PolygonHierarchy(clonePositions(nextPositions))
      ) as any;
    }

    if (this.selectedKind === "polyline" && e.polyline) {
      e.polyline.positions = new Cesium.ConstantProperty(clonePositions(nextPositions)) as any;
    }

    this.dragPreviewPositions = clonePositions(nextPositions);
  }

  private updateAllHandlePositions(next: Cesium.Cartesian3[]) {
    for (let i = 0; i < this.handles.length; i++) {
      const h = this.handles[i];
      const p = next[i];
      if (!p) continue;
      h.position = Cesium.Cartesian3.clone(p) as any;
    }
  }

  private getCommittedPositions(): Cesium.Cartesian3[] | null {
    if (!this.selectedId || !this.selectedKind) return null;
    const feat =
      this.selectedKind === "polygon"
        ? this.store.getPolygon(this.selectedId)
        : this.selectedKind === "polyline"
          ? this.store.getPolyline(this.selectedId)
          : null;
    if (!feat) return null;
    return feat.geometry.positions;
  }

  // ---------- insert point helpers ----------
  private tryInsertPointOnPolygon(screenPos: Cesium.Cartesian2): boolean {
    if (!this.selectedId) return false;
    const feat = this.store.getPolygon(this.selectedId);
    if (!feat) return false;
    const picked = this.pick.pickPosition(screenPos);
    if (!picked) return false;

    const { ok, insertIndex, projected } = this.findClosestEdgeInsertion(
      feat.geometry.positions,
      picked,
      screenPos,
      true
    );
    if (!ok || insertIndex === null || !projected) return false;

    const before = snapshotFeature(feat);
    const next = clonePositions(feat.geometry.positions);
    next.splice(insertIndex, 0, projected);

    const v = validatePolygonPositions(next);
    if (!v.ok) {
      const msg = v.issues[0]?.message ?? "几何校验失败";
      this.opts.onNotice?.(`插点失败：${msg}`);
      return false;
    }

    const after = {
      ...feat,
      geometry: { ...feat.geometry, positions: next },
      meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
    } as any;

    this.stack.push(
      new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
    );
    this.refreshHandles();
    this.emit();
    return true;
  }

  private tryInsertPointOnPolyline(screenPos: Cesium.Cartesian2): boolean {
    if (!this.selectedId) return false;
    const feat = this.store.getPolyline(this.selectedId);
    if (!feat) return false;
    const picked = this.pick.pickPosition(screenPos);
    if (!picked) return false;

    const { ok, insertIndex, projected } = this.findClosestEdgeInsertion(
      feat.geometry.positions,
      picked,
      screenPos,
      false
    );
    if (!ok || insertIndex === null || !projected) return false;

    const before = snapshotFeature(feat);
    const next = clonePositions(feat.geometry.positions);
    next.splice(insertIndex, 0, projected);

    const err = validatePolylinePositions(next);
    if (err) {
      this.opts.onNotice?.(`插点失败：${err}`);
      return false;
    }

    const after = {
      ...feat,
      geometry: { ...feat.geometry, positions: next },
      meta: feat.meta ? { ...feat.meta, updatedAt: Date.now() } : feat.meta,
    } as any;

    this.stack.push(
      new UpdateFeatureCommand(this.store, this.selectedId, before, snapshotFeature(after))
    );
    this.refreshHandles();
    this.emit();
    return true;
  }

  /**
   * Finds insertion index by projecting to screen and choosing the closest segment.
   * For polygon, segments wrap around; for polyline, they do not.
   */
  private findClosestEdgeInsertion(
    positions: Cesium.Cartesian3[],
    picked: Cesium.Cartesian3,
    screenPos: Cesium.Cartesian2,
    wrap: boolean
  ): { ok: boolean; insertIndex: number | null; projected?: Cesium.Cartesian3 } {
    if (positions.length < 2) return { ok: false, insertIndex: null };

    const scene = this.viewer.scene;
    const p2 = screenPos;

    let bestDist = Number.POSITIVE_INFINITY;
    let bestInsert: number | null = null;
    let bestProjected: Cesium.Cartesian3 | null = null;

    const segCount = wrap ? positions.length : positions.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = positions[i];
      const b = positions[(i + 1) % positions.length];
      const a2 = Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, a);
      const b2 = Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, b);
      if (!a2 || !b2) continue;
      const d = distancePointToSegment2D(p2, a2, b2);
      if (d < bestDist) {
        bestDist = d;
        bestInsert = i + 1;
        bestProjected = closestPointOnSegment3D(picked, a, b);
      }
    }

    // apply snap on projected point if enabled
    if (bestProjected && this.snapEnabled) {
      bestProjected = this.snapWithEngine(bestProjected, screenPos, {
        excludeOwnerId: this.selectedId ?? undefined,
      });
    }

    // threshold check: within snapThresholdPx * 1.5 (slightly more forgiving)
    if (!Number.isFinite(bestDist) || bestDist > this.snapThresholdPx * 1.5) {
      return { ok: false, insertIndex: null };
    }
    return { ok: true, insertIndex: bestInsert, projected: bestProjected ?? undefined };
  }

  // ---------- snapping ----------
  private snapWithEngine(
    world: Cesium.Cartesian3,
    screen: Cesium.Cartesian2,
    opts: { excludeOwnerId?: string; excludeIndex?: number } = {}
  ) {
    const res = this.snapping.snap(world, screen, opts);
    if (res) return res.candidate;
    return world;
  }

  // ---------- props helpers ----------
  private getProps(entity: Cesium.Entity) {
    return entity.properties?.getValue(Cesium.JulianDate.now());
  }

  // ---------- camera lock ----------
  private lockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = false;
    c.enableTilt = false;
    c.enableTranslate = false;
    c.enableZoom = false;
    c.enableLook = false;
  }

  private unlockCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = true;
    c.enableTilt = true;
    c.enableTranslate = true;
    c.enableZoom = true;
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

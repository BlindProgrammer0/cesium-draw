import type { CommandStack } from "../viewer/commands/CommandStack";
import type { FeatureStore } from "../features/store";
import type { PolygonDrawTool } from "../viewer/PolygonDrawTool";
import type { PolylineDrawTool } from "../viewer/PolylineDrawTool";
import type { PointDrawTool } from "../viewer/PointDrawTool";
import type { FeatureEditTool } from "../viewer/edit/FeatureEditTool";

export type ToolMode = "idle" | "draw" | "edit";
export type DrawKind = "polygon" | "polyline" | "point";

type Listener = () => void;

/**
 * ToolController
 *
 * A thin, stable orchestration boundary for UI integration.
 *
 * Goals (Stage 6.3 non-snap):
 * - Centralize mode transitions (draw/edit/idle) and ensure cleanup.
 * - Normalize Escape semantics:
 *    - If drawing: cancel drawing
 *    - Else if dragging in edit: cancel current edit transaction
 *    - Else: deselect
 * - Keep Undo/Redo and store-driven rendering unchanged.
 */
export class ToolController {
  private listeners = new Set<Listener>();
  private currentDrawKind: DrawKind | null = null;

  constructor(
    private readonly stack: CommandStack,
    private readonly store: FeatureStore,
    private readonly drawPolygon: PolygonDrawTool,
    private readonly drawPolyline: PolylineDrawTool,
    private readonly drawPoint: PointDrawTool,
    private readonly edit: FeatureEditTool
  ) {
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get mode(): ToolMode {
    if (this.isDrawing()) return "draw";
    if (this.edit.selectedEntityId) return "edit";
    return "idle";
  }

  get drawingKind(): DrawKind | null {
    return this.isDrawing() ? this.currentDrawKind : null;
  }

  isDrawing() {
    if (!this.currentDrawKind) return false;
    if (this.currentDrawKind === "polygon") return this.drawPolygon.state === "drawing";
    if (this.currentDrawKind === "polyline") return this.drawPolyline.getState() === "drawing";
    if (this.currentDrawKind === "point") return this.drawPoint.getState() === "drawing";
    return false;
  }

  startDrawing(kind: DrawKind) {
    // leave edit mode
    this.edit.cancel();

    // cancel existing drawing if any
    if (this.currentDrawKind) this.cancelDrawing();
    this.currentDrawKind = kind;

    if (kind === "polygon") this.drawPolygon.start();
    if (kind === "polyline") this.drawPolyline.start();
    if (kind === "point") this.drawPoint.start();

    this.emit();
  }

  finishDrawing() {
    if (!this.currentDrawKind) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.finish();
    if (this.currentDrawKind === "polyline") this.drawPolyline.finish();
    if (this.currentDrawKind === "point") this.drawPoint.finish();
    this.currentDrawKind = null;
    this.emit();
  }

  undoDrawPoint() {
    if (!this.isDrawing()) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.undoPoint();
    if (this.currentDrawKind === "polyline") this.drawPolyline.undoPoint();
  }

  cancelDrawing() {
    if (!this.currentDrawKind) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.cancel();
    if (this.currentDrawKind === "polyline") this.drawPolyline.cancel();
    if (this.currentDrawKind === "point") this.drawPoint.cancel();
    this.currentDrawKind = null;
    this.emit();
  }

  deselect() {
    this.edit.deselect();
    this.emit();
  }

  undo() {
    this.stack.undo();
    this.emit();
  }

  redo() {
    this.stack.redo();
    this.emit();
  }

  clearCommitted() {
    this.drawPolygon.clearAllCommitted();
    this.emit();
  }

  deleteSelected() {
    this.edit.deleteSelected();
    this.emit();
  }

  deleteActiveVertex() {
    this.edit.deleteActiveVertex();
    this.emit();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;

    // Drawing has highest priority
    if (this.isDrawing()) {
      this.cancelDrawing();
      return;
    }

    // Then cancel active edit transaction (drag) or deselect
    this.edit.cancel();
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

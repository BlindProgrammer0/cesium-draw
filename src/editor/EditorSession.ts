import {
  reduceEditorState,
  initialEditorState,
  type EditorEvent,
  type EditorState,
  type DrawKind,
} from "./fsm";
import type { CommandStack } from "../viewer/commands/CommandStack";
import type { PolygonDrawTool } from "../viewer/PolygonDrawTool";
import type { PolylineDrawTool } from "../viewer/PolylineDrawTool";
import type { PointDrawTool } from "../viewer/PointDrawTool";
import type { FeatureEditTool } from "../viewer/edit/FeatureEditTool";
import type { FeatureStore } from "../features/store";

type Listener = () => void;

/**
 * EditorSession (FSM-driven orchestration)
 *
 * Stage 5.1+: extended to support multiple draw kinds:
 * - polygon / polyline / point
 *
 * Notes:
 * - Selection/picking is still handled by the edit tool; session only provides
 *   a single authoritative UI state and tool lifecycle invariants.
 */
export class EditorSession {
  private listeners = new Set<Listener>();
  private _state: EditorState = initialEditorState;

  private currentDrawKind: DrawKind | null = null;

  constructor(
    private readonly stack: CommandStack,
    private readonly store: FeatureStore,
    private readonly drawPolygon: PolygonDrawTool,
    private readonly drawPolyline: PolylineDrawTool,
    private readonly drawPoint: PointDrawTool,
    private readonly edit: FeatureEditTool
  ) {}

  get state(): EditorState {
    // Drawing takes precedence
    if (this.currentDrawKind) {
      const isDrawing =
        (this.currentDrawKind === "polygon" && this.drawPolygon.state === "drawing") ||
        (this.currentDrawKind === "polyline" && this.drawPolyline.getState() === "drawing") ||
        (this.currentDrawKind === "point" && this.drawPoint.getState() === "drawing");

      if (isDrawing) {
        return { ...this._state, mode: "drawing", drawingKind: this.currentDrawKind };
      }
      // tool already ended
      this.currentDrawKind = null;
    }

    const selectedId = this.edit.selectedEntityId ?? null;
    const selectedKind = selectedId
      ? ((this.store.get(selectedId)?.kind as any) ?? null)
      : null;
    const mode = selectedId ? "editing" : "idle";
    return { ...this._state, mode, drawingKind: null, selectedId, selectedKind };
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  startDrawing(kind: DrawKind) {
    // stop editing selection
    this.deselect();

    // cancel any existing drawing
    if (this.currentDrawKind) this.cancelDrawing();

    this.currentDrawKind = kind;
    if (kind === "polygon") this.drawPolygon.start();
    if (kind === "polyline") this.drawPolyline.start();
    if (kind === "point") this.drawPoint.start();

    this.dispatch({ type: "DRAW_START", kind });
  }

  finishDrawing() {
    if (!this.currentDrawKind) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.finish();
    if (this.currentDrawKind === "polyline") this.drawPolyline.finish();
    if (this.currentDrawKind === "point") this.drawPoint.finish();

    this.currentDrawKind = null;
    this.dispatch({ type: "DRAW_FINISH" });
  }

  undoDrawPoint() {
    if (!this.currentDrawKind) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.undoPoint();
    if (this.currentDrawKind === "polyline") this.drawPolyline.undoPoint();
  }

  cancelDrawing() {
    if (!this.currentDrawKind) return;
    if (this.currentDrawKind === "polygon") this.drawPolygon.cancel();
    if (this.currentDrawKind === "polyline") this.drawPolyline.cancel();
    if (this.currentDrawKind === "point") this.drawPoint.cancel();

    this.currentDrawKind = null;
    this.dispatch({ type: "DRAW_CANCEL" });
  }

  deselect() {
    this.edit.deselect();
    this.dispatch({ type: "DESELECT" });
  }

  undo() {
    this.stack.undo();
    this.dispatch({ type: "COMMITTED_CHANGED" });
  }

  redo() {
    this.stack.redo();
    this.dispatch({ type: "COMMITTED_CHANGED" });
  }

  clearCommitted() {
    this.drawPolygon.clearAllCommitted();
    this.dispatch({ type: "COMMITTED_CHANGED" });
  }

  deleteSelected() {
    this.edit.deleteSelected();
    this.dispatch({ type: "COMMITTED_CHANGED" });
  }

  deleteActiveVertex() {
    this.edit.deleteActiveVertex();
    this.dispatch({ type: "COMMITTED_CHANGED" });
  }

  private dispatch(ev: EditorEvent) {
    this._state = reduceEditorState(this._state, ev);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

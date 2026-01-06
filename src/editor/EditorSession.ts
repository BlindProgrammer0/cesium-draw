import { reduceEditorState, initialEditorState, type EditorEvent, type EditorState } from "./fsm";
import type { PickService } from "../viewer/PickService";
import type { CommandStack } from "../viewer/commands/CommandStack";
import type { PolygonDrawTool } from "../viewer/PolygonDrawTool";
import type { PolygonEditTool } from "../viewer/edit/PolygonEditTool";

type Listener = () => void;

/**
 * Stage 5.1: EditorSession (FSM-driven orchestration)
 *
 * Responsibilities:
 * - One authoritative editor state for UI (idle/drawing/editing)
 * - Tool orchestration and invariants (e.g. editing guarded during drawing)
 * - Single integration point for future features (validation, persistence, collaboration)
 */
export class EditorSession {
  private listeners = new Set<Listener>();
  private _state: EditorState = initialEditorState;

  constructor(
    public readonly draw: PolygonDrawTool,
    public readonly edit: PolygonEditTool,
    public readonly pick: PickService,
    public readonly stack: CommandStack
  ) {
    // Sync from tools -> session state
    this.draw.onStateChange(() => {
      if (this.draw.state === "drawing") this.dispatch({ type: "DRAW_START" });
      if (this.draw.state === "idle") this.dispatch({ type: "DRAW_FINISH" });
      // draw tool internally distinguishes finish/cancel; we keep minimal transitions.
    });

    this.draw.onCommittedChange(() => {
      this.dispatch({ type: "COMMITTED_CHANGED" });
    });

    // High-frequency (drawing) updates should still reflect in UI.
    this.draw.onPointChange(() => {
      this.emit();
    });

    this.edit.onChange(() => {
      const id = this.edit.selectedEntityId;
      if (id && this._state.selectedId !== id) this.dispatch({ type: "SELECT", id });
      if (!id && this._state.selectedId) this.dispatch({ type: "DESELECT" });
    });

    this.stack.onChange(() => {
      // Handle refresh is still owned by UI (it knows what to refresh visually),
      // but we emit for state-driven UIs.
      this.emit();
    });
  }

  get state(): EditorState {
    // Mode derived from draw.state takes precedence.
    if (this.draw.state === "drawing") {
      return { ...this._state, mode: "drawing" };
    }
    // When not drawing, mode depends on selection.
    const selectedId = this.edit.selectedEntityId ?? null;
    const mode = selectedId ? "editing" : "idle";
    return { ...this._state, mode, selectedId };
  }

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Stage 5-friendly command API */
  startDrawing() {
    this.draw.start();
    this.dispatch({ type: "DRAW_START" });
  }

  finishDrawing() {
    this.draw.finish();
    this.dispatch({ type: "DRAW_FINISH" });
  }

  cancelDrawing() {
    this.draw.cancel();
    this.dispatch({ type: "DRAW_CANCEL" });
  }

  undoDrawPoint() {
    this.draw.undoPoint();
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

  deselect() {
    this.edit.deselect();
    this.dispatch({ type: "DESELECT" });
  }

  deleteSelectedPolygon() {
    this.edit.deleteSelectedPolygon();
    // selection will be updated by edit.onChange
    this.emit();
  }

  deleteActiveVertex() {
    this.edit.deleteActiveVertex();
    this.emit();
  }

  clearCommitted() {
    this.deselect();
    this.draw.clearAllCommitted();
    this.emit();
  }

  private dispatch(ev: EditorEvent) {
    this._state = reduceEditorState(this._state, ev);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

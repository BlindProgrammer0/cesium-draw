export type DrawKind = "polygon" | "polyline" | "point";

export type EditorMode = "idle" | "drawing" | "editing";

export type EditorState = {
  mode: EditorMode;

  /** When mode==='drawing', which geometry is being drawn. */
  drawingKind: DrawKind | null;

  /** When mode==='editing', the selected feature id. */
  selectedId: string | null;

  /** When mode==='editing', the selected feature kind. */
  selectedKind: DrawKind | null;

  /** Debug-friendly reason for last transition. */
  lastEvent?: string;
};

export type EditorEvent =
  | { type: "DRAW_START"; kind: DrawKind }
  | { type: "DRAW_FINISH" }
  | { type: "DRAW_CANCEL" }
  | { type: "SELECT"; id: string; kind: DrawKind }
  | { type: "DESELECT" }
  | { type: "COMMITTED_CHANGED" };

export const initialEditorState: EditorState = {
  mode: "idle",
  drawingKind: null,
  selectedId: null,
  selectedKind: null,
};

export function reduceEditorState(prev: EditorState, ev: EditorEvent): EditorState {
  switch (ev.type) {
    case "DRAW_START":
      return {
        ...prev,
        mode: "drawing",
        drawingKind: ev.kind,
        selectedId: null,
        selectedKind: null,
        lastEvent: ev.type,
      };

    case "DRAW_FINISH":
      return {
        ...prev,
        mode: "idle",
        drawingKind: null,
        lastEvent: ev.type,
      };

    case "DRAW_CANCEL":
      return {
        ...prev,
        mode: "idle",
        drawingKind: null,
        lastEvent: ev.type,
      };

    case "SELECT":
      // Selecting while drawing cancels drawing at session layer.
      return {
        ...prev,
        mode: "editing",
        drawingKind: null,
        selectedId: ev.id,
        selectedKind: ev.kind,
        lastEvent: ev.type,
      };

    case "DESELECT":
      return {
        ...prev,
        mode: "idle",
        drawingKind: null,
        selectedId: null,
        selectedKind: null,
        lastEvent: ev.type,
      };

    case "COMMITTED_CHANGED":
      return { ...prev, lastEvent: ev.type };

    default: {
      const _exhaustive: never = ev;
      return prev;
    }
  }
}

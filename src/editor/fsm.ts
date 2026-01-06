export type EditorMode = "idle" | "drawing" | "editing";

export type EditorState = {
  mode: EditorMode;
  /** When mode==='editing', the selected entity id (polygon). */
  selectedId: string | null;
  /** Debug-friendly reason for last transition. */
  lastEvent?: string;
};

export type EditorEvent =
  | { type: "DRAW_START" }
  | { type: "DRAW_FINISH" }
  | { type: "DRAW_CANCEL" }
  | { type: "SELECT"; id: string }
  | { type: "DESELECT" }
  | { type: "COMMITTED_CHANGED" };

export const initialEditorState: EditorState = {
  mode: "idle",
  selectedId: null,
};

/**
 * Minimal FSM for stage 5.1:
 * - Centralizes tool-mode transitions and enforces invariants.
 * - Keeps editing enabled even when idle (selection is optional),
 *   but exposes a single authoritative `mode` for UI.
 */
export function reduceEditorState(
  prev: EditorState,
  ev: EditorEvent
): EditorState {
  switch (ev.type) {
    case "DRAW_START":
      return { mode: "drawing", selectedId: prev.selectedId, lastEvent: ev.type };

    case "DRAW_FINISH":
    case "DRAW_CANCEL":
      // After finishing/cancelling, we go back to editing if a polygon is selected.
      return {
        mode: prev.selectedId ? "editing" : "idle",
        selectedId: prev.selectedId,
        lastEvent: ev.type,
      };

    case "SELECT":
      // Selection always moves into editing mode unless we are drawing.
      return {
        mode: prev.mode === "drawing" ? "drawing" : "editing",
        selectedId: ev.id,
        lastEvent: ev.type,
      };

    case "DESELECT":
      return {
        mode: prev.mode === "drawing" ? "drawing" : "idle",
        selectedId: null,
        lastEvent: ev.type,
      };

    case "COMMITTED_CHANGED":
      // If selected entity vanished, selection should be cleared by the session.
      return { ...prev, lastEvent: ev.type };

    default: {
      const _exhaustive: never = ev;
      return prev;
    }
  }
}

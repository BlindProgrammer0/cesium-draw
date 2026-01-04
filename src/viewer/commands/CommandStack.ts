import type { Command } from "./Command";
type Listener = () => void;

export class CommandStack {
  private done: Command[] = [];
  private undone: Command[] = [];
  private listeners: Listener[] = [];

  onChange(fn: Listener) { this.listeners.push(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  get canUndo() { return this.done.length > 0; }
  get canRedo() { return this.undone.length > 0; }
  get undoCount() { return this.done.length; }
  get redoCount() { return this.undone.length; }

  push(cmd: Command) {
    cmd.do();
    this.done.push(cmd);
    this.undone = [];
    this.emit();
  }

  undo() {
    const cmd = this.done.pop();
    if (!cmd) return;
    cmd.undo();
    this.undone.push(cmd);
    this.emit();
  }

  redo() {
    const cmd = this.undone.pop();
    if (!cmd) return;
    cmd.do();
    this.done.push(cmd);
    this.emit();
  }

  clear() { this.done = []; this.undone = []; this.emit(); }
}

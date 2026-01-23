export type FeatureId = string;

type Listener = (ids: ReadonlySet<FeatureId>) => void;

/**
 * SelectionManager (Stage 6.4)
 *
 * - Internal representation is a Set to allow future multi-select/box-select.
 * - Stage 6.4 behavior is effectively single-select via selectOne().
 */
export class SelectionManager {
  private ids = new Set<FeatureId>();
  private listeners = new Set<Listener>();

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSelectedIds(): ReadonlySet<FeatureId> {
    return this.ids;
  }

  /** Primary selection (single-select semantics today). */
  getPrimaryId(): FeatureId | null {
    const it = this.ids.values().next();
    return it.done ? null : it.value;
  }

  has(id: FeatureId) {
    return this.ids.has(id);
  }

  /** Stage 6.4: single-select. Clears previous selection. */
  selectOne(id: FeatureId) {
    const same = this.ids.size === 1 && this.ids.has(id);
    if (same) return;

    this.ids.clear();
    this.ids.add(id);
    this.emit();
  }

  clear() {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.emit();
  }

  // ---- reserved for future multi-select ----
  add(id: FeatureId) {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    this.emit();
  }

  remove(id: FeatureId) {
    if (!this.ids.delete(id)) return;
    this.emit();
  }

  toggle(id: FeatureId) {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn(this.ids);
  }
}

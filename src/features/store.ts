import type { Feature, FeatureId, PolygonFeature } from "./types";

export type FeatureEvent =
  | { type: "upsert"; feature: Feature }
  | { type: "remove"; id: FeatureId }
  | { type: "clear"; removed: Feature[] };

type Listener = (evt: FeatureEvent) => void;

/**
 * In-memory feature store.
 * - Source of truth for geometry/props.
 * - Rendering layers should subscribe to events.
 */
export class FeatureStore {
  private map = new Map<FeatureId, Feature>();
  private listeners: Listener[] = [];

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit(evt: FeatureEvent) {
    for (const fn of this.listeners) fn(evt);
  }

  get size() {
    return this.map.size;
  }

  has(id: FeatureId) {
    return this.map.has(id);
  }

  get(id: FeatureId): Feature | undefined {
    return this.map.get(id);
  }

  getPolygon(id: FeatureId): PolygonFeature | undefined {
    const f = this.map.get(id);
    if (!f || f.kind !== "polygon") return undefined;
    return f as PolygonFeature;
  }

  all(): Feature[] {
    return [...this.map.values()];
  }

  upsert(feature: Feature, opts?: { silent?: boolean }) {
    this.map.set(feature.id, feature);
    if (!opts?.silent) this.emit({ type: "upsert", feature });
  }

  remove(id: FeatureId, opts?: { silent?: boolean }) {
    const existed = this.map.get(id);
    if (!existed) return;
    this.map.delete(id);
    if (!opts?.silent) this.emit({ type: "remove", id });
  }

  clear(opts?: { silent?: boolean }) {
    const removed = this.all();
    this.map.clear();
    if (!opts?.silent) this.emit({ type: "clear", removed });
    return removed;
  }
}

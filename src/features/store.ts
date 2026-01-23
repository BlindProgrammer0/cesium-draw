import type {
  Feature,
  FeatureId,
  PointFeature,
  PolylineFeature,
  PolygonFeature,
} from "./types";

export type FeatureEvent =
  | { type: "upsert"; feature: Feature }
  | { type: "remove"; id: FeatureId }
  | { type: "clear"; removed: Feature[] };

// 可选：批量事件（如果你后面要一次 upsert 很多）
// | { type: "upsertMany"; features: Feature[] };

type Listener = (evt: FeatureEvent) => void;
type Unsubscribe = () => void;

/**
 * In-memory feature store.
 * - Source of truth for geometry/props.
 * - Rendering layers should subscribe to events.
 */
export class FeatureStore {
  private map = new Map<FeatureId, Feature>();
  private listeners = new Set<Listener>();

  /** 兼容旧接口：继续可用 */
  onChange(fn: Listener): Unsubscribe {
    return this.on(fn);
  }

  /** 推荐接口：更通用 */
  on(fn: Listener): Unsubscribe {
    this.listeners.add(fn);
    return () => this.off(fn);
  }

  off(fn: Listener) {
    this.listeners.delete(fn);
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

  getPoint(id: FeatureId): PointFeature | undefined {
    const f = this.map.get(id);
    if (!f || f.kind !== "point") return undefined;
    return f as PointFeature;
  }

  getPolyline(id: FeatureId): PolylineFeature | undefined {
    const f = this.map.get(id);
    if (!f || f.kind !== "polyline") return undefined;
    return f as PolylineFeature;
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

  // 可选：批量 upsert（你后面导入/事务会更舒服）
  // upsertMany(features: Feature[], opts?: { silent?: boolean }) {
  //   for (const f of features) this.map.set(f.id, f);
  //   if (!opts?.silent) this.emit({ type: "upsertMany", features });
  // }

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

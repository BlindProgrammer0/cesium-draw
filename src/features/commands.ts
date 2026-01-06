import * as Cesium from "cesium";
import type { Command } from "../viewer/commands/Command";
import type { Feature, FeatureId } from "./types";
import type { FeatureStore } from "./store";

export type FeatureSnapshot = Feature;

export class AddFeatureCommand implements Command {
  readonly name = "AddFeature";
  constructor(private readonly store: FeatureStore, private readonly feature: Feature) {}

  do(): void {
    this.store.upsert(this.feature);
  }

  undo(): void {
    this.store.remove(this.feature.id);
  }

  get id() {
    return this.feature.id;
  }
}

export class UpdateFeatureCommand implements Command {
  readonly name = "UpdateFeature";
  constructor(
    private readonly store: FeatureStore,
    private readonly id: FeatureId,
    private readonly before: FeatureSnapshot,
    private readonly after: FeatureSnapshot
  ) {}

  do(): void {
    this.store.upsert(this.after);
  }

  undo(): void {
    this.store.upsert(this.before);
  }
}

export class RemoveFeatureCommand implements Command {
  readonly name = "RemoveFeature";
  private snap: FeatureSnapshot | null = null;
  constructor(private readonly store: FeatureStore, private readonly id: FeatureId) {}

  do(): void {
    const f = this.store.get(this.id);
    if (!f) return;
    this.snap = snapshotFeature(f);
    this.store.remove(this.id);
  }

  undo(): void {
    if (!this.snap) return;
    this.store.upsert(this.snap);
  }
}

export class ClearAllFeaturesCommand implements Command {
  readonly name = "ClearAllFeatures";
  private removed: FeatureSnapshot[] = [];
  constructor(private readonly store: FeatureStore) {}

  do(): void {
    this.removed = this.store.clear().map(snapshotFeature);
  }

  undo(): void {
    for (const f of this.removed) this.store.upsert(f);
  }
}

export function snapshotFeature(f: Feature): FeatureSnapshot {
  // Deep clone while preserving Cesium.Cartesian3.
  if (f.kind === "polygon") {
    const positions = (f as any).geometry.positions as Cesium.Cartesian3[];
    const cloned = positions.map((p) => Cesium.Cartesian3.clone(p));
    return {
      ...f,
      geometry: { ...(f as any).geometry, positions: cloned },
      meta: f.meta ? { ...f.meta } : undefined,
      properties: f.properties ? { ...f.properties } : undefined,
    } as FeatureSnapshot;
  }
  return {
    ...f,
    meta: f.meta ? { ...f.meta } : undefined,
    properties: f.properties ? { ...f.properties } : undefined,
  } as FeatureSnapshot;
}

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

/**
 * Replace the entire store with a given set of features as a single undoable command.
 * - do(): clears store then upserts all items
 * - undo(): restores the exact previous snapshot (including features not present in the new set)
 */
export class ReplaceAllFeaturesCommand implements Command {
  readonly name = "ReplaceAllFeatures";
  private before: FeatureSnapshot[] = [];
  private readonly after: FeatureSnapshot[];

  constructor(private readonly store: FeatureStore, features: Feature[]) {
    this.after = features.map(snapshotFeature);
  }

  do(): void {
    this.before = this.store.all().map(snapshotFeature);
    this.store.clear();
    for (const f of this.after) this.store.upsert(f);
  }

  undo(): void {
    this.store.clear();
    for (const f of this.before) this.store.upsert(f);
  }
}

/**
 * Upsert a batch of features as a single undoable command.
 * - If a feature id already exists, it is replaced (and old value is restored on undo).
 * - If it doesn't exist, it is removed on undo.
 */
export class UpsertManyFeaturesCommand implements Command {
  readonly name = "UpsertManyFeatures";
  private beforeById = new Map<FeatureId, FeatureSnapshot | null>();
  private readonly items: FeatureSnapshot[];

  constructor(private readonly store: FeatureStore, features: Feature[]) {
    this.items = features.map(snapshotFeature);
  }

  do(): void {
    for (const f of this.items) {
      if (!this.beforeById.has(f.id)) {
        const existed = this.store.get(f.id);
        this.beforeById.set(f.id, existed ? snapshotFeature(existed) : null);
      }
      this.store.upsert(f);
    }
  }

  undo(): void {
    // reverse order for deterministic restore
    const ids = Array.from(this.beforeById.keys()).reverse();
    for (const id of ids) {
      const before = this.beforeById.get(id) ?? null;
      if (before) this.store.upsert(before);
      else this.store.remove(id);
    }
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

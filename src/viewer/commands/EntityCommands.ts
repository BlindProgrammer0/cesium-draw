import * as Cesium from "cesium";
import type { Command } from "./Command";

export type PolygonSnapshot = {
  id: string;
  name?: string;
  positions: Cesium.Cartesian3[];
  material?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

export function clonePositions(positions: Cesium.Cartesian3[]) {
  return positions.map((p) => Cesium.Cartesian3.clone(p));
}

export function snapshotPolygonEntity(e: Cesium.Entity): PolygonSnapshot | null {
  if (!e.id || !e.polygon?.hierarchy) return null;
  const hierarchy = e.polygon.hierarchy.getValue(Cesium.JulianDate.now()) as Cesium.PolygonHierarchy | undefined;
  if (!hierarchy?.positions?.length) return null;

  return {
    id: String(e.id),
    name: e.name ?? undefined,
    positions: clonePositions(hierarchy.positions),
    material: e.polygon.material ?? undefined,
    outlineColor: e.polygon.outlineColor ?? undefined,
  };
}

export function addPolygonFromSnapshot(ds: Cesium.CustomDataSource, snap: PolygonSnapshot): Cesium.Entity {
  return ds.entities.add({
    id: snap.id,
    name: snap.name ?? "polygon",
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(clonePositions(snap.positions)),
      material: snap.material ?? new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
      outline: true,
      outlineColor: snap.outlineColor ?? Cesium.Color.CYAN.withAlpha(0.95),
    },
    properties: { __type: "polygon", __source: "committed" },
  });
}

export function applyPolygonSnapshot(ds: Cesium.CustomDataSource, entityId: string, snap: PolygonSnapshot) {
  const e = ds.entities.getById(entityId);
  if (!e?.polygon) return;

  e.name = snap.name ?? e.name;

  const hierarchy = new Cesium.PolygonHierarchy(clonePositions(snap.positions));
  e.polygon.hierarchy = new Cesium.ConstantProperty(hierarchy) as any;

  if (snap.material) e.polygon.material = snap.material;
  if (snap.outlineColor) e.polygon.outlineColor = snap.outlineColor;
}

export class AddPolygonCommand implements Command {
  readonly name = "AddPolygon";
  private entityId: string;

  constructor(
    private readonly ds: Cesium.CustomDataSource,
    private readonly snap: Omit<PolygonSnapshot, "id"> & { id?: string },
    private readonly onAdded?: (e: Cesium.Entity) => void,
    private readonly onRemoved?: (id: string) => void,
  ) {
    this.entityId = snap.id ?? Cesium.createGuid();
  }

  do(): void {
    const e = addPolygonFromSnapshot(this.ds, { ...this.snap, id: this.entityId });
    this.onAdded?.(e);
  }

  undo(): void {
    const e = this.ds.entities.getById(this.entityId);
    if (e) this.ds.entities.remove(e);
    this.onRemoved?.(this.entityId);
  }

  get id() { return this.entityId; }
}

export class ClearAllPolygonsCommand implements Command {
  readonly name = "ClearAllPolygons";
  private snaps: PolygonSnapshot[] = [];

  constructor(
    private readonly ds: Cesium.CustomDataSource,
    private readonly entities: Cesium.Entity[],
    private readonly onCleared?: () => void,
    private readonly onRestored?: (restored: Cesium.Entity[]) => void,
  ) {}

  do(): void {
    this.snaps = [];
    for (const e of this.entities) {
      const snap = snapshotPolygonEntity(e);
      if (!snap) continue;
      this.snaps.push(snap);
      this.ds.entities.remove(e);
    }
    this.onCleared?.();
  }

  undo(): void {
    const restored: Cesium.Entity[] = [];
    for (const snap of this.snaps) restored.push(addPolygonFromSnapshot(this.ds, snap));
    this.onRestored?.(restored);
  }
}

export class UpdatePolygonCommand implements Command {
  readonly name = "UpdatePolygon";

  constructor(
    private readonly ds: Cesium.CustomDataSource,
    private readonly entityId: string,
    private readonly before: PolygonSnapshot,
    private readonly after: PolygonSnapshot,
    private readonly onApplied?: () => void,
  ) {}

  do(): void {
    applyPolygonSnapshot(this.ds, this.entityId, this.after);
    this.onApplied?.();
  }

  undo(): void {
    applyPolygonSnapshot(this.ds, this.entityId, this.before);
    this.onApplied?.();
  }
}

export class RemovePolygonCommand implements Command {
  readonly name = "RemovePolygon";
  private snap: PolygonSnapshot | null = null;

  constructor(
    private readonly ds: Cesium.CustomDataSource,
    private readonly entityId: string,
    private readonly onRemoved?: () => void,
    private readonly onRestored?: (e: Cesium.Entity) => void,
  ) {}

  do(): void {
    const e = this.ds.entities.getById(this.entityId);
    if (!e) return;
    this.snap = snapshotPolygonEntity(e);
    this.ds.entities.remove(e);
    this.onRemoved?.();
  }

  undo(): void {
    if (!this.snap) return;
    const e = addPolygonFromSnapshot(this.ds, this.snap);
    this.onRestored?.(e);
  }
}

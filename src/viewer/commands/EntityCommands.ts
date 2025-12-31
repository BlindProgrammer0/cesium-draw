import * as Cesium from "cesium";
import type { Command } from "./Command";

export type PolygonSnapshot = {
  id?: string;
  name?: string;
  positions: Cesium.Cartesian3[];
  material?: Cesium.MaterialProperty;
  outlineColor?: Cesium.Color;
};

export function addPolygonFromSnapshot(ds: Cesium.CustomDataSource, snap: PolygonSnapshot): Cesium.Entity {
  return ds.entities.add({
    id: snap.id,
    name: snap.name ?? "polygon",
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(snap.positions.map((p) => Cesium.Cartesian3.clone(p))),
      material: snap.material ?? new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
      outline: true,
      outlineColor: snap.outlineColor ?? Cesium.Color.CYAN.withAlpha(0.95),
    },
    properties: { __type: "polygon", __source: "committed" },
  });
}

export function snapshotPolygonEntity(e: Cesium.Entity): PolygonSnapshot | null {
  if (!e.polygon?.hierarchy) return null;
  const hierarchy = e.polygon.hierarchy.getValue(Cesium.JulianDate.now()) as Cesium.PolygonHierarchy | undefined;
  if (!hierarchy?.positions?.length) return null;
  return {
    id: e.id,
    name: e.name ?? undefined,
    positions: hierarchy.positions.map((p) => Cesium.Cartesian3.clone(p)),
    material: e.polygon.material ?? undefined,
    outlineColor: e.polygon.outlineColor ?? undefined,
  };
}

export class AddPolygonCommand implements Command {
  readonly name = "AddPolygon";
  private entity: Cesium.Entity | null = null;

  constructor(
    private readonly ds: Cesium.CustomDataSource,
    private readonly snap: PolygonSnapshot,
    private readonly onAdded?: (e: Cesium.Entity) => void,
    private readonly onRemoved?: (e: Cesium.Entity) => void,
  ) {}

  do(): void {
    if (this.entity) this.entity = addPolygonFromSnapshot(this.ds, { ...this.snap, id: this.entity.id });
    else this.entity = addPolygonFromSnapshot(this.ds, this.snap);
    this.onAdded?.(this.entity);
  }

  undo(): void {
    if (!this.entity) return;
    this.ds.entities.remove(this.entity);
    this.onRemoved?.(this.entity);
  }
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

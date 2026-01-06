import * as Cesium from "cesium";

export class PickService {
  constructor(private readonly viewer: Cesium.Viewer) {}

  pickPosition(screenPos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const scene = this.viewer.scene;

    if (scene.pickPositionSupported) {
      const picked = scene.pickPosition(screenPos);
      if (Cesium.defined(picked)) return picked as Cesium.Cartesian3;
    }

    const ellipsoid = scene.globe.ellipsoid;
    const ray = this.viewer.camera.getPickRay(screenPos);
    if (!ray) return null;
    return ellipsoid.pick(ray, scene) ?? null;
  }

  pickEntity(screenPos: Cesium.Cartesian2): Cesium.Entity | null {
    const picked = this.viewer.scene.pick(screenPos);
    if (!picked || !("id" in picked)) return null;
    const id = (picked as any).id;
    return id instanceof Cesium.Entity ? id : null;
  }

  /**
   * Pick a committed feature id rendered by CesiumFeatureLayer.
   * Returns null if the picked entity is not a feature.
   */
  pickFeatureId(screenPos: Cesium.Cartesian2): string | null {
    const e = this.pickEntity(screenPos);
    if (!e) return null;
    const props = e.properties?.getValue(Cesium.JulianDate.now());
    const fid = props?.__featureId;
    return typeof fid === "string" ? fid : null;
  }
}

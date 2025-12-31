import * as Cesium from "cesium";

export class PickService {
  constructor(private readonly viewer: Cesium.Viewer) {}

  /**
   * 屏幕坐标 -> 世界坐标（Cartesian3）。
   * 优先使用 scene.pickPosition（需要深度纹理 & 支持），否则回退到椭球拾取。
   */
  pickPosition(screenPos: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const scene = this.viewer.scene;

    // pickPosition 需要 scene.pickPositionSupported
    if (scene.pickPositionSupported) {
      const picked = scene.pickPosition(screenPos);
      if (Cesium.defined(picked)) return picked as Cesium.Cartesian3;
    }

    // 回退：从椭球拾取（不依赖地形/3D Tiles 深度）
    const ellipsoid = scene.globe.ellipsoid;
    const ray = this.viewer.camera.getPickRay(screenPos);
    if (!ray) return null;
    const cart = ellipsoid.pick(ray, scene);
    return cart ?? null;
  }

  /**
   * 拾取 Entity（点击要素等）。
   */
  pickEntity(screenPos: Cesium.Cartesian2): Cesium.Entity | null {
    const picked = this.viewer.scene.pick(screenPos);
    if (!picked || !("id" in picked)) return null;
    const id = (picked as any).id;
    return id instanceof Cesium.Entity ? id : null;
  }
}

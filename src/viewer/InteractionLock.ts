import * as Cesium from "cesium";

export type CameraControlOverrides = Partial<{
  enableRotate: boolean;
  enableTranslate: boolean;
  enableZoom: boolean;
  enableTilt: boolean;
  enableLook: boolean;
}>;

type Snapshot = Required<CameraControlOverrides>;

/**
 * InteractionLock
 *
 * Deterministically manages Cesium camera controls across tools.
 *
 * Invariants:
 * - First acquire captures a snapshot of camera control flags.
 * - Each acquire can apply overrides (e.g. disable translate during draw).
 * - Release restores the snapshot once all acquisitions are released.
 */
export class InteractionLock {
  private snapshot: Snapshot | null = null;
  private activeTokens = new Map<string, CameraControlOverrides>();

  constructor(private readonly viewer: Cesium.Viewer) {}

  acquire(token: string, overrides: CameraControlOverrides = {}) {
    if (!token) throw new Error("InteractionLock.acquire: token is required");

    // capture initial snapshot on first acquire
    if (!this.snapshot) {
      const c = this.viewer.scene.screenSpaceCameraController;
      this.snapshot = {
        enableRotate: c.enableRotate,
        enableTranslate: c.enableTranslate,
        enableZoom: c.enableZoom,
        enableTilt: c.enableTilt,
        enableLook: (c as any).enableLook ?? true,
      };
    }

    this.activeTokens.set(token, overrides);
    this.apply();

    return () => this.release(token);
  }

  release(token: string) {
    this.activeTokens.delete(token);
    if (this.activeTokens.size === 0) {
      this.restore();
      return;
    }
    this.apply();
  }

  clear() {
    this.activeTokens.clear();
    this.restore();
  }

  private apply() {
    if (!this.snapshot) return;
    const c = this.viewer.scene.screenSpaceCameraController;

    // start from snapshot, then apply overrides in insertion order
    const next: Snapshot = { ...this.snapshot };
    for (const [, o] of this.activeTokens) Object.assign(next, o);

    c.enableRotate = next.enableRotate;
    c.enableTranslate = next.enableTranslate;
    c.enableZoom = next.enableZoom;
    c.enableTilt = next.enableTilt;
    (c as any).enableLook = next.enableLook;
  }

  private restore() {
    if (!this.snapshot) return;
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = this.snapshot.enableRotate;
    c.enableTranslate = this.snapshot.enableTranslate;
    c.enableZoom = this.snapshot.enableZoom;
    c.enableTilt = this.snapshot.enableTilt;
    (c as any).enableLook = this.snapshot.enableLook;
    this.snapshot = null;
  }
}

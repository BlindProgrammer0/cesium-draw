import * as Cesium from "cesium";
import type { SnapCandidate } from "./SnapTypes";

export type SnapIndicatorOptions = {
  enabled?: boolean;
};

/**
 * Visual feedback for snapping. Uses a dedicated data source and does NOT participate in undo/redo.
 */
export class SnapIndicator {
  private ds: Cesium.CustomDataSource;
  private point: Cesium.Entity;
  private line: Cesium.Entity;
  private label: Cesium.Entity;
  private enabled = true;

  constructor(private readonly viewer: Cesium.Viewer) {
    this.ds = new Cesium.CustomDataSource("snap-indicator");
    viewer.dataSources.add(this.ds);

    this.point = this.ds.entities.add({
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize: 10,
        color: Cesium.Color.LIME.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { __type: "snap-indicator" },
      show: false,
    });

    this.line = this.ds.entities.add({
      polyline: {
        positions: [Cesium.Cartesian3.ZERO, Cesium.Cartesian3.ZERO],
        width: 2,
        material: Cesium.Color.LIME.withAlpha(0.75),
        clampToGround: false,
      },
      properties: { __type: "snap-indicator" },
      show: false,
    });

    this.label = this.ds.entities.add({
      position: Cesium.Cartesian3.ZERO,
      label: {
        text: "",
        font: "12px sans-serif",
        fillColor: Cesium.Color.WHITE.withAlpha(0.95),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.35),
        pixelOffset: new Cesium.Cartesian2(12, -12),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      properties: { __type: "snap-indicator" },
      show: false,
    });
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) this.hide();
  }

  getEnabled() {
    return this.enabled;
  }

  show(candidate: SnapCandidate, cursorWorld?: Cesium.Cartesian3) {
    if (!this.enabled) return;

    const pos = candidate.position;
    this.point.position = Cesium.Cartesian3.clone(pos) as any;
    this.point.show = true;

    const labelText = `${candidate.type} (${candidate.distancePx.toFixed(1)}px)`;
    (this.label.label as any).text = labelText;
    this.label.position = Cesium.Cartesian3.clone(pos) as any;
    this.label.show = true;

    if (cursorWorld) {
      (this.line.polyline as any).positions = [
        Cesium.Cartesian3.clone(cursorWorld),
        Cesium.Cartesian3.clone(pos),
      ];
      this.line.show = true;
    } else {
      this.line.show = false;
    }
  }

  hide() {
    this.point.show = false;
    this.line.show = false;
    this.label.show = false;
  }

  destroy() {
    try {
      this.viewer.dataSources.remove(this.ds, true);
    } catch {
      // ignore
    }
  }
}

import * as Cesium from "cesium";
import { PickService } from "./viewer/PickService";
import { PolygonDrawTool } from "./viewer/PolygonDrawTool";
import { geojsonFeatureCollectionFromEntities } from "./viewer/geojson";

export function createApp(mountEl: HTMLElement) {
  // Cesium 运行时静态资源根目录（对应 viteStaticCopy 的输出 /cesium）
  // 注意：必须在 new Viewer 之前设置
  (window as any).CESIUM_BASE_URL = "/cesium/";

  const root = document.createElement("div");
  root.id = "root";

  const container = document.createElement("div");
  container.id = "cesiumContainer";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h1>Vite + TypeScript + Cesium：Polygon 绘制 / 预览 / 取消 / 撤销 / 导出 GeoJSON</h1>

    <div class="row">
      <span class="badge"><span class="dot off" id="stateDot"></span><span id="stateText">idle</span></span>
      <span class="badge"><b>点数：</b><span id="ptCount">0</span></span>
      <span class="badge"><b>提示：</b>左键加点，右键结束，多边形至少 3 点</span>
    </div>

    <div class="row">
      <button class="btn primary" id="btnStart">开始绘制</button>
      <button class="btn" id="btnFinish">完成（预览锁定）</button>
      <button class="btn" id="btnUndo">撤销上一步</button>
      <button class="btn danger" id="btnCancel">取消绘制</button>
      <button class="btn" id="btnClear">清空图形</button>
      <button class="btn" id="btnExport">导出 GeoJSON</button>
      <button class="btn" id="btnCopy">复制 GeoJSON</button>
    </div>

    <div class="kv">
      <div><b>PickService</b></div>
      <div>单击地球可拾取位置（经纬度/高度），并显示在控制台。绘制时会自动使用拾取位置。</div>
      <div><b>说明</b></div>
      <div>默认基于椭球拾取（无地形也可用）。若开启地形且支持，将优先使用 scene.pickPosition。</div>
    </div>

    <textarea class="textarea" id="geojsonOut" spellcheck="false" placeholder="点击“导出 GeoJSON”后，这里会输出 FeatureCollection..."></textarea>
    <div class="hint">可直接把 GeoJSON 保存为 .geojson 文件，用 QGIS / Mapbox Studio / Turf 等工具验证。</div>
  `;

  root.appendChild(container);
  root.appendChild(panel);
  mountEl.appendChild(root);

  const viewer = new Cesium.Viewer(container, {
    animation: false,
    baseLayerPicker: true,
    fullscreenButton: false,
    geocoder: false,
    homeButton: true,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
    shouldAnimate: false,
  });

  // 更直观一些
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.globe.enableLighting = false;

  const pick = new PickService(viewer);

  // 额外：单击拾取演示（不影响绘制）
  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const cart = pick.pickPosition(movement.position);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    const lng = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const h = c.height ?? 0;
    console.log("[PickService] lon/lat/height:", { lng, lat, h });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const draw = new PolygonDrawTool(viewer, pick, {
    // 你可以把颜色/透明度等做成可配置
    polygonMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
    outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
    pointColor: Cesium.Color.YELLOW.withAlpha(0.95),
  });

  // UI wiring
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const stateDot = $("stateDot");
  const stateText = $("stateText");
  const ptCount = $("ptCount");
  const geojsonOut = $("geojsonOut") as HTMLTextAreaElement;

  function refreshStatus() {
    stateText.textContent = draw.state;
    ptCount.textContent = String(draw.pointCount);
    stateDot.classList.toggle("off", draw.state === "idle");
  }

  draw.onStateChange(refreshStatus);
  draw.onPointChange(refreshStatus);
  refreshStatus();

  $("btnStart").addEventListener("click", () => draw.start());
  $("btnFinish").addEventListener("click", () => draw.finish());
  $("btnUndo").addEventListener("click", () => draw.undo());
  $("btnCancel").addEventListener("click", () => draw.cancel());
  $("btnClear").addEventListener("click", () => {
    draw.clearAll();
    geojsonOut.value = "";
  });

  $("btnExport").addEventListener("click", () => {
    const fc = geojsonFeatureCollectionFromEntities(draw.getCommittedEntities());
    geojsonOut.value = JSON.stringify(fc, null, 2);
  });

  $("btnCopy").addEventListener("click", async () => {
    const text = geojsonOut.value.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      // 轻量提示
      stateText.textContent = draw.state + " (copied)";
      setTimeout(refreshStatus, 800);
    } catch {
      alert("复制失败：浏览器可能未授权剪贴板权限。");
    }
  });

  // 初始视角
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(114.3055, 30.5928, 25000), // 武汉附近
    duration: 0.8,
  });

  return { viewer, draw, pick };
}

import * as Cesium from "cesium";
import { PickService } from "./viewer/PickService";
import { PolygonDrawTool } from "./viewer/PolygonDrawTool";
import { geojsonFeatureCollectionFromEntities } from "./viewer/geojson";
import { CommandStack } from "./viewer/commands/CommandStack";

export function createApp(mountEl: HTMLElement) {
  (window as any).CESIUM_BASE_URL = "/cesium/";

  const root = document.createElement("div");
  root.id = "root";

  const container = document.createElement("div");
  container.id = "cesiumContainer";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h1>阶段 1：全局 CommandStack（Undo/Redo）+ Polygon 绘制</h1>

    <div class="row">
      <span class="badge"><span class="dot off" id="stateDot"></span><span id="stateText">idle</span></span>
      <span class="badge"><b>点数：</b><span id="ptCount">0</span></span>
      <span class="badge"><b>已提交：</b><span id="committedCount">0</span></span>
      <span class="badge"><b>Undo/Redo：</b><span id="cmdCount">0/0</span></span>
    </div>

    <div class="row">
      <button class="btn primary" id="btnStart">开始绘制</button>
      <button class="btn" id="btnFinish">完成（提交，可 Undo）</button>
      <button class="btn" id="btnUndoPoint">撤销加点</button>
      <button class="btn danger" id="btnCancel">取消绘制</button>

      <button class="btn" id="btnUndoCmd">Undo</button>
      <button class="btn" id="btnRedoCmd">Redo</button>

      <button class="btn" id="btnClearCommitted">清空已提交（可 Undo）</button>
      <button class="btn" id="btnExport">导出 GeoJSON</button>
      <button class="btn" id="btnCopy">复制 GeoJSON</button>
    </div>

    <div class="kv">
      <div><b>PickService</b></div>
      <div>单击地球可拾取位置（经纬度/高度），并打印到控制台。绘制时自动使用拾取位置。</div>
      <div><b>命令栈</b></div>
      <div>“完成提交 Polygon”和“清空已提交”都会进入命令栈，因此支持全局 Undo/Redo。</div>
    </div>

    <textarea class="textarea" id="geojsonOut" spellcheck="false" placeholder="点击“导出 GeoJSON”后，这里会输出 FeatureCollection..."></textarea>
    <div class="hint">提示：撤销加点只作用于绘制中；Undo/Redo 作用于已提交动作（命令栈）。</div>
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

  viewer.scene.globe.depthTestAgainstTerrain = false;

  const pick = new PickService(viewer);

  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
  clickHandler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const cart = pick.pickPosition(movement.position);
    if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    console.log("[PickService] lon/lat/height:", {
      lng: Cesium.Math.toDegrees(c.longitude),
      lat: Cesium.Math.toDegrees(c.latitude),
      h: c.height ?? 0,
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const stack = new CommandStack();

  const draw = new PolygonDrawTool(viewer, pick, stack, {
    polygonMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
    outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
    pointColor: Cesium.Color.YELLOW.withAlpha(0.95),
  });

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const stateDot = $("stateDot");
  const stateText = $("stateText");
  const ptCount = $("ptCount");
  const committedCount = $("committedCount");
  const cmdCount = $("cmdCount");
  const btnUndoCmd = $("btnUndoCmd") as HTMLButtonElement;
  const btnRedoCmd = $("btnRedoCmd") as HTMLButtonElement;
  const geojsonOut = $("geojsonOut") as HTMLTextAreaElement;

  function refreshStatus() {
    stateText.textContent = draw.state;
    ptCount.textContent = String(draw.pointCount);
    committedCount.textContent = String(draw.committedCount);
    stateDot.classList.toggle("off", draw.state === "idle");

    cmdCount.textContent = `${stack.undoCount}/${stack.redoCount}`;
    btnUndoCmd.disabled = !stack.canUndo;
    btnRedoCmd.disabled = !stack.canRedo;
  }

  draw.onStateChange(refreshStatus);
  draw.onPointChange(refreshStatus);
  draw.onCommittedChange(refreshStatus);
  stack.onChange(refreshStatus);
  refreshStatus();

  $("btnStart").addEventListener("click", () => draw.start());
  $("btnFinish").addEventListener("click", () => draw.finish());
  $("btnUndoPoint").addEventListener("click", () => draw.undoPoint());
  $("btnCancel").addEventListener("click", () => draw.cancel());

  btnUndoCmd.addEventListener("click", () => stack.undo());
  btnRedoCmd.addEventListener("click", () => stack.redo());

  $("btnClearCommitted").addEventListener("click", () => {
    draw.clearAllCommitted();
    geojsonOut.value = "";
  });

  $("btnExport").addEventListener("click", () => {
    geojsonOut.value = JSON.stringify(geojsonFeatureCollectionFromEntities(draw.getCommittedEntities()), null, 2);
  });

  $("btnCopy").addEventListener("click", async () => {
    const text = geojsonOut.value.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      stateText.textContent = draw.state + " (copied)";
      setTimeout(refreshStatus, 800);
    } catch {
      alert("复制失败：浏览器可能未授权剪贴板权限。");
    }
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(114.3055, 30.5928, 25000),
    duration: 0.8,
  });

  return { viewer, draw, pick, stack };
}

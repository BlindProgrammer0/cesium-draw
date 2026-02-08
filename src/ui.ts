import * as Cesium from "cesium";
import { PickService } from "./viewer/PickService";
import { PolygonDrawTool } from "./viewer/PolygonDrawTool";
import { PolylineDrawTool } from "./viewer/PolylineDrawTool";
import { PointDrawTool } from "./viewer/PointDrawTool";
import { InteractionLock } from "./viewer/InteractionLock";
import { CommandStack } from "./viewer/commands/CommandStack";
import { FeatureEditTool } from "./viewer/edit/FeatureEditTool";
import { ToolController } from "./editor/ToolController";
import { SelectionManager } from "./editor/selection/SelectionManager";
import { PickResolver } from "./editor/pick/PickResolver";
import { FeatureStore } from "./features/store";
import { CesiumFeatureLayer } from "./features/CesiumFeatureLayer";

export function createApp(mountEl: HTMLElement) {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  (window as any).CESIUM_BASE_URL = `${base}cesium/`;

  const root = document.createElement("div");
  root.id = "root";

  const container = document.createElement("div");
  container.id = "cesiumContainer";

  const leftToolbar = document.createElement("div");
  leftToolbar.className = "left-toolbar";
  leftToolbar.innerHTML = `
    <button class="btn primary draw-btn" id="btnDrawPolygon">Polygon</button>
    <button class="btn primary draw-btn" id="btnDrawPolyline">Polyline</button>
    <button class="btn primary draw-btn" id="btnDrawPoint">Point</button>
  `;

  const propPanel = document.createElement("div");
  propPanel.className = "prop-panel";
  propPanel.innerHTML = `
    <div class="panel-header">
      <strong>属性面板</strong>
      <button class="btn ghost" id="btnClosePanel">关闭</button>
    </div>

    <div id="notice" class="notice"></div>

    <div class="panel-section">
      <div class="panel-row"><span>Mode</span><code id="stateText">idle</code></div>
      <div class="panel-row"><span>Drawing Kind</span><code id="drawingKind">-</code></div>
      <div class="panel-row"><span>Point Count</span><code id="ptCount">0</code></div>
      <div class="panel-row"><span>Committed</span><code id="committedCount">0</code></div>
      <div class="panel-row"><span>Selected</span><code id="selectedId">-</code></div>
      <div class="panel-row"><span>Active Vertex</span><code id="activeVertex">-</code></div>
      <div class="panel-row"><span>Undo/Redo</span><code id="cmdCount">0/0</code></div>
    </div>

    <div class="panel-section">
      <div class="panel-title">操作</div>
      <div class="action-grid">
        <button class="btn" id="btnFinish">完成绘制</button>
        <button class="btn danger" id="btnCancel">取消绘制</button>
        <button class="btn" id="btnUndoPoint">撤销加点</button>
        <button class="btn" id="btnDeselect">取消选中</button>
        <button class="btn" id="btnUndoCmd">Undo</button>
        <button class="btn" id="btnRedoCmd">Redo</button>
        <button class="btn danger" id="btnDeleteSelected">删除选中</button>
        <button class="btn danger" id="btnDeleteVertex">删除选中顶点</button>
        <button class="btn danger" id="btnClearCommitted">清空已提交</button>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-title">吸附</div>
      <label class="field"><input type="checkbox" id="snapEnabled" checked /> 启用吸附</label>
      <label class="field"><input type="checkbox" id="snapIndicator" checked /> 提示显示</label>
      <label class="field"><input type="checkbox" id="snapToPolygons" checked /> 其他要素</label>
      <label class="field"><input type="checkbox" id="snapToGrid" /> 网格源</label>

      <label class="field"><input type="checkbox" id="snapTypeVertex" checked /> 顶点</label>
      <label class="field"><input type="checkbox" id="snapTypeMid" checked /> 中点</label>
      <label class="field"><input type="checkbox" id="snapTypeEdge" checked /> 边</label>
      <label class="field"><input type="checkbox" id="snapTypeGrid" /> 网格点</label>

      <label class="field">
        阈值(px)
        <input type="range" id="snapThreshold" min="4" max="32" value="12" />
        <code id="snapThresholdVal">12</code>
      </label>
      <label class="field">
        网格(m)
        <input type="range" id="gridSize" min="1" max="50" value="5" />
        <code id="gridSizeVal">5</code>
      </label>
    </div>
  `;

  const reopenPanelBtn = document.createElement("button");
  reopenPanelBtn.className = "btn panel-toggle";
  reopenPanelBtn.id = "btnOpenPanel";
  reopenPanelBtn.textContent = "属性";
  reopenPanelBtn.hidden = true;

  root.appendChild(container);
  root.appendChild(leftToolbar);
  root.appendChild(propPanel);
  root.appendChild(reopenPanelBtn);
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
  const selection = new SelectionManager();
  const pickResolver = new PickResolver(viewer);
  const interactionLock = new InteractionLock(viewer);
  const stack = new CommandStack();
  const store = new FeatureStore();

  const noticeEl = propPanel.querySelector<HTMLDivElement>("#notice")!;
  let noticeTimer: number | null = null;
  const setNotice = (msg: string) => {
    noticeEl.textContent = msg;
    noticeEl.style.display = msg ? "block" : "none";
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    if (msg) {
      noticeTimer = window.setTimeout(() => setNotice(""), 4000);
    }
  };

  const featureLayer = new CesiumFeatureLayer(store, {
    name: "feature-layer",
    polygonStyle: {
      material: new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
      outlineColor: Cesium.Color.CYAN,
    },
    polylineStyle: {
      material: new Cesium.ColorMaterialProperty(Cesium.Color.YELLOW.withAlpha(0.9)),
      width: 3,
    },
    pointStyle: {
      color: Cesium.Color.YELLOW,
      pixelSize: 10,
    },
  });
  featureLayer.mount(viewer);

  const drawPolygon = new PolygonDrawTool(viewer, interactionLock, pick, stack, store, {
    onNotice: setNotice,
    polygonMaterial: new Cesium.ColorMaterialProperty(Cesium.Color.CYAN.withAlpha(0.25)),
    outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
    pointColor: Cesium.Color.YELLOW.withAlpha(0.95),
  });
  const drawPolyline = new PolylineDrawTool(viewer, interactionLock, pick, stack, store, {
    onNotice: setNotice,
  });
  const drawPoint = new PointDrawTool(viewer, interactionLock, pick, stack, store, {
    onNotice: setNotice,
  });

  const edit = new FeatureEditTool(
    viewer,
    interactionLock,
    selection,
    pickResolver,
    featureLayer,
    store,
    pick,
    stack,
    () =>
      drawPolygon.state === "drawing" ||
      drawPolyline.getState() === "drawing" ||
      drawPoint.getState() === "drawing",
    { onNotice: setNotice },
  );

  const controller = new ToolController(
    stack,
    store,
    selection,
    drawPolygon,
    drawPolyline,
    drawPoint,
    edit,
  );

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const stateText = $("stateText");
  const drawingKind = $("drawingKind");
  const ptCount = $("ptCount");
  const committedCount = $("committedCount");
  const selectedId = $("selectedId");
  const activeVertex = $("activeVertex");
  const cmdCount = $("cmdCount");
  const btnUndoCmd = $("btnUndoCmd") as HTMLButtonElement;
  const btnRedoCmd = $("btnRedoCmd") as HTMLButtonElement;
  const btnDeleteSelected = $("btnDeleteSelected") as HTMLButtonElement;
  const btnDeleteVertex = $("btnDeleteVertex") as HTMLButtonElement;
  const btnDrawPolygon = $("btnDrawPolygon") as HTMLButtonElement;
  const btnDrawPolyline = $("btnDrawPolyline") as HTMLButtonElement;
  const btnDrawPoint = $("btnDrawPoint") as HTMLButtonElement;

  const snapEnabled = $("snapEnabled") as HTMLInputElement;
  const snapIndicator = $("snapIndicator") as HTMLInputElement;
  const snapToPolygons = $("snapToPolygons") as HTMLInputElement;
  const snapToGrid = $("snapToGrid") as HTMLInputElement;
  const snapTypeVertex = $("snapTypeVertex") as HTMLInputElement;
  const snapTypeMid = $("snapTypeMid") as HTMLInputElement;
  const snapTypeEdge = $("snapTypeEdge") as HTMLInputElement;
  const snapTypeGrid = $("snapTypeGrid") as HTMLInputElement;
  const snapThreshold = $("snapThreshold") as HTMLInputElement;
  const snapThresholdVal = $("snapThresholdVal");
  const gridSize = $("gridSize") as HTMLInputElement;
  const gridSizeVal = $("gridSizeVal");

  const startDraw = (kind: "polygon" | "polyline" | "point") => {
    controller.startDrawing(kind);
  };

  btnDrawPolygon.addEventListener("click", () => startDraw("polygon"));
  btnDrawPolyline.addEventListener("click", () => startDraw("polyline"));
  btnDrawPoint.addEventListener("click", () => startDraw("point"));

  $("btnFinish").addEventListener("click", () => controller.finishDrawing());
  $("btnCancel").addEventListener("click", () => controller.cancelDrawing());
  $("btnUndoPoint").addEventListener("click", () => controller.undoDrawPoint());
  $("btnUndoCmd").addEventListener("click", () => controller.undo());
  $("btnRedoCmd").addEventListener("click", () => controller.redo());
  $("btnDeleteSelected").addEventListener("click", () => controller.deleteSelected());
  $("btnDeleteVertex").addEventListener("click", () => controller.deleteActiveVertex());
  $("btnDeselect").addEventListener("click", () => controller.deselect());
  $("btnClearCommitted").addEventListener("click", () => controller.clearCommitted());

  $("btnClosePanel").addEventListener("click", () => {
    propPanel.classList.add("collapsed");
    reopenPanelBtn.hidden = false;
  });
  reopenPanelBtn.addEventListener("click", () => {
    propPanel.classList.remove("collapsed");
    reopenPanelBtn.hidden = true;
  });

  snapEnabled.addEventListener("change", () => edit.setSnapEnabled(snapEnabled.checked));
  snapIndicator.addEventListener("change", () =>
    edit.setSnapIndicatorEnabled(snapIndicator.checked),
  );
  snapToPolygons.addEventListener("change", () =>
    edit.setSnapSources({ polygons: snapToPolygons.checked }),
  );
  snapToGrid.addEventListener("change", () => {
    edit.setSnapSources({ grid: snapToGrid.checked });
    edit.setSnapTypes({ grid: snapToGrid.checked });
    snapTypeGrid.checked = snapToGrid.checked;
  });

  const applySnapTypesFromUI = () => {
    edit.setSnapTypes({
      vertex: snapTypeVertex.checked,
      midpoint: snapTypeMid.checked,
      edge: snapTypeEdge.checked,
      grid: snapTypeGrid.checked,
    });
  };
  snapTypeVertex.addEventListener("change", applySnapTypesFromUI);
  snapTypeMid.addEventListener("change", applySnapTypesFromUI);
  snapTypeEdge.addEventListener("change", applySnapTypesFromUI);
  snapTypeGrid.addEventListener("change", () => {
    const enabled = snapTypeGrid.checked;
    edit.setSnapSources({ grid: enabled });
    snapToGrid.checked = enabled;
    applySnapTypesFromUI();
  });

  snapThreshold.addEventListener("input", () => {
    const v = Number(snapThreshold.value);
    snapThresholdVal.textContent = String(v);
    edit.setSnapThresholdPx(v);
  });
  gridSize.addEventListener("input", () => {
    const v = Number(gridSize.value);
    gridSizeVal.textContent = String(v);
    edit.setGridSizeMeters(v);
  });

  edit.setSnapEnabled(snapEnabled.checked);
  edit.setSnapIndicatorEnabled(snapIndicator.checked);
  edit.setSnapSources({ polygons: snapToPolygons.checked, grid: snapToGrid.checked });
  edit.setSnapTypes({
    vertex: snapTypeVertex.checked,
    midpoint: snapTypeMid.checked,
    edge: snapTypeEdge.checked,
    grid: snapTypeGrid.checked,
  });
  edit.setSnapThresholdPx(Number(snapThreshold.value));
  edit.setGridSizeMeters(Number(gridSize.value));

  const refreshStatus = () => {
    const mode = controller.mode;
    const kind = controller.drawingKind;
    stateText.textContent = mode;
    drawingKind.textContent = kind ?? "-";
    ptCount.textContent = String(
      mode === "draw"
        ? kind === "polygon"
          ? drawPolygon.pointCount
          : kind === "polyline"
            ? drawPolyline.pointCount
            : kind === "point"
              ? drawPoint.pointCount
              : 0
        : 0,
    );
    committedCount.textContent = String(store.size);
    selectedId.textContent = edit.selectedEntityId
      ? `${edit.selectedEntityId} (${edit.selectedEntityKind ?? "-"})`
      : "-";
    activeVertex.textContent =
      edit.activeVertexIndex === null ? "-" : String(edit.activeVertexIndex);
    cmdCount.textContent = `${stack.undoCount}/${stack.redoCount}`;
    btnUndoCmd.disabled = !stack.canUndo;
    btnRedoCmd.disabled = !stack.canRedo;
    btnDeleteSelected.disabled = !edit.selectedEntityId;
    btnDeleteVertex.disabled = !(edit.selectedEntityId && edit.activeVertexIndex !== null);

    const drawingPolygon = mode === "draw" && kind === "polygon";
    const drawingPolyline = mode === "draw" && kind === "polyline";
    const drawingPoint = mode === "draw" && kind === "point";
    btnDrawPolygon.classList.toggle("active", drawingPolygon);
    btnDrawPolyline.classList.toggle("active", drawingPolyline);
    btnDrawPoint.classList.toggle("active", drawingPoint);
  };

  controller.onChange(() => {
    if (edit.selectedEntityId) edit.refreshHandles();
    refreshStatus();
  });
  refreshStatus();

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(114.3055, 30.5928, 25000),
    duration: 0.8,
  });

  return { viewer, controller, edit, pick, stack };
}

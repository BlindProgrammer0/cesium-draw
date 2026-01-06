import * as Cesium from "cesium";
import { PickService } from "./viewer/PickService";
import { PolygonDrawTool } from "./viewer/PolygonDrawTool";
import { geojsonFeatureCollectionFromEntities } from "./viewer/geojson";
import { CommandStack } from "./viewer/commands/CommandStack";
import { PolygonEditTool } from "./viewer/edit/PolygonEditTool";
import { EditorSession } from "./editor/EditorSession";

export function createApp(mountEl: HTMLElement) {
  // Cesium 会在运行时动态请求 Workers/Assets/Widgets 等静态资源。
  // 资源由 vite-plugin-static-copy 拷贝到 {base}/cesium 下，因此这里必须与 Vite 的 base 保持一致。
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  (window as any).CESIUM_BASE_URL = `${base}cesium/`;

  const root = document.createElement("div");
  root.id = "root";

  const container = document.createElement("div");
  container.id = "cesiumContainer";

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <h1>阶段 4：GIS 吸附编辑（顶点/中点/边/网格 + 吸附源 + 优先级 + 可视化提示，全部可 Undo/Redo）</h1>

    <div class="row">
      <span class="badge"><span class="dot off" id="stateDot"></span><span id="stateText">idle</span></span>
      <span class="badge"><b>点数：</b><span id="ptCount">0</span></span>
      <span class="badge"><b>已提交：</b><span id="committedCount">0</span></span>
      <span class="badge"><b>选中：</b><span id="selectedId">-</span></span>
      <span class="badge"><b>顶点：</b><span id="activeVertex">-</span></span>
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
      <button class="btn danger" id="btnDeleteSelected">删除选中 Polygon（可 Undo）</button>
      <button class="btn danger" id="btnDeleteVertex">删除选中顶点（可 Undo）</button>
      <button class="btn" id="btnDeselect">取消选中</button>
      <button class="btn" id="btnExport">导出 GeoJSON</button>
      <button class="btn" id="btnCopy">复制 GeoJSON</button>
    </div>

    <div class="row">
      <label class="field"><input type="checkbox" id="snapEnabled" checked /> 吸附</label>
      <label class="field"><input type="checkbox" id="snapIndicator" checked /> 提示</label>
      <label class="field"><input type="checkbox" id="snapToPolygons" checked /> 其他要素</label>
      <label class="field"><input type="checkbox" id="snapToGrid" /> 网格</label>
    </div>

    <div class="row">
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

    <div class="kv">
      <div><b>插入点</b></div>
      <div>选中 Polygon 后，按住 <b>Ctrl</b> 并点击边附近，会在最近边插入顶点（支持 Undo/Redo）。</div>

      <div><b>删单点</b></div>
      <div>点击某个橙色顶点（会变红）后，按 <b>Delete</b> 删除该顶点（至少保留 3 个点）。</div>

      <div><b>整体平移</b></div>
      <div>按住 <b>Shift</b> 并拖拽 Polygon，可整体平移（支持吸附与 Undo/Redo）。</div>

      <div><b>吸附</b></div>
      <div>拖拽顶点/平移时，按配置吸附到：顶点/中点/边/网格。优先级：顶点 &gt; 中点 &gt; 边 &gt; 网格。</div>
    </div>

    <textarea class="textarea" id="geojsonOut" spellcheck="false" placeholder="点击“导出 GeoJSON”后，这里会输出 FeatureCollection..."></textarea>
    <div class="hint">提示：撤销加点只作用于绘制中；Undo/Redo 作用于已提交动作（提交/清空/编辑/插点/删点/删除）。</div>
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
  clickHandler.setInputAction(
    (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const cart = pick.pickPosition(movement.position);
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      console.log("[PickService] lon/lat/height:", {
        lng: Cesium.Math.toDegrees(c.longitude),
        lat: Cesium.Math.toDegrees(c.latitude),
        h: c.height ?? 0,
      });
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK
  );

  const stack = new CommandStack();

  const draw = new PolygonDrawTool(viewer, pick, stack, {
    polygonMaterial: new Cesium.ColorMaterialProperty(
      Cesium.Color.CYAN.withAlpha(0.25)
    ),
    outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
    pointColor: Cesium.Color.YELLOW.withAlpha(0.95),
  });

  const edit = new PolygonEditTool(
    viewer,
    draw.ds,
    pick,
    stack,
    () => draw.state === "drawing"
  );

  // Stage 5.1: Use a single session as the orchestration boundary.
  const session = new EditorSession(draw, edit, pick, stack);

  const $ = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const stateDot = $("stateDot");
  const stateText = $("stateText");
  const ptCount = $("ptCount");
  const committedCount = $("committedCount");
  const selectedId = $("selectedId");
  const activeVertex = $("activeVertex");
  const cmdCount = $("cmdCount");
  const btnUndoCmd = $("btnUndoCmd") as HTMLButtonElement;
  const btnRedoCmd = $("btnRedoCmd") as HTMLButtonElement;
  const btnDeleteSelected = $("btnDeleteSelected") as HTMLButtonElement;
  const btnDeleteVertex = $("btnDeleteVertex") as HTMLButtonElement;
  const geojsonOut = $("geojsonOut") as HTMLTextAreaElement;

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

  function refreshStatus() {
    const st = session.state;
    stateText.textContent = st.mode;
    ptCount.textContent = String(draw.pointCount);
    committedCount.textContent = String(draw.committedCount);
    stateDot.classList.toggle("off", st.mode === "idle");

    selectedId.textContent = edit.selectedEntityId ?? "-";
    activeVertex.textContent =
      edit.activeVertexIndex === null ? "-" : String(edit.activeVertexIndex);

    cmdCount.textContent = `${stack.undoCount}/${stack.redoCount}`;
    btnUndoCmd.disabled = !stack.canUndo;
    btnRedoCmd.disabled = !stack.canRedo;

    btnDeleteSelected.disabled = !edit.selectedEntityId;
    btnDeleteVertex.disabled = !(
      edit.selectedEntityId && edit.activeVertexIndex !== null
    );
  }

  snapEnabled.addEventListener("change", () =>
    edit.setSnapEnabled(snapEnabled.checked)
  );

  snapIndicator.addEventListener("change", () =>
    edit.setSnapIndicatorEnabled(snapIndicator.checked)
  );

  snapToPolygons.addEventListener("change", () =>
    edit.setSnapSources({ polygons: snapToPolygons.checked })
  );

  snapToGrid.addEventListener("change", () => {
    edit.setSnapSources({ grid: snapToGrid.checked });
    edit.setSnapTypes({ grid: snapToGrid.checked });
    snapTypeGrid.checked = snapToGrid.checked;
  });

  function applySnapTypesFromUI() {
    edit.setSnapTypes({
      vertex: snapTypeVertex.checked,
      midpoint: snapTypeMid.checked,
      edge: snapTypeEdge.checked,
      grid: snapTypeGrid.checked,
    });
  }
  snapTypeVertex.addEventListener("change", applySnapTypesFromUI);
  snapTypeMid.addEventListener("change", applySnapTypesFromUI);
  snapTypeEdge.addEventListener("change", applySnapTypesFromUI);
  snapTypeGrid.addEventListener("change", () => {
    // Grid type implies grid source
    const v = snapTypeGrid.checked;
    edit.setSnapSources({ grid: v });
    snapToGrid.checked = v;
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

  // Initial sync from UI
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

  // Session-driven refresh (stage 5). We keep the existing per-tool hooks,
  // but centralize UI invalidation through the session boundary.
  session.onChange(() => {
    if (edit.selectedEntityId) edit.refreshHandles();
    refreshStatus();
  });
  refreshStatus();

  $("btnStart").addEventListener("click", () => session.startDrawing());
  $("btnFinish").addEventListener("click", () => session.finishDrawing());
  $("btnUndoPoint").addEventListener("click", () => session.undoDrawPoint());
  $("btnCancel").addEventListener("click", () => session.cancelDrawing());

  btnUndoCmd.addEventListener("click", () => session.undo());
  btnRedoCmd.addEventListener("click", () => session.redo());

  $("btnClearCommitted").addEventListener("click", () => {
    session.clearCommitted();
    geojsonOut.value = "";
  });

  $("btnDeleteSelected").addEventListener("click", () => {
    session.deleteSelectedPolygon();
    geojsonOut.value = "";
  });

  $("btnDeleteVertex").addEventListener("click", () => {
    session.deleteActiveVertex();
    geojsonOut.value = "";
  });

  $("btnDeselect").addEventListener("click", () => session.deselect());

  $("btnExport").addEventListener("click", () => {
    geojsonOut.value = JSON.stringify(
      geojsonFeatureCollectionFromEntities(draw.getCommittedEntities()),
      null,
      2
    );
  });

  $("btnCopy").addEventListener("click", async () => {
    const text = geojsonOut.value.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      stateText.textContent = session.state.mode + " (copied)";
      setTimeout(refreshStatus, 800);
    } catch {
      alert("复制失败：浏览器可能未授权剪贴板权限。");
    }
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(114.3055, 30.5928, 25000),
    duration: 0.8,
  });

  return { viewer, session, draw, edit, pick, stack };
}

import * as Cesium from "cesium";
import { PickService } from "./viewer/PickService";
import { PolygonDrawTool } from "./viewer/PolygonDrawTool";
import { PolylineDrawTool } from "./viewer/PolylineDrawTool";
import { PointDrawTool } from "./viewer/PointDrawTool";
import { InteractionLock } from "./viewer/InteractionLock";
import {
  geojsonFeatureCollectionFromFeatures,
  polygonFeaturesFromGeoJSON,
} from "./features/geojson";
import { CommandStack } from "./viewer/commands/CommandStack";
import { FeatureEditTool } from "./viewer/edit/FeatureEditTool";
import { ToolController } from "./editor/ToolController";
import { SelectionManager } from "./editor/selection/SelectionManager";
import { PickResolver } from "./editor/pick/PickResolver";
import { FeatureStore } from "./features/store";
import { CesiumFeatureLayer } from "./features/CesiumFeatureLayer";
import {
  ReplaceAllFeaturesCommand,
  UpsertManyFeaturesCommand,
} from "./features/commands";
import { validatePolygonPositions } from "./features/validation";

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
    <div id="notice" class="notice"></div>

    <div class="row">
      <span class="badge"><span class="dot off" id="stateDot"></span><span id="stateText">idle</span></span>
      <span class="badge"><b>点数：</b><span id="ptCount">0</span></span>
      <span class="badge"><b>已提交：</b><span id="committedCount">0</span></span>
      <span class="badge"><b>选中：</b><span id="selectedId">-</span></span>
      <span class="badge"><b>顶点：</b><span id="activeVertex">-</span></span>
      <span class="badge"><b>Undo/Redo：</b><span id="cmdCount">0/0</span></span>
    </div>

    <div class="row">
      <label class="badge"><b>绘制类型：</b><select id="drawKind"><option value="polygon">Polygon</option><option value="polyline">Polyline</option><option value="point">Point</option></select></label>
      <button class="btn primary" id="btnStart">开始绘制</button>
      <button class="btn" id="btnFinish">完成（提交，可 Undo）</button>
      <button class="btn" id="btnUndoPoint">撤销加点</button>
      <button class="btn danger" id="btnCancel">取消绘制</button>

      <button class="btn" id="btnUndoCmd">Undo</button>
      <button class="btn" id="btnRedoCmd">Redo</button>

      <button class="btn" id="btnClearCommitted">清空已提交（可 Undo）</button>
      <button class="btn danger" id="btnDeleteSelected">删除选中要素（可 Undo）</button>
      <button class="btn danger" id="btnDeleteVertex">删除选中顶点（可 Undo）</button>
      <button class="btn" id="btnDeselect">取消选中</button>
      <button class="btn" id="btnExport">导出 GeoJSON</button>
      <button class="btn" id="btnCopy">复制 GeoJSON</button>
      <label class="field">
        导入策略
        <select id="importStrategy" class="select">
          <option value="merge" selected>合并（同 id 覆盖）</option>
          <option value="append">追加（自动新 ID）</option>
          <option value="overwrite">覆盖（清空后导入）</option>
        </select>
      </label>
      <button class="btn" id="btnImport">导入 GeoJSON（预检 + 可 Undo）</button>
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

    <input type="file" id="geojsonFile" accept=".geojson,.json,application/geo+json" style="display:none" />
    <textarea class="textarea" id="geojsonOut" spellcheck="false" placeholder="点击“导出 GeoJSON”后，这里会输出 FeatureCollection，也可以导入 FeatureCollection/Feature/Polygon/MultiPolygon..."></textarea>
    <div class="hint">提示：撤销加点只作用于绘制中；Undo/Redo 作用于已提交动作（提交/清空/编辑/插点/删点/删除）。</div>
  `;

  const noticeEl = panel.querySelector<HTMLDivElement>("#notice")!;
  let noticeTimer: any = null;
  const setNotice = (msg: string) => {
    if (!noticeEl) return;
    noticeEl.textContent = msg;
    noticeEl.style.display = msg ? "block" : "none";
    if (noticeTimer) clearTimeout(noticeTimer);
    if (msg) noticeTimer = setTimeout(() => setNotice(""), 4000);
  };

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
  const selection = new SelectionManager();
  const pickResolver = new PickResolver(viewer);

  const interactionLock = new InteractionLock(viewer);

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
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );

  const stack = new CommandStack();

  // Stage 5.2: Feature model is the single source of truth.
  const store = new FeatureStore();

  // Render layer (Feature -> Entity)
  const featureLayer = new CesiumFeatureLayer(store, {
    name: "feature-layer",
    polygonStyle: {
      material: new Cesium.ColorMaterialProperty(
        Cesium.Color.CYAN.withAlpha(0.25),
      ),
      outlineColor: Cesium.Color.CYAN,
    },
    polylineStyle: {
      material: new Cesium.ColorMaterialProperty(
        Cesium.Color.YELLOW.withAlpha(0.9),
      ),
      width: 3,
    },
    pointStyle: {
      color: Cesium.Color.YELLOW,
      pixelSize: 10,
    },
  });
  featureLayer.mount(viewer);

  // Draw tools
  const drawPolygon = new PolygonDrawTool(
    viewer,
    interactionLock,
    pick,
    stack,
    store,
    {
      onNotice: setNotice,
      polygonMaterial: new Cesium.ColorMaterialProperty(
        Cesium.Color.CYAN.withAlpha(0.25),
      ),
      outlineColor: Cesium.Color.CYAN.withAlpha(0.95),
      pointColor: Cesium.Color.YELLOW.withAlpha(0.95),
    },
  );

  const drawPolyline = new PolylineDrawTool(
    viewer,
    interactionLock,
    pick,
    stack,
    store,
    { onNotice: setNotice },
  );
  const drawPoint = new PointDrawTool(
    viewer,
    interactionLock,
    pick,
    stack,
    store,
    { onNotice: setNotice },
  );

  // Stage 6.2: unified edit tool for point/polyline/polygon
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

  // Stage 6.3: use ToolController as the single orchestration boundary.
  const controller = new ToolController(
    stack,
    store,
    selection,
    drawPolygon,
    drawPolyline,
    drawPoint,
    edit,
  );

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

  // Stage 5.4: GeoJSON import via hidden file input.
  const geojsonFile = document.createElement("input");
  geojsonFile.type = "file";
  geojsonFile.accept = ".geojson,.json,application/geo+json";
  geojsonFile.style.display = "none";
  panel.appendChild(geojsonFile);

  const importGeoJSON = (
    input: any,
    strategy: "merge" | "append" | "overwrite",
  ) => {
    const parsed = polygonFeaturesFromGeoJSON(input);
    if (parsed.length === 0) {
      setNotice("导入失败：未找到可导入的 Polygon/MultiPolygon。 ");
      geojsonOut.value = JSON.stringify(
        { strategy, ok: false, reason: "no-polygons" },
        null,
        2,
      );
      return;
    }

    // --- preflight ---
    const invalid: { id: string; message: string }[] = [];
    const incomingIds = new Map<string, number>();
    for (const f of parsed) {
      incomingIds.set(f.id, (incomingIds.get(f.id) ?? 0) + 1);
      const v = validatePolygonPositions(f.geometry.positions);
      if (!v.ok)
        invalid.push({
          id: f.id,
          message: v.issues[0]?.message ?? "几何校验失败",
        });
    }

    const duplicatedIncoming = [...incomingIds.entries()]
      .filter(([, c]) => c > 1)
      .map(([id, c]) => ({ id, count: c }));
    const conflicts = parsed.filter((f) => store.has(f.id)).map((f) => f.id);

    const report = {
      strategy,
      total: parsed.length,
      invalidCount: invalid.length,
      duplicatedIncomingCount: duplicatedIncoming.length,
      conflictCount: conflicts.length,
      willClear: strategy === "overwrite" ? store.size : 0,
      willAdd:
        strategy === "overwrite"
          ? parsed.length
          : strategy === "merge"
            ? parsed.length - conflicts.length
            : parsed.length,
      willReplace: strategy === "merge" ? conflicts.length : 0,
      notes: [
        "导入仅支持 Polygon/MultiPolygon，且仅使用第一条外环（不处理洞）。",
        "预检失败时不会写入数据。",
        "追加策略会在 id 冲突/重复时自动生成新 id，并在 properties.__sourceId 中保留原 id。",
      ],
      invalid: invalid.slice(0, 20),
      duplicatedIncoming: duplicatedIncoming.slice(0, 20),
      conflicts: conflicts.slice(0, 20),
    };

    geojsonOut.value = JSON.stringify({ preflight: report }, null, 2);

    if (invalid.length) {
      setNotice(`预检失败：发现 ${invalid.length} 个无效几何（详见文本框）。`);
      return;
    }

    // --- normalize by strategy ---
    let features = parsed;
    if (strategy === "append") {
      const used = new Set<string>(store.all().map((f) => f.id));
      const remapped: any[] = [];
      for (const f of parsed) {
        let id = f.id;
        if (used.has(id) || (incomingIds.get(id) ?? 0) > 1) {
          const sourceId = id;
          id = Cesium.createGuid();
          remapped.push({
            ...f,
            id,
            properties: { ...(f.properties ?? {}), __sourceId: sourceId },
            meta: f.meta ? { ...f.meta, updatedAt: Date.now() } : f.meta,
          });
        } else {
          remapped.push(f);
        }
        used.add(id);
      }
      features = remapped as any;
    }

    if (strategy === "overwrite") {
      stack.push(new ReplaceAllFeaturesCommand(store, features));
      setNotice(
        `覆盖导入：清空 ${report.willClear} 个并导入 ${features.length} 个（可 Undo）。`,
      );
    } else {
      stack.push(new UpsertManyFeaturesCommand(store, features));
      setNotice(
        `导入完成：${features.length} 个（${strategy === "append" ? "追加" : "合并"}，可 Undo）。`,
      );
    }

    geojsonOut.value = JSON.stringify(
      geojsonFeatureCollectionFromFeatures(store.all()),
      null,
      2,
    );
  };
  const btnImport = $("btnImport") as HTMLButtonElement;

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
    const mode = controller.mode;
    const kind = controller.drawingKind;
    stateText.textContent = mode;
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
    stateDot.classList.toggle("off", mode === "idle");

    selectedId.textContent = edit.selectedEntityId
      ? `${edit.selectedEntityId} (${edit.selectedEntityKind ?? "-"})`
      : "-";
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

  // ---- GeoJSON import/export ----
  const exportGeoJSON = () => {
    const fc = geojsonFeatureCollectionFromFeatures(store.all());
    geojsonOut.value = JSON.stringify(fc, null, 2);
    setNotice(`已导出 ${fc.features?.length ?? 0} 个要素。`);
  };

  const copyGeoJSON = async () => {
    try {
      await navigator.clipboard.writeText(geojsonOut.value || "");
      setNotice("已复制到剪贴板。");
    } catch {
      setNotice("复制失败：浏览器未授权剪贴板。可手动全选复制。");
    }
  };

  const importGeoJSONText = (text: string) => {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      setNotice("导入失败：不是合法 JSON。");
      return;
    }

    const feats = polygonFeaturesFromGeoJSON(data);
    if (!feats.length) {
      setNotice("导入失败：未识别到 Polygon/MultiPolygon。");
      return;
    }

    // Validate all before commit.
    for (const f of feats) {
      const v = validatePolygonPositions(f.geometry.positions);
      if (!v.ok) {
        const msg = v.issues[0]?.message ?? "几何校验失败";
        setNotice(`导入失败：${msg}`);
        return;
      }
    }

    stack.push(new UpsertManyFeaturesCommand(store, feats));
    setNotice(`已导入 ${feats.length} 个要素（可 Undo）。`);
    refreshStatus();
  };

  snapEnabled.addEventListener("change", () =>
    edit.setSnapEnabled(snapEnabled.checked),
  );

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
  edit.setSnapSources({
    polygons: snapToPolygons.checked,
    grid: snapToGrid.checked,
  });
  edit.setSnapTypes({
    vertex: snapTypeVertex.checked,
    midpoint: snapTypeMid.checked,
    edge: snapTypeEdge.checked,
    grid: snapTypeGrid.checked,
  });
  edit.setSnapThresholdPx(Number(snapThreshold.value));
  edit.setGridSizeMeters(Number(gridSize.value));

  // Controller-driven refresh (stage 6.3): centralize UI invalidation.
  controller.onChange(() => {
    if (edit.selectedEntityId) edit.refreshHandles();
    refreshStatus();
  });
  refreshStatus();

  $("btnStart").addEventListener("click", () => {
    const kind = ($("drawKind") as HTMLSelectElement).value as any;
    controller.startDrawing(kind);
  });
  $("btnFinish").addEventListener("click", () => controller.finishDrawing());
  $("btnUndoPoint").addEventListener("click", () => controller.undoDrawPoint());
  $("btnCancel").addEventListener("click", () => controller.cancelDrawing());

  btnUndoCmd.addEventListener("click", () => controller.undo());
  btnRedoCmd.addEventListener("click", () => controller.redo());

  $("btnClearCommitted").addEventListener("click", () => {
    controller.clearCommitted();
    geojsonOut.value = "";
  });

  $("btnDeleteSelected").addEventListener("click", () => {
    controller.deleteSelected();
    geojsonOut.value = "";
  });

  $("btnDeleteVertex").addEventListener("click", () => {
    controller.deleteActiveVertex();
    geojsonOut.value = "";
  });

  $("btnDeselect").addEventListener("click", () => controller.deselect());

  // Stage 5.4: Import GeoJSON.
  btnImport.addEventListener("click", () => {
    const strategy =
      (($("importStrategy") as HTMLSelectElement)?.value as any) ?? "merge";
    const text = geojsonOut.value.trim();
    if (text) {
      try {
        importGeoJSON(JSON.parse(text), strategy);
        return;
      } catch {
        // fall through to file chooser
      }
    }
    geojsonFile.value = "";
    geojsonFile.click();
  });

  geojsonFile.addEventListener("change", async () => {
    const file = geojsonFile.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const strategy =
        (($("importStrategy") as HTMLSelectElement)?.value as any) ?? "merge";
      importGeoJSON(JSON.parse(text), strategy);
    } catch {
      setNotice("导入失败：文件不是有效 JSON/GeoJSON。 ");
    }
  });

  $("btnExport").addEventListener("click", () => {
    geojsonOut.value = JSON.stringify(
      geojsonFeatureCollectionFromFeatures(store.all()),
      null,
      2,
    );
  });

  $("btnCopy").addEventListener("click", async () => {
    const text = geojsonOut.value.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      stateText.textContent = controller.mode + " (copied)";
      setTimeout(refreshStatus, 800);
    } catch {
      alert("复制失败：浏览器可能未授权剪贴板权限。");
    }
  });

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(114.3055, 30.5928, 25000),
    duration: 0.8,
  });

  return { viewer, controller, edit, pick, stack };
}

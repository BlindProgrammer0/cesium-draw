# 阶段 4：GIS 吸附编辑（基于 stage3 工程升级）

本版本在你原有 **stage3（PolygonEditTool + PickService + CommandStack）** 的基础上，升级为更专业的 GIS 编辑吸附体验。

## 已实现能力

### 吸附（Snapping）
- 吸附类型：**顶点 / 中点 / 边 / 网格点**
- 吸附源：
  - **其他要素（已提交 polygon）**
  - **网格（可配置间距）**
- 吸附优先级：**Vertex > Midpoint > Edge > Grid**
- 吸附阈值：屏幕像素阈值（默认 14px，可在面板调节）
- 可视化吸附提示：命中点 + 类型 + 距离（提示层不进入 Undo/Redo）

### 编辑（Edit）
- 拖拽顶点移动（支持吸附）
- 双击边附近插入点（支持边/中点吸附后插点）
- Shift + 点击顶点删除点（保持 >=3 顶点约束）
- Alt + 拖拽整体平移（支持吸附，可按你的实现策略决定是否对平移吸附）

### Undo / Redo
- 所有几何变更依旧通过 `CommandStack` 统一管理
- **吸附不产生独立命令**：只影响最终落点，命令语义保持干净

## 运行

```bash
npm i
npm run dev
```

## Cesium 静态资源说明（无需手动拷贝）

本项目已在 `vite.config.ts` 使用 `vite-plugin-static-copy`：

- Dev 模式：由 Vite 处理静态资源访问
- Build 模式：资源会被拷贝到 `dist/cesium`

`src/ui.ts` 中的 `CESIUM_BASE_URL` 会自动使用 `import.meta.env.BASE_URL` 拼接成 `{base}/cesium/`，因此无需手动复制到 `public/cesium`。

## 关键文件
- `src/viewer/edit/PolygonEditTool.ts`：编辑工具（阶段 4 吸附接入点）
- `src/viewer/snap/SnappingEngine.ts`：吸附引擎
- `src/viewer/snap/SnapIndicator.ts`：吸附提示层

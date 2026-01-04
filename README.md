# 阶段 3：插入点 / 删单点 / 整体平移 / 吸附阈值（全命令化 Undo/Redo）

新增能力：
- 插入点：选中 polygon 后，Ctrl + 点击边附近 → 最近边插入顶点（UpdatePolygonCommand）
- 删除单个顶点：点击顶点 handle 使其变红 → Delete 删除该顶点（>=3 限制）
- 整体平移：Shift + 拖拽 polygon → 平移整个 polygon（UpdatePolygonCommand）
- 吸附：拖拽顶点/平移时，若鼠标附近存在其他顶点（像素距离 <= 阈值），吸附到该顶点

## 运行
```bash
npm i
npm run dev
```

关键文件：
- `src/viewer/edit/PolygonEditTool.ts`

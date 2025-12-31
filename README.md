# 阶段 2：选中 + 顶点编辑（编辑也可 Undo/Redo）

新增能力：
- 单击已提交 Polygon：选中并高亮
- 自动生成顶点 handle（橙色点），可拖拽编辑顶点
- 拖拽完成（LEFT_UP）后 push `UpdatePolygonCommand` → 可 Undo/Redo
- Delete/Backspace 删除选中（可 Undo/Redo）

## 运行
```bash
npm i
npm run dev
```

## 关键实现
- `src/viewer/edit/PolygonEditTool.ts`
  - 选中：LEFT_CLICK
  - 拖拽：LEFT_DOWN/MOUSE_MOVE/LEFT_UP（命中 handle）
  - 命令：UpdatePolygonCommand / RemovePolygonCommand

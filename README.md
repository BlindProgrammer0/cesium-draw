# 阶段 1：全局 Undo/Redo（CommandStack）

已完成：
- `CommandStack`：全局 Undo/Redo
- 提交 Polygon：`AddPolygonCommand`（可 Undo/Redo）
- 清空已提交：`ClearAllPolygonsCommand`（可 Undo/Redo）
- 仍保留“绘制中撤销加点”

## 运行
```bash
npm i
npm run dev
```

# Vite + TypeScript + Cesium 绘制 Polygon Demo

包含：
- PickService（屏幕坐标拾取世界坐标 / Entity）
- Polygon 绘制（左键加点，右键结束）
- 预览（绘制过程中实时预览 polygon）
- 取消 / 撤销（Undo）
- 导出 GeoJSON（FeatureCollection / Polygon）

## 运行

```bash
pnpm i
pnpm dev
```

或：

```bash
npm i
npm run dev
```

## 注意

- `vite.config.ts` 使用 `vite-plugin-static-copy` 把 `node_modules/cesium/Build/Cesium` 复制到 `/cesium`。
- `src/ui.ts` 中设置了 `window.CESIUM_BASE_URL="/cesium/"`，必须在 `new Cesium.Viewer` 之前设置。

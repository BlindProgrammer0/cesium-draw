import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// Cesium 在运行时会加载 Worker / Assets / Widgets 等静态资源。
// 这里把 node_modules/cesium/Build/Cesium 复制到打包产物的 /cesium 目录。
export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/cesium/Build/Cesium/*",
          dest: "cesium",
        },
      ],
    }),
  ],
  define: {
    // 避免某些依赖检查到 process.env
    "process.env": {},
  },
});

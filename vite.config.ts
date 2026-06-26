import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const host = process.env.TAURI_DEV_HOST;

// Voice Activity Detection (mic) assets must be served locally from the app
// root. The library otherwise fetches them from a CDN, which fails inside the
// Tauri webview (so the microphone silently never starts).
const vadAssets = [
  {
    src: "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
    dest: "",
  },
  { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx", dest: "" },
  { src: "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx", dest: "" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", dest: "" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm", dest: "" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm", dest: "" },
  { src: "node_modules/onnxruntime-web/dist/ort-wasm.wasm", dest: "" },
];

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({ targets: vadAssets }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

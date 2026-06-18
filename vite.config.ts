import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
//
// Build contract with src-tauri/tauri.conf.json:
//   - devUrl       http://localhost:5174  ↔  server.port 5174 (strictPort)
//   - frontendDist ../dist                ↔  build.outDir "dist" (repo-root dist)
export default defineConfig(async () => ({
  // Tailwind v4 is required by the Atlas + Synapse module surfaces (their CSS
  // imports `tailwindcss` and the Atlas @theme tokens). The plugin scans the
  // project for used utilities and emits only those — purely additive to the
  // shell's own plain-CSS chrome (src/index.css).
  plugins: [react(), tailwindcss()],

  build: {
    // Tauri's frontendDist is "../dist" (relative to src-tauri), i.e. the
    // repo-root /dist. Vite's outDir is relative to the project root, so "dist".
    outDir: "dist",
    emptyOutDir: true,
  },

  // Vite options tailored for Tauri development.
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5174,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5175,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

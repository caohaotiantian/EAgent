import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@eagent/view-model": resolve(__dirname, "../src/view-model.ts"),
      "@eagent/wire-events": resolve(__dirname, "../src/wire-events.ts"),
    },
  },
  server: {
    proxy: {
      // API under the same host in dev; Vite serves the SPA.
      "/health": "http://127.0.0.1:8787",
      "/run": "http://127.0.0.1:8787",
      "/answer": "http://127.0.0.1:8787",
      "/sessions": "http://127.0.0.1:8787",
      "/events": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

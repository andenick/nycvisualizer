import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api and /basemap-heavy calls to the FastAPI backend so the
// browser never talks to MTA/Socrata directly and never sees any server-side key.
// The backend origin is configurable via VITE_API_TARGET (default local uvicorn).
const API_TARGET = process.env.VITE_API_TARGET || "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
      "/__track": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});

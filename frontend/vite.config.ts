import { defineConfig } from "vite";

// The dev server proxies the API and WebSocket to the FastAPI backend on port 8000.
export default defineConfig({
  build: { chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});

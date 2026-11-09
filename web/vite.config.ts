import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the page runs on Vite's server and the gateway (in Docker) on 8080
export default defineConfig({
  plugins: [react()],
  // three.js alone is most of the bundle; one file is fine for a single-page app
  build: { chunkSizeWarningLimit: 1500 },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8080", ws: true },
    },
  },
});

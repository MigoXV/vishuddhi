import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@renderer": path.resolve(__dirname, "src/renderer"),
      "@workers": path.resolve(__dirname, "src/workers"),
      "@host-core": path.resolve(__dirname, "src/host-core"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3778",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});

import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "../static",
    emptyOutDir: true,
    target: "es2024",
    sourcemap: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ws": { target: "ws://127.0.0.1:3000", ws: true },
    },
  },
});

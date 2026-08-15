import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare()],
  build: {
    target: "es2024",
    sourcemap: true,
  },
});

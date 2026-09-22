import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// One app, two homes: built to dist/web/ and served at / by both Vercel
// (the hosted demo, baked fixture) and `agentdiff view` (live /api/*).
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // `vite web` next to a running `agentdiff view` gives live data in dev.
    proxy: { "/api": "http://localhost:4321" },
  },
});

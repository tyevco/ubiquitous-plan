import { defineConfig } from "vitest/config";

// GitHub Pages serves project sites from /<repo>/, so the deploy workflow sets
// VITE_BASE=/ubiquitous-plan/. Local dev and preview use the root.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  build: { target: "es2022" },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});

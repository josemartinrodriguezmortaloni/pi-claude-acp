import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.smoke.ts"], testTimeout: 180_000, hookTimeout: 60_000 },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  // The catalog follows the system locale; tests pin it so their copy does not depend on the machine.
  test: { include: ["test/**/*.test.ts"], env: { LC_ALL: "", LC_MESSAGES: "", LANG: "es_AR.UTF-8" } },
});

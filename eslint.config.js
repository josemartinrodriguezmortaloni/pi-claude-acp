import tseslint from "typescript-eslint";

// Only the cyclomatic complexity gate (V(G) < 4). Biome owns every other lint rule.
export default tseslint.config({
  files: ["src/**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  rules: { complexity: ["error", 3] },
});

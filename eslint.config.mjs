import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@radix-ui/*"],
              message: "Import Wallie wrappers from @/components/ui instead of Radix directly.",
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", ".codex/**"]),
]);

export default eslintConfig;

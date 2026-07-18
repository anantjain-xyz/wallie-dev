import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const arbitrarySmallTextPattern = /text-\[(?:9|10|11|12)(?:\.\d+)?px\]/;

const wallieTypographyPlugin = {
  rules: {
    "no-small-arbitrary-text": {
      create(context) {
        function checkText(node, value) {
          if (arbitrarySmallTextPattern.test(value)) {
            context.report({
              message:
                "Use a semantic typography role, text-xs, or type-annotation instead of an arbitrary 9–12px text size.",
              node,
            });
          }
        }

        return {
          Literal(node) {
            if (typeof node.value === "string") checkText(node, node.value);
          },
          TemplateElement(node) {
            checkText(node, node.value.raw);
          },
        };
      },
      meta: {
        docs: {
          description: "Discourage arbitrary text sizes below the essential-copy floor.",
        },
        schema: [],
        type: "suggestion",
      },
    },
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "wallie-typography": wallieTypographyPlugin,
    },
    rules: {
      "wallie-typography/no-small-arbitrary-text": "error",
    },
  },
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
            {
              regex: "(^|/)components/shared/icons(?:/index)?$",
              message: "Import each icon from its direct module; do not use an all-icons barrel.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "(^|/)components/shared/icons(?:/index)?$",
              message: "Import each icon from its direct module; do not use an all-icons barrel.",
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

import { globalIgnores } from "eslint/config";

const eslintConfig = [
  globalIgnores([
    ".omo/**",
    ".playwright-cli/**",
    ".playwright-mcp/**",
    ".pnpm-store/**",
    ".symphony/screenshots/**",
    "src/app/preview/**",
    "test-results/**",
  ]),
];

export default eslintConfig;

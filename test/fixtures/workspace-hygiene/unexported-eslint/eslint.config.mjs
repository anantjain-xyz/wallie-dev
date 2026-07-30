import { globalIgnores } from "eslint/config";

const unusedIgnores = globalIgnores([
  ".omo/**",
  ".playwright-cli/**",
  ".playwright-mcp/**",
  ".pnpm-store/**",
  ".symphony/screenshots/**",
  "src/app/preview/**",
  "supabase/.temp/**",
  "test-results/**",
]);

const eslintConfig = [];

export { unusedIgnores };
export default eslintConfig;

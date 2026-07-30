function globalIgnores(patterns) {
  return { ignores: patterns };
}

const eslintConfig = [
  globalIgnores([
    ".omo/**",
    ".playwright-cli/**",
    ".playwright-mcp/**",
    ".pnpm-store/**",
    ".symphony/screenshots/**",
    "src/app/preview/**",
    "supabase/.temp/**",
    "test-results/**",
  ]),
];

export default eslintConfig;

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src-tauri/**",
    "claude-chat/**",
    "desktop-bundle/**",
    "desktop-lite/marked.min.js",
    "public/sw.js",
    "public/workbox-*.js",
    "public/swe-worker-*.js",
    "scripts/cleanup-standalone.js",
  ]),
]);

export default eslintConfig;

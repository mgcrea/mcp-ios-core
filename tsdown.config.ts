import { defineConfig } from "tsdown";

/**
 * A library, not a server: one entry, no CLI, no `bin`.
 *
 * `fixedExtension: false` because tsdown 0.22+ otherwise emits `.mjs` on the
 * node platform, which the `exports` map does not name.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
  outDir: "dist",
});

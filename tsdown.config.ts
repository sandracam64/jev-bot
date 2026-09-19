import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/*.ts", "!src/*.d.ts"],
  unbundle: true,
  format: "esm",
  fixedExtension: false,
  platform: "node",
  target: "node22",
  tsconfig: "tsconfig.build.json",
  dts: { generator: "tsgo" },
  clean: true,
});

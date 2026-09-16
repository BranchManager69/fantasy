import { build } from "esbuild";
await build({
  entryPoints: ["scripts/interview-server.ts", "scripts/interview-control.ts"],
  outdir: ".phone-build", bundle: true, platform: "node", format: "cjs", target: "node22",
  outExtension: { ".js": ".cjs" }, packages: "external", sourcemap: true,
  tsconfig: "tsconfig.json",
});

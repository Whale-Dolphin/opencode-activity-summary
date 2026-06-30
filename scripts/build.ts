import solidTransformPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./src/tui.tsx"],
  outdir: "./dist",
  target: "bun",
  format: "esm",
  splitting: false,
  sourcemap: "external",
  minify: false,
  plugins: [solidTransformPlugin],
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opencode-ai/sdk",
    "@opencode-ai/sdk/v2",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

console.log("built dist/tui.js")

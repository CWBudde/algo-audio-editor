import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// SharedArrayBuffer (the playback ring buffer) is only available in a
// cross-origin isolated context, which needs both of these headers. GitHub
// Pages cannot send headers, so production also ships coi-serviceworker.js;
// Electron sets them in its app:// protocol handler.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ command }) => {
  const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
  const outputDir = process.env.VITE_OUT_DIR ?? "dist";
  const distDir = fileURLToPath(new URL(`./${outputDir}/`, import.meta.url));
  const hashed = (name: string) => {
    if (command !== "build") return name;
    const hash = createHash("sha256")
      .update(readFileSync(`${publicDir}${name}`))
      .digest("hex")
      .slice(0, 16);
    const dot = name.lastIndexOf(".");
    return `${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
  };
  const wasm = hashed("kernel.wasm");
  const runtime = hashed("wasm_exec.js");
  const workerHash = createHash("sha256")
    .update(readFileSync(`${publicDir}coi-serviceworker.js`))
    .digest("hex")
    .slice(0, 16);
  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}
  return {
    // GitHub Pages serves the app from /<repo>/; everything else from the root.
    base: process.env.VITE_BASE ?? "/",
    build: { outDir: outputDir },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "pages-artifacts",
        apply: "build",
        transformIndexHtml: (html) =>
          html.replace('coi-serviceworker.js"', `coi-serviceworker.js?v=${workerHash}"`),
        closeBundle() {
          for (const [source, target] of [
            ["kernel.wasm", wasm],
            ["wasm_exec.js", runtime],
          ]) {
            copyFileSync(`${publicDir}${source}`, `${distDir}${target}`);
            rmSync(`${distDir}${source}`);
          }
          copyFileSync(`${distDir}index.html`, `${distDir}404.html`);
        },
      },
    ],
    define: {
      "import.meta.env.VITE_KERNEL_FILE": JSON.stringify(wasm),
      "import.meta.env.VITE_GO_RUNTIME_FILE": JSON.stringify(runtime),
      "import.meta.env.VITE_BUILD_COMMIT": JSON.stringify(commit),
      "import.meta.env.VITE_BUILD_CHANNEL": JSON.stringify(
        process.env.VITE_BUILD_CHANNEL ?? "development",
      ),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@aae/protocol": fileURLToPath(
          new URL("../../packages/protocol/src/index.ts", import.meta.url),
        ),
      },
    },
    server: { headers: crossOriginIsolation },
    preview: { headers: crossOriginIsolation },
    worker: { format: "es" },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      restoreMocks: true,
    },
  };
});

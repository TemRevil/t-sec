// Custom build script (not the plain esbuild CLI) because ink's dynamic, DEV-gated
// `await import('./devtools.js')` still gets its static imports (react-devtools-core) hoisted
// and eagerly resolved by esbuild's bundler, crashing at load time even though the code path
// is never taken. Stubbing that one file out avoids pulling react-devtools-core in at all.
import * as esbuild from "esbuild";

const stubDevtoolsPlugin = {
  name: "stub-ink-devtools",
  setup(build) {
    build.onResolve({ filter: /devtools\.js$/ }, (args) => {
      if (args.importer.replace(/\\/g, "/").includes("/ink/build/")) {
        return { path: args.path, namespace: "stub-devtools" };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({
      contents: "export default undefined;",
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/cli.tsx"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/t-sec.mjs",
  plugins: [stubDevtoolsPlugin],
  // Bundled CJS deps (commander) call require() for Node builtins - ESM output has no
  // ambient require, so shim one in via createRequire.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});

console.log("built dist/t-sec.mjs");

const { writeFileSync, chmodSync } = await import('node:fs');
writeFileSync('dist/t-sec.cmd', '@echo off\r\nnode "%~dp0t-sec.mjs" %*\r\n');
if (process.platform !== 'win32') chmodSync('dist/t-sec.mjs', 0o755);

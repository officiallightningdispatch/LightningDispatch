import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
// Static (SPA) build for the Capacitor native shell.
//
// The web publish path (`bun run build`, vite.config.ts) is SSR: it emits
// hashed client assets + a `dist/server` SSR bundle but NO `index.html`, which
// is exactly what Capacitor needs to copy into the native projects. This config
// enables TanStack Start's SPA mode so the client build is a self-contained
// `index.html` + hashed assets that boots the React app in the native webview
// and talks to the deployed backend over HTTPS.
//
// Output is isolated in `dist/capacitor` so it never collides with the SSR
// build's `dist/client` / `dist/server` (publish and go-live stay untouched).
//
// TanStack Start's `serverFns.base` config is a *path segment* only — it gets
// joined and `//` is collapsed, so it cannot carry a full origin. The actual
// per-request URL is `process.env.TSS_SERVER_FN_BASE + functionId`, inlined at
// build time via Vite `define`. We override that define here (for this build
// only) to point server-function RPC at the deployed backend; the web build
// (vite.config.ts) keeps the default same-origin `/_serverFn/`.

const NATIVE_SERVER_FN_BASE = "https://909fd9d2fde94962cd798bdcbee436ba.ctonew.app/_serverFn/";

// Runs as a config-hook plugin AFTER the tanstackStart plugin's own define
// (tanstackStart is enforce:"pre"), so our value wins for these two keys.
const nativeServerFnBasePlugin: Plugin = {
  name: "native-serverfn-base",
  config() {
    return {
      define: {
        "process.env.TSS_SERVER_FN_BASE": JSON.stringify(NATIVE_SERVER_FN_BASE),
        "import.meta.env.TSS_SERVER_FN_BASE": JSON.stringify(
          NATIVE_SERVER_FN_BASE,
        ),
      },
    };
  },
};

export default defineConfig({
  build: {
    outDir: "dist/capacitor",
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      spa: {
        enabled: true,
        // Prerender the SPA shell to `index.html` (Capacitor requires an
        // `index.html` entry; the default `/_shell` output is not copied).
        prerender: {
          outputPath: "/index",
        },
      },
    }),
    nativeServerFnBasePlugin,
    viteReact(),
  ],
});

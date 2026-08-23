import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
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
    viteReact(),
  ],
});

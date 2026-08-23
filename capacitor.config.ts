import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lightningroadside.lightningdispatch',
  appName: 'Lightning Dispatch',
  // Static (SPA) build produced by `bun run build:cap` (vite.capacitor.config.ts).
  // The SSR web publish (`bun run build`) emits dist/client + dist/server with no
  // index.html, so the native shell reads from the dedicated SPA output instead.
  webDir: 'dist/capacitor/client',
  server: { androidScheme: 'https' },
  plugins: {
    SplashScreen: { launchShowDuration: 0 },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
export default config;

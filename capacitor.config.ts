import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lightningroadside.lightningdispatch',
  appName: 'Lightning Dispatch',
  // Thin-shell: the native webview loads the live site directly, so every
  // serverFn call and cookie is same-origin (no CORS involved) and sign-in
  // works. No bundled SPA (no webDir) — server.url takes precedence.
  server: { url: 'https://www.lightningdispatch.app', androidScheme: 'https' },
  plugins: {
    SplashScreen: { launchShowDuration: 0 },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
export default config;

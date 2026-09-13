import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lightningroadside.lightningdispatch',
  appName: 'Lightning Dispatch',
  // Transitional native shell: the app now loads Lightning Dispatch from our
  // production Vercel deployment, removing the legacy cto.new runtime
  // dependency. Server functions and auth cookies remain same-origin while the
  // bundled/offline-native frontend migration is completed.
  server: { url: 'https://lightning-dispatch.vercel.app', androidScheme: 'https' },
  plugins: {
    SplashScreen: { launchShowDuration: 0 },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};
export default config;

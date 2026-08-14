# Native contractor app

Lightning Dispatch now has a Capacitor source project using the existing web contractor experience (`/driver`) and backend APIs. It is not a second auth or data system.

- App ID/package: `com.lightningroadside.lightningdispatch`
- Config: `capacitor.config.ts`; bridge: `src/lib/native-capabilities.ts`
- Projects: `ios/` and `android/`
- Build: `bun run build`, then `bunx cap sync`, `bunx cap open ios` / `bunx cap open android`.
- Native capabilities: Preferences (Keychain/Keystore-backed storage), push registration, location permission/watch, camera, network state, deep links, durable update/photo queues. Existing API calls and web push remain unchanged.
- Native push still requires APNs/FCM credentials and server device-token registration wiring; this slice only registers with the OS safely.
- iOS/Android SDKs and signing tools are not installed in this environment, so native compilation/signing was not run. Web build remains the source of truth; do not publish this scaffolding until native QA completes.
- Branding is inherited from the existing orange `#F27801` / black / white / yellow design tokens. Native launch icons/splash and production signing are pending.

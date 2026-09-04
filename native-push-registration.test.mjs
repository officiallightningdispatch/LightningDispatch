// Hermetic tests for the native (Capacitor) APNs registration path —
// the iOS "Couldn't turn on alerts" submission blocker (2026-09).
// No DB, no device, no network. Covers:
//   · nativePushFailureCopy maps every failure reason to a DISTINCT,
//     driver-readable message (and appends/truncates the `detail` string),
//     so the owner's next physical-device tap shows WHY it failed.
//   · ensureNativePushRegistration({ prompt:false }) never fires the iOS
//     permission prompt NOR registers at boot (the boot-time caller must not
//     consume/deny the permission before the user's explicit tap).
//   · the persistent token listener captures the token from register(), and a
//     subsequent call REUSES the in-memory token instead of re-registering —
//     iOS does not re-emit the token for an already-registered device, so the
//     old code's second register() hung for the full 10s timeout.
//   · a terminal registrationError surfaces as register_failed WITH the APNs
//     error string; a refused server save surfaces as save_failed WITH the
//     server's message.
import { describe, test, expect, mock } from 'bun:test';

// ensureNativePushRegistration gates on `typeof window !== "undefined"`; bun's
// test runtime does not always define it. Provide the minimal global.
globalThis.window = {};

const state = {
  native: true,
  perm: 'prompt', // 'prompt' | 'granted' | 'denied'
  registerCount: 0,
  requestCount: 0,
  listeners: {},
  saveImpl: async () => ({ ok: true }),
  savedTokens: [],
};
mock.module('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => state.native, getPlatform: () => 'ios' } }));
mock.module('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: async () => ({ receive: state.perm }),
    requestPermissions: async () => { state.requestCount++; state.perm = 'granted'; return { receive: 'granted' }; },
    register: async () => { state.registerCount++; },
    addListener: async (event, cb) => { (state.listeners[event] ??= []).push(cb); return { remove: async () => {} }; },
  },
}));
// push-client.ts statically imports the subscription CRUD fns and dynamically
// imports saveNativePushToken — provide both so the module loads hermetically.
mock.module('./src/data/push.ts', () => ({
  saveNativePushToken: async ({ data }) => { state.savedTokens.push(data.token); return state.saveImpl(); },
  savePushSubscription: async () => ({ ok: true }),
  getPushVapidPublicKey: async () => ({ ok: true, data: 'key' }),
  listPushSubscriptions: async () => ({ ok: true, data: [] }),
  deletePushSubscription: async () => ({ ok: true }),
}));

const { nativePushFailureCopy, ensureNativePushRegistration } = await import('./src/lib/push-client.ts');

describe('nativePushFailureCopy — driver-readable, reason-specific', () => {
  test('each reason has a DISTINCT message (no one-size-fits-all collapse)', () => {
    const messages = ['not_native', 'not_granted', 'register_failed', 'save_failed', 'error'].map((r) => nativePushFailureCopy(r));
    expect(new Set(messages).size).toBe(5);
  });
  test('detail is appended and truncated to 180 chars', () => {
    const out = nativePushFailureCopy('register_failed', 'x'.repeat(500));
    expect(out).toContain('('.repeat(1));
    expect(out.endsWith(')')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(400);
    // the (truncated) detail is present
    expect(out).toContain('x'.repeat(180));
  });
  test('no detail → no parenthetical suffix', () => {
    expect(nativePushFailureCopy('save_failed')).not.toContain('(');
  });
});

describe('ensureNativePushRegistration — ordering + token reuse', () => {
  test('boot prompt:false never prompts nor registers; error/save paths surface detail; token is reused not re-registered', async () => {
    // (1) boot-time: permission not yet granted → not_granted, and NO prompt/register.
    state.perm = 'prompt';
    const boot = await ensureNativePushRegistration({ prompt: false });
    expect(boot).toEqual({ ok: false, reason: 'not_granted' });
    expect(state.requestCount).toBe(0);
    expect(state.registerCount).toBe(0);

    // (2) terminal APNs error → register_failed WITH the error string.
    state.perm = 'granted';
    state.listeners['registrationError'][0]({ error: 'no valid aps-environment entitlement' });
    const errRes = await ensureNativePushRegistration();
    expect(errRes).toEqual({ ok: false, reason: 'register_failed', detail: 'no valid aps-environment entitlement' });
    expect(state.registerCount).toBe(1); // it DID attempt register()

    // (3) a token arrives → success; the token is captured + saved.
    state.savedTokens.length = 0;
    state.listeners['registration'][0]({ value: 'TOKEN64HEX' });
    const okRes = await ensureNativePushRegistration();
    expect(okRes).toEqual({ ok: true });
    expect(state.savedTokens).toEqual(['TOKEN64HEX']);

    // (4) second call reuses the in-memory token — register() is NOT called again
    //     (iOS never re-emits the token for an already-registered device).
    state.savedTokens.length = 0;
    const reuse = await ensureNativePushRegistration();
    expect(reuse).toEqual({ ok: true });
    expect(state.registerCount).toBe(1); // unchanged — no re-register
    expect(state.savedTokens).toEqual(['TOKEN64HEX']);

    // (5) a refused server save → save_failed WITH the server's message.
    state.saveImpl = async () => ({ ok: false, error: 'Only contractors can manage push notifications.' });
    const saveRes = await ensureNativePushRegistration();
    expect(saveRes).toEqual({ ok: false, reason: 'save_failed', detail: 'Only contractors can manage push notifications.' });
    state.saveImpl = async () => ({ ok: true });
  });
});

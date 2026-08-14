/**
 * Lightning-strike sound (backlog #1, owner-directed 2026-08-11).
 *
 * Synthesized entirely with the Web Audio API — no binary asset. One strike is
 * a short white-noise burst (fast attack ~12ms, exponential decay ~250ms)
 * band-limited for a crackle, plus a low-frequency sine thump for body. The
 * whole thing is < 300ms, fires exactly once per call (one-shot sources, no
 * looping). LOUDNESS (owner-directed 2026-08-13): the strike must be
 * UNMISTAKABLE in a noisy cab — master peak 0.7 → 0.95, noise 0.45 → 0.6,
 * thump 0.55 → 0.75, with a DynamicsCompressor between the master and the
 * speakers so the summed transient is loud and CLEAR, never clipped to
 * distortion (the same +~4.5dB pass was applied to the rendered mp3/wav
 * assets via scripts/generate-strike.mjs).
 *
 * Autoplay policy: the AudioContext is created lazily and primed on the first
 * user gesture (pointer/key) via primeAudio(). If the context is still blocked
 * when a notification fires, playLightning() returns silently — the caller's
 * banner still shows (banner-only fallback). No console noise, ever.
 *
 * Mute: per-role toggle persisted in localStorage (ld-sound-owner /
 * ld-sound-driver, default ON). When muted the banner still shows; the sound
 * simply does not play.
 */

export type SoundRole = "owner" | "driver";

const SOUND_KEYS: Record<SoundRole, string> = {
  owner: "ld-sound-owner",
  driver: "ld-sound-driver",
};

let ctx: AudioContext | null = null;
let primed = false;
/** A real alert whose play() was blocked by the autoplay policy (no user
 *  gesture since load — the FIRST push after opening the app is silent on iOS
 *  and Chrome). Replayed on the next user gesture by primeAudio(), so a
 *  driver who picks up the phone after a missed alert still HEARS it (the
 *  banner is already up). Cleared when muted, when it finally plays, or when
 *  it is superseded by a newer blocked alert. */
let pendingStrike: SoundRole | null = null;

/** Create the shared AudioContext lazily (webkit prefix for older Safari). */
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null; // blocked or unsupported — banner-only fallback
    }
  }
  return ctx;
}

/** Call on the first user gesture (any click/tap/key): create/resume the
 *  context so sounds work afterward. Idempotent and never throws. Also fires
 *  any alert whose play was blocked by autoplay earlier (pendingStrike). */
export function primeAudio(): void {
  if (typeof window === "undefined" || primed) return;
  const c = getCtx();
  if (!c) return;
  try {
    if (c.state === "suspended") {
      void c.resume().then(() => {
        primed = true;
        firePendingStrike();
      }).catch(() => { /* blocked — retried on the next gesture */ });
    } else if (c.state === "running") {
      primed = true;
      firePendingStrike();
    }
  } catch {
    /* blocked — banner-only fallback */
  }
}

/** Replay the most recent autoplay-blocked alert now that a gesture has
 *  unlocked audio. playLightning re-checks mute; on success the pending flag
 *  clears (it also re-sets pending if STILL blocked — next gesture retries). */
function firePendingStrike(): void {
  if (!pendingStrike) return;
  const role = pendingStrike;
  pendingStrike = null;
  playLightning(role);
}

/** Per-role mute state — absent key means sound ON (default). */
export function soundMuted(role: SoundRole): boolean {
  try {
    return localStorage.getItem(SOUND_KEYS[role]) === "1";
  } catch {
    return false;
  }
}

export function setSoundMuted(role: SoundRole, muted: boolean): void {
  try {
    if (muted) {
      localStorage.setItem(SOUND_KEYS[role], "1");
      if (pendingStrike === role) pendingStrike = null; // muted — don't replay a blocked alert
    } else localStorage.removeItem(SOUND_KEYS[role]);
  } catch {
    /* storage unavailable — mute just won't persist this session */
  }
}

export function toggleSoundMuted(role: SoundRole): boolean {
  const next = !soundMuted(role);
  setSoundMuted(role, next);
  return next;
}

/** The OWNER'S EXACT alert sound (owner-supplied MP3, bundled byte-identical
 *  at public/sounds/alert.mp3 — the ONLY audible notification cue 2026-08-13:
 *  the system-banner `sound` on Android, the in-app push-received alert on
 *  iOS, and the in-app banner strike all play this one file). Cached
 *  HTMLAudioElement; currentTime is reset so rapid pushes re-trigger. If the
 *  asset can't play (autoplay blocked / load error), falls back to the
 *  synthesized playLightning so a blocked browser is still audible when the
 *  AudioContext is primed. Never throws. */
let alertAudio: HTMLAudioElement | null = null;
function getAlertAudio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (!alertAudio) {
    try {
      const a = new Audio("/sounds/alert.mp3");
      a.preload = "auto";
      alertAudio = a;
    } catch {
      return null;
    }
  }
  return alertAudio;
}

export function playAlertSound(role: SoundRole): void {
  if (typeof window === "undefined") return;
  if (soundMuted(role)) return;
  const a = getAlertAudio();
  if (!a) return; // no Audio API — banner-only fallback
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.catch === "function") {
      p.then(() => {
        // Played — a previously blocked alert (pendingStrike) is now stale;
        // drop it so the next gesture doesn't replay an old alert.
        pendingStrike = null;
      }).catch(() => playLightning(role)); // autoplay blocked — synthesized fallback
    }
  } catch {
    playLightning(role);
  }
}

/**
 * Play ONE lightning strike. Silent no-op when muted, when the context is
 * blocked (autoplay policy — banner-only fallback), or when Web Audio is
 * unsupported. Fires exactly once per call: every source is one-shot
 * (loop=false) with a hard stop; nothing repeats.
 */
export function playLightning(role: SoundRole): void {
  if (typeof window === "undefined") return;
  if (soundMuted(role)) return;
  const c = getCtx();
  if (!c) return;
  if (c.state !== "running") {
    // Autoplay-blocked (no user gesture since load). Remember the alert so the
    // next gesture replays it (primeAudio → firePendingStrike); until then the
    // banner still shows — sound is best-effort by browser policy.
    pendingStrike = role;
    try { void c.resume().catch(() => { /* still blocked — gesture retry */ }); } catch { /* blocked */ }
    return;
  }
  try {
    const now = c.currentTime;

    // Master envelope: fast attack, exponential decay — the "strike" shape.
    // LOUD (2026-08-13): 0.7 → 0.95; the compressor below keeps it clean.
    const master = c.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.95, now + 0.012);
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    master.connect(limiter);
    limiter.connect(c.destination);

    // White-noise crackle (band-limited so it reads as a strike, not hiss).
    const dur = 0.3;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource();
    noise.buffer = buf;
    noise.loop = false;
    const bandpass = c.createBiquadFilter();
    bandpass.type = "bandpass";
    bandpass.frequency.value = 2200;
    bandpass.Q.value = 0.8;
    const noiseGain = c.createGain();
    noiseGain.gain.setValueAtTime(0.6, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(master);
    noise.start(now);
    noise.stop(now + 0.3);

    // Low-frequency thump for body (sine, pitch-dropping).
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.12);
    const thumpGain = c.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.75, now + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(thumpGain);
    thumpGain.connect(master);
    osc.start(now);
    osc.stop(now + 0.18);

    // Release the graph after the strike finishes (fire-and-forget).
    const cleanup = () => {
      try {
        noise.disconnect();
        osc.disconnect();
        master.disconnect();
        limiter.disconnect();
      } catch { /* already gone */ }
    };
    noise.onended = cleanup;
    setTimeout(cleanup, 600);
  } catch {
    /* never throw from sound — the banner already shows */
  }
}

#!/usr/bin/env bun
// Render the Lightning Dispatch notification sound — a synthesized THUNDER
// STORM (owner-directed 2026-08-13: "the notification sound is very low, let's
// change it to a thunder storm (about 5 seconds long)") — into
// public/sounds/lightning-strike.mp3 (+ .wav fallback) for the OS push
// notification `sound` field and the in-app HTMLAudioElement fallback.
// ~5 s: deep rolling 80–200 Hz rumble with 3 crack/boom peaks at 0.35 / 1.85 /
// 3.05 s, normalized to ~-0.5 dBFS peak (0.944) with a strong RMS so it cuts
// through a noisy cab / phone speaker. Pure synthesis, no samples, no external
// tools (lamejs is the only dep).
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

// lame.all.js is a raw concatenated script (no module.exports) — evaluate it
// in a vm sandbox and grab the `lamejs` function it attaches (browser-style).
const lameSandbox = { console };
createContext(lameSandbox);
runInContext(
  readFileSync(new URL("../node_modules/lamejs/lame.all.js", import.meta.url), "utf8"),
  lameSandbox,
);
const lamejs = lameSandbox.lamejs;

const SR = 44100;
const DUR = 5.0; // thunder storm, ~5 s
const N = Math.ceil(SR * DUR);
const t = (i) => i / SR;

function biquadBandpass(samples, freq, Q) {
  const w0 = (2 * Math.PI * freq) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const c = Math.cos(w0);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
  const out = new Float64Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

function biquadLowpass(samples, freq, Q) {
  const w0 = (2 * Math.PI * freq) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const c = Math.cos(w0);
  const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2;
  const a0 = 1 + alpha, a1 = -2 * c, a2 = 1 - alpha;
  const out = new Float64Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

// --- Layer 1: deep rolling rumble (brown noise -> 160 Hz lowpass, amplitude-modulated) ---
const brown = new Float64Array(N);
let last = 0;
for (let i = 0; i < N; i++) {
  last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
  brown[i] = last * 3.5;
}
const rumble = biquadLowpass(brown, 160, 0.6);

function rumbleMod(tt) {
  // rolling swell/subsidence — reads as a storm rolling, not a flat drone
  const roll =
    0.55 +
    0.3 * Math.sin(2 * Math.PI * 0.55 * tt + 0.9 * Math.sin(2 * Math.PI * 0.16 * tt)) +
    0.15 * Math.sin(2 * Math.PI * 1.7 * tt + 2.1);
  const atk = tt < 0.3 ? Math.pow(tt / 0.3, 1.4) : 1; // ramp in, no click
  const tail = tt < 3.6 ? 1 : Math.max(0.0001, Math.exp(-(tt - 3.6) / 0.7));
  return Math.max(0.03, roll) * atk * tail;
}

// --- Layer 2: mid "body" roll (300–600 Hz) so the storm is audible on a phone speaker ---
const midRoll = biquadBandpass(brown, 420, 0.7);

// --- Layers 3+4: crack + boom peaks (times chosen so the storm feels alive) ---
const CRACKS = [
  { t0: 0.35, crackGain: 0.85, boomGain: 0.9 },
  { t0: 1.85, crackGain: 0.7, boomGain: 0.75 },
  { t0: 3.05, crackGain: 0.75, boomGain: 0.8 },
];
const crackNoise = biquadBandpass(
  (() => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = Math.random() * 2 - 1; return w; })(),
  1700,
  0.55,
);

function burstEnv(dt) {
  // 3 ms attack, then a sharp crack + a rolling tail
  if (dt < 0.003) return dt / 0.003;
  const s = dt - 0.003;
  return 0.8 * Math.exp(-s / 0.045) + 0.2 * Math.exp(-s / 0.3);
}

function boomEnv(dt) {
  if (dt < 0.006) return dt / 0.006;
  return Math.exp(-(dt - 0.006) / 0.55);
}

const mix = new Float64Array(N);
let peak = 0, rmsSum = 0;
for (let i = 0; i < N; i++) {
  const tt = t(i);
  let s =
    rumble[i] * rumbleMod(tt) * 0.9 +
    midRoll[i] * rumbleMod(tt) * 0.28;
  for (const c of CRACKS) {
    const dt = tt - c.t0;
    if (dt < 0) continue;
    s += crackNoise[i] * burstEnv(dt) * c.crackGain;
    // boom: 120 -> 42 Hz pitch-dropping sine + a 55 Hz sub body
    const glideDur = 0.65;
    const f = dt < glideDur ? 120 * Math.exp(Math.log(42 / 120) * (dt / glideDur)) : 42;
    s += Math.sin(2 * Math.PI * f * dt) * boomEnv(dt) * c.boomGain;
    s += Math.sin(2 * Math.PI * 55 * dt) * boomEnv(dt) * 0.45 * c.boomGain;
  }
  // final fade so the wav/mp3 ends at a zero crossing (no cutoff click)
  const fade = tt > DUR - 0.15 ? Math.max(0, (DUR - tt) / 0.15) : 1;
  s *= fade;
  mix[i] = s;
  peak = Math.max(peak, Math.abs(s));
}

// --- Normalize to ~-0.5 dBFS (0.944) full-scale peak: loud but not clipped ---
const gain = peak > 0 ? 0.944 / peak : 1;
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) {
  const s = Math.max(-1, Math.min(1, mix[i] * gain));
  pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  rmsSum += s * s;
}
const rms = Math.sqrt(rmsSum / N);

// --- MP3 (lamejs, 128 kbps mono) ---
const enc = new lamejs.Mp3Encoder(1, SR, 128);
const mp3Chunks = [];
for (let i = 0; i < pcm.length; i += 1152) {
  const buf = enc.encodeBuffer(pcm.subarray(i, i + 1152));
  if (buf.length) mp3Chunks.push(Buffer.from(buf));
}
const end = enc.flush();
if (end.length) mp3Chunks.push(Buffer.from(end));

// --- WAV (16-bit PCM fallback) ---
const wavHeader = Buffer.alloc(44);
wavHeader.write("RIFF", 0); wavHeader.writeUInt32LE(36 + N * 2, 4); wavHeader.write("WAVE", 8);
wavHeader.write("fmt ", 12); wavHeader.writeUInt32LE(16, 16); wavHeader.writeUInt16LE(1, 20);
wavHeader.writeUInt16LE(1, 22); wavHeader.writeUInt32LE(SR, 24); wavHeader.writeUInt32LE(SR * 2, 28);
wavHeader.writeUInt16LE(2, 32); wavHeader.writeUInt16LE(16, 34);
wavHeader.write("data", 36); wavHeader.writeUInt32LE(N * 2, 40);

const outDir = "/home/team/shared/site/public/sounds";
mkdirSync(outDir, { recursive: true });
const mp3Path = join(outDir, "lightning-strike.mp3");
const wavPath = join(outDir, "lightning-strike.wav");
const mp3 = Buffer.concat(mp3Chunks);
const wav = Buffer.concat([wavHeader, Buffer.from(pcm.buffer)]);
writeFileSync(mp3Path, mp3);
writeFileSync(wavPath, wav);
console.log(`thunder storm rendered: ${DUR}s @ ${SR}Hz, mix peak ${peak.toFixed(3)}, full-scale peak ~0.944 (-0.5 dBFS), RMS ${rms.toFixed(3)}`);
console.log(`  ${mp3Path} (${mp3.length} bytes)`);
console.log(`  ${wavPath} (${wav.length} bytes)`);

#!/usr/bin/env bun
// Render the Lightning Dispatch strike — the SAME synthesized sound as
// src/lib/sound.ts (white-noise crackle through a 2.2 kHz bandpass, ~250 ms
// exponential decay + a 90→48 Hz sine thump; one-shot, < 320 ms) — into
// public/sounds/lightning-strike.mp3 (+ .wav fallback) for the OS push
// notification `sound` field and the in-app HTMLAudioElement fallback.
// Pure synthesis, no samples, no external tools (lamejs is the only dep).
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
const DUR = 0.32;
const N = Math.ceil(SR * DUR);

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

const t = (i) => i / SR;
// Master envelope: fast attack, exponential decay (the "strike" shape).
const master = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const tt = t(i);
  if (tt < 0.012) {
    master[i] = 0.0001 * Math.exp(Math.log(0.7 / 0.0001) * (tt / 0.012));
  } else if (tt < 0.26) {
    master[i] = 0.7 * Math.exp(Math.log(0.0001 / 0.7) * ((tt - 0.012) / (0.26 - 0.012)));
  } else {
    master[i] = 0.0001;
  }
}
// White-noise crackle (band-limited so it reads as a strike, not hiss).
const noise = new Float64Array(N);
for (let i = 0; i < N; i++) noise[i] = Math.random() * 2 - 1;
const band = biquadBandpass(noise, 2200, 0.8);
const noiseEnv = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const tt = t(i);
  noiseEnv[i] = tt < 0.22 ? 0.45 * Math.exp(Math.log(0.0001 / 0.45) * (tt / 0.22)) : 0.0001;
}
// Low-frequency thump (sine, pitch-dropping 90→48 Hz).
const thump = new Float64Array(N);
let phase = 0;
for (let i = 0; i < N; i++) {
  const tt = t(i);
  if (tt >= 0.18) { thump[i] = 0; continue; }
  phase += (2 * Math.PI * (90 * Math.exp(Math.log(48 / 90) * (tt / 0.18)))) / SR;
  const g = tt < 0.008
    ? 0.0001 * Math.exp(Math.log(0.55 / 0.0001) * (tt / 0.008))
    : 0.55 * Math.exp(Math.log(0.0001 / 0.55) * ((tt - 0.008) / 0.16));
  thump[i] = g * Math.sin(phase);
}

const mix = new Float64Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  mix[i] = (band[i] * noiseEnv[i] + thump[i]) * master[i];
  peak = Math.max(peak, Math.abs(mix[i]));
}
const gain = peak > 0 ? 0.9 / peak : 1;
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(mix[i] * gain * 32767)));

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
console.log(`strike rendered: ${DUR}s @ ${SR}Hz, peak ${peak.toFixed(3)}`);
console.log(`  ${mp3Path} (${mp3.length} bytes)`);
console.log(`  ${wavPath} (${wav.length} bytes)`);

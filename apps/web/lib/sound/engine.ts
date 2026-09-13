'use client';

import {
  MASTER_GAIN,
  SOUNDS,
  durationOf,
  type NoiseBurst,
  type SoundName,
  type SoundSpec,
  type Voice,
} from './sounds';

/**
 * The instrument.
 *
 * One `AudioContext` for the tab, created lazily and never before a user has
 * clicked something. That is not an optimisation — every browser refuses to
 * start audio that the user did not ask for, and a context created on page load
 * arrives `suspended` and stays that way. Since every sound here is off until
 * somebody turns it on, the switch itself is the gesture that starts it.
 *
 * Nodes are built per sound and thrown away. Web Audio nodes are cheap, they
 * disconnect themselves when they stop, and the alternative — a pool of
 * long-lived oscillators — is a great deal of bookkeeping for sounds that last
 * a twentieth of a second.
 *
 * Everything in here fails silently. A browser with no Web Audio, a context
 * that will not resume, a tab that has been throttled into the ground: none of
 * them are worth an error on a poker table. The game is the game; the sound is
 * a nicety.
 */

let context: AudioContext | null = null;
/** One buffer of white noise, reused by every burst. Generating it is not free. */
let noiseBuffer: AudioBuffer | null = null;

type AudioContextCtor = new () => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Start the audio clock, or wake it up.
 *
 * Call this from inside a click handler. Browsers only honour `resume()` when a
 * gesture is on the stack, so calling it anywhere else is a promise that quietly
 * never settles.
 */
export function primeAudio(): void {
  const ctx = ensureContext();
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

function ensureContext(): AudioContext | null {
  if (context !== null) return context;

  const Ctor = audioContextCtor();
  if (Ctor === null) return null;

  try {
    context = new Ctor();
  } catch {
    // A browser that has Web Audio but will not give us a context. Nothing to
    // be done, and nothing worth saying about it.
    return null;
  }
  return context;
}

/**
 * White noise, generated once.
 *
 * `Math.random` is banned repo-wide and rightly so — but that rule is about
 * *the game*: a deck, a shuffle, anything a player could be cheated by. This is
 * a sound. It is not poker randomness, it never reaches the server, and no
 * outcome depends on it. It still uses `crypto.getRandomValues`, because a
 * one-line alternative that keeps the lint rule honest and needs no exception
 * is better than an argument in a code review.
 */
function ensureNoise(ctx: AudioContext): AudioBuffer | null {
  if (noiseBuffer !== null) return noiseBuffer;

  try {
    const frames = Math.floor(ctx.sampleRate * 0.4);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const channel = buffer.getChannelData(0);

    const bytes = new Uint8Array(frames);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < frames; i += 1) {
      // 0..255 mapped to -1..1.
      channel[i] = ((bytes[i] ?? 128) - 128) / 128;
    }

    noiseBuffer = buffer;
    return noiseBuffer;
  } catch {
    return null;
  }
}

/**
 * Play one of the six.
 *
 * `volume` is the player's own 0..1 setting, scaling `MASTER_GAIN` rather than
 * replacing it — the constant stays the ceiling, so turning the slider all the
 * way up is still a quiet table rather than a loud one.
 *
 * Silent and harmless if audio is unavailable.
 */
export function playSound(name: SoundName, volume = 1): void {
  play(SOUNDS[name], volume);
}

function play(spec: SoundSpec, volume: number): void {
  const ctx = ensureContext();
  if (ctx === null) return;

  // A tab that was hidden may have had its context suspended out from under us.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  if (ctx.state === 'closed') return;

  const level = MASTER_GAIN * Math.min(1, Math.max(0, volume));
  if (level <= 0) return;

  try {
    const master = ctx.createGain();
    master.gain.value = level;
    master.connect(ctx.destination);

    const start = ctx.currentTime;
    for (const voice of spec.voices) addVoice(ctx, master, voice, start);
    for (const burst of spec.noise) addNoise(ctx, master, burst, start);

    // Let the whole chain go once the last tail has decayed.
    const end = start + durationOf(spec) + 0.05;
    master.gain.setValueAtTime(level, end);
    window.setTimeout(
      () => {
        master.disconnect();
      },
      Math.ceil((end - start) * 1000) + 50,
    );
  } catch {
    // Nothing a player can act on.
  }
}

/**
 * One oscillator with a percussive envelope.
 *
 * The attack is 8ms rather than zero: a gain that jumps straight to full
 * produces a click of its own on top of the note, which is audible on exactly
 * the short, sharp sounds this file is mostly made of.
 */
function addVoice(ctx: AudioContext, out: GainNode, voice: Voice, start: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = voice.type;
  const at = start + voice.at;
  const end = at + voice.dur;

  osc.frequency.setValueAtTime(voice.from, at);
  if (voice.to !== undefined) {
    // Exponential ramps cannot reach or pass through zero.
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, voice.to), end);
  }

  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(voice.gain, at + Math.min(0.008, voice.dur / 2));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain);
  gain.connect(out);
  osc.start(at);
  osc.stop(end + 0.02);
}

function addNoise(ctx: AudioContext, out: GainNode, burst: NoiseBurst, start: number): void {
  const buffer = ensureNoise(ctx);
  if (buffer === null) return;

  const source = ctx.createBufferSource();
  const band = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  source.buffer = buffer;
  band.type = 'bandpass';
  band.frequency.value = burst.centre;
  band.Q.value = burst.q;

  const at = start + burst.at;
  const end = at + burst.dur;

  gain.gain.setValueAtTime(burst.gain, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  source.connect(band);
  band.connect(gain);
  gain.connect(out);
  source.start(at);
  source.stop(end + 0.02);
}

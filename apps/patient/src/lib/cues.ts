// Soft audio/haptic cues for the rest timer. Tones are synthesized with Web
// Audio (no asset to cache). iOS only lets a page make sound after a user
// gesture, so unlockAudio() must be called from a tap — the "finished set"
// tap that starts the rest does it. The silent switch still mutes; that's
// intended.

const MUTED_KEY = 'patient.cues.muted';

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

export function unlockAudio() {
  const c = getCtx();
  if (!c) return;
  void c.resume().catch(() => {});
  // A silent one-sample buffer played inside the gesture is what actually
  // unlocks output on older iOS Safari.
  try {
    const src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, 22050);
    src.connect(c.destination);
    src.start(0);
  } catch {
    // ignore — worst case the cue is silent
  }
}

function tone(freq: number, startOffset: number, durationSec: number, peak: number) {
  const c = getCtx();
  if (!c) return;
  if (c.state !== 'running') void c.resume().catch(() => {});
  const t0 = c.currentTime + startOffset;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Short attack + exponential decay so it's a soft "ding", never a click.
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durationSec + 0.02);
}

/** Quiet countdown tick (5-4-3-2-1). */
export function playTick() {
  if (isMuted()) return;
  tone(523, 0, 0.08, 0.12);
}

/** Two rising notes — rest is over, start the next set. */
export function playStart() {
  if (isMuted()) return;
  tone(784, 0, 0.16, 0.22);
  tone(1047, 0.15, 0.28, 0.22);
}

export function vibrate(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // unsupported (iOS) — the on-screen state is enough
  }
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(MUTED_KEY, '1');
    else localStorage.removeItem(MUTED_KEY);
  } catch {
    // storage unavailable — the choice just won't stick
  }
}

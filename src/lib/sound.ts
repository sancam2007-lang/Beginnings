// Synthesized office sounds — no external/copyrighted assets. The AudioContext
// is created lazily on the first user gesture (pressing the pager).

let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function setMuted(v: boolean) {
  muted = v;
}
export function isMuted() {
  return muted;
}

/** Short electric buzz — the pager/intercom. */
export function playPager() {
  const c = ac();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(220, c.currentTime);
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, c.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.18);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.2);
}

/** Mechanical whir + paper feed for the given duration (seconds). */
export function playPrinter(duration = 0.9) {
  const c = ac();
  if (!c) return;
  const end = c.currentTime + duration;

  // filtered noise = paper feed
  const bufferSize = Math.floor(c.sampleRate * duration);
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
  const noise = c.createBufferSource();
  noise.buffer = buffer;
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1400;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.05, c.currentTime);
  ng.gain.setValueAtTime(0.05, end - 0.1);
  ng.gain.exponentialRampToValueAtTime(0.0001, end);
  noise.connect(bp).connect(ng).connect(c.destination);
  noise.start();
  noise.stop(end);

  // low motor hum
  const osc = c.createOscillator();
  const og = c.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(70, c.currentTime);
  og.gain.setValueAtTime(0.03, c.currentTime);
  og.gain.setValueAtTime(0.03, end - 0.08);
  og.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(og).connect(c.destination);
  osc.start();
  osc.stop(end);
}

/** Heavy rubber-stamp thud. */
export function playStamp() {
  const c = ac();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(140, c.currentTime);
  osc.frequency.exponentialRampToValueAtTime(50, c.currentTime + 0.12);
  gain.gain.setValueAtTime(0.18, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
  osc.connect(gain).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + 0.24);
}

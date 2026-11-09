// The discovery sting: a low swell that blooms into a bell chime, synthesized
// with WebAudio (no assets; the 3d-portfolio-website region reveal is silent,
// so there was no sound to port). Like caveAudio.ts: one context created on
// the first user gesture, a missing AudioContext is a silent no-op.
//
//   swell: two detuned saws + a sub sine through a low-pass that opens as the
//          title fades in (the reference's 18 % fade-in), then decays
//   chime: an A-major arpeggio of bell tones (fundamental + 2.76x partial),
//          landing as the title settles, through a soft feedback echo
//
// Volume: localStorage "lodestone.intro.volume" (0..1, default 0.6; 0 mutes),
// settable from the dev handle (__lodestoneIntro.volume(v)). The client has
// no global sound settings yet; when it does, read them in stingVolume().

export type StingKind = 'grand' | 'major' | 'minor';

const VOLUME_KEY = 'lodestone.intro.volume';
let ctx: AudioContext | null = null;
let volume = readVolume();
let unlockInstalled = false;

function readVolume(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(VOLUME_KEY));
    return globalThis.localStorage?.getItem(VOLUME_KEY) == null || !Number.isFinite(v) ? 0.6 : Math.max(0, Math.min(1, v));
  } catch {
    return 0.6;
  }
}

export function stingVolume(): number {
  return volume;
}

export function setStingVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  try {
    globalThis.localStorage?.setItem(VOLUME_KEY, String(volume));
  } catch {}
}

function ensureContext(): AudioContext | null {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  }
  const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return null;
  try {
    ctx = new Ctx();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Create/resume the context on the first key or click (browsers' autoplay rule). */
export function installStingUnlock(): () => void {
  if (unlockInstalled || typeof window === 'undefined') return () => {};
  unlockInstalled = true;
  const unlock = () => {
    ensureContext();
    if (ctx && ctx.state === 'running') remove();
  };
  const remove = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    unlockInstalled = false;
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  return remove;
}

const A5 = 880;
const ARPEGGIO: Record<StingKind, number[]> = {
  grand: [A5, A5 * 1.25992, A5 * 1.49831, A5 * 2], // A C# E A
  major: [A5, A5 * 1.49831, A5 * 2], // A E A
  minor: [A5 * 1.49831, A5 * 2], // E A
};

/** Play the sting. `riseMs` is when the title finishes fading in (the chime lands there). */
export function playSting(kind: StingKind, riseMs: number): void {
  if (volume <= 0 || (typeof document !== 'undefined' && document.hidden)) return;
  const ac = ensureContext();
  if (!ac || ac.state !== 'running') return;
  try {
    const t0 = ac.currentTime + 0.02;
    const rise = Math.max(0.25, riseMs / 1000);
    const out = ac.createGain();
    out.gain.value = 0.5 * volume;
    out.connect(ac.destination);

    // Soft echo for the chime: delay -> low-pass -> feedback.
    const echo = ac.createDelay(1);
    echo.delayTime.value = 0.27;
    const echoTone = ac.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2600;
    const feedback = ac.createGain();
    feedback.gain.value = 0.32;
    echo.connect(echoTone);
    echoTone.connect(feedback);
    feedback.connect(echo);
    echoTone.connect(out);

    const stopAt = t0 + rise + 3.6;
    if (kind !== 'minor') {
      const swell = ac.createGain();
      const peak = kind === 'grand' ? 0.3 : 0.22;
      swell.gain.setValueAtTime(0.0001, t0);
      swell.gain.linearRampToValueAtTime(peak, t0 + rise);
      swell.gain.exponentialRampToValueAtTime(0.0001, t0 + rise + (kind === 'grand' ? 3.0 : 2.3));
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(140, t0);
      lp.frequency.exponentialRampToValueAtTime(kind === 'grand' ? 1100 : 800, t0 + rise);
      lp.frequency.exponentialRampToValueAtTime(220, t0 + rise + 2);
      lp.connect(swell);
      swell.connect(out);
      for (const [f, type, g] of [[55, 'sawtooth', 0.5], [55 * 1.004, 'sawtooth', 0.5], [82.41, 'sawtooth', 0.35], [55, 'sine', 0.9]] as const) {
        const o = ac.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const og = ac.createGain();
        og.gain.value = g;
        o.connect(og);
        og.connect(lp);
        o.start(t0);
        o.stop(stopAt);
      }
    }

    const notes = ARPEGGIO[kind];
    const chimeAt = kind === 'minor' ? t0 : t0 + rise * 0.85;
    notes.forEach((f, i) => {
      const at = chimeAt + i * (kind === 'grand' ? 0.13 : 0.11);
      const g = ac.createGain();
      const level = (kind === 'minor' ? 0.1 : 0.13) * (i === notes.length - 1 ? 1.15 : 1);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(level, at + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 2.4);
      g.connect(out);
      g.connect(echo);
      for (const [mult, amp] of [[1, 1], [2.76, 0.28], [5.4, 0.08]] as const) {
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mult;
        const og = ac.createGain();
        og.gain.value = amp;
        o.connect(og);
        og.connect(g);
        o.start(at);
        o.stop(at + 2.5);
      }
    });
    // Release the graph once everything has rung out.
    setTimeout(() => {
      try {
        feedback.disconnect();
        out.disconnect();
      } catch {}
    }, (stopAt - ac.currentTime + 2) * 1000);
  } catch {
    // Audio is decoration; never let it break the HUD.
  }
}

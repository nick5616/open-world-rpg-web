import { describe, expect, it } from 'vitest';
import { CONTENT } from '@lodestone/contracts';
import { clampOctave, defaultOctave, degreeToMidi, foldIntoRange, isNoteKey, KEY_ROWS, keyToMidi, midiToHz, noteName, scaleByKey, SCALES, velocityOf } from './theory';
import { BATCH_MS, decodeNote, decodeNotesData, encodeNote, NoteBatcher, packBatch, Playout, unpackBatch } from './wire';
import { bellParams, drumParams, estimatePitch, fluteEnvelope, fluteParams, foldHz, mulberry32, pluckParams, renderBell, renderDrum, renderPluck, strokeOf, velGain } from './voices';
import { addNoteHit, clearNoteHits, takeNoteHits } from './store';
import { AvatarAnimator, EMOTE_PLAYING, followMusic } from '../../net/avatarAnim';
import { applaudArms } from '../../world/buildings/npcs';
import { hitEnvelope } from './FirstPersonInstrument';

const major = scaleByKey('major');

describe('theory: scales and the keyboard rows', () => {
  it('has the scales a player asks for, each starting at the root and ascending', () => {
    for (const k of ['major', 'minor', 'pentatonic', 'minor_pentatonic', 'dorian', 'mixolydian', 'blues', 'chromatic']) expect(SCALES.some((s) => s.key === k)).toBe(true);
    for (const s of SCALES) {
      expect(s.steps[0]).toBe(0);
      for (let i = 1; i < s.steps.length; i++) expect(s.steps[i]).toBeGreaterThan(s.steps[i - 1]);
      expect(s.steps[s.steps.length - 1]).toBeLessThan(12);
    }
    expect(scaleByKey('nope').key).toBe('major');
  });

  it('maps the letter row to the scale from the root, the other rows by octaves', () => {
    // C major, octave 4: Q = C4 (60), W = D4, E = E4, R = F4 ... I = C5.
    expect([...'QWERTYUI'].map((c) => keyToMidi(`Key${c}`, major, 0, 4))).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(keyToMidi('Digit1', major, 0, 4)).toBe(72);
    expect(keyToMidi('KeyA', major, 0, 4)).toBe(48);
    expect(keyToMidi('KeyZ', major, 0, 4)).toBe(36);
    expect(keyToMidi('KeyQ', major, 0, 4, true)).toBe(72); // Shift: an octave up
    expect(keyToMidi('Escape', major, 0, 4)).toBeNull();
    // D dorian at octave 3: D3 E3 F3 G3.
    expect(['KeyQ', 'KeyW', 'KeyE', 'KeyR'].map((c) => keyToMidi(c, scaleByKey('dorian'), 2, 3))).toEqual([50, 52, 53, 55]);
    // A pentatonic row climbs past the octave after five keys.
    const pent = scaleByKey('pentatonic');
    expect(keyToMidi('KeyY', pent, 0, 4)).toBe(72);
    expect(degreeToMidi(-1, major, 0, 4)).toBe(59); // below the root: B3
  });

  it('every keyboard key is a note, and only those', () => {
    const codes = KEY_ROWS.flatMap((r) => r.codes);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBe(45);
    for (const c of codes) expect(isNoteKey(c)).toBe(true);
    for (const c of ['Escape', 'Tab', 'Enter', 'Space', 'ShiftLeft', 'ArrowUp']) expect(isNoteKey(c)).toBe(false);
  });

  it('names notes in the key: sharps in sharp keys, flats in flat ones', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(66, 7, major)).toBe('F♯4'); // G major
    expect(noteName(70, 5, major)).toBe('B♭4'); // F major
    expect(noteName(63, 0, scaleByKey('minor'))).toBe('E♭4'); // C minor (E♭ major's signature)
    expect(midiToHz(69)).toBeCloseTo(440, 6);
    expect(midiToHz(57)).toBeCloseTo(220, 6);
  });

  it('folds notes into an instrument range and starts each keyboard inside it', () => {
    expect(foldIntoRange(30, [40, 84])).toBe(42);
    expect(foldIntoRange(100, [60, 96])).toBe(88);
    expect(foldIntoRange(70, [60, 96])).toBe(70);
    for (const inst of CONTENT.instruments.list) {
      const o = defaultOctave(inst.range);
      const q = keyToMidi('KeyQ', major, 0, o)!;
      expect(q).toBeGreaterThanOrEqual(inst.range[0]);
      expect(q).toBeLessThanOrEqual(inst.range[1]);
    }
    expect(clampOctave(12)).toBe(7);
    expect(clampOctave(-3)).toBe(1);
  });

  it('velocity: the dynamics, Space accents, 1..7', () => {
    expect(velocityOf(5, false)).toBe(5);
    expect(velocityOf(5, true)).toBe(7);
    expect(velocityOf(7, true)).toBe(7);
    expect(velocityOf(0, false)).toBe(1);
  });
});

describe('wire: note events and batches', () => {
  it('packs a note in 16 bits, the Go layout (music.go EncodeMusicNote)', () => {
    expect(encodeNote({ note: 60, vel: 5, offsetMs: 12 })).toBe(60 | (5 << 7) | (12 << 10));
    for (const n of [
      { note: 60, vel: 5, offsetMs: 0 },
      { note: 127, vel: 7, offsetMs: 63 },
      { note: 40, vel: 0, offsetMs: 17 },
    ])
      expect(decodeNote(encodeNote(n))).toEqual(n);
    expect(decodeNote(0)).toBeNull();
    expect(decodeNote(encodeNote({ note: 60, vel: 5, offsetMs: 400 }))!.offsetMs).toBe(63); // clamped
  });

  it('packs five events and the batch clock into Interact 120/2', () => {
    const ev = [60, 62, 64, 65, 67].map((note, i) => ({ note, vel: 4, offsetMs: i * 10 }));
    const { targetId, arg } = packBatch(ev, 70000);
    const back = unpackBatch(targetId, arg);
    expect(back.events).toEqual(ev);
    expect(back.clock).toBe(70000 - 65536);
    const two = packBatch(ev.slice(0, 2), 5);
    expect(unpackBatch(two.targetId, two.arg).events.length).toBe(2);
    const v = encodeNote({ note: 64, vel: 3, offsetMs: 9 });
    expect(decodeNotesData(new Uint8Array([v & 255, v >> 8, 0, 0]))).toEqual([{ note: 64, vel: 3, offsetMs: 9 }]);
  });

  it('batcher: the first note at once, the rest every batchMs, five a batch', () => {
    const b = new NoteBatcher(50);
    b.add(60, 5, 1000);
    const first = b.due(1000)!;
    expect(first.events).toEqual([{ note: 60, vel: 5, offsetMs: 0 }]);
    b.add(62, 5, 1010);
    b.add(64, 5, 1030);
    expect(b.due(1040)).toBeNull(); // within the window
    expect(b.nextDue()).toBe(1050);
    const second = b.due(1050)!;
    expect(second.clock).toBe(1010);
    expect(second.events.map((e) => [e.note, e.offsetMs])).toEqual([
      [62, 0],
      [64, 20],
    ]);
    for (let i = 0; i < 7; i++) b.add(60 + i, 5, 1060 + i);
    expect(b.due(1100)!.events.length).toBe(5);
    expect(b.queued).toBe(2);
    expect(b.due(1120)).toBeNull();
    expect(b.due(1150)!.events.length).toBe(2);
    expect(BATCH_MS).toBe(CONTENT.instruments.batchMs);
    expect(1000 / BATCH_MS).toBeLessThanOrEqual(CONTENT.instruments.batchesPerS);
  });

  it('a fast run never sends more than one batch per batchMs', () => {
    const b = new NoteBatcher(50);
    let sent = 0;
    for (let t = 0; t < 1000; t++) {
      if (t % 30 === 0) b.add(60, 5, t);
      if (b.due(t)) sent++;
    }
    expect(sent).toBeLessThanOrEqual(20);
    expect(sent).toBeGreaterThanOrEqual(17);
  });

  it('playout: keeps the player’s spacing through jitter, starts over after a pause, survives the clock wrap', () => {
    const p = new Playout(45);
    const lat = [80, 110, 85, 95, 120, 82]; // jitter up to 40 ms: under the 45 ms margin
    const starts = lat.map((l, i) => p.schedule((65500 + i * 50) % 65536, 10000 + i * 50 + l));
    // After the first, every batch starts 50 ms after the one before (the jitter is under the margin + the minimum).
    for (let i = 2; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeCloseTo(50, 5);
    for (let i = 0; i < starts.length; i++) expect(starts[i]).toBeGreaterThanOrEqual(10000 + i * 50 + lat[i]);
    // Five seconds of silence: a new phrase isn't held to the old path.
    const s = p.schedule(1000, 20000);
    expect(s).toBe(20045);
  });
});

describe('voices: the synthesis', () => {
  const sr = 48000;
  it('the lute string sounds its note (Karplus-Strong, tuned by an all-pass)', () => {
    for (const m of [45, 57, 64, 76]) {
      const x = renderPluck(sr, pluckParams(m, 5), mulberry32(m));
      const f = estimatePitch(x, sr, 50, 1500);
      expect(Math.abs(1200 * Math.log2(f / midiToHz(m)))).toBeLessThan(12); // within 12 cents
    }
  });

  it('the lute decays, longer for low strings, and the pick brightens with velocity', () => {
    const rms = (x: Float32Array, a: number, b: number) => Math.sqrt(x.slice(a, b).reduce((s, v) => s + v * v, 0) / (b - a));
    const x = renderPluck(sr, pluckParams(52, 5), mulberry32(1));
    expect(rms(x, 0, sr * 0.2)).toBeGreaterThan(8 * rms(x, x.length - sr * 0.3, x.length));
    expect(pluckParams(40, 5).t60).toBeGreaterThan(pluckParams(80, 5).t60);
    expect(pluckParams(60, 7).bright).toBeGreaterThan(pluckParams(60, 2).bright);
    expect(x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeLessThan(0.7); // headroom for chords
  });

  it('the drum: the register picks the stroke, the note tunes the skin', () => {
    expect([strokeOf(40), strokeOf(60), strokeOf(80)]).toEqual(['bass', 'tone', 'slap']);
    const bass = drumParams(40, 6);
    const slap = drumParams(80, 6);
    expect(bass.hz).toBeGreaterThanOrEqual(62);
    expect(bass.hz).toBeLessThan(124);
    expect(slap.hz).toBeGreaterThanOrEqual(300);
    expect(slap.decayS).toBeLessThan(bass.decayS);
    expect(slap.noise).toBeGreaterThan(bass.noise);
    expect(foldHz(1000, 150, 300)).toBeCloseTo(250, 6);
    // Two notes a fifth apart in the tone register keep the fifth.
    expect(drumParams(62, 5).hz / drumParams(55, 5).hz).toBeCloseTo(Math.pow(2, 7 / 12), 4);
    const x = renderDrum(sr, bass, mulberry32(3));
    expect(x.length).toBe(Math.ceil(bass.seconds * sr));
    expect(x.slice(0, sr * 0.05).reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toBeGreaterThan(0.05);
    expect(Math.abs(x[x.length - 1])).toBeLessThan(1e-3);
  });

  it('the handbell: fundamental and twelfth lead, upper partials fade first, nothing above Nyquist', () => {
    const p = bellParams(96, 7, 44100);
    expect(p.partials[0].ratio).toBe(1);
    for (const pt of p.partials) expect(p.hz * pt.ratio).toBeLessThan(44100 * 0.45);
    const all = bellParams(60, 5);
    for (let i = 3; i < all.partials.length; i++) expect(all.partials[i].t60).toBeLessThan(all.partials[2].t60);
    expect(bellParams(84, 5).seconds).toBeLessThan(bellParams(60, 5).seconds);
    const x = renderBell(sr, bellParams(72, 5), mulberry32(9));
    const f = estimatePitch(x, sr, 200, 1500, 0.2, 0.3);
    expect(Math.abs(1200 * Math.log2(f / midiToHz(72)))).toBeLessThan(15);
  });

  it('the flute: a soft attack, held, a short release; a strong breath is brighter', () => {
    const p = fluteParams(72, 5);
    expect(fluteEnvelope(p, 0, 1)).toBe(0);
    expect(fluteEnvelope(p, p.attackS / 2, 1)).toBeGreaterThan(0.2);
    expect(fluteEnvelope(p, 0.5, 1)).toBe(1);
    expect(fluteEnvelope(p, 1 + p.releaseS, 1)).toBeLessThan(0.1);
    const soft = fluteParams(72, 2);
    const hard = fluteParams(72, 7);
    expect(hard.harmonics[1]).toBeGreaterThan(soft.harmonics[1]);
    expect(hard.attackS).toBeLessThan(soft.attackS);
    expect(p.vibratoDelayS).toBeGreaterThan(0.1);
    expect(velGain(7)).toBe(1);
    expect(velGain(3)).toBeLessThan(velGain(5));
  });
});

describe('the body answers the notes', () => {
  it('note hits come out in time order, when due', () => {
    clearNoteHits();
    addNoteHit(7, 60, 5, 200);
    addNoteHit(7, 62, 5, 100);
    addNoteHit(7, 64, 5, 300);
    expect(takeNoteHits(7, 50)).toEqual([]);
    expect(takeNoteHits(7, 250).map((h) => h.midi)).toEqual([62, 60]);
    expect(takeNoteHits(7, 400).map((h) => h.midi)).toEqual([64]);
  });

  it('playing poses the instrument and a note moves the strumming hand', () => {
    for (const inst of CONTENT.instruments.list) {
      const a = new AvatarAnimator();
      const inp = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, activity: 0, healthPct: 100 };
      a.emote(EMOTE_PLAYING, inst.id);
      for (let i = 0; i < 30; i++) a.update(inp, 1 / 60);
      expect(a.pose.instrument).toBe(inst.id);
      const before = { ...a.pose.armR };
      followMusic(a, [{ midi: 64, vel: 7 }]);
      a.update(inp, 1 / 60);
      const after = a.pose.armR;
      expect(Math.abs(after.swing - before.swing) + Math.abs(after.bend - before.bend) + Math.abs(a.pose.armL.swing - before.swing)).toBeGreaterThan(0.01);
    }
    expect(hitEnvelope(0)).toBe(1);
    expect(hitEnvelope(400)).toBeLessThan(0.05);
  });

  it('townsfolk applaud for the length of a cheer: arms up (cheer) or hands meeting (clap)', () => {
    expect(applaudArms(0, -1, 1)).toBeNull();
    expect(applaudArms(0, 3, 1)).toBeNull();
    const cheer = applaudArms(0, 1, 1)!;
    expect(cheer.fwd).toBeGreaterThan(2.4);
    const clapR = applaudArms(1, 1, 1)!;
    const clapL = applaudArms(1, 1, -1)!;
    expect(clapR.fwd).toBeGreaterThan(1);
    expect(clapR.fwd).toBeLessThan(1.5);
    expect(Math.sign(clapR.inward)).toBe(-Math.sign(clapL.inward));
  });
});

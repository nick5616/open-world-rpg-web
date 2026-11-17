import { describe, expect, it } from 'vitest';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { aimAt, dialogCam, dialogCamBegin, dialogCamEnd, dialogCamReset, dialogCamStep, turnTo } from './camera';
import { DLG_EV, decodeNode } from './events';
import { offlineNode, offlineReply } from './offline';
import { advanceAction, choiceForKey, reduceDialogEvent, typedChars, useDialog, type DialogState } from './store';
import { basePitch, blipHz, blipsAt } from './voice';

const enc = new TextEncoder();
const ev = (kind: number, data: unknown, extra: Partial<ZoneEvent> = {}): ZoneEvent =>
  ({ kind, entityId: 0, targetId: 0, value: 0, x: 0, y: 0, z: 0, data: typeof data === 'string' ? enc.encode(data) : enc.encode(JSON.stringify(data)), ...extra }) as ZoneEvent;

// The zone's JSON (server/zone/internal/game/dialog.go dlgWire).
const node = {
  npc: { id: 77, name: 'Ulus', role: 3, title: 'innkeeper', town: 'Draedmore' },
  seq: 1,
  aff: 4,
  met: true,
  line: 'Come in, come in, mind the cat.',
  mood: 'warm',
  choices: [
    { id: 1, text: 'Heard anything interesting?', kind: 'rumour' },
    { id: 2, text: 'Goodbye.', kind: 'leave' },
  ],
};

const base = (): DialogState => ({ ...useDialog.getState(), open: false, parked: false, awaitingWork: false, key: null, focus: null, node: null, lineAt: 0, toast: null, offline: false, lines: 0 });

describe('dialog store', () => {
  it('a node opens the conversation and starts the line', () => {
    const p = reduceDialogEvent(base(), ev(DLG_EV.node, node, { entityId: 77 }), 1234)!;
    expect(p.open).toBe(true);
    expect(p.node?.npc.name).toBe('Ulus');
    expect(p.key).toBe(77);
    expect(p.lineAt).toBe(1234);
    expect(p.lines).toBe(1);
    expect(p.parked).toBe(false);
  });

  it('a node that answers a service request arrives parked behind its panel', () => {
    const s = { ...base(), open: true, key: 77, awaitingWork: true };
    const p = reduceDialogEvent(s, ev(DLG_EV.node, node), 1)!;
    expect(p.parked).toBe(true);
    expect(p.awaitingWork).toBe(false);
  });

  it('an end closes it with the reason; a refusal too, except a bad choice', () => {
    const open = { ...base(), open: true, key: 77, node: node as never };
    const walked = reduceDialogEvent(open, ev(DLG_EV.end, '', { value: 1 }), 5)!;
    expect(walked.open).toBe(false);
    expect(walked.toast?.text).toMatch(/walked away/);
    const you = reduceDialogEvent(open, ev(DLG_EV.end, '', { value: 0 }), 5)!;
    expect(you.toast).toBeNull();
    const far = reduceDialogEvent(open, ev(DLG_EV.refused, '', { value: 2 }), 5)!;
    expect(far.open).toBe(false);
    expect(far.toast?.text).toMatch(/Too far/);
    const bad = reduceDialogEvent(open, ev(DLG_EV.refused, '', { value: 4 }), 5)!;
    expect(bad.open).toBeUndefined(); // the conversation stays on
    expect(bad.toast).toBeTruthy();
  });

  it('ignores other events and garbage', () => {
    expect(reduceDialogEvent(base(), ev(800, 'hi'), 1)).toBeNull();
    expect(reduceDialogEvent(base(), ev(DLG_EV.node, 'not json'), 1)).toBeNull();
    expect(decodeNode(enc.encode('{"line":1}'))).toBeNull();
  });
});

describe('keys and advancing', () => {
  it('1-6 pick the numbered answer, never past the list', () => {
    expect(choiceForKey('Digit1', 3)).toBe(0);
    expect(choiceForKey('Digit3', 3)).toBe(2);
    expect(choiceForKey('Digit4', 3)).toBeNull();
    expect(choiceForKey('Digit6', 6)).toBe(5);
    expect(choiceForKey('KeyE', 3)).toBeNull();
    expect(choiceForKey('Digit0', 3)).toBeNull();
  });

  it('E / Space / click skip the typing first, then go on only when there is one thing to say', () => {
    const two = [{ id: 1 }, { id: 2 }];
    expect(advanceAction(false, two)).toEqual({ kind: 'skip' });
    expect(advanceAction(true, two)).toEqual({ kind: 'none' });
    expect(advanceAction(true, [{ id: 9 }])).toEqual({ kind: 'choose', id: 9 });
    expect(advanceAction(false, [{ id: 9 }])).toEqual({ kind: 'skip' });
  });

  it('the typewriter reveals over time, pauses on punctuation and ends', () => {
    const t = 'Hello, friend. Sit.';
    expect(typedChars(t, 0)).toBe(0);
    const a = typedChars(t, 200);
    const b = typedChars(t, 600);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(typedChars(t, 60000)).toBe(t.length);
    // the comma costs time: the same elapsed time shows fewer characters than with no punctuation
    expect(typedChars('Hello  friend  Sit', 600)).toBeGreaterThanOrEqual(typedChars(t, 600));
  });
});

describe('conversation camera', () => {
  it('aims the camera convention at a point', () => {
    const a = aimAt({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 1.6, z: -5 });
    expect(a.yaw).toBeCloseTo(0, 5); // -z is forward at yaw 0
    expect(a.pitch).toBeCloseTo(0, 5);
    const right = aimAt({ x: 0, y: 1.6, z: 0 }, { x: -5, y: 1.6, z: 0 });
    expect(right.yaw).toBeCloseTo(Math.PI / 2, 5); // forward = (-sin yaw, -cos yaw)
    expect(aimAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 5, z: -5 }).pitch).toBeCloseTo(Math.PI / 4, 5);
  });

  it('turns the short way round', () => {
    expect(turnTo(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 5);
    expect(turnTo(0, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('eases to the face, and back to where you were looking', () => {
    dialogCamReset();
    const lk = { yaw: 1.0, pitch: 0.2 };
    const eye = { x: 0, y: 1.6, z: 0 };
    dialogCamBegin({ x: 0, y: 1.6, z: -4 }, lk.yaw, lk.pitch);
    expect(dialogCam.phase).toBe('in');
    for (let i = 0; i < 120; i++) dialogCamStep(lk, eye, 1 / 60);
    expect(Math.abs(turnTo(lk.yaw, 0))).toBeLessThan(0.01);
    expect(Math.abs(lk.pitch)).toBeLessThan(0.01);
    dialogCamEnd();
    expect(dialogCam.phase).toBe('out');
    let driving = true;
    for (let i = 0; i < 240 && driving; i++) driving = dialogCamStep(lk, eye, 1 / 60);
    expect(driving).toBe(false);
    expect(dialogCam.phase).toBe('off');
    expect(lk.yaw).toBeCloseTo(1.0, 5);
    expect(lk.pitch).toBeCloseTo(0.2, 5);
  });

  it('snaps at once for reduced motion and does nothing when off', () => {
    dialogCamReset();
    const lk = { yaw: 2, pitch: 0 };
    expect(dialogCamStep(lk, { x: 0, y: 0, z: 0 }, 0.016)).toBe(false);
    dialogCamBegin({ x: 0, y: 0, z: -4 }, lk.yaw, lk.pitch);
    dialogCamStep(lk, { x: 0, y: 0, z: 0 }, 0.016, true);
    expect(lk.yaw).toBeCloseTo(0, 5);
    dialogCamReset();
  });
});

describe('voice and offline', () => {
  it('everyone has their own pitch, the same every time, in a soft range', () => {
    const ids = [1, 2, 3, 77, 1234, 99999];
    const p = ids.map(basePitch);
    expect(new Set(p).size).toBeGreaterThan(4);
    for (const x of p) {
      expect(x).toBeGreaterThanOrEqual(110);
      expect(x).toBeLessThanOrEqual(250);
    }
    expect(basePitch(77)).toBe(basePitch(77));
    expect(blipHz(77, 'a', 3)).toBe(blipHz(77, 'a', 3));
    expect(blipHz(77, 'i', 3)).toBeGreaterThan(blipHz(77, 'u', 3));
  });

  it('blips on every third letter, never on spaces or punctuation', () => {
    const t = 'Hi, friend';
    const at = [...t].map((c, i) => blipsAt(c, i));
    expect(at[2]).toBe(false); // the comma
    expect(at[3]).toBe(false); // the space
    expect(at.filter(Boolean).length).toBeGreaterThan(1);
  });

  it('offline: a local line, a rumour answer that says it needs a zone, goodbye ends', () => {
    const c = { kind: 'npc', x: 0, y: 1, z: 0, entityId: null, stableId: 0n, index: 4, name: 'Mira', role: 3, merchant: 255, settlement: 0 } as const;
    const n = offlineNode(c as never);
    expect(n.npc.name).toBe('Mira');
    expect(n.line.length).toBeGreaterThan(10);
    const r = offlineReply(n, n.choices[0])!;
    expect(r.line).toMatch(/offline/);
    expect(offlineReply(n, n.choices[1])).toBeNull();
  });
});

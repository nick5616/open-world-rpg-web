import { describe, expect, it } from 'vitest';
import { CONTENT, type Event as ZoneEvent } from '@lodestone/contracts';
import { AvatarAnimator, EMOTE_FISHING, EMOTE_SHOW_CATCH, followEmote, type AnimInput } from '../../net/avatarAnim';
import { clampCursor, emoteByKey, parseEmoteCommand, pickSector, sectorCenter, TokenBucket, WHEEL } from './emotes';
import { applyEmoteEvent, emoteOf } from './store';
import { emoteNod } from './FirstPersonEmote';
import { parseInput } from '../../social/commands';

const still = (): AnimInput => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, activity: 0, healthPct: 100 });

function run(a: AvatarAnimator, s: number, inp: AnimInput = still()) {
  for (let t = 0; t < s; t += 1 / 60) a.update(inp, 1 / 60);
  return a.pose;
}

describe('emote wheel', () => {
  it('has ten emotes, none of them the zone fishing poses', () => {
    expect(WHEEL.map((e) => e.key)).toEqual(['wave', 'bow', 'cheer', 'point', 'sit', 'dance', 'laugh', 'shrug', 'salute', 'rest']);
    expect(WHEEL.every((e) => !e.system && e.id < 20)).toBe(true);
  });
  it('picks the sector under the mouse, clockwise from the top', () => {
    const n = WHEEL.length;
    expect(pickSector(0, 0, n)).toBe(-1); // dead zone
    expect(pickSector(0, -100, n)).toBe(0); // straight up
    expect(pickSector(0, 100, n)).toBe(n / 2); // straight down
    expect(pickSector(12, -18, n)).toBe(-1);
    for (let i = 0; i < n; i++) {
      const c = sectorCenter(i, n);
      expect(pickSector(c.x * 100, c.y * 100, n)).toBe(i);
    }
    const cur = { x: 300, y: 400 };
    clampCursor(cur, 150);
    expect(Math.hypot(cur.x, cur.y)).toBeCloseTo(150);
  });
  it('limits like the zone: a burst, then one per everyS', () => {
    const b = new TokenBucket(CONTENT.emotes.burst, CONTENT.emotes.everyS);
    let ok = 0;
    for (let i = 0; i < 10; i++) if (b.take(1000 + i)) ok++;
    expect(ok).toBe(CONTENT.emotes.burst);
    expect(b.take(1000 + CONTENT.emotes.everyS * 1000 + 20)).toBe(true);
    expect(b.take(1000 + CONTENT.emotes.everyS * 1000 + 40)).toBe(false);
  });
  it('/emote and /e parse; names and prefixes resolve', () => {
    expect(parseInput('/emote wave', { activeTab: 'zone' })).toEqual({ kind: 'game', verb: 'emote', args: 'wave' });
    expect(parseInput('/e bow', { activeTab: 'zone' })).toEqual({ kind: 'game', verb: 'emote', args: 'bow' });
    expect(parseEmoteCommand('')).toEqual({ kind: 'list' });
    expect(parseEmoteCommand('stop')).toEqual({ kind: 'stop' });
    expect(parseEmoteCommand('Rest by the fire')).toMatchObject({ kind: 'play', emote: { key: 'rest' } });
    expect(emoteByKey('sal')?.key).toBe('salute');
    expect(parseEmoteCommand('backflip').kind).toBe('error');
    expect(emoteByKey('fishing')).toBeNull(); // the zone's own pose is not on the wheel
  });
});

describe('emote poses (avatarAnim)', () => {
  it('wave raises the right arm; bow bends forward; sit lowers the body; salute to the brow', () => {
    const a = new AvatarAnimator();
    run(a, 0.5);
    const idleArm = a.pose.armR.swing;
    a.emote(1);
    run(a, 0.6);
    expect(a.currentEmote).toBe(1);
    expect(a.pose.armR.swing).toBeGreaterThan(idleArm + 1.5);
    a.emote(2);
    run(a, 0.8);
    expect(a.pose.torsoPitch).toBeLessThan(-0.5);
    a.emote(5);
    run(a, 1);
    expect(a.pose.bodyY).toBeLessThan(-0.6);
    expect(a.pose.legR.swing).toBeGreaterThan(1.2);
    a.emote(9);
    run(a, 0.8);
    expect(a.pose.armR.bend).toBeGreaterThan(1.8);
  });
  it('one-shot emotes end on their own; loops end when the body moves', () => {
    const a = new AvatarAnimator();
    a.emote(8); // shrug, 1.6 s
    run(a, 2);
    expect(a.currentEmote).toBe(0);
    a.emote(6); // dance loops
    run(a, 5);
    expect(a.currentEmote).toBe(6);
    const walking = still();
    let x = 0;
    for (let i = 0; i < 60; i++) {
      x += 4 / 60;
      walking.x = x;
      walking.speed = 4;
      a.update(walking, 1 / 60);
    }
    expect(a.currentEmote).toBe(0);
  });
  it('every wheel emote poses without NaN and blends out', () => {
    for (const e of WHEEL) {
      const a = new AvatarAnimator();
      run(a, 0.2);
      a.emote(e.id);
      const p = run(a, 0.9);
      for (const v of [p.bodyY, p.bodyPitch, p.torsoPitch, p.headPitch, p.armR.swing, p.armL.bend, p.legR.swing]) expect(Number.isFinite(v)).toBe(true);
      a.emote(0);
      run(a, 1);
      expect(Math.abs(a.pose.bodyY)).toBeLessThan(0.05);
    }
  });
  it('the fishing pose shows the rod, the catch shows the fish; an attack ends an emote but not the line', () => {
    const a = new AvatarAnimator();
    a.emote(EMOTE_FISHING);
    run(a, 0.5);
    expect(a.pose.rod).toBe(true);
    a.trigger({ kind: 'slash', durMs: 300, color: null, dir: 1, hold: false });
    expect(a.currentEmote).toBe(EMOTE_FISHING);
    a.emote(EMOTE_SHOW_CATCH, 7);
    run(a, 0.6);
    expect(a.pose.rod).toBe(false);
    expect(a.pose.fish).toBe(7);
    a.emote(3);
    a.trigger({ kind: 'slash', durMs: 300, color: null, dir: 1, hold: false });
    expect(a.currentEmote).toBe(0);
  });
  it('replicated records drive the avatar once per emote (Event 1090)', () => {
    const ev = (id: number) => ({ kind: 1090, entityId: 42, targetId: id, value: 0, x: 100, y: 200, z: 300, data: new Uint8Array() }) as unknown as ZoneEvent;
    expect(applyEmoteEvent(ev(7))).toBe(true);
    const a = new AvatarAnimator();
    followEmote(a, emoteOf(42));
    expect(a.currentEmote).toBe(7);
    run(a, 3); // laugh ends
    followEmote(a, emoteOf(42)); // same record: not replayed
    expect(a.currentEmote).toBe(0);
    applyEmoteEvent(ev(7)); // the same emote again plays again
    followEmote(a, emoteOf(42));
    expect(a.currentEmote).toBe(7);
    applyEmoteEvent(ev(0));
    followEmote(a, emoteOf(42));
    expect(a.currentEmote).toBe(0);
    expect(emoteOf(42)?.x).toBe(1);
  });
  it('first person: a bow nods the view down, sitting lowers the eye', () => {
    expect(emoteNod(2, 0.8).pitch).toBeLessThan(-0.3);
    expect(emoteNod(5, 1).drop).toBeGreaterThan(0.6);
    expect(emoteNod(1, 0.5)).toEqual({ pitch: 0, roll: 0, drop: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { FlatGround, type GroundQuery } from '../sim/ground';
import { chooseMode, headOf, inverseDistanceGain, listenerAxes, relativeToListener, terrainBetween } from './spatial';
import { loadPrefs } from './store';
import { TalkController, type Mic } from './talk';
import { tokenCanPublish } from './token';

describe('voice token grant (playtest 2)', () => {
  const jwt = (claims: object) => {
    const b64 = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `eyJhbGciOiJIUzI1NiJ9.${b64}.sig`;
  };
  it('talks unless the token withholds canPublish (moderator mute)', () => {
    expect(tokenCanPublish(jwt({ sub: 'c1', video: { roomJoin: true, canPublish: true, canPublishSources: ['microphone'] } }))).toBe(true);
    expect(tokenCanPublish(jwt({ sub: 'c1', video: { roomJoin: true, canPublish: false } }))).toBe(false);
    // Unreadable: the SFU enforces the grant anyway, so don't block the button.
    expect(tokenCanPublish('not-a-jwt')).toBe(true);
  });
});

describe('spatial math', () => {
  it('listener axes follow the camera convention (yaw 0 looks down -Z)', () => {
    const a = listenerAxes(0, 0);
    expect(a.forward.z).toBeCloseTo(-1);
    expect(a.up.y).toBeCloseTo(1);
    const b = listenerAxes(Math.PI / 2, 0); // turned left: facing -X
    expect(b.forward.x).toBeCloseTo(-1);
    const c = listenerAxes(0.3, 0.4);
    const dot = c.forward.x * c.up.x + c.forward.y * c.up.y + c.forward.z * c.up.z;
    expect(dot).toBeCloseTo(0); // up stays perpendicular when looking up
  });

  it('places a speaker right/left/ahead in the listener frame', () => {
    const me = { x: 0, y: 1.8, z: 0 };
    expect(relativeToListener(me, 0, 0, { x: 5, y: 1.8, z: 0 }).right).toBeCloseTo(5);
    expect(relativeToListener(me, 0, 0, { x: -5, y: 1.8, z: 0 }).right).toBeCloseTo(-5);
    expect(relativeToListener(me, 0, 0, { x: 0, y: 1.8, z: -7 }).forward).toBeCloseTo(7);
    // Facing +X (yaw -pi/2), someone at +X is ahead and someone at +Z is on the right.
    expect(relativeToListener(me, -Math.PI / 2, 0, { x: 4, y: 1.8, z: 0 }).forward).toBeCloseTo(4);
    expect(relativeToListener(me, -Math.PI / 2, 0, { x: 0, y: 1.8, z: 4 }).right).toBeCloseTo(4);
  });

  it('inverse distance gain matches the PannerNode model (ref 2 m, max 40 m)', () => {
    expect(inverseDistanceGain(1)).toBe(1);
    expect(inverseDistanceGain(2)).toBe(1);
    expect(inverseDistanceGain(5)).toBeCloseTo(0.4);
    expect(inverseDistanceGain(20)).toBeCloseTo(0.1);
    expect(inverseDistanceGain(40)).toBeCloseTo(0.05);
    expect(inverseDistanceGain(46)).toBeCloseTo(0.05); // clamped at max until unsubscribed
  });

  it('heads are PLAYER_HEIGHT above the feet', () => {
    expect(headOf({ x: 1, y: 10, z: 2 })).toEqual({ x: 1, y: 11.8, z: 2 });
  });

  it('chooses spatial within earshot, radio for far party members', () => {
    expect(chooseMode(10, false)).toBe('spatial');
    expect(chooseMode(10, true)).toBe('spatial');
    expect(chooseMode(48, true)).toBe('spatial');
    expect(chooseMode(60, true)).toBe('radio');
    expect(chooseMode(null, true)).toBe('radio');
    expect(chooseMode(null, false)).toBe('flat');
    expect(chooseMode(50, false)).toBe('spatial'); // still subscribed for a moment: keep it in place
  });

  it('detects terrain between two heads by sampling the ground', () => {
    const flat = new FlatGround(0);
    expect(terrainBetween(flat, { x: 0, y: 1.8, z: 0 }, { x: 30, y: 1.8, z: 0 })).toBe(false);
    // A 5 m ridge halfway.
    const ridge: GroundQuery = { heightAt: (x) => (x > 12 && x < 18 ? 5 : 0) };
    expect(terrainBetween(ridge, { x: 0, y: 1.8, z: 0 }, { x: 30, y: 1.8, z: 0 })).toBe(true);
    // Both standing on top of tall ground: the line clears the ridge.
    expect(terrainBetween(ridge, { x: 0, y: 8, z: 0 }, { x: 30, y: 8, z: 0 })).toBe(false);
    // A bump under your own feet doesn't muffle anyone.
    const bump: GroundQuery = { heightAt: (x) => (x < 0.8 ? 1.7 : 0) };
    expect(terrainBetween(bump, { x: 0, y: 1.8, z: 0 }, { x: 20, y: 1.8, z: 0 })).toBe(false);
  });

  it('underground, cave air between the heads is not an occluder; rock is (G3)', () => {
    // The surface is 60 m overhead; a tunnel at y 0..4 runs along x from 0 to 40.
    const tunnel: GroundQuery = { heightAt: () => 60, caveAir: (x, y) => x >= 0 && x <= 40 && y > 0 && y < 4 };
    expect(terrainBetween(tunnel, { x: 2, y: 1.8, z: 0 }, { x: 30, y: 1.8, z: 0 })).toBe(false);
    // Past the tunnel's end there is rock between them.
    expect(terrainBetween(tunnel, { x: 2, y: 1.8, z: 0 }, { x: 60, y: 1.8, z: 0 })).toBe(true);
    // A ground without caves underground (no caveAir) stays occluded, as before.
    expect(terrainBetween({ heightAt: () => 60 }, { x: 2, y: 1.8, z: 0 }, { x: 30, y: 1.8, z: 0 })).toBe(true);
  });
});

describe('voice prefs', () => {
  it('defaults to push-to-talk and validates stored values', () => {
    expect(loadPrefs(null).talkMode).toBe('ptt');
    expect(loadPrefs('not json').talkMode).toBe('ptt');
    const p = loadPrefs(JSON.stringify({ talkMode: 'vad', masterVolume: 9, volumes: { Bob: 1.5, Eve: -3, X: 'loud' }, muted: { Bob: true, Eve: 'yes' } }));
    expect(p).toEqual({ talkMode: 'vad', masterVolume: 2, volumes: { Bob: 1.5, Eve: 0, X: 1 }, muted: { Bob: true } });
    expect(loadPrefs(JSON.stringify({ talkMode: 'always-on' })).talkMode).toBe('ptt');
  });
});

class FakeMic implements Mic {
  acquired = 0;
  live = false;
  calls: string[] = [];
  deny = false;
  private release: (() => void) | null = null;
  slow = false;
  acquire(): Promise<void> {
    this.acquired++;
    this.calls.push('acquire');
    if (this.deny) return Promise.reject(new Error('denied'));
    if (this.slow) return new Promise((r) => (this.release = r));
    return Promise.resolve();
  }
  grant() {
    this.release?.();
  }
  setLive(live: boolean): Promise<void> {
    this.live = live;
    this.calls.push(live ? 'live' : 'mute');
    return Promise.resolve();
  }
}

describe('push-to-talk', () => {
  it('does not ask for the microphone until the first push', async () => {
    const mic = new FakeMic();
    const t = new TalkController(mic, () => {}, () => true);
    await t.settled();
    expect(mic.acquired).toBe(0);
    t.press();
    await t.settled();
    expect(mic.acquired).toBe(1);
    expect(mic.live).toBe(true);
    expect(t.state).toEqual({ mic: 'ready', transmitting: true });
    t.release();
    await t.settled();
    expect(mic.live).toBe(false);
    t.press();
    t.release();
    await t.settled();
    expect(mic.acquired).toBe(1); // only once
  });

  it('a tap during the permission prompt leaves the mic muted', async () => {
    const mic = new FakeMic();
    mic.slow = true;
    const t = new TalkController(mic, () => {}, () => true);
    t.press();
    await new Promise((r) => setTimeout(r, 0)); // the permission prompt is up
    t.release();
    mic.grant();
    await t.settled();
    await t.settled();
    expect(mic.live).toBe(false);
    expect(mic.calls).toEqual(['acquire']);
  });

  it('listen-only players never acquire or transmit', async () => {
    const mic = new FakeMic();
    const t = new TalkController(mic, () => {}, () => false);
    expect(t.press()).toBe(false);
    t.setMode('vad');
    t.setGate(true);
    await t.settled();
    expect(mic.acquired).toBe(0);
    expect(mic.live).toBe(false);
  });

  it('a denied microphone reports denied and asks again on the next push', async () => {
    const mic = new FakeMic();
    mic.deny = true;
    const states: string[] = [];
    const t = new TalkController(mic, (s) => states.push(s.mic), () => true);
    t.press();
    await t.settled();
    await t.settled();
    expect(t.state.mic).toBe('denied');
    expect(mic.live).toBe(false);
    t.release();
    mic.deny = false;
    t.press();
    await t.settled();
    await t.settled();
    expect(t.state).toEqual({ mic: 'ready', transmitting: true });
    expect(states).toContain('denied');
  });

  it('voice activation follows the level gate once opted in', async () => {
    const mic = new FakeMic();
    const t = new TalkController(mic, () => {}, () => true);
    t.setMode('vad'); // opting in is the consent to open the mic
    await t.settled();
    expect(mic.acquired).toBe(1);
    expect(mic.live).toBe(false);
    t.setGate(true);
    await t.settled();
    expect(mic.live).toBe(true);
    t.setGate(false);
    await t.settled();
    expect(mic.live).toBe(false);
    // The talk key does nothing to the gate in VAD mode.
    t.press();
    await t.settled();
    expect(mic.live).toBe(false);
  });
});

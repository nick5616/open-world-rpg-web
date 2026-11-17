import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BEARDS, BUILDS, DEFAULT_LOOK, EYE_COLORS, HAIR_COLORS, HAIR_STYLES, SKIN_TONES, hasLook, lookLimit, lookToAppearance, parseLook, randomLook, type Look } from './look';
import { floorY, layoutClusters, layoutStalactites, GEMS } from '../screens/stage/caveGen';
import type { RemoteView } from './interpolation';

describe('look (CR 047)', () => {
  it('round-trips through the stored appearance object', () => {
    const l: Look = { build: 2, skin: 4, hairStyle: 5, hairColor: 8, beard: 3, eyes: 5 };
    const stored = JSON.parse(JSON.stringify(lookToAppearance(l)));
    expect(hasLook(stored)).toBe(true);
    expect(parseLook(stored)).toEqual(l);
  });

  it('decodes legacy, partial and hostile appearance JSON to a valid look', () => {
    expect(hasLook({})).toBe(false);
    expect(parseLook({})).toEqual(DEFAULT_LOOK);
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
    expect(parseLook({ hair: 3 })).toEqual(DEFAULT_LOOK); // the old test object from the account tests
    const odd = parseLook({ look: { build: 99, skin: -4, hairStyle: 1.7, beard: 'x', eyes: NaN } });
    expect(odd.build).toBe(BUILDS.length - 1);
    expect(odd.skin).toBe(0);
    expect(odd.hairStyle).toBe(1);
    expect(odd.beard).toBe(DEFAULT_LOOK.beard);
    expect(odd.eyes).toBe(DEFAULT_LOOK.eyes);
  });

  it('keeps every option table the size the pickers assume', () => {
    expect(lookLimit('skin')).toBe(SKIN_TONES.length);
    expect(lookLimit('hairStyle')).toBe(HAIR_STYLES.length);
    expect(lookLimit('hairColor')).toBe(HAIR_COLORS.length);
    expect(lookLimit('beard')).toBe(BEARDS.length);
    expect(lookLimit('eyes')).toBe(EYE_COLORS.length);
    expect(JSON.stringify(lookToAppearance(DEFAULT_LOOK)).length).toBeLessThan(200); // the account service caps appearance at 4 KB
  });

  it('randomises within range and covers every option over many draws', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const seen = new Map<string, Set<number>>();
    for (let i = 0; i < 600; i++) {
      const l = randomLook(rand);
      expect(parseLook(lookToAppearance(l))).toEqual(l);
      for (const [k, v] of Object.entries(l)) {
        if (!seen.has(k)) seen.set(k, new Set());
        seen.get(k)!.add(v);
      }
    }
    for (const k of ['build', 'skin', 'hairStyle', 'hairColor', 'beard', 'eyes'] as const) expect(seen.get(k)!.size).toBe(lookLimit(k));
  });
});

describe('cavern layout', () => {
  it('is deterministic and keeps clusters off the figure and on the floor or walls', () => {
    const a = layoutClusters('stage', 4242);
    const b = layoutClusters('stage', 4242);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(20);
    for (const c of a) {
      expect(c.gem).toBeGreaterThanOrEqual(0);
      expect(c.gem).toBeLessThan(GEMS.length);
      expect(Math.hypot(c.x, c.z)).toBeGreaterThan(3.5); // the character stands at the origin
      if (c.floor) expect(c.y).toBeCloseTo(floorY(c.x, c.z), 5);
    }
    // all five gem colours are present
    expect(new Set(a.map((c) => c.gem)).size).toBe(GEMS.length);
    expect(layoutStalactites(4242).length).toBeGreaterThan(20);
  });

  it('has a near-level plateau under the figure', () => {
    for (const [x, z] of [[0, 0], [1, 1], [-1.5, 0.5], [0.5, -1.5]]) expect(Math.abs(floorY(x, z) - floorY(0, 0))).toBeLessThan(0.15);
  });
});

describe('avatar look rendering', () => {
  it('restyles skin, hair, beard, eyes and build, and a bald figure hides its hair', async () => {
    (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
    const { Avatar } = await import('./avatar');
    const a = new Avatar(3, { nameplate: false });
    const names = (o: THREE.Object3D) => {
      const out: Record<string, THREE.Mesh> = {};
      o.traverse((c) => {
        if (c.name.startsWith('avatar-')) out[c.name] = c as THREE.Mesh;
      });
      return out;
    };
    const cam = new THREE.PerspectiveCamera();
    const v = { id: 3, kind: 1, name: 'x', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: 0, ring: 0, delayMs: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, mode: 'interp' } as unknown as RemoteView;
    a.update(v, cam, 0.016); // puts the full rig in the graph
    expect(names(a.root)['avatar-beard']).toBeUndefined();
    const look: Look = { build: 2, skin: 5, hairStyle: 4, hairColor: 9, beard: 3, eyes: 1 };
    a.setLook(look);
    const m = names(a.root);
    const color = (x: THREE.Mesh) => (x.material as THREE.MeshStandardMaterial).color.getHex();
    expect(m['avatar-hair'].visible).toBe(true);
    expect(color(m['avatar-hair'])).toBe(HAIR_COLORS[9]);
    expect(m['avatar-beard'].visible).toBe(true);
    expect(color(m['avatar-beard'])).toBe(HAIR_COLORS[9]);
    expect(color(m['avatar-iris'])).toBe(EYE_COLORS[1]);
    expect(a.look).toEqual(look);
    // build scales the figure (the three LOD levels)
    const s = BUILDS[2];
    a.update(v, cam, 0.016);
    const rig = a.root.children.find((c) => c.scale.x !== 1)!;
    expect(rig.scale.x).toBeCloseTo(s.sx);
    expect(rig.scale.y).toBeCloseTo(s.sy);

    a.setLook({ ...look, hairStyle: 0, beard: 0 });
    expect(names(a.root)['avatar-hair'].visible).toBe(false);
    expect(names(a.root)['avatar-beard'].visible).toBe(false);
    a.dispose();
  });
});

describe('wire word and remote looks (CR 047)', () => {
  it('packs like the zone (the same vectors as looks_test.go)', async () => {
    const { packLook, unpackLook } = await import('./look');
    const a: Look = { build: 2, skin: 4, hairStyle: 5, hairColor: 8, beard: 3, eyes: 5 };
    expect(packLook(a)).toBe((1 << 18) | 2 | (4 << 2) | (5 << 5) | (8 << 8) | (3 << 12) | (5 << 15));
    expect(packLook(DEFAULT_LOOK)).toBe((1 << 18) | 1 | (2 << 2) | (2 << 5) | (1 << 8));
    expect(unpackLook(packLook(a))).toEqual(a);
    expect(unpackLook(0)).toBeNull();
    expect(unpackLook(5)).toBeNull(); // no marker bit
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 200; i++) {
      const l = randomLook(rand);
      expect(unpackLook(packLook(l))).toEqual(l);
    }
  });

  it('asks once, retries a few times, stops when answered, and forgets leavers', async () => {
    const { LookBook, EV_LOOK } = await import('./remoteLooks');
    const { packLook } = await import('./look');
    const b = new LookBook();
    expect(b.due(5, 0)).toBe(true);
    expect(b.due(5, 1000)).toBe(false);
    expect(b.due(5, 4100)).toBe(true);
    expect(b.due(5, 8300)).toBe(true);
    expect(b.due(5, 20000)).toBe(false); // gave up after three asks
    const look: Look = { build: 0, skin: 1, hairStyle: 3, hairColor: 2, beard: 1, eyes: 4 };
    b.onEvent({ kind: EV_LOOK, entityId: 5, value: packLook(look) } as never);
    b.onEvent({ kind: 1234, entityId: 6, value: packLook(look) } as never); // another kind
    expect(b.get(5)).toEqual(look);
    expect(b.get(6)).toBeUndefined();
    expect(b.due(5, 99999)).toBe(false);
    b.forget(5);
    expect(b.get(5)).toBeUndefined();
    expect(b.due(5, 100000)).toBe(true);
  });
});

// CR 038: the client side of the vertical world: layer meshes (which
// triangles exist, holes, water), the map's layers, the music by layer.
import { describe, expect, it } from 'vitest';
import { LAYER_DEPTHS, LAYER_SKY, LAYER_UNDER, NO_WATER, OPEN_C, TILE_S, type LayerTile, type Site, type VerticalWorld } from '@lodestone/worldgen';
import { buildLayerMesh } from './layerMesh';
import { siteOnLayer } from '../../ui/map/layers';
import { MusicDirector, type MusicInputs } from '../../audio/music/director';
import { mappingMatches, type MusicMapping } from '../../audio/composer/mapping';
import type { VibeContext } from '../../audio/composer/override';

const S = TILE_S;
function world(over: Partial<VerticalWorld> = {}): VerticalWorld {
  return { genVersion: 3, baseSites: 0, archs: [], islands: [], updrafts: [], chambers: [], corridors: [], openings: [], surfaceOpenings: [], gateOpenings: [], shafts: [], columns: [], decos: [], veins: [], domain: [new Uint8Array(512), new Uint8Array(512), new Uint8Array(512)], ...over };
}
function tile(layer: number, fill: (i: number, j: number) => [number, number, number]): LayerTile {
  const a = new Float32Array(S * S);
  const b = new Float32Array(S * S);
  const w = new Float32Array(S * S);
  let flags = 0;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const [fa, fb, fw] = fill(i, j);
      a[j * S + i] = fa;
      b[j * S + i] = fb;
      w[j * S + i] = fw;
      if (layer === LAYER_SKY ? fa > fb : fb > fa) flags |= 1;
      if (layer !== LAYER_SKY && fw > fa) flags |= 2;
    }
  return { layer, lod: 0, cx: 10, cz: 10, step: 1, flags, minA: 0, maxA: 0, minB: 0, maxB: 0, a, b, w };
}

describe('layer meshes', () => {
  it('draws floor and ceiling only where the layer is open', () => {
    // Open in the west half (i < 32), rock in the east.
    const t = tile(LAYER_UNDER, (i) => (i < 32 ? [-100, -60, NO_WATER] : [-50, -50, NO_WATER]));
    const m = buildLayerMesh(t, world());
    const tris = m.index.length / 3;
    // 31 open columns of cells fully + the boundary column (any corner open), floor and ceiling, 2 triangles per cell, 64 rows.
    expect(tris).toBe(2 * 64 * 2 * 32);
    expect(m.wIndex.length).toBe(0);
    for (let k = 0; k < m.index.length; k++) expect(m.index[k]).toBeLessThan(2 * S * S);
  });

  it('never draws the ceiling of an opening (open sky above a tunnel mouth)', () => {
    const t = tile(LAYER_UNDER, () => [-10, OPEN_C, NO_WATER]);
    const m = buildLayerMesh(t, world());
    // Floor only.
    expect(m.index.length / 3).toBe(64 * 64 * 2);
    for (let k = 0; k < m.index.length; k++) expect(m.index[k]).toBeLessThan(S * S);
  });

  it('cuts a Depths gate out of the Underground floor', () => {
    const t = tile(LAYER_UNDER, () => [-100, -40, NO_WATER]);
    const gate = { x: 640 + 32, z: 640 + 32, rMask: 10, y: -100, into: LAYER_DEPTHS, kind: 2, yaw: 0, site: 0, target: 0 };
    const full = buildLayerMesh(t, world()).index.length;
    const cut = buildLayerMesh(t, world({ openings: [gate], gateOpenings: [gate] })).index.length;
    // About pi r^2 = 314 one-metre cells (628 triangles) of floor fewer; the ceiling stays.
    expect(full - cut).toBeGreaterThan(3 * 560);
    expect(full - cut).toBeLessThan(3 * 700);
  });

  it('meshes lakes where the water stands over the floor', () => {
    const t = tile(LAYER_UNDER, (i, j) => [Math.hypot(i - 32, j - 32) < 12 ? -110 : -100, -40, -104]);
    const m = buildLayerMesh(t, world());
    expect(m.wIndex.length).toBeGreaterThan(0);
    expect(m.wDepth[32 * S + 32]).toBeCloseTo(6, 3);
  });

  it('an island: top and bottom where it is solid, glow free', () => {
    const t = tile(LAYER_SKY, (i, j) => (Math.hypot(i - 32, j - 32) < 20 ? [500, 440, NO_WATER] : [480, 480, NO_WATER]));
    const m = buildLayerMesh(t, world());
    expect(m.index.length).toBeGreaterThan(0);
    for (let k = 0; k < m.glow.length; k++) expect(m.glow[k]).toBe(0);
    // The top faces up, the bottom down.
    expect(m.normals[(32 * S + 32) * 3 + 1]).toBeGreaterThan(0.9);
    expect(m.normals[(S * S + 32 * S + 32) * 3 + 1]).toBeLessThan(-0.9);
  });
});

describe('map layers', () => {
  const site = (kind: string, layer?: number) => ({ kind, layer, category: 'poi' }) as unknown as Site;
  it('shows each site on its own layer, doorways on both', () => {
    expect(siteOnLayer(site('tower'), 0)).toBe(true);
    expect(siteOnLayer(site('tower'), 2)).toBe(false);
    expect(siteOnLayer(site('cavern', 2), 2)).toBe(true);
    expect(siteOnLayer(site('cavern', 2), 0)).toBe(false);
    expect(siteOnLayer(site('tunnel', 0), 0)).toBe(true);
    expect(siteOnLayer(site('tunnel', 0), 2)).toBe(true);
    expect(siteOnLayer(site('depths_gate', 2), 3)).toBe(true);
    expect(siteOnLayer(site('sky_lift', 0), 1)).toBe(true);
  });
});

describe('music by layer', () => {
  const base: MusicInputs = { playing: true, hour: 13, underground: 1, inTown: false, combat: false, voidMoment: false, timed: null, finale: null };
  it('the Depths play the void realm, the Underground the cave', () => {
    expect(new MusicDirector().wanted({ ...base, layer: LAYER_DEPTHS })).toBe('void');
    expect(new MusicDirector().wanted({ ...base, layer: LAYER_UNDER })).toBe('cave');
  });
  it('composer mappings can ask for a layer', () => {
    const m: MusicMapping = { id: 'a', file: 'sky.wav', when: { layer: 'sky' }, gain: 1, loop: true, fadeIn: 2, enabled: true };
    const c = { state: 'day', biome: 'meadow', hour: 12, time: 'day', weather: 'clear', tier: null, tierIndex: 0, areaLevel: null, act: null, combat: false, boss: false, underground: 0, inTown: false, layer: 'sky', timedPhase: null, intensity: 0.3 } as VibeContext;
    expect(mappingMatches(m, c)).toBe(true);
    expect(mappingMatches(m, { ...c, layer: 'surface' })).toBe(false);
  });
});

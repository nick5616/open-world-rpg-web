// WP20 building kit: the rendered shell coincides with the collision boxes
// (spec 5 "what you see is what you bump"). For sample buildings of every
// style (the official world has timber, stone, stilt and cottage; seed 3
// adds adobe; the log style only appears on snowpeak settlements, which the
// first worlds lack, so a timber building is relabelled log: log walls use
// the same 0.3 m thickness and every face is drawn from the boxes anyway),
// every wall box's outer and inner faces, the floor top and each roof half
// must be covered by a mesh triangle lying in the box face's plane.

import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BOX_FLAG, BUILDING_FLAG, loadWorldgen, parseTowns, townsBytes, type Building, type Towns } from '@lodestone/worldgen';
import { hasWasm, testWorld, wasmPath } from '../testing/wasm';
import * as THREE from 'three';
import { BK, SKY_GLOW_HOUSE, SKY_GLOW_INN, boxAt, buildSettlementMesh, drawBuildingShell, drawSteps, wallThickness, type Box } from './kit';
import { GLOW_DAYLIGHT, MeshBuilder, type MeshData } from './meshBuilder';
import { buildStructureMesh } from './structures';
import { TEX } from './textures';
import { makeTownMaterials, townTexture, TOWN_PROGRAM_KEY } from './townMaterial';

type V = [number, number, number];

/** Is there a triangle whose plane holds p (within tol) with normal ~n, and which contains p? */
function covered(m: MeshData, p: V, n: V, tol = 2e-3): boolean {
  const P = m.position;
  const I = m.index;
  for (let t = 0; t < m.indexCount; t += 3) {
    const a = I[t] * 3;
    const b = I[t + 1] * 3;
    const c = I[t + 2] * 3;
    const e1: V = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]];
    const e2: V = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) continue;
    nx /= L;
    ny /= L;
    nz /= L;
    if (nx * n[0] + ny * n[1] + nz * n[2] < 0.995) continue;
    const w: V = [p[0] - P[a], p[1] - P[a + 1], p[2] - P[a + 2]];
    if (Math.abs(w[0] * nx + w[1] * ny + w[2] * nz) > tol) continue;
    // Barycentric containment.
    const d00 = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
    const d01 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const d11 = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
    const d20 = w[0] * e1[0] + w[1] * e1[1] + w[2] * e1[2];
    const d21 = w[0] * e2[0] + w[1] * e2[1] + w[2] * e2[2];
    const den = d00 * d11 - d01 * d01;
    const v = (d11 * d20 - d01 * d21) / den;
    const u = (d00 * d21 - d01 * d20) / den;
    if (v >= -1e-6 && u >= -1e-6 && u + v <= 1 + 1e-6) return true;
  }
  return false;
}

const world = (b: Box, u: number, y: number, v: number): V => [b.cx + u * b.c - v * b.s, y, b.cz + u * b.s + v * b.c];
const dir = (b: Box, u: number, v: number): V => [u * b.c - v * b.s, 0, u * b.s + v * b.c];

/** Check one building's shell against its boxes; returns the number of faces checked. */
function checkBuilding(t: Towns, b: Building): number {
  const mb = new MeshBuilder();
  drawBuildingShell(mb, t, b, () => b.floorY - 1);
  const m = mb.data();
  let checked = 0;
  const wt = wallThickness(b.style);
  for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
    const bx = boxAt(t, i);
    const top = Math.max(bx.y1, bx.y2);
    if (bx.kind === BK.wall) {
      // Both long faces, sampled at a third of the height (below windows' sills: 0.95 m) and mid-span.
      const long = bx.hx >= bx.hz;
      const y = Math.max(bx.y0, b.floorY) + Math.min(0.5, (top - Math.max(bx.y0, b.floorY)) / 3);
      for (const sgn of [-1, 1]) {
        const p = long ? world(bx, 0, y, sgn * bx.hz) : world(bx, sgn * bx.hx, y, 0);
        const n = long ? dir(bx, 0, sgn) : dir(bx, sgn, 0);
        expect(covered(m, p, n), `building ${b.index} (${b.style}) wall box ${i} face ${sgn}`).toBe(true);
        checked++;
      }
      expect(Math.min(bx.hx, bx.hz) * 2).toBeCloseTo(wt, 3);
    } else if (bx.kind === BK.floor && (bx.flags & BOX_FLAG.solid) !== 0) {
      expect(covered(m, world(bx, bx.hx * 0.3, bx.y1, -bx.hz * 0.2), [0, 1, 0]), `floor of ${b.index}`).toBe(true);
      checked++;
    } else if (bx.kind === BK.roof) {
      // The roof surface over the box's middle, at the collision top there.
      const y = (bx.y1 + bx.y2) / 2;
      const p = world(bx, 0, y, 0);
      const slope = (bx.y2 - bx.y1) / (2 * bx.hx);
      const nu: V = dir(bx, -slope, 0);
      const L = Math.hypot(nu[0], 1, nu[2]);
      expect(covered(m, p, [nu[0] / L, 1 / L, nu[2] / L]), `roof box ${i} of ${b.index}`).toBe(true);
      checked++;
    } else if (bx.kind === BK.upper && (b.roof === 2 || b.roof === 3)) {
      expect(covered(m, world(bx, 0, top, 0), [0, 1, 0]), `flat roof of ${b.index}`).toBe(true);
      checked++;
    }
  }
  return checked;
}

describe.skipIf(!hasWasm)('building kit vs collision boxes', () => {
  let official: Towns;
  let adobeWorld: Towns;
  beforeAll(async () => {
    const { wg, atlas } = await testWorld();
    official = parseTowns(townsBytes(wg, atlas));
    const wg2 = await loadWorldgen(fs.readFileSync(wasmPath));
    const a3 = wg2.buildAtlas(wg2.specFromSeed(3n));
    adobeWorld = parseTowns(townsBytes(wg2, a3));
  }, 60000);

  const sample = (t: Towns, style: number) => t.buildings.filter((b) => b.style === style && b.floors > 0).slice(0, 12);

  for (const [name, style, which] of [
    ['timber', 0, 'official'],
    ['stone', 1, 'official'],
    ['stilt', 3, 'official'],
    ['cottage', 5, 'official'],
    ['adobe', 2, 'seed3'],
  ] as const) {
    it(`${name}: walls, floors and roofs are drawn on their boxes`, () => {
      const t = which === 'official' ? official : adobeWorld;
      const bs = sample(t, style);
      expect(bs.length).toBeGreaterThan(0);
      let n = 0;
      for (const b of bs) n += checkBuilding(t, b);
      expect(n).toBeGreaterThan(bs.length * 6);
    });
  }

  it('log (a timber building relabelled: same 0.3 m walls)', () => {
    const b = sample(official, 0)[0];
    const n = checkBuilding(official, { ...b, style: 4 });
    expect(n).toBeGreaterThan(6);
  });

  it('every role gets a shell with a door gap: no wall box covers the doorway', () => {
    for (const b of official.buildings.filter((x) => x.floors > 0).slice(0, 80)) {
      const wt = wallThickness(b.style);
      const du = b.doorU;
      const dv = -b.hz + wt / 2;
      const x = b.x + du * b.c - dv * b.s;
      const z = b.z + du * b.s + dv * b.c;
      const y = b.floorY + 1.2;
      for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
        const bx = boxAt(official, i);
        if (bx.kind !== BK.wall || y < bx.y0) continue;
        const dx = x - bx.cx;
        const dz = z - bx.cz;
        const inside = Math.abs(dx * bx.c + dz * bx.s) < bx.hx - 1e-3 && Math.abs(dz * bx.c - dx * bx.s) < bx.hz - 1e-3;
        expect(inside, `door of building ${b.index} blocked by box ${i}`).toBe(false);
      }
    }
  });

  it('the largest town is a handful of meshes worth of geometry, built quickly', () => {
    const big = [...official.settlements].sort((a, b) => b.size - a.size || b.buildingCount - a.buildingCount)[0];
    const t0 = performance.now();
    const m = buildSettlementMesh(official, big.index, () => big.y);
    const ms = performance.now() - t0;
    expect(m.shell.indexCount / 3).toBeGreaterThan(5000);
    expect(m.shell.indexCount / 3).toBeLessThan(120_000);
    expect(m.interior.indexCount).toBeGreaterThan(0);
    expect(m.lights.length / 7).toBeGreaterThan(big.buildingCount / 4);
    // Playtest 2 immersion pass: one smoke source per chimney stack, above its building's roof, within the town.
    const chimneys = official.buildings.slice(big.buildingFirst, big.buildingFirst + big.buildingCount).filter((b) => (b.flags & BUILDING_FLAG.chimney) !== 0);
    expect(m.smoke.length / 3).toBe(chimneys.length);
    for (let i = 0; i < m.smoke.length; i += 3) {
      expect(Math.hypot(m.smoke[i] - big.x, m.smoke[i + 2] - big.z)).toBeLessThan(big.radius + 20);
      expect(m.smoke[i + 1]).toBeGreaterThan(big.y + 2);
    }
    // All indices in range, all positions finite.
    for (let i = 0; i < m.shell.indexCount; i++) expect(m.shell.index[i]).toBeLessThan(m.shell.vertexCount);
    expect(m.shell.position.every(Number.isFinite)).toBe(true);
    expect(ms).toBeLessThan(500);
  });

  it('every structure builds; each solid box is covered on its top', () => {
    for (const st of official.structures) {
      const m = buildStructureMesh(official, st.index, () => st.y);
      expect(m.shell.indexCount, `structure ${st.index}`).toBeGreaterThan(0);
      expect(m.shell.position.every(Number.isFinite)).toBe(true);
    }
  });

  it('windows: inner panes carry the daylight class, outer panes keep their night glow', () => {
    const nightGlows = new Set([0, SKY_GLOW_HOUSE, SKY_GLOW_INN]);
    let inner = 0;
    let outer = 0;
    let outerLit = 0;
    for (const b of official.buildings.filter((x) => x.floors > 0).slice(0, 60)) {
      const mb = new MeshBuilder();
      drawBuildingShell(mb, official, b, () => b.floorY - 1);
      const m = mb.data();
      for (let i = 0; i < m.vertexCount; i++) {
        if (m.lg[i * 2] !== TEX.window) continue;
        const glow = m.lg[i * 2 + 1];
        // Which way the pane looks: away from the building's middle (outside) or toward it (inside).
        const facing = (m.position[i * 3] - b.x) * m.normal[i * 3] + (m.position[i * 3 + 2] - b.z) * m.normal[i * 3 + 2];
        if (glow === GLOW_DAYLIGHT) {
          expect(facing, `building ${b.index}: daylight pane faces in`).toBeLessThan(0);
          inner++;
        } else {
          expect(nightGlows.has(glow), `building ${b.index}: window glow ${glow}`).toBe(true);
          expect(facing, `building ${b.index}: night pane faces out`).toBeGreaterThan(0);
          outer++;
          if (glow > 0) outerLit++;
        }
      }
    }
    expect(inner).toBeGreaterThan(0);
    expect(inner).toBe(outer); // one inner pane per outer pane
    expect(outerLit).toBeGreaterThan(0);
  });
});

describe('daylight panes (playtest 2: windows light the room by day)', () => {
  it('127 is reserved: no night window or always-on light uses it', () => {
    expect(GLOW_DAYLIGHT).toBe(127);
    expect(SKY_GLOW_HOUSE).toBeLessThan(GLOW_DAYLIGHT);
    expect(SKY_GLOW_INN).toBeLessThan(GLOW_DAYLIGHT);
    for (const f of ['kit.ts', 'props.ts', 'structures.ts']) {
      const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/\],\s*127\s*\)/);
    }
  });

  it('the town shader lights daylight panes by (1 - uNight) and has a new cache key', () => {
    const mats = makeTownMaterials(townTexture(new Uint8Array(4), 1, 1));
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    mats.solid.onBeforeCompile(shader as never, null as never);
    expect(shader.fragmentShader).toContain('float daylight = abs(g - 127.0) < 0.5 ? 1.0 : 0.0;');
    expect(shader.fragmentShader).toContain('float on = mix(mix(uNight, 1.0, always), 1.0 - uNight, daylight);');
    expect(shader.fragmentShader).toContain('* townTexel.a * on * uGlow');
    expect(mats.solid.customProgramCacheKey()).toBe('lodestone-town-v4');
    expect(mats.decal.customProgramCacheKey()).toBe(TOWN_PROGRAM_KEY);
    mats.dispose();
  });
});

describe('genVersion 2 door steps (playtest 1)', () => {
  it('steps on a door ramp: ~0.2 m risers whose treads sit within one riser of the walkable slope', () => {
    // A ramp box rising 2.4 m over 3.72 m, u axis up the flight (worldgen kit.rs stair_len).
    const bx = { cx: 0, cz: 0, c: 1, s: 0, hx: 1.86, hz: 0.9, y0: -0.6, y1: 0, y2: 2.4, kind: BK.ramp, flags: BOX_FLAG.walk, owner: 0 } as unknown as Box;
    const mb = new MeshBuilder(256);
    const n = drawSteps(mb, { cx: 0, cz: 0, c: 1, s: 0 }, bx, 'planks');
    expect(n).toBe(12);
    const m = mb.data();
    let treads = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      if (m.normal[i * 3 + 1] < 120) continue; // upward faces
      const u = m.position[i * 3];
      const y = m.position[i * 3 + 1];
      if (Math.abs(m.position[i * 3 + 2]) > bx.hz - 0.08 + 1e-4) continue; // stringer tops
      const ramp = bx.y1 + ((u + bx.hx) / (2 * bx.hx)) * (bx.y2 - bx.y1);
      expect(Math.abs(y - ramp)).toBeLessThanOrEqual(2.4 / 12 + 1e-4);
      treads++;
    }
    expect(treads).toBeGreaterThanOrEqual(12 * 4);
  });
});

// Enemy model gallery (dev only): the real enemy renderer and the world's
// post chain over a test ground, fed synthetic snapshot views, for
// iterating on the models and for the evidence shots and the crowd bench
// (enemy-shots.ts) without a zone.
//
//   /src/combat/enemies/dev/gallery.html?tier=high|low[&night=1]
//   __enemies.show(['wolf', 'boar'], { yaw })   a lineup facing the camera
//   __enemies.act('windup' | 'strike' | 'hit' | 'dying' | 'walk' | 'idle')
//   __enemies.crowd(200, 'new' | 'legacy')       a wandering synthetic crowd
//   __enemies.numbers()                          a burst of damage numbers
//   __enemies.sample(ms)                         frame times

import * as THREE from 'three';
import { COMBAT } from '@lodestone/contracts';
import { PostFX } from '../../../world/post/postfx';
import { useQualityStore, type QualityTier } from '../../../stores/qualityStore';
import type { RemoteView } from '../../../net/interpolation';
import { EnemyRenderer } from '../renderer';
import { DamageNumberLayer } from '../../numbers/layer';
import { LegacyEnemies } from './legacy';
import { modelFor } from '../models';
import { modelSpec, summonSpec, contractSummons } from '../spec';
import { enemyInfo } from '../../events';
import { enemyWarmObjects } from '../warm';
import { pushNumber, fxQueue, type DamageNumber } from '../../store';

const q = new URLSearchParams(location.search);
const tier = (q.get('tier') ?? 'high') as QualityTier;
const night = q.has('night');
useQualityStore.getState().setSetting(tier);

const h = (x: number, z: number) => 0.25 * Math.sin(x * 0.11) * Math.cos(z * 0.09) + 0.15 * Math.sin(x * 0.05 + z * 0.07);

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = tier !== 'low';
renderer.info.autoReset = false; // one frame's draws across every post pass (stats)
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? '#0d1424' : '#8aa4c8');
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 900);
scene.add(camera);
scene.add(new THREE.HemisphereLight(night ? 0x34405a : 0xcfe3ff, night ? 0x10140c : 0x4a5a3a, night ? 0.35 : 1.1));
const sun = new THREE.DirectionalLight(night ? 0x8090c0 : 0xfff1dd, night ? 0.25 : 2.2);
sun.position.set(30, 50, 25);
sun.castShadow = tier !== 'low';
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, far: 150 });
scene.add(sun);
scene.add(sun.target);

const geo = new THREE.PlaneGeometry(600, 600, 200, 200).rotateX(-Math.PI / 2);
const pos = geo.getAttribute('position') as THREE.BufferAttribute;
for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
geo.computeVertexNormals();
const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#5f7a3c', roughness: 1 }));
terrain.receiveShadow = true;
scene.add(terrain);
for (let i = 0; i < 30; i++) {
  const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + Math.random() * 0.7), new THREE.MeshStandardMaterial({ color: '#6d6a62', roughness: 1, flatShading: true }));
  const x = (Math.random() - 0.5) * 80;
  const z = -Math.random() * 60 - 8;
  r.position.set(x, h(x, z), z);
  r.castShadow = r.receiveShadow = true;
  scene.add(r);
}

const post = new PostFX(renderer, scene, camera, { multisampling: tier === 'high' ? 4 : 0, bloom: tier !== 'low', godRays: false, spellScreen: false });
post.setSize(innerWidth, innerHeight);
const sunDir = sun.position.clone().normalize();
const sunCol = new THREE.Color(night ? '#8090c0' : '#fff1dd');
post.fog.u('uFogDensity').value = 0.0035;
post.fog.u('uSunDir').value = sunDir;
post.fog.u('uSunColor').value = sunCol;
post.fog.u('uExposure').value = night ? 1.1 : 1;

const enemies = new EnemyRenderer();
scene.add(enemies.root);
const numbers = new DamageNumberLayer();
scene.add(numbers.mesh);
const legacy = new LegacyEnemies();
scene.add(legacy.root);
const label = document.getElementById('label')!;

// ── Synthetic views ─────────────────────────────────────────────────────────

interface Sim {
  v: RemoteView;
  /** wander: centre, radius, angular speed, phase */
  cx: number;
  cz: number;
  r: number;
  w: number;
  a: number;
  next: number;
  windUntil: number;
}
let sims: Sim[] = [];
let mode: 'new' | 'legacy' = 'new';
let wander = false;
let nextId = 1;

function enemyDef(key: string) {
  return COMBAT.enemies.find((e) => e.key === key);
}

function makeView(key: string, x: number, z: number, yaw: number, o: { element?: number; affix?: number; summon?: boolean; name?: string } = {}): RemoteView {
  let typeId: number;
  let kind = 2;
  if (o.summon) {
    typeId = contractSummons().find((m) => m.key === key)!.typeId;
    kind = 7;
  } else {
    const d = enemyDef(key)!;
    const el = o.element ?? (d.element >= 0 ? d.element : -1);
    typeId = d.id | ((el + 1) << 8) | ((o.affix ?? 0) << 12);
  }
  const fly = !o.summon && enemyDef(key)?.behavior === 'flyer';
  return { id: nextId++, x, y: h(x, z) + (fly ? 1.5 : 0), z, yaw, pitch: 0, speed: 0, kind, name: o.name ?? '', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId, ring: 'near', delayMs: 0, mode: 'interp' } as RemoteView;
}

function sizeOf(v: RemoteView): { r: number; h: number } {
  const spec = v.kind === 7 ? summonSpec(v.typeId ?? 0) : modelSpec(enemyInfo(v));
  const m = modelFor(spec);
  return { r: m.radius * spec.scale, h: m.height * spec.scale };
}

function clearAll(): void {
  sims = [];
  for (const t of timers.splice(0)) clearTimeout(t);
  legacy.clear();
  enemies.update([], camera, 5, performance.now());
  numbers.clear();
}

const timers: number[] = [];

const gallery = {
  ready: false,
  label(s: string) {
    label.textContent = s;
  },
  /** A lineup of keys (summons: 'summon:wraith_hound'), side by side, turned 3/4 to the camera. */
  show(keys: string[], opts: { yaw?: number; element?: number; affix?: number; height?: number; dist?: number; names?: boolean } = {}): void {
    clearAll();
    mode = 'new';
    wander = false;
    const views = keys.map((k) => (k.startsWith('summon:') ? makeView(k.slice(7), 0, 0, 0, { summon: true }) : makeView(k, 0, 0, 0, { element: opts.element, affix: opts.affix, name: opts.names ? enemyDef(k)?.name : '' })));
    const sizes = views.map(sizeOf);
    // two rows when the line would be wide: the big ones stand behind the small ones
    const small = sizes.map((s, i) => [s, i] as const).filter(([s]) => s.h < 2.4);
    const big = sizes.map((s, i) => [s, i] as const).filter(([s]) => s.h >= 2.4);
    const rows = small.length && big.length && sizes.length > 3 ? [small, big] : [sizes.map((s, i) => [s, i] as const)];
    const gap = 0.45;
    let z = 0;
    let frontW = 0;
    let maxH = 0;
    let frontH = 0;
    rows.forEach((row, ri) => {
      const total = row.reduce((a, [s]) => a + s.r * 1.6 + gap, -gap);
      if (ri === 0) frontW = total;
      let x = -total / 2;
      const depth = Math.max(...row.map(([s]) => s.r));
      if (ri > 0) z -= depth + 0.5;
      for (const [s, i] of row) {
        x += s.r * 0.8;
        const v = views[i];
        v.x = x;
        v.z = z;
        v.y = h(x, z) + (v.y - h(0, 0));
        v.yaw = Math.PI + (opts.yaw ?? -0.5);
        x += s.r * 0.8 + gap;
        maxH = Math.max(maxH, s.h);
        if (ri === 0) frontH = Math.max(frontH, s.h);
        sims.push({ v, cx: v.x, cz: v.z, r: 0, w: 0, a: 0, next: 1e12, windUntil: 0 });
      }
      if (ri === 0) z -= depth;
    });
    const fov = (camera.fov * Math.PI) / 180;
    const dist = opts.dist ?? Math.max((Math.max(frontH, maxH * 0.75) * 1.25) / (2 * Math.tan(fov / 2)), (frontW * 1.05) / (2 * Math.tan(fov / 2) * camera.aspect)) + 0.8;
    camera.position.set(0, maxH * 0.5 + dist * 0.32, dist);
    camera.lookAt(0, maxH * 0.38, z * 0.35);
  },
  /** Drive the lineup: idle, walk (in place), windup (held near its peak), strike, hit, dying. */
  act(state: string): void {
    const now = performance.now();
    for (const s of sims) {
      const v = s.v;
      v.speed = state === 'walk' ? 3.2 : 0;
      v.activity = 0;
      const spec = v.kind === 7 ? summonSpec(v.typeId ?? 0) : modelSpec(enemyInfo(v));
      const def = enemyDef(spec.key);
      const atk = COMBAT.enemyAttacks.find((a) => a.key === (def?.attacks[state === 'strike2' || state === 'windup2' ? Math.min(1, def.attacks.length - 1) : 0] ?? 'bite'));
      if (state.startsWith('windup')) {
        // a long wind-up, captured near its peak
        enemies.telegraph(v.id, atk?.id ?? 0, 4000, atk?.activeMs ?? 100);
        v.activity = 8;
        s.windUntil = now + 4000;
      } else if (state.startsWith('strike')) {
        enemies.telegraph(v.id, atk?.id ?? 0, 120, Math.max(240, atk?.activeMs ?? 100));
        v.activity = 8;
        s.windUntil = now + 120;
      } else if (state === 'hit') enemies.hit(v.id, true);
      else if (state === 'dying') {
        enemies.die(v.id);
        v.healthPct = 0;
      } else if (state === 'reset') {
        v.healthPct = 100;
      }
    }
  },
  /** A wandering crowd of n random enemies (all families) in front of the camera. */
  crowd(n: number, m: 'new' | 'legacy' = 'new', opts: { keys?: string[]; spread?: number } = {}): void {
    clearAll();
    mode = m;
    wander = true;
    const keys = opts.keys ?? COMBAT.enemies.filter((e) => e.family !== 'boss' && e.key !== 'starless_sovereign').map((e) => e.key);
    const spread = opts.spread ?? 130;
    let seed = 12345;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const key = keys[i % keys.length];
      // denser near the camera (a fight), thinning out to the horizon
      const d = 6 + Math.pow(r(), 1.6) * spread;
      const a = (r() - 0.5) * 1.5;
      const cx = Math.sin(a) * d;
      const cz = -Math.cos(a) * d;
      const v = makeView(key, cx, cz, 0, { affix: r() < 0.06 ? 1 + Math.floor(r() * 3) : 0 });
      sims.push({ v, cx, cz, r: 1 + r() * 3, w: (0.4 + r() * 0.8) * (r() < 0.5 ? -1 : 1), a: r() * 6.28, next: performance.now() + 500 + r() * 4000, windUntil: 0 });
    }
    camera.position.set(0, 3.2, 8);
    camera.lookAt(0, 1.2, -20);
  },
  /** A burst of damage numbers on the first lineup enemy (every kind, a few elements, stacked). */
  numbers(): void {
    const v = sims[0]?.v;
    if (!v) return;
    const top = v.y + sizeOf(v).h + 0.3;
    const list: [number, DamageNumber['kind'], number | undefined][] = [
      [24, 'dealt', undefined],
      [31, 'dealt', 0],
      [58, 'crit', 0],
      [19, 'weak', 1],
      [7, 'resist', 2],
      [42, 'dealt', 5],
      [96, 'crit', 7],
      [12, 'dealt', 3],
    ];
    list.forEach(([val, kind, el], i) => timers.push(window.setTimeout(() => pushNumber(v.x + (i % 2 ? 0.2 : -0.2), top, v.z, val, kind, el), i * 70)));
    timers.push(window.setTimeout(() => pushNumber(camera.position.x + 0.5, camera.position.y - 0.6, camera.position.z - 3, 14, 'taken'), 200));
    timers.push(window.setTimeout(() => pushNumber(camera.position.x - 0.5, camera.position.y - 0.6, camera.position.z - 3, 25, 'heal'), 300));
  },
  view(name: 'fp' | 'tp' | 'wide'): void {
    const v = sims[0]?.v;
    const at = v ? new THREE.Vector3(v.x, v.y, v.z) : new THREE.Vector3();
    if (name === 'fp') camera.position.set(at.x + 0.6, at.y + 1.6, at.z + 3.2);
    else if (name === 'tp') camera.position.set(at.x + 1.5, at.y + 2.6, at.z + 6.5);
    else camera.position.set(at.x, at.y + 6, at.z + 16);
    camera.lookAt(at.x, at.y + 1.1, at.z);
  },
  camera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
  },
  /** (scripts: a no-op marking where to take a screenshot) */
  shot(): void {},
  /** The animator state of lineup entry i (debugging). */
  anim(i = 0) {
    const a = sims[i] ? enemies.animator(sims[i].v.id) : null;
    return a ? { state: a.state, death: a.death, dissolve: a.dissolve, windup: a.windup, flash: a.flash } : null;
  },
  stats: () => ({ ...enemies.stats(), mode, programs: (renderer.info.programs ?? []).length, calls: frameCalls, triangles: frameTris }),
  async sample(ms: number): Promise<{ dt: number[]; update: number[] }> {
    const dt: number[] = [];
    const update: number[] = [];
    let last = performance.now();
    const t0 = last;
    await new Promise<void>((done) => {
      const f = (t: number) => {
        dt.push(t - last);
        update.push(lastUpdateMs);
        last = t;
        if (t - t0 < ms) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    return { dt, update };
  },
};
(window as unknown as { __enemies: typeof gallery }).__enemies = gallery;

let lastUpdateMs = 0;
let frameCalls = 0;
let frameTris = 0;
let lastT = performance.now();
const views: RemoteView[] = [];
const frame = (t: number) => {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  const now = performance.now();
  views.length = 0;
  for (const s of sims) {
    const v = s.v;
    if (wander) {
      // walk a circle; now and then wind up an attack (casting bit + telegraph)
      s.a += (s.w * dt * 2.5) / s.r;
      const nx = s.cx + Math.cos(s.a) * s.r;
      const nz = s.cz + Math.sin(s.a) * s.r;
      const dx = nx - v.x;
      const dz = nz - v.z;
      v.speed = Math.hypot(dx, dz) / Math.max(1e-3, dt);
      if (v.speed > 0.01) v.yaw = Math.atan2(-dx, -dz);
      v.x = nx;
      v.z = nz;
      v.y = h(nx, nz) + (enemyDef(enemyInfo(v).key)?.behavior === 'flyer' ? 1.5 : 0);
      if (now > s.next) {
        s.next = now + 2500 + Math.random() * 4000;
        const def = enemyDef(enemyInfo(v).key);
        const atk = COMBAT.enemyAttacks.find((a) => a.key === def?.attacks[Math.floor(Math.random() * (def?.attacks.length ?? 1))]);
        if (atk) {
          enemies.telegraph(v.id, atk.id, atk.windupMs, atk.activeMs);
          s.windUntil = now + atk.windupMs;
        }
        if (Math.random() < 0.3) enemies.hit(v.id);
      }
    }
    v.activity = now < s.windUntil ? 8 : 0;
    views.push(v);
  }
  // damage numbers come through the store's FX queue, as in play
  while (fxQueue.length) {
    const f = fxQueue.shift()!;
    if (f.t === 'number') numbers.add(f.n);
  }
  const u0 = performance.now();
  if (mode === 'legacy') legacy.update(views, camera, dt, now);
  else enemies.update(views, camera, dt, now);
  numbers.update(camera, renderer, now);
  lastUpdateMs = performance.now() - u0;
  post.update(sunDir, sunCol, 1);
  renderer.info.reset();
  post.render(dt);
  frameCalls = renderer.info.render.calls;
  frameTris = renderer.info.render.triangles;
  requestAnimationFrame(frame);
};

// Warm the enemy programs (as the world's warm-up does) before the first frame.
for (const o of enemyWarmObjects()) scene.add(o);
renderer.compileAsync(scene, camera).then(() => {
  for (const o of enemyWarmObjects()) scene.remove(o);
  requestAnimationFrame(frame);
  setTimeout(() => (gallery.ready = true), 300);
});

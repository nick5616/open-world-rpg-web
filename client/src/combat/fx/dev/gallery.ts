// Spell FX gallery (dev only): the real FX engine and the world's real post
// chain (fog, bloom on high, ACES, grade, the spell screen effect) over a
// rolling test ground with dummy enemies, for iterating on spell looks and
// for the evidence screenshots (fx-shots.ts) without a zone.
//
//   /src/combat/fx/dev/gallery.html?tier=high|low[&night=1]
//   window.__gallery.cast('fireball')      observer view (third person, side-on)
//   window.__gallery.local('fireball')     first person, as your own cast
//   window.__gallery.status('burn')        a status on the first dummy

import * as THREE from 'three';
import { COMBAT, type SpellDef } from '@lodestone/contracts';
import { PostFX } from '../../../world/post/postfx';
import { useQualityStore, type QualityTier } from '../../../stores/qualityStore';
import { drawnRemotes } from '../../../net/netStore';
import type { RemoteView } from '../../../net/interpolation';
import { localPlayer } from '../../../state/live';
import type { GroundQuery } from '../../../sim/ground';
import { SpellFxEngine } from '../engine';
import { setSpellFxEngine } from '../api';
import { fxLightCount, currentFxTier } from '../quality';
import { spellByKey, statusById } from '../spellVisual';

const q = new URLSearchParams(location.search);
const tier = (q.get('tier') ?? 'high') as QualityTier;
const night = q.has('night');
useQualityStore.getState().setSetting(tier);

// ── Ground ──────────────────────────────────────────────────────────────────
const h = (x: number, z: number) => 0.7 * Math.sin(x * 0.13) * Math.cos(z * 0.11) + 0.35 * Math.sin(x * 0.05 + z * 0.07) + 0.15 * Math.sin(z * 0.4 + x * 0.2);
const ground: GroundQuery = { heightAt: h };

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NoToneMapping; // ACES runs in the post chain (as in the world)
renderer.shadowMap.enabled = tier !== 'low';
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(night ? '#0d1424' : '#7d97bd');
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 600);
scene.add(camera);
scene.add(new THREE.HemisphereLight(night ? 0x34405a : 0xcfe3ff, night ? 0x10140c : 0x4a5a3a, night ? 0.35 : 1.1));
const sun = new THREE.DirectionalLight(night ? 0x8090c0 : 0xfff1dd, night ? 0.25 : 2.2);
sun.position.set(30, 50, 20);
sun.castShadow = tier !== 'low';
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 150 });
scene.add(sun);

const geo = new THREE.PlaneGeometry(240, 240, 160, 160).rotateX(-Math.PI / 2);
const pos = geo.getAttribute('position') as THREE.BufferAttribute;
for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
geo.computeVertexNormals();
const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#5f7a3c', roughness: 1 }));
terrain.receiveShadow = true;
scene.add(terrain);
// a few rocks for depth cues
for (let i = 0; i < 24; i++) {
  const r = new THREE.Mesh(new THREE.DodecahedronGeometry(0.3 + Math.random() * 0.7), new THREE.MeshStandardMaterial({ color: '#6d6a62', roughness: 1, flatShading: true }));
  const x = (Math.random() - 0.5) * 60;
  const z = -Math.random() * 50 + 10;
  r.position.set(x, h(x, z), z);
  r.castShadow = r.receiveShadow = true;
  scene.add(r);
}

// ── Dummies (enemy views the engine sees, and meshes) ───────────────────────
const enemy = COMBAT.enemies[0];
const dummies: RemoteView[] = [];
const spots: [number, number][] = [
  [0, -14],
  [-3.5, -17],
  [3.5, -16],
  [-1.5, -21],
  [2, -9],
];
spots.forEach(([x, z], i) => {
  const y = h(x, z);
  const v = { id: 9000 + i, x, y, z, yaw: 0, pitch: 0, speed: 0, kind: 2, name: '', level: 1, healthPct: 100, activity: 0, partyId: 0, typeId: enemy.id, ring: 'near', delayMs: 0, mode: 'interp' } as RemoteView;
  dummies.push(v);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.7, 4, 10), new THREE.MeshStandardMaterial({ color: '#8a5a44', roughness: 0.7 }));
  m.position.set(x, y + 0.8, z);
  m.castShadow = true;
  scene.add(m);
});
drawnRemotes.views = dummies;

// ── Engine and post ─────────────────────────────────────────────────────────
const engine = new SpellFxEngine(fxLightCount(tier));
engine.prims.ground = ground;
scene.add(engine.group);
setSpellFxEngine(engine);
const post = new PostFX(renderer, scene, camera, { multisampling: tier === 'high' ? 4 : 0, bloom: tier !== 'low', godRays: false, spellScreen: tier !== 'low' });
post.setSize(innerWidth, innerHeight);
const sunDir = sun.position.clone().normalize();
const sunCol = new THREE.Color(night ? '#8090c0' : '#fff1dd');
post.fog.u('uFogDensity').value = 0.0015;
post.fog.u('uSunDir').value = sunDir;
post.fog.u('uSunColor').value = sunCol;
post.fog.u('uExposure').value = night ? 1.1 : 1;
const maxPoint = (() => {
  const ctx = renderer.getContext();
  const r = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE) as ArrayLike<number>;
  return Math.min(512, r[1]);
})();

// ── Views ───────────────────────────────────────────────────────────────────
const caster = { x: 0, y: h(0, 0), z: 0 };
type View = 'observer' | 'fp' | 'wide' | 'top' | 'close';
let view: View = 'observer';
function setView(v: View): void {
  view = v;
  (document.getElementById('cross') as HTMLElement).style.display = v === 'fp' ? 'block' : 'none';
  if (v === 'fp') {
    camera.position.set(caster.x, caster.y + 1.6, caster.z);
    camera.rotation.set(-0.08, 0, 0, 'YXZ');
  } else if (v === 'wide') {
    camera.position.set(16, caster.y + 9, -2);
    camera.lookAt(0, caster.y + 1, -13);
  } else if (v === 'close') {
    const t = dummies[1];
    camera.position.set(t.x - 3.2, t.y + 1.7, t.z + 3.4);
    camera.lookAt(t.x, t.y + 0.9, t.z);
  } else if (v === 'top') {
    camera.position.set(9, caster.y + 16, -4);
    camera.lookAt(0, caster.y, -14);
  } else {
    camera.position.set(11, caster.y + 3.6, -6.5);
    camera.lookAt(-0.5, caster.y + 1, -9.5);
  }
  camera.updateMatrixWorld();
}
setView('observer');
Object.assign(localPlayer.pos, caster);
localPlayer.yaw = 0;
localPlayer.pitch = -0.08;

/** Aim: chest of the first dummy for shots, the ground under it for areas. */
function aimFor(sp: SpellDef): { yaw: number; pitch: number; dist: number } {
  const t = dummies[0];
  const eyeY = caster.y + 1.6;
  const dx = t.x - caster.x;
  const dz = t.z - caster.z;
  const d = Math.hypot(dx, dz);
  const area = sp.type === 'aoe' || sp.type === 'rune';
  const ty = area ? t.y : t.y + 1;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(ty - eyeY, d), dist: d };
}

function flight(sp: SpellDef, dist: number): number {
  return sp.type === 'projectile' || sp.type === 'arc' ? (dist / Math.max(1, sp.speed)) * 1000 + sp.windupMs : sp.windupMs;
}

const timers: number[] = [];
const later = (f: () => void, ms: number) => void timers.push(window.setTimeout(f, ms));
const label = document.getElementById('label') as HTMLElement;
const gallery = {
  ready: false,
  tier: () => ({ graphics: tier, fx: currentFxTier() }),
  view: (v: View) => setView(v),
  label: (s: string) => (label.textContent = s),
  /** Observer cast from the caster spot at the first dummy. Returns ms until impact. */
  cast(key: string): number {
    const sp = spellByKey.get(key);
    if (!sp) throw new Error(`no spell ${key}`);
    const a = aimFor(sp);
    engine.castFrom(sp, { ...caster }, caster.x, caster.y, caster.z, a.yaw, a.pitch);
    return flight(sp, a.dist);
  },
  /** First-person cast, as the runtime plays your own. */
  local(key: string): number {
    const sp = spellByKey.get(key);
    if (!sp) throw new Error(`no spell ${key}`);
    setView('fp');
    const a = aimFor(sp);
    localPlayer.yaw = a.yaw;
    localPlayer.pitch = a.pitch;
    camera.rotation.set(a.pitch, a.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    const eye = { x: caster.x, y: caster.y + 1.6 - 0.15, z: caster.z };
    const t0 = dummies[0];
    const aim = (sp.type === 'aoe' || sp.type === 'rune') && !sp.selfCast && !sp.cone && !sp.line ? { x: t0.x, y: t0.y, z: t0.z } : null;
    engine.castStart(sp, 'self', aim, a.yaw);
    const cp = Math.cos(a.pitch);
    if (sp.type === 'projectile' || sp.type === 'arc') {
      later(() => {
        const pt = a.pitch + (sp.gravity > 0 ? 0.05 : 0);
        engine.projectile(sp, eye.x, eye.y, eye.z, -Math.sin(a.yaw) * Math.cos(pt) * sp.speed, Math.sin(pt) * sp.speed, -Math.cos(a.yaw) * Math.cos(pt) * sp.speed, sp.gravity, Math.max(0.2, Math.min(sp.radius, 1)), (sp.range || 40) / sp.speed, { local: true, collide: 'enemies', explode: sp.radius > 1 ? sp.radius : 0, pierce: sp.pierce });
      }, sp.windupMs);
    } else if (sp.type === 'hitscan' || sp.type === 'beam') {
      const t = dummies[0];
      engine.beam(`g${Math.random()}`, sp, 'self', { x: t.x, y: t.y + 0.9, z: t.z }, sp.type === 'beam' ? sp.durationMs : 160);
    } else if (sp.type === 'aoe' || sp.type === 'domain' || sp.type === 'rune') {
      // as the runtime resolves it after the windup
      later(() => {
        const self = sp.selfCast || sp.type === 'domain' || sp.cone > 0 || sp.line > 0;
        const c = self ? caster : { x: t0.x, y: t0.y, z: t0.z };
        if (sp.type === 'rune') engine.rune(sp, c.x, c.y, c.z);
        else engine.area(sp, c.x, c.y, c.z, { radius: sp.radius, cone: sp.cone, line: sp.line, yaw: a.yaw }, sp.durationMs, sp.selfCast || sp.type === 'domain' ? 'self' : null);
      }, sp.windupMs);
    }
    void cp;
    return flight(sp, a.dist);
  },
  status(key: string, target = 1): void {
    const s = COMBAT.statuses.find((x) => x.key === key);
    if (s) engine.status(dummies[target].id, s.id);
  },
  statusIds: () => [...statusById.values()].map((s) => s.key),
  stats: () => engine.stats(),
  clear: () => {
    for (const t of timers.splice(0)) clearTimeout(t);
    engine.clear();
  },
  /** Frame times (ms) over the next `ms` (perf sanity in the gallery). */
  async sample(ms: number): Promise<number[]> {
    const out: number[] = [];
    let last = performance.now();
    const t0 = last;
    await new Promise<void>((done) => {
      const f = (t: number) => {
        out.push(t - last);
        last = t;
        if (t - t0 < ms) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    return out;
  },
};
(window as unknown as { __gallery: typeof gallery }).__gallery = gallery;

let lastT = performance.now();
const frame = (t: number) => {
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  engine.update(camera, { width: innerWidth, height: innerHeight, dpr: 1, maxPoint });
  post.update(sunDir, sunCol, 1);
  post.render(dt);
  requestAnimationFrame(frame);
};
// Warm the FX programs before the first cast (as the world's warm-up does).
renderer.compileAsync(scene, camera).then(() => {
  engine.prewarm(); // and draw every FX variant once (engine.ts prewarm)
  requestAnimationFrame(frame);
  setTimeout(() => (gallery.ready = true), 300);
});
void view;

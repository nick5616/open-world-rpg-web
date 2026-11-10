// The 3D half of combat (WP13): enemies and summoned allies drawn from the
// interpolation buffer, telegraph decals, floating damage numbers and the
// first-person weapon with its swing. Mounted inside the world canvas by
// NetPlay. Every spell visual (yours, other players', enemy projectiles,
// statuses) is the spell FX engine's (fx/SpellFxLayer.tsx, playtest 2),
// mounted here.
//
// Playtest 2 enemy models: the enemies are the procedural, instanced,
// animated models of enemies/renderer.ts (one per contract family, LOD for
// crowds), animated from the snapshot (movement, the casting bit) and the
// combat events (telegraphs, hits, deaths, statuses, parries); the damage
// numbers are numbers/layer.ts (small, element-coloured, stacked).
//
// Everything is imperative three.js in one useFrame (no React state per
// frame).

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { COMBAT } from '@lodestone/contracts';
import { drawnRemotes } from '../net/netStore';
import { localPlayer } from '../state/live';
import { combatRuntime } from './link';
import { fxQueue, type Fx } from './store';
// The newest melee swing (set from the FX queue below, read by the weapon).
import { FirstPersonWeapon, swing } from './weapons/FirstPersonWeapon';
import { SpellFxLayer } from './fx/SpellFxLayer';
import { spellFx } from './fx/api';
import { EnemyRenderer } from './enemies/renderer';
import { DamageNumberLayer } from './numbers/layer';

const disc = new THREE.CircleGeometry(1, 48);

// ---- CR 020: allies from summon spells (EntityKind effect, typeId = summon id | (element + 1) << 8) ----
const summonById = new Map(COMBAT.summons.map((m) => [m.id, m]));
const summonSpell = new Map(COMBAT.summons.map((m) => [m.key, COMBAT.spells.find((s) => s.summon?.key === m.key) ?? null]));

const _q = new THREE.Quaternion();

/**
 * Turns `plate` (a child of a rotated parent) to face the camera: its world
 * rotation becomes the camera's, whatever the parent's yaw (billboard).
 * Exported for tests.
 */
export function faceCamera(plate: THREE.Object3D, camera: THREE.Camera): void {
  const parent = plate.parent;
  if (parent) {
    parent.updateWorldMatrix(true, false);
    parent.getWorldQuaternion(_q).invert();
    plate.quaternion.copy(_q).multiply(camera.getWorldQuaternion(new THREE.Quaternion()));
  } else plate.quaternion.copy(camera.quaternion);
}

interface Live {
  fx: Extract<Fx, { t: 'telegraph' }>;
  obj: THREE.Mesh;
  until: number;
}

function telegraphMesh(f: Extract<Fx, { t: 'telegraph' }>): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ color: '#ff3020', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
  let m: THREE.Mesh;
  switch (f.shape) {
    case 0: {
      // cone: a sector
      const g = new THREE.CircleGeometry(f.reach, 32, -((f.arc / 2) * Math.PI) / 180, (f.arc * Math.PI) / 180);
      m = new THREE.Mesh(g, mat);
      m.rotation.set(-Math.PI / 2, 0, f.yaw + Math.PI / 2);
      break;
    }
    case 3: {
      const g = new THREE.PlaneGeometry(f.width, f.reach);
      g.translate(0, f.reach / 2, 0);
      m = new THREE.Mesh(g, mat);
      m.rotation.set(-Math.PI / 2, 0, f.yaw);
      break;
    }
    default:
      m = new THREE.Mesh(disc, mat);
      m.scale.setScalar(Math.max(0.5, f.radius));
      m.rotation.x = -Math.PI / 2;
  }
  m.position.set(f.x, f.y + 0.08, f.z);
  // Readability: enemy telegraphs draw over spell ground effects (renderOrder 2-4).
  m.renderOrder = 6;
  return m;
}

/** The first-person weapon and its swing: weapons/FirstPersonWeapon.tsx (pt/ux). */
const Weapon = FirstPersonWeapon;

/** The enemy renderer of the mounted layer (headless captures, the bench). */
export const enemyLayer: { renderer: EnemyRenderer | null; numbers: DamageNumberLayer | null } = { renderer: null, numbers: null };

export function CombatLayer() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const root = useMemo(() => new THREE.Group(), []);
  const enemies = useMemo(() => new EnemyRenderer(), []);
  const numbers = useMemo(() => new DamageNumberLayer(), []);
  const allies = useMemo(() => new Map<number, { aura: number; seen: number }>(), []); // CR 020
  const live = useMemo<Live[]>(() => [], []);
  const frame = useMemo(() => ({ n: 0 }), []);

  useEffect(() => {
    scene.add(root);
    root.add(enemies.root, numbers.mesh);
    enemyLayer.renderer = enemies;
    enemyLayer.numbers = numbers;
    return () => {
      scene.remove(root);
      root.clear();
      enemies.dispose();
      numbers.clear();
      allies.clear();
      if (enemyLayer.renderer === enemies) enemyLayer.renderer = enemyLayer.numbers = null;
    };
  }, [scene, root, enemies, numbers, allies]);

  useFrame((_, delta) => {
    const rt = combatRuntime.current;
    const now = performance.now();
    rt?.update(delta * 1000);
    const all = drawnRemotes.views;
    rt?.noteBossHealth(all.filter((v) => v.kind === 2));
    const frozen = rt ? now < rt.hitstopUntil : false;

    // New FX first (a telegraph or a hit lands on this frame's pose).
    while (fxQueue.length) {
      const f = fxQueue.shift()!;
      switch (f.t) {
        case 'spark':
          // the hit flash and flinch on the enemy; the burst itself is the spell FX engine's
          if (f.target === undefined || !enemies.hit(f.target, f.heavy)) enemies.hitNear(f.x, f.y, f.z);
          break;
        case 'number':
          numbers.add(f.n);
          break;
        case 'telegraph': {
          const obj = telegraphMesh(f);
          root.add(obj);
          live.push({ fx: f, obj, until: now + f.windupMs + 250 });
          enemies.telegraph(f.enemy, f.attackId ?? 0, f.windupMs, f.activeMs);
          break;
        }
        case 'enemy':
          if (f.what === 'died') enemies.die(f.enemy);
          else if (f.what === 'status') enemies.status(f.enemy, f.value);
          else enemies.stagger(f.enemy);
          break;
        case 'swing':
          swing.at = f.at;
          swing.dur = f.durationMs + 120;
          break;
      }
    }

    // Enemies and allies (the renderer reads kinds 2 and 7).
    enemies.target.set(localPlayer.pos.x, localPlayer.pos.y + 1.5, localPlayer.pos.z);
    enemies.update(all, camera, delta, now, frozen);

    // CR 020: an ally appearing bursts; an idle aura while it lasts.
    frame.n++;
    for (const v of all) {
      if (v.kind !== 7) continue;
      const def = summonById.get((v.typeId ?? 0) & 0xff);
      const sp = def ? summonSpell.get(def.key) ?? null : null;
      let a = allies.get(v.id);
      if (!a) {
        a = { aura: 0, seen: 0 };
        allies.set(v.id, a);
        if (sp) spellFx.summonAppear(sp, v.x, v.y, v.z);
      }
      a.seen = frame.n;
      a.aura -= delta;
      if (a.aura <= 0 && sp) {
        a.aura = 0.25;
        spellFx.summonAura(sp, v.x, v.y, v.z, def?.size ?? 1);
      }
    }
    for (const [id, a] of allies) if (a.seen !== frame.n) allies.delete(id);

    // Telegraph decals: brighten through the wind-up, then go.
    for (let i = live.length - 1; i >= 0; i--) {
      const l = live[i];
      if (now >= l.until) {
        root.remove(l.obj);
        const m = l.obj.material as THREE.Material;
        m.dispose();
        if (l.obj.geometry !== disc) l.obj.geometry.dispose();
        live.splice(i, 1);
        continue;
      }
      const k = Math.min(1, (now - l.fx.at) / Math.max(1, l.fx.windupMs));
      (l.obj.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.45 * k;
    }

    numbers.update(camera, gl, now);
  });

  return (
    <>
      <Weapon />
      <SpellFxLayer />
    </>
  );
}

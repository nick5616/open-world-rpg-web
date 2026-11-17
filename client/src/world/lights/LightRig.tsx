// Torches and familiar lights in the world (playtest 3, CR 042).
//
// One component, mounted with the networked world. It
//   - listens for Event 1840 / 1841 (your light, as the zone says it) and the
//     torch key (8: Interact 160), the familiar spells being ordinary casts;
//   - gathers every lit source: your torch (first-person hand or third-person
//     body), your familiar, and the torches and familiars the snapshots say other
//     players carry (RemoteView.light -> Avatar.light);
//   - draws the familiars (familiarModels.ts: spinning icicle, ember mote, ...)
//     following their owners over the right shoulder, and every source's glow
//     (additive halos, no lights needed: that is the "emissive for the rest");
//   - hands the pooled point lights to the sources that matter most (lightPool.ts).
//
// The pool is fixed: its lights are created with the rig, before the world's
// shader warm-up (world/warmup.ts), stay in the scene for good and only change
// intensity, colour, position and reach. Nothing here adds or removes a three.js
// light in play, so no lit material ever recompiles. The pool is small on low
// tiers (poolSizeFor). Flames flicker gently (flicker.ts), magic breathes; with
// "Reduce flashing" the swing is smaller still.

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { localPlayer, view } from '../../state/live';
import { liveAvatars, SELF_AVATAR } from '../../net/avatar';
import type { ZoneSession } from '../../net/zoneSession';
import { QUALITY_PRESETS, useQualityStore } from '../../stores/qualityStore';
import { useAccessibility } from '../../stores/accessibility';
import { notGameKey } from '../../input/useKeyboard';
import { DEBUG } from '../../config';
import { familiarById, TORCH, unpackLight, type FamiliarDef } from './familiars';
import { makeFamiliarVisual, type FamiliarVisual } from './familiarModels';
import { breathe, flameFlicker, flickerSwing } from './flicker';
import { poolSizeFor, rank, type LightSource } from './lightPool';
import { applyLightEvent, INTERACT_LIGHT, LIGHT_ACT, resetLights, useLights } from './lightStore';
import { torchAnchors, type TorchModel } from './torchModel';

/** The torch key (every letter is taken; 8 sits by the steed and pet keys 5-7). */
export const TORCH_KEY = 'Digit8';

/** Familiars hover here, relative to their owner's feet and facing: over the right shoulder. */
const SHOULDER = { right: 0.62, up: 1.95, back: 0.1 };
/** Your own, seen from inside your head: ahead and to the right, a little above the eye, so it is in view (not behind the lens). */
const SHOULDER_FP = { right: 0.75, up: 1.98, back: -0.95 };
const MAX_SOURCES = 24;

interface Floater {
  def: FamiliarDef;
  vis: FamiliarVisual;
  pos: THREE.Vector3;
  init: boolean;
  seen: boolean;
  seed: number;
}

interface Slot {
  light: THREE.PointLight;
  key: string;
  cur: number;
}

const tmp = new THREE.Vector3();
const fwd = new THREE.Vector3();

export function LightRig({ session }: { session: ZoneSession }) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const rig = useMemo(() => {
    const tier = useQualityStore.getState().shaderTier;
    const n = poolSizeFor(QUALITY_PRESETS[tier].maxLights);
    const root = new THREE.Group();
    root.name = 'light-rig';
    const slots: Slot[] = Array.from({ length: n }, () => {
      const l = new THREE.PointLight('#ffffff', 0, 16, 1.7); // decay 1.7: a candle-warm falloff that reaches farther than inverse-square
      l.castShadow = false;
      root.add(l);
      return { light: l, key: '', cur: 0 };
    });
    const pool: LightSource[] = Array.from({ length: MAX_SOURCES }, () => ({ key: '', x: 0, y: 0, z: 0, color: '#ffffff', intensity: 0, range: 10, priority: 1, d2: 0, seed: 0, flame: false }));
    return { root, slots, pool, used: 0, ranked: [] as LightSource[], floaters: new Map<string, Floater>(), flatSources: [] as LightSource[] };
  }, []);

  useEffect(() => {
    scene.add(rig.root);
    return () => {
      scene.remove(rig.root);
      for (const f of rig.floaters.values()) f.vis.dispose();
      rig.floaters.clear();
    };
  }, [scene, rig]);

  // Headless captures (debug builds): the pool's slots and how many three.js lights the scene holds.
  useEffect(() => {
    if (!DEBUG || typeof window === 'undefined') return;
    (window as unknown as { __lodestoneLights?: unknown }).__lodestoneLights = () => {
      let lights = 0;
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++;
      });
      return { slots: rig.slots.map((s) => ({ key: s.key, intensity: +s.light.intensity.toFixed(2) })), lights, floaters: rig.floaters.size };
    };
  }, [scene, rig]);

  // Your light, from the zone.
  useEffect(() => {
    const l = (e: Parameters<typeof applyLightEvent>[0]) => {
      applyLightEvent(e);
    };
    session.eventListeners.add(l);
    session.sendInteract(INTERACT_LIGHT, 0n, LIGHT_ACT.send);
    return () => {
      session.eventListeners.delete(l);
      resetLights();
    };
  }, [session]);

  // The torch key.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== TORCH_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || notGameKey(e)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      session.sendInteract(INTERACT_LIGHT, 0n, LIGHT_ACT.torch);
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [session]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const t = state.clock.elapsedTime;
    const swing = flickerSwing(useAccessibility.getState().reduceFlashing);
    const own = useLights.getState();
    let n = 0;
    const add = (key: string, x: number, y: number, z: number, color: string, intensity: number, range: number, priority: number, seed: number, flame: boolean): LightSource => {
      const s = rig.pool[n++];
      s.key = key;
      s.x = x;
      s.y = y;
      s.z = z;
      s.color = color;
      s.intensity = intensity;
      s.range = range;
      s.priority = priority;
      s.seed = seed;
      s.flame = flame;
      return s;
    };
    for (const f of rig.floaters.values()) f.seen = false;

    const torchAt = (torch: TorchModel | null, fallback: THREE.Vector3, seed: number): THREE.Vector3 => {
      if (!torch) return fallback;
      torch.flame.getWorldPosition(tmp);
      const f = flameFlicker(t, seed, swing);
      const k = swing > 0 ? (f - 1) / swing : 0; // -1..1
      torch.flame.scale.set(1 - 0.08 * k, 1 + 0.16 * k, 1);
      torch.flame.rotation.z = Math.sin(t * 2.7 + seed) * 0.06;
      (torch.halo.material as THREE.SpriteMaterial).opacity = 0.42 + 0.1 * k;
      return tmp;
    };
    const float = (id: string, def: FamiliarDef, ox: number, oy: number, oz: number, yaw: number, priority: number, seed: number, off = SHOULDER) => {
      let f = rig.floaters.get(id);
      if (f && f.def.id !== def.id) {
        rig.root.remove(f.vis.group);
        f.vis.dispose();
        rig.floaters.delete(id);
        f = undefined;
      }
      if (!f) {
        const vis = makeFamiliarVisual(def);
        rig.root.add(vis.group);
        f = { def, vis, pos: new THREE.Vector3(), init: false, seen: true, seed };
        rig.floaters.set(id, f);
      }
      f.seen = true;
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      // over the right shoulder (right = (cos yaw, 0, -sin yaw)), bobbing
      const bob = Math.sin(t * 1.4 + seed) * 0.07;
      const tx = ox + cy * off.right + sy * off.back;
      const ty = oy + off.up + bob;
      const tz = oz - sy * off.right + cy * off.back;
      if (!f.init) {
        f.pos.set(tx, ty, tz);
        f.init = true;
      }
      const k = 1 - Math.exp(-dt * 5); // a little lag: it trails the owner
      f.pos.x += (tx - f.pos.x) * k;
      f.pos.y += (ty - f.pos.y) * k;
      f.pos.z += (tz - f.pos.z) * k;
      if (f.pos.distanceToSquared(tmp.set(tx, ty, tz)) > 36) f.pos.set(tx, ty, tz); // a teleport: no long glide
      f.vis.group.position.copy(f.pos);
      f.vis.tick(t, dt);
      const breath = breathe(t, seed, swing > 0.05 ? 0.1 : 0.04);
      f.vis.halo.material.opacity = 0.5 * breath;
      add(`${id}`, f.pos.x, f.pos.y, f.pos.z, def.color, def.intensity * breath, def.range, priority, seed, false);
    };

    // ---- yours
    const third = view.third && !view.hideBody;
    const selfAv = liveAvatars.get(SELF_AVATAR);
    if (own.torch) {
      const model = third && selfAv ? selfAv.activeTorch() : torchAnchors.fp;
      const fb = tmp.set(view.eye.x, view.eye.y - 0.3, view.eye.z);
      const p = torchAt(model, fb, 1.3);
      const f = flameFlicker(t, 1.3, swing);
      let lx = p.x;
      let ly = p.y;
      let lz = p.z;
      if (!third) {
        // In first person the flame is half a metre from the lens: lit from there it would blow out the sword and the
        // hand in front of it. The light sits a step ahead of the flame instead, so the world takes it, not the view model.
        camera.getWorldDirection(fwd);
        lx += fwd.x * 0.7;
        ly += 0.15 + fwd.y * 0.7;
        lz += fwd.z * 0.7;
      }
      add('self:torch', lx, ly, lz, TORCH.color, TORCH.intensity * f, TORCH.range, 0, 1.3, true);
    }
    const ownFam = own.familiar ? familiarById(own.familiar) : undefined;
    if (ownFam) float('self:familiar', ownFam, view.feet.x, view.feet.y, view.feet.z, localPlayer.yaw, 0, 0.7, third ? SHOULDER : SHOULDER_FP);

    // ---- everyone else's
    for (const [id, a] of liveAvatars) {
      if (id === SELF_AVATAR || id < 0 || a.light === 0 || n >= MAX_SOURCES - 2) continue;
      const l = unpackLight(a.light);
      if (l.torch) {
        const fb = tmp.set(a.root.position.x, a.root.position.y + 1.25, a.root.position.z);
        const p = torchAt(a.activeTorch(), fb, id * 0.37);
        add(`${id}:torch`, p.x, p.y, p.z, TORCH.color, TORCH.intensity * flameFlicker(t, id * 0.37, swing), TORCH.range, 1, id * 0.37, true);
      }
      const fam = l.familiar ? familiarById(l.familiar) : undefined;
      if (fam) float(`${id}:familiar`, fam, a.root.position.x, a.root.position.y, a.root.position.z, a.root.rotation.y, 1, id * 0.61);
    }
    for (const [key, f] of rig.floaters) {
      if (!f.seen) {
        rig.root.remove(f.vis.group);
        f.vis.dispose();
        rig.floaters.delete(key);
      }
    }
    rig.used = n;

    // ---- the pooled lights go to the sources that matter most
    const all = rig.flatSources;
    all.length = 0;
    for (let i = 0; i < n; i++) all.push(rig.pool[i]);
    const ranked = rank(all, rig.slots.length, camera.position.x, camera.position.y, camera.position.z, rig.ranked);
    const ease = 1 - Math.exp(-dt * 9);
    for (let i = 0; i < rig.slots.length; i++) {
      const slot = rig.slots[i];
      const src = ranked[i];
      if (src) {
        if (slot.key !== src.key) {
          slot.key = src.key; // a new owner of this slot fades in from nothing
          slot.cur = 0;
        }
        // A light within 3 m of the lens is dimmed (down to 40%): inverse-falloff would blow out the view model and the
        // faces of whoever stands next to the bearer; the halo glow still shows in full.
        const dc = Math.sqrt(src.d2);
        const near = dc < 3 ? 0.4 + 0.6 * (dc / 3) : 1;
        slot.cur += (src.intensity * near - slot.cur) * ease;
        slot.light.color.set(src.color);
        slot.light.position.set(src.x, src.y, src.z);
        slot.light.distance = src.range;
        slot.light.intensity = slot.cur;
      } else if (slot.cur > 0) {
        slot.cur *= 1 - ease;
        if (slot.cur < 0.05) {
          slot.cur = 0;
          slot.key = '';
        }
        slot.light.intensity = slot.cur;
      }
    }
  });

  return null;
}


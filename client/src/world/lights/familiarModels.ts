// The look of each familiar light (CR 042). One school, one creature of light:
//
//   icicle    (Frost)     a slowly spinning glowing icicle with two shards circling it
//   ember     (Fire)      a hovering brazier mote: a hot core in a ragged ember shell, sparks rising
//   lantern   (Shadow)    a small cage lantern with a dim violet flame inside
//   fireflies (Nature)    a loose drift of six fireflies that blink softly
//   orb       (Lightning) a pale ball held by three slow crackling rings (smooth, never a strobe)
//   zephyr    (Wind)      a bright core wrapped by three turning ribbons of air
//   wisp      (Light)     a radiant wisp: a core, a slowly turning star and a short tail
//   lamp      (Void)      a black sphere ringed in cold light, with three stars circling it
//
// Everything is unlit (MeshBasicMaterial) or an additive sprite, so one program
// serves them all, plus the pooled point light the LightRig gives the nearest
// ones. Geometry is built once and shared; each familiar owns a Group, its
// materials (tinted by the spell's colour) and a `tick(t)` that animates it.

import * as THREE from 'three';
import { glowMaterial, haloTexture, starTexture } from './glowTextures';
import type { FamiliarDef } from './familiars';

export interface FamiliarVisual {
  group: THREE.Group;
  /** Sprite halo: its opacity is breathed by the rig. */
  halo: THREE.Sprite;
  /** Animate at `t` seconds (the camera is passed for billboard-ish parts). */
  tick(t: number, dt: number): void;
  dispose(): void;
}

const geos = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geos.get(key);
  if (!g) geos.set(key, (g = make()));
  return g;
}

interface Owned {
  mats: THREE.Material[];
}

function basic(owned: Owned, color: THREE.ColorRepresentation, opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false, ...opts });
  owned.mats.push(m);
  return m;
}

function sprite(owned: Owned, tex: THREE.Texture, color: THREE.ColorRepresentation, opacity: number, size: number): THREE.Sprite {
  const m = glowMaterial(tex, color, opacity);
  owned.mats.push(m);
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  s.renderOrder = 5;
  return s;
}

const mesh = (g: THREE.BufferGeometry, m: THREE.Material) => {
  const x = new THREE.Mesh(g, m);
  x.frustumCulled = false;
  return x;
};

export function makeFamiliarVisual(def: FamiliarDef): FamiliarVisual {
  const owned: Owned = { mats: [] };
  const group = new THREE.Group();
  group.name = `familiar-${def.kind}`;
  const col = new THREE.Color(def.color);
  const hot = col.clone().lerp(new THREE.Color('#ffffff'), 0.7);
  const halo = sprite(owned, haloTexture(), col, 0.55, 1.5);
  group.add(halo);
  let tick: (t: number, dt: number) => void = () => undefined;

  switch (def.kind) {
    case 'icicle': {
      const prof = [new THREE.Vector2(0, -0.2), new THREE.Vector2(0.045, -0.02), new THREE.Vector2(0.04, 0.07), new THREE.Vector2(0, 0.13)];
      const body = mesh(geo('icicle', () => new THREE.LatheGeometry(prof, 6)), basic(owned, hot));
      const sheath = mesh(geo('icicle2', () => new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p.x * 1.5, p.y * 1.12)), 6)), basic(owned, col, { transparent: true, opacity: 0.4, depthWrite: false }));
      const spin = new THREE.Group();
      spin.add(body, sheath);
      spin.rotation.z = 0.35;
      const shards = [0, 1].map((i) => {
        const s = mesh(geo('shard', () => new THREE.OctahedronGeometry(0.03, 0).scale(0.6, 1.4, 0.6)), basic(owned, hot));
        s.userData.phase = i * Math.PI;
        group.add(s);
        return s;
      });
      group.add(spin);
      tick = (t) => {
        spin.rotation.y = t * 0.9; // slow
        for (const s of shards) {
          const a = t * 1.3 + (s.userData.phase as number);
          s.position.set(Math.cos(a) * 0.17, Math.sin(a * 0.7) * 0.05 + 0.02, Math.sin(a) * 0.17);
          s.rotation.y = a;
        }
      };
      break;
    }
    case 'ember': {
      const core = mesh(geo('ember-core', () => new THREE.IcosahedronGeometry(0.055, 0)), basic(owned, hot));
      const shell = mesh(geo('ember-shell', () => new THREE.IcosahedronGeometry(0.1, 0)), basic(owned, col, { transparent: true, opacity: 0.45, depthWrite: false }));
      group.add(core, shell);
      const sparks = [0, 1, 2, 3].map((i) => {
        const s = mesh(geo('spark', () => new THREE.IcosahedronGeometry(0.014, 0)), basic(owned, hot));
        s.userData.phase = i / 4;
        group.add(s);
        return s;
      });
      tick = (t) => {
        core.rotation.set(t * 0.8, t * 1.1, 0);
        shell.rotation.set(-t * 0.5, t * 0.7, t * 0.3);
        shell.scale.setScalar(1 + 0.06 * Math.sin(t * 2.1));
        for (const s of sparks) {
          const u = (t * 0.45 + (s.userData.phase as number)) % 1; // rising and fading
          s.position.set(Math.sin(u * 7 + (s.userData.phase as number) * 6) * 0.07, 0.04 + u * 0.28, Math.cos(u * 6 + (s.userData.phase as number) * 5) * 0.07);
          s.scale.setScalar(1 - u * 0.8);
        }
      };
      break;
    }
    case 'lantern': {
      const frameMat = basic(owned, '#17121f');
      const cap = geo('lantern-cap', () => new THREE.CylinderGeometry(0.05, 0.07, 0.025, 6));
      const bar = geo('lantern-bar', () => new THREE.CylinderGeometry(0.006, 0.006, 0.15, 4));
      const top = mesh(cap, frameMat);
      top.position.y = 0.085;
      const bot = mesh(cap, frameMat);
      bot.position.y = -0.085;
      bot.scale.y = -1;
      const glass = mesh(geo('lantern-glass', () => new THREE.CylinderGeometry(0.055, 0.065, 0.15, 6, 1, true)), basic(owned, col, { transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      const flame = mesh(geo('lantern-flame', () => new THREE.OctahedronGeometry(0.04, 0).scale(0.8, 1.4, 0.8)), basic(owned, hot));
      const ring = mesh(geo('lantern-ring', () => new THREE.TorusGeometry(0.03, 0.005, 4, 10)), frameMat);
      ring.position.y = 0.115;
      group.add(top, bot, glass, flame, ring);
      for (let i = 0; i < 6; i++) {
        const b = mesh(bar, frameMat);
        const a = (i / 6) * Math.PI * 2;
        b.position.set(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06);
        group.add(b);
      }
      halo.material.opacity = 0.4;
      tick = (t) => {
        flame.scale.set(1, 1 + 0.12 * Math.sin(t * 3.1), 1);
        group.rotation.y = Math.sin(t * 0.6) * 0.5; // the lantern sways on its invisible hook
        group.rotation.z = Math.sin(t * 0.8 + 1) * 0.06;
      };
      break;
    }
    case 'fireflies': {
      const flies = Array.from({ length: 6 }, (_, i) => {
        const s = sprite(owned, haloTexture(), col, 0.9, 0.11);
        s.userData.seed = i * 1.37 + 0.4;
        group.add(s);
        const dot = mesh(geo('fly', () => new THREE.IcosahedronGeometry(0.012, 0)), basic(owned, hot));
        s.add(dot);
        dot.scale.setScalar(1 / 0.11);
        return s;
      });
      halo.material.opacity = 0.35;
      tick = (t) => {
        for (const s of flies) {
          const k = s.userData.seed as number;
          s.position.set(Math.sin(t * 0.7 + k * 3.1) * 0.24, Math.sin(t * 1.1 + k * 2.3) * 0.16, Math.cos(t * 0.6 + k * 1.9) * 0.24);
          const blink = 0.5 + 0.5 * Math.sin(t * (1.4 + (k % 0.6)) + k * 5); // soft, 0.2-0.4 Hz fades
          (s.material as THREE.SpriteMaterial).opacity = 0.25 + 0.7 * blink * blink;
        }
      };
      break;
    }
    case 'orb': {
      const core = mesh(geo('orb-core', () => new THREE.SphereGeometry(0.075, 12, 8)), basic(owned, hot));
      const cage = mesh(geo('orb-cage', () => new THREE.IcosahedronGeometry(0.115, 1)), basic(owned, col, { wireframe: true, transparent: true, opacity: 0.45, depthWrite: false }));
      group.add(core, cage);
      const ringGeo = geo('orb-ring', () => new THREE.TorusGeometry(0.15, 0.006, 4, 28, Math.PI * 1.4));
      const rings = [0, 1, 2].map((i) => {
        const r = mesh(ringGeo, basic(owned, hot, { transparent: true, opacity: 0.6, depthWrite: false }));
        r.userData.i = i;
        group.add(r);
        return r;
      });
      tick = (t) => {
        cage.rotation.set(t * 0.4, t * 0.6, 0);
        for (const r of rings) {
          const i = r.userData.i as number;
          r.rotation.set(t * (0.9 + i * 0.35) + i * 2, t * (0.7 - i * 0.2) + i, i * 1.1);
          (r.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.7 + i * 2.1)); // a crackle that swells, not a flash
        }
        core.scale.setScalar(1 + 0.05 * Math.sin(t * 2.6));
      };
      break;
    }
    case 'zephyr': {
      const core = mesh(geo('zeph-core', () => new THREE.SphereGeometry(0.05, 10, 8)), basic(owned, hot));
      group.add(core);
      const arc = geo('zeph-arc', () => new THREE.TorusGeometry(0.13, 0.009, 4, 20, Math.PI * 1.15));
      const ribbons = [0, 1, 2].map((i) => {
        const r = mesh(arc, basic(owned, col, { transparent: true, opacity: 0.7, depthWrite: false }));
        r.userData.i = i;
        r.rotation.x = Math.PI / 2 + (i - 1) * 0.5;
        const holder = new THREE.Group();
        holder.add(r);
        holder.userData.i = i;
        group.add(holder);
        return holder;
      });
      tick = (t) => {
        for (const h of ribbons) {
          const i = h.userData.i as number;
          h.rotation.y = t * (1.6 + i * 0.5) + i * 2.1;
          h.rotation.z = Math.sin(t * 0.7 + i) * 0.3;
          h.scale.setScalar(0.85 + 0.2 * i + 0.06 * Math.sin(t * 1.3 + i));
        }
      };
      break;
    }
    case 'wisp': {
      const core = mesh(geo('wisp-core', () => new THREE.SphereGeometry(0.06, 10, 8)), basic(owned, hot));
      const rays = sprite(owned, starTexture(), hot, 0.8, 0.7);
      group.add(core, rays);
      const tail = [0, 1, 2, 3].map((i) => {
        const s = sprite(owned, haloTexture(), col, 0.6 - i * 0.12, 0.2 - i * 0.03);
        s.userData.i = i + 1;
        group.add(s);
        return s;
      });
      tick = (t) => {
        (rays.material as THREE.SpriteMaterial).rotation = t * 0.35;
        rays.scale.setScalar(0.62 + 0.08 * Math.sin(t * 1.8));
        for (const s of tail) {
          const i = s.userData.i as number;
          s.position.set(Math.sin(t * 1.5 - i * 0.6) * 0.04, -0.05 * i - 0.04 * i * Math.sin(t * 1.2 - i), Math.cos(t * 1.5 - i * 0.6) * 0.04);
        }
      };
      break;
    }
    case 'lamp': {
      const dark = mesh(geo('lamp-core', () => new THREE.SphereGeometry(0.075, 14, 10)), basic(owned, '#05020a'));
      const ring = mesh(geo('lamp-ring', () => new THREE.TorusGeometry(0.115, 0.009, 6, 32)), basic(owned, hot));
      ring.rotation.x = 1.2;
      const ring2 = mesh(geo('lamp-ring2', () => new THREE.TorusGeometry(0.095, 0.005, 4, 28)), basic(owned, col, { transparent: true, opacity: 0.7, depthWrite: false }));
      group.add(dark, ring, ring2);
      const stars = [0, 1, 2].map((i) => {
        const s = mesh(geo('lamp-star', () => new THREE.OctahedronGeometry(0.014, 0)), basic(owned, hot));
        s.userData.i = i;
        group.add(s);
        return s;
      });
      halo.material.opacity = 0.4;
      tick = (t) => {
        ring.rotation.z = t * 0.5;
        ring2.rotation.set(-0.6, t * 0.7, 0.3);
        for (const s of stars) {
          const a = t * 0.9 + (s.userData.i as number) * 2.09;
          s.position.set(Math.cos(a) * 0.2, Math.sin(a * 1.3) * 0.08, Math.sin(a) * 0.2);
        }
      };
      break;
    }
    default: {
      group.add(mesh(geo('plain', () => new THREE.SphereGeometry(0.06, 10, 8)), basic(owned, hot)));
    }
  }
  return {
    group,
    halo,
    tick,
    dispose() {
      for (const m of owned.mats) m.dispose();
    },
  };
}

/** Program variants of the familiar visuals, for the shader warm-up (world/warmup.ts). */
export function familiarWarmObjects(): THREE.Object3D[] {
  const owned: Owned = { mats: [] };
  const out: THREE.Object3D[] = [
    new THREE.Mesh(geo('warm', () => new THREE.SphereGeometry(0.05, 6, 4)), basic(owned, '#ffffff')),
    new THREE.Mesh(geo('warm', () => new THREE.SphereGeometry(0.05, 6, 4)), basic(owned, '#ffffff', { transparent: true, opacity: 0.5, depthWrite: false })),
    new THREE.Mesh(geo('warm', () => new THREE.SphereGeometry(0.05, 6, 4)), basic(owned, '#ffffff', { wireframe: true, transparent: true, opacity: 0.5, depthWrite: false })),
    new THREE.Mesh(geo('warm', () => new THREE.SphereGeometry(0.05, 6, 4)), basic(owned, '#ffffff', { side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false })),
    sprite(owned, haloTexture(), '#ffffff', 0.5, 1),
  ];
  return out;
}

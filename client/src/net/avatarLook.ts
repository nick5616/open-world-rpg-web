// Geometry and materials for the creation options (look.ts): hair styles,
// beards, eyes, skin tones. Shared by every avatar (built once per option,
// never disposed: a few small buffers). All in the head frame of avatar.ts:
// centred on the skull, facing -Z, the skull ~0.2 m radius.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDS, EYE_COLORS, HAIR_COLORS, SKIN_TONES, type Look } from './look';

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
    return n;
  });
  const out = mergeGeometries(flat, false)!;
  for (const g of [...parts, ...flat]) if (g !== out) g.dispose();
  return out;
}

const PI = Math.PI;
const sphere = (r: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
  const g = new THREE.SphereGeometry(r, 10, 7);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
};
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
};

const cap = (r: number, theta: number) => new THREE.SphereGeometry(r, 14, 7, 0, PI * 2, 0, PI * theta);

const hairCache = new Map<number, THREE.BufferGeometry | null>();
/** Hair geometry of a style (0 bald = null). Style 2 is the original swept cap, drawn by avatar.ts's own hairGeometry. */
export function hairStyleGeometry(style: number, original: THREE.BufferGeometry): THREE.BufferGeometry | null {
  if (style === 0) return null;
  if (style === 2) return original;
  if (hairCache.has(style)) return hairCache.get(style)!;
  let g: THREE.BufferGeometry;
  switch (style) {
    case 1: // cropped: a close cap
      g = merge([cap(0.207, 0.33)]);
      g.scale(0.97, 1.04, 1.01);
      break;
    case 3: // long: the cap, a curtain down the back and over the shoulders' tops
      g = merge([cap(0.214, 0.4), sphere(0.2, 0, -0.17, 0.085, 1.06, 1.9, 0.62), sphere(0.15, 0.17, -0.05, 0.02, 0.4, 1.2, 0.8), sphere(0.15, -0.17, -0.05, 0.02, 0.4, 1.2, 0.8)]);
      break;
    case 4: // topknot: close sides, a bun
      g = merge([cap(0.207, 0.33), sphere(0.075, 0, 0.245, 0.03), sphere(0.04, 0, 0.205, 0.03, 1.4, 0.6, 1.4)]);
      break;
    default: {
      // mohawk: a crest of blades from brow to nape over a shaved scalp
      const parts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 9; i++) {
        const a = (-0.62 + (i / 8) * 1.55) * PI; // brow (front, -Z) over the crown to the nape
        const h = 0.075 + 0.035 * Math.sin((i / 8) * PI);
        const b = new THREE.BoxGeometry(0.045, h, 0.07);
        b.translate(0, 0.205 + h / 2 - 0.02, 0);
        b.rotateX(a * 0.62);
        parts.push(b);
      }
      g = merge(parts);
    }
  }
  hairCache.set(style, g);
  return g;
}

const beardCache = new Map<number, THREE.BufferGeometry | null>();
/** Beard geometry (0 none = null), in the hair's colour. */
export function beardGeometry(style: number): THREE.BufferGeometry | null {
  if (style === 0) return null;
  const hit = beardCache.get(style);
  if (hit) return hit;
  // front-lower arc of the skull: phi 1.12..1.88 pi faces -Z, theta below the mouth
  const jaw = (r: number, t0: number, t1: number, phiPad = 0.12) => new THREE.SphereGeometry(r, 14, 6, PI * (1 + phiPad), PI * (1 - 2 * phiPad), PI * t0, PI * (t1 - t0));
  const stache = (w: number) => box(w, 0.024, 0.034, 0, -0.062, -0.2);
  let parts: THREE.BufferGeometry[];
  switch (style) {
    case 1: // stubble: a thin shell
      parts = [jaw(0.203, 0.6, 0.86, 0.08)];
      break;
    case 2: // short
      parts = [jaw(0.212, 0.62, 0.9, 0.06), stache(0.12)];
      break;
    case 3: // full
      parts = [jaw(0.222, 0.58, 0.96, 0.02), stache(0.15), sphere(0.085, 0, -0.2, -0.13, 1.5, 1.5, 1)];
      break;
    default: // braided: a full beard with a plait hanging from the chin
      parts = [jaw(0.222, 0.58, 0.96, 0.02), stache(0.15), sphere(0.07, 0, -0.2, -0.13, 1.3, 1.2, 1)];
      for (let i = 0; i < 5; i++) parts.push(sphere(0.035 - i * 0.003, 0, -0.27 - i * 0.055, -0.15, 1, 1.15, 1));
  }
  const g = merge(parts);
  g.scale(0.95, 1.04, 1);
  beardCache.set(style, g);
  return g;
}

let irisGeo: THREE.BufferGeometry | null = null;
/** Two irises just in front of the face's eyes (avatar.ts faceGeometry: ±0.068, 0.035, -0.178). */
export function irisGeometry(): THREE.BufferGeometry {
  if (!irisGeo) irisGeo = merge([-1, 1].map((s) => sphere(0.0165, s * 0.068, 0.035, -0.186, 1, 1.25, 0.5)));
  return irisGeo;
}

const mats = new Map<string, THREE.MeshStandardMaterial>();
function cached(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = mats.get(key);
  if (!m) mats.set(key, (m = make()));
  return m;
}
export const skinMaterial = (i: number) => cached(`s${i}`, () => new THREE.MeshStandardMaterial({ color: SKIN_TONES[i], roughness: 0.7 }));
export const hairMaterial = (i: number) => cached(`h${i}`, () => new THREE.MeshStandardMaterial({ color: HAIR_COLORS[i], roughness: 0.9 }));
export const eyeMaterial = (i: number) => cached(`e${i}`, () => new THREE.MeshStandardMaterial({ color: EYE_COLORS[i], roughness: 0.35, emissive: EYE_COLORS[i], emissiveIntensity: 0.25 }));

/** The whole-figure scale of a build. */
export function buildScale(look: Look): { sx: number; sy: number } {
  return BUILDS[look.build] ?? BUILDS[1];
}

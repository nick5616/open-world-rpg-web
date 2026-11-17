// Gear parts for the townsfolk renderer (playtest 4, CR 050). One instanced
// mesh holds every variant of a kind of dress (all the hair styles, hats,
// hoods and beards; all the vests and aprons and skirts; every held prop):
// each vertex carries which piece it belongs to (`aGear`, a bit index, -1
// always shown) and which of three colours it takes (`aSlot`: the instance
// colour, `aC1`, `aC2`), and each instance a bitmask of the pieces it wears
// (`aShow`). The vertex shader collapses the pieces an instance does not
// wear, so a hundred villagers with a hundred different looks still cost one
// draw call per kind, not one per hair style.
//
// Chosen over one mesh per style because the town budget is draw calls
// (docs/STATUS.md WP20: 400): the old renderer spent 11 draws on the NPCs,
// this one 9 with a lot more to look at.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { A, H, PROP, T } from './npcLife';

export const NPC_MAX = 96;

type G = THREE.BufferGeometry;
export const boxG = (w: number, h: number, d: number, x: number, y: number, z: number): G => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
export const cylG = (rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number): G => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);

/** Collects pieces (geometry + bit + colour slot) into one geometry. */
export class GearBuilder {
  private readonly parts: G[] = [];
  /** `bit` -1: always shown. `slot` 0 instance colour, 1 aC1, 2 aC2. */
  add(g: G, bit: number, slot: number): this {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute('uv');
    const n = ng.getAttribute('position').count;
    ng.setAttribute('aGear', new THREE.BufferAttribute(new Float32Array(n).fill(bit), 1));
    ng.setAttribute('aSlot', new THREE.BufferAttribute(new Float32Array(n).fill(slot), 1));
    this.parts.push(ng);
    if (ng !== g) g.dispose();
    return this;
  }

  build(name: string, max = NPC_MAX): GearMesh {
    const geo = mergeGeometries(this.parts, false)!;
    this.parts.forEach((p) => p.dispose());
    return new GearMesh(geo, name, max);
  }
}

/** A mask test usable on the CPU too (the shader does the same arithmetic). */
export const shown = (mask: number, bit: number): boolean => bit < 0 || (mask >> bit) % 2 === 1;

export class GearMesh extends THREE.InstancedMesh {
  readonly show: THREE.InstancedBufferAttribute;
  readonly c1: THREE.InstancedBufferAttribute;
  readonly c2: THREE.InstancedBufferAttribute;

  constructor(geo: G, name: string, max: number) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGear;\nattribute float aSlot;\nattribute float aShow;\nattribute vec3 aC1;\nattribute vec3 aC2;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
#ifdef USE_INSTANCING_COLOR
  vColor.xyz = aSlot < 0.5 ? instanceColor.xyz : (aSlot < 1.5 ? aC1 : aC2);
#endif`,
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
  if (aGear > -0.5 && mod(floor(aShow / exp2(aGear) + 0.01), 2.0) < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`,
        );
    };
    mat.customProgramCacheKey = () => 'npc-gear';
    super(geo, mat, max);
    this.show = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    this.c1 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.c2 = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.show, this.c1, this.c2]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aShow', this.show);
    geo.setAttribute('aC1', this.c1);
    geo.setAttribute('aC2', this.c2);
    this.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.count = 0;
    this.name = name;
    this.castShadow = false;
    this.receiveShadow = true;
    this.frustumCulled = false;
  }

  /** Sets instance i: matrix, bitmask and the three colours. */
  put(i: number, m: THREE.Matrix4, mask: number, c0: THREE.Color, c1: THREE.Color, c2: THREE.Color): void {
    this.setMatrixAt(i, m);
    this.show.setX(i, mask);
    this.setColorAt(i, c0);
    this.c1.setXYZ(i, c1.r, c1.g, c1.b);
    this.c2.setXYZ(i, c2.r, c2.g, c2.b);
  }

  finish(n: number): void {
    this.count = n;
    this.visible = n > 0;
    this.instanceMatrix.needsUpdate = true;
    this.show.needsUpdate = true;
    this.c1.needsUpdate = true;
    this.c2.needsUpdate = true;
    if (this.instanceColor) this.instanceColor.needsUpdate = true;
  }
}

// ---- Geometries --------------------------------------------------------------
// The model faces +x; y up; z is its width. Head box: 0.24 x 0.27 x 0.22 centred (0, 1.66, 0).

/** Rotate a geometry about z (handle direction in hand space). */
const rz = (g: G, a: number): G => g.rotateZ(a);

/** Faces: eyes (open/closed), brows, mouth (closed/open). Every piece is the face colour. */
export const F = { eyeOpen: 0, eyeShut: 1, brow: 2, mouth: 3, mouthOpen: 4 } as const;

export function buildFace(): GearMesh {
  const b = new GearBuilder();
  b.add(merge([boxG(0.02, 0.036, 0.034, 0.121, 1.695, 0.052), boxG(0.02, 0.036, 0.034, 0.121, 1.695, -0.052)]), F.eyeOpen, 0);
  b.add(merge([boxG(0.02, 0.01, 0.036, 0.121, 1.688, 0.052), boxG(0.02, 0.01, 0.036, 0.121, 1.688, -0.052)]), F.eyeShut, 0);
  b.add(merge([boxG(0.016, 0.014, 0.056, 0.123, 1.738, 0.054), boxG(0.016, 0.014, 0.056, 0.123, 1.738, -0.054)]), F.brow, 0);
  b.add(boxG(0.016, 0.012, 0.062, 0.122, 1.592, 0), F.mouth, 0);
  b.add(boxG(0.02, 0.034, 0.046, 0.121, 1.59, 0), F.mouthOpen, 0);
  return b.build('npc-face');
}

function merge(gs: G[]): G {
  const m = mergeGeometries(gs.map((x) => (x.index ? x.toNonIndexed() : x)), false)!;
  gs.forEach((x) => x.dispose());
  return m;
}

/** Hair styles, hats, hoods, scarves, beards: slot 0 = hair/beard colour, 1 = cloth colour, 2 = accent. */
export function buildHeadGear(): GearMesh {
  const b = new GearBuilder();
  // Hair.
  b.add(merge([boxG(0.27, 0.07, 0.25, -0.01, 1.81, 0), boxG(0.06, 0.22, 0.25, -0.12, 1.7, 0)]), H.short, 0);
  b.add(merge([boxG(0.27, 0.07, 0.25, -0.01, 1.81, 0), boxG(0.07, 0.5, 0.27, -0.125, 1.56, 0), boxG(0.22, 0.12, 0.04, -0.02, 1.76, 0.125), boxG(0.22, 0.12, 0.04, -0.02, 1.76, -0.125)]), H.long, 0);
  b.add(merge([boxG(0.27, 0.07, 0.25, -0.01, 1.81, 0), boxG(0.06, 0.18, 0.25, -0.12, 1.71, 0), boxG(0.13, 0.12, 0.13, -0.15, 1.82, 0)]), H.bun, 0);
  b.add(merge([boxG(0.29, 0.1, 0.28, -0.015, 1.82, 0), boxG(0.08, 0.2, 0.28, -0.13, 1.72, 0), boxG(0.1, 0.1, 0.1, 0.03, 1.87, 0.1), boxG(0.1, 0.1, 0.1, 0.03, 1.87, -0.1)]), H.curls, 0);
  b.add(merge([boxG(0.27, 0.07, 0.25, -0.01, 1.81, 0), boxG(0.06, 0.16, 0.25, -0.12, 1.72, 0), boxG(0.05, 0.4, 0.07, -0.16, 1.55, 0.02), boxG(0.07, 0.06, 0.09, -0.15, 1.73, 0.02)]), H.pony, 0);
  b.add(boxG(0.001, 0.001, 0.001, 0, 0, 0), H.bald, 0);
  // Hats: brim and crown (slot 1), a band (slot 2).
  b.add(merge([cylG(0.33, 0.33, 0.03, 12, 0, 1.79, 0), cylG(0.14, 0.16, 0.16, 8, 0, 1.87, 0)]), H.hat, 1);
  b.add(cylG(0.145, 0.15, 0.03, 8, 0, 1.845, 0), H.hat, 2);
  b.add(merge([cylG(0.15, 0.17, 0.1, 8, 0, 1.83, 0), boxG(0.12, 0.025, 0.2, 0.15, 1.8, 0)]), H.cap, 1);
  b.add(merge([cylG(0.17, 0.18, 0.06, 10, -0.005, 1.82, 0), boxG(0.1, 0.02, 0.24, 0.08, 1.84, 0)]), H.flatCap, 1);
  // Helmet with a nasal bar and a plume (accent).
  b.add(merge([cylG(0.15, 0.16, 0.14, 8, 0, 1.77, 0), cylG(0.0, 0.15, 0.12, 8, 0, 1.9, 0), boxG(0.04, 0.12, 0.04, 0.15, 1.69, 0)]), H.helm, 1);
  b.add(boxG(0.05, 0.14, 0.03, -0.02, 1.98, 0), H.helm, 2);
  // Hood: a cowl over the head and shoulders.
  b.add(merge([boxG(0.29, 0.16, 0.27, -0.015, 1.8, 0), boxG(0.1, 0.38, 0.28, -0.12, 1.66, 0), boxG(0.28, 0.07, 0.34, -0.03, 1.5, 0), boxG(0.16, 0.08, 0.04, 0.1, 1.73, 0.12), boxG(0.16, 0.08, 0.04, 0.1, 1.73, -0.12)]), H.hood, 1);
  // Headscarf: a band over the hair and a knot at the back.
  b.add(merge([boxG(0.265, 0.1, 0.245, -0.01, 1.78, 0), boxG(0.08, 0.14, 0.12, -0.15, 1.74, 0)]), H.scarf, 1);
  b.add(boxG(0.05, 0.1, 0.05, -0.18, 1.7, 0.06), H.scarf, 2);
  // Beards and moustache (hair colour).
  b.add(merge([boxG(0.08, 0.1, 0.22, 0.1, 1.575, 0), boxG(0.12, 0.05, 0.24, 0.04, 1.61, 0)]), H.beardShort, 0);
  b.add(merge([boxG(0.1, 0.2, 0.23, 0.115, 1.52, 0), boxG(0.07, 0.12, 0.17, 0.115, 1.4, 0), boxG(0.12, 0.05, 0.24, 0.04, 1.62, 0)]), H.beardFull, 0);
  b.add(merge([boxG(0.1, 0.34, 0.26, 0.135, 1.5, 0), boxG(0.08, 0.2, 0.16, 0.14, 1.28, 0), boxG(0.07, 0.07, 0.05, 0.14, 1.15, 0.03), boxG(0.07, 0.07, 0.05, 0.14, 1.15, -0.03), boxG(0.09, 0.08, 0.3, 0.12, 1.62, 0)]), H.beardDwarf, 0);
  b.add(boxG(0.05, 0.03, 0.15, 0.125, 1.615, 0), H.moustache, 0);
  return b.build('npc-headgear');
}

/** Dress: slot 0 = main colour, 1 = second, 2 = trim. Torso box 0.27 x 0.62 x 0.42 at y 1.15. */
export function buildTorsoGear(): GearMesh {
  const b = new GearBuilder();
  b.add(boxG(0.03, 0.72, 0.32, 0.15, 1.02, 0), T.apron, 0);
  b.add(boxG(0.05, 0.04, 0.34, 0.155, 1.34, 0), T.apron, 2);
  b.add(boxG(0.285, 0.48, 0.43, 0, 1.17, 0), T.vest, 1);
  b.add(boxG(0.292, 0.46, 0.04, 0, 1.17, 0), T.vest, 2);
  const skirt = new THREE.CylinderGeometry(0.2, 0.34, 0.56, 10).translate(0, 0.62, 0);
  skirt.scale(0.86, 1, 1.28);
  b.add(skirt, T.skirt, 1);
  b.add(boxG(0.3, 0.07, 0.44, 0, 1.5, 0), T.collar, 2);
  b.add(merge([boxG(0.045, 0.78, 0.3, 0.15, 1.02, 0), boxG(0.045, 0.7, 0.3, -0.15, 1.05, 0)]), T.tabard, 0);
  b.add(merge([boxG(0.05, 0.05, 0.31, 0.152, 1.35, 0), boxG(0.05, 0.05, 0.31, 0.152, 0.7, 0)]), T.tabard, 2);
  b.add(boxG(0.29, 0.06, 0.435, 0, 0.9, 0), T.belt, 2);
  b.add(merge([boxG(0.3, 0.1, 0.46, 0, 1.45, 0), boxG(0.1, 0.34, 0.46, -0.1, 1.28, 0)]), T.shawl, 1);
  return b.build('npc-dress');
}

/** Arms (hang from the shoulder): slot 0 sleeves, 1 skin, 2 bracer. */
export function buildArms(): GearMesh {
  const b = new GearBuilder();
  b.add(boxG(0.11, 0.62, 0.12, 0, -0.29, 0), -1, 1);
  b.add(boxG(0.126, 0.5, 0.138, 0, -0.22, 0), A.long, 0);
  b.add(boxG(0.126, 0.27, 0.138, 0, -0.125, 0), A.rolled, 0);
  b.add(boxG(0.134, 0.14, 0.146, 0, -0.5, 0), A.bracer, 2);
  return b.build('npc-arms', NPC_MAX * 2);
}

/**
 * Held props in the right hand's frame: the grip is the origin, the arm hangs
 * along -y, so an angle `a` below turns a long handle away from the forearm
 * (each tuned for the arm angle its pose holds; see workPose). Slot 0 handle
 * and body, 1 metal or straw, 2 trim.
 */
export function buildProps(): GearMesh {
  const b = new GearBuilder();
  // A cylinder lying along +x from x0 to x1.
  const rod = (r0: number, r1: number, x0: number, x1: number, seg = 5): G => new THREE.CylinderGeometry(r1, r0, x1 - x0, seg).rotateZ(-Math.PI / 2).translate((x0 + x1) / 2, 0, 0);
  // Hammer: wrist-bent handle, iron head.
  b.add(rz(rod(0.025, 0.022, -0.08, 0.55), -1.07), PROP.hammer, 0);
  b.add(rz(boxG(0.1, 0.1, 0.22, 0.58, 0, 0), -1.07), PROP.hammer, 1);
  // Hoe: long handle, iron blade at the end.
  b.add(rz(rod(0.025, 0.022, -0.25, 1.3), -1.1), PROP.hoe, 0);
  b.add(rz(boxG(0.04, 0.2, 0.2, 1.3, -0.08, 0), -1.1), PROP.hoe, 1);
  // Scythe: long snath, a blade sweeping inward from its end.
  b.add(rz(rod(0.025, 0.022, -0.25, 1.4), -1.45), PROP.scythe, 0);
  b.add(rz(boxG(0.07, 0.025, 0.6, 1.4, 0, -0.28), -1.45 + 0.8), PROP.scythe, 1);
  // Broom: handle up, bristles at the bottom end (-x).
  b.add(rz(rod(0.02, 0.02, -0.75, 0.3), 0.05), PROP.broom, 0);
  b.add(rz(boxG(0.34, 0.14, 0.22, -0.82, 0, 0), 0.05), PROP.broom, 1);
  // Basket (hangs from the hand) and bucket.
  b.add(rz(boxG(0.3, 0.04, 0.04, 0.15, 0, 0), -1.97), PROP.basket, 0);
  b.add(rz(new THREE.CylinderGeometry(0.17, 0.12, 0.2, 8).rotateZ(-Math.PI / 2).translate(0.38, 0, 0), -1.97), PROP.basket, 1);
  b.add(rz(boxG(0.2, 0.03, 0.03, 0.1, 0, 0), -1.67), PROP.bucket, 1);
  b.add(rz(new THREE.CylinderGeometry(0.1, 0.075, 0.22, 8).rotateZ(-Math.PI / 2).translate(0.3, 0, 0), -1.67), PROP.bucket, 0);
  // Mug.
  b.add(rz(merge([rod(0.04, 0.036, 0.0, 0.1, 7), boxG(0.04, 0.012, 0.012, 0.05, 0.04, 0)]), 0.32), PROP.mug, 0);
  b.add(rz(rod(0.038, 0.038, 0.1, 0.112, 7), 0.32), PROP.mug, 2);
  // Spear: grounded shaft, iron tip.
  b.add(rz(rod(0.025, 0.025, -0.98, 1.2), 1.45), PROP.spear, 0);
  b.add(rz(new THREE.CylinderGeometry(0, 0.06, 0.25, 4).rotateZ(-Math.PI / 2).translate(1.32, 0, 0), 1.45), PROP.spear, 1);
  // Crate held out in front.
  b.add(rz(boxG(0.3, 0.18, 0.4, 0.08, -0.08, -0.26), -1.15), PROP.crate, 0);
  b.add(rz(boxG(0.1, 0.1, 0.12, 0.2, 0.0, -0.2), -1.15), PROP.crate, 2);
  return b.build('npc-props');
}

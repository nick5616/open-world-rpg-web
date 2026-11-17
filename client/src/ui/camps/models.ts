// Low-poly procedural camp pieces (playtest 2 camps, CR 025), in the art
// direction of the towns kit: flat-shaded wood, stone and cloth, no
// textures. Each builder returns a group whose local +x is the footprint's
// width and +z its depth (front), base at y = 0; CampLayer turns it by
// -rot * 45 degrees about y (collide.ts rotCS: local x -> (cos, sin)).
// Fires get their flames and light from CampLayer (the night layer's flame
// cards), so the model is the ring, the logs and the embers.

import * as THREE from 'three';
import { PIECE } from './events';
import { pieceDef } from '../build/geometry';

const mat = (color: string, rough = 0.9, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, flatShading: true, ...extra });

export const CAMP_MAT = {
  wood: mat('#7a5634'),
  woodDark: mat('#553a22'),
  woodLight: mat('#a07a4c'),
  bark: mat('#4d3826'),
  stone: mat('#8a867a', 0.95),
  stoneDark: mat('#5f5b52', 0.95),
  iron: mat('#4a4c52', 0.5, { metalness: 0.6 }),
  cloth: mat('#c9b48a', 0.95, { side: THREE.DoubleSide }),
  clothRed: mat('#9a3b2c', 0.95, { side: THREE.DoubleSide }),
  fur: mat('#6b5a48', 1),
  ash: mat('#2a2522', 1),
  ember: new THREE.MeshStandardMaterial({ color: '#3a1a0c', emissive: new THREE.Color('#ff5a1a'), emissiveIntensity: 0, roughness: 1, flatShading: true }),
};

const G = {
  rock: new THREE.DodecahedronGeometry(0.17, 0),
  log: new THREE.CylinderGeometry(0.07, 0.08, 1.0, 6),
  post: new THREE.CylinderGeometry(0.06, 0.07, 1, 6),
  box: new THREE.BoxGeometry(1, 1, 1),
  disk: new THREE.CylinderGeometry(0.42, 0.45, 0.04, 10),
};

function box(m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const b = new THREE.Mesh(G.box, m);
  b.scale.set(w, h, d);
  b.position.set(x, y, z);
  b.castShadow = true;
  b.receiveShadow = true;
  return b;
}

function log(m: THREE.Material, len: number, x: number, y: number, z: number, rx: number, rz: number, ry = 0): THREE.Mesh {
  const l = new THREE.Mesh(G.log, m);
  l.scale.set(1, len, 1);
  l.position.set(x, y, z);
  l.rotation.set(rx, ry, rz, 'YXZ');
  l.castShadow = true;
  return l;
}

function campfire(seed: number): THREE.Group {
  const g = new THREE.Group();
  // A ring of stones.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + seed * 0.3;
    const r = new THREE.Mesh(G.rock, i % 3 ? CAMP_MAT.stone : CAMP_MAT.stoneDark);
    const s = 0.85 + ((seed * 7 + i * 13) % 5) * 0.08;
    r.scale.set(s, s * 0.75, s);
    r.position.set(Math.cos(a) * 0.62, 0.08, Math.sin(a) * 0.62);
    r.rotation.set(i, i * 2.1, 0);
    r.castShadow = true;
    g.add(r);
  }
  const ash = new THREE.Mesh(G.disk, CAMP_MAT.ash);
  ash.position.y = 0.02;
  g.add(ash);
  const ember = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.05, 8), CAMP_MAT.ember);
  ember.name = 'ember';
  ember.position.y = 0.05;
  g.add(ember);
  // A teepee of logs.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + seed;
    g.add(log(i % 2 ? CAMP_MAT.wood : CAMP_MAT.bark, 0.7, Math.cos(a) * 0.15, 0.27, Math.sin(a) * 0.15, 0, 0.5, -a + Math.PI / 2));
  }
  return g;
}

function bedroll(): THREE.Group {
  const g = new THREE.Group();
  // The roll: a fur mat on a cloth ground sheet, a rolled pillow at the back.
  g.add(box(CAMP_MAT.cloth, 0.95, 0.04, 2.05, 0, 0.02, 0));
  g.add(box(CAMP_MAT.fur, 0.8, 0.09, 1.7, 0, 0.08, 0.1));
  const pillow = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.78, 8), CAMP_MAT.clothRed);
  pillow.rotation.z = Math.PI / 2;
  pillow.position.set(0, 0.15, -0.82);
  pillow.castShadow = true;
  g.add(pillow);
  // A lean-to over the head end: two forked posts, a ridge pole and a slanted cloth.
  g.add(log(CAMP_MAT.wood, 1.2, -0.58, 0.6, -0.55, 0, 0));
  g.add(log(CAMP_MAT.wood, 1.2, 0.58, 0.6, -0.55, 0, 0));
  g.add(log(CAMP_MAT.bark, 1.3, 0, 1.18, -0.55, 0, Math.PI / 2));
  const tarp = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.45), CAMP_MAT.cloth);
  tarp.position.set(0, 0.62, -0.05);
  tarp.rotation.x = -Math.PI / 2 + 0.95;
  tarp.castShadow = true;
  g.add(tarp);
  return g;
}

function chest(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(CAMP_MAT.wood, 1.1, 0.55, 0.66, 0, 0.3, 0));
  const lid = box(CAMP_MAT.woodLight, 1.14, 0.2, 0.7, 0, 0.67, 0);
  lid.name = 'lid';
  g.add(lid);
  for (const x of [-0.38, 0.38]) g.add(box(CAMP_MAT.iron, 0.07, 0.8, 0.72, x, 0.42, 0));
  g.add(box(CAMP_MAT.iron, 0.14, 0.16, 0.05, 0, 0.55, 0.36));
  // Feet.
  for (const [x, z] of [[-0.48, -0.26], [0.48, -0.26], [-0.48, 0.26], [0.48, 0.26]]) g.add(box(CAMP_MAT.woodDark, 0.12, 0.06, 0.12, x, 0.03, z));
  return g;
}

function workbench(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(CAMP_MAT.woodLight, 1.85, 0.1, 0.85, 0, 0.92, 0));
  for (const [x, z] of [[-0.82, -0.34], [0.82, -0.34], [-0.82, 0.34], [0.82, 0.34]]) g.add(box(CAMP_MAT.wood, 0.1, 0.88, 0.1, x, 0.44, z));
  g.add(box(CAMP_MAT.woodDark, 1.6, 0.06, 0.08, 0, 0.25, -0.34));
  g.add(box(CAMP_MAT.woodDark, 1.6, 0.06, 0.08, 0, 0.25, 0.34));
  // A vise, a saw and a mallet on top; a log on the shelf.
  g.add(box(CAMP_MAT.iron, 0.16, 0.14, 0.2, 0.7, 1.04, 0.3));
  g.add(box(CAMP_MAT.iron, 0.6, 0.012, 0.13, -0.3, 0.98, 0.1));
  g.add(box(CAMP_MAT.woodDark, 0.08, 0.05, 0.13, -0.66, 0.99, 0.1));
  g.add(box(CAMP_MAT.woodDark, 0.12, 0.1, 0.12, 0.25, 1.02, -0.2));
  g.add(log(CAMP_MAT.bark, 0.3, 0.25, 1.02, -0.05, Math.PI / 2, 0));
  g.add(log(CAMP_MAT.bark, 1.2, 0, 0.36, 0, 0, Math.PI / 2));
  return g;
}

function labelTexture(text: string): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#a07a4c';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#3a2614';
  ctx.font = `600 ${text.length > 14 ? 24 : 30}px Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34, 240);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function signpost(label: string): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(G.post, CAMP_MAT.wood);
  post.scale.set(1.3, 2.3, 1.3);
  post.position.y = 1.15;
  post.castShadow = true;
  g.add(post);
  const tex = labelTexture(label);
  const face = tex ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }) : CAMP_MAT.woodLight;
  const plank = new THREE.Mesh(G.box, [CAMP_MAT.woodLight, CAMP_MAT.woodLight, CAMP_MAT.woodLight, CAMP_MAT.woodLight, face, face]);
  plank.scale.set(1.1, 0.3, 0.05);
  plank.position.set(0, 1.85, 0.07);
  plank.castShadow = true;
  plank.name = 'plank';
  g.add(plank);
  // A pennant at the top.
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.3), CAMP_MAT.clothRed);
  flag.position.set(0.27, 2.15, 0);
  flag.name = 'flag';
  g.add(flag);
  return g;
}

/** A piece's model (base at y 0, local +z its front). */
export function pieceModel(kind: number, id: number, label = ''): THREE.Group {
  const seed = id % 97;
  let g: THREE.Group;
  if (kind === PIECE.campfire) g = campfire(seed);
  else if (kind === PIECE.bedroll) g = bedroll();
  else if (kind === PIECE.chest) g = chest();
  else if (kind === PIECE.workbench) g = workbench();
  else if (kind === PIECE.signpost) g = signpost(label || pieceDef(kind)?.name || '');
  else g = new THREE.Group();
  g.userData.kind = kind;
  return g;
}

/** Fallen branches (a deadfall patch): a few crossed sticks. */
export function deadfallModel(seed: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const a = seed * 1.7 + i * 1.3;
    g.add(log(i % 2 ? CAMP_MAT.bark : CAMP_MAT.wood, 0.7 + (i % 3) * 0.18, Math.cos(a) * 0.15, 0.07 + i * 0.03, Math.sin(a) * 0.15, Math.PI / 2, 0, a));
  }
  return g;
}

/** Give every mesh of a model one material (the placement ghost). */
export function ghostify(g: THREE.Object3D, m: THREE.Material): void {
  g.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.material = m;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
  });
}

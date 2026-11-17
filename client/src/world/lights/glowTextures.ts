// Soft procedural sprites for torches and familiar lights (CR 042): a round
// halo, a flame teardrop and a four-ray star. Drawn once on a canvas (original
// art, no files); the materials are shared so every glow in the world uses the
// same two programs (a plain mesh and an additive sprite), both pre-warmed in
// world/warmup.ts via lightWarmObjects().

import * as THREE from 'three';

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (g) draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let halo: THREE.Texture | null = null;
let flame: THREE.Texture | null = null;
let star: THREE.Texture | null = null;

/** A round falloff: white centre to nothing, no visible edge. */
export function haloTexture(): THREE.Texture {
  return (halo ??= canvasTexture(64, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.18, 'rgba(255,255,255,0.55)');
    r.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }));
}

/** A teardrop flame: hot white core, orange body, a soft tip. */
export function flameTexture(): THREE.Texture {
  return (flame ??= canvasTexture(64, (g, s) => {
    g.clearRect(0, 0, s, s);
    const body = (w: number, top: number, bottom: number, a: number, col: string) => {
      g.beginPath();
      g.moveTo(s / 2, top);
      g.bezierCurveTo(s / 2 + w, s * 0.5, s / 2 + w * 0.8, bottom, s / 2, bottom);
      g.bezierCurveTo(s / 2 - w * 0.8, bottom, s / 2 - w, s * 0.5, s / 2, top);
      const grad = g.createRadialGradient(s / 2, bottom * 0.9, 0, s / 2, bottom * 0.9, s * 0.5);
      grad.addColorStop(0, col.replace('A', String(a)));
      grad.addColorStop(1, col.replace('A', '0'));
      g.fillStyle = grad;
      g.fill();
    };
    body(s * 0.3, s * 0.04, s * 0.96, 0.95, 'rgba(255,150,40,A)');
    body(s * 0.18, s * 0.28, s * 0.92, 1, 'rgba(255,230,160,A)');
    body(s * 0.08, s * 0.5, s * 0.88, 1, 'rgba(255,255,255,A)');
  }));
}

/** Four soft rays (a twinkle): for the radiant wisp. */
export function starTexture(): THREE.Texture {
  return (star ??= canvasTexture(64, (g, s) => {
    g.clearRect(0, 0, s, s);
    for (const [w, h] of [
      [s * 0.9, s * 0.07],
      [s * 0.07, s * 0.9],
    ]) {
      const grad = g.createLinearGradient(s / 2 - w / 2, s / 2, s / 2 + w / 2, s / 2);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.save();
      g.translate(s / 2, s / 2);
      if (h > w) g.rotate(Math.PI / 2);
      g.translate(-s / 2, -s / 2);
      g.fillStyle = grad;
      g.fillRect(s / 2 - Math.max(w, h) / 2, s / 2 - Math.min(w, h) / 2, Math.max(w, h), Math.min(w, h));
      g.restore();
    }
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * 0.22);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  }));
}

/** An additive, unlit sprite material (shared program with every glow). */
export function glowMaterial(map: THREE.Texture, color: THREE.ColorRepresentation, opacity: number): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({ map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false });
}

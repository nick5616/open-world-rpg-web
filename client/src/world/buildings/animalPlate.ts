// The soft nameplate over a town dog or cat you look at up close (playtest 5,
// CR 054): one small DOM label, projected from the animal's head, fading in
// as you come within a few metres and out as you look away. The E prompt
// ("[E] Pet Biscuit") carries the name too; this is the quiet version for
// when you are only looking.

import * as THREE from 'three';
import type { TownAnimals } from './townAnimals';
import { view } from '../../state/live';

export const PLATE_MAX_M = 7.5;
/** Opacity of a plate `d` metres away: full within 4 m, gone at PLATE_MAX_M. */
export function plateAlpha(d: number): number {
  return Math.max(0, Math.min(1, (PLATE_MAX_M - d) / (PLATE_MAX_M - 4)));
}

export class AnimalPlate {
  private readonly el = document.createElement('div');
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private shown = '';
  /** Debug and tests: the name on show. */
  get text(): string {
    return this.shown;
  }

  constructor() {
    this.el.dataset.testid = 'animal-plate';
    Object.assign(this.el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      zIndex: '19',
      padding: '2px 10px 3px',
      borderRadius: '10px',
      background: 'rgba(32,26,20,0.42)',
      backdropFilter: 'blur(2px)',
      color: '#f8eed8',
      font: '600 12px/1.25 system-ui, sans-serif',
      letterSpacing: '0.02em',
      textShadow: '0 1px 2px rgba(0,0,0,0.7)',
      whiteSpace: 'nowrap',
      opacity: '0',
      transition: 'opacity 0.25s',
    });
    document.body.append(this.el);
  }

  update(camera: THREE.Camera, animals: TownAnimals): void {
    const fwd = this.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const hit = view.photo ? null : animals.lookedAt(camera.position, fwd, PLATE_MAX_M);
    if (!hit) {
      if (this.el.style.opacity !== '0') this.el.style.opacity = '0';
      return;
    }
    const p = this.v.set(hit.x, hit.y, hit.z).project(camera);
    if (p.z > 1) {
      this.el.style.opacity = '0';
      return;
    }
    if (this.shown !== hit.name) {
      this.shown = hit.name;
      this.el.textContent = hit.name;
    }
    const x = (p.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-p.y * 0.5 + 0.5) * window.innerHeight;
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    this.el.style.opacity = String(plateAlpha(hit.d).toFixed(2));
  }

  dispose(): void {
    this.el.remove();
  }
}

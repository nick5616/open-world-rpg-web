// Debug overlay (spec 14 "show chunk borders"): outlines of the terrain tiles
// being drawn, coloured by LOD (lod 0 white -> lod 6 red), draped on the
// ground. Shown together with WP02's cell/chunk/region borders (F4). Rebuilt
// at most 4 times a second, only when the drawn set changed.

import * as THREE from 'three';
import type { GroundQuery } from '../../sim/ground';
import { keyOf, tileSize, type TileId } from '../terrain/quadtree';

const LOD_COLORS = ['#ffffff', '#7cf3ff', '#5dff7a', '#fff35d', '#ffa53d', '#ff5df0', '#ff3b3b'].map((c) => new THREE.Color(c));
const MAX_DIST = 1500;

export class LodOverlay {
  readonly lines: THREE.LineSegments;
  private last = '';
  private lastAt = 0;

  constructor(private readonly ground: GroundQuery) {
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, transparent: true, opacity: 0.85 }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.lines.visible = false;
  }

  update(on: boolean, drawn: TileId[], cam: THREE.Vector3, now: number): void {
    this.lines.visible = on;
    if (!on || now - this.lastAt < 250) return;
    this.lastAt = now;
    const near = drawn.filter((t) => {
      const s = tileSize(t.lod);
      return Math.hypot(t.cx * 64 + s / 2 - cam.x, t.cz * 64 + s / 2 - cam.z) < MAX_DIST + s;
    });
    const sig = near.map(keyOf).sort().join('|');
    if (sig === this.last) return;
    this.last = sig;
    const pos: number[] = [];
    const col: number[] = [];
    for (const t of near) {
      const s = tileSize(t.lod);
      const x0 = t.cx * 64;
      const z0 = t.cz * 64;
      const c = LOD_COLORS[t.lod];
      const seg = Math.max(4, s / 16);
      const edge = (ax: number, az: number, bx: number, bz: number) => {
        const n = Math.ceil(Math.hypot(bx - ax, bz - az) / seg);
        for (let i = 0; i < n; i++) {
          const x1 = ax + ((bx - ax) * i) / n;
          const z1 = az + ((bz - az) * i) / n;
          const x2 = ax + ((bx - ax) * (i + 1)) / n;
          const z2 = az + ((bz - az) * (i + 1)) / n;
          pos.push(x1, this.ground.heightAt(x1, z1) + 0.4, z1, x2, this.ground.heightAt(x2, z2) + 0.4, z2);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      };
      edge(x0, z0, x0 + s, z0);
      edge(x0, z0, x0, z0 + s);
    }
    const g = this.lines.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

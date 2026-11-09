// The audio engine's view of the loaded world (towns, terrain, water,
// chemistry fire): the glue between WorldRuntime and the pure audio modules
// (shelter.ts, surface.ts, emitters.ts, loopPool.ts). Indices are built once
// per runtime (a few ms: every building into a 16 m grid, every fire prop
// into a 64 m grid); the queries are what the engine's 10 Hz tick asks.

import { FIRE_UPDRAFT_TOP_M } from '@lodestone/contracts';
import { BIOMES } from '@lodestone/worldgen';
import type { WorldRuntime } from '../world/core/runtime';
import type { ChemView } from '../systems/chem/sync';
import { cellCenter, cellX, cellZ } from '../systems/chem/sim';
import { PointGrid, townEmitters, type Hammer } from './emitters';
import { clusterFires, type LoopEmitter } from './loopPool';
import { ShelterIndex, type ShelterProbe } from './shelter';
import { SPACE_CAVE, SPACE_OUTDOORS } from './spatial';
import { classifySurface, type StepSurface } from './surface';

/** A point this far below the terrain is in a cave (for occlusion). */
const CAVE_BELOW_M = 3;
/** Water probe rings (m) and directions. */
const WATER_RINGS = [3, 7, 13, 21, 32, 45];
const WATER_DIRS = 8;
/** Node flags (AtlasData.nodeParams byte 3). */
const NODE_RIVER = 4;

const OPEN_SKY: ShelterProbe = { roof: 0, indoors: 0, building: SPACE_OUTDOORS, roomRadius: 4 };

export class WorldProbe {
  private rt: WorldRuntime | null = null;
  shelter: ShelterIndex | null = null;
  private fireGrid: PointGrid<LoopEmitter> | null = null;
  private hammerGrid: PointGrid<Hammer> | null = null;
  private chemVersion = -1;
  private chemView: ChemView | null = null;
  private chemFires: LoopEmitter[] = [];
  /** Static fire emitters / forges indexed (debug). */
  stats = { fires: 0, hammers: 0, buildMs: 0 };

  /** Follow the loaded world (cheap when unchanged). */
  attach(rt: WorldRuntime | null): void {
    if (rt === this.rt) return;
    this.rt = rt;
    this.shelter = null;
    this.fireGrid = this.hammerGrid = null;
    if (!rt?.towns) return;
    const t0 = performance.now();
    const shelter = new ShelterIndex(rt.towns.buildings, rt.townCollision);
    this.shelter = shelter;
    const { fires, hammers } = townEmitters(rt.towns, (x, y, z) => shelter.spaceAt(x, y, z));
    this.fireGrid = new PointGrid(fires);
    this.hammerGrid = new PointGrid(hammers);
    this.stats = { fires: fires.length, hammers: hammers.length, buildMs: Math.round(performance.now() - t0) };
  }

  get ready(): boolean {
    return !!this.rt;
  }

  /** Acoustic space of a point: a cave, a closed building, or outdoors. */
  spaceOf(x: number, y: number, z: number): number {
    const rt = this.rt;
    if (!rt) return SPACE_OUTDOORS;
    if (y < rt.terrainGround.heightAt(x, z) - CAVE_BELOW_M) return SPACE_CAVE;
    return this.shelter ? this.shelter.spaceAt(x, y, z) : SPACE_OUTDOORS;
  }

  /** Roof and walls around the listener's feet. */
  shelterAt(x: number, feetY: number, z: number): ShelterProbe {
    return this.shelter ? this.shelter.probe(x, feetY, z) : OPEN_SKY;
  }

  biomeAt(x: number, z: number): string | null {
    const d = this.rt?.data;
    if (!d || d.macroRes <= 0) return null;
    const i = Math.min(d.gridN - 1, Math.max(0, Math.round(x / d.macroRes)));
    const j = Math.min(d.gridN - 1, Math.max(0, Math.round(z / d.macroRes)));
    return BIOMES[d.biome[j * d.gridN + i]] ?? null;
  }

  private nodeFlags(x: number, z: number): number {
    const d = this.rt?.data;
    if (!d || d.macroRes <= 0) return 0;
    const i = Math.min(d.gridN - 1, Math.max(0, Math.round(x / d.macroRes)));
    const j = Math.min(d.gridN - 1, Math.max(0, Math.round(z / d.macroRes)));
    return d.nodeParams[4 * (j * d.gridN + i) + 3] ?? 0;
  }

  /** Footstep surface at the feet. */
  surfaceAt(x: number, feetY: number, z: number, underground: number, inTown: boolean): StepSurface {
    const rt = this.rt;
    const water = rt ? rt.terrainGround.waterAt(x, z) - feetY : -1;
    return classifySurface({ underground, box: this.shelter?.surfaceUnder(x, feetY, z) ?? null, waterDepth: Number.isFinite(water) ? water : -1, biome: underground > 0.3 ? null : this.biomeAt(x, z), inTown });
  }

  /** Static fires within r metres (towns, camps, structures). */
  *firesNear(x: number, z: number, r: number): Generator<LoopEmitter> {
    if (this.fireGrid) yield* this.fireGrid.near(x, z, r);
  }

  /** Forges within r metres. */
  *forgesNear(x: number, z: number, r: number): Generator<Hammer> {
    if (this.hammerGrid) yield* this.hammerGrid.near(x, z, r);
  }

  /**
   * Burning chemistry cells as fire emitters (re-clustered only when the
   * chemistry view changed).
   */
  chemistryFires(view: ChemView | null): LoopEmitter[] {
    if (!view) return (this.chemFires = []);
    if (view === this.chemView && view.version === this.chemVersion) return this.chemFires;
    this.chemView = view;
    this.chemVersion = view.version;
    const cells: { x: number; y: number; z: number }[] = [];
    view.forEachActive((id, st, y) => {
      if (st === 1) cells.push({ x: cellCenter(cellX(id)), y: y - FIRE_UPDRAFT_TOP_M + 0.6, z: cellCenter(cellZ(id)) });
    });
    this.chemFires = clusterFires(cells, (x, y, z) => this.spaceOf(x, y, z));
    return this.chemFires;
  }

  /**
   * Nearby open water as one emitter: probe rings around the listener
   * (terrain vs water surface, ~100 wasm calls), take the nearest ring with
   * water, place the source at its wet points' centroid; a river (atlas node
   * flag) flows, a lake or the sea laps. Null when no water within 45 m.
   */
  waterNear(x: number, z: number): LoopEmitter | null {
    const rt = this.rt;
    if (!rt) return null;
    const g = rt.terrainGround;
    for (const r of WATER_RINGS) {
      let n = 0;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = 0; k < WATER_DIRS; k++) {
        const a = (k / WATER_DIRS) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const w = g.waterAt(px, pz);
        if (!Number.isFinite(w) || w <= g.heightAt(px, pz) + 0.15) continue;
        n++;
        sx += px;
        sy += w;
        sz += pz;
      }
      if (!n) continue;
      const cx = sx / n;
      const cz = sz / n;
      const river = (this.nodeFlags(cx, cz) & NODE_RIVER) !== 0;
      // Mostly water around you (a lake shore, mid-river) is louder than a glimpse of it.
      return { id: river ? 'water:river' : 'water:shore', kind: river ? 'river' : 'shore', x: cx, y: sy / n, z: cz, level: 0.55 + 0.45 * (n / WATER_DIRS), space: SPACE_OUTDOORS };
    }
    return null;
  }
}

// The world the map draws: the atlas (sites, regions, macro grids) and the
// towers built from it. Set by the world's structure layer once the runtime
// has loaded (client/src/world/structures/StructuresLayer.tsx), cleared on
// dispose. The terrain picture is rendered lazily on first map open (a
// 1024 x 1024 software render takes ~150 ms; nobody should pay it at load).

import { create } from 'zustand';
import type { AtlasData } from '@lodestone/worldgen';
import type { RadialStructure } from '../../world/structures/overlay';
import { renderTerrain } from './mapRender';
import { setTowerShelters } from '../../sim/shelter';

export const MAP_PX = 1024;

export interface MapTower {
  site: number;
  shape: RadialStructure;
}

interface MapWorldState {
  data: AtlasData | null;
  towers: MapTower[];
  terrain: HTMLCanvasElement | null;
}

export const useMapWorld = create<MapWorldState>(() => ({ data: null, towers: [], terrain: null }));

export function setMapWorld(data: AtlasData | null, towers: MapTower[] = []): void {
  useMapWorld.setState({ data, towers, terrain: null });
  setTowerShelters(towers.map((t) => t.shape)); // playtest 2 co-op: dry tower walls (sim/shelter.ts)
}

/** The terrain picture for the current world (rendered on first use). */
export function mapTerrain(): HTMLCanvasElement | null {
  const st = useMapWorld.getState();
  if (st.terrain || !st.data) return st.terrain;
  const c = document.createElement('canvas');
  c.width = c.height = MAP_PX;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  renderTerrain(ctx, st.data, MAP_PX);
  useMapWorld.setState({ terrain: c });
  return c;
}

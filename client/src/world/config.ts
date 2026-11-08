// World-side knobs: which world to load and how much each quality tier
// spends. The tier table lives here, not in the WP02 quality store, because
// these are terrain/scatter internals; the store's tier picks the row.
// Every effect has a tier switch (spec 12).

import type { QualityTier } from '../stores/qualityStore';

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

/**
 * World seed for solo play. Same default as WP04's official world
 * (LODESTONE_WORLD_SEED, 20261108) so solo and online show the same land.
 * `?seed=` overrides for exploring other worlds.
 */
export function worldSeed(): string {
  const s = params.get('seed') ?? (import.meta.env.VITE_WORLD_SEED as string | undefined) ?? '20261108';
  return /^\d+$/.test(s) ? s : '20261108';
}

/** `?nocache=1`: skip the IndexedDB mesh cache (benchmarks measuring generation). */
export const MESH_CACHE = !params.has('nocache');

export interface WorldTier {
  /** Quadtree split factor: a tile splits while the camera is within split x its size. */
  lodSplit: number;
  /** New tiles turned into GPU meshes per frame (time-sliced uploads). */
  uploadsPerFrame: number;
  /** ...and the main-thread milliseconds they may take. */
  uploadBudgetMs: number;
  /** Trees and rocks are instanced out to here (beyond: billboards to impostorDistance). */
  scatterDistance: number;
  /** Full tree meshes inside this radius, impostor billboards outside (spec 12: 200 m). */
  treeMeshDistance: number;
  /** Bushes and grass tufts. */
  smallScatterDistance: number;
  /** Grass blade clumps around the camera (0 = off) and their density per m². */
  grassDistance: number;
  grassDensity: number;
  /** Sun shadow reach in meters (cascades come from the quality preset). */
  shadowDistance: number;
  shadowMapSize: number;
  bloom: boolean;
  godRays: boolean;
  /** Animated water normals and sun glints. */
  waterDetail: boolean;
}

export const WORLD_TIERS: Record<QualityTier, WorldTier> = {
  low: {
    lodSplit: 0.9,
    uploadsPerFrame: 2,
    uploadBudgetMs: 3,
    scatterDistance: 450,
    treeMeshDistance: 120,
    smallScatterDistance: 60,
    grassDistance: 0,
    grassDensity: 0,
    shadowDistance: 0,
    shadowMapSize: 1024,
    bloom: false,
    godRays: false,
    waterDetail: false,
  },
  medium: {
    lodSplit: 1.1,
    uploadsPerFrame: 3,
    uploadBudgetMs: 4,
    scatterDistance: 700,
    treeMeshDistance: 160,
    smallScatterDistance: 90,
    grassDistance: 28,
    grassDensity: 1.2,
    shadowDistance: 180,
    shadowMapSize: 1024,
    bloom: true,
    godRays: false,
    waterDetail: true,
  },
  high: {
    lodSplit: 1.3,
    uploadsPerFrame: 4,
    uploadBudgetMs: 5,
    scatterDistance: 1000,
    treeMeshDistance: 200,
    smallScatterDistance: 120,
    grassDistance: 40,
    grassDensity: 2,
    shadowDistance: 320,
    shadowMapSize: 2048,
    bloom: true,
    godRays: true,
    waterDetail: true,
  },
};

/** Far plane: the horizon mesh shows the whole 4 km world from anywhere in it. */
export const CAMERA_FAR = 9000;

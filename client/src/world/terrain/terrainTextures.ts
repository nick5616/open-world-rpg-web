// Loads the terrain texture arrays built by tools/textures/build-textures.mjs
// (KTX2 / Basis Universal, one layer per terrain material). three's
// KTX2Loader transcodes in its own workers to whatever the GPU supports
// (BC7/ASTC/ETC2..., RGBA8 as a last resort) and returns a
// CompressedArrayTexture, which binds as a sampler2DArray.
//
// pbrMaterial rules (spec 12) apply: everything arrives together or not at
// all (the material renders flat mean colours until then), textures are
// cached for the session and never disposed by a component.

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

export interface TerrainManifest {
  version: number;
  size: number;
  layers: string[];
  files: { color: string; normal: string; orm: string };
  bytes: { color: number; normal: number; orm: number };
  mean: Record<string, [number, number, number]>;
}

export interface TerrainTextures {
  manifest: TerrainManifest;
  color: THREE.Texture;
  normal: THREE.Texture | null;
  orm: THREE.Texture;
  /** Bytes fetched (benchmark: download before first playable frame). */
  bytes: number;
}

const BASE = `${import.meta.env.BASE_URL}textures/terrain/`;
let loader: KTX2Loader | null = null;
let manifestPromise: Promise<TerrainManifest> | null = null;
const cache = new Map<string, Promise<TerrainTextures>>();

export function terrainManifest(): Promise<TerrainManifest> {
  // The manifest is the only un-hashed file: fetch it fresh, the arrays it names are immutable.
  manifestPromise ??= fetch(`${BASE}manifest.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`terrain manifest: HTTP ${r.status}`);
    return r.json() as Promise<TerrainManifest>;
  });
  return manifestPromise;
}

export function loadTerrainTextures(renderer: THREE.WebGLRenderer, withNormals: boolean, anisotropy: number): Promise<TerrainTextures> {
  const key = `${withNormals}:${anisotropy}`;
  let p = cache.get(key);
  if (p) return p;
  p = (async () => {
    const manifest = await terrainManifest();
    if (!loader) {
      loader = new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).setWorkerLimit(2);
      loader.detectSupport(renderer);
    }
    const load = async (file: string) => {
      const t = (await loader!.loadAsync(BASE + file)) as THREE.Texture;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = anisotropy;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    const [color, normal, orm] = await Promise.all([load(manifest.files.color), withNormals ? load(manifest.files.normal) : null, load(manifest.files.orm)]);
    const bytes = manifest.bytes.color + manifest.bytes.orm + (withNormals ? manifest.bytes.normal : 0);
    return { manifest, color, normal, orm, bytes };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

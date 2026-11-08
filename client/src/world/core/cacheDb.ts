// World caches in the shared "lodestone" IndexedDB (WP04 owns the database
// helper in client/src/account/idb.ts and its `profile` + `saves` stores).
// Every store here is prefixed "cache:", so account/idb.ts clearCaches()
// can wipe them without ever touching a save. Stores are added through
// openLodestoneDb(), which bumps the version only when one is missing, so
// WP04 and WP05 never have to agree on version numbers.
//
//   cache:atlas         one record per (genVersion, seed): the atlas bytes + hash
//   cache:terrain-mesh  built terrain tiles keyed (atlasHash, genVersion, lod, cx, cz, mesh format)
//   cache:terrain-meta  {key, t, bytes} per tile: LRU clock + size, kept apart
//                       so a cache hit rewrites 30 bytes, not a 150 KB record
//
// Runs on the main thread (atlas) and inside generation workers (meshes):
// IndexedDB is available in both, and doing the mesh cache in the workers
// keeps its structured-clone cost off the main thread.

import { openLodestoneDb, type StoreSpec } from '../../account/idb';

export const ATLAS_STORE = 'cache:atlas';
export const MESH_STORE = 'cache:terrain-mesh';
export const META_STORE = 'cache:terrain-meta';
/** Bump when TileMeshData's layout changes so stale cached meshes are never read. */
// 3: WP09 tiles carry mouth holes (an own index over cave mouths).
export const MESH_FORMAT = 3;
/** Spec 12: LRU cap of 500 MB for built chunk meshes. */
export const MESH_CACHE_CAP_BYTES = 500 * 1024 * 1024;

export const WORLD_STORES: StoreSpec[] = [
  { name: ATLAS_STORE, keyPath: 'key' },
  { name: MESH_STORE, keyPath: 'key' },
  { name: META_STORE, keyPath: 'key', indexes: [{ name: 't', keyPath: 't' }] },
];

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Opens (and if needed upgrades) the database; null when IndexedDB is unavailable (private mode, tests). */
export function worldDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = (typeof indexedDB === 'undefined' ? Promise.resolve(null) : openLodestoneDb(WORLD_STORES)).catch((err) => {
      console.warn('[world] IndexedDB unavailable, caches disabled:', err);
      return null;
    });
  }
  return dbPromise;
}

export function meshKey(atlasHash: string, genVersion: number, lod: number, cx: number, cz: number): string {
  // The spec keys meshes by (genVersion, chunk, lod); the atlas hash is added
  // because two worlds with the same genVersion have different chunks.
  return `${atlasHash}:${genVersion}:${MESH_FORMAT}:${lod}:${cx}:${cz}`;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function cacheGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return (await req(db.transaction(store).objectStore(store).get(key))) as T | undefined;
}

export async function cachePut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

/** Mesh hit: read the record and bump its LRU clock in one go. */
export async function meshGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  const rec = await cacheGet<{ key: string; data: T }>(db, MESH_STORE, key);
  if (!rec) return undefined;
  const meta = await cacheGet<{ key: string; t: number; bytes: number }>(db, META_STORE, key);
  if (meta) {
    meta.t = Date.now();
    cachePut(db, META_STORE, meta).catch(() => {});
  }
  return rec.data;
}

export async function meshPut(db: IDBDatabase, key: string, data: unknown, bytes: number): Promise<void> {
  const tx = db.transaction([MESH_STORE, META_STORE], 'readwrite');
  tx.objectStore(MESH_STORE).put({ key, data });
  tx.objectStore(META_STORE).put({ key, t: Date.now(), bytes });
  await done(tx);
}

export interface MetaRow {
  key: string;
  t: number;
  bytes: number;
}

/** Keys to delete (oldest first) so the cache fits in `cap` bytes. Pure; tested. */
export function lruVictims(rows: readonly MetaRow[], cap: number): string[] {
  let total = rows.reduce((s, r) => s + r.bytes, 0);
  if (total <= cap) return [];
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const out: string[] = [];
  for (const r of sorted) {
    if (total <= cap) break;
    out.push(r.key);
    total -= r.bytes;
  }
  return out;
}

/** Enforce the mesh-cache cap. Returns {bytes before, deleted count}. */
export async function evictMeshes(db: IDBDatabase, cap = MESH_CACHE_CAP_BYTES): Promise<{ bytes: number; deleted: number }> {
  const rows = (await req(db.transaction(META_STORE).objectStore(META_STORE).getAll())) as MetaRow[];
  const victims = lruVictims(rows, cap);
  if (victims.length) {
    const tx = db.transaction([MESH_STORE, META_STORE], 'readwrite');
    for (const k of victims) {
      tx.objectStore(MESH_STORE).delete(k);
      tx.objectStore(META_STORE).delete(k);
    }
    await done(tx);
  }
  return { bytes: rows.reduce((s, r) => s + r.bytes, 0), deleted: victims.length };
}

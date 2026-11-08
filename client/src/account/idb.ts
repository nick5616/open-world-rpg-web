// The shared "lodestone" IndexedDB (spec 11 and 12): saves and caches live in
// one database under separate object stores, so clearing caches never deletes
// a save.
//
// Convention for every module that keeps stores here (account saves now, the
// atlas/wasm/chunk caches from WP05 later): don't hard-code a database
// version. Call `openLodestoneDb(yourStores)`; it opens whatever version
// exists and, only if one of your stores is missing, reopens at version + 1
// to create it. Two modules can therefore add stores independently without
// agreeing on version numbers. Cache stores must be named with
// CACHE_STORE_PREFIX so `clearCaches()` can find them.

export const DB_NAME = 'lodestone';

/** Prefix for every cache store (e.g. "cache:atlas"). Saves never use it. */
export const CACHE_STORE_PREFIX = 'cache:';

export interface StoreSpec {
  name: string;
  keyPath: string;
  indexes?: { name: string; keyPath: string }[];
}

/** Stores the account module owns. */
export const ACCOUNT_STORES: StoreSpec[] = [
  // The local profile (id + secret). One record, key "current".
  { name: 'profile', keyPath: 'key' },
  // Newest signed save per character.
  { name: 'saves', keyPath: 'characterId', indexes: [{ name: 'byProfile', keyPath: 'profileId' }] },
];

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open(version?: number, stores: StoreSpec[] = []): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of stores) {
        if (db.objectStoreNames.contains(s.name)) continue;
        const os = db.createObjectStore(s.name, { keyPath: s.keyPath });
        for (const i of s.indexes ?? []) os.createIndex(i.name, i.keyPath);
      }
    };
    r.onsuccess = () => {
      const db = r.result;
      // Let another module (or tab) upgrade the database: holding the old
      // connection open would block its versionchange forever.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab; close other Lodestone tabs'));
  });
}

/** Opens the shared database, creating any of `stores` that are missing. */
export async function openLodestoneDb(stores: StoreSpec[] = ACCOUNT_STORES): Promise<IDBDatabase> {
  const db = await open();
  const missing = stores.filter((s) => !db.objectStoreNames.contains(s.name));
  if (missing.length === 0) return db;
  const next = db.version + 1;
  db.close();
  return open(next, missing);
}

export async function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbGetAll<T>(db: IDBDatabase, store: string, index?: string, query?: IDBValidKey): Promise<T[]> {
  const os = db.transaction(store).objectStore(store);
  return req(index ? os.index(index).getAll(query) : os.getAll()) as Promise<T[]>;
}

export async function idbPut(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Empties every cache store and nothing else. Saves are untouched by construction. */
export async function clearCaches(db: IDBDatabase): Promise<string[]> {
  const caches = Array.from(db.objectStoreNames).filter((n) => n.startsWith(CACHE_STORE_PREFIX));
  if (caches.length === 0) return [];
  const tx = db.transaction(caches, 'readwrite');
  for (const c of caches) tx.objectStore(c).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return caches;
}

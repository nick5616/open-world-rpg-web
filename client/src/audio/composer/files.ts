// Playtest 2 vibe explorer: the composer's loaded audio files, kept in this
// browser's IndexedDB so a test track survives a reload (no rebuild, nothing
// uploaded anywhere). Every call is best effort: a private window or a
// blocked database just means files live for this session only.

const DB = 'lodestone-composer';
const STORE = 'files';

export interface StoredFile {
  name: string;
  size: number;
  type: string;
  at: number;
}

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return db().then(
    (d) =>
      new Promise<T | null>((resolve) => {
        if (!d) return resolve(null);
        try {
          const r = fn(d.transaction(STORE, mode).objectStore(STORE));
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function saveFile(name: string, blob: Blob): Promise<boolean> {
  const rec = { name, size: blob.size, type: blob.type, at: Date.now(), blob };
  return (await req('readwrite', (s) => s.put(rec, name))) !== null;
}

export async function listFiles(): Promise<StoredFile[]> {
  const all = (await req('readonly', (s) => s.getAll())) as ({ blob: Blob } & StoredFile)[] | null;
  return (all ?? []).map(({ name, size, type, at }) => ({ name, size, type, at })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readFile(name: string): Promise<Blob | null> {
  const r = (await req('readonly', (s) => s.get(name))) as { blob?: Blob } | null;
  return r?.blob ?? null;
}

export async function deleteFile(name: string): Promise<void> {
  await req('readwrite', (s) => s.delete(name));
}

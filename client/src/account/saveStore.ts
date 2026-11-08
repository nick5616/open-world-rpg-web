// Local profile + signed saves in IndexedDB (spec 11). IndexedDB rather than
// localStorage because saves can reach hundreds of KB and localStorage is
// small and blocks the main thread.
import { idbGet, idbGetAll, idbPut, openLodestoneDb } from './idb';
import type { SaveBlob } from './types';

export interface LocalProfile {
  key: 'current';
  profileId: string;
  /** Proves this browser owns profileId. Anyone holding it (e.g. an export file) can play the profile. */
  profileSecret: string;
  createdAt: number;
  /** Set after a successful upgrade; the saves are then only a cache. */
  upgradedTo?: string;
}

export interface StoredSave {
  characterId: string;
  profileId: string;
  blob: SaveBlob;
  savedAt: number;
}

function randomSecret(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  // base64url without padding: 43 characters (the server's minimum).
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class SaveStore {
  private db: IDBDatabase | null = null;

  static async open(): Promise<SaveStore> {
    const s = new SaveStore();
    await s.conn();
    return s;
  }

  /**
   * The open connection, reopened on demand. Another module adding its cache
   * store bumps the database version, which closes our connection (see
   * idb.ts); without this every later save would fail with InvalidStateError.
   */
  private async conn(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    const db = await openLodestoneDb();
    const drop = () => {
      if (this.db === db) this.db = null;
    };
    db.addEventListener('versionchange', drop);
    db.addEventListener('close', drop);
    this.db = db;
    return db;
  }

  async getProfile(): Promise<LocalProfile | undefined> {
    return idbGet<LocalProfile>(await this.conn(), 'profile', 'current');
  }

  /** Returns the existing profile or creates one with a random id (crypto.randomUUID) and secret. */
  async ensureProfile(): Promise<LocalProfile> {
    const existing = await this.getProfile();
    if (existing && !existing.upgradedTo) return existing;
    const p: LocalProfile = { key: 'current', profileId: crypto.randomUUID(), profileSecret: randomSecret(), createdAt: Date.now() };
    await idbPut(await this.conn(), 'profile', p);
    return p;
  }

  async putProfile(p: Omit<LocalProfile, 'key'>): Promise<void> {
    await idbPut(await this.conn(), 'profile', { ...p, key: 'current' });
  }

  async markUpgraded(accountId: string): Promise<void> {
    const p = await this.getProfile();
    if (p) await idbPut(await this.conn(), 'profile', { ...p, upgradedTo: accountId });
  }

  /** Object stores currently in the shared database (diagnostics). */
  async storeNames(): Promise<string[]> {
    return Array.from((await this.conn()).objectStoreNames);
  }

  async getSave(characterId: string): Promise<StoredSave | undefined> {
    return idbGet<StoredSave>(await this.conn(), 'saves', characterId);
  }

  async listSaves(profileId: string): Promise<StoredSave[]> {
    return idbGetAll<StoredSave>(await this.conn(), 'saves', 'byProfile', profileId);
  }

  /**
   * Stores a blob unless a newer one (higher counter) is already stored, so a
   * late response or an older import never overwrites newer progress.
   * Returns whether it was stored.
   */
  async putSave(blob: SaveBlob): Promise<boolean> {
    const cur = await this.getSave(blob.characterId);
    if (cur && cur.blob.counter > blob.counter) return false;
    await idbPut(await this.conn(), 'saves', { characterId: blob.characterId, profileId: blob.profileId, blob, savedAt: Date.now() } satisfies StoredSave);
    return true;
  }
}

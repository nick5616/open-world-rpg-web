// Export / Import of a local profile (spec 11): the only way a local
// character survives clearing browser data or moves to another device.
//
// The file carries the profile secret, because importing on a new device must
// be able to claim the profile. Treat the file like a password. Blobs inside
// are verified by the server on import (signature + newest counter), so an
// edited file is rejected rather than trusted.
import type { SaveBlob } from './types';

export const EXPORT_FORMAT = 'lodestone-profile-export';
export const EXPORT_VERSION = 1;

export interface ProfileExport {
  format: typeof EXPORT_FORMAT;
  v: number;
  exportedAt: string;
  profile: { profileId: string; profileSecret: string; createdAt: number };
  saves: SaveBlob[];
}

export function buildExport(profile: { profileId: string; profileSecret: string; createdAt: number }, saves: SaveBlob[], now = new Date()): ProfileExport {
  return {
    format: EXPORT_FORMAT,
    v: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    profile: { profileId: profile.profileId, profileSecret: profile.profileSecret, createdAt: profile.createdAt },
    saves,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isSave(x: unknown, profileId: string): x is SaveBlob {
  const s = x as Partial<SaveBlob>;
  return (
    typeof s === 'object' && s !== null && s.format === 'lodestone-save' && typeof s.v === 'number' && s.profileId === profileId &&
    typeof s.characterId === 'string' && typeof s.worldId === 'string' && typeof s.counter === 'number' && s.counter > 0 &&
    typeof s.issuedAt === 'number' && typeof s.state === 'string' && typeof s.sig === 'string'
  );
}

/** Parses and shape-checks an export file. Throws with a player-readable message. */
export function parseExport(text: string): ProfileExport {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('This is not a Lodestone profile file (not JSON).');
  }
  const e = j as Partial<ProfileExport>;
  if (!e || e.format !== EXPORT_FORMAT) throw new Error('This is not a Lodestone profile file.');
  if (e.v !== EXPORT_VERSION) throw new Error(`Unsupported profile file version ${String(e.v)}.`);
  const p = e.profile;
  if (!p || typeof p.profileId !== 'string' || !UUID.test(p.profileId) || typeof p.profileSecret !== 'string' || p.profileSecret.length < 43) {
    throw new Error('The profile file is damaged (bad profile id or secret).');
  }
  if (!Array.isArray(e.saves) || !e.saves.every((s) => isSave(s, p.profileId))) {
    throw new Error('The profile file is damaged (bad save entries).');
  }
  return { format: EXPORT_FORMAT, v: EXPORT_VERSION, exportedAt: String(e.exportedAt ?? ''), profile: { profileId: p.profileId, profileSecret: p.profileSecret, createdAt: Number(p.createdAt) || Date.now() }, saves: e.saves };
}

/** Triggers a browser download of the export. */
export function downloadExport(exp: ProfileExport): void {
  const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lodestone-profile-${exp.profile.profileId.slice(0, 8)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

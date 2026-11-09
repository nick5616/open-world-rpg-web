// Which worldgen.wasm generates a world (spec 5 "keeping old worlds
// working"): a world pins its genVersion forever, so online play compiles
// the generator the zone's world was minted with (Welcome.genVersion). The
// current build is worldgen/pkg/worldgen.wasm; superseded builds live in
// worldgen/archive/ (manifest.json) and are bundled as hashed assets, loaded
// only when a world asks for them.

import currentUrl from '../../../../worldgen/pkg/worldgen.wasm?url';
import archive from '../../../../worldgen/archive/manifest.json';

const archived = import.meta.glob('../../../../worldgen/archive/*.wasm', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/**
 * The wasm URL for a world's genVersion ("2", "v2", 2). Unknown, placeholder
 * or current versions get the current build; a version in the archive gets
 * its archived build.
 */
export function wasmUrlFor(genVersion?: string | number | null): string {
  const n = typeof genVersion === 'number' ? genVersion : Number.parseInt(String(genVersion ?? '').replace(/^v/, ''), 10);
  if (!Number.isFinite(n)) return currentUrl;
  const entry = (archive.versions as { genVersion: number; file: string }[]).find((v) => v.genVersion === n);
  if (!entry) return currentUrl;
  const key = Object.keys(archived).find((k) => k.endsWith(`/${entry.file}`));
  return key ? archived[key] : currentUrl;
}

/** Archived genVersions this client can load besides the current build. */
export const archivedGenVersions = (archive.versions as { genVersion: number }[]).map((v) => v.genVersion);

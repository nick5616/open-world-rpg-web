// normalize(): the one gate every creator-made WorldSpec passes before it is
// previewed or minted (spec 6): structural validation -> clamp -> strict
// validation. The Go endpoint (tools/creator/server/internal/spec) is a line-
// by-line port; tools/creator/fixtures/normalize.json holds inputs and the
// exact outputs both must produce (`npm run fixtures -w @lodestone/creator`
// regenerates it from test/fixture-cases.ts).
//
// Rules, in the order fields appear in the schema's top-level `required`
// list (an array, so both languages walk it in the same order):
//   - numbers: clamped to the schema's [minimum, maximum]; integer fields are
//     then rounded half-up (floor(x + 0.5): JS Math.round and Go math.Round
//     disagree on negative halves, and the clamp makes this nonnegative-safe
//     anyway);
//   - weight groups: each weight clamped to [0, 1], then divided by the
//     group's largest weight so the strongest is exactly 1 (all zero -> all
//     1). That is the generator's own normalization (worldgen
//     atlas/climate.rs divides biome weights by their max), so the stored
//     numbers are the ones the generator effectively uses, and it is exactly
//     idempotent (max / max == 1 in IEEE arithmetic);
//   - name: characters outside [A-Za-z0-9' -] become spaces, spaces collapse,
//     trimmed, cut to 40; fewer than 3 left, or a word starting with a
//     blocked stem (the worldgen name blocklist), is a rejection;
//   - seed: canonical decimal (no leading zeros); above 2^64-1 is a rejection;
//   - lootThemes: unknown tags, repeats and tags past the 4th are dropped;
//   - palette, nameGrammar: enums; an unknown value is a rejection (there is
//     nothing sensible to clamp it to).
import type { WorldSpec } from '@lodestone/contracts';
import { STRICT_SCHEMA, validateRelaxed, validateStrict } from './schema';

export type ChangeReason =
  | 'clamped'
  | 'rounded'
  | 'renormalized'
  | 'name-cleaned'
  | 'seed-canonical'
  | 'dropped-unknown-tag'
  | 'dropped-duplicate'
  | 'dropped-over-limit';

/** One repair the clamp made. `from`/`to` are the field's values around this step. */
export interface Change {
  path: string;
  reason: ChangeReason;
  from: unknown;
  to: unknown;
}

export type NormalizeResult = { ok: true; spec: WorldSpec; changes: Change[] } | { ok: false; errors: string[] };

/**
 * Stems that must not start any word of a world name. Same list as
 * worldgen/src/names.rs BLOCKLIST ("inspired by, never copied", spec 2), but
 * matched per word prefix instead of anywhere, because creators type real
 * words ("Lavender", "Wanderer") that a substring match would refuse.
 */
export const NAME_BLOCKLIST = [
  'hyrul', 'zelda', 'ganon', 'hylia', 'kakarik', 'gerudo', 'goron', 'zora', 'rito', 'korok', 'sheikah', 'epona',
  'creeper', 'ender', 'nether', 'herobrine', 'steve', 'valheim', 'midgard', 'asgard', 'yggdras', 'odin',
  'nazi', 'fuck', 'shit', 'cunt', 'rape', 'slut', 'piss',
];

type Obj = Record<string, unknown>;
const props = STRICT_SCHEMA.properties as Record<string, Obj>;
const UINT64_MAX = (1n << 64n) - 1n;

const roundHalfUp = (x: number) => Math.floor(x + 0.5);
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Clean a display name; returns the cleaned text (may be too short). */
export function cleanName(name: string): string {
  let out = '';
  for (const ch of name) out += /^[A-Za-z0-9' -]$/.test(ch) ? ch : ' ';
  out = out.replace(/ +/g, ' ').trim();
  const max = props.name.maxLength as number;
  if (out.length > max) out = out.slice(0, max).trimEnd();
  return out;
}

/** The blocked stem a name's word starts with, or null. */
export function blockedStem(name: string): string | null {
  for (const word of name.toLowerCase().split(/[ '-]+/)) {
    if (!word) continue;
    const hit = NAME_BLOCKLIST.find((b) => word.startsWith(b));
    if (hit) return hit;
  }
  return null;
}

/** Validate, clamp and re-validate an untrusted WorldSpec-shaped value. */
export function normalize(input: unknown): NormalizeResult {
  const structural = validateRelaxed(input);
  if (structural.length) return { ok: false, errors: structural };
  const spec = structuredClone(input) as Obj;
  const changes: Change[] = [];
  const errors: string[] = [];
  const note = (path: string, reason: ChangeReason, from: unknown, to: unknown) => changes.push({ path, reason, from, to });

  const clampNumber = (path: string, v: number, schema: Obj): number => {
    const lo = schema.minimum as number;
    const hi = schema.maximum as number;
    // "+ 0" turns -0 into 0: JSON.stringify writes -0 as "0" but Go writes
    // "-0", and the two must serialize identically.
    let out = clamp(v, lo, hi) + 0;
    if (out !== v) note(path, 'clamped', v, out);
    if (schema.type === 'integer') {
      const r = roundHalfUp(out);
      if (r !== out) note(path, 'rounded', out, r);
      out = r;
    }
    return out;
  };

  for (const key of STRICT_SCHEMA.required as string[]) {
    const schema = props[key];
    const v = spec[key];
    if (schema.type === 'number' || schema.type === 'integer') {
      spec[key] = clampNumber(key, v as number, schema);
    } else if (schema.type === 'object') {
      const group = v as Record<string, number>;
      const keys = schema.required as string[];
      const sub = schema.properties as Record<string, Obj>;
      for (const k of keys) group[k] = clampNumber(`${key}.${k}`, group[k], sub[k]);
      let max = 0;
      for (const k of keys) if (group[k] > max) max = group[k];
      if (max !== 1) {
        for (const k of keys) {
          const next = max === 0 ? 1 : group[k] / max;
          if (next !== group[k]) note(`${key}.${k}`, 'renormalized', group[k], next);
          group[k] = next;
        }
      }
    } else if (key === 'name') {
      const cleaned = cleanName(v as string);
      if (cleaned !== v) note(key, 'name-cleaned', v, cleaned);
      spec[key] = cleaned;
      const min = schema.minLength as number;
      if (cleaned.length < min) errors.push(`/name has fewer than ${min} usable characters`);
      const stem = blockedStem(cleaned);
      if (stem) errors.push(`/name contains a blocked word ("${stem}...")`);
    } else if (key === 'seed') {
      const n = BigInt(v as string);
      if (n > UINT64_MAX) errors.push('/seed is larger than 2^64-1');
      const canon = n.toString();
      if (canon !== v) note(key, 'seed-canonical', v, canon);
      spec[key] = canon;
    } else if (key === 'lootThemes') {
      const vocab = (schema.items as Obj).enum as string[];
      const max = schema.maxItems as number;
      const out: string[] = [];
      for (const t of v as string[]) {
        if (!vocab.includes(t)) note(key, 'dropped-unknown-tag', t, null);
        else if (out.includes(t)) note(key, 'dropped-duplicate', t, null);
        else if (out.length >= max) note(key, 'dropped-over-limit', t, null);
        else out.push(t);
      }
      spec[key] = out;
    }
    // palette / nameGrammar: enum already enforced by the relaxed schema.
  }
  if (errors.length) return { ok: false, errors };
  const strict = validateStrict(spec);
  if (strict.length) return { ok: false, errors: strict };
  return { ok: true, spec: spec as unknown as WorldSpec, changes };
}

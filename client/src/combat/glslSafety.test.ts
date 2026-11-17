// Playtest 3 kill flash (Linux Chrome): GLSL `pow(x, y)` is undefined for x < 0
// and Mesa / NVIDIA GL return NaN (exp2(y * log2(x))), where Windows ANGLE /
// D3D happens to give x * x. The spell screen effect did
// `exp(-pow((r - w.z) / 0.035, 2.0))`: negative inside every shockwave ring,
// so each kill's shockwave turned a disc of the frame NaN (black / garbled)
// on Linux only. This guards the class: every pow() in the combat, post-
// process and ground-loot shaders takes a base that cannot be negative.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const ROOTS = ['combat', 'world/post', 'ui/inventory/ground', 'ui/spellcards'];

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|glsl)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

/** The first argument of every `pow(` call (balanced parentheses). */
function powBases(src: string): { base: string; line: number }[] {
  const out: { base: string; line: number }[] = [];
  const re = /(?<![\w.])pow\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 1) break;
    }
    out.push({ base: src.slice(start, i).replace(/\s+/g, ' ').replace(/['"+]\s*['"]/g, '').trim(), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Bases that cannot be negative (clamped, abs, a sine mapped to 0..1, a sum of squares). */
const SAFE: RegExp[] = [
  /^max\(/,
  /^clamp\(/,
  /^abs\(/,
  /^[A-Za-z_]\w*$/, // a named value already guarded where it is computed (e.g. `facing = abs(...)`, `s` in the glint = max(0, s))
  /^1\.0 - (clamp|abs)\(/, // 1 - clamp(x, 0, 1)
  /^0\.5 \+ 0\.5 \* sin\(/,
  /^1\.0 \+ g \* g - 2\.0 \* g \* m[um]$/, // Henyey-Greenstein: >= (1 - g)^2
  /^\(c \+ 0\.055\) \/ 1\.055$/, // sRGB to linear, `c` is a non-negative colour
];

describe('GLSL pow() bases', () => {
  it('are never possibly negative (NaN on Mesa / NVIDIA GL)', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const root of ROOTS) {
      let list: string[] = [];
      try {
        list = files(join(SRC, root));
      } catch {
        continue;
      }
      for (const f of list) {
        const src = readFileSync(f, 'utf8');
        for (const { base, line } of powBases(src)) {
          seen++;
          if (!SAFE.some((r) => r.test(base))) bad.push(`${relative(SRC, f).split(sep).join('/')}:${line} pow(${base}, ...)`);
        }
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(bad, 'use max(x, 0.0), or multiply for a square (q * q): pow(x < 0, y) is NaN on Linux GL').toEqual([]);
  });

  it('the spell screen effect squares by multiplication', () => {
    const src = readFileSync(join(SRC, 'combat/fx/screen.ts'), 'utf8');
    expect(src).toMatch(/exp\(-q \* q\)/);
    expect(src).not.toMatch(/exp\(-pow\(/);
  });
});

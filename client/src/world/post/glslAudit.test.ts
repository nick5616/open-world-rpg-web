// Playtest 4 (Linux GPU dark-blue screen): world-wide static audit of every GLSL string in client/src
// for operations the GLSL spec leaves undefined, which Windows ANGLE / D3D11 happens to evaluate
// harmlessly and Mesa / NVIDIA OpenGL turns into NaN (and one NaN pixel is spread over the whole
// frame by the bloom's mip blur: finiteGuard.ts). combat/glslSafety.test.ts keeps its own, narrower
// pow() rule for the combat shaders; this one covers all shaders.
//
//   pow(x < 0, y)              NaN       -> max(x, 0.0) / abs / clamp
//   normalize(dFdx / dFdy)     NaN where a triangle's derivative is 0 (rock bump mapping did this)
//   sqrt / log of <= 0         NaN / -Inf
//   smoothstep(e0 >= e1, ...)  undefined -> 1.0 - smoothstep(e1, e0, x)
//   atan(0, 0)                 undefined -> atan(y, x + 1e-6)
//   acos / asin outside [-1,1] NaN       -> clamp first

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LuminanceMaterial } from 'postprocessing';
import { FINITE_GLSL, guardLuminanceFragment } from './finiteGuard';

const SRC = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|glsl)$/.test(n) && !/\.(test|d)\./.test(n)) out.push(p);
  }
  return out;
}

const GLSL_MARK = /\/\*\s*glsl\s*\*\/|gl_FragColor|gl_Position|mainImage\(|onBeforeCompile/;
const SHADER_FILES = walk(SRC).filter((f) => GLSL_MARK.test(readFileSync(f, 'utf8')));

interface Call {
  file: string;
  line: number;
  args: string[];
}

/** Every `name(` call in the shader files with its top-level arguments (balanced parentheses). TypeScript calls (`Math.pow`, typed parameters) are skipped. */
function calls(name: string): Call[] {
  const out: Call[] = [];
  for (const f of SHADER_FILES) {
    const src = readFileSync(f, 'utf8');
    const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 1;
      let i = m.index + m[0].length;
      let start = i;
      const args: string[] = [];
      for (; i < src.length && depth > 0; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) args.push(src.slice(start, i));
        } else if (ch === ',' && depth === 1) {
          args.push(src.slice(start, i));
          start = i + 1;
        }
      }
      const a = args.map((s) => s.replace(/\s+/g, ' ').trim());
      if (a.some((s) => s.includes(': number'))) continue; // a TypeScript helper of the same name
      out.push({ file: relative(SRC, f).split(sep).join('/'), line: src.slice(0, m.index).split('\n').length, args: a });
    }
  }
  return out;
}

const where = (c: Call, text: string) => `${c.file}:${c.line} ${text}`;
const NUM = /^-?\d+(\.\d*)?(e-?\d+)?$/;

/** Bases / arguments that cannot be negative. */
const NON_NEGATIVE: RegExp[] = [
  /^max\(/,
  /^clamp\(/,
  /^saturate\(/,
  /^abs\(/,
  /^[A-Za-z_]\w*$/, // a named value guarded where it is computed (the combat test reviews the same rule)
  /^1\.0 - (clamp|abs|saturate)\(/,
  /^0\.5 \+ 0\.5 \* sin\(/,
  /^1\.0 \+ g2 - 2\.0 \* MIE_G \* mu$/, // Henyey-Greenstein: >= (1 - g)^2
  /^1\.0 \+ g \* g - 2\.0 \* g \* m[um]$/,
  /^\(c \+ 0\.055\) \/ 1\.055$/, // sRGB to linear, `c` is a non-negative colour
  /^fi \/ 24\.0$/,
  /^1\.0 - ndv$/, // ndv = max(dot(n, V), 0.0)
  /^1\.0 - d$/,
  /^el \+ 6\.07995$/, // el >= -1.5 (airmassY clamps it)
];

describe('GLSL undefined-behaviour audit (all shaders in client/src)', () => {
  it('finds the shaders', () => {
    expect(SHADER_FILES.length).toBeGreaterThan(25);
    expect(calls('smoothstep').length).toBeGreaterThan(50);
  });

  it('pow() bases cannot be negative', () => {
    const bad = calls('pow')
      .filter((c) => c.args.length === 2 && !NON_NEGATIVE.some((r) => r.test(c.args[0])))
      .map((c) => where(c, `pow(${c.args[0]}, ${c.args[1]})`));
    expect(bad, 'pow(x < 0, y) is NaN on Mesa / NVIDIA GL: use max(x, 0.0) or multiply').toEqual([]);
  });

  it('sqrt() takes a non-negative argument', () => {
    const bad = calls('sqrt')
      .filter((c) => c.args.length === 1 && !NON_NEGATIVE.some((r) => r.test(c.args[0])))
      .map((c) => where(c, `sqrt(${c.args[0]})`));
    expect(bad).toEqual([]);
  });

  it('log() / inversesqrt() are not used on unguarded values', () => {
    const bad = [...calls('log'), ...calls('log2'), ...calls('inversesqrt')].filter((c) => !/^max\(/.test(c.args[0])).map((c) => where(c, `${c.args[0]}`));
    expect(bad).toEqual([]);
  });

  it('never normalizes a screen-space derivative (zero on edge-on / sub-pixel triangles)', () => {
    const bad = calls('normalize')
      .filter((c) => /dFd[xy]\(/.test(c.args[0]))
      .map((c) => where(c, `normalize(${c.args[0]})`));
    expect(bad, 'divide by max(length(v), 1e-12) instead').toEqual([]);
  });

  it('smoothstep() with literal edges runs low to high', () => {
    const bad = calls('smoothstep')
      .filter((c) => c.args.length === 3 && NUM.test(c.args[0]) && NUM.test(c.args[1]) && parseFloat(c.args[0]) >= parseFloat(c.args[1]))
      .map((c) => where(c, `smoothstep(${c.args[0]}, ${c.args[1]}, ...)`));
    expect(bad, 'smoothstep with edge0 >= edge1 is undefined: write 1.0 - smoothstep(e1, e0, x)').toEqual([]);
  });

  it('smoothstep() with computed edges is not written high to low as `w, w * k`', () => {
    const bad = calls('smoothstep')
      .filter((c) => c.args.length === 3 && /^(\w+), \1 \* 0?\.\d+$/.test(`${c.args[0]}, ${c.args[1]}`))
      .map((c) => where(c, `smoothstep(${c.args[0]}, ${c.args[1]}, ...)`));
    expect(bad).toEqual([]);
  });

  it('two-argument atan() is nudged off the origin', () => {
    const bad = calls('atan')
      .filter((c) => c.args.length === 2 && !/1e-\d/.test(c.args[1]))
      .map((c) => where(c, `atan(${c.args[0]}, ${c.args[1]})`));
    expect(bad, 'atan(0, 0) is undefined: atan(y, x + 1e-6)').toEqual([]);
  });

  it('acos() / asin() are clamped', () => {
    const bad = [...calls('acos'), ...calls('asin')].filter((c) => !/^clamp\(/.test(c.args[0])).map((c) => where(c, c.args[0]));
    expect(bad).toEqual([]);
  });
});

describe('finite-colour guard (finiteGuard.ts)', () => {
  it('patches postprocessing\'s luminance pass, the bloom input that spreads one NaN over the frame', () => {
    const src = new LuminanceMaterial().fragmentShader;
    const patched = guardLuminanceFragment(src);
    expect(patched).not.toBe(src);
    expect(patched).toContain('texel.rgb=lsFinite(texel.rgb);');
    expect(patched).toContain(FINITE_GLSL);
  });

  it('tests the exponent bits rather than relying on isnan / x != x', () => {
    expect(FINITE_GLSL).toContain('floatBitsToUint');
    expect(FINITE_GLSL).toContain('0x7F800000u');
    expect(FINITE_GLSL).not.toMatch(/isnan|isinf/);
  });
});

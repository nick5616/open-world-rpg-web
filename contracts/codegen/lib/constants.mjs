// constants.yaml -> TS, Go, Rust.
import { HEADER_NOTE, snakeToPascal, gofmt } from './util.mjs';

export function parseConstants(doc) {
  const out = [];
  for (const [group, entries] of Object.entries(doc.groups)) {
    for (const [name, e] of Object.entries(entries)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`constant ${name}: must be UPPER_SNAKE`);
      if (!['f64', 'i32', 'u32', 'string'].includes(e.type)) throw new Error(`constant ${name}: bad type ${e.type}`);
      if (e.type !== 'string' && typeof e.value !== 'number') throw new Error(`constant ${name}: value must be a number`);
      if ((e.type === 'i32' || e.type === 'u32') && !Number.isInteger(e.value)) throw new Error(`constant ${name}: integer expected`);
      out.push({ group, name, ...e });
    }
  }
  return { version: doc.version, list: out };
}

const lit = (c, lang) => {
  if (c.type === 'string') return JSON.stringify(c.value);
  if (c.type === 'f64' && lang === 'rust') return Number.isInteger(c.value) ? `${c.value}.0` : String(c.value);
  return String(c.value);
};

export function genConstantsTs(c) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/constants.yaml', ''];
  let g = '';
  for (const k of c.list) {
    if (k.group !== g) { L.push(`// ---- ${k.group}`); g = k.group; }
    L.push(`/** ${k.doc} */`, `export const ${k.name} = ${lit(k, 'ts')};`);
  }
  return L.join('\n') + '\n';
}

export function genConstantsGo(c) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/constants.yaml', '', '// Package constants holds values shared with the client and worldgen.', 'package constants', ''];
  let g = '';
  for (const k of c.list) {
    if (k.group !== g) { L.push(`// ---- ${k.group}`, ''); g = k.group; }
    const n = snakeToPascal(k.name);
    L.push(`// ${n}: ${k.doc}`);
    if (k.type === 'f64') L.push(`const ${n} float64 = ${lit(k, 'go')}`);
    else L.push(`const ${n} = ${lit(k, 'go')}`);
    L.push('');
  }
  return gofmt(L.join('\n'));
}

export function genConstantsRust(c) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/constants.yaml', '#![allow(dead_code)]', ''];
  const rt = { f64: 'f64', i32: 'i32', u32: 'u32', string: '&str' };
  let g = '';
  for (const k of c.list) {
    if (k.group !== g) { L.push(`// ---- ${k.group}`); g = k.group; }
    L.push(`/// ${k.doc}`, `pub const ${k.name}: ${rt[k.type]} = ${lit(k, 'rust')};`);
  }
  return L.join('\n') + '\n';
}

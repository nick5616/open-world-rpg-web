// worldspec.schema.json -> TS type + ranges, Go struct + ranges, Rust serde struct.
// The schema is the source; generated ranges feed clamping (spec 6: clamp every
// number, drop unknown tags) and the creator tool's sliders.
import { HEADER_NOTE, camelToPascal, goField, gofmt } from './util.mjs';

export function parseWorldSpec(schema) {
  const fields = [];
  const nested = {};
  for (const [name, p] of Object.entries(schema.properties)) {
    if (p.type === 'object') {
      nested[name] = Object.entries(p.properties).map(([k, q]) => ({ name: k, type: q.type, min: q.minimum, max: q.maximum }));
      fields.push({ name, type: 'object', struct: camelToPascal(name) });
    } else if (p.type === 'array') {
      fields.push({ name, type: 'array', enum: p.items.enum, maxItems: p.maxItems });
    } else {
      fields.push({ name, type: p.type, enum: p.enum, min: p.minimum, max: p.maximum, minLength: p.minLength, maxLength: p.maxLength });
    }
  }
  return { fields, nested };
}

export function genWorldSpecTs(w) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/worldspec.schema.json', ''];
  for (const f of w.fields) if (f.enum) {
    const n = camelToPascal(f.name).replace(/s$/, '');
    L.push(`export const ${n.toUpperCase()}_VALUES = [${f.enum.map((v) => `'${v}'`).join(', ')}] as const;`);
    L.push(`export type ${n} = (typeof ${n.toUpperCase()}_VALUES)[number];`, '');
  }
  for (const [name, fs] of Object.entries(w.nested)) {
    L.push(`export interface ${camelToPascal(name)} {`, ...fs.map((f) => `  ${f.name}: number;`), '}', '');
    L.push(`export const ${name.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}_KEYS = [${fs.map((f) => `'${f.name}'`).join(', ')}] as const;`, '');
  }
  L.push('export interface WorldSpec {');
  for (const f of w.fields) {
    let t = f.type === 'integer' || f.type === 'number' ? 'number' : f.type === 'string' ? 'string' : '';
    if (f.enum) t = camelToPascal(f.name).replace(/s$/, '');
    if (f.type === 'object') t = f.struct;
    if (f.type === 'array') t = `${camelToPascal(f.name).replace(/s$/, '')}[]`;
    L.push(`  ${f.name}: ${t};`);
  }
  L.push('}', '');
  L.push('/** Numeric ranges from the schema, for clamping and sliders. Nested weights use "group.key". */');
  L.push('export const WORLDSPEC_RANGES: Record<string, { min: number; max: number; integer: boolean }> = {');
  for (const f of w.fields) if (f.min !== undefined) L.push(`  ${f.name}: { min: ${f.min}, max: ${f.max}, integer: ${f.type === 'integer'} },`);
  for (const [name, fs] of Object.entries(w.nested)) for (const f of fs) L.push(`  '${name}.${f.name}': { min: ${f.min}, max: ${f.max}, integer: false },`);
  L.push('};', '');
  const lt = w.fields.find((f) => f.name === 'lootThemes');
  L.push(`export const LOOT_THEMES_MAX = ${lt?.maxItems ?? 4};`, '');
  return L.join('\n');
}

export function genWorldSpecGo(w) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/worldspec.schema.json', '', '// Package worldspec mirrors the WorldSpec JSON schema.', 'package worldspec', ''];
  for (const [name, fs] of Object.entries(w.nested)) {
    L.push(`type ${camelToPascal(name)} struct {`, ...fs.map((f) => `${goField(f.name)} float64 \`json:"${f.name}"\``), '}', '');
  }
  L.push('// WorldSpec: seed + spec + genVersion fully define a world (spec 5).', 'type WorldSpec struct {');
  for (const f of w.fields) {
    let t = f.type === 'integer' ? 'int' : f.type === 'number' ? 'float64' : 'string';
    if (f.type === 'object') t = f.struct;
    if (f.type === 'array') t = '[]string';
    L.push(`${goField(f.name)} ${t} \`json:"${f.name}"\``);
  }
  L.push('}', '');
  L.push('// Range is a numeric field bound from the schema.', 'type Range struct {', 'Min, Max float64', 'Integer bool', '}', '');
  L.push('// Ranges keys nested weights as "group.key".', 'var Ranges = map[string]Range{');
  for (const f of w.fields) if (f.min !== undefined) L.push(`"${f.name}": {${f.min}, ${f.max}, ${f.type === 'integer'}},`);
  for (const [name, fs] of Object.entries(w.nested)) for (const f of fs) L.push(`"${name}.${f.name}": {${f.min}, ${f.max}, false},`);
  L.push('}', '');
  L.push('// Enums lists allowed values of enum fields (lootThemes items included).', 'var Enums = map[string][]string{');
  for (const f of w.fields) if (f.enum) L.push(`"${f.name}": {${f.enum.map((v) => `"${v}"`).join(', ')}},`);
  L.push('}', '');
  return gofmt(L.join('\n'));
}

export function genWorldSpecRust(w) {
  const L = [`// ${HEADER_NOTE}`, '// Source: contracts/worldspec.schema.json', '#![allow(dead_code)]', '', 'use serde::{Deserialize, Serialize};', ''];
  const snake = (s) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  for (const [name, fs] of Object.entries(w.nested)) {
    L.push('#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]', '#[serde(deny_unknown_fields)]', `pub struct ${camelToPascal(name)} {`);
    for (const f of fs) L.push(`    pub ${f.name === 'void' ? 'r#void' : f.name}: f64,`);
    L.push('}', '');
  }
  L.push('/// Seed + WorldSpec + genVersion fully define a world (spec 5).');
  L.push('#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]', '#[serde(rename_all = "camelCase", deny_unknown_fields)]', 'pub struct WorldSpec {');
  for (const f of w.fields) {
    let t = f.type === 'integer' ? 'i64' : f.type === 'number' ? 'f64' : 'String';
    if (f.type === 'object') t = f.struct;
    if (f.type === 'array') t = 'Vec<String>';
    L.push(`    pub ${snake(f.name)}: ${t},`);
  }
  L.push('}', '');
  for (const f of w.fields) if (f.enum) {
    L.push(`pub const ${snake(f.name).toUpperCase()}_VALUES: &[&str] = &[${f.enum.map((v) => `"${v}"`).join(', ')}];`);
  }
  L.push('');
  L.push('/// (field, min, max, integer). Nested weights use "group.key".');
  L.push('pub const RANGES: &[(&str, f64, f64, bool)] = &[');
  const rl = (v) => (Number.isInteger(v) ? `${v}.0` : String(v));
  for (const f of w.fields) if (f.min !== undefined) L.push(`    ("${f.name}", ${rl(f.min)}, ${rl(f.max)}, ${f.type === 'integer'}),`);
  for (const [name, fs] of Object.entries(w.nested)) for (const f of fs) L.push(`    ("${name}.${f.name}", ${rl(f.min)}, ${rl(f.max)}, false),`);
  L.push('];', '');
  return L.join('\n');
}

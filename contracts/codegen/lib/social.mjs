// social.yaml -> TS types and Go structs for the JSON social socket.
import { HEADER_NOTE, pascal, goField, gofmt } from './util.mjs';

function parseFieldType(t, known) {
  let s = String(t).trim();
  const optional = s.endsWith('?');
  if (optional) s = s.slice(0, -1);
  const array = s.endsWith('[]');
  if (array) s = s.slice(0, -2);
  if (!['string', 'int', 'number', 'bool'].includes(s) && !known.has(s)) throw new Error(`social: unknown type ${s}`);
  return { base: s, array, optional };
}

export function parseSocial(doc) {
  const known = new Set([...Object.keys(doc.enums ?? {}), ...Object.keys(doc.structs ?? {})]);
  const fields = (obj) => Object.entries(obj ?? {}).map(([name, t]) => {
    if (name === 'type') throw new Error('social: field "type" is reserved');
    return { name, ...parseFieldType(t, known) };
  });
  const structs = Object.entries(doc.structs ?? {}).map(([name, f]) => ({ name, fields: fields(f) }));
  const msgs = (dir) => Object.entries(doc.messages[dir] ?? {}).map(([name, f]) => ({ name, dir, fields: fields(f) }));
  return { version: doc.version, enums: doc.enums ?? {}, structs, c2s: msgs('c2s'), s2c: msgs('s2c') };
}

const tsBase = (b) => ({ string: 'string', int: 'number', number: 'number', bool: 'boolean' })[b] ?? b;
const goBase = (b) => ({ string: 'string', int: 'int64', number: 'float64', bool: 'bool' })[b] ?? b;

export function genSocialTs(s) {
  const L = [`// ${HEADER_NOTE}`, `// Source: contracts/social.yaml (version ${s.version})`, '', `export const SOCIAL_PROTOCOL_VERSION = ${s.version};`, ''];
  for (const [name, vals] of Object.entries(s.enums)) {
    L.push(`export const ${name}Values = [${vals.map((v) => `'${v}'`).join(', ')}] as const;`);
    L.push(`export type ${name} = (typeof ${name}Values)[number];`, '');
  }
  const field = (f) => `  ${f.name}${f.optional ? '?' : ''}: ${tsBase(f.base)}${f.array ? '[]' : ''};`;
  for (const st of s.structs) {
    L.push(`export interface ${st.name} {`, ...st.fields.map(field), '}', '');
  }
  for (const dir of ['c2s', 's2c']) {
    const P = dir.toUpperCase();
    for (const m of s[dir]) L.push(`export interface ${P}${pascal(m.name)} {`, `  type: '${m.name}';`, ...m.fields.map(field), '}', '');
    L.push(`export type ${P}Message = ${s[dir].map((m) => `${P}${pascal(m.name)}`).join(' | ')};`, '');
  }
  return L.join('\n');
}

export function genSocialGo(s) {
  const L = [`// ${HEADER_NOTE}`, `// Source: contracts/social.yaml (version ${s.version})`, '', '// Package socialproto holds the social socket JSON message types.', 'package socialproto', ''];
  L.push(`const Version = ${s.version}`, '');
  for (const [name, vals] of Object.entries(s.enums)) {
    L.push(`type ${name} string`, '', 'const (');
    for (const v of vals) L.push(`${name}${pascal(v)} ${name} = "${v}"`);
    L.push(')', '');
  }
  const field = (f) => {
    const t = `${f.array ? '[]' : f.optional && !['string', 'int', 'number', 'bool'].includes(f.base) && !s.enums[f.base] ? '*' : ''}${goBase(f.base)}`;
    return `${goField(f.name)} ${t} \`json:"${f.name}${f.optional ? ',omitempty' : ''}"\``;
  };
  for (const st of s.structs) L.push(`type ${st.name} struct {`, ...st.fields.map(field), '}', '');
  for (const dir of ['c2s', 's2c']) {
    const P = dir.toUpperCase();
    L.push(`// Type names for ${dir} messages.`, 'const (');
    for (const m of s[dir]) L.push(`${P}Type${pascal(m.name)} = "${m.name}"`);
    L.push(')', '');
    for (const m of s[dir]) {
      L.push(`type ${P}${pascal(m.name)} struct {`, 'Type string `json:"type"`', ...m.fields.map(field), '}', '');
    }
  }
  return gofmt(L.join('\n'));
}

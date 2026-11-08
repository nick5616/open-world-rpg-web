// Binary zone protocol generator: protocol.yaml -> TS codec, Go codec, golden vectors.
//
// Three implementations of the same wire format exist on purpose:
//   1. a generic reference encoder here (interprets the schema at gen time),
//   2. the generated TypeScript codec,
//   3. the generated Go codec.
// The reference encoder writes the golden byte vectors; TS and Go tests must
// decode them to the same values and re-encode them to the same bytes. A bug
// would have to appear identically in two independent code paths to slip by.
import { HEADER_NOTE, goField, pascal, rng, strHash, gofmt } from './util.mjs';

const PRIMS = {
  u8: { size: 1, ts: 'number', go: 'uint8', min: 0, max: 255 },
  u16: { size: 2, ts: 'number', go: 'uint16', min: 0, max: 65535 },
  u32: { size: 4, ts: 'number', go: 'uint32', min: 0, max: 4294967295 },
  i8: { size: 1, ts: 'number', go: 'int8', min: -128, max: 127 },
  i16: { size: 2, ts: 'number', go: 'int16', min: -32768, max: 32767 },
  i32: { size: 4, ts: 'number', go: 'int32', min: -2147483648, max: 2147483647 },
  u64: { size: 8, ts: 'bigint', go: 'uint64', min: 0n, max: 18446744073709551615n },
  i64: { size: 8, ts: 'bigint', go: 'int64', min: -9223372036854775808n, max: 9223372036854775807n },
  f32: { size: 4, ts: 'number', go: 'float32' },
  f64: { size: 8, ts: 'number', go: 'float64' },
  bool: { size: 1, ts: 'boolean', go: 'bool' },
  string: { ts: 'string', go: 'string' },
  bytes: { ts: 'Uint8Array', go: '[]byte' },
};

const GO_RW = { u8: 'U8', u16: 'U16', u32: 'U32', i8: 'I8', i16: 'I16', i32: 'I32', u64: 'U64', i64: 'I64', f32: 'F32', f64: 'F64', bool: 'Bool', string: 'Str', bytes: 'Bytes' };
const TS_RW = { u8: 'u8', u16: 'u16', u32: 'u32', i8: 'i8', i16: 'i16', i32: 'i32', u64: 'u64', i64: 'i64', f32: 'f32', f64: 'f64', bool: 'bool', string: 'str', bytes: 'bytes' };

// ---------------------------------------------------------------- parsing

export function parseProtocol(doc) {
  const enums = {};
  for (const [name, e] of Object.entries(doc.enums ?? {})) {
    if (!PRIMS[e.type] || PRIMS[e.type].ts !== 'number') throw new Error(`enum ${name}: bad base type ${e.type}`);
    enums[name] = { name, base: e.type, values: e.values };
  }
  const flags = {};
  for (const [name, f] of Object.entries(doc.flags ?? {})) flags[name] = { name, base: f.type, bits: f.bits };

  const structNames = new Set(Object.keys(doc.structs ?? {}));
  const parseType = (t, where) => {
    t = String(t).trim();
    const m = /^list<(.+)>$/.exec(t);
    if (m) return { k: 'list', of: parseType(m[1], where) };
    if (PRIMS[t]) return { k: 'prim', name: t };
    if (enums[t]) return { k: 'enum', name: t, base: enums[t].base };
    if (structNames.has(t)) return { k: 'struct', name: t };
    throw new Error(`${where}: unknown type '${t}'`);
  };
  const parseFields = (fields, where) =>
    Object.entries(fields ?? {}).map(([name, spec]) => {
      if (name === 'type') throw new Error(`${where}: field name 'type' is reserved for the TS discriminant`);
      const s = typeof spec === 'object' && spec !== null ? spec : { type: spec };
      return { name, type: parseType(s.type, `${where}.${name}`), always: !!s.always };
    });

  const structs = {};
  for (const [name, s] of Object.entries(doc.structs ?? {})) {
    const fields = parseFields(s.fields, name);
    const mask = s.mask ?? null;
    if (mask && !['u8', 'u16', 'u32'].includes(mask)) throw new Error(`${name}: mask must be u8/u16/u32`);
    const masked = mask ? fields.filter((f) => !f.always) : [];
    if (mask && masked.length > PRIMS[mask].size * 8) throw new Error(`${name}: too many masked fields for ${mask}`);
    structs[name] = { name, doc: s.doc, fields, mask, masked };
  }
  const messages = [];
  const ids = new Set();
  for (const [name, m] of Object.entries(doc.messages ?? {})) {
    if (ids.has(m.id)) throw new Error(`duplicate message id ${m.id}`);
    ids.add(m.id);
    if (!['c2s', 's2c'].includes(m.dir)) throw new Error(`${name}: dir must be c2s or s2c`);
    if (!['unreliable', 'reliable', 'chunk'].includes(m.delivery)) throw new Error(`${name}: bad delivery`);
    messages.push({ name, id: m.id, dir: m.dir, delivery: m.delivery, doc: m.doc, fields: parseFields(m.fields, name) });
  }
  return { version: doc.version, enums, flags, structs, messages };
}

// ---------------------------------------------------------------- reference encoder (JSON-friendly values)

class RefWriter {
  constructor() { this.parts = []; }
  push(buf) { this.parts.push(Buffer.from(buf)); }
  prim(t, v) {
    const b = Buffer.alloc(PRIMS[t].size ?? 0);
    switch (t) {
      case 'u8': b.writeUInt8(v); break;
      case 'u16': b.writeUInt16LE(v); break;
      case 'u32': b.writeUInt32LE(v); break;
      case 'i8': b.writeInt8(v); break;
      case 'i16': b.writeInt16LE(v); break;
      case 'i32': b.writeInt32LE(v); break;
      case 'u64': b.writeBigUInt64LE(BigInt(v)); break;
      case 'i64': b.writeBigInt64LE(BigInt(v)); break;
      case 'f32': b.writeFloatLE(v); break;
      case 'f64': b.writeDoubleLE(v); break;
      case 'bool': b.writeUInt8(v ? 1 : 0); break;
      case 'string': {
        const s = Buffer.from(v, 'utf8');
        const l = Buffer.alloc(2); l.writeUInt16LE(s.length); this.push(l); this.push(s); return;
      }
      case 'bytes': {
        const s = Buffer.from(v, 'hex');
        const l = Buffer.alloc(4); l.writeUInt32LE(s.length); this.push(l); this.push(s); return;
      }
    }
    this.push(b);
  }
  done() { return Buffer.concat(this.parts); }
}

function refWriteType(p, w, type, v) {
  switch (type.k) {
    case 'prim': return w.prim(type.name, v);
    case 'enum': return w.prim(type.base, v);
    case 'list': {
      w.prim('u16', v.length);
      for (const it of v) refWriteType(p, w, type.of, it);
      return;
    }
    case 'struct': return refWriteStruct(p, w, p.structs[type.name], v);
  }
}

function refWriteStruct(p, w, s, v) {
  if (!s.mask) {
    for (const f of s.fields) refWriteType(p, w, f.type, v[f.name]);
    return;
  }
  for (const f of s.fields) if (f.always) refWriteType(p, w, f.type, v[f.name]);
  let mask = 0;
  s.masked.forEach((f, i) => { if (v[f.name] !== undefined) mask |= 1 << i; });
  w.prim(s.mask, mask >>> 0);
  for (const f of s.masked) if (v[f.name] !== undefined) refWriteType(p, w, f.type, v[f.name]);
}

export function refEncodeMessage(p, msg, value) {
  const w = new RefWriter();
  w.prim('u8', msg.id);
  for (const f of msg.fields) refWriteType(p, w, f.type, value[f.name]);
  return w.done();
}

// ---------------------------------------------------------------- sample values for vectors

const F32_SAMPLES = [0, 1.5, -2.25, 1024.125, 0.0078125, -65504];
const STR_SAMPLES = ['', 'Nicole', 'héllo ✨ wörld', 'Ember Vale of Kesh'];

function sample(p, type, mode, r) {
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  switch (type.k) {
    case 'enum': {
      const vals = Object.values(p.enums[type.name].values);
      return mode === 'min' ? Math.min(...vals) : mode === 'max' ? Math.max(...vals) : pick(vals);
    }
    case 'prim': {
      const t = type.name, P = PRIMS[t];
      if (t === 'bool') return mode === 'min' ? false : mode === 'max' ? true : r() < 0.5;
      if (t === 'f32') return mode === 'min' ? -65504 : mode === 'max' ? 1024.125 : pick(F32_SAMPLES);
      if (t === 'f64') return mode === 'min' ? -1e300 : mode === 'max' ? 1731024000123.25 : Math.round(r() * 1e9) / 64;
      if (t === 'string') return mode === 'min' ? '' : mode === 'max' ? 'é'.repeat(40) : pick(STR_SAMPLES);
      if (t === 'bytes') {
        const n = mode === 'min' ? 0 : mode === 'max' ? 16 : 1 + Math.floor(r() * 8);
        return Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256))).toString('hex');
      }
      if (t === 'u64' || t === 'i64') {
        if (mode === 'min') return P.min.toString();
        if (mode === 'max') return P.max.toString();
        const hi = BigInt(Math.floor(r() * 2 ** 31)), lo = BigInt(Math.floor(r() * 2 ** 32));
        let v = (hi << 32n) | lo;
        if (t === 'i64' && r() < 0.5) v = -v;
        return v.toString();
      }
      if (mode === 'min') return P.min;
      if (mode === 'max') return P.max;
      return P.min + Math.floor(r() * (P.max - P.min + 1));
    }
    case 'list': {
      const n = mode === 'min' ? 0 : mode === 'max' ? 3 : 1 + Math.floor(r() * 2);
      return Array.from({ length: n }, (_, i) => sample(p, type.of, mode === 'rand' || i % 2 ? 'rand' : mode, r));
    }
    case 'struct': {
      const s = p.structs[type.name];
      const v = {};
      s.fields.forEach((f, i) => {
        // 'rand' leaves out every other masked field, exercising sparse masks.
        if (s.mask && !f.always && mode === 'rand' && (i + Math.floor(r() * 2)) % 2) return;
        if (s.mask && !f.always && mode === 'min') return; // empty mask
        v[f.name] = sample(p, f.type, mode, r);
      });
      return v;
    }
  }
}

export function buildVectors(p) {
  const vectors = [];
  for (const msg of p.messages) {
    for (const mode of ['min', 'max', 'rand']) {
      const r = rng(strHash(msg.name + mode));
      const value = {};
      for (const f of msg.fields) value[f.name] = sample(p, f.type, mode, r);
      vectors.push({ message: msg.name, case: mode, value, hex: refEncodeMessage(p, msg, value).toString('hex') });
    }
  }
  return { protocolVersion: p.version, note: HEADER_NOTE, vectors };
}

// ---------------------------------------------------------------- TypeScript

function tsType(p, t) {
  switch (t.k) {
    case 'prim': return PRIMS[t.name].ts;
    case 'enum': return 'number';
    case 'struct': return t.name;
    case 'list': return `${tsType(p, t.of)}[]`;
  }
}

function tsWrite(t, e, depth = 0) {
  switch (t.k) {
    case 'prim': return `w.${TS_RW[t.name]}(${e});`;
    case 'enum': return `w.${TS_RW[t.base]}(${e});`;
    case 'struct': return `write${t.name}(w, ${e});`;
    case 'list': {
      const it = `it${depth}`;
      return `w.u16(${e}.length); for (const ${it} of ${e}) { ${tsWrite(t.of, it, depth + 1)} }`;
    }
  }
}

function tsRead(t) {
  switch (t.k) {
    case 'prim': return `r.${TS_RW[t.name]}()`;
    case 'enum': return `r.${TS_RW[t.base]}()`;
    case 'struct': return `read${t.name}(r)`;
    case 'list': return `r.list(() => ${tsRead(t.of)})`;
  }
}

export function genTs(p) {
  const L = [];
  L.push(`// ${HEADER_NOTE}`, `// Source: contracts/protocol.yaml (version ${p.version})`, '/* eslint-disable */', '');
  L.push(`import { Writer, Reader } from '../wire';`, '');
  L.push(`export const PROTOCOL_VERSION = ${p.version};`, '');
  for (const e of Object.values(p.enums)) {
    L.push(`export const ${e.name} = {`);
    for (const [k, v] of Object.entries(e.values)) L.push(`  ${k}: ${v},`);
    L.push('} as const;', '');
  }
  for (const f of Object.values(p.flags)) {
    L.push(`export const ${f.name} = {`);
    for (const [k, b] of Object.entries(f.bits)) L.push(`  ${k}: ${2 ** b},`);
    L.push('} as const;', '');
  }
  for (const s of Object.values(p.structs)) {
    if (s.doc) L.push(`/** ${s.doc} */`);
    L.push(`export interface ${s.name} {`);
    for (const f of s.fields) L.push(`  ${f.name}${s.mask && !f.always ? '?' : ''}: ${tsType(p, f.type)};`);
    L.push('}', '');
    if (s.mask) {
      L.push(`export const ${s.name}Bits = {`);
      s.masked.forEach((f, i) => L.push(`  ${f.name}: ${2 ** i},`));
      L.push('} as const;', '');
    }
    L.push(`export function write${s.name}(w: Writer, v: ${s.name}): void {`);
    if (!s.mask) {
      for (const f of s.fields) L.push(`  ${tsWrite(f.type, `v.${f.name}`)}`);
    } else {
      for (const f of s.fields.filter((f) => f.always)) L.push(`  ${tsWrite(f.type, `v.${f.name}`)}`);
      L.push('  let mask = 0;');
      s.masked.forEach((f, i) => L.push(`  if (v.${f.name} !== undefined) mask |= ${2 ** i};`));
      L.push(`  w.${s.mask}(mask >>> 0);`);
      for (const f of s.masked) L.push(`  if (v.${f.name} !== undefined) { ${tsWrite(f.type, `v.${f.name}`)} }`);
    }
    L.push('}', '');
    L.push(`export function read${s.name}(r: Reader): ${s.name} {`);
    if (!s.mask) {
      L.push(`  return {`);
      for (const f of s.fields) L.push(`    ${f.name}: ${tsRead(f.type)},`);
      L.push('  };');
    } else {
      L.push(`  const v = {} as ${s.name};`);
      for (const f of s.fields.filter((f) => f.always)) L.push(`  v.${f.name} = ${tsRead(f.type)};`);
      L.push(`  const mask = r.${s.mask}();`);
      s.masked.forEach((f, i) => L.push(`  if (mask & ${2 ** i}) v.${f.name} = ${tsRead(f.type)};`));
      L.push('  return v;');
    }
    L.push('}', '');
  }
  L.push('export const MSG_ID = {');
  for (const m of p.messages) L.push(`  ${m.name}: ${m.id},`);
  L.push('} as const;', '');
  L.push(`export type Delivery = 'unreliable' | 'reliable' | 'chunk';`);
  L.push('export const MSG_DELIVERY: Record<number, Delivery> = {');
  for (const m of p.messages) L.push(`  ${m.id}: '${m.delivery}',`);
  L.push('};', '');
  for (const m of p.messages) {
    if (m.doc) L.push(`/** ${m.doc} */`);
    L.push(`export interface ${m.name} {`, `  type: '${m.name}';`);
    for (const f of m.fields) L.push(`  ${f.name}: ${tsType(p, f.type)};`);
    L.push('}', '');
  }
  const c2s = p.messages.filter((m) => m.dir === 'c2s').map((m) => m.name);
  const s2c = p.messages.filter((m) => m.dir === 's2c').map((m) => m.name);
  L.push(`export type ClientMessage = ${c2s.join(' | ')};`);
  L.push(`export type ServerMessage = ${s2c.join(' | ')};`);
  L.push('export type AnyMessage = ClientMessage | ServerMessage;', '');
  L.push('/** Append one framed message ([id][body]) to `w`. */');
  L.push('export function writeMessage(w: Writer, m: AnyMessage): void {');
  L.push('  switch (m.type) {');
  for (const m of p.messages) {
    L.push(`    case '${m.name}':`, `      w.u8(${m.id});`);
    for (const f of m.fields) L.push(`      ${tsWrite(f.type, `m.${f.name}`)}`);
    L.push('      return;');
  }
  L.push('  }', '}', '');
  L.push('/** Encode one message into a fresh Uint8Array. Hot paths should reuse a Writer with writeMessage. */');
  L.push('export function encodeMessage(m: AnyMessage): Uint8Array {');
  L.push('  const w = new Writer(64);', '  writeMessage(w, m);', '  return w.finish();', '}', '');
  L.push('/** Decode one framed message. Throws on unknown ids, truncation or trailing bytes. */');
  L.push('export function decodeMessage(buf: Uint8Array): AnyMessage {');
  L.push('  const r = new Reader(buf);', '  const id = r.u8();', '  let m: AnyMessage;', '  switch (id) {');
  for (const m of p.messages) {
    L.push(`    case ${m.id}:`, `      m = {`, `        type: '${m.name}',`);
    for (const f of m.fields) L.push(`        ${f.name}: ${tsRead(f.type)},`);
    L.push('      };', '      break;');
  }
  L.push('    default:', '      throw new RangeError(`unknown message id ${id}`);', '  }', '  r.end();', '  return m;', '}', '');
  return L.join('\n');
}

// ---------------------------------------------------------------- Go

function goType(p, t) {
  switch (t.k) {
    case 'prim': return PRIMS[t.name].go;
    case 'enum': return t.name;
    case 'struct': return t.name;
    case 'list': return `[]${goType(p, t.of)}`;
  }
}

function goWrite(t, e, depth = 0) {
  switch (t.k) {
    case 'prim': return `w.${GO_RW[t.name]}(${e})`;
    case 'enum': return `w.${GO_RW[t.base]}(${PRIMS[t.base].go}(${e}))`;
    case 'struct': return `${e}.Write(w)`;
    case 'list': {
      const i = `i${depth}`;
      return `w.U16(uint16(len(${e})))\nfor ${i} := range ${e} {\n${goWrite(t.of, `${e}[${i}]`, depth + 1)}\n}`;
    }
  }
}

function goRead(t, target, depth = 0) {
  switch (t.k) {
    case 'prim': return `${target} = r.${GO_RW[t.name]}()`;
    case 'enum': return `${target} = ${t.name}(r.${GO_RW[t.base]}())`;
    case 'struct': return `${target}.Read(r)`;
    case 'list': {
      const n = `n${depth}`, i = `i${depth}`;
      // Braced so two list fields in one body don't redeclare n0.
      return `{\n${n} := r.Count()\n${target} = make(${`[]${goTypeOf(t.of)}`}, ${n})\nfor ${i} := 0; ${i} < ${n}; ${i}++ {\n${goRead(t.of, `${target}[${i}]`, depth + 1)}\n}\n}`;
    }
  }
}
// goTypeOf without parser context (types are self-describing).
function goTypeOf(t) {
  switch (t.k) {
    case 'prim': return PRIMS[t.name].go;
    case 'enum': case 'struct': return t.name;
    case 'list': return `[]${goTypeOf(t.of)}`;
  }
}

function goJSON(t, e, depth = 0) {
  switch (t.k) {
    case 'prim':
      if (t.name === 'u64' || t.name === 'i64') return `fmt.Sprint(${e})`;
      if (t.name === 'bytes') return `hex.EncodeToString(${e})`;
      if (t.name === 'f32') return `float64(${e})`;
      return e;
    case 'enum': return `${PRIMS[t.base].go}(${e})`;
    case 'struct': return `${e}.ToJSON()`;
    case 'list': {
      const i = `j${depth}`;
      return `func() []any { out := make([]any, len(${e})); for ${i} := range ${e} { out[${i}] = ${goJSON(t.of, `${e}[${i}]`, depth + 1)} }; return out }()`;
    }
  }
}

export function genGo(p) {
  const L = [];
  L.push(`// ${HEADER_NOTE}`, `// Source: contracts/protocol.yaml (version ${p.version})`, '', 'package proto', '');
  L.push('import (', '"encoding/hex"', '"fmt"', ')', '');
  L.push('var _ = hex.EncodeToString', 'var _ = fmt.Sprint', '');
  L.push(`// ProtocolVersion is checked at Hello; mismatched clients are kicked.`, `const ProtocolVersion = ${p.version}`, '');
  for (const e of Object.values(p.enums)) {
    L.push(`type ${e.name} ${PRIMS[e.base].go}`, '', 'const (');
    for (const [k, v] of Object.entries(e.values)) L.push(`${e.name}${pascal(k)} ${e.name} = ${v}`);
    L.push(')', '');
  }
  for (const f of Object.values(p.flags)) {
    L.push('const (');
    for (const [k, b] of Object.entries(f.bits)) L.push(`${f.name}${pascal(k)} ${PRIMS[f.base].go} = 1 << ${b}`);
    L.push(')', '');
  }
  for (const s of Object.values(p.structs)) {
    if (s.doc) L.push(`// ${s.name}: ${s.doc}`);
    L.push(`type ${s.name} struct {`);
    for (const f of s.fields.filter((f) => f.always || !s.mask)) L.push(`${goField(f.name)} ${goType(p, f.type)}`);
    if (s.mask) {
      L.push(`// Mask says which of the fields below are present (${s.name}Has* bits).`);
      L.push(`Mask ${PRIMS[s.mask].go}`);
      for (const f of s.masked) L.push(`${goField(f.name)} ${goType(p, f.type)}`);
    }
    L.push('}', '');
    if (s.mask) {
      L.push('const (');
      s.masked.forEach((f, i) => L.push(`${s.name}Has${goField(f.name)} ${PRIMS[s.mask].go} = 1 << ${i}`));
      L.push(')', '');
    }
    L.push(`func (v *${s.name}) Write(w *Writer) {`);
    if (!s.mask) for (const f of s.fields) L.push(goWrite(f.type, `v.${goField(f.name)}`));
    else {
      for (const f of s.fields.filter((f) => f.always)) L.push(goWrite(f.type, `v.${goField(f.name)}`));
      L.push(`w.${GO_RW[s.mask]}(v.Mask)`);
      s.masked.forEach((f) => L.push(`if v.Mask&${s.name}Has${goField(f.name)} != 0 {`, goWrite(f.type, `v.${goField(f.name)}`), '}'));
    }
    L.push('}', '');
    L.push(`func (v *${s.name}) Read(r *Reader) {`);
    if (!s.mask) for (const f of s.fields) L.push(goRead(f.type, `v.${goField(f.name)}`));
    else {
      for (const f of s.fields.filter((f) => f.always)) L.push(goRead(f.type, `v.${goField(f.name)}`));
      L.push(`v.Mask = r.${GO_RW[s.mask]}()`);
      s.masked.forEach((f) => L.push(`if v.Mask&${s.name}Has${goField(f.name)} != 0 {`, goRead(f.type, `v.${goField(f.name)}`), '}'));
    }
    L.push('}', '');
    L.push(`// ToJSON renders present fields the way contracts/golden vectors spell them.`);
    L.push(`func (v *${s.name}) ToJSON() map[string]any {`, 'out := map[string]any{}');
    for (const f of s.fields) {
      const set = `out["${f.name}"] = ${goJSON(f.type, `v.${goField(f.name)}`)}`;
      if (s.mask && !f.always) L.push(`if v.Mask&${s.name}Has${goField(f.name)} != 0 {`, set, '}');
      else L.push(set);
    }
    L.push('return out', '}', '');
  }
  L.push('// Message is any framed zone protocol message.');
  L.push('type Message interface {', 'MsgID() uint8', 'WriteBody(w *Writer)', 'ReadBody(r *Reader)', 'ToJSON() map[string]any', '}', '');
  L.push('// Delivery classes (spec 9).', 'type Delivery uint8', '', 'const (', 'Unreliable Delivery = iota', 'Reliable', 'PerChunk', ')', '');
  L.push('const (');
  for (const m of p.messages) L.push(`Msg${m.name} uint8 = ${m.id}`);
  L.push(')', '');
  L.push('// DeliveryOf maps a message id to its delivery class.', 'func DeliveryOf(id uint8) Delivery {', 'switch id {');
  for (const m of p.messages) L.push(`case ${m.id}:`, `return ${m.delivery === 'unreliable' ? 'Unreliable' : m.delivery === 'reliable' ? 'Reliable' : 'PerChunk'}`);
  L.push('}', 'return Reliable', '}', '');
  for (const m of p.messages) {
    L.push(`// ${m.name} (${m.dir}, ${m.delivery})${m.doc ? ': ' + m.doc : ''}`);
    L.push(`type ${m.name} struct {`);
    for (const f of m.fields) L.push(`${goField(f.name)} ${goType(p, f.type)}`);
    L.push('}', '');
    L.push(`func (*${m.name}) MsgID() uint8 { return ${m.id} }`, '');
    L.push(`func (m *${m.name}) WriteBody(w *Writer) {`);
    for (const f of m.fields) L.push(goWrite(f.type, `m.${goField(f.name)}`));
    L.push('}', '');
    L.push(`func (m *${m.name}) ReadBody(r *Reader) {`);
    for (const f of m.fields) L.push(goRead(f.type, `m.${goField(f.name)}`));
    L.push('}', '');
    L.push(`func (m *${m.name}) ToJSON() map[string]any {`, 'out := map[string]any{}');
    for (const f of m.fields) L.push(`out["${f.name}"] = ${goJSON(f.type, `m.${goField(f.name)}`)}`);
    L.push('return out', '}', '');
  }
  L.push('// NewMessage returns an empty message for an id, or nil if unknown.', 'func NewMessage(id uint8) Message {', 'switch id {');
  for (const m of p.messages) L.push(`case ${m.id}:`, `return &${m.name}{}`);
  L.push('}', 'return nil', '}', '');
  L.push('// MessageName returns the protocol.yaml name for an id.', 'func MessageName(id uint8) string {', 'switch id {');
  for (const m of p.messages) L.push(`case ${m.id}:`, `return "${m.name}"`);
  L.push('}', 'return fmt.Sprintf("unknown(%d)", id)', '}', '');
  return gofmt(L.join('\n'));
}

export function genGoVectorTest() {
  return gofmt(`// ${HEADER_NOTE}

package proto

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type vectorFile struct {
	ProtocolVersion int \`json:"protocolVersion"\`
	Vectors         []struct {
		Message string         \`json:"message"\`
		Case    string         \`json:"case"\`
		Value   map[string]any \`json:"value"\`
		Hex     string         \`json:"hex"\`
	} \`json:"vectors"\`
}

// normalize round-trips through JSON so Go ints and JSON float64s compare equal.
func normalize(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestGoldenVectors: decode each reference vector to the expected values, then
// re-encode it to the exact same bytes (spec 14, protocol golden vectors).
func TestGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "golden", "protocol_vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatal(err)
	}
	if vf.ProtocolVersion != ProtocolVersion {
		t.Fatalf("vector file version %d != ProtocolVersion %d", vf.ProtocolVersion, ProtocolVersion)
	}
	if len(vf.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, v := range vf.Vectors {
		b, err := hex.DecodeString(v.Hex)
		if err != nil {
			t.Fatal(err)
		}
		m, err := DecodeMessage(b)
		if err != nil {
			t.Fatalf("%s/%s: decode: %v", v.Message, v.Case, err)
		}
		if MessageName(m.MsgID()) != v.Message {
			t.Fatalf("%s/%s: decoded as %s", v.Message, v.Case, MessageName(m.MsgID()))
		}
		got := normalize(t, m.ToJSON())
		want := normalize(t, v.Value)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s/%s: value mismatch\\n got: %v\\nwant: %v", v.Message, v.Case, got, want)
		}
		var w Writer
		WriteMessage(&w, m)
		if hex.EncodeToString(w.B) != v.Hex {
			t.Fatalf("%s/%s: re-encode mismatch\\n got: %x\\nwant: %s", v.Message, v.Case, w.B, v.Hex)
		}
	}
}

func TestTruncatedAndTrailing(t *testing.T) {
	var w Writer
	WriteMessage(&w, &ClockPing{T1: 12.5})
	if _, err := DecodeMessage(w.B[:len(w.B)-1]); err == nil {
		t.Fatal("expected truncation error")
	}
	if _, err := DecodeMessage(append(append([]byte{}, w.B...), 0)); err == nil {
		t.Fatal("expected trailing-bytes error")
	}
	if _, err := DecodeMessage([]byte{255}); err == nil {
		t.Fatal("expected unknown-id error")
	}
}
`);
}

// Protocol golden vectors (spec 14): decode each reference vector to the
// expected values, then re-encode to the exact same bytes. The Go side runs the
// same vectors in server/pkg/proto/protocol_vectors_gen_test.go.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decodeMessage, encodeMessage, PROTOCOL_VERSION, Writer, writeMessage, type AnyMessage } from '../src';

interface Vector { message: string; case: string; value: Record<string, unknown>; hex: string }
const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'golden', 'protocol_vectors.json'), 'utf8')) as {
  protocolVersion: number;
  vectors: Vector[];
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));

/** Same JSON spelling as the vectors: bigint -> decimal string, bytes -> hex. */
function friendly(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(friendly);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'type' && x !== undefined) out[k] = friendly(x);
    return out;
  }
  return v;
}

describe('protocol golden vectors', () => {
  it('matches the generated version', () => {
    expect(file.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(file.vectors.length).toBeGreaterThan(20);
  });
  for (const v of file.vectors) {
    it(`${v.message}/${v.case}`, () => {
      const m = decodeMessage(unhex(v.hex));
      expect(m.type).toBe(v.message);
      expect(friendly(m)).toEqual(v.value);
      expect(hex(encodeMessage(m))).toBe(v.hex);
    });
  }
});

describe('framing', () => {
  const ping: AnyMessage = { type: 'ClockPing', t1: 12.5 };
  it('rejects truncation, trailing bytes and unknown ids', () => {
    const b = encodeMessage(ping);
    expect(() => decodeMessage(b.subarray(0, b.length - 1))).toThrow();
    expect(() => decodeMessage(new Uint8Array([...b, 0]))).toThrow();
    expect(() => decodeMessage(new Uint8Array([255]))).toThrow();
  });
  it('reuses a Writer without leaking bytes between messages', () => {
    const w = new Writer(4);
    writeMessage(w, { type: 'Kick', code: 1, reason: 'a long reason that grows the buffer' });
    w.reset();
    writeMessage(w, ping);
    expect(hex(w.view())).toBe(hex(encodeMessage(ping)));
  });
  it('omits absent masked fields entirely', () => {
    const snap: AnyMessage = {
      type: 'Snapshot', tick: 1, baselineTick: 0, ackInputSeq: 0, serverTime: 0,
      self: {}, entities: [{ id: 7 }], removed: [],
    };
    // 1 id + 4+4+4+8 + self mask 2 + list 2 + (id 4 + mask 2) + removed 2
    expect(encodeMessage(snap).length).toBe(1 + 20 + 2 + 2 + 6 + 2);
  });
});

// Byte-level runtime for the generated zone codec (contracts/ts/src/gen/protocol.ts).
// Hand-written on purpose: it has no knowledge of messages, only of primitives,
// and it is exercised by the golden vector tests through the generated code.
// Little-endian everywhere (protocol.yaml framing rules).

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export class Writer {
  buf: Uint8Array;
  private dv: DataView;
  len = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.dv = new DataView(this.buf.buffer);
  }

  /** Reuse the same backing store for the next message (hot paths: input, snapshots). */
  reset(): void {
    this.len = 0;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  u8(v: number) { this.ensure(1); this.dv.setUint8(this.len, v); this.len += 1; }
  i8(v: number) { this.ensure(1); this.dv.setInt8(this.len, v); this.len += 1; }
  u16(v: number) { this.ensure(2); this.dv.setUint16(this.len, v, true); this.len += 2; }
  i16(v: number) { this.ensure(2); this.dv.setInt16(this.len, v, true); this.len += 2; }
  u32(v: number) { this.ensure(4); this.dv.setUint32(this.len, v, true); this.len += 4; }
  i32(v: number) { this.ensure(4); this.dv.setInt32(this.len, v, true); this.len += 4; }
  u64(v: bigint) { this.ensure(8); this.dv.setBigUint64(this.len, v, true); this.len += 8; }
  i64(v: bigint) { this.ensure(8); this.dv.setBigInt64(this.len, v, true); this.len += 8; }
  f32(v: number) { this.ensure(4); this.dv.setFloat32(this.len, v, true); this.len += 4; }
  f64(v: number) { this.ensure(8); this.dv.setFloat64(this.len, v, true); this.len += 8; }
  bool(v: boolean) { this.u8(v ? 1 : 0); }

  str(v: string) {
    const b = enc.encode(v);
    if (b.length > 0xffff) throw new RangeError('string longer than 65535 bytes');
    this.u16(b.length);
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  bytes(v: Uint8Array) {
    this.u32(v.length);
    this.ensure(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
  }

  /** Copy of the written bytes (safe to transfer or keep). */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  /** View of the written bytes without copying; invalid after the next write/reset. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

export class Reader {
  private dv: DataView;
  off = 0;

  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): number {
    const at = this.off;
    if (at + n > this.buf.length) throw new RangeError(`truncated message: need ${n} at ${at}, have ${this.buf.length}`);
    this.off += n;
    return at;
  }

  u8() { return this.dv.getUint8(this.need(1)); }
  i8() { return this.dv.getInt8(this.need(1)); }
  u16() { return this.dv.getUint16(this.need(2), true); }
  i16() { return this.dv.getInt16(this.need(2), true); }
  u32() { return this.dv.getUint32(this.need(4), true); }
  i32() { return this.dv.getInt32(this.need(4), true); }
  u64() { return this.dv.getBigUint64(this.need(8), true); }
  i64() { return this.dv.getBigInt64(this.need(8), true); }
  f32() { return this.dv.getFloat32(this.need(4), true); }
  f64() { return this.dv.getFloat64(this.need(8), true); }
  bool() { return this.u8() !== 0; }

  str(): string {
    const n = this.u16();
    const at = this.need(n);
    return dec.decode(this.buf.subarray(at, at + n));
  }

  bytes(): Uint8Array {
    const n = this.u32();
    const at = this.need(n);
    return this.buf.slice(at, at + n);
  }

  list<T>(item: () => T): T[] {
    const n = this.u16();
    // Every item is at least one byte; reject counts the buffer can't hold
    // before allocating (a hostile count could otherwise allocate 65535 slots).
    if (n > this.buf.length - this.off) throw new RangeError(`list count ${n} exceeds remaining bytes`);
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = item();
    return out;
  }

  /** Strict framing: trailing bytes mean the peer speaks a different protocol version. */
  end(): void {
    if (this.off !== this.buf.length) throw new RangeError(`${this.buf.length - this.off} trailing bytes`);
  }
}

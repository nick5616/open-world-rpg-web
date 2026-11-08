// Delta snapshot decoder: rebuilds what the client knows from Snapshot
// messages applied against acknowledged baselines.
//
// port of server/pkg/snapshot Decoder.Apply (the reference; the zone's
// encoder and this must agree byte for byte, see server/zone/README.md
// "Applying snapshots"):
//  - baselineTick 0: full snapshot. Otherwise a delta against the frame we
//    built for baselineTick (one we acked); we keep the last BASELINE_RING.
//  - new frame = baseline, minus `removed`, with each record applied: fields
//    present in the record (mask bit set = property defined after decoding)
//    replace the baseline's; a record for an id the baseline lacks applies
//    onto the ZERO state (first sight omits zero-valued fields but always
//    carries kind and name).
//  - baseline entities without a record are unchanged (slow AOI rings and
//    the byte budget skip ticks this way).
//  - SelfState is diffed the same way against the baseline's self.
//  - a snapshot not newer than the newest applied is stale (datagrams can
//    reorder) and ignored.

import { BASELINE_RING, type EntityRecord, type SelfState, type Snapshot } from '@lodestone/contracts';

/** One entity as the client knows it, in wire units (cm, cm/s, byte angles). */
export interface EntState {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  healthPct: number;
  activity: number;
  typeId: number;
  name: string;
  level: number;
  partyId: number;
}

/** SelfState with every field present (wire units). */
export type FullSelf = Required<SelfState>;

export interface Frame {
  tick: number;
  serverTime: number;
  ackInputSeq: number;
  self: FullSelf;
  /** Sorted by id. */
  ents: EntState[];
  /** Ids that carried a record in this snapshot (moved, changed, or first seen). */
  updated: Set<number>;
  /** Ids the snapshot explicitly removed. */
  removed: number[];
}

export const ZERO_SELF: Readonly<FullSelf> = Object.freeze({
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, health: 0, healthMax: 0, stamina: 0, staminaMax: 0, mode: 0, airJumps: 0, activity: 0, flags: 0, moveExt: 0,
});

function zeroEnt(id: number): EntState {
  return { id, kind: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, healthPct: 0, activity: 0, typeId: 0, name: '', level: 0, partyId: 0 };
}

/** base with r's present fields applied (base undefined = zero state). */
export function applyRecord(base: EntState | undefined, r: EntityRecord): EntState {
  const s = base ? { ...base } : zeroEnt(r.id);
  s.id = r.id;
  if (r.kind !== undefined) s.kind = r.kind;
  if (r.x !== undefined) s.x = r.x;
  if (r.y !== undefined) s.y = r.y;
  if (r.z !== undefined) s.z = r.z;
  if (r.yaw !== undefined) s.yaw = r.yaw;
  if (r.pitch !== undefined) s.pitch = r.pitch;
  if (r.vx !== undefined) s.vx = r.vx;
  if (r.vy !== undefined) s.vy = r.vy;
  if (r.vz !== undefined) s.vz = r.vz;
  if (r.healthPct !== undefined) s.healthPct = r.healthPct;
  if (r.activity !== undefined) s.activity = r.activity;
  if (r.typeId !== undefined) s.typeId = r.typeId;
  if (r.name !== undefined) s.name = r.name;
  if (r.level !== undefined) s.level = r.level;
  if (r.partyId !== undefined) s.partyId = r.partyId;
  return s;
}

export function applySelf(base: Readonly<FullSelf>, r: SelfState): FullSelf {
  const s = { ...base };
  for (const k of Object.keys(ZERO_SELF) as (keyof FullSelf)[]) {
    const v = r[k];
    if (v !== undefined) s[k] = v;
  }
  return s;
}

export type ApplyResult = { ok: true; frame: Frame } | { ok: false; reason: 'stale' | 'no_baseline' | 'bad_tick' };

export class SnapshotDecoder {
  private ring: (Frame | undefined)[] = new Array(BASELINE_RING);
  private _latest = 0;

  /** Newest applied tick: what Input.ackTick carries. */
  get latest(): number {
    return this._latest;
  }

  frame(tick: number): Frame | undefined {
    if (tick === 0) return undefined;
    const f = this.ring[tick % BASELINE_RING];
    return f && f.tick === tick ? f : undefined;
  }

  reset(): void {
    this.ring = new Array(BASELINE_RING);
    this._latest = 0;
  }

  apply(s: Snapshot): ApplyResult {
    if (s.tick === 0) return { ok: false, reason: 'bad_tick' };
    if (this._latest !== 0 && s.tick <= this._latest) return { ok: false, reason: 'stale' };
    let base: Frame | undefined;
    if (s.baselineTick !== 0) {
      if (s.baselineTick >= s.tick || s.tick - s.baselineTick >= BASELINE_RING) return { ok: false, reason: 'no_baseline' };
      base = this.frame(s.baselineTick);
      if (!base) return { ok: false, reason: 'no_baseline' };
    }
    const self = applySelf(base ? base.self : ZERO_SELF, s.self);

    // Records arrive in id order from our encoder, but don't rely on it.
    const recs = [...s.entities].sort((a, b) => a.id - b.id);
    const removed = new Set(s.removed);
    const bents = base ? base.ents : [];
    const ents: EntState[] = [];
    const updated = new Set<number>();
    let j = 0;
    let k = 0;
    while (j < bents.length || k < recs.length) {
      if (k < recs.length && (j >= bents.length || recs[k].id < bents[j].id)) {
        ents.push(applyRecord(undefined, recs[k]));
        updated.add(recs[k].id);
        k++;
      } else if (k >= recs.length || bents[j].id < recs[k].id) {
        if (!removed.has(bents[j].id)) ents.push(bents[j]);
        j++;
      } else {
        ents.push(applyRecord(bents[j], recs[k]));
        updated.add(recs[k].id);
        j++;
        k++;
      }
    }
    const frame: Frame = { tick: s.tick, serverTime: s.serverTime, ackInputSeq: s.ackInputSeq, self, ents, updated, removed: s.removed };
    this.ring[s.tick % BASELINE_RING] = frame;
    this._latest = s.tick;
    return { ok: true, frame };
  }
}

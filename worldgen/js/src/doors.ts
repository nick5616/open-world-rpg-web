// Building doors (playtest follow-up to WP20): a dynamic overlay on the town
// collision. The Go zone runs a line-for-line port (server/pkg/towns
// doors.go); both must give identical bits, like town.ts.
//
// Door boxes come straight from the towns buffer, no arithmetic: a closable
// door is the doorway of a building with floors whose front is not open
// (forges are), and its box is the building's lintel box (the one wall box
// whose bottom is more than 1 m above the floor: it spans exactly the
// doorway, door_w x wall thickness, on the front wall) with its bottom
// lowered to the bottom of the building's other walls (floor - 0.05) and its
// top at the lintel's bottom. Every value is a copied f32, so TS and Go hold
// the same numbers (pinned by server/pkg/towns/testdata/doors.json).
//
// The town collision (and its golden vectors) never sees door boxes: a
// closed door is pushed out of after the town's push-out, by the same
// per-box arithmetic, two passes over the closed doors near the body in
// ascending door index. Open doors (the default: a WP20 doorway) are not
// there at all. Which doors are closed is the caller's: a pure function of
// the door index (client: the state at the movement step being simulated;
// zone: the state for this player's input seq).
import { MAX_STEP_UP_M, PLAYER_CAPSULE_RADIUS } from '@lodestone/contracts';
import { BUILDING_FLAG, TOWN_GRID_CELL, TOWN_HEAD_M, type TownCollideResult, type Towns } from './town';

const STEP = MAX_STEP_UP_M;
const R = PLAYER_CAPSULE_RADIUS;
const KIND_WALL = 1;
const PROP_DOOR = 0;

export interface TownDoor {
  /** Door index (ascending building order). */
  index: number;
  building: number;
  /** PROPS index of the door prop (kind 0) and its stable id (Interact 34 targetId). */
  prop: number;
  id: bigint;
  settlement: number;
  /** Door prop position: doorway centre on the wall's mid-plane, at floor height. */
  x: number;
  y: number;
  z: number;
  /** Prop yaw (radians, the building's u axis); interior is local +v. */
  yaw: number;
  /** Doorway width (m) and wall thickness (2 x box hz). */
  width: number;
  thick: number;
}

const cellKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

/**
 * Every closable door of a towns layer, its box (9 floats per door, the
 * TownBoxes layout: cx, cz, c, s, hx, hz, y0, y1, y2) and a grid index.
 */
export class TownDoors {
  readonly doors: TownDoor[] = [];
  readonly f: Float64Array;
  readonly byProp = new Map<bigint, number>();
  readonly byBuilding = new Map<number, number>();
  /** PROPS index -> door index (Events 970/971 name doors by prop index). */
  readonly byPropIndex = new Map<number, number>();
  private readonly cells = new Map<number, number[]>();
  private readonly stamp: Uint32Array;
  private query = 0;
  private readonly cand: number[] = [];

  constructor(readonly towns: Towns) {
    const bx = towns.boxes;
    const fs: number[] = [];
    for (const b of towns.buildings) {
      if (b.floors === 0 || (b.flags & BUILDING_FLAG.openFront) !== 0) continue;
      let prop = -1;
      for (let p = b.propFirst; p < b.propFirst + b.propCount; p++) {
        if (towns.props[p].kind === PROP_DOOR) {
          prop = p;
          break;
        }
      }
      if (prop < 0) continue;
      let lintel = -1;
      let y0 = Infinity;
      for (let i = b.boxFirst; i < b.boxFirst + b.boxCount; i++) {
        if (bx.kind[i] !== KIND_WALL) continue;
        const b0 = bx.f[i * 9 + 6];
        if (b0 > b.floorY + 1) {
          if (lintel < 0) lintel = i;
        } else if (b0 < y0) y0 = b0;
      }
      if (lintel < 0 || y0 === Infinity) continue;
      const o = lintel * 9;
      const top = bx.f[o + 6];
      fs.push(bx.f[o], bx.f[o + 1], bx.f[o + 2], bx.f[o + 3], bx.f[o + 4], bx.f[o + 5], y0, top, top);
      const pr = towns.props[prop];
      const index = this.doors.length;
      this.doors.push({ index, building: b.index, prop, id: pr.id, settlement: b.settlement, x: pr.x, y: pr.y, z: pr.z, yaw: pr.yaw, width: bx.f[o + 4] * 2, thick: bx.f[o + 5] * 2 });
      this.byProp.set(pr.id, index);
      this.byBuilding.set(b.index, index);
      this.byPropIndex.set(prop, index);
    }
    this.f = new Float64Array(fs);
    this.stamp = new Uint32Array(this.doors.length);
    const f = this.f;
    for (let d = 0; d < this.doors.length; d++) {
      const o = d * 9;
      const r = Math.sqrt(f[o + 4] * f[o + 4] + f[o + 5] * f[o + 5]);
      const x0 = Math.floor((f[o] - r) / TOWN_GRID_CELL);
      const x1 = Math.floor((f[o] + r) / TOWN_GRID_CELL);
      const z0 = Math.floor((f[o + 1] - r) / TOWN_GRID_CELL);
      const z1 = Math.floor((f[o + 1] + r) / TOWN_GRID_CELL);
      for (let cz = z0; cz <= z1; cz++)
        for (let cx = x0; cx <= x1; cx++) {
          const k = cellKey(cx, cz);
          const l = this.cells.get(k);
          if (l) l.push(d);
          else this.cells.set(k, [d]);
        }
    }
  }

  get count(): number {
    return this.doors.length;
  }

  /** Doors indexed in the square [x-m, x+m] x [z-m, z+m], ascending, deduplicated (reused array). */
  candidates(x: number, z: number, m: number): number[] {
    const out = this.cand;
    out.length = 0;
    this.query = (this.query + 1) >>> 0;
    if (this.query === 0) {
      this.stamp.fill(0);
      this.query = 1;
    }
    const x0 = Math.floor((x - m) / TOWN_GRID_CELL);
    const x1 = Math.floor((x + m) / TOWN_GRID_CELL);
    const z0 = Math.floor((z - m) / TOWN_GRID_CELL);
    const z1 = Math.floor((z + m) / TOWN_GRID_CELL);
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const l = this.cells.get(cellKey(cx, cz));
        if (!l) continue;
        for (const i of l) {
          if (this.stamp[i] !== this.query) {
            this.stamp[i] = this.query;
            out.push(i);
          }
        }
      }
    out.sort((a, b) => a - b);
    return out;
  }

  /**
   * Push the body (feet at the result r of the collision under the doors)
   * out of the closed doors near it: two passes, ascending door index, the
   * town box arithmetic. Pushes add to r's (out.pushX = doors + r.pushX);
   * y and the ceiling flag pass through. When no closed door pushes, out is
   * a copy of r (bit for bit).
   */
  after(r: TownCollideResult, closed: (d: number) => boolean, out: TownCollideResult): TownCollideResult {
    out.x = r.x;
    out.y = r.y;
    out.z = r.z;
    out.pushX = r.pushX;
    out.pushZ = r.pushZ;
    out.ceiling = r.ceiling;
    const cands = this.candidates(r.x, r.z, R + 1);
    if (cands.length === 0) return out;
    const f = this.f;
    const lim = r.y + STEP;
    const head = r.y + TOWN_HEAD_M;
    const r2 = R * R;
    let px = r.x;
    let pz = r.z;
    let dpx = 0;
    let dpz = 0;
    let pushed = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const i of cands) {
        if (!closed(i)) continue;
        const o = i * 9;
        const y1 = f[o + 7];
        const y2 = f[o + 8];
        const top = y1 > y2 ? y1 : y2;
        if (!(top > lim && f[o + 6] < head)) continue;
        const c = f[o + 2];
        const s = f[o + 3];
        const hx = f[o + 4];
        const hz = f[o + 5];
        const dx = px - f[o];
        const dz = pz - f[o + 1];
        const u = dx * c + dz * s;
        const v = dz * c - dx * s;
        const cu = u < -hx ? -hx : u > hx ? hx : u;
        const cv = v < -hz ? -hz : v > hz ? hz : v;
        const du = u - cu;
        const dv = v - cv;
        const d2 = du * du + dv * dv;
        if (d2 >= r2) continue;
        let pu: number;
        let pv: number;
        if (d2 > 0) {
          const d = Math.sqrt(d2);
          const k = (R - d) / d;
          pu = du * k;
          pv = dv * k;
        } else {
          const ex = hx - (u < 0 ? -u : u);
          const ez = hz - (v < 0 ? -v : v);
          if (ex <= ez) {
            pu = (u >= 0 ? 1 : -1) * (ex + R);
            pv = 0;
          } else {
            pu = 0;
            pv = (v >= 0 ? 1 : -1) * (ez + R);
          }
        }
        const wx = pu * c - pv * s;
        const wz = pu * s + pv * c;
        px = px + wx;
        pz = pz + wz;
        dpx = dpx + wx;
        dpz = dpz + wz;
        pushed = true;
      }
    }
    if (!pushed) return out;
    out.x = px;
    out.z = pz;
    out.pushX = dpx + r.pushX;
    out.pushZ = dpz + r.pushZ;
    return out;
  }

  /**
   * Does a body (radius rad, feet at y, head y + TOWN_HEAD_M) touch door d's
   * box? The zone refuses to close a door on one (rad includes its margin).
   */
  touches(d: number, x: number, y: number, z: number, rad: number): boolean {
    const f = this.f;
    const o = d * 9;
    if (!(f[o + 7] > y && f[o + 6] < y + TOWN_HEAD_M)) return false;
    const c = f[o + 2];
    const s = f[o + 3];
    const hx = f[o + 4];
    const hz = f[o + 5];
    const dx = x - f[o];
    const dz = z - f[o + 1];
    const u = dx * c + dz * s;
    const v = dz * c - dx * s;
    const cu = u < -hx ? -hx : u > hx ? hx : u;
    const cv = v < -hz ? -hz : v > hz ? hz : v;
    const du = u - cu;
    const dv = v - cv;
    return du * du + dv * dv < rad * rad;
  }
}

/**
 * Door states with the step each change applies at (the client's own
 * movement steps; the zone stamps every change for each player it tells).
 * A door is open at step n when n >= at ? to : was.
 */
export class DoorStates {
  /** 1 = open. Doors start open (a WP20 doorway). */
  readonly was: Uint8Array;
  readonly to: Uint8Array;
  /** Step (input seq) from which `to` applies; 0 = settled (to == was). */
  readonly at: Uint32Array;
  /** Doors not settled open (closed, or changing). The ground skips doors when 0. */
  active = 0;
  /** Bumped on every change (renderers, HUD). */
  version = 0;

  constructor(readonly count: number) {
    this.was = new Uint8Array(count).fill(1);
    this.to = new Uint8Array(count).fill(1);
    this.at = new Uint32Array(count);
  }

  openAt(d: number, step: number): boolean {
    const at = this.at[d];
    return (at !== 0 && step >= at ? this.to[d] : this.was[d]) === 1;
  }

  /** Change door d to `open` from step `step` on (0: now, settled). Steps already passed settle first. */
  set(d: number, open: boolean, step: number, now: number): void {
    const before = this.was[d] === 1 && this.to[d] === 1 && this.at[d] === 0;
    if (this.at[d] !== 0 && now >= this.at[d]) this.was[d] = this.to[d];
    if (step === 0) {
      this.was[d] = this.to[d] = open ? 1 : 0;
      this.at[d] = 0;
    } else {
      this.to[d] = open ? 1 : 0;
      this.at[d] = step;
    }
    const after = this.was[d] === 1 && this.to[d] === 1 && this.at[d] === 0;
    if (before && !after) this.active++;
    else if (!before && after) this.active--;
    this.version++;
  }

  /** Replace door d's state outright (a baseline): `was` before step `at`, `to` from it (at 0 = settled at `to`). */
  put(d: number, was: boolean, to: boolean, at: number): void {
    const before = this.was[d] === 1 && this.to[d] === 1 && this.at[d] === 0;
    this.was[d] = (at === 0 ? to : was) ? 1 : 0;
    this.to[d] = to ? 1 : 0;
    this.at[d] = at;
    const after = this.was[d] === 1 && this.to[d] === 1 && this.at[d] === 0;
    if (before && !after) this.active++;
    else if (!before && after) this.active--;
    this.version++;
  }

  /** Settle changes whose step has passed (cheap bookkeeping; never changes an answer). */
  settle(now: number): void {
    for (let d = 0; d < this.count; d++) {
      if (this.at[d] === 0 || now < this.at[d]) continue;
      const before = this.was[d] === 1 && this.to[d] === 1 && this.at[d] === 0;
      this.was[d] = this.to[d];
      this.at[d] = 0;
      const after = this.was[d] === 1;
      if (!before && after) this.active--;
    }
  }

  /** Back to all open (a new session, another zone). */
  reset(): void {
    this.was.fill(1);
    this.to.fill(1);
    this.at.fill(0);
    this.active = 0;
    this.version++;
  }
}

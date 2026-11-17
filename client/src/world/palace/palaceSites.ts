// CR 044: the sky palaces on the client. The TS twin of server/pkg/palace:
// each palace's walls, floors, ceilings and columns are collision boxes
// appended to the towns' box list before the collision is indexed, so the
// movement prediction collides with them exactly as the zone does. The
// layout is contracts/palace.yaml (PALACE, expanded at `npm run gen`); the
// palace turns by quarter turns only (exact cos and sin).
import { PALACE } from '@lodestone/contracts';
import type { Towns, VerticalWorld } from '@lodestone/worldgen';

export const PALACE_DECO_KIND = 16;

export interface PalaceSite {
  /** The atlas site index (Interact 150). */
  index: number;
  x: number;
  z: number;
  /** Walkable floor height. */
  floor: number;
  /** Quarter turns (0-3) and the box cos / sin. */
  q: number;
  cs: number;
  sn: number;
}

const CS = [1, 0, -1, 0];
// Three's rotateY(a) sends local +x to (cos a, -sin a): a box's c = cos a, s = -sin a.
const SN = [0, -1, 0, 1];

export function newPalaceSite(index: number, x: number, y: number, z: number, yaw16: number): PalaceSite {
  const q = Math.round(yaw16 / 16384) & 3;
  return { index, x, z, floor: y + PALACE.floorAboveTopM, q, cs: CS[q], sn: SN[q] };
}

export function palaceSites(v: VerticalWorld | null | undefined): PalaceSite[] {
  if (!v) return [];
  return v.decos.filter((d) => d.kind === PALACE_DECO_KIND).map((d) => newPalaceSite(d.aux, d.x, d.y, d.z, d.yaw));
}

/** Local (lx, lz) to world x, z. */
export function palaceWorld(s: PalaceSite, lx: number, lz: number): [number, number] {
  return [s.x + lx * s.cs + lz * -s.sn, s.z + lx * s.sn + lz * s.cs];
}

/** World x, z to the palace's frame. */
export function palaceLocal(s: PalaceSite, x: number, z: number): [number, number] {
  const dx = x - s.x;
  const dz = z - s.z;
  return [dx * s.cs + dz * s.sn, dz * s.cs - dx * s.sn];
}

/** Add every palace's boxes to the towns' box list (the existing indexes never change). */
export function appendPalaceBoxes(towns: Towns, sites: PalaceSite[]): void {
  if (!sites.length) return;
  const b = towns.boxes;
  const per = PALACE.boxes.length;
  const n = b.count + per * sites.length;
  const f = new Float64Array(n * 9);
  f.set(b.f);
  const kind = new Uint8Array(n);
  kind.set(b.kind);
  const flags = new Uint8Array(n);
  flags.set(b.flags);
  const owner = new Uint16Array(n);
  owner.set(b.owner);
  let i = b.count;
  for (const s of sites) {
    for (const r of PALACE.boxes) {
      const [x, z] = palaceWorld(s, r[2], r[3]);
      const o = i * 9;
      f[o] = x;
      f[o + 1] = z;
      f[o + 2] = s.cs;
      f[o + 3] = s.sn;
      f[o + 4] = r[4];
      f[o + 5] = r[5];
      f[o + 6] = r[6] + s.floor;
      f[o + 7] = r[7] + s.floor;
      f[o + 8] = r[8] + s.floor;
      kind[i] = r[0];
      flags[i] = r[1];
      owner[i] = 0xffff;
      i++;
    }
  }
  b.count = n;
  b.f = f;
  b.kind = kind;
  b.flags = flags;
  b.owner = owner;
}

export interface PalaceColumn {
  x: number;
  z: number;
  r: number;
  top: number;
  lift: number;
}

/** The atriums' updraft shafts (Go: palace.Wind). */
export function palaceColumns(sites: PalaceSite[]): PalaceColumn[] {
  return sites.map((s) => {
    const [x, z] = palaceWorld(s, PALACE.shaft.x, PALACE.shaft.z);
    return { x, z, r: PALACE.shaft.r, top: s.floor + PALACE.shaft.top, lift: PALACE.shaft.lift };
  });
}

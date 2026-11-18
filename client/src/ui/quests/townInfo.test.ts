// Playtest 5 (CR 055): the Info tab's data.

import { describe, expect, it } from 'vitest';
import { BUILDING_ROLES, NPC_ROLES, PROP_KINDS, type Site, type Towns } from '@lodestone/worldgen';
import { discoveredTowns, SERVICE_KINDS, townServices } from './townInfo';

const npc = (index: number, role: string, name: string, merchant = 0, wx = 0, wz = 0) => ({ index, id: BigInt(index), settlement: 0, role: NPC_ROLES.indexOf(role as (typeof NPC_ROLES)[number]), variant: 0, name, home: 0, work: 0, workProp: 0, workX: wx, workZ: wz, homeX: 0, homeZ: 0, workYaw: 0, merchant });
const prop = (kind: string, x: number, z: number) => ({ index: 0, id: 0n, x, y: 0, z, yaw: 0, kind: PROP_KINDS.indexOf(kind as (typeof PROP_KINDS)[number]), variant: 0, building: 0, settlement: 0, flags: 0, scale: 64, structure: 0 });
const building = (role: string, x: number, z: number) => ({ settlement: 0, role: BUILDING_ROLES.indexOf(role as (typeof BUILDING_ROLES)[number]), x, z });

function fakeTowns(): Towns {
  const base = { x: 1000, y: 0, z: 1000, radius: 80 };
  return {
    settlements: [
      { index: 0, site: 5, ...base, npcFirst: 0, npcCount: 5, propFirst: 0, propCount: 2, buildingFirst: 0, buildingCount: 3 },
      { index: 1, site: 6, x: 3000, y: 0, z: 3000, radius: 60, npcFirst: 5, npcCount: 0, propFirst: 2, propCount: 0, buildingFirst: 3, buildingCount: 0 },
    ],
    npcs: [
      npc(0, 'merchant', 'Fenia', 0, 1010, 1020), // the general merchant keeps the stables
      npc(1, 'merchant', 'Orla', 2, 990, 1005),
      npc(2, 'blacksmith', 'Selina'),
      npc(3, 'innkeeper', 'Ulus'),
      npc(4, 'bounty', 'Kelmir'),
    ],
    props: [prop('forge', 1030, 990), prop('board', 1005, 1040)],
    buildings: [building('house', 960, 960), building('inn', 1040, 1010), building('storehouse', 975, 1030)],
    roads: [],
  } as unknown as Towns;
}

const site = (index: number, kind: string, x: number, z: number, name: string): Site => ({ index, id: BigInt(index), category: kind === 'settlement' ? 'settlement' : 'poi', kind, size: 0, region: 0, x, y: 0, z, radius: 0, score: 0, name, link: -1 }) as unknown as Site;
const sites: Site[] = [
  ...Array.from({ length: 5 }, (_, i) => site(i, 'cave', 0, 0, `c${i}`)),
  site(5, 'settlement', 1000, 1000, 'Draedmore'),
  site(6, 'settlement', 3000, 3000, 'Kudrogair'),
  site(7, 'tower', 1400, 1000, 'The Spire'),
  site(8, 'tower', 2500, 2500, 'Far Tower'),
  site(9, 'shrine', 1000, 1600, 'The Quiet Shrine'),
];
const name = (s: Site) => s.name ?? s.kind;
const bits = (...idx: number[]) => {
  const b = new Uint8Array(4);
  for (const i of idx) b[i >> 3] |= 1 << (i & 7);
  return b;
};

describe('town services', () => {
  it('lists the stables, smith, inn, storage, board, merchants, the near shrine and tower', () => {
    const sv = townServices(fakeTowns(), 0, sites, name);
    const kinds = sv.map((s) => s.kind);
    expect(kinds).toEqual(['stables', 'smith', 'inn', 'storage', 'board', 'merchant', 'merchant', 'shrine', 'tower']);
    const at = (k: string) => sv.find((s) => s.kind === k)!;
    expect(at('stables')).toMatchObject({ x: 1010, z: 1020, label: 'Stables' });
    expect(at('stables').detail).toContain('Fenia');
    expect(at('smith')).toMatchObject({ x: 1030, z: 990 });
    expect(at('inn')).toMatchObject({ x: 1040, z: 1010 });
    expect(at('board')).toMatchObject({ x: 1005, z: 1040 });
    expect(at('tower').detail).toContain('The Spire'); // not the far one
    expect(at('shrine').detail).toContain('The Quiet Shrine');
    expect(sv.filter((s) => s.kind === 'merchant').map((s) => s.detail)).toEqual(['Fenia: general goods', 'Orla: herbs']);
  });

  it('a town with nothing lists nothing; a missing town too', () => {
    expect(townServices(fakeTowns(), 1, [], name)).toEqual([]);
    expect(townServices(fakeTowns(), 9, sites, name)).toEqual([]);
  });

  it('the kinds are the ones the zone knows (server guidance.go serviceLabels)', () => {
    expect(Object.values(SERVICE_KINDS).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(SERVICE_KINDS.stables).toBe(1);
    expect(SERVICE_KINDS.tower).toBe(6);
  });
});

describe('discovered towns', () => {
  it('lists the towns you have found, the one you stand in, nearest first', () => {
    const t = fakeTowns();
    expect(discoveredTowns(t, sites, bits(), { x: 5000, z: 5000 }, name)).toEqual([]);
    expect(discoveredTowns(t, sites, bits(6), { x: 5000, z: 5000 }, name).map((x) => x.name)).toEqual(['Kudrogair']);
    // Standing in Draedmore counts before its discovery has arrived; Kudrogair found.
    const both = discoveredTowns(t, sites, bits(6), { x: 1010, z: 1000 }, name);
    expect(both.map((x) => x.name)).toEqual(['Draedmore', 'Kudrogair']);
    expect(both[0].services.length).toBeGreaterThan(5);
  });
});

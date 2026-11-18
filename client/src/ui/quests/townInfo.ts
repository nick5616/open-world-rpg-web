// Playtest 5 (CR 055): the journal's Info tab. "Marking on your map didn't
// work for pointing out where the horse stables are. Could also be under an
// info tab in the journal." For each town you have discovered: its services
// (stables, smith, inn, storage, shrine, tower, bounty board, merchants), each
// with a place, read from the towns buffer the client already has and the
// atlas sites. Pure (townInfo.test.ts); InfoTab.tsx draws it.

import { BUILDING_ROLES, NPC_ROLES, PROP_KINDS, type Site, type Towns } from '@lodestone/worldgen';
import { hasBit } from '../map/events';

/** Service kinds on the wire (server/zone/internal/game/guidance.go serviceLabels, from 1). */
export const SERVICE_KINDS = { stables: 1, smith: 2, inn: 3, storage: 4, shrine: 5, tower: 6, board: 7, merchant: 8 } as const;
export type ServiceKind = keyof typeof SERVICE_KINDS;

export const SERVICE_LABEL: Record<ServiceKind, string> = {
  stables: 'Stables',
  smith: 'Smith',
  inn: 'Inn',
  storage: 'Storage',
  shrine: 'Shrine',
  tower: 'Tower',
  board: 'Bounty board',
  merchant: 'Merchant',
};

export interface Service {
  kind: ServiceKind;
  /** "Stables", "Merchant". */
  label: string;
  /** Who or what: "Fenia sells spirit whistles", "The Spire". */
  detail: string;
  x: number;
  z: number;
}

export interface TownInfo {
  /** Settlement index in the towns buffer. */
  settlement: number;
  name: string;
  x: number;
  z: number;
  services: Service[];
}

// Towns buffer vocabulary (worldgen/js/src/town.ts tables, looked up by name so a reorder cannot drift).
const ROLE_MERCHANT = NPC_ROLES.indexOf('merchant');
const ROLE_SMITH = NPC_ROLES.indexOf('blacksmith');
const ROLE_INNKEEPER = NPC_ROLES.indexOf('innkeeper');
const ROLE_BOUNTY = NPC_ROLES.indexOf('bounty');
const BUILDING_INN = BUILDING_ROLES.indexOf('inn');
const BUILDING_STOREHOUSE = BUILDING_ROLES.indexOf('storehouse');
const PROP_FORGE = PROP_KINDS.indexOf('forge');
const PROP_BOARD = PROP_KINDS.indexOf('board');
/** The merchant kinds in towns-buffer order (MERCHANT_KINDS: general, provisions, herbalist, tools, miner, broker). */
const MERCHANT_WARES = ['general goods', 'provisions', 'herbs', 'tools', 'ore and gems', 'broker'];

/** Tower and shrine sites within this far of a town's centre count as "near" it (the zone allows the same). */
export const NEAR_SERVICE_M = 900;

/**
 * The services of settlement `si`. `siteName` names an atlas site;
 * `sites` are the atlas sites (towers and shrines near the town).
 */
export function townServices(towns: Towns, si: number, sites: readonly Site[], siteName: (s: Site) => string): Service[] {
  const st = towns.settlements[si];
  if (!st) return [];
  const out: Service[] = [];
  const add = (kind: ServiceKind, detail: string, x: number, z: number) => out.push({ kind, label: SERVICE_LABEL[kind], detail, x, z });
  const npcs = towns.npcs.slice(st.npcFirst, st.npcFirst + st.npcCount);
  const of = (role: number) => npcs.filter((n) => n.role === role);

  // The stables: the general merchant keeps the spirit whistles (the zone's rumour says the same).
  for (const n of npcs) if (n.role === ROLE_MERCHANT && n.merchant === 0) add('stables', `${n.name} sells spirit whistles and steeds' tack`, n.workX, n.workZ);

  const forge = towns.props.slice(st.propFirst, st.propFirst + st.propCount).find((p) => p.kind === PROP_FORGE);
  const smith = of(ROLE_SMITH)[0];
  if (forge) add('smith', smith ? `${smith.name}, blacksmith: forge, anvil and blueprints` : 'a forge and anvil', forge.x, forge.z);
  else if (smith) add('smith', `${smith.name}, blacksmith`, smith.workX, smith.workZ);

  const buildings = towns.buildings.slice(st.buildingFirst, st.buildingFirst + st.buildingCount);
  const inn = buildings.find((b) => b.role === BUILDING_INN);
  const keeper = of(ROLE_INNKEEPER)[0];
  if (inn) add('inn', keeper ? `${keeper.name}, innkeeper: a bed, a hearth and rumours` : 'a bed and a hearth', inn.x, inn.z);
  else if (keeper) add('inn', `${keeper.name}, innkeeper`, keeper.workX, keeper.workZ);

  const store = buildings.find((b) => b.role === BUILDING_STOREHOUSE);
  if (store) add('storage', 'the storehouse', store.x, store.z);

  const board = towns.props.slice(st.propFirst, st.propFirst + st.propCount).find((p) => p.kind === PROP_BOARD);
  const keeperB = of(ROLE_BOUNTY)[0];
  if (board) add('board', keeperB ? `${keeperB.name}, bounty keeper` : 'bounties and notices', board.x, board.z);
  else if (keeperB) add('board', `${keeperB.name}, bounty keeper`, keeperB.workX, keeperB.workZ);

  for (const n of of(ROLE_MERCHANT)) add('merchant', `${n.name}: ${MERCHANT_WARES[n.merchant] ?? 'wares'}`, n.workX, n.workZ);

  // The nearest tower and the nearest shrine within reach of the town.
  const nearest = (kind: string) => {
    let best: Site | null = null;
    let bd = NEAR_SERVICE_M;
    for (const s of sites) {
      if (s.kind !== kind) continue;
      const d = Math.hypot(s.x - st.x, s.z - st.z);
      if (d < bd) {
        best = s;
        bd = d;
      }
    }
    return best ? { site: best, d: bd } : null;
  };
  const shrine = nearest('shrine');
  if (shrine) add('shrine', `${siteName(shrine.site)}, ${Math.round(shrine.d / 10) * 10} m away`, shrine.site.x, shrine.site.z);
  const tower = nearest('tower');
  if (tower) add('tower', `${siteName(tower.site)}, ${Math.round(tower.d / 10) * 10} m away`, tower.site.x, tower.site.z);
  return out;
}

/**
 * The towns you have discovered: their atlas site is in your discoveries (or
 * you are standing in them: a new character has not yet been "discovered" by
 * the first step into their own town).
 */
export function discoveredTowns(towns: Towns, sites: readonly Site[], discoveries: Uint8Array, at: { x: number; z: number }, siteName: (s: Site) => string): TownInfo[] {
  const out: TownInfo[] = [];
  towns.settlements.forEach((st, i) => {
    const here = Math.hypot(at.x - st.x, at.z - st.z) <= st.radius + 60;
    if (!here && !hasBit(discoveries, st.site)) return;
    const site = sites[st.site];
    out.push({ settlement: i, name: site ? siteName(site) : 'the town', x: st.x, z: st.z, services: townServices(towns, i, sites, siteName) });
  });
  // The town you are in first, then the nearest.
  out.sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z));
  return out;
}

// What each discovery looks like as an intro: site kind -> subtitle, zone
// Event -> IntroSpec, and the region under a world position. Pure (atlas data
// passed in), unit-tested in intro.test.ts.
//
// Event -> intro (contracts/events.md, WP12):
//   600 tower_unlocked     -> "region" variant: "Region revealed" + region name
//   601 waypoint_activated -> "minor" variant: the waypoint's name
//   602 discovery          -> "major" variant: town / tower / cave / structure /
//                             landmark name, kind + region under it, +XP
//   902 tower_attuned      -> towerAttunedIntro (CR 012, pt/progression). Wired
//                             in INTRO_FOR_EVENT:
//                               [TOWER_ATTUNED]: towerAttunedIntro,
// First entry into a region this session and name cards for known towns are
// position-driven (DiscoveryIntro.tsx), built by regionIntro / townCard.

import type { Event as ZoneEvent } from '@lodestone/contracts';
import { LANDMARK_VARIANTS, SETTLEMENT_SIZES, type AtlasData, type Region, type Site } from '@lodestone/worldgen';
import { EV } from '../map/events';
import type { IntroSpec } from './queue';

/** The WP12 toast kinds the intros replace (ExplorationHud stops drawing them). */
export const INTRO_TOAST_KINDS: ReadonlySet<string> = new Set(['discovery', 'tower', 'waypoint']);

export const ACCENT = {
  region: '#4fdcff', // Sheikah cyan, the reference ornament diamond
  settlement: '#ffd166',
  tower: '#ff7b72',
  cave: '#b388ff',
  structure: '#e9c46a',
  landmark: '#06d6a0',
  waypoint: '#4cc9f0',
} as const;

const STRUCTURE_LABEL: Record<string, string> = {
  ruin: 'Ruins',
  watchtower: 'Watchtower',
  mineshaft: 'Mineshaft',
  shrine: 'Shrine',
  bandit_camp: 'Bandit Camp',
  wizard_tower: "Wizard's Tower",
  meteor_crater: 'Meteor Crater',
  sunken_temple: 'Sunken Temple',
  demon_lair: 'Demon Lair',
};

const LANDMARK_LABEL: Record<string, string> = {
  standing_stones: 'Standing Stones',
  great_tree: 'Great Tree',
  stone_arch: 'Stone Arch',
  monolith: 'Monolith',
  giant_bones: "Giant's Bones",
  crystal_outcrop: 'Crystal Outcrop',
  statue: 'Ancient Statue',
  hot_spring: 'Hot Spring',
};

const BIOME_LABEL: Record<string, string> = {
  meadow: 'Meadows',
  forest: 'Forest',
  highlands: 'Highlands',
  snowpeak: 'Snowpeaks',
  badlands: 'Badlands',
  wetland: 'Wetlands',
};

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** What a site is, in words: "Village", "Tower of Ashen Vale", "Cave", "Ruins", "Great Tree". */
export function siteKindLabel(site: Pick<Site, 'category' | 'kind' | 'size'>, regionName = ''): string {
  if (site.category === 'settlement') return titleCase(SETTLEMENT_SIZES[site.size] ?? 'settlement');
  if (site.category === 'structure') return STRUCTURE_LABEL[site.kind] ?? titleCase(site.kind);
  switch (site.kind) {
    case 'tower':
      return regionName ? `Tower of ${regionName}` : 'Tower';
    case 'cave_mouth':
      return 'Cave';
    case 'waypoint':
      return 'Waypoint';
    case 'landmark':
      return LANDMARK_LABEL[LANDMARK_VARIANTS[site.size] ?? ''] ?? 'Landmark';
    case 'enemy_camp':
      return 'Camp';
  }
  return titleCase(site.kind);
}

export function siteAccent(site: Pick<Site, 'category' | 'kind'>): string {
  if (site.category === 'settlement') return ACCENT.settlement;
  if (site.category === 'structure') return ACCENT.structure;
  if (site.kind === 'tower') return ACCENT.tower;
  if (site.kind === 'cave_mouth') return ACCENT.cave;
  if (site.kind === 'waypoint') return ACCENT.waypoint;
  return ACCENT.landmark;
}

export function biomeLabel(biome: string): string {
  return BIOME_LABEL[biome] ?? titleCase(biome);
}

/** Region index under (x, z): the atlas region grid (regionsPerEdge squared). */
export function regionIndexAt(data: Pick<AtlasData, 'worldSize' | 'regionsPerEdge'>, x: number, z: number): number {
  const per = data.regionsPerEdge;
  const rs = data.worldSize / per;
  if (!(rs > 0) || x < 0 || z < 0 || x >= data.worldSize || z >= data.worldSize) return -1;
  return Math.floor(z / rs) * per + Math.floor(x / rs);
}

/** Atlas lookups an intro builder may use (null when the world isn't loaded). */
export interface IntroWorld {
  sites: readonly Site[];
  regions: readonly Region[];
}

const utf8 = new TextDecoder();
const nameOf = (ev: ZoneEvent) => (ev.data.length ? utf8.decode(ev.data).trim() : '');
const regionName = (w: IntroWorld | null, r: number) => (r >= 0 ? w?.regions[r]?.name ?? '' : '');
const xpLine = (xp: number) => (xp > 0 ? `+${xp} XP` : undefined);

/**
 * A site's intro: name big, kind and region under it. Without a name the kind
 * becomes the title ("Cave") and the region the subtitle.
 */
export function siteIntro(site: Site | undefined, fallbackName: string, w: IntroWorld | null, opts: { key: string; variant: IntroSpec['variant']; detail?: string; eyebrow?: string }): IntroSpec {
  const name = site?.name?.trim() || fallbackName;
  const region = site ? regionName(w, site.region) : '';
  if (!site) return { key: opts.key, variant: opts.variant, title: name || 'Somewhere new', eyebrow: opts.eyebrow, detail: opts.detail, accent: ACCENT.region };
  const kind = siteKindLabel(site, region);
  let title = name;
  let subtitle: string | undefined;
  if (!name) {
    title = kind;
    subtitle = site.kind === 'tower' ? undefined : region || undefined;
  } else if (site.kind === 'tower') {
    subtitle = kind; // "Tower of <Region>" already names the region
  } else {
    subtitle = region ? `${kind} · ${region}` : kind;
  }
  return { key: opts.key, variant: opts.variant, title, eyebrow: opts.eyebrow, subtitle, detail: opts.detail, accent: siteAccent(site) };
}

/** 602 discovery: targetId = site, value = XP, data = name. */
export function discoveryIntro(ev: ZoneEvent, w: IntroWorld | null): IntroSpec {
  const site = w?.sites[ev.targetId];
  return siteIntro(site, nameOf(ev), w, { key: `site:${ev.targetId}`, variant: 'major', detail: xpLine(ev.value) });
}

/** 600 tower_unlocked: targetId = tower site, value = region revealed, data = region name. */
export function towerUnlockedIntro(ev: ZoneEvent, w: IntroWorld | null): IntroSpec {
  const r = ev.value;
  const region = w?.regions[r];
  const title = nameOf(ev) || region?.name || 'Unknown lands';
  return {
    key: `reveal:${r}`,
    variant: 'region',
    covers: [`region:${r}`],
    eyebrow: 'Region revealed',
    title,
    subtitle: region ? biomeLabel(region.biome) : undefined,
    detail: 'Map updated · tower unlocked for fast travel',
    accent: ACCENT.region,
  };
}

/** 601 waypoint_activated: targetId = site, data = name (a settlement waypoint carries the settlement's). */
export function waypointIntro(ev: ZoneEvent, w: IntroWorld | null): IntroSpec {
  const site = w?.sites[ev.targetId];
  const name = nameOf(ev);
  const region = site ? regionName(w, site.region) : '';
  return { key: `waypoint:${ev.targetId}`, variant: 'minor', title: name || 'Waypoint', subtitle: name ? 'Waypoint' : region || undefined, detail: 'Unlocked for fast travel', accent: ACCENT.waypoint };
}

/**
 * Event 902 `tower_attuned` (CR 012, the progression branch): targetId =
 * the tower's atlas site index, value = region index, data = region name
 * (600's layout). The tower's own name is the title; the boon is the line.
 */
export const TOWER_ATTUNED = 902;
export function towerAttunedIntro(ev: ZoneEvent, w: IntroWorld | null): IntroSpec {
  const site = w?.sites[ev.targetId];
  const spec = siteIntro(site, site?.name ?? nameOf(ev), w, { key: `attuned:${ev.targetId}`, variant: 'major', eyebrow: 'Tower attuned', detail: 'Its crystal answers you · a permanent boon' });
  return { ...spec, accent: ACCENT.tower };
}

export type IntroBuilder = (ev: ZoneEvent, w: IntroWorld | null) => IntroSpec | null;

/** Zone Event kind -> intro. Add a line here to give another Event an intro. */
export const INTRO_FOR_EVENT: Partial<Record<number, IntroBuilder>> = {
  [EV.towerUnlocked]: towerUnlockedIntro,
  [EV.waypoint]: waypointIntro,
  [EV.discovery]: discoveryIntro,
  [TOWER_ATTUNED]: towerAttunedIntro, // CR 012 (a zone without it never sends 902)
};

export function introForEvent(ev: ZoneEvent, w: IntroWorld | null): IntroSpec | null {
  return INTRO_FOR_EVENT[ev.kind]?.(ev, w) ?? null;
}

/** First time in a region this session. */
export function regionIntro(region: Region, revealed: boolean): IntroSpec {
  return {
    key: `region:${region.index}`,
    variant: 'region',
    title: region.name,
    subtitle: biomeLabel(region.biome),
    detail: revealed ? undefined : 'Uncharted · climb its tower to map it',
    accent: ACCENT.region,
  };
}

/** Walking back into a town you already know: a small, quick name card. */
export function townCard(site: Site): IntroSpec {
  return { key: `card:${site.index}`, variant: 'card', title: site.name?.trim() || siteKindLabel(site), subtitle: siteKindLabel(site), accent: ACCENT.settlement };
}

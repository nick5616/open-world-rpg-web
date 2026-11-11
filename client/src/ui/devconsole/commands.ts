// Playtest 2 dev console (CR 032): the command line. Every button in the
// console has a command here; a parsed command is the Interact 250 sends it
// makes (the zone does the work and answers with Event 1401). Pure: the
// caller passes what it needs to know (current flags, places, quests).

import { ACHIEVEMENTS, BOSSES, CUTS, ELEMENTS, ELITES, ENEMIES, GEAR_AFFIXES, GEMS, itemCatalog, RARITIES, resolve, SKILLS, SPECIES, SPELLS, suggest, WEATHER, WORLD_EVENTS, type CatalogItem } from './catalog';
import { DEV_ACT, DEV_FLAG, DEV_RIFT, DEV_STORY, giveSend, petSend, send, spawnSend, teleportSend, type DevFlagName, type DevSend, type GiveOpts } from './events';
// Playtest 2 vibe explorer (docs/cr/036-vibe-explorer.md): /vibe and /music.
import { MUSIC_USAGE, parseMusic, parseVibe, VIBE_USAGE, type MusicCmd } from './vibe/commands';
import type { VibeFilter } from './vibe/filters';
import type { VibeState } from './vibe/store';

export interface CmdPlace {
  kind: string;
  name: string;
  x: number;
  z: number;
}

export interface CmdCtx {
  flags: number;
  places: readonly CmdPlace[];
  quests: readonly { id: number; title: string }[];
  /** The vibe explorer's results (go next/random, region names). */
  vibe?: Pick<VibeState, 'results' | 'total' | 'offset' | 'cursor' | 'regions' | 'filter' | 'here'>;
}

export type CmdResult = { sends: DevSend[]; note?: string; local?: 'help' | 'clear'; vibe?: { filter?: VibeFilter; cursor?: number }; music?: MusicCmd } | { error: string };

export interface CommandDef {
  name: string;
  usage: string;
  does: string;
  /** What the first argument completes from. */
  arg?: 'item' | 'spell' | 'enemy' | 'species' | 'event' | 'weather' | 'place' | 'achievement' | 'skill' | 'command' | 'vibe';
  aliases?: string[];
}

export const COMMANDS: CommandDef[] = [
  { name: 'give', usage: '/give <item> [qty] [rarity] [lvl=N] [gem=ruby[:brilliant]] [affix=brutal]', does: 'put an item in your pack (gear rolled at that rarity)', arg: 'item' },
  { name: 'equip', usage: '/equip <item> [rarity] [l1|l2|l3] [lvl=N] [gem=..] [affix=..]', does: 'give and equip (weapons: main hand of that loadout; armor: its slot; tomes/arrows/draughts: used)', arg: 'item' },
  { name: 'learn', usage: '/learn <spell|all>', does: 'learn a spell, or every spell', arg: 'spell' },
  { name: 'unlearn', usage: '/unlearn <spell|all>', does: 'forget a spell, or all but the starting kit', arg: 'spell' },
  { name: 'level', usage: '/level <1-255>', does: 'set your character level' },
  { name: 'xp', usage: '/xp <total>', does: 'set your total XP' },
  { name: 'gold', usage: '/gold <n>', does: 'set the gold in your purse' },
  { name: 'sp', usage: '/sp <n>', does: 'extra skill points (this session)', aliases: ['skillpoints'] },
  { name: 'skill', usage: '/skill <swordsmanship|...|all> <1-100>', does: 'set a weapon or craft skill level', arg: 'skill' },
  { name: 'heal', usage: '/heal', does: 'refill health, mana and stamina', aliases: ['refill'] },
  { name: 'god', usage: '/god [on|off]', does: 'toggle god mode (nothing hurts you)' },
  { name: 'mana', usage: '/mana [on|off]', does: 'toggle infinite mana' },
  { name: 'stamina', usage: '/stamina [on|off]', does: 'toggle infinite stamina' },
  { name: 'nocd', usage: '/nocd [on|off]', does: 'toggle no cooldowns', aliases: ['cooldowns'] },
  { name: 'fly', usage: '/fly [on|off]', does: 'toggle fly (Space up, Ctrl down, Shift fast)' },
  { name: 'speed', usage: '/speed <x>', does: 'fly speed multiplier (0.1-50)' },
  { name: 'freelearn', usage: '/freelearn [on|off]', does: 'skill tree: every tier, no points or prerequisites' },
  { name: 'freeze', usage: '/freeze [on|off]', does: 'freeze the world clock (zone-wide)' },
  { name: 'tp', usage: '/tp <x> <z> | <tower, town or vault name>', does: 'teleport', arg: 'place', aliases: ['teleport'] },
  { name: 'time', usage: '/time <hour, e.g. 21.5 or 21:30>', does: 'set the time of day' },
  { name: 'weather', usage: '/weather <clear|rain|thunderstorm|snow|...|seeded>', does: 'force the weather everywhere (seeded: back to normal)', arg: 'weather' },
  { name: 'spawn', usage: '/spawn <enemy|boss> [count] [level] [fast|shielded|splitting]', does: 'spawn enemies or a boss ahead of you', arg: 'enemy' },
  { name: 'despawn', usage: '/despawn', does: 'remove everything the console spawned' },
  { name: 'event', usage: '/event <starfall|caravan|...>', does: 'start a world event near you', arg: 'event' },
  { name: 'tame', usage: '/tame <species>', does: 'a weakened tameable creature ahead (feed it its favourite food)', arg: 'species' },
  { name: 'pet', usage: '/pet <species> [shiny|elemental[:fire]] [level]', does: 'a tamed pet of that species', arg: 'species' },
  { name: 'steed', usage: '/steed [colour 0-5]', does: 'a spirit steed and its whistle (5 calls it)' },
  { name: 'quest', usage: '/quest <id|all> [step|done|abandon]', does: 'finish a step, finish or abandon quests' },
  { name: 'reveal', usage: '/reveal', does: 'reveal the map: every tower and waypoint' },
  { name: 'attune', usage: '/attune', does: 'attune every tower crystal (boons)' },
  { name: 'achieve', usage: '/achieve <achievement|all>', does: 'unlock an achievement, or all of them (rewards paid)', arg: 'achievement' },
  { name: 'rift', usage: '/rift <spawn [chapter]|go <chapter> <stage>|win|leave|list>', does: 'rift runs (CR 040): open a rift at your feet, go straight into chapter 1-5 at room 1-50, clear the room you are in, walk out (spoils banked), list the open rifts' },
  { name: 'story', usage: '/story <act N [step]|heartfall|hush PCT|bells|down|win|vigil|places|reset>', does: 'the main story (CR 035): jump to an act and step, go to the Heartfall, set the Hush\'s health, shatter its bells, be downed (try a revive), win the fight (or fell the Sovereign), end the vigil\'s waves' },
  { name: 'vibe', usage: VIBE_USAGE, does: 'the vibe explorer: find places by biome, landmark, level, region; teleport there safely; set the area level; spawn its enemies; freeze the vibe; demons on/off', arg: 'vibe' },
  { name: 'music', usage: MUSIC_USAGE, does: 'composer aids: what is playing and why, force a state/track/intensity, solo or mute buses, loop a section, load your own audio files, export mappings' },
  { name: 'reset', usage: '/reset yes', does: 'a new character: level 1, starting kit, no spells, map or quests' },
  { name: 'help', usage: '/help [command]', does: 'list commands', arg: 'command' },
  { name: 'clear', usage: '/clear', does: 'clear the console log' },
];

const TOGGLES: Record<string, DevFlagName> = { god: 'god', mana: 'mana', stamina: 'stamina', nocd: 'cooldowns', fly: 'fly', freelearn: 'freeLearn', freeze: 'freezeTime' };

export function commandDef(name: string): CommandDef | undefined {
  const n = name.toLowerCase().replace(/^\//, '');
  return COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/** Split a command line into words ("quoted words" stay together). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  for (const m of line.trim().matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

const num = (s: string | undefined): number | null => (s !== undefined && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);

/** The longest run of leading words that names something in list; the rest are options. */
function leading<T extends { key: string; name: string; id?: number }>(list: readonly T[], words: string[]): { hit: T; rest: string[] } | null {
  for (let k = words.length; k >= 1; k--) {
    const hit = resolve(list, words.slice(0, k).join(' '));
    if (hit) return { hit, rest: words.slice(k) };
  }
  return null;
}

/** /give and /equip options after the item. */
export function giveOptions(item: CatalogItem, rest: string[], equip: boolean): GiveOpts | string {
  const o: GiveOpts = { equip };
  let numbers = 0;
  for (const w of rest) {
    const lw = w.toLowerCase();
    const n = num(w);
    if (n !== null) {
      if (numbers++ === 0) o.qty = n;
      else o.level = n;
    } else if (/^l[123]$/.test(lw) || /^loadout[123]$/.test(lw)) o.loadout = Number(lw.at(-1)) - 1; // CR 039: l3
    else if (lw.startsWith('lvl=') || lw.startsWith('level=')) o.level = Number(lw.split('=')[1]) || 0;
    else if (lw.startsWith('gem=')) {
      const [g, c] = lw.slice(4).split(':');
      const gem = resolve(GEMS, g);
      if (!gem) return `no gem "${g}"`;
      o.gem = gem.id;
      if (c) {
        const cut = resolve(CUTS, c);
        if (!cut) return `no cut "${c}" (rough, cut, brilliant)`;
        o.cut = cut.id;
      } else o.cut = 2;
    } else if (lw.startsWith('affix=')) {
      const a = resolve(GEAR_AFFIXES, lw.slice(6));
      if (!a) return `no affix "${lw.slice(6)}"`;
      o.affix = a.id;
    } else {
      const r = resolve(RARITIES, w);
      if (!r) return `don't know "${w}" (a quantity, rarity, l1/l2, lvl=, gem=, affix=)`;
      o.rarity = r.id;
    }
  }
  if (equip && item.gear) o.qty = 1;
  return o;
}

function toggle(name: DevFlagName, flags: number, arg: string | undefined): DevSend {
  const bit = DEV_FLAG[name];
  const on = arg === 'on' ? true : arg === 'off' ? false : (flags & bit) === 0;
  return send(DEV_ACT.flags, 0, on ? flags | bit : flags & ~bit);
}

/** Parse one command line. */
export function parseCommand(line: string, ctx: CmdCtx): CmdResult {
  const words = tokenize(line);
  if (words.length === 0) return { error: 'type a command, or /help' };
  const def = commandDef(words[0]);
  if (!def) return { error: `unknown command ${words[0]} (try /help)` };
  const args = words.slice(1);
  const a0 = args[0];
  const n0 = num(a0);
  const need = (cond: boolean, msg = `usage: ${def.usage}`): string | null => (cond ? null : msg);
  let err: string | null;
  switch (def.name) {
    case 'help':
      return { sends: [], local: 'help', note: a0 ? (commandDef(a0)?.usage ?? `unknown command ${a0}`) : undefined };
    case 'clear':
      return { sends: [], local: 'clear' };
    case 'give':
    case 'equip': {
      const hit = leading(itemCatalog(), args);
      if (!hit) return { error: a0 ? `no item "${args.join(' ')}"` : `usage: ${def.usage}` };
      const o = giveOptions(hit.hit, hit.rest, def.name === 'equip');
      if (typeof o === 'string') return { error: o };
      return { sends: [giveSend(hit.hit.key, o)] };
    }
    case 'learn':
    case 'unlearn': {
      const act = def.name === 'learn' ? DEV_ACT.learn : DEV_ACT.unlearn;
      if (a0?.toLowerCase() === 'all') return { sends: [send(act, 0)] };
      const sp = leading(SPELLS, args);
      if (!sp) return { error: a0 ? `no spell "${args.join(' ')}"` : `usage: ${def.usage}` };
      return { sends: [send(act, sp.hit.id)] };
    }
    case 'level':
      if ((err = need(n0 !== null && n0 >= 1 && n0 <= 255))) return { error: err };
      return { sends: [send(DEV_ACT.level, 0, n0!)] };
    case 'xp':
      if ((err = need(n0 !== null && n0 >= 0))) return { error: err };
      return { sends: [send(DEV_ACT.xp, BigInt(Math.floor(n0!)))] };
    case 'gold':
      if ((err = need(n0 !== null && n0 >= 0 && n0 <= 100_000_000))) return { error: err };
      return { sends: [send(DEV_ACT.gold, 0, n0!)] };
    case 'sp':
      if ((err = need(n0 !== null && n0 >= 0 && n0 <= 1000))) return { error: err };
      return { sends: [send(DEV_ACT.skillPoints, 0, n0!)] };
    case 'skill': {
      const lvl = num(args[1]);
      if ((err = need(!!a0 && lvl !== null && lvl >= 1 && lvl <= 100))) return { error: err };
      if (a0.toLowerCase() === 'all') return { sends: [send(DEV_ACT.weaponSkill, 0, lvl!)] };
      const sk = resolve(SKILLS, a0);
      if (!sk) return { error: `no skill "${a0}" (${SKILLS.map((s) => s.key).join(', ')})` };
      return { sends: [send(DEV_ACT.weaponSkill, sk.id, lvl!)] };
    }
    case 'heal':
      return { sends: [send(DEV_ACT.refill)] };
    case 'god':
    case 'mana':
    case 'stamina':
    case 'nocd':
    case 'fly':
    case 'freelearn':
    case 'freeze':
      return { sends: [toggle(TOGGLES[def.name], ctx.flags, a0?.toLowerCase())] };
    case 'speed':
      if ((err = need(n0 !== null && n0 >= 0.1 && n0 <= 50))) return { error: err };
      return { sends: [send(DEV_ACT.speed, 0, Math.round(n0! * 100))] };
    case 'tp': {
      const x = num(a0);
      const z = num(args[1]);
      if (x !== null && z !== null) return { sends: [teleportSend(x, z)] };
      const pl = leading(
        ctx.places.map((p, i) => ({ ...p, key: `${p.kind}:${p.name}`, id: i })),
        args,
      );
      if (!pl) return { error: a0 ? `no place "${args.join(' ')}" (or give x z)` : `usage: ${def.usage}` };
      return { sends: [teleportSend(pl.hit.x, pl.hit.z)], note: `${pl.hit.kind} ${pl.hit.name}` };
    }
    case 'time': {
      const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(a0 ?? '');
      const h = m ? Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0) : n0;
      if ((err = need(h !== null && h >= 0 && h <= 24))) return { error: err };
      return { sends: [send(DEV_ACT.time, 0, Math.round(h! * 100))] };
    }
    case 'weather': {
      if (a0 && ['seeded', 'off', 'normal', 'auto'].includes(a0.toLowerCase())) return { sends: [send(DEV_ACT.weather, 0, 0)] };
      const w = a0 ? resolve(WEATHER, args.join('_')) : undefined;
      if (!w) return { error: `usage: ${def.usage}` };
      return { sends: [send(DEV_ACT.weather, 0, w.id + 1)] };
    }
    case 'spawn': {
      const boss = leading(BOSSES, args);
      const en = boss ? null : leading(ENEMIES, args);
      const hit = boss ?? en;
      if (!hit) return { error: a0 ? `no enemy or boss "${a0}"` : `usage: ${def.usage}` };
      const nums = hit.rest.map(num).filter((v): v is number => v !== null);
      const eliteWord = hit.rest.find((w) => num(w) === null);
      const elite = eliteWord ? resolve(ELITES, eliteWord) : undefined;
      if (eliteWord && !elite) return { error: `no elite affix "${eliteWord}" (${ELITES.map((e) => e.key).join(', ')})` };
      if (boss) return { sends: [spawnSend(boss.hit.id, 1, nums[0] ?? 0, true)] };
      return { sends: [spawnSend(en!.hit.id, nums[0] ?? 1, nums[1] ?? 0, false, elite?.id ?? 0)] };
    }
    case 'despawn':
      return { sends: [send(DEV_ACT.despawn)] };
    case 'event': {
      const ev = a0 ? leading(WORLD_EVENTS, args) : null;
      if (!ev) return { error: `usage: ${def.usage} (${WORLD_EVENTS.map((e) => e.key).join(', ')})` };
      return { sends: [send(DEV_ACT.event, 0, ev.hit.id)] };
    }
    case 'tame':
    case 'pet': {
      const sp = a0 ? leading(SPECIES, args) : null;
      if (!sp) return { error: `usage: ${def.usage} (${SPECIES.map((s) => s.key).join(', ')})` };
      if (def.name === 'tame') return { sends: [send(DEV_ACT.tameable, sp.hit.id)] };
      let variant = 0;
      let element = -1;
      let level = 1;
      for (const w of sp.rest) {
        const lw = w.toLowerCase();
        const n = num(w);
        if (n !== null) level = n;
        else if (lw === 'shiny') variant = 1;
        else if (lw.startsWith('elemental')) {
          variant = 2;
          element = Math.max(0, ELEMENTS.indexOf((lw.split(':')[1] ?? 'fire') as (typeof ELEMENTS)[number]));
        } else return { error: `don't know "${w}" (shiny, elemental[:fire], a level)` };
      }
      return { sends: [petSend(sp.hit.id, variant, level, element)] };
    }
    case 'steed':
      if ((err = need(a0 === undefined || (n0 !== null && n0 >= 0 && n0 <= 5)))) return { error: err };
      return { sends: [send(DEV_ACT.steed, 0, n0 ?? 0)] };
    case 'quest': {
      const op = { step: 1, done: 2, finish: 2, complete: 2, abandon: 3 }[(args[1] ?? 'done').toLowerCase()];
      if (!a0 || !op) return { error: `usage: ${def.usage}` };
      if (a0.toLowerCase() === 'all') return { sends: [send(DEV_ACT.quest, 0, op)] };
      const q = n0 !== null ? ctx.quests.find((x) => x.id === n0) : ctx.quests.find((x) => x.title.toLowerCase().includes(a0.toLowerCase()));
      if (!q && n0 === null) return { error: `no active quest "${a0}"` };
      return { sends: [send(DEV_ACT.quest, q?.id ?? n0!, op)] };
    }
    case 'reveal':
      return { sends: [send(DEV_ACT.reveal)] };
    case 'attune':
      return { sends: [send(DEV_ACT.attune)] };
    case 'achieve': {
      if (a0?.toLowerCase() === 'all') return { sends: [send(DEV_ACT.achieve, 0)] };
      const ac = a0 ? leading(ACHIEVEMENTS, args) : null;
      if (!ac) return { error: a0 ? `no achievement "${args.join(' ')}"` : `usage: ${def.usage}` };
      return { sends: [send(DEV_ACT.achieve, ac.hit.id)] };
    }
    case 'rift': {
      const sub = (a0 ?? '').toLowerCase();
      const ch = args[1] === undefined ? 0 : Number(args[1]);
      const st = args[2] === undefined ? 1 : Number(args[2]);
      if (sub === 'spawn') {
        if (!Number.isInteger(ch) || ch < 0 || ch > 5) return { error: 'usage: /rift spawn [chapter 1-5]' };
        return { sends: [send(DEV_ACT.rift, 0n, DEV_RIFT.spawn | (ch << 4))] };
      }
      if (sub === 'go') {
        if (!Number.isInteger(ch) || ch < 1 || ch > 5 || !Number.isInteger(st) || st < 1 || st > 50) return { error: 'usage: /rift go <chapter 1-5> <room 1-50>' };
        return { sends: [send(DEV_ACT.rift, 0n, DEV_RIFT.go | (ch << 4) | (st << 8))] };
      }
      const simple: Record<string, number> = { win: DEV_RIFT.win, leave: DEV_RIFT.leave, list: DEV_RIFT.list };
      if (simple[sub] === undefined) return { error: `usage: ${def.usage}` };
      return { sends: [send(DEV_ACT.rift, 0n, simple[sub])] };
    }
    case 'story': {
      const sub = (a0 ?? '').toLowerCase();
      if (sub === 'act') {
        const act = Number(args[1]);
        const step = args[2] === undefined ? 0 : Number(args[2]);
        if (!Number.isInteger(act) || act < 1 || act > 6 || !Number.isInteger(step) || step < 0 || step > 20) return { error: 'usage: /story act <1-6> [step]' };
        return { sends: [send(DEV_ACT.story, BigInt(act | (step << 8)), DEV_STORY.jump)] };
      }
      if (sub === 'hush') {
        const pct = Number(args[1]);
        if (!Number.isInteger(pct) || pct < 1 || pct > 100) return { error: 'usage: /story hush <1-100>' };
        return { sends: [send(DEV_ACT.story, BigInt(pct), DEV_STORY.hush)] };
      }
      const simple: Record<string, number> = { heartfall: DEV_STORY.heartfall, win: DEV_STORY.win, vigil: DEV_STORY.vigil, places: DEV_STORY.places, reset: DEV_STORY.reset, bells: DEV_STORY.bells, down: DEV_STORY.down };
      if (simple[sub] === undefined) return { error: `usage: ${def.usage}` };
      return { sends: [send(DEV_ACT.story, 0n, simple[sub])] };
    }
    case 'vibe': {
      const v = parseVibe(args, ctx.vibe ?? { results: [], total: 0, offset: 0, cursor: -1, regions: [], filter: { biome: -1, landmark: 0, region: -1, levelMin: 0, levelMax: 0, stamped: 0, distMin: 0, distMax: 0, tier: -1, n: 0, offset: 0, go: false, random: false }, here: null });
      if ('error' in v) return v;
      return { sends: v.sends, note: v.note, vibe: { filter: v.filter, cursor: v.cursor } };
    }
    case 'music': {
      const m = parseMusic(args);
      if ('error' in m) return m;
      return { sends: [], music: m };
    }
    case 'reset':
      if (a0 !== 'yes') return { error: 'this resets your character: type /reset yes' };
      return { sends: [send(DEV_ACT.reset)] };
  }
  return { error: `unknown command ${words[0]}` };
}

/** Completions for the line as typed so far (whole lines, ready to put in the box). */
export function complete(line: string, ctx: CmdCtx): string[] {
  const m = /^\s*\/?(\S*)(\s+(.*))?$/.exec(line);
  if (!m) return [];
  const head = m[1].toLowerCase();
  if (m[2] === undefined) return COMMANDS.filter((c) => c.name.startsWith(head)).map((c) => `/${c.name} `);
  const def = commandDef(head);
  const q = (m[3] ?? '').trimStart();
  if (!def?.arg || /\s/.test(q.trim())) return [];
  const pre = `/${def.name} `;
  const keys = (list: readonly { key: string; name: string }[], extra: string[] = []) => [...extra.filter((e) => e.startsWith(q.toLowerCase())), ...suggest(list, q).map((x) => x.key)].slice(0, 8).map((k) => pre + k);
  switch (def.arg) {
    case 'item':
      return keys(itemCatalog());
    case 'spell':
      return keys(SPELLS, ['all']);
    case 'enemy':
      return keys([...BOSSES, ...ENEMIES]);
    case 'species':
      return keys(SPECIES);
    case 'event':
      return keys(WORLD_EVENTS);
    case 'weather':
      return keys(WEATHER, ['seeded']);
    case 'achievement':
      return keys(ACHIEVEMENTS, ['all']);
    case 'skill':
      return keys(SKILLS, ['all']);
    case 'command':
      return keys(COMMANDS.map((c) => ({ key: c.name, name: c.name })));
    case 'vibe':
      return ['find ', 'go next', 'go random', 'level ', 'spawn', 'freeze', 'demons off', 'here'].filter((x) => x.startsWith(q.toLowerCase())).map((x) => pre + x);
    case 'place':
      return suggest(
        ctx.places.map((p) => ({ key: p.name, name: p.name })),
        q,
      ).map((p) => `${pre}"${p.key}"`);
  }
  return [];
}

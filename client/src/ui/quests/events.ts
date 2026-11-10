// Quest wire glue (playtest 1, CR 013): Event kinds 950-955 and Interact 60
// (contracts/events.md). The zone sends the whole log as JSON (950) after
// join and on every change; offers (951) carry every step's markers so the
// client can preview where a quest takes place before accepting.

export const QEV = {
  log: 950,
  offer: 951,
  step: 952,
  completed: 953,
  refused: 954,
  started: 955,
} as const;

export const QUEST_INTERACT = 60;
export const QUEST_ACT = { accept: 1, abandon: 2, turnIn: 3, track: 4 } as const;

export const QUEST_REFUSAL: Record<number, string> = {
  1: 'Unknown quest',
  2: 'Hand it in at the bounty board or the bounty keeper of its town',
  3: 'You don\'t have everything yet',
  4: 'Your quest log is full',
  5: 'You already have that quest',
  6: 'You already completed that quest',
};

export const QUEST_KIND = { bounty: 0, story: 1, side: 2 } as const;

/** The journal's word for a quest kind. */
export const QUEST_KIND_LABEL: Record<number, string> = { 0: 'Bounty', 1: 'Story', 2: 'Request' };

/** A place a quest step points at (meters). r > 0: an area circle. */
export interface QuestMarker {
  x: number;
  z: number;
  r?: number;
  label: string;
}

export interface QuestView {
  id: number;
  key: string;
  kind: number;
  title: string;
  giver: string;
  step: number;
  steps: { text: string; done: boolean }[];
  text: string;
  note?: string;
  progress: number;
  need: number;
  markers: QuestMarker[];
  gold: number;
  xp: number;
  turnIn?: boolean;
  /** Offers only: every step's markers. */
  stepMarkers?: QuestMarker[][];
  /** CR 023: reward items, equipment rolls, renown (with repTown), the giver's offer line. */
  items?: { item: string; qty: number }[];
  rollItems?: number;
  rep?: number;
  repTown?: string;
  say?: string;
}

export interface QuestLogView {
  tracked: number;
  quests: QuestView[];
}

const utf8 = new TextDecoder();

function json<T>(data: Uint8Array): T | null {
  try {
    return JSON.parse(utf8.decode(data)) as T;
  } catch {
    return null;
  }
}

function normQuest(q: Partial<QuestView>): QuestView {
  return {
    id: (q.id ?? 0) >>> 0,
    key: q.key ?? '',
    kind: q.kind ?? 0,
    title: q.title ?? 'Quest',
    giver: q.giver ?? '',
    step: q.step ?? 0,
    steps: q.steps ?? [],
    text: q.text ?? '',
    note: q.note,
    progress: q.progress ?? 0,
    need: q.need ?? 0,
    markers: q.markers ?? [],
    gold: q.gold ?? 0,
    xp: q.xp ?? 0,
    turnIn: q.turnIn,
    stepMarkers: q.stepMarkers,
    items: q.items,
    rollItems: q.rollItems,
    rep: q.rep,
    repTown: q.repTown,
    say: q.say,
  };
}

export function decodeQuestLog(data: Uint8Array): QuestLogView {
  const j = json<{ tracked?: number; quests?: Partial<QuestView>[] }>(data);
  return { tracked: (j?.tracked ?? 0) >>> 0, quests: (j?.quests ?? []).map(normQuest) };
}

export function decodeQuest(data: Uint8Array): QuestView | null {
  const j = json<Partial<QuestView>>(data);
  return j ? normQuest(j) : null;
}

export function decodeJSON<T>(data: Uint8Array): T | null {
  return json<T>(data);
}

/** Compass direction from (x, z) to (tx, tz) (north is -z), as the zone words it. */
export function compassWord(x: number, z: number, tx: number, tz: number): string {
  const a = (Math.atan2(-(tz - z), tx - x) * 180) / Math.PI;
  const dirs = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  let k = Math.floor((a + 22.5) / 45) % 8;
  if (k < 0) k += 8;
  return dirs[k];
}

export function distanceText(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}

/** "420 m north-east" from (x, z) to a marker. */
export function whereText(x: number, z: number, m: QuestMarker): string {
  const d = Math.hypot(m.x - x, m.z - z);
  if (d < 15) return 'here';
  return `${distanceText(d)} ${compassWord(x, z, m.x, m.z)}`;
}

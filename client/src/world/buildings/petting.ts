// Petting the town dogs and cats (playtest 5, CR 054). Pure timeline and
// rules plus the one shared state the animals, the first-person camera and
// hand, and your avatar read (plain module state, like emotes/store.ts).
//
// The moment is PET_DUR_S long: the body lowers and leans in (about 0.6 s,
// eased), the hand strokes from the head down the back three times (a
// stroke is 0.45 s: the hand glides, lifts, and goes back to the head), and
// the body rises again over the last half second. Everything below is a
// function of the time since E, so the camera, the hand, the dog and the
// tests all agree.

export const PET_INTERACT = 183;
export const EV_ANIMAL_PET = 1970;
export const EV_ANIMAL_PET_REFUSED = 1971;
/** content.yaml emotes `pet_animal`: the avatar's kneeling, stroking pose. */
export const EMOTE_PET_ANIMAL = 26;
export const PET_ACT = { start: 1, stop: 2 } as const;

export const PET_DUR_S = 2.5;
/** You can pet an animal within this horizontal distance of your feet. */
export const PET_REACH_M = 2.6;
/** Where the animal stands for it: this far in front of you, facing you. */
export const PET_STAND_M = 1.45;
const STROKES = 3;
const STROKE_FROM_S = 0.7;
const STROKE_S = 0.45;
const STROKES_END_S = STROKE_FROM_S + STROKES * STROKE_S;

export const PET_REFUSAL: Record<number, string> = {
  1: 'Not from the saddle',
  2: 'Not in a fight',
  3: 'Slow down a little',
  4: 'There is no one to pet here',
  5: 'Stand still on the ground first',
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** The animal key of the wire: settlement index << 8 | the animal's index in the settlement's plan. */
export const animalKey = (settlement: number, index: number): number => ((settlement << 8) | (index & 0xff)) >>> 0;
export const splitKey = (key: number): { settlement: number; index: number } => ({ settlement: key >>> 8, index: key & 0xff });

export interface PetBeat {
  /** 0 standing .. 1 fully crouched and leaning in. */
  crouch: number;
  /** 0 hand away .. 1 hand on the animal. */
  reach: number;
  /** Stroke position along the animal: 0 the head .. 1 the rump. */
  s: number;
  /** Hand lift off the fur (m), a little while stroking, more on the way back to the head. */
  lift: number;
  /** Which stroke (0-based), -1 outside the strokes. */
  stroke: number;
  /** The animal's contentment: 0 .. 1 (sits, leans in, wags faster). */
  joy: number;
}

/** The moment `t` seconds after E (clamped to its length). */
export function petBeat(t: number): PetBeat {
  const crouch = smooth(0, 0.6, t) * (1 - smooth(PET_DUR_S - 0.5, PET_DUR_S, t));
  const reach = smooth(0.3, 0.8, t) * (1 - smooth(STROKES_END_S, PET_DUR_S - 0.1, t));
  let s = 0;
  let lift = 0.02;
  let stroke = -1;
  if (t >= STROKE_FROM_S && t < STROKES_END_S) {
    const u = (t - STROKE_FROM_S) / STROKE_S;
    stroke = Math.floor(u);
    const f = u - stroke;
    if (f < 0.78) {
      s = smooth(0, 0.78, f); // the long, slow part: head to rump
      lift = 0.012;
    } else {
      const g = (f - 0.78) / 0.22; // lift and glide back to the head
      s = 1 - smooth(0, 1, g);
      lift = 0.012 + 0.07 * Math.sin(Math.PI * g);
    }
  } else if (t >= STROKES_END_S) {
    s = 0;
    lift = 0.02 + 0.12 * smooth(STROKES_END_S, PET_DUR_S, t);
  }
  const joy = smooth(0.25, 0.9, t) * (1 - smooth(PET_DUR_S + 0.9, PET_DUR_S + 1.6, t));
  return { crouch, reach, s, lift, stroke, joy };
}

/** Does this petting include a roll onto the back (about one in four, by the animal's seed and the start time)? */
export function rollsOver(seed: number, startMs: number, kind: number): boolean {
  if (kind !== 1) return false; // dogs only
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(Math.floor(startMs / 100) | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return (h >>> 7) % 4 === 0;
}

/** The roll's angle (0 .. PI) t seconds in: over on the back from 1.1 s to 2.3 s, upright again by the end. */
export function rollAngle(t: number): number {
  return Math.PI * smooth(1.0, 1.5, t) * (1 - smooth(2.0, 2.45, t));
}

export interface PetFacts {
  mounted: boolean;
  downed: boolean;
  inCombat: boolean;
  grounded: boolean;
  swimming?: boolean;
  /** Horizontal distance from your feet to the animal (m). */
  dist: number;
}

/** Why a petting cannot start (null: it can). */
export function petBlocked(f: PetFacts): string | null {
  if (f.mounted) return PET_REFUSAL[1];
  if (f.downed || f.inCombat) return PET_REFUSAL[2];
  if (!f.grounded || f.swimming) return PET_REFUSAL[5];
  if (f.dist > PET_REACH_M + 0.4) return 'Too far to reach';
  return null;
}

/** Does moving (or anything else) end a petting in progress? Standing still keeps it. */
export function petCancelled(f: { speed: number; grounded: boolean; mounted: boolean; inCombat: boolean; downed: boolean; jumped?: boolean }): boolean {
  return f.speed > 0.7 || !f.grounded || f.mounted || f.inCombat || f.downed || !!f.jumped;
}

/** Forward unit vector (x, z) of a look yaw (yaw 0 faces -z; positive turns toward -x). */
export function forwardOfYaw(yaw: number): { x: number; z: number } {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * The hand target on an animal: from the top of its head (s = 0) to its
 * rump (s = 1), lifted off the fur. The anchors are world positions the
 * animal publishes each frame (its head top and rump top, whatever pose it is in).
 */
export function handTarget(head: V3, back: V3, beat: PetBeat, out: V3): V3 {
  out.x = head.x + (back.x - head.x) * beat.s;
  out.y = head.y + (back.y - head.y) * beat.s + beat.lift;
  out.z = head.z + (back.z - head.z) * beat.s;
  return out;
}

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** The petting you are doing (null fields when none). Read by the animals, camera, hand and avatar. */
export const petState = {
  active: false,
  /** Animal key (animalKey). */
  key: 0,
  kind: 1,
  name: '',
  /** performance.now() ms of the start. */
  startedAt: 0,
  /** Seconds in (updated by tickPet). */
  t: 0,
  beat: petBeat(0),
  /** The animal's drawn head top, rump top and centre (world metres), published by TownAnimals every frame. */
  head: { x: 0, y: 0, z: 0 } as V3,
  back: { x: 0, y: 0, z: 0 } as V3,
  centre: { x: 0, y: 0, z: 0 } as V3,
  /** Bumped when a petting finishes (the owner's remark, counters). */
  finished: 0,
  /** Where the petting started (feet), for the "you moved" test. */
  fx: 0,
  fz: 0,
};

export function beginPet(key: number, kind: number, name: string, now: number, feet: { x: number; z: number }): void {
  petState.active = true;
  petState.key = key;
  petState.kind = kind;
  petState.name = name;
  petState.startedAt = now;
  petState.t = 0;
  petState.beat = petBeat(0);
  petState.fx = feet.x;
  petState.fz = feet.z;
}

export function endPet(completed: boolean): void {
  if (!petState.active) return;
  petState.active = false;
  petState.t = 0;
  petState.beat = petBeat(0);
  if (completed) petState.finished++;
}

/** Per frame: advance the clock; true while running. Finishes by itself after PET_DUR_S. */
export function tickPet(now: number): boolean {
  if (!petState.active) return false;
  petState.t = (now - petState.startedAt) / 1000;
  if (petState.t >= PET_DUR_S) {
    endPet(true);
    return false;
  }
  petState.beat = petBeat(petState.t);
  return true;
}

/** What others' pettings look like to this client: the animals they are at, until when (animal key -> record). */
export interface RemotePet {
  entityId: number;
  /** performance.now() ms of the start. */
  from: number;
  until: number;
  /** The petter's feet and look yaw at the start (from Event 1970; the avatar's drawn yaw once seen). */
  x: number;
  z: number;
}

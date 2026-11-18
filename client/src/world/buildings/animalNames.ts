// Names for the town dogs and cats (playtest 5, CR 054: "give some dogs
// names"). Pure and deterministic from the settlement id and the animal's
// index in its plan (animalsPlan.ts), so every client agrees and nothing is
// sent over the wire. Names are unique within a settlement while the list
// lasts. The owner of a dog is a townsperson picked the same way, and speaks
// its name in the barks below (npcs the player stands near).

import { ANIMAL } from './animalsPlan';
import { h32 } from './npcLines';

export const DOG_NAMES = [
  'Biscuit', 'Old Tam', 'Mudge', 'Pepper', 'Bramble', 'Sir Wags', 'Tuppence', 'Rufus', 'Nutmeg', 'Barley',
  'Juniper', 'Scrap', 'Crumpet', 'Gravy', 'Bosun', 'Fennel', 'Ember', 'Haggis', 'Pudding', 'Thistle',
  'Mabel', 'Cobb', 'Dumpling', 'Smudge',
] as const;

export const CAT_NAMES = [
  'Marmalade', 'Soot', 'Whisker', 'Mistress Pip', 'Sorrel', 'Tansy', 'Inkling', 'Biddy', 'Muffin', 'Cinders',
  'Pickle', 'Velvet', 'Madam Hush', 'Quill', 'Dusty', 'Saffron', 'Nip', 'Clover', 'Mortimer', 'Wick',
] as const;

/**
 * The name of animal `index` (its position in planAnimals' list) of settlement
 * `id`. Chickens have none (''). Dogs and cats of one settlement never share
 * a name (probing along the list), as long as the list is longer than the
 * animals in a town (it is).
 */
export function animalName(kind: number, id: number, index: number, taken: ReadonlySet<string> = new Set()): string {
  if (kind !== ANIMAL.dog && kind !== ANIMAL.cat) return '';
  const pool = kind === ANIMAL.dog ? DOG_NAMES : CAT_NAMES;
  const start = h32(id >>> 0, index, 0x517 + kind) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const n = pool[(start + k) % pool.length];
    if (!taken.has(n)) return n;
  }
  return pool[start];
}

/** Names for a whole plan (kinds in plan order), unique per kind within the settlement. */
export function nameAll(kinds: readonly number[], id: number): string[] {
  const takenDog = new Set<string>();
  const takenCat = new Set<string>();
  return kinds.map((kind, i) => {
    const set = kind === ANIMAL.dog ? takenDog : takenCat;
    const n = animalName(kind, id, i, set);
    if (n) set.add(n);
    return n;
  });
}

/** Which of `count` candidate owners keeps this animal (0..count-1; -1 when there is nobody). */
export function ownerOf(id: number, index: number, count: number): number {
  return count <= 0 ? -1 : h32(id >>> 0, index, 0x0ae) % count;
}

/** What the E prompt says ("Pet Biscuit"; unnamed animals: "Pet the dog"). */
export function petPrompt(kind: number, name: string): string {
  return `[E] Pet ${name || (kind === ANIMAL.cat ? 'the cat' : 'the dog')}`;
}

const CALL_DOG = [
  '{n}! Leave the traveller be!',
  '{n}, come here, you rascal!',
  'Mind {n}, friend, he is all paws.',
  '{n}! Heel!',
  'Do not mind {n}. He thinks everyone is his friend.',
  '{n}! Not in the road!',
];
const CALL_CAT = ['{n} does as {n} pleases, I am afraid.', 'That is {n}. She owns the step, not me.', 'Do not mind {n}, she is only judging you.'];
const PETTED_DOG = [
  '{n} likes you. He does not like everyone.',
  'Well, look at that. {n} has taken to you.',
  "That is {n}'s favourite spot, behind the ear.",
  'You have a friend for life now. {n} never forgets a kind hand.',
];
const PETTED_CAT = ['{n} is purring! She never purrs for strangers.', 'Fancy that, {n} let you.', '{n} has chosen you. Congratulations.'];

const fill = (t: string, name: string) => t.split('{n}').join(name);

/** What an owner says when their animal pesters or charms the player; `petted` after a petting. */
export function ownerLine(kind: number, name: string, petted: boolean, seed: number): string {
  const pool = kind === ANIMAL.cat ? (petted ? PETTED_CAT : CALL_CAT) : petted ? PETTED_DOG : CALL_DOG;
  return fill(pool[h32(seed) % pool.length], name || (kind === ANIMAL.cat ? 'the cat' : 'the dog'));
}

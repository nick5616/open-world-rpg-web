// What townsfolk say out loud when nobody is running a dialog (playtest 4,
// CR 050): greetings, market cries, grumbles about the rain, a guard's call
// at dusk, a cheer, and the little conversations two neighbours have when
// they stop to talk (some of it rumour that points at real places in the
// region). Pure data and a pure picker: the renderer decides when, these
// decide what. All lines are original; short enough to read in a few seconds.

export type TimeBucket = 'morning' | 'day' | 'evening' | 'night';

export function timeBucket(hour: number): TimeBucket {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

/** Deterministic 32-bit mix of up to three integers. */
export function h32(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function pick<T>(pool: readonly T[], seed: number): T {
  return pool[h32(seed) % pool.length];
}

// Roles: 0 villager, 1 merchant, 2 blacksmith, 3 innkeeper, 4 bounty keeper, 5 farmer, 6 guard.

const HELLO_ANY = ['Well met!', 'Hello there.', 'Good to see a new face.', 'Welcome, traveller.', 'Mind the cobbles!', 'Hail!'];

const HELLO: Record<number, Partial<Record<TimeBucket, string[]>>> = {
  0: {
    morning: ['Morning! Sleep well?', 'Up with the roosters, are you?', 'Good morning to you!'],
    day: ['Fine day for it.', 'Hello! Lost? Everyone is, at first.', 'Afternoon, friend.'],
    evening: ['Evening. Supper smells good tonight.', 'Getting dark soon. Stay close to the lamps.', 'Evening, traveller.'],
    night: ['Late to be about, friend.', 'Quiet night. Just how I like it.'],
  },
  1: {
    morning: ['Fresh stock this morning, take a look!', 'First customer of the day gets a smile. That is you.'],
    day: ['Browse all you like, no charge for looking!', 'Something catch your eye?'],
    evening: ['Last chance today, friend!', 'Closing soon, but not for you.'],
  },
  2: {
    morning: ['Mind the sparks!', 'Forge is hot, as ever.'],
    day: ['Need something mended?', 'Steel does not shape itself, you know.'],
    evening: ['One more blade before supper.'],
  },
  3: {
    morning: ['Breakfast is on, and the bed is made.', 'Porridge for the early birds!'],
    day: ['Stew is hot and the ale is cold.', 'Come in, come in, the fire is lit.'],
    evening: ['A seat by the fire for you, traveller.', 'Warm beds and a warmer welcome!'],
    night: ['We never lock the door at the inn.'],
  },
  4: {
    day: ['The board has fresh work, if you have the nerve.', 'Looking for a job? I have a few.'],
    morning: ['New notices went up at dawn.'],
    evening: ['Jobs do not post themselves.'],
  },
  5: {
    morning: ['Morning! The dew is still on the barley.', 'Early start. The crops do not wait.'],
    day: ['Hot work, but honest work.', 'Mind the furrows, friend.'],
    evening: ['Another day in the field done.'],
  },
  6: {
    morning: ['All quiet on the road. Move along safely.', 'Morning. Keep to the road and you will be fine.'],
    day: ['Halt, friend. Ah, you are fine. Carry on.', 'Keep your blade sheathed in town and we will get on.'],
    evening: ['Evening. Gates close soon.', 'Stay by the lamps after dark.'],
    night: ['Night watch. Keep to the lit streets.', 'Nothing stirs. Nothing I cannot handle.'],
  },
};

const HELLO_RAIN = ['Wet enough for you?', 'Ha! Even the ducks went in.', 'Get under a roof, friend!', 'This will make the crops happy, at least.', 'Rain again. Hello, though!'];

/** A greeting for the player, by role, time of day and weather. */
export function greetingFor(role: number, hour: number, rain: boolean, seed: number): string {
  if (rain && h32(seed, 7) % 3 !== 0) return pick(HELLO_RAIN, seed);
  const byTime = HELLO[role]?.[timeBucket(hour)];
  if (byTime && h32(seed, 3) % 4 !== 0) return pick(byTime, seed);
  return pick(HELLO_ANY, seed);
}

/** Merchant cries by merchant kind (the towns buffer's `merchant`: 0 general goods, 1 provisions, 2 herbalist, 3 tools). */
const CRIES: string[][] = [
  ['Needles, rope, candles, and a bit of everything!', 'Honest prices! Mostly honest, anyway.', 'Everything you forgot to pack, right here!'],
  ['Apples! Crisp as a frost!', 'Fresh bread, still warm!', 'Smoked cheese, who will have a wedge?', 'Pies! Mind the steam!'],
  ['Herbs for the cough, herbs for the heart!', 'Moonpetal and yarrow, picked this morning!', 'A pinch of this and you will never feel it.'],
  ['Picks, hammers, hatchets! Built to last!', 'A sharp axe is a happy axe!', 'Shovels! Because the ground will not dig itself!'],
];
const CRIES_SMITH = ['Hot iron!', 'Blades sharpened, shoes fitted!', 'Clang and ring, that is the sound of an honest day.'];
const CRIES_FARMER = ['Mind the seedlings!', 'Good soil this year.', 'Come on, you stubborn weeds.'];
const CRIES_INN = ['Ale and stew, the finest in the valley!', 'Beds going fast tonight!'];

export function cryFor(role: number, merchantKind: number, seed: number): string {
  if (role === 1) return pick(CRIES[merchantKind >= 0 && merchantKind < CRIES.length ? merchantKind : 0], seed);
  if (role === 2) return pick(CRIES_SMITH, seed);
  if (role === 5) return pick(CRIES_FARMER, seed);
  if (role === 3) return pick(CRIES_INN, seed);
  return pick(HELLO_ANY, seed);
}

export const RAIN_LINES = ['Ugh, soaked through!', 'Quick, inside!', 'My hat! My poor hat!', 'There goes the washing.', 'Just a shower, just a shower...', 'Under the eaves, hurry!'];
export const FEAR_LINES = ['Something is out there!', 'Get inside, get inside!', 'Guards! Guards!', 'Not again...', 'Bar the doors!'];
export const GUARD_THREAT = ['Stay back, I have got this!', 'Hold the line!', 'Away from the houses, beast!', 'To arms, there is something at the gate!'];
export const CHEER_LINES = ['Well done!', 'Bravo, traveller!', 'Now that deserves a cheer!', 'Stronger by the day, that one.', 'Hurrah!'];
export const DUSK_LINES = ['Lanterns! Light the lanterns!', 'Gates close at nightfall!', 'Lamps up, folks. Dusk is here.'];

// ---- Conversations ---------------------------------------------------------

/** Two people, alternating lines (A speaks first). Gossip points at real things in the region: lights in the hills, the dwarves, bandits, the sky islands. */
export const CONVOS: readonly (readonly string[])[] = [
  ['Did you see the light up in the hills last night?', 'Strange green thing, hanging over the ridge?', 'That one! Third night running.', 'My gran says it is a lantern. Nobody has told the hills.'],
  ['They say the dwarves are still down there, under the mountain.', 'Still hammering? I thought that was my headache.', 'You can hear it from the well, if you lean in.', 'I am not leaning into a well for any dwarf.'],
  ['Hank came back from the north road with no cart.', 'No cart? What about the barrels?', 'Bandits. Four of them, and one wore a very silly hat.', 'Silly hats are how you know they mean it.'],
  ['You ever seen the islands in the sky, up past the clouds?', 'On a clear morning. Gives me a crick in the neck.', 'Folk say there is a palace on the biggest one.', 'Who keeps the roof tidy, I wonder.'],
  ['Did you hear the Hollow Bell last night?', 'Do not remind me. I slept with the quilt on my head.', 'It was only the wind.', 'The wind does not usually ring in threes.'],
  ['Is it true the guards doubled the watch?', 'Because of the bandits on the north road.', 'And the lights in the hills.', 'And the dwarves? Put the dwarves in as well, why not.'],
  ['My hens stopped laying.', 'The cold?', 'The fox. Or a dog. Or the shadow of a fox.', 'Have you tried asking nicely?'],
  ['Heard the blacksmith made a blade that hums.', 'Hums? A song or a warning?', 'Depends who you ask. Hums at night, mostly.', 'I will not ask. I am keeping my dinner.'],
  ['Market was slow today.', 'Everyone is watching the road.', 'You cannot eat a road.', 'You can if the flour is bad enough.'],
  ['I found a coin in the stream, old as anything.', 'A strange face on it?', 'A crown, and some writing I cannot read.', 'Show it to the innkeeper. She reads everything.'],
  ['Do you think the dwarves know we can hear them?', 'I think they like it.', 'Like what?', 'Being the reason we whisper.'],
  ['Mara says the lights in the hills moved last night.', 'Moved? Which way?', 'Toward the old ruins.', 'Then they have better taste than the bandits.'],
  ['Lovely weather for it.', 'For what?', 'Whatever we are going to complain about next.', 'The rain. Always the rain.'],
  ['Have you been up to the old watchtower lately?', 'Not since the stairs argued with me.', 'There is a light up there, some nights.', 'Not a lamp, you think?', 'Nobody lives there to light one.'],
  ['The apples were awful this year.', 'Worms?', 'Opinions. Every apple had an opinion.', 'That is the best kind of orchard, truly.'],
  ['What would you do if you found a dragon?', 'Politely leave.', 'And if it asked you to stay for supper?', 'Then I would bring pie.'],
  ['The wagon driver says there is a ruined shrine out past the river.', 'With a ward on it, glowing blue.', 'Glowing blue is never good news.', 'Nor good for the sheep.'],
  ['I saw a figure on the north road at dusk.', 'A traveller?', 'It carried no lantern. And the road was dark.', 'Well. Do not stand about telling me that at dusk.'],
];

export const CONVO_COUNT = CONVOS.length;

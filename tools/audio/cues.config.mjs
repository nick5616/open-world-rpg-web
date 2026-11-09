// What every shipped sound is made of (the sound design, as data).
//
// A cue has variants; a variant mixes layers; a layer is a slice of a
// source file (start `ss`, length `t`, playback `rate`, an ffmpeg filter
// chain `af`, gain `db`, `delay` ms) or a synthesized signal (`synth`, an
// ffmpeg aevalsrc expression). build-audio.mjs renders each variant,
// peak-normalizes it and encodes Ogg Opus + AAC. Music tracks are encoded
// whole, loudness-matched, with the edits listed here.
//
// Sources: RPG = Nicole's tracks (C:\Users\nickb\Documents\ableton\rpg),
// everything else is a Novation Anniversary pack under C:\Samples
// (royalty-free; see CREDITS.md). Slice times were chosen from onset
// analysis and spectrograms (tools/audio/README.md "How cues were picked").

export const ROOTS = {
  RPG: process.env.LODESTONE_AUDIO_RPG ?? 'C:/Users/nickb/Documents/ableton/rpg',
  SAMPLES: process.env.LODESTONE_AUDIO_SAMPLES ?? 'C:/Samples',
};

const D1 = 'SAMPLES:Novation Anniversary Soundpack 1st Drop/';
const D2 = 'SAMPLES:Novation Anniversary Pack 2nd Drop/';
const D3 = 'SAMPLES:Novation Anniversary 3rd Drop/';

// Packs (credit names)
export const PACKS = {
  [`${D1}Novation FX Soundpack/`]: 'Novation Anniversary Soundpack (1st Drop): FX Soundpack',
  [`${D1}Novation Acoustic Drums Soundpack/`]: 'Novation Anniversary Soundpack (1st Drop): Acoustic Drums Soundpack',
  [`${D1}Novation Hyperpop Soundpack (Gm, 150bpm)/`]: 'Novation Anniversary Soundpack (1st Drop): Hyperpop Soundpack',
  [`${D1}Novation Analog Synthwave Soundpack (Bbm, 134bpm)/`]: 'Novation Anniversary Soundpack (1st Drop): Analog Synthwave Soundpack',
  [`${D1}Novation Old School Hip-Hop Soundpack (Em, 107bpm)/`]: 'Novation Anniversary Soundpack (1st Drop): Old School Hip-Hop Soundpack',
  [`${D2}Japanese LoFi/`]: 'Novation Anniversary Pack (2nd Drop): Japanese LoFi',
  [`${D2}East Coast Hip Hop/`]: 'Novation Anniversary Pack (2nd Drop): East Coast Hip Hop',
  [`${D2}Phonk Hip Hop/`]: 'Novation Anniversary Pack (2nd Drop): Phonk Hip Hop',
  [`${D2}Retro Disco/`]: 'Novation Anniversary Pack (2nd Drop): Retro Disco',
  [`${D2}Modern Hip Hop/`]: 'Novation Anniversary Pack (2nd Drop): Modern Hip Hop',
  [`${D2}World Flute Trap/`]: 'Novation Anniversary Pack (2nd Drop): World Flute Trap',
  [`${D3}Horror Trap (Fm, 146bpm)/`]: 'Novation Anniversary (3rd Drop): Horror Trap',
  [`${D3}Indie Hip Hop (Amaj, 84bpm)/`]: 'Novation Anniversary (3rd Drop): Indie Hip Hop',
  [`${D3}Acid Techno (Ab, 131bpm)/`]: 'Novation Anniversary (3rd Drop): Acid Techno',
  [`${D3}EBM Energy (Fm, 120bpm)/`]: 'Novation Anniversary (3rd Drop): EBM Energy',
  'RPG:': "Nicole's original tracks for Lodestone (Documents/ableton/rpg)",
};

// Source files
const FX = (n) => `${D1}Novation FX Soundpack/FX/${n}`;
const AD = (n) => `${D1}Novation Acoustic Drums Soundpack/Acoustic Drum Loops/Acoustic Drums${n}.wav`;
const HP = (n) => `${D1}Novation Hyperpop Soundpack (Gm, 150bpm)/FX/FX_Gm_150bpm_${n}.aif`;
const SWV = (dir, n) => `${D1}Novation Analog Synthwave Soundpack (Bbm, 134bpm)/${dir}/${n}`;
const OS = (n) => `${D1}Novation Old School Hip-Hop Soundpack (Em, 107bpm)/FX/FX_Em_107bpm_${n}.aif`;
const JL = (n) => `${D2}Japanese LoFi/FX/FX ${n}.wav`;
const EC = (n) => `${D2}East Coast Hip Hop/FX/One-Shot ${n}.wav`;
const PV = (n) => `${D2}Phonk Hip Hop/Vocals/Vocals ${n}.wav`;
const RD = (n) => `${D2}Retro Disco/FX/FX ${n}.wav`;
const MH = (n) => `${D2}Modern Hip Hop/FX/FX ${n}.wav`;
const WF = `${D2}World Flute Trap/FX/Fx1 0020 [2020-08-03 062925].wav`;
const HT = (n) => `${D3}Horror Trap (Fm, 146bpm)/FX/${n}`;
const IH = (n) => `${D3}Indie Hip Hop (Amaj, 84bpm)/FX/One Shot ${n}.wav`;
const AT = (n) => `${D3}Acid Techno (Ab, 131bpm)/FX/${n}.wav`;
const EB1 = `${D3}EBM Energy (Fm, 120bpm)/FX/FX 0001 [2022-10-20 204338].wav`;
const EB15 = `${D3}EBM Energy (Fm, 120bpm)/FX/FX 0015 [2022-10-23 003255].wav`;
const RPG = (n) => `RPG:${n}.aif`;

const CARVE_SFX = HT('Carve SFX_FX_SFX_16-00_Retrigger_Bar_None [2020-10-26 153328].wav');
const CARVE_FX = HT('Carve Effects_FX_Effects_16-00_Retrigger_Bar_None [2020-10-26 153327].wav');
const DANGER = HT('Danger Harsh_FX_Harsh_16-00_Retrigger_Bar_None [2020-10-26 153328].wav');
const LANTERN = HT('Lantern Short_FX_Short_16-00_Retrigger_Bar_None [2020-10-26 153329].wav');
const STEEL = HT('Steel SFX_FX_SFX_16-00_Retrigger_Bar_None [2020-10-26 153330].wav');

// Slices of the acoustic kit (onset analysis of the loops): kick thuds,
// snare ghosts, snares, closed hats. Footsteps and body hits are built from these.
const KICK = [
  [15, 2.065],
  [12, 2.065],
  [13, 2.614],
  [10, 1.507],
];
const GHOST = [
  [16, 0.968],
  [15, 4.25],
  [14, 1.786],
  [5, 1.517],
];
const SNARE = [
  [4, 0.529],
  [2, 0.529],
  [13, 0.539],
  [5, 0.529],
];
const HAT = [
  [5, 0.808],
  [5, 1.357],
  [5, 1.896],
  [2, 0.808],
];
const kick = (i, o = {}) => ({ f: AD(KICK[i % 4][0]), ss: KICK[i % 4][1], t: 0.16, ...o });
const ghost = (i, o = {}) => ({ f: AD(GHOST[i % 4][0]), ss: GHOST[i % 4][1], t: 0.11, ...o });
const snare = (i, o = {}) => ({ f: AD(SNARE[i % 4][0]), ss: SNARE[i % 4][1], t: 0.22, ...o });
const hat = (i, o = {}) => ({ f: AD(HAT[i % 4][0]), ss: HAT[i % 4][1], t: 0.12, ...o });
const ding = (o = {}) => ({ f: JL(12), ss: 0, t: 0.5, ...o });
const shimmer = (o = {}) => ({ f: EC(6), ss: 0, t: 1.2, ...o });

// A war horn, synthesized: two detuned saws an octave apart, slow attack, dark.
const HORN = "0.3*(2*(t*98-floor(t*98+0.5))+2*(t*98.6-floor(t*98.6+0.5))+0.6*(2*(t*49.2-floor(t*49.2+0.5))))*(1+0.04*sin(2*PI*5*t))";

// A wooden creak, synthesized: stick-slip pulses speeding up (60 -> ~120 Hz),
// through a woody band-pass. Doors, chests, stations.
const CREAK = (secs) => `0.9*gt(sin(2*PI*(60*t+${(30 / secs).toFixed(2)}*t*t))\\,0.92)*sin(PI*t/${secs})`;
const creak = (secs, o = {}) => ({ synth: CREAK(secs), t: secs, af: "bandpass=f=750:w=2,bandpass=f=900:w=1,volume=12dB", ...o });

const v = (...layers) => ({ layers });
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

/** @type {{id: string, mono?: boolean, variants: {layers: object[], fade?: number}[]}[]} */
export const SFX = [
  // ---- UI
  { id: 'ui_click', variants: [v({ f: HP(4), t: 0.1, af: 'highpass=f=400' }), v({ f: IH(3), t: 0.08 }), v({ f: IH(4), t: 0.09, af: 'highpass=f=300' })] },
  { id: 'ui_confirm', variants: [v(ding(), { f: HP(4), t: 0.1, db: -8 })] },
  { id: 'ui_open', variants: [v({ f: IH(1), t: 0.45, af: 'highpass=f=200' })] },
  { id: 'ui_close', variants: [v({ f: IH(1), t: 0.35, rate: 0.8, af: 'highpass=f=200' })] },
  { id: 'ui_error', variants: [v({ f: EC(2), t: 0.3, rate: 0.9 }, { f: IH(5), t: 0.25, db: -6, af: 'lowpass=f=1500' })] },
  { id: 'map_open', variants: [v({ f: OS(4), t: 0.45, af: 'bandpass=f=2500:w=1.5' }, { f: FX('Noise Sweep FX.aif'), ss: 0.9, t: 0.35, db: -10, af: 'highpass=f=1500' })] },
  { id: 'map_close', variants: [v({ f: OS(4), ss: 0.5, t: 0.35, rate: 1.1, af: 'bandpass=f=1800:w=1.5' })] },
  { id: 'notify', variants: [v(ding({ t: 0.4, rate: 1.25 }))] },
  { id: 'whisper', variants: [v(ding({ t: 0.3, rate: 1.5, af: 'lowpass=f=4000' }))] },
  { id: 'quest_accept', variants: [v(shimmer({ t: 1.0 }), { f: HP(4), t: 0.1, db: -6 })] },
  { id: 'quest_complete', variants: [v({ f: RPG('level up sound 2'), rate: 1.122 }, shimmer({ db: -8, delay: 150 }))] },

  // ---- Movement (mono: they sit on the player)
  { id: 'step_soft', mono: true, variants: range(4, (i) => v(kick(i, { t: 0.12, af: 'lowpass=f=500' }), hat(i, { t: 0.08, db: -16, af: 'highpass=f=4000' }))) },
  { id: 'step_hard', mono: true, variants: range(4, (i) => v(ghost(i, { rate: 0.9, af: 'lowpass=f=3500' }), kick(i, { t: 0.1, db: -8, af: 'lowpass=f=400' }))) },
  { id: 'step_snow', mono: true, variants: range(3, (i) => v(hat(i, { t: 0.18, rate: 0.6, af: 'lowpass=f=3000' }), kick(i, { t: 0.1, db: -10, af: 'lowpass=f=300' }))) },
  { id: 'jump', mono: true, variants: [v({ f: FX('Fast FX.wav'), t: 0.25, af: 'lowpass=f=3000' }), v({ f: FX('Fast FX.wav'), ss: 0.1, t: 0.25, rate: 1.1, af: 'lowpass=f=3000' })] },
  { id: 'land', mono: true, variants: [v(kick(2, { t: 0.22, af: 'lowpass=f=250' }), hat(0, { db: -12, af: 'lowpass=f=2000' }), ghost(0, { db: -10 })), v(kick(0, { t: 0.22, af: 'lowpass=f=250' }), hat(3, { db: -12, af: 'lowpass=f=2000' }), ghost(2, { db: -10 }))] },
  { id: 'dash', mono: true, variants: [v({ f: FX('Fast FX.wav'), t: 0.6 }), v({ f: FX('Fast FX.wav'), t: 0.5, rate: 1.15 })] },
  { id: 'dodge', mono: true, variants: [v({ f: FX('Fast FX.wav'), t: 0.4, rate: 1.2 })] },
  { id: 'splash', mono: true, variants: [v({ f: EB1, t: 0.7, af: 'highpass=f=300,lowpass=f=2500' }, kick(1, { t: 0.2, db: -6, af: 'lowpass=f=300' }))] },
  { id: 'swim_stroke', mono: true, variants: [v({ f: FX('Water FX.wav'), ss: 1.2, t: 0.6 }), v({ f: FX('Water FX.wav'), ss: 2.6, t: 0.6 })] },
  { id: 'glide_open', mono: true, variants: [v({ f: FX('Swipe FX.wav'), t: 0.5 }, { f: OS(8), t: 0.3, db: -4, af: 'lowpass=f=1500' })] },
  { id: 'climb_grab', mono: true, variants: range(3, (i) => v(ghost(i + 1, { af: 'lowpass=f=1800' }), { f: OS(4), ss: i * 0.3, t: 0.12, db: -6, af: 'bandpass=f=2000:w=1' })) },

  // ---- Weapons
  { id: 'swing_sword', mono: true, variants: [v({ f: FX('Swipe FX.wav'), t: 0.3, rate: 1.15, af: 'highpass=f=600' }), v({ f: IH(10), t: 0.35, af: 'highpass=f=800' }), v({ f: SWV('FX', 'FX_Bbm_134bpm_7.aif'), t: 0.3, rate: 1.2, af: 'highpass=f=800' })] },
  { id: 'swing_heavy', mono: true, variants: [v({ f: FX('Swipe FX.wav'), t: 0.55, rate: 0.85 }, { f: HP(10), t: 0.5, db: -4, af: 'lowpass=f=3000' })] },
  { id: 'thrust_spear', mono: true, variants: [v({ f: FX('Fast FX.wav'), ss: 0.3, t: 0.3, af: 'highpass=f=1000' }, { f: HP(13), t: 0.29, db: -6 }), v({ f: OS(3), t: 0.3, af: 'highpass=f=1200' })] },
  { id: 'swing_staff', mono: true, variants: [v({ f: FX('Swipe FX.wav'), t: 0.4, rate: 0.75, af: 'lowpass=f=2500' })] },
  { id: 'wand_flick', mono: true, variants: [v({ f: JL(10), t: 0.25, rate: 1.4, af: 'highpass=f=1500' }, { f: FX('Fast FX.wav'), ss: 0.4, t: 0.2, db: -10 })] },
  { id: 'bow_draw', mono: true, variants: [v({ f: IH(11), t: 0.55, af: 'bandpass=f=1500:w=1' }, creak(0.6, { db: -6 }))] },
  { id: 'bow_release', mono: true, variants: [v({ f: HP(4), t: 0.1, rate: 0.6 }, { f: FX('Fast FX.wav'), ss: 0.35, t: 0.3, db: -4, af: 'highpass=f=2000' })] },
  { id: 'bolt', mono: true, variants: [v({ f: JL(10), t: 0.45 }), v({ f: JL(10), t: 0.45, rate: 0.85 })] },
  { id: 'hit', mono: true, variants: range(4, (i) => v(snare(i, { t: 0.18 }), kick(i + 1, { db: -3 }), { f: HP(i % 2 ? 7 : 13), t: 0.12, db: -8, af: 'lowpass=f=6000' })) },
  { id: 'hit_crit', mono: true, variants: range(2, (i) => v(snare(i, { t: 0.2 }), kick(i, { db: -2 }), { f: FX('Metallic FX.wav'), t: 0.5, db: -4 }, { f: FX('Hit FX.wav'), t: 0.6, db: -6, af: 'lowpass=f=2500' })) },
  { id: 'hit_resist', mono: true, variants: [v({ f: FX('Metallic FX.wav'), t: 0.4, rate: 0.8, af: 'lowpass=f=4000' }, snare(1, { db: -8 }))] },
  { id: 'arrow_hit', mono: true, variants: range(2, (i) => v({ f: LANTERN, t: 0.15, rate: 1 + i * 0.1 }, kick(i, { db: -6, af: 'lowpass=f=500' }), hat(i, { db: -12, af: 'highpass=f=3000' }))) },
  { id: 'parry', mono: true, variants: [v({ f: FX('Metallic FX.wav'), t: 0.8 }, { f: AT('STAB B 3'), t: 0.5, db: -6 })] },

  // ---- Spells: cast / impact per element
  { id: 'cast_fire', mono: true, variants: [v({ f: CARVE_SFX, t: 0.7, af: 'lowpass=f=6000' }), v({ f: CARVE_SFX, t: 0.6, rate: 1.12, af: 'lowpass=f=6000' })] },
  { id: 'impact_fire', mono: true, variants: [v({ f: RD(9), t: 1.2, af: 'lowpass=f=5000' }, kick(0, { db: -2 }))] },
  { id: 'cast_ice', mono: true, variants: [v({ f: FX('Metallic FX.wav'), t: 0.6, rate: 1.3, af: 'highpass=f=2000' }, { f: FX('Airy FX.wav'), ss: 0.5, t: 0.7, db: -6, af: 'highpass=f=3000' })] },
  { id: 'impact_ice', mono: true, variants: [v({ f: EC(5), t: 0.9, af: 'highpass=f=1500' }, { f: FX('Metallic FX.wav'), t: 0.5, rate: 1.5, db: -6 })] },
  { id: 'cast_lightning', mono: true, variants: [v({ f: EC(7), t: 0.6, af: 'highpass=f=1000' }, { f: FX('Glitch FX.wav'), ss: 0.3, t: 0.3, db: -6 })] },
  { id: 'impact_lightning', mono: true, variants: [v({ f: FX('Glitch FX.wav'), ss: 0.25, t: 0.5 }, { f: FX('Cymbal Hit FX.wav'), t: 0.6, db: -6, af: 'highpass=f=2000' })] },
  { id: 'cast_earth', mono: true, variants: [v({ f: JL(4), t: 0.8, af: 'lowpass=f=800' }, { f: OS(4), t: 0.5, db: -4, af: 'bandpass=f=1500:w=1' })] },
  { id: 'impact_earth', mono: true, variants: [v({ f: JL(4), t: 1.5 }, { f: OS(4), t: 0.9, db: -4, af: 'lowpass=f=3000' }, kick(2, { db: -2 }))] },
  { id: 'cast_wind', mono: true, variants: [v({ f: FX('Noise Sweep FX.aif'), t: 1.1, af: 'bandpass=f=1500:w=0.7' })] },
  { id: 'impact_wind', mono: true, variants: [v({ f: EB15, t: 0.9, af: 'highpass=f=600' })] },
  { id: 'cast_light', mono: true, variants: [v({ f: AT('FX STAB A 5'), ss: 0.3, t: 1.0, af: 'highpass=f=800' }, ding({ rate: 2, db: -10 }))] },
  { id: 'impact_light', mono: true, variants: [v(shimmer({ t: 1.0 }), { f: HP(4), t: 0.1, db: -6 })] },
  { id: 'cast_dark', mono: true, variants: [v({ f: FX('Deep FX.aif'), t: 1.0 }, { f: PV(3), ss: 0.38, t: 0.45, rate: 0.6, db: -14, af: 'areverse,lowpass=f=1500' })] },
  { id: 'impact_dark', mono: true, variants: [v({ f: FX('Short Delay FX.aif'), t: 1.0, af: 'lowpass=f=2500' })] },
  { id: 'cast_void', mono: true, variants: [v({ f: FX('Control FX.wav'), t: 0.9, rate: 0.8 }, { f: FX('Abyss FX.wav'), t: 0.9, db: -6 })] },
  { id: 'impact_void', mono: true, variants: [v({ f: FX('Robot Scream FX.aif'), ss: 0.4, t: 0.9, rate: 0.5, af: 'lowpass=f=3000' }, { f: FX('Hit FX.wav'), t: 0.8, db: -4 })] },
  { id: 'domain', variants: [v({ f: FX('Long Tail FX.wav'), t: 3.0 }, { f: FX('Deep FX.aif'), t: 3.0, db: -4 })], fade: 0.8 },
  { id: 'spell_refused', variants: [v({ f: IH(5), t: 0.25, af: 'lowpass=f=1500' }, { f: IH(2), t: 0.06, db: -6 })] },

  // ---- Hurt, death, healing
  { id: 'player_hurt', mono: true, variants: range(2, (i) => v(kick(i + 2, { af: 'lowpass=f=400' }), snare(i + 1, { db: -6 }), { f: IH(4), t: 0.09, db: -8 })) },
  { id: 'player_downed', variants: [v({ f: EC(2), t: 1.5 }, { f: FX('Hit FX.wav'), t: 1.2, db: -2, af: 'lowpass=f=1500' })] },
  { id: 'respawn', variants: [v({ f: FX('Soft Riser FX.aif'), t: 2.2, af: 'highpass=f=300' }, ding({ delay: 2000, db: -2 }))] },
  { id: 'enemy_die', mono: true, variants: [v({ f: FX('Hit FX.wav'), t: 0.8, rate: 0.8, af: 'lowpass=f=2000' }, { f: OS(4), t: 0.4, db: -8 }), v({ f: FX('Hit FX.wav'), t: 0.7, rate: 0.95, af: 'lowpass=f=2000' }, { f: OS(4), ss: 0.4, t: 0.4, db: -8 })] },
  { id: 'heal', variants: [v({ f: HP(8), t: 1.3, af: 'highpass=f=500' }, ding({ rate: 1.5, db: -6 }))] },
  { id: 'shield', variants: [v({ f: FX('Metallic FX.wav'), t: 0.8, rate: 0.6, af: 'lowpass=f=3000' }, { f: FX('Abyss FX.wav'), t: 0.8, db: -8 })] },
  { id: 'drink', mono: true, variants: [v({ f: FX('Water FX.wav'), ss: 1.2, t: 0.5, rate: 1.3, af: 'lowpass=f=2000' })] },

  // ---- Enemies and demons
  { id: 'telegraph', mono: true, variants: [v({ f: IH(11), t: 0.55 }, { f: DANGER, t: 0.5, db: -12 })] },
  { id: 'enemy_shot', mono: true, variants: [v({ f: JL(10), t: 0.4, rate: 0.7, af: 'lowpass=f=3000' })] },
  { id: 'beast_growl', mono: true, variants: [v({ f: FX('Robot Scream FX.aif'), t: 1.0, rate: 0.45, af: 'lowpass=f=1200' }), v({ f: DANGER, t: 0.6, rate: 0.5, af: 'lowpass=f=1500' })] },
  {
    id: 'demon_growl',
    mono: true,
    variants: [
      v({ f: PV(3), ss: 0.38, t: 0.47, rate: 0.55, af: 'areverse,lowpass=f=2000,aecho=0.8:0.6:60:0.4' }),
      v({ f: FX('Robot Scream FX.aif'), t: 1.2, rate: 0.4, af: 'lowpass=f=1800' }, { f: DANGER, t: 0.6, rate: 0.45, db: -4 }),
      v({ f: PV(5), ss: 0.1, t: 0.4, rate: 0.5, af: 'areverse,lowpass=f=1800,aecho=0.8:0.6:70:0.4' }),
    ],
  },
  { id: 'demons_rise', mono: true, variants: [v({ f: FX('Long Tail FX.wav'), t: 2.5, rate: 0.7, af: 'lowpass=f=2500' }, { f: FX('Deep FX.aif'), t: 2.5, db: -4 }, { f: FX('Hit FX.wav'), t: 1.5, db: -2 })], fade: 0.6 },
  { id: 'demon_shrug', mono: true, variants: [v({ f: STEEL, t: 0.7, rate: 0.7, af: 'lowpass=f=3000' })] },
  { id: 'demon_burn', mono: true, variants: [v({ f: CARVE_FX, t: 1.2, af: 'lowpass=f=5000' }, { f: EB1, t: 1.2, db: -6, af: 'highpass=f=3000' }), v({ f: CARVE_FX, ss: 0.4, t: 1.0, rate: 0.9, af: 'lowpass=f=5000' }, { f: EB1, ss: 1, t: 1.0, db: -6, af: 'highpass=f=3000' })] },
  { id: 'lord_risen', variants: [v({ f: FX('Eerie FX.aif'), t: 4.0, rate: 0.75 }, { f: FX('Robot Scream FX.aif'), t: 3.0, rate: 0.35, db: -6, af: 'lowpass=f=1500' }, { f: FX('Long Tail FX.wav'), t: 3.0, db: -4 })], fade: 1.2 },
  { id: 'boss_engaged', variants: [v({ f: FX('Long Tail FX.wav'), t: 3.0 }, { f: FX('Hit FX.wav'), t: 2.0, af: 'lowpass=f=2000' }, { f: DANGER, t: 0.6, rate: 0.6, db: -6 })], fade: 0.8 },
  { id: 'boss_phase', mono: true, variants: [v({ f: FX('Robot Scream FX.aif'), t: 1.6, rate: 0.55, af: 'lowpass=f=2500' }, { f: FX('Hit FX.wav'), t: 1.2 })], fade: 0.4 },
  { id: 'boss_defeated', variants: [v({ f: RPG('level up sound 3'), rate: 0.9 }, { f: FX('Cymbal Hit FX.wav'), t: 2.5, db: -6 })] },

  // ---- Mining
  { id: 'mine_stone', mono: true, variants: range(3, (i) => v({ f: LANTERN, t: 0.15, rate: 0.9 + i * 0.1 }, snare(i, { t: 0.12, db: -4, af: 'highpass=f=1500' }), { f: FX('Metallic FX.wav'), t: 0.12, db: -10 })) },
  { id: 'mine_gem', mono: true, variants: range(2, (i) => v({ f: FX('Metallic FX.wav'), t: 0.5, rate: 1.4 + i * 0.15 }, ding({ rate: 2, db: -4 }))) },
  { id: 'vein_break', mono: true, variants: [v({ f: OS(4), t: 1.4, af: 'lowpass=f=4000' }, { f: JL(4), t: 1.0, db: -6 })] },

  // ---- Loot
  { id: 'loot_common', variants: [v(ding({ t: 0.35, rate: 1.5 }))] },
  { id: 'loot_uncommon', variants: [v(ding({ t: 0.35, rate: 1.5 }), ding({ t: 0.4, rate: 2, delay: 90 }))] },
  { id: 'loot_rare', variants: [v(shimmer({ t: 0.8, rate: 1.2 }), ding({ rate: 1.5, db: -4 }))] },
  { id: 'loot_epic', variants: [v({ f: HP(11), t: 1.0 }, shimmer({ db: -2 }))] },
  { id: 'loot_mythic', variants: [v({ f: FX('Ripple Riser FX.wav'), ss: 4.0, t: 1.5 }, shimmer({ delay: 1400 }), { f: FX('Cymbal Hit FX.wav'), t: 1.5, delay: 1400, db: -8 })] },
  { id: 'loot_bitchin', variants: [v({ f: FX('Ripple Riser FX.wav'), ss: 3.5, t: 2.0 }, { f: RPG('level up sound 3'), delay: 1950 }, { f: FX('Cymbal Hit FX.wav'), t: 2.5, delay: 1950, db: -6 }, { f: HP(11), t: 1.0, delay: 2600, db: -6 }, { f: FX('Glitch FX.wav'), ss: 0.2, t: 0.6, delay: 1950, db: -12 })] },
  { id: 'coins', variants: range(2, (i) => v(ding({ t: 0.25, rate: 2.2 + i * 0.3 }), ding({ t: 0.25, rate: 2.6 + i * 0.3, delay: 60, db: -3 }), ding({ t: 0.25, rate: 2.4, delay: 130, db: -6 }))) },
  { id: 'chest_open', mono: true, variants: [v(creak(0.5), kick(2, { delay: 450, af: 'lowpass=f=300' }), ding({ delay: 520, db: -8 }))] },
  { id: 'item_drop', variants: [v({ f: IH(5), t: 0.3, af: 'lowpass=f=2000' }, kick(3, { db: -6 }))] },

  // ---- Crafting and towns
  { id: 'forge_hammer', mono: true, variants: range(3, (i) => v({ f: FX('Metallic FX.wav'), t: 0.6, rate: 0.9 + i * 0.1 }, kick(i, { af: 'lowpass=f=300' }), snare(i, { db: -8, af: 'highpass=f=1000' }))) },
  { id: 'smelt', mono: true, variants: [v({ f: CARVE_SFX, t: 0.8, rate: 0.6, af: 'lowpass=f=2500' }, { f: EB1, t: 1.5, db: -6, af: 'highpass=f=2000' })], fade: 0.5 },
  { id: 'craft_done', variants: [v(ding(), shimmer({ db: -6 }))] },
  { id: 'station_open', mono: true, variants: [v(creak(0.4, { db: -3 }), kick(1, { af: 'lowpass=f=300', db: -4 }))] },
  { id: 'npc_talk', variants: range(3, (i) => v({ f: IH(2 + i), t: 0.09, rate: 0.7, af: 'bandpass=f=1200:w=1' })) },
  { id: 'door_open', mono: true, variants: [v(creak(1.0), kick(3, { db: -10, af: 'lowpass=f=200' })), v(creak(0.8, { rate: 1.1 }), kick(1, { db: -10, af: 'lowpass=f=200' }))] },
  { id: 'door_close', mono: true, variants: [v(kick(2, { t: 0.25, af: 'lowpass=f=300' }), ghost(0, { db: -4, af: 'lowpass=f=1500' }), { f: EC(3), t: 0.4, db: -6, af: 'lowpass=f=600' })] },
  { id: 'rest', variants: [v({ f: FX('Chimes FX.wav'), t: 3.0 })], fade: 1.0 },

  // ---- Night, fire, chemistry, wards
  { id: 'dusk', variants: [v({ f: FX('Eerie FX.aif'), t: 3.5, rate: 0.85, af: 'lowpass=f=4000' })], fade: 1.2 },
  { id: 'dawn', variants: [v({ f: FX('Airy FX.wav'), t: 3.5 }, shimmer({ delay: 1000, db: -4 }))], fade: 1.2 },
  { id: 'ignite', mono: true, variants: range(2, (i) => v({ f: CARVE_SFX, t: 0.7, rate: 0.9 + i * 0.15 }, { f: EB1, t: 0.5, db: -6, af: 'lowpass=f=3000' })) },
  { id: 'extinguish', mono: true, variants: [v({ f: EB1, t: 1.0, af: 'highpass=f=2500' })], fade: 0.5 },
  { id: 'freeze', mono: true, variants: [v({ f: EC(5), t: 1.0, af: 'highpass=f=2000' }, { f: FX('Metallic FX.wav'), t: 0.5, rate: 1.6, db: -8 })] },
  { id: 'pillar', mono: true, variants: [v({ f: JL(4), t: 1.8 }, { f: OS(4), t: 1.4, af: 'lowpass=f=2500' })] },
  { id: 'ward_falter', variants: [v({ f: FX('Decay Riser FX_Gm.wav'), t: 3.0 }, { f: IH(8), t: 2.0, db: -8, af: 'lowpass=f=3000' })], fade: 0.6 },
  { id: 'ward_hit', mono: true, variants: [v({ f: FX('Short Delay FX.aif'), t: 0.8, af: 'lowpass=f=3000' }, { f: FX('Metallic FX.wav'), t: 0.4, rate: 0.5, db: -8 })] },
  { id: 'wave_horn', variants: [v({ synth: HORN, t: 2.4, af: 'lowpass=f=700,lowpass=f=900,afade=t=in:d=0.3,aecho=0.8:0.5:180:0.3' }, { f: MH(9), t: 1.5, db: -6 })], fade: 0.8 },
  { id: 'defense_held', variants: [v({ f: RPG('level up sound 3') }, { f: FX('Cymbal Hit FX.wav'), t: 2.0, db: -6 })] },
  { id: 'defense_broken', variants: [v({ f: EC(2), t: 1.5, rate: 0.7 }, { f: FX('Long Tail FX.wav'), t: 2.5, rate: 0.6 }, { f: DANGER, t: 0.6, rate: 0.5, db: -4 })], fade: 0.8 },

  // ---- Exploration and progression
  { id: 'discovery', variants: [v({ f: FX('Textured Riser FX.aif'), ss: 3.5, t: 2.1 }, shimmer({ delay: 2000 }), ding({ delay: 2000, db: -6 }))] },
  { id: 'tower_riser', variants: [v({ f: FX('Shade Riser FX.aif'), t: 3.0 })], fade: 0.3 },
  { id: 'tower_attune', variants: [v({ f: FX('Ripple Riser FX.wav'), ss: 2.5, t: 3.0 }, { f: FX('Tower FX.wav'), t: 3.5, delay: 2900 }, { f: RPG('level up sound 2'), delay: 2900 })], fade: 1.0 },
  { id: 'waypoint', variants: [v({ f: WF, t: 1.6 }, ding({ db: -4 }))], fade: 0.5 },
  { id: 'level_up_small', variants: [v({ f: RPG('level up sound 1') })] },
  { id: 'level_up', variants: [v({ f: RPG('level up sound 2') })] },
  { id: 'level_up_big', variants: [v({ f: RPG('level up sound 3') })] },
  { id: 'skill_up', variants: [v({ f: HP(11), t: 1.0 })] },
  { id: 'camp_cleared', variants: [v({ f: FX('Cymbal Hit FX.wav'), t: 1.5, af: 'lowpass=f=6000' }, shimmer())] },
];

const SW_LOOP = (n) => SWV('Drums', `Drum Loop_Bbm_134bpm_${n}.aif`);
const SW_BASS = (n) => SWV('Bass', `Bass Loop_Bbm_134bpm_${n}.aif`);
const SW_MEL = (n) => SWV('Melodic', `Melodic Loop_Bbm_134bpm_${n}.aif`);

/**
 * Music. `lufs` = integrated loudness target (gain only, no limiter on the
 * loops so their lengths and phase stay exact); `gainDb` overrides it with
 * a fixed gain shared by a set of parts (time crunch).
 */
export const MUSIC = [
  { id: 'future_land_1', src: RPG('future land 1'), lufs: -16 },
  { id: 'future_land_2', src: RPG('future land 2'), lufs: -16 },
  // The night theme export is silent (see README); the nocturne cut of
  // future land 2 (its quiet middle, down two semitones, darker, roomier)
  // plays at night until it is re-exported.
  { id: 'night', src: RPG('future land 2'), ss: 100, t: 58, af: 'asetrate=44100*0.8909,aresample=44100,lowpass=f=2200,aecho=0.8:0.7:140|260:0.35|0.25', fadeIn: 3, fadeOut: 4, lufs: -18 },
  { id: 'void_realm', src: RPG('void realm'), lufs: -17 },
  { id: 'time_crunch_intro', src: RPG('time crunch intro'), gainDb: 3.5, exact: true },
  { id: 'time_crunch_loop', src: RPG('time crunch loop'), gainDb: 3.5, exact: true },
  { id: 'time_crunch_final', src: RPG('time crunch 5 sec left'), gainDb: 3.5, exact: true },
  // Combat: 16 bars of the Analog Synthwave pack (134 bpm, Bb minor):
  // drums + bass under two different melodic loops, gapless.
  {
    id: 'combat',
    mix: [
      [{ f: SW_LOOP(1), db: -2 }, { f: SW_BASS(5), db: -4 }, { f: SW_MEL(16), db: -6 }],
      [{ f: SW_LOOP(1), db: -2 }, { f: SW_BASS(5), db: -4 }, { f: SW_MEL(4), db: -6 }],
    ],
    lufs: -17,
    exact: true,
  },
];

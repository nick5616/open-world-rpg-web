// The client's step-synchronous combat timeline (WP13, spec 8 "quick and
// snappy"). It runs inside the 60 Hz movement steps (LocalSim calls it
// before each step) and decides WHEN an attack, cast, dodge or drink starts;
// the zone re-derives WHICH move it is from the same frames with the same
// rules (server/zone/internal/combat/player.go) and refuses starts that come
// faster than the move allows. Keep the two in step.
//
// Feel rules implemented here (constants.yaml combat group):
//  - attacks start on the first step after the press when idle (startup is
//    the move's own, <= LIGHT_STARTUP_MAX_MS);
//  - presses during a move are buffered INPUT_BUFFER_MS and fire on the
//    first legal step, so they are never lost;
//  - a dodge is available whenever the previous dash/i-frames are over, and
//    a dodge after an attack's hit frames cancels its recovery;
//  - consumables (R) take effect CONSUMABLE_USE_MS later, movement unaffected.

import { COMBAT, INPUT_BUFFER_MS, InputFlag, MOVE_STEP_HZ, type MoveDef, type SpellDef, type WeaponDef, type FormDef } from '@lodestone/contracts';
import type { MoveState } from '../sim/movement';
import { dashStep, startDashHold, type DashHold } from './dashes';
import { castSlotOf } from './hotbar';

/** CR 027: riding the spirit steed (sim/ride.ts MOUNTED, SelfState flags bit 3). */
function riding(s: MoveState): boolean {
  return (s.flags & 8) !== 0;
}

/** Weapons with no use from the saddle (the zone's mountedFrame strips the same). */
export function meleeKey(key: string): boolean {
  return key === 'sword' || key === 'spear';
}

export const BUFFER_STEPS = Math.round((INPUT_BUFFER_MS * MOVE_STEP_HZ) / 1000);
export const COMBO_WINDOW_STEPS = 24;
export const PLUNGE_MIN_HEIGHT = 3;
export const SPRINT_ATTACK_SPEED = 8 * 0.75;
export const FORM_SLOT = 4;
/** A form's first hit frame after its start step (CR 022: others draw its burst then too). */
export const FORM_STARTUP_STEPS = 2;
export const TECHNIQUE_SLOT = 5;

const moveByKey = new Map(COMBAT.moves.map((m) => [m.key, m]));
const spellByKey = new Map(COMBAT.spells.map((s) => [s.key, s]));
export const weaponByKey = new Map(COMBAT.weapons.map((w) => [w.key, w]));
export const weaponById = new Map(COMBAT.weapons.map((w) => [w.id, w]));
export const spellById = new Map(COMBAT.spells.map((s) => [s.id, s]));
export const moveById = new Map(COMBAT.moves.map((m) => [m.id, m]));
export const formByElement = new Map(COMBAT.forms.map((f) => [f.element, f]));

export function moveOf(w: WeaponDef, kind: string, combo = 0): MoveDef | undefined {
  for (const k of w.moves) {
    const m = moveByKey.get(k)!;
    if (m.kind === kind && m.combo === combo) return m;
  }
  return undefined;
}

export function comboLength(w: WeaponDef): number {
  return Math.max(1, w.moves.filter((k) => moveByKey.get(k)!.kind === 'light').length);
}

/**
 * CR 033: a weapon that looses only drawn shots (the bow): its charged move
 * has a minimum draw, and the PRIMARY button draws it (player.go refuses
 * its light move and a shorter draw).
 */
export function drawWeapon(w: WeaponDef): MoveDef | undefined {
  const m = moveOf(w, 'charged');
  return m && (m.minChargeSteps ?? 0) > 0 ? m : undefined;
}

/** The draw fraction (0..1) after `held` steps of a charged move (timeline, view model, avatars). */
export function drawFraction(m: MoveDef | undefined, held: number): number {
  return Math.min(1, Math.max(0, held / Math.max(1, m?.chargeSteps ?? 60)));
}

/** A projectile move's launch speed at draw fraction c (server: combat.ShotSpeed). */
export function shotSpeed(m: MoveDef, c: number): number {
  return m.chargeSpeed && c > 0 ? m.speed + (m.chargeSpeed - m.speed) * c : m.speed;
}

/** CR 033: how far it reaches at draw fraction c: full reach at full draw, less the slower it flies (server: combat.ShotRange). */
export function shotRange(m: MoveDef, c: number): number {
  return m.chargeSpeed && m.chargeSpeed > m.speed && m.speed > 0 ? (m.reach * shotSpeed(m, c)) / m.chargeSpeed : m.reach;
}

/** Presses latched by the input layer since the last step (edges), plus held state. */
export interface CombatButtons {
  attackDown: boolean;
  altDown: boolean;
  attackPress: number; // count of presses since last consume
  altPress: number;
  altRelease: number;
  dodgePress: number;
  castPress: (number | null)[]; // slot presses (0..7, CR 039: the slots the level opened)
  /** CR 020: the slot's key (or RMB with the slot selected) is held down now (streams, charges, sustained dashes). */
  castHeld: boolean[];
  formPress: number;
  techniquePress: number;
  drinkPress: number;
}

export interface Loadout {
  weapon: string;
  spells: (string | null)[];
  gem: number; // element of the socketed gem, -1 none
}

/** A started action (for FX, hit detection and the probe). */
export interface Started {
  kind: 'move' | 'spell' | 'form';
  id: number;
  seq: number;
  move?: MoveDef;
  spell?: SpellDef;
  form?: FormDef;
  charge: number;
  fallHeight: number;
  /** Steps from start to the first hit frame and the number of hit frames. */
  startup: number;
  active: number;
  recovery: number;
  /** Real time (performance.now) of the press that caused it (probe). */
  pressedAt: number;
  /** CR 020: a stream's shot index (its seq is the shot's nominal seq, what claims name). */
  shot?: number;
  /** CR 020: the cast that starts a stream (its shots come as separate Starteds). */
  stream?: boolean;
  /** CR 020: the stream's start seq (seed of its jitter / rain pattern). */
  streamStart?: number;
}

/** CR 020: a running stream or gathering charge (mirrors server/zone/internal/combat/stream.go). */
export interface Channel {
  slot: number;
  spell: SpellDef;
  start: number;
  /** Stream: nominal seq of the next shot. */
  next: number;
  shots: number;
  charge: boolean;
}

export interface StepOut {
  flags: number;
  castSlot: number;
  started: Started | null;
  /** CR 020: stream shots fired this step (each its own Started: seq = nominal shot seq). */
  shots: Started[];
  /** CR 020: a charge began gathering this step / a stream or charge ended this step. */
  chargeStart: SpellDef | null;
  channelEnd: Channel | null;
  /** The press was refused locally (cooldown, mana): HUD flash. */
  refused: { id: number; reason: 'cooldown' | 'mana' | 'locked' } | null;
  /** CR 033: the secondary lowered a bow's draw this step (nothing was shot). */
  drawCancelled?: boolean;
}

interface Buffered {
  kind: 'attack' | 'cast' | 'dodge' | 'form' | 'technique' | 'heavy' | 'charged';
  slot: number;
  until: number;
  pressedAt: number;
}

/** Skill levels and level-gated techniques the zone reported (combat_sync). */
export interface SkillView {
  level(skill: string): number;
  has(skill: string, technique: string): boolean;
}

/** Playtest 2 dev console (CR 032): the zone refills mana and clears cooldowns every tick; the prediction does too. */
export const devCombat = { infiniteMana: false, noCooldowns: false };

export class CombatTimeline {
  loadout: Loadout = { weapon: 'sword', spells: ['ember_flick', 'frost_bite', 'magma_dash', null], gem: -1 };
  mana = 100;
  manaMax = 100;
  manaRegenPerStep = 11 / 60;
  skills: SkillView = { level: () => 1, has: () => false };
  downed = false;

  private nextSeq = 0;
  private activeEnd = 0;
  private lastLight: { seq: number; move: MoveDef; combo: number; weapon: string } | null = null;
  private dodgeSeq = 0;
  private altHeld = 0;
  private altPrev = false;
  /** CR 033: a bow draw is under way (the primary went down; a tap keeps it until the minimum draw). */
  private bowArmed = false;
  /** CR 033: the secondary lowered the draw; the primary must come up before the next one. */
  private bowBlocked = false;
  private airTop = 0;
  private wasAir = false;
  private readyAt = new Map<number, number>();
  private buf: Buffered[] = [];
  private pendingDash = 0; // wind form: dash variant on the next step
  /** CR 020: the running stream or gathering charge. */
  channel: Channel | null = null;
  /** CR 021: the mobility dash this timeline started and whether its key still holds it (dashes.ts). */
  dashHold: DashHold | null = null;
  /** Last step's seq (probe/tests). */
  seq = 0;

  weapon(): WeaponDef {
    return weaponByKey.get(this.loadout.weapon) ?? weaponByKey.get('sword')!;
  }

  /** Steps the draw / charge has been held (the alt_attack bit: bow draw, spear charge): the view model reads it. */
  get heldSteps(): number {
    return this.altHeld;
  }

  /** CR 033: the bow's draw 0..1 (0 when not drawing): the view model and the crosshair read it. */
  get drawFrac(): number {
    const m = drawWeapon(this.weapon());
    return m && this.altHeld > 0 ? drawFraction(m, this.altHeld) : 0;
  }

  /** Whether an attack may start at seq (after the last move, or after its hit frames when a dodge cancelled the recovery). */
  private canStart(seq: number): boolean {
    const cancel = this.dodgeSeq >= this.activeEnd && this.activeEnd > 0 && this.dodgeSeq <= seq;
    return seq >= this.nextSeq || (cancel && seq >= this.activeEnd);
  }

  /** Steps until a spell id is ready (0 = ready), for the HUD. */
  cooldownLeft(id: number): number {
    return Math.max(0, (this.readyAt.get(id) ?? 0) - this.seq);
  }

  cooldownSteps(base: number): number {
    let m = this.weapon().cooldownMult;
    if (this.skills.has('spellcraft', 'quick_cast')) m *= 0.9;
    return Math.round(base * m);
  }

  /** CR 020: fire the running stream's next shot if it is due and paid for (stream.go streamShot). */
  private streamShot(seq: number, out: StepOut, now: number): void {
    const c = this.channel;
    if (!c || c.charge || seq < c.next) return;
    const s = c.spell;
    const a = s.auto!;
    if (this.mana < a.manaPerShot) {
      this.endChannel(seq, out);
      return;
    }
    this.mana -= a.manaPerShot;
    out.shots.push({ kind: 'spell', id: s.id, seq: c.next, spell: s, charge: 0, fallHeight: 0, startup: 0, active: 1, recovery: 0, pressedAt: now, shot: c.shots, streamStart: c.start });
    c.next += a.intervalSteps;
    c.shots++;
  }

  /** CR 020: end the stream or charge at seq (a stream: ready one interval after its last shot or cooldownMs from now). */
  endChannel(seq: number, out: StepOut | null): void {
    const c = this.channel;
    if (!c) return;
    this.channel = null;
    if (out) out.channelEnd = c;
    if (c.charge) return;
    let ready = seq + this.cooldownSteps(c.spell.cooldownSteps);
    if (c.shots > 0) ready = Math.max(ready, c.start + c.spell.windupSteps + (c.shots - 1) * c.spell.auto!.intervalSteps + c.spell.auto!.intervalSteps);
    this.readyAt.set(c.spell.id, ready);
  }

  /** The server refused a start: forget its cooldown (the zone didn't charge it). */
  refund(id: number): void {
    this.readyAt.delete(id);
  }

  private queue(b: Omit<Buffered, 'until'>): void {
    this.buf.push({ ...b, until: this.seq + BUFFER_STEPS });
  }

  /**
   * One step. `before` is the movement state this step starts from, `ground`
   * its ground height there. Returns the flags/castSlot to OR into the step's
   * InputFrame and what started.
   */
  step(seq: number, b: CombatButtons, before: MoveState, groundY: number, now: number): StepOut {
    this.seq = seq;
    this.mana = devCombat.infiniteMana ? this.manaMax : Math.min(this.manaMax, this.mana + this.manaRegenPerStep);
    if (devCombat.noCooldowns) this.readyAt.clear();
    const out: StepOut = { flags: 0, castSlot: 0, started: null, refused: null, shots: [], chargeStart: null, channelEnd: null };
    const w = this.weapon();
    if (this.downed) {
      this.buf = [];
      this.bowArmed = false;
      if (this.channel) this.endChannel(seq, out);
      return out;
    }
    // CR 020: a stream key still held after its stream ended (mana, a dodge)
    // starts it again as soon as it is ready and paid for.
    const held = b.castHeld ?? [];
    if (!this.channel)
      held.forEach((h, slot) => {
        const k = this.loadout.spells[slot];
        const s = h && k ? spellByKey.get(k) : undefined;
        if (s?.auto && b.castPress[slot] == null && seq >= (this.readyAt.get(s.id) ?? 0) && this.mana >= s.mana && !this.buf.some((x) => x.kind === 'cast' && x.slot === slot)) b.castPress[slot] = now;
      });
    const prior = this.channel;
    if (prior?.charge && !held[prior.slot]) {
      // Release: the charge fires on this step, which carries nothing else
      // (an attack, dodge or cast here would cancel it on the zone).
      this.channel = null;
      out.channelEnd = prior;
      const f = Math.min(1, Math.max(0, (seq - prior.start) / Math.max(1, prior.spell.charge!.maxSteps)));
      const s = prior.spell;
      out.started = { kind: 'spell', id: s.id, seq, spell: s, charge: f, fallHeight: 0, startup: Math.max(1, s.windupSteps), active: 1, recovery: 0, pressedAt: now };
    }
    // Latch presses into the buffer (they fire now or within BUFFER_STEPS).
    const staffy = w.key === 'staff' || w.key === 'wand';
    const bowMove = drawWeapon(w); // CR 033: the primary draws instead of attacking
    if (!bowMove) for (let i = 0; i < b.attackPress; i++) this.queue({ kind: 'attack', slot: 0, pressedAt: now });
    for (let i = 0; i < b.dodgePress; i++) this.queue({ kind: 'dodge', slot: 0, pressedAt: now });
    b.castPress.forEach((p, slot) => p !== null && this.queue({ kind: 'cast', slot, pressedAt: p }));
    for (let i = 0; i < b.formPress; i++) this.queue({ kind: 'form', slot: FORM_SLOT, pressedAt: now });
    for (let i = 0; i < b.techniquePress; i++) this.queue({ kind: 'technique', slot: TECHNIQUE_SLOT, pressedAt: now });
    if (b.altPress > 0 && staffy) this.queue({ kind: 'heavy', slot: 0, pressedAt: now });
    const charged = moveOf(w, 'charged');
    if (b.altRelease > 0 && charged && !bowMove && this.altHeld > 0) this.queue({ kind: 'charged', slot: 0, pressedAt: now });
    if (b.drinkPress > 0) out.flags |= InputFlag.interact;

    // alt_attack is held while the secondary button is held (spear charge,
    // sword parry). Staff/wand use the press as a heavy attack instead.
    // CR 027: in the saddle a sword or spear neither parries nor charges (the zone strips it too).
    let alt = b.altDown && !staffy && !bowMove && !(riding(before) && meleeKey(w.key));
    // CR 033: a bow draws while the PRIMARY is held (the same alt_attack bit
    // on the wire, so the zone counts the same draw) and looses when it comes
    // up. A tap keeps drawing to the minimum draw first; the draw starts only
    // once the last shot has recovered (no shot is ever lost to the recovery);
    // the secondary (Z, or the right button with the weapon picked) lowers it.
    let loose = false;
    if (bowMove) {
      if (b.altPress > 0 && this.bowArmed) {
        this.bowArmed = false;
        this.bowBlocked = true;
        out.drawCancelled = this.altHeld > 0;
      }
      if (!b.attackDown && b.attackPress === 0) this.bowBlocked = false;
      if ((b.attackDown || b.attackPress > 0) && !this.bowBlocked) this.bowArmed = true;
      if (this.bowArmed && this.canStart(seq)) {
        // out.started: a spell charge released on this step (that step carries nothing else): one more step of draw
        if (!b.attackDown && this.altHeld >= (bowMove.minChargeSteps ?? 1) && out.started === null) loose = true;
        else alt = true;
      }
    }
    const air = before.mode === 1 || before.mode === 3; // air, glide
    if (air) {
      if (!this.wasAir) this.airTop = before.pos.y;
      this.airTop = Math.max(this.airTop, before.pos.y);
    }
    this.wasAir = air;

    this.buf = this.buf.filter((x) => x.until >= seq);
    if (this.pendingDash && !out.channelEnd) {
      out.flags |= InputFlag.dodge;
      out.castSlot = this.pendingDash;
      this.pendingDash = 0;
    }
    if (loose) {
      // CR 033: the release, before anything buffered (the draw it carries is this.altHeld).
      this.bowArmed = false;
      this.tryMove({ kind: 'charged', slot: 0, until: seq, pressedAt: now }, out, w, before, groundY, air, false, seq);
    }
    // One action per step: dodge first (the escape), then casts, then attacks.
    for (let i = 0; i < this.buf.length && out.started === null && (out.flags & (InputFlag.dodge | InputFlag.cast | InputFlag.attack)) === 0; i++) {
      const x = this.buf[i];
      const fired = this.tryFire(x, out, w, before, groundY, air, alt, seq);
      if (fired === 'done' || fired === 'refused') {
        this.buf.splice(i, 1);
        i--;
      }
    }
    // CR 020: the stream / charge that ran before this step (stream.go's channelFrame).
    if (prior && this.channel === prior) {
      if ((out.flags & (InputFlag.dodge | InputFlag.cast | InputFlag.attack)) !== 0 || !held[prior.slot]) this.endChannel(seq, out);
      else {
        out.flags |= InputFlag.channel;
        if (!prior.charge) this.streamShot(seq, out, now);
      }
    }
    dashStep(this, b, before, out, seq); // CR 021: name the running dash, hold it while the key is down (dashes.ts)
    if (alt) out.flags |= InputFlag.alt_attack;
    if (staffy && (out.flags & InputFlag.attack) !== 0 && out.started?.move?.kind === 'heavy') out.flags |= InputFlag.alt_attack;
    this.altHeld = alt ? this.altHeld + 1 : 0;
    this.altPrev = alt;
    void this.altPrev;
    return out;
  }

  private tryFire(x: Buffered, out: StepOut, w: WeaponDef, before: MoveState, groundY: number, air: boolean, alt: boolean, seq: number): 'done' | 'wait' | 'refused' {
    switch (x.kind) {
      case 'dodge': {
        if (riding(before)) return 'refused'; // CR 027: no dodging from the saddle
        if ((before.dash ?? 0) > 1 || (before.iframes ?? 0) > 1) return 'wait';
        if (before.mode === 2 || before.mode === 4) return 'wait'; // climbing, swimming
        out.flags |= InputFlag.dodge;
        out.castSlot = 0;
        this.dodgeSeq = seq;
        return 'done';
      }
      case 'cast': {
        const key = this.loadout.spells[x.slot];
        const s = key ? spellByKey.get(key) : undefined;
        if (!s || s.type === 'passive') return 'refused';
        // CR 020: casting the spell that is streaming ends that stream first (the zone does the same).
        if (this.channel && this.channel.spell.id === s.id) this.endChannel(seq, out);
        // CR 020 x CR 021: a stream or charge waits for a running dash to end (its channel bit would hold the dash).
        if ((s.auto || s.charge) && (before.dash ?? 0) > 0) return 'wait';
        if (seq < (this.readyAt.get(s.id) ?? 0)) {
          if (x.until === seq) out.refused = { id: s.id, reason: 'cooldown' };
          return 'wait';
        }
        if (this.mana < s.mana) {
          out.refused = { id: s.id, reason: 'mana' };
          return 'refused';
        }
        if (s.type === 'mobility') {
          if (riding(before)) {
            out.refused = { id: s.id, reason: 'locked' }; // CR 027: no dashes from the saddle
            return 'refused';
          }
          if ((before.dash ?? 0) > 0 || (before.iframes ?? 0) > 0 || before.mode === 2 || before.mode === 4) return 'wait';
          out.flags |= InputFlag.dodge;
          out.castSlot = s.dash;
          this.dodgeSeq = seq;
          this.dashHold = startDashHold(x.slot, s.dash, seq); // CR 021: hold the key to sustain it (dashes.ts)
        } else {
          out.flags |= InputFlag.cast;
          out.castSlot = castSlotOf(x.slot); // CR 039: slots 5-8 travel as 6-9
        }
        if (s.auto || s.charge) {
          // CR 020: a stream (shots pay as they fire) or a charge (paid now, fires on release).
          if (this.channel) this.endChannel(seq, out);
          this.channel = { slot: x.slot, spell: s, start: seq, next: seq + s.windupSteps, shots: 0, charge: !!s.charge };
          if (s.charge) {
            this.mana -= s.mana;
            this.readyAt.set(s.id, seq + this.cooldownSteps(s.cooldownSteps));
            out.chargeStart = s;
          } else {
            out.started = { kind: 'spell', id: s.id, seq, spell: s, charge: 0, fallHeight: 0, startup: 0, active: 1, recovery: 0, pressedAt: x.pressedAt, stream: true, streamStart: seq };
            this.streamShot(seq, out, x.pressedAt);
          }
          return 'done';
        }
        this.mana -= s.mana;
        this.readyAt.set(s.id, seq + this.cooldownSteps(s.cooldownSteps));
        out.started = { kind: 'spell', id: s.id, seq, spell: s, charge: 0, fallHeight: 0, startup: Math.max(1, s.windupSteps), active: Math.max(1, s.durationSteps || 1), recovery: 0, pressedAt: x.pressedAt };
        return 'done';
      }
      case 'form': {
        if (riding(before)) return 'refused'; // CR 027
        const f = formByElement.get(this.loadout.gem);
        const tech = w.key === 'spear' ? 'spear_form' : 'sword_form';
        if (!f || (w.key !== 'sword' && w.key !== 'spear') || !this.skills.has(w.skill, tech)) {
          out.refused = { id: f?.id ?? 0, reason: 'locked' };
          return 'refused';
        }
        if (seq < (this.readyAt.get(f.id) ?? 0)) return 'wait';
        this.readyAt.set(f.id, seq + f.cooldownSteps);
        out.flags |= InputFlag.cast;
        out.castSlot = FORM_SLOT;
        if (f.dash) this.pendingDash = f.dash;
        out.started = { kind: 'form', id: f.id, seq, form: f, charge: 0, fallHeight: 0, startup: FORM_STARTUP_STEPS, active: 8, recovery: 10, pressedAt: x.pressedAt };
        return 'done';
      }
      default:
        return this.tryMove(x, out, w, before, groundY, air, alt, seq);
    }
  }

  private tryMove(x: Buffered, out: StepOut, w: WeaponDef, before: MoveState, groundY: number, air: boolean, alt: boolean, seq: number): 'done' | 'wait' | 'refused' {
    let m: MoveDef | undefined;
    let charge = 0;
    let combo = 0;
    const hs = Math.hypot(before.vel.x, before.vel.z);
    if (x.kind === 'technique') {
      m = moveOf(w, 'heavy');
      if (!m || !m.technique || !this.skills.has(w.skill, m.technique)) return 'refused';
    } else if (x.kind === 'heavy') {
      m = moveOf(w, 'heavy');
    } else if (x.kind === 'charged') {
      m = moveOf(w, 'charged');
      if (m) charge = Math.min(1, this.altHeld / Math.max(1, m.chargeSteps ?? 1));
    } else if (air && before.pos.y - groundY >= PLUNGE_MIN_HEIGHT && before.vel.y < 0 && moveOf(w, 'plunge')) {
      m = moveOf(w, 'plunge');
    } else if (air && moveOf(w, 'air')) {
      m = moveOf(w, 'air');
    } else if (!air && x.kind === 'attack' && hs > SPRINT_ATTACK_SPEED && this.sprinting && moveOf(w, 'sprint')) {
      m = moveOf(w, 'sprint');
    } else {
      const l = this.lastLight;
      if (l && l.weapon === w.key && seq <= l.seq + l.move.startupSteps + l.move.activeSteps + l.move.recoverySteps + COMBO_WINDOW_STEPS) combo = (l.combo + 1) % comboLength(w);
      m = moveOf(w, 'light', combo);
    }
    if (!m) return 'refused';
    void alt;
    if (riding(before) && meleeKey(w.key)) return 'refused'; // CR 027: bows, staves and wands work from the saddle; swords and spears don't
    // Legal start: after the previous move, or after its hit frames when a
    // dodge since then cancelled the recovery (spec 8).
    const cancel = this.dodgeSeq >= this.activeEnd && this.activeEnd > 0 && this.dodgeSeq <= seq;
    if (seq < this.nextSeq && !(cancel && seq >= this.activeEnd)) return x.kind === 'charged' ? 'refused' : 'wait'; // a release that can't fire now is lost (the zone derives charged from the release step)
    if (m.cooldownSteps && seq < (this.readyAt.get(m.id) ?? 0)) return 'refused';
    if (m.cooldownSteps) this.readyAt.set(m.id, seq + m.cooldownSteps);
    out.flags |= x.kind === 'technique' ? InputFlag.cast : InputFlag.attack;
    if (x.kind === 'technique') out.castSlot = TECHNIQUE_SLOT;
    this.activeEnd = seq + m.startupSteps + m.activeSteps;
    this.nextSeq = this.activeEnd + m.recoverySteps;
    if (m.kind === 'light') this.lastLight = { seq, move: m, combo, weapon: w.key };
    out.started = { kind: 'move', id: m.id, seq, move: m, charge, fallHeight: m.kind === 'plunge' ? Math.max(0, this.airTop - groundY) : 0, startup: m.startupSteps, active: m.activeSteps, recovery: m.recoverySteps, pressedAt: x.pressedAt };
    return 'done';
  }

  /** Set by the input layer: the sprint key is held this step. */
  sprinting = false;
}

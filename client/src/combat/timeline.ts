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

export const BUFFER_STEPS = Math.round((INPUT_BUFFER_MS * MOVE_STEP_HZ) / 1000);
export const COMBO_WINDOW_STEPS = 24;
export const PLUNGE_MIN_HEIGHT = 3;
export const SPRINT_ATTACK_SPEED = 8 * 0.75;
export const FORM_SLOT = 4;
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

/** Presses latched by the input layer since the last step (edges), plus held state. */
export interface CombatButtons {
  attackDown: boolean;
  altDown: boolean;
  attackPress: number; // count of presses since last consume
  altPress: number;
  altRelease: number;
  dodgePress: number;
  castPress: (number | null)[]; // slot presses (0..3)
  formPress: number;
  techniquePress: number;
  drinkPress: number;
  /** Held state of the four spell slots (key 1-4, or RMB with the slot selected): CR 020 auto spells, CR 021 held dashes. */
  castHeld: boolean[];
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
}

export interface StepOut {
  flags: number;
  castSlot: number;
  started: Started | null;
  /** The press was refused locally (cooldown, mana): HUD flash. */
  refused: { id: number; reason: 'cooldown' | 'mana' | 'locked' } | null;
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
  private airTop = 0;
  private wasAir = false;
  private readyAt = new Map<number, number>();
  private buf: Buffered[] = [];
  private pendingDash = 0; // wind form: dash variant on the next step
  /** CR 021: the mobility dash this timeline started and whether its key still holds it (dashes.ts). */
  dashHold: DashHold | null = null;
  /** Last step's seq (probe/tests). */
  seq = 0;

  weapon(): WeaponDef {
    return weaponByKey.get(this.loadout.weapon) ?? weaponByKey.get('sword')!;
  }

  /** Steps the secondary button has been held (bow draw, spear charge): the view model reads it. */
  get heldSteps(): number {
    return this.altHeld;
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
    this.mana = Math.min(this.manaMax, this.mana + this.manaRegenPerStep);
    const out: StepOut = { flags: 0, castSlot: 0, started: null, refused: null };
    const w = this.weapon();
    if (this.downed) {
      this.buf = [];
      return out;
    }
    // Latch presses into the buffer (they fire now or within BUFFER_STEPS).
    const staffy = w.key === 'staff' || w.key === 'wand';
    for (let i = 0; i < b.attackPress; i++) this.queue({ kind: 'attack', slot: 0, pressedAt: now });
    for (let i = 0; i < b.dodgePress; i++) this.queue({ kind: 'dodge', slot: 0, pressedAt: now });
    b.castPress.forEach((p, slot) => p !== null && this.queue({ kind: 'cast', slot, pressedAt: p }));
    for (let i = 0; i < b.formPress; i++) this.queue({ kind: 'form', slot: FORM_SLOT, pressedAt: now });
    for (let i = 0; i < b.techniquePress; i++) this.queue({ kind: 'technique', slot: TECHNIQUE_SLOT, pressedAt: now });
    if (b.altPress > 0 && staffy) this.queue({ kind: 'heavy', slot: 0, pressedAt: now });
    const charged = moveOf(w, 'charged');
    if (b.altRelease > 0 && charged && this.altHeld > 0) this.queue({ kind: 'charged', slot: 0, pressedAt: now });
    if (b.drinkPress > 0) out.flags |= InputFlag.interact;

    // alt_attack is held while the secondary button is held (bow draw, spear
    // charge, sword parry). Staff/wand use the press as a heavy attack instead.
    const alt = b.altDown && !staffy;
    const air = before.mode === 1 || before.mode === 3; // air, glide
    if (air) {
      if (!this.wasAir) this.airTop = before.pos.y;
      this.airTop = Math.max(this.airTop, before.pos.y);
    }
    this.wasAir = air;

    this.buf = this.buf.filter((x) => x.until >= seq);
    if (this.pendingDash) {
      out.flags |= InputFlag.dodge;
      out.castSlot = this.pendingDash;
      this.pendingDash = 0;
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
        if (seq < (this.readyAt.get(s.id) ?? 0)) {
          if (x.until === seq) out.refused = { id: s.id, reason: 'cooldown' };
          return 'wait';
        }
        if (this.mana < s.mana) {
          out.refused = { id: s.id, reason: 'mana' };
          return 'refused';
        }
        if (s.type === 'mobility') {
          if ((before.dash ?? 0) > 0 || (before.iframes ?? 0) > 0 || before.mode === 2 || before.mode === 4) return 'wait';
          out.flags |= InputFlag.dodge;
          out.castSlot = s.dash;
          this.dodgeSeq = seq;
          this.dashHold = startDashHold(x.slot, s.dash, seq); // CR 021: hold the key to sustain it (dashes.ts)
        } else {
          out.flags |= InputFlag.cast;
          out.castSlot = x.slot;
        }
        this.mana -= s.mana;
        this.readyAt.set(s.id, seq + this.cooldownSteps(s.cooldownSteps));
        out.started = { kind: 'spell', id: s.id, seq, spell: s, charge: 0, fallHeight: 0, startup: Math.max(1, s.windupSteps), active: Math.max(1, s.durationSteps || 1), recovery: 0, pressedAt: x.pressedAt };
        return 'done';
      }
      case 'form': {
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
        out.started = { kind: 'form', id: f.id, seq, form: f, charge: 0, fallHeight: 0, startup: 2, active: 8, recovery: 10, pressedAt: x.pressedAt };
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

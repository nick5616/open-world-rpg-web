// The client side of combat (WP13): input, the step-synchronous timeline,
// predicted hits (melee arcs, local projectiles, area spells) with instant
// feedback (spark, hitstop, number-on-confirm), HitClaims to the zone, and
// the zone's verdicts and Events (contracts/events.md 200-399). One runtime
// per zone session; NetPlay attaches it next to WP12's exploration link.
//
// Prediction never waits for the network (spec 8): the spark and the
// hitstop play the moment the client's own hit test passes; the damage
// number appears when HitResult confirms it (a refused claim just shows no
// number).

import { COMBAT, HITSTOP_MS, InputFlag, MOVE_STEP_HZ, i16ToPitch, u16ToYaw, type Event as ZoneEvent, type HitResult, type MoveDef, type SpellDef } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import type { MoveState } from '../sim/movement';
import type { RemoteView } from '../net/interpolation';
import { drawnRemotes } from '../net/netStore';
import { localPlayer } from '../state/live';
import { CombatTimeline, spellById, weaponById, type CombatButtons, type Started } from './timeline';
import { EV, INTERACT_COMBAT, ACT, ELEMENT_COLORS, decodeSync, decodeTelegraph, enemyInfo } from './events';
import { fxQueue, pushNumber, toast, useCombatHud } from './store';
import { CombatProbe } from './probe';
import { nextSelection, validSelection, WheelStepper } from './spellSelect';
import { emitSound } from '../audio/bridge';
import { isHostilePlayer } from '../ui/pvp/hostile';
// Playtest 2: every spell visual goes through the FX engine (fx/README in ../README.md).
import { spellFx } from './fx/api';

const STEP_MS = 1000 / MOVE_STEP_HZ;
const EYE = 1.6;

/** What the runtime needs from the zone session (ZoneSession implements it). */
export interface CombatLink {
  sendHitClaim(c: { attackSeq: number; attackId: number; targetId: number; tick: number; x: number; y: number; z: number; yaw: number; pitch: number }): void;
  sendInteract(targetKind: number, targetId: bigint, action: number, arg?: number): void;
  latestTick(): number;
  selfId(): number;
}

interface LocalShot {
  started: Started;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  radius: number;
  left: number;
  hit: Set<number>;
  pierce: boolean;
  aoe: number;
  fx: number;
}

interface Active {
  s: Started;
  /** The view (InputFrame) yaw/pitch at the start: melee cones, as the zone validates them. */
  yaw: number;
  pitch: number;
  /** Playtest 2: the converged crosshair aim (= yaw/pitch in first person): shots and aimed areas. */
  aimYaw: number;
  aimPitch: number;
  hit: Set<number>;
  impact: { x: number; y: number; z: number } | null;
  ticks: number; // area ticks claimed so far (lingering spells)
  until: number; // seq the action stops checking
}


export class CombatRuntime {
  readonly timeline = new CombatTimeline();
  readonly probe = new CombatProbe();
  private buttons: CombatButtons = blankButtons();
  private actives: Active[] = [];
  private shots: LocalShot[] = [];
  private pendingClaims = new Map<string, { at: number; x: number; y: number; z: number; kind: 'move' | 'spell' | 'form' }>();
  hitstopUntil = 0;
  /** Playtest 2: the newest action this player started, and a counter (the own third-person avatar animates from it). */
  lastStarted: Started | null = null;
  startedCount = 0;
  private detach: (() => void) | null = null;
  ground: GroundQuery | null = null;
  enabled = true;

  constructor(private link: CombatLink) {}

  /** Our own entity id (0 before Welcome). */
  selfId(): number {
    return this.link.selfId();
  }

  /** Keyboard/mouse listeners (browser only). */
  attachInput(target: Window = window): void {
    const isText = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const now = () => performance.now();
    // Playtest 1: the right button uses the wheel's selection (the weapon's
    // secondary, or a spell slot); Z holds the weapon's secondary always.
    let rmbCast = false;
    const altDown = () => {
      this.buttons.altDown = true;
      this.buttons.altPress++;
      if (this.timeline.weapon().key === 'bow') emitSound('bow_draw');
    };
    const altUp = () => {
      this.buttons.altDown = false;
      this.buttons.altRelease++;
    };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      if (e.button === 0) {
        this.buttons.attackDown = true;
        this.buttons.attackPress++;
        this.probe.press('attack', now());
      } else if (e.button === 2) {
        const sel = useCombatHud.getState().selected;
        if (sel >= 0 && this.timeline.loadout.spells[sel]) {
          rmbCast = true;
          this.buttons.castHeld[sel] = true;
          this.buttons.castPress[sel] = now();
        } else altDown();
      }
      // Middle button: the camera view toggle (hud/ViewHud.tsx), not combat (playtest 2: it did nothing
      // for anyone without a weapon technique; techniques stay on V).
    };
    const onUp = (e: MouseEvent) => {
      if (e.button === 0) this.buttons.attackDown = false;
      if (e.button === 2) {
        if (rmbCast) {
          rmbCast = false;
          this.buttons.castHeld = this.buttons.castHeld.map(() => false);
        }
        else if (this.buttons.altDown) altUp();
      }
    };
    const wheel = new WheelStepper();
    const onWheel = (e: WheelEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName !== 'CANVAS' || el.closest('[data-testid="map-screen"]')) return;
      const dir = wheel.step(e.deltaY, now());
      if (dir) this.cycleSelection(dir);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyZ' && this.buttons.altDown) altUp();
      if (e.code.startsWith('Digit')) {
        const slot = Number(e.code.slice(5)) - 1;
        if (slot >= 0 && slot < 4) this.buttons.castHeld[slot] = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (isText(e.target) || e.repeat) return;
      const t = now();
      switch (e.code) {
        case 'KeyF':
        case 'AltLeft':
          e.preventDefault();
          this.buttons.dodgePress++;
          this.probe.press('dodge', t);
          break;
        case 'Digit1':
        case 'Digit2':
        case 'Digit3':
        case 'Digit4': {
          const slot = Number(e.code.slice(5)) - 1;
          this.buttons.castPress[slot] = t;
          this.buttons.castHeld[slot] = true;
          if (this.timeline.loadout.spells[slot]) useCombatHud.getState().set({ selected: slot });
          break;
        }
        case 'KeyZ':
          altDown();
          break;
        case 'KeyQ':
          this.buttons.formPress++;
          break;
        case 'KeyV':
          this.buttons.techniquePress++;
          break;
        case 'KeyR':
          this.buttons.drinkPress++;
          this.probe.press('drink', t);
          break;
        case 'KeyX':
          this.swapLoadout();
          break;
      }
    };
    const noMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'CANVAS') e.preventDefault();
    };
    const release = () => {
      this.buttons.attackDown = false;
      this.buttons.altDown = false;
      this.buttons.castHeld = [false, false, false, false];
    };
    target.addEventListener('mousedown', onDown);
    target.addEventListener('mouseup', onUp);
    target.addEventListener('keydown', onKey);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('wheel', onWheel, { passive: true });
    target.addEventListener('contextmenu', noMenu);
    target.addEventListener('blur', release);
    this.detach = () => {
      target.removeEventListener('mousedown', onDown);
      target.removeEventListener('mouseup', onUp);
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('contextmenu', noMenu);
      target.removeEventListener('blur', release);
    };
  }

  dispose(): void {
    this.detach?.();
  }

  /** Scripted input (headless runs, tests): the same latches the listeners fill. */
  press(what: 'attack' | 'alt' | 'altRelease' | 'dodge' | 'drink' | 'form' | 'technique' | number): void {
    const t = performance.now();
    if (what === 'attack') {
      this.buttons.attackPress++;
      this.probe.press('attack', t);
    } else if (what === 'alt') {
      this.buttons.altDown = true;
      this.buttons.altPress++;
    } else if (what === 'altRelease') {
      this.buttons.altDown = false;
      this.buttons.altRelease++;
    } else if (what === 'dodge') {
      this.buttons.dodgePress++;
      this.probe.press('dodge', t);
    } else if (what === 'drink') {
      this.buttons.drinkPress++;
      this.probe.press('drink', t);
    } else if (what === 'form') this.buttons.formPress++;
    else if (what === 'technique') this.buttons.techniquePress++;
    else this.buttons.castPress[what] = t;
  }

  /** Wheel: move the right-button selection (weapon, then non-empty spell slots). */
  cycleSelection(dir: 1 | -1): number {
    const hud = useCombatHud.getState();
    const next = nextSelection(validSelection(hud.selected, this.timeline.loadout.spells), this.timeline.loadout.spells, dir);
    hud.set({ selected: next, selectedAt: performance.now() });
    return next;
  }

  /** Scripted: select a slot (-1 weapon) / use the selection as the right button would. */
  select(slot: number): void {
    useCombatHud.getState().set({ selected: validSelection(slot, this.timeline.loadout.spells), selectedAt: performance.now() });
  }

  /** Scripted: hold or let go of a spell slot's key (CR 021 held dashes, CR 020 hold-to-fire). */
  holdCast(slot: number, on: boolean): void {
    this.buttons.castHeld[slot] = on;
  }

  useSelected(): void {
    const sel = useCombatHud.getState().selected;
    if (sel >= 0 && this.timeline.loadout.spells[sel]) this.buttons.castPress[sel] = performance.now();
    else this.press('alt');
  }

  swapLoadout(): void {
    const hud = useCombatHud.getState();
    const next = hud.activeLoadout === 0 ? 1 : 0;
    this.link.sendInteract(INTERACT_COMBAT, 0n, ACT.swapLoadout, next);
    hud.set({ activeLoadout: next });
    this.applyLoadout();
  }

  private applyLoadout(): void {
    const hud = useCombatHud.getState();
    const lo = hud.loadouts[hud.activeLoadout];
    if (lo) this.timeline.loadout = { weapon: lo.weapon, spells: lo.spells, gem: lo.gem };
    const sel = validSelection(hud.selected, this.timeline.loadout.spells);
    if (sel !== hud.selected) hud.set({ selected: sel });
  }

  /**
   * Called by LocalSim before each 60 Hz step: returns the combat bits for
   * this step's InputFrame (attack/alt/dodge/cast/interact + castSlot).
   */
  stepHook(seq: number, before: MoveState, sprinting: boolean): { flags: number; castSlot: number } {
    if (!this.enabled) return { flags: 0, castSlot: 0 };
    const b = this.buttons;
    this.timeline.sprinting = sprinting;
    const gy = this.ground ? this.ground.heightAt(before.pos.x, before.pos.z) : before.pos.y;
    const out = this.timeline.step(seq, b, before, gy, performance.now());
    this.buttons = { ...blankButtons(), attackDown: b.attackDown, altDown: b.altDown, castHeld: b.castHeld };
    if (out.started) this.begin(out.started, before);
    if ((out.flags & InputFlag.dodge) !== 0) this.probe.dodgeStart(seq, performance.now());
    if ((out.flags & InputFlag.interact) !== 0) this.probe.drinkStart(performance.now());
    if (out.refused) {
      useCombatHud.getState().set({ refused: { id: out.refused.id, at: performance.now() } });
      if (out.refused.reason === 'mana') toast('Not enough mana');
    }
    return { flags: out.flags, castSlot: out.castSlot };
  }

  /** After each step: i-frame bookkeeping for the probe and active hit windows. */
  afterStep(seq: number, state: MoveState): void {
    this.probe.afterStep(seq, state, performance.now());
    for (const a of this.actives) this.activeStep(a, seq, state);
    this.actives = this.actives.filter((a) => seq < a.until);
  }

  private begin(s: Started, before: MoveState): void {
    const yaw = localPlayer.yaw;
    const pitch = localPlayer.pitch;
    this.probe.started(s, performance.now());
    this.lastStarted = s;
    this.startedCount++;
    const total = s.startup + s.active + Math.max(0, s.spell?.durationSteps ?? 0);
    this.actives.push({ s, yaw, pitch, aimYaw: localPlayer.aimYaw, aimPitch: localPlayer.aimPitch, hit: new Set(), impact: null, ticks: 0, until: s.seq + total + 1 });
    const color = s.spell?.color ?? (s.form ? '#ffd76a' : '#e8e8e8');
    if (s.move && s.move.speed === 0) fxQueue.push({ t: 'swing', arc: s.move.arc, reach: s.move.reach, color, durationMs: (s.startup + s.active) * STEP_MS, at: performance.now() });
    if (s.spell) {
      // Hand flourish, windup telegraph (where an area will land, the target
      // of a long direct spell), dash trails, shields: spellFx (fx/engine.ts).
      const sp = s.spell;
      const eye = { x: before.pos.x, y: before.pos.y + EYE, z: before.pos.z };
      const aim = sp.windupMs > 0 && (sp.type === 'aoe' || sp.type === 'rune') && !sp.selfCast && !sp.cone && !sp.line ? this.aimPoint(eye, localPlayer.aimYaw, localPlayer.aimPitch, sp.range) : null;
      const target = sp.type === 'direct' && sp.windupMs > 0 ? this.aimTarget(eye, localPlayer.aimYaw, localPlayer.aimPitch, sp.range, 12) : null;
      spellFx.castStart(sp, 'self', aim, yaw, target ? target.id : null);
    }
    // Sound from the prediction, instantly (spec 8); client/src/audio/triggers.ts.
    if (s.spell) emitSound('cast', { element: s.spell.tree, kind: s.spell.type });
    else emitSound('attack', { weapon: this.timeline.weapon().key, kind: s.move?.kind ?? 'heavy' });
    void before;
  }

  /** The enemies the player sees (interpolated, as drawn this frame), and the players they may fight (playtest 2 PvP and duels, ui/pvp). */
  private enemies(): RemoteView[] {
    return drawnRemotes.views.filter((v) => (v.kind === 2 && v.healthPct > 0) || isHostilePlayer(v));
  }

  private activeStep(a: Active, seq: number, st: MoveState): void {
    const s = a.s;
    const firstHit = s.seq + s.startup;
    if (seq < firstHit) return;
    const eye = { x: st.pos.x, y: st.pos.y + EYE, z: st.pos.z };
    if (s.move) {
      const m = s.move;
      if (m.speed > 0) {
        if (seq === firstHit) this.launch(s, m.speed * (m.chargeSpeed && s.charge > 0 ? 1 + (m.chargeSpeed / m.speed - 1) * s.charge : 1), m.gravity, m.radius, m.reach, false, 0, a);
        return;
      }
      if (m.radius > 1) {
        if (seq === firstHit) this.areaAt(a, this.aimPoint(eye, a.aimYaw, a.aimPitch, m.reach), m.radius, s, '#c8c8c8');
        return;
      }
      if (seq >= firstHit + s.active) return;
      for (const e of this.enemies()) {
        if (a.hit.has(e.id)) continue;
        const r = enemyInfo(e).radius;
        const center = m.kind === 'plunge' ? st.pos : st.pos;
        if (inCone(center, a.yaw, m.reach + r + 0.3, m.arc, e)) {
          a.hit.add(e.id);
          this.predictHit(s, e, st.pos, 'move');
        }
      }
      return;
    }
    if (s.form) {
      if (seq !== firstHit) return;
      const f = s.form;
      for (const e of this.enemies()) {
        const r = enemyInfo(e).radius;
        const ok = f.shape === 'aoe' ? Math.hypot(e.x - st.pos.x, e.z - st.pos.z) <= f.radius + r : f.shape === 'cone' ? inCone(st.pos, a.yaw, f.reach + r, f.arc, e) : inLine(st.pos, a.yaw, f.reach, f.width / 2 + r, e);
        if (ok) this.predictHit(s, e, st.pos, 'form');
      }
      spellFx.form(f, 'self', a.yaw);
      return;
    }
    const sp = s.spell!;
    this.spellStep(a, sp, seq, firstHit, st, eye);
  }

  private spellStep(a: Active, sp: SpellDef, seq: number, firstHit: number, st: MoveState, eye: { x: number; y: number; z: number }): void {
    const s = a.s;
    const color = sp.color ?? '#ffffff';
    switch (sp.type) {
      case 'projectile':
      case 'arc':
        if (seq === firstHit) {
          const n = Math.max(1, sp.spread);
          for (let i = 0; i < n; i++) {
            const off = n > 1 ? ((i - (n - 1) / 2) * sp.spreadDeg * Math.PI) / 180 : 0;
            this.launch(s, sp.speed, sp.gravity, Math.max(0.2, Math.min(sp.radius, 1)), sp.range, sp.pierce, sp.radius > 1 ? sp.radius : 0, a, off, color, n > 1);
          }
        }
        return;
      case 'hitscan':
      case 'beam': {
        const ticks = sp.type === 'beam' ? Math.max(1, sp.hits) : 1;
        const every = sp.type === 'beam' ? Math.max(1, Math.floor(Math.max(1, sp.durationSteps) / ticks)) : 1;
        if (seq < firstHit || (seq - firstHit) % every !== 0 || a.ticks >= ticks) return;
        a.ticks++;
        const t = this.aimTarget(eye, localPlayer.aimYaw, localPlayer.aimPitch, sp.range, 6);
        const end = t ? { x: t.x, y: t.y + 0.9, z: t.z } : this.aimPoint(eye, localPlayer.aimYaw, localPlayer.aimPitch, sp.range);
        // One beam per cast (same id every tick: it stays up and re-aims).
        spellFx.beam(`l${s.seq}`, sp, 'self', end, sp.type === 'beam' ? every * STEP_MS + 60 : 160);
        if (!t) return;
        this.predictHit(s, t, st.pos, 'spell', sp.type === 'beam');
        if (sp.chain > 0) {
          let prev = t;
          const used = new Set([t.id]);
          for (let k = 0; k < sp.chain; k++) {
            let best: RemoteView | null = null;
            for (const e of this.enemies()) if (!used.has(e.id) && Math.hypot(e.x - prev.x, e.z - prev.z) < 8 && (!best || Math.hypot(e.x - prev.x, e.z - prev.z) < Math.hypot(best.x - prev.x, best.z - prev.z))) best = e;
            if (!best) break;
            used.add(best.id);
            spellFx.chain(sp, { x: prev.x, y: prev.y + enemyInfo(prev).height, z: prev.z }, { x: best.x, y: best.y + enemyInfo(best).height, z: best.z });
            this.predictHit(s, best, prev, 'spell');
            prev = best;
          }
        }
        return;
      }
      case 'direct': {
        if (seq !== firstHit) return;
        const t = this.aimTarget(eye, a.aimYaw, a.aimPitch, sp.range, 12);
        if (t) {
          spellFx.targetHit(sp, t.x, t.y, t.z, enemyInfo(t).height * 2);
          this.predictHit(s, t, st.pos, 'spell');
        }
        return;
      }
      case 'aoe':
      case 'domain':
      case 'rune': {
        const lingering = sp.type === 'rune' || sp.durationSteps > 0;
        if (seq === firstHit) {
          a.impact = sp.selfCast || sp.type === 'domain' || sp.cone > 0 || sp.line > 0 ? { ...st.pos } : this.aimPoint(eye, a.aimYaw, a.aimPitch, sp.range);
          const p = a.impact;
          if (sp.type === 'rune') spellFx.rune(sp, p.x, p.y, p.z);
          else spellFx.area(sp, p.x, p.y, p.z, { radius: sp.radius, cone: sp.cone, line: sp.line, yaw: a.yaw }, lingering ? sp.durationSteps * STEP_MS : 0, sp.selfCast || sp.type === 'domain' ? 'self' : null);
        }
        if (!a.impact) return;
        const ticks = Math.max(1, sp.hits);
        const every = lingering ? Math.max(1, Math.floor(Math.max(1, sp.durationSteps) / ticks)) : 1;
        if (sp.type !== 'rune' && ((seq - firstHit) % every !== 0 || a.ticks >= ticks)) return;
        if (sp.type !== 'rune' && !lingering && seq !== firstHit) return;
        a.ticks++;
        const center = sp.selfCast || sp.type === 'domain' ? st.pos : a.impact;
        for (const e of this.enemies()) {
          const r = enemyInfo(e).radius;
          let inside: boolean;
          if (sp.cone > 0) inside = inCone(st.pos, a.yaw, sp.radius + r, sp.cone, e);
          else if (sp.line > 0) inside = inLine(st.pos, a.yaw, sp.line, sp.radius + r, e);
          else inside = Math.hypot(e.x - center.x, e.z - center.z) <= sp.radius + r && Math.abs(e.y - center.y) < 4;
          if (!inside) continue;
          if (sp.type === 'rune') {
            if (a.hit.has(e.id)) continue;
            a.hit.add(e.id);
          }
          this.predictHit(s, e, center, 'spell', true);
        }
        return;
      }
    }
  }

  /** The aim point on the terrain along the look ray (or at range). */
  private aimPoint(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, range: number): { x: number; y: number; z: number } {
    const cp = Math.cos(pitch);
    const dx = -Math.sin(yaw) * cp;
    const dz = -Math.cos(yaw) * cp;
    const dy = Math.sin(pitch);
    for (let d = 1; d <= range; d += 0.5) {
      const x = eye.x + dx * d;
      const y = eye.y + dy * d;
      const z = eye.z + dz * d;
      const g = this.ground ? this.ground.heightAt(x, z) : 0;
      if (y <= g) return { x, y: g, z };
    }
    const x = eye.x + dx * range;
    const z = eye.z + dz * range;
    return { x, y: this.ground ? this.ground.heightAt(x, z) : eye.y + dy * range, z };
  }

  /** The enemy nearest the crosshair within range and `deg` degrees. */
  private aimTarget(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, range: number, deg: number): RemoteView | null {
    const cp = Math.cos(pitch);
    const f = { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
    let best: RemoteView | null = null;
    let bestA = (deg * Math.PI) / 180;
    for (const e of this.enemies()) {
      const v = { x: e.x - eye.x, y: e.y + 0.9 - eye.y, z: e.z - eye.z };
      const d = Math.hypot(v.x, v.y, v.z);
      if (d > range + 1 || d < 0.1) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (v.x * f.x + v.y * f.y + v.z * f.z) / d))) - Math.atan2(enemyInfo(e).radius, d);
      if (ang < bestA) {
        bestA = ang;
        best = e;
      }
    }
    return best;
  }

  private launch(s: Started, speed: number, gravity: number, radius: number, range: number, pierce: boolean, aoe: number, a: Active, yawOff = 0, color = '#e8d8a0', spread = false): void {
    const eye = { x: localPlayer.pos.x, y: localPlayer.pos.y + EYE - 0.15, z: localPlayer.pos.z };
    // Playtest 2: the converged aim (third person: toward what the crosshair is on).
    const yaw = localPlayer.aimYaw + yawOff;
    const pitch = localPlayer.aimPitch + (gravity > 0 ? 0.05 : 0);
    const cp = Math.cos(pitch);
    const sh: LocalShot = { started: s, x: eye.x, y: eye.y, z: eye.z, vx: -Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * cp * speed, gravity, radius, left: range, hit: new Set(), pierce, aoe, fx: 0 };
    this.shots.push(sh);
    void a;
    void color;
    // The visual starts at your off hand and is ended by update() below (hit, ground, range).
    sh.fx = spellFx.projectile(s.spell ?? null, sh.x, sh.y, sh.z, sh.vx, sh.vy, sh.vz, gravity, Math.max(0.12, radius), range / Math.max(1, speed), { local: true, explode: aoe, pierce, spread, kind: 'arrow' });
  }

  /** Per rendered frame: local projectiles and hitstop. */
  update(dtMs: number): void {
    const dt = Math.min(dtMs, 50) / 1000;
    const keep: LocalShot[] = [];
    for (const sh of this.shots) {
      let alive = true;
      const n = 3;
      for (let k = 0; k < n && alive; k++) {
        const h = dt / n;
        sh.vy -= sh.gravity * h;
        sh.x += sh.vx * h;
        sh.y += sh.vy * h;
        sh.z += sh.vz * h;
        sh.left -= Math.hypot(sh.vx, sh.vy, sh.vz) * h;
        const g = this.ground ? this.ground.heightAt(sh.x, sh.z) : -1e9;
        if (sh.left <= 0 || sh.y < g) {
          if (sh.aoe > 0) this.explode(sh);
          spellFx.projectileEnd(sh.fx, sh.x, Math.max(sh.y, g + 0.05), sh.z, sh.y < g ? 'ground' : 'expire', sh.aoe);
          alive = false;
          break;
        }
        for (const e of this.enemies()) {
          if (sh.hit.has(e.id)) continue;
          const r = enemyInfo(e).radius + sh.radius + 0.25;
          const cy = e.y + enemyInfo(e).height;
          if (Math.hypot(e.x - sh.x, e.z - sh.z) <= r && Math.abs(cy - sh.y) <= enemyInfo(e).height + sh.radius + 0.4) {
            sh.hit.add(e.id);
            if (sh.aoe > 0) {
              this.explode(sh);
              spellFx.projectileEnd(sh.fx, sh.x, sh.y, sh.z, 'hit', sh.aoe);
              alive = false;
              break;
            }
            this.predictHit(sh.started, e, localPlayer.pos, sh.started.kind);
            if (!sh.pierce) {
              spellFx.projectileEnd(sh.fx, sh.x, sh.y, sh.z, 'hit');
              alive = false;
              break;
            }
            spellFx.projectileHit(sh.fx, sh.x, sh.y, sh.z);
          }
        }
      }
      if (alive) keep.push(sh);
    }
    this.shots = keep;
  }

  private explode(sh: LocalShot): void {
    // The explosion visual is the projectile's end (spellFx.projectileEnd with the radius).
    emitSound('impact', { at: { x: sh.x, y: sh.y, z: sh.z }, element: sh.started.spell?.tree ?? 'earth' });
    for (const e of this.enemies()) {
      if (Math.hypot(e.x - sh.x, e.z - sh.z) <= sh.aoe + enemyInfo(e).radius) this.predictHit(sh.started, e, { x: sh.x, y: sh.y, z: sh.z }, sh.started.kind, true);
    }
  }

  private areaAt(a: Active, p: { x: number; y: number; z: number }, radius: number, s: Started, color: string): void {
    spellFx.slam(p.x, p.y, p.z, radius);
    void color;
    for (const e of this.enemies()) if (Math.hypot(e.x - p.x, e.z - p.z) <= radius + enemyInfo(e).radius) this.predictHit(s, e, p, 'move', true);
    void a;
  }

  /**
   * A predicted hit: spark + hitstop now (spec 8: feedback from the client's
   * prediction), the claim to the zone, the number when it confirms.
   */
  private predictHit(s: Started, e: RemoteView, origin: { x: number; y: number; z: number }, kind: 'move' | 'spell' | 'form', impactIsOrigin = false): void {
    const now = performance.now();
    const at = { x: e.x, y: e.y + enemyInfo(e).height, z: e.z };
    fxQueue.push({ t: 'spark', x: at.x, y: at.y, z: at.z, color: s.spell?.color ?? '#fff3c0', at: now });
    const gem = this.timeline.loadout.gem;
    spellFx.hit(s.spell ?? null, at.x, at.y, at.z, { tint: !s.spell && gem >= 0 ? ELEMENT_COLORS[gem] : null, heavy: kind === 'form' || s.move?.kind === 'heavy' });
    if (!impactIsOrigin) emitSound('impact', { at, element: s.spell?.tree, weapon: this.timeline.weapon().key });
    if (kind === 'move' || kind === 'form') this.hitstopUntil = Math.max(this.hitstopUntil, now + HITSTOP_MS);
    this.probe.localHit(s, now, kind === 'move' || kind === 'form' ? HITSTOP_MS : 0);
    const claimAt = impactIsOrigin ? origin : localPlayer.pos;
    const yaw = Math.round((((localPlayer.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 65536) & 0xffff;
    this.link.sendHitClaim({ attackSeq: s.seq, attackId: s.id, targetId: e.id, tick: this.link.latestTick(), x: Math.round(claimAt.x * 100), y: Math.round(claimAt.y * 100), z: Math.round(claimAt.z * 100), yaw, pitch: 0 });
    this.pendingClaims.set(`${s.seq}:${e.id}`, { at: now, ...at, kind });
  }

  /** HitResult: show the number for confirmed hits (refused: nothing). */
  onHitResult(r: HitResult): void {
    const key = `${r.attackSeq}:${r.targetId}`;
    const p = this.pendingClaims.get(key);
    this.pendingClaims.delete(key);
    this.probe.confirmed(r.accepted, p?.at ?? 0, performance.now());
    if (!p || !r.accepted) return;
    const kind = r.flags & 1 ? 'crit' : r.flags & 4 ? 'weak' : r.flags & 8 ? 'resist' : 'dealt';
    pushNumber(p.x, p.y + 0.4, p.z, r.damage, kind);
  }

  /** Combat Events from the zone. */
  onEvent(ev: ZoneEvent): void {
    const hud = useCombatHud.getState();
    const self = this.link.selfId();
    const now = performance.now();
    switch (ev.kind) {
      case EV.combatSync: {
        const s = decodeSync(ev.data);
        if (!s) return;
        hud.set({ active: true, activeLoadout: s.active, loadouts: s.loadouts, known: s.known, skillXp: s.skillXp, manaMax: s.manaMax, charges: s.charges, skillPoints: s.skillPoints, level: s.level });
        this.timeline.manaMax = s.manaMax;
        this.timeline.skills = {
          level: (k) => levelFor(s.skillXp[k] ?? 0),
          has: (k, t) => {
            const sk = COMBAT.skills.list.find((x) => x.key === k);
            const tq = sk?.techniques.find((x) => x.key === t);
            return !!tq && levelFor(s.skillXp[k] ?? 0) >= tq.level;
          },
        };
        this.applyLoadout();
        return;
      }
      case EV.mana:
        this.timeline.mana = ev.value / 10;
        this.timeline.manaMax = ev.targetId / 10;
        hud.set({ mana: ev.value / 10, manaMax: ev.targetId / 10 });
        return;
      case EV.telegraph: {
        const t = decodeTelegraph(ev);
        if (t) fxQueue.push({ t: 'telegraph', ...t, at: now });
        this.probe.telegraph(ev.value, now);
        return;
      }
      case EV.projectile: {
        const d = new DataView(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
        if (ev.data.length < 10) return;
        const vx = d.getInt16(0, true) / 50;
        const vy = d.getInt16(2, true) / 50;
        const vz = d.getInt16(4, true) / 50;
        const range = d.getUint16(8, true) / 100;
        const sp = Math.max(1, Math.hypot(vx, vy, vz));
        void sp;
        spellFx.enemyProjectile(ev.entityId, Number(ev.targetId), ev.x / 100, ev.y / 100, ev.z / 100, vx, vy, vz, d.getUint16(6, true) / 100, range);
        return;
      }
      case EV.cast: {
        // Another player's attack, cast, form or dash (contracts/events.md 214).
        if (ev.data.length < 4) return;
        const d = new DataView(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
        spellFx.remoteCast(ev.entityId, Number(ev.targetId), ev.x / 100, ev.y / 100, ev.z / 100, u16ToYaw(d.getUint16(0, true)), i16ToPitch(d.getInt16(2, true)));
        return;
      }
      case EV.status:
        spellFx.status(Number(ev.targetId), ev.value);
        return;
      case EV.shield:
        if (ev.entityId === self || ev.entityId === 0) spellFx.shieldPoints(ev.value);
        return;
      case EV.damage:
        pushNumber(ev.x / 100, ev.y / 100 + 0.4, ev.z / 100, ev.value, 'dealt');
        fxQueue.push({ t: 'spark', x: ev.x / 100, y: ev.y / 100, z: ev.z / 100, color: '#fff3c0', at: now });
        spellFx.hit(null, ev.x / 100, ev.y / 100, ev.z / 100);
        return;
      case EV.playerHurt:
        if (ev.entityId === self) {
          pushNumber(localPlayer.pos.x, localPlayer.pos.y + 2.1, localPlayer.pos.z, ev.value, 'taken');
          this.probe.strike(now, false);
        }
        return;
      case EV.evaded:
        if (ev.entityId === self) {
          toast(ev.value === 2 ? 'Parried!' : 'Dodged!');
          this.probe.strike(now, true);
        }
        return;
      case EV.heal:
        if (ev.targetId === self) pushNumber(localPlayer.pos.x, localPlayer.pos.y + 2.1, localPlayer.pos.z, ev.value, 'heal');
        return;
      case EV.consumable:
        if (ev.targetId === 0 && ev.data.length > 0) {
          this.probe.drinkDone(now);
          pushNumber(localPlayer.pos.x, localPlayer.pos.y + 2.1, localPlayer.pos.z, ev.data[0], 'heal');
        }
        hud.set({ charges: ev.value });
        return;
      case EV.playerDowned:
        if (ev.entityId === self) {
          this.timeline.downed = true;
          hud.set({ downedUntil: now + ev.value });
        }
        return;
      case EV.respawned:
        this.timeline.downed = false;
        hud.set({ downedUntil: 0 });
        return;
      case EV.bossEngaged:
        hud.set({ boss: { id: ev.entityId, name: new TextDecoder().decode(ev.data), phase: 1, phases: COMBAT.bosses.length ? 3 : 1, pct: 100 } });
        return;
      case EV.bossPhase: {
        const name = new TextDecoder().decode(ev.data.subarray(2));
        hud.set({ boss: { id: ev.entityId, name, phase: ev.targetId + 1, phases: ev.value, pct: hud.boss?.pct ?? 100 } });
        toast(`${name}: phase ${ev.targetId + 1}`);
        return;
      }
      case EV.bossDefeated:
        toast(`${new TextDecoder().decode(ev.data)} defeated (${ev.value} s)`);
        hud.set({ boss: null });
        return;
      case EV.bossReset:
        hud.set({ boss: null });
        return;
      case EV.refused: {
        const sp = spellById.get(ev.targetId);
        if (sp) this.timeline.refund(sp.id);
        hud.set({ refused: { id: ev.targetId, at: now } });
        return;
      }
      case EV.skillUp: {
        const sk = COMBAT.skills.list.find((x) => x.id === ev.targetId);
        const tech = new TextDecoder().decode(ev.data);
        toast(`${sk?.key ?? 'skill'} ${ev.value}${tech ? ` — learned ${COMBAT.names[tech] ?? tech}` : ''}`);
        return;
      }
      case EV.campCleared:
        toast('Camp cleared');
        return;
    }
  }

  /** Keep the boss bar's health from the snapshot (called by the 3D layer). */
  noteBossHealth(views: RemoteView[]): void {
    const hud = useCombatHud.getState();
    if (!hud.boss) return;
    const v = views.find((x) => x.id === hud.boss!.id);
    if (v && v.healthPct !== hud.boss.pct) hud.set({ boss: { ...hud.boss, pct: v.healthPct } });
  }

  weaponName(): string {
    return this.timeline.weapon().key;
  }
}

function blankButtons(): CombatButtons {
  return { attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], formPress: 0, techniquePress: 0, drinkPress: 0, castHeld: [false, false, false, false] };
}

export function levelFor(xp: number): number {
  let lv = 1;
  while (lv < 100 && xp >= Math.round(COMBAT.skills.xpBase * Math.pow(lv, COMBAT.skills.xpExp))) lv++;
  return lv;
}

function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

function angleDiff(a: number, b: number): number {
  const d = ((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return Math.abs(d);
}

export function inCone(o: { x: number; z: number }, yaw: number, reach: number, arcDeg: number, e: { x: number; z: number }): boolean {
  const dx = e.x - o.x;
  const dz = e.z - o.z;
  const d = Math.hypot(dx, dz);
  if (d > reach) return false;
  if (arcDeg >= 360 || d < 0.8) return true;
  return angleDiff(yawTo(dx, dz), yaw) <= (arcDeg / 2) * (Math.PI / 180) + 0.15;
}

function inLine(o: { x: number; z: number }, yaw: number, length: number, halfWidth: number, e: { x: number; z: number }): boolean {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const dx = e.x - o.x;
  const dz = e.z - o.z;
  const along = dx * fx + dz * fz;
  return along >= -1 && along <= length + 1 && Math.abs(dx * fz - dz * fx) <= halfWidth;
}

void weaponById;
export type { MoveDef };

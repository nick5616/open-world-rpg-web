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

import { COMBAT, HITSTOP_MS, InputFlag, MOVE_STEP_HZ, type Event as ZoneEvent, type HitResult, type MoveDef, type SpellDef } from '@lodestone/contracts';
import type { GroundQuery } from '../sim/ground';
import type { MoveState } from '../sim/movement';
import type { RemoteView } from '../net/interpolation';
import { drawnRemotes } from '../net/netStore';
import { localPlayer } from '../state/live';
import { CombatTimeline, shotRange, shotSpeed, spellById, weaponById, type CombatButtons, type Started } from './timeline';
import { EV, INTERACT_COMBAT, ACT, ELEMENT_COLORS, decodeSync, decodeTelegraph, enemyInfo } from './events';
import { fxQueue, pushNumber, toast, useCombatHud } from './store';
import { GRACE_MS, killerName, respawnSiteName } from './downed';
import { CombatProbe } from './probe';
import { nextSelection, validSelection, WheelStepper } from './spellSelect';
import { emitSound } from '../audio/bridge';
import { isHostilePlayer } from '../ui/pvp/hostile';
// Playtest 2: every spell visual goes through the FX engine (fx/README in ../README.md).
import { spellFx } from './fx/api';
// Playtest 2 weather (CR 030): the wind pushes arrows.
import { arrowWindAt } from '../systems/weather/runtime';
// CR 020: the shared spell simulation (the zone's twin re-flies homing shots and judges stream shots the same way).
import { canAcquire, chargeMult, homingParams, homingStep, launchShot, orbOffset, rainOffset, shotJitter, SIM_DT, streamSeed, type HomingParams, type HomingShot } from './spellsim';
// CR 022: your caster record (the state your visuals and everyone else's are drawn from) and the shared aim.
import { castState, remoteEvent, CAST_FX_DASH, CAST_FX_GUARD } from './castState';
import { aimPoint as sharedAimPoint, aimTarget as sharedAimTarget } from './aim';
import { dashLive } from './dashes';
import { castHooks, gemFor } from './fx/castOrigin';
import type { WeaponKind } from './weapons/look';
import { uiPanelUp } from '../input/interact';
import { isCaptureClick } from '../input/useMouseLook';
import { heldBlocked, onHeldRelease } from '../input/held';
import { isChatShortcut } from '../input/useKeyboard';

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
  /** CR 020: a seeking shot (stepped at 60 Hz by the shared homing step). */
  homing: { p: HomingParams; s: HomingShot; lock: number; acc: number } | null;
  /** CR 030: the wind's pull on an arrow (m/s^2, x and z); null when calm. */
  wind?: [number, number] | null;
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
  /** CR 020: an orbit's last touch (step) per target. */
  lastHit: Map<number, number> | null;
  hitCount?: Map<number, number>;
}


export class CombatRuntime {
  readonly timeline = new CombatTimeline();
  readonly probe = new CombatProbe();
  private buttons: CombatButtons = blankButtons();
  private actives: Active[] = [];
  private shots: LocalShot[] = [];
  private pendingClaims = new Map<string, { at: number; x: number; y: number; z: number; kind: 'move' | 'spell' | 'form'; element: number }>();
  hitstopUntil = 0;
  /** CR 020: the stream this player is firing (HUD, avatar pose). */
  streaming: { spell: SpellDef; start: number } | null = null;
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
    let rmbSlot = 0; // CR 020: the slot RMB holds (streams, charges)
    const altDown = () => {
      this.buttons.altDown = true;
      this.buttons.altPress++;
    };
    const altUp = () => {
      this.buttons.altDown = false;
      this.buttons.altRelease++;
    };
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
      // Playtest 2 polish: the click that captures the mouse (input/useMouseLook.ts) neither swings nor casts,
      // and nothing is drawn, streamed or charged under the Esc menu or a panel (input/held.ts).
      if (isCaptureClick() || heldBlocked()) return;
      if (e.button === 0) {
        this.buttons.attackDown = true;
        this.buttons.attackPress++;
        this.probe.press('attack', now());
      } else if (e.button === 2) {
        const sel = useCombatHud.getState().selected;
        if (sel >= 0 && this.timeline.loadout.spells[sel]) {
          rmbCast = true;
          rmbSlot = sel;
          this.buttons.castHeld[sel] = true;
          this.buttons.castPress[sel] = now();
        } else altDown();
      }
      // Middle button: the camera view toggle (hud/ViewHud.tsx), not combat (playtest 2: it did nothing
      // for anyone without a weapon technique; techniques are on Tab).
    };
    const onUp = (e: MouseEvent) => {
      if (e.button === 0) this.buttons.attackDown = false;
      if (e.button === 2) {
        if (rmbCast) {
          rmbCast = false;
          this.buttons.castHeld[rmbSlot] = false;
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
      if (/^Digit[1-4]$/.test(e.code)) this.buttons.castHeld[Number(e.code.slice(5)) - 1] = false; // CR 020
    };
    const onKey = (e: KeyboardEvent) => {
      if (isText(e.target) || isChatShortcut(e) || e.repeat) return; // "/" is chat's (Shift+7, Hebrew Q: input/useKeyboard.ts)
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
          if (this.timeline.loadout.spells[slot]) useCombatHud.getState().set({ selected: slot });
          if (heldBlocked()) break; // under the Esc menu or a panel 1-4 only pick the right button's slot
          this.buttons.castPress[slot] = t;
          this.buttons.castHeld[slot] = true; // CR 020: streams and charges run while held
          break;
        }
        case 'KeyZ':
          if (!heldBlocked()) altDown();
          break;
        case 'KeyQ':
          this.buttons.formPress++;
          break;
        // Playtest 2 integration QA: the weapon technique moved from V to Tab. V is push-to-talk
        // (voice/runtime.ts) and every push to talk also fired the technique.
        case 'Tab':
          // With a panel open Tab moves the focus (spell cards, buttons); in the world it is the technique.
          if (uiPanelUp()) break;
          e.preventDefault(); // no focus jump to a HUD button
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
      // CR 033: losing the window lowers a bow's draw instead of loosing it (the secondary's cancel)
      if (this.buttons.attackDown && this.timeline.weapon().key === 'bow') this.buttons.altPress++;
      this.buttons.attackDown = false;
      this.buttons.altDown = false;
      this.buttons.castHeld = [false, false, false, false];
      rmbCast = false;
    };
    target.addEventListener('mousedown', onDown);
    target.addEventListener('mouseup', onUp);
    target.addEventListener('keydown', onKey);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('wheel', onWheel, { passive: true });
    target.addEventListener('contextmenu', noMenu);
    target.addEventListener('blur', release);
    const offHeld = onHeldRelease(release); // the mouse capture lost, the Esc menu opened, the page hidden
    this.detach = () => {
      offHeld();
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

  /** CR 033, scripted: hold (or let go of) the primary button, as the left mouse button does (a bow draws while held). */
  holdAttack(on: boolean): void {
    if (on && !this.buttons.attackDown) {
      this.buttons.attackPress++;
      this.probe.press('attack', performance.now());
    }
    this.buttons.attackDown = on;
  }

  /** CR 020, scripted: hold (or let go of) a spell slot's key (streams, charges). A hold also presses it. */
  hold(slot: number, on: boolean): void {
    if (on && !this.buttons.castHeld[slot]) this.buttons.castPress[slot] = performance.now();
    this.buttons.castHeld[slot] = on;
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
    castHooks.selfGem = this.timeline.loadout.gem; // CR 022: your swings' tint (others read it from your weapon look)
    castHooks.selfWeapon = this.timeline.loadout.weapon as WeaponKind;
    const sel = validSelection(hud.selected, this.timeline.loadout.spells);
    if (sel !== hud.selected) hud.set({ selected: sel });
  }

  /**
   * Called by LocalSim before each 60 Hz step: returns the combat bits for
   * this step's InputFrame (attack/alt/dodge/cast/interact + castSlot).
   */
  stepHook(seq: number, before: MoveState, sprinting: boolean): { flags: number; castSlot: number; aim?: { yaw: number; pitch: number } | null } {
    if (!this.enabled) return { flags: 0, castSlot: 0 };
    const b = this.buttons;
    this.timeline.sprinting = sprinting;
    const gy = this.ground ? this.ground.heightAt(before.pos.x, before.pos.z) : before.pos.y;
    const now = performance.now();
    const heldBefore = castState.peek('self')?.held ?? null; // a charge released on this step still aimed it
    const out = this.timeline.step(seq, b, before, gy, now);
    this.buttons = { ...blankButtons(), attackDown: b.attackDown, altDown: b.altDown, castHeld: b.castHeld };
    // CR 022: your caster record, from the same step bits the zone replays (it sends others the same):
    // a dash start (dodge + variant: Event 214 | 0x8000), the held dash's thrust (the casting bit),
    // the guard (the secondary on a sword, spear or bow: 214 0x4001 and the casting bit).
    if ((out.flags & InputFlag.dodge) !== 0 && out.castSlot) castState.action('self', CAST_FX_DASH | out.castSlot, now);
    castState.dashHolding('self', dashLive.variant, dashLive.held, now);
    const wk = this.timeline.weapon().key;
    if (wk !== 'staff' && wk !== 'wand') {
      if (this.timeline.heldSteps === 1) {
        castState.action('self', CAST_FX_GUARD, now);
        if (wk === 'bow') emitSound('bow_draw'); // CR 033: the draw starts on the step the primary arms it
      }
      else if (this.timeline.heldSteps === 0) castState.release('self', 'guard');
    }
    // CR 020: a stream or charge that ended, a charge that began, the stream's shots this step.
    if (out.channelEnd) {
      spellFx.channelEnd('self', out.channelEnd.spell);
      castState.release('self', out.channelEnd.charge ? 'charge' : 'stream');
      this.streaming = null;
    }
    if (out.chargeStart) {
      castState.hold('self', 'charge', out.chargeStart.id, seq, now);
      spellFx.chargeStart(out.chargeStart, 'self');
      emitSound('cast', { element: out.chargeStart.tree, kind: 'charge' });
    }
    if (out.started) this.begin(out.started, before);
    for (const s of out.shots) this.fireShot(s, before);
    if ((out.flags & InputFlag.dodge) !== 0) this.probe.dodgeStart(seq, performance.now());
    if ((out.flags & InputFlag.interact) !== 0) this.probe.drinkStart(performance.now());
    if (out.refused) {
      useCombatHud.getState().set({ refused: { id: out.refused.id, at: performance.now() } });
      if (out.refused.reason === 'mana') toast('Not enough mana');
    }
    // CR 022: on a step that aims something (a spell cast, a shot or area move, a released charge)
    // and while a stream, charge or beam is held, the frame carries the aim the spell really flies
    // along (third person: the crosshair's convergence, up to a few degrees off the camera look),
    // so the zone validates it and every other player draws it along that exact aim (Events 214,
    // 223, 226). Melee cones and dashes keep the camera look (what their prediction uses).
    const h = castState.peek('self')?.held ?? heldBefore;
    const st = out.started;
    const aiming = (h && h.kind !== 'guard') || (st && (st.spell ? st.spell.type !== 'mobility' : !!st.move && (st.move.speed > 0 || st.move.radius > 1)));
    const aim = aiming && (localPlayer.aimYaw !== localPlayer.yaw || localPlayer.aimPitch !== localPlayer.pitch) ? { yaw: localPlayer.aimYaw, pitch: localPlayer.aimPitch } : null;
    return { flags: out.flags, castSlot: out.castSlot, aim };
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
    const now = performance.now();
    if (s.stream && s.spell) {
      // CR 020: a hold-to-fire stream: its shots arrive one by one (fireShot).
      this.streaming = { spell: s.spell, start: s.seq };
      castState.hold('self', 'stream', s.spell.id, s.seq, now); // CR 022 (others: Event 223)
      spellFx.streamStart(s.spell, 'self', streamSeed(s.seq, s.spell.id));
      emitSound('cast', { element: s.spell.tree, kind: s.spell.type });
      return;
    }
    // CR 022: the action on your caster record (others get it as Event 214; a mobility
    // spell's is its dash variant, noted in stepHook like the zone does).
    if (s.spell?.type !== 'mobility') castState.action('self', s.id, now, s.charge);
    const total = s.startup + s.active + Math.max(0, s.spell?.durationSteps ?? 0);
    this.actives.push({ s, yaw, pitch, aimYaw: localPlayer.aimYaw, aimPitch: localPlayer.aimPitch, hit: new Set(), impact: null, ticks: 0, until: s.seq + total + 1, lastHit: null });
    const color = s.spell?.color ?? (s.form ? '#ffd76a' : '#e8e8e8');
    if (s.move && s.move.speed === 0) fxQueue.push({ t: 'swing', arc: s.move.arc, reach: s.move.reach, color, durationMs: (s.startup + s.active) * STEP_MS, at: performance.now() });
    // CR 022: the swing's arc in the world (the same FX others see from Event 214).
    if (s.move && s.move.speed === 0 && s.move.radius <= 1) spellFx.swing('self', s.move.id, yaw, gemFor('self'));
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

  /**
   * CR 020: one shot of a hold-to-fire stream. It leaves along the current
   * aim leaning by the stream's seeded jitter (spellsim.ts, the zone judges
   * the claim from the same lean), or for rain falls from above a seeded
   * point around the aim point. Its claims name the shot's own seq.
   */
  private fireShot(s: Started, before: MoveState): void {
    const sp = s.spell!;
    const seed = streamSeed(s.streamStart ?? s.seq, sp.id);
    const k = s.shot ?? 0;
    const aoe = sp.radius > 1 ? sp.radius : 0;
    const radius = Math.max(0.12, Math.min(sp.radius, 1));
    if (sp.rain) {
      const eye = { x: before.pos.x, y: before.pos.y + EYE, z: before.pos.z };
      const aim = this.aimPoint(eye, localPlayer.aimYaw, localPlayer.aimPitch, sp.range);
      const off = rainOffset(seed, k, sp.rain.radius);
      const x = aim.x + off.dx;
      const z = aim.z + off.dz;
      const gy = this.ground ? this.ground.heightAt(x, z) : aim.y;
      const sh: LocalShot = { started: s, x, y: gy + sp.rain.height, z, vx: 0, vy: -sp.speed, vz: 0, gravity: 0, radius, left: sp.rain.height + 4, hit: new Set(), pierce: false, aoe, fx: 0, homing: null };
      this.shots.push(sh);
      sh.fx = spellFx.projectile(sp, sh.x, sh.y, sh.z, 0, -sp.speed, 0, 0, Math.min(radius, 0.4), (sp.rain.height + 4) / sp.speed, { explode: aoe, spread: true });
      if (k % 3 === 0) emitSound('cast', { element: sp.tree, kind: 'stream' });
      return;
    }
    const j = shotJitter(seed, k, sp.auto?.jitterDeg ?? 0);
    const a: Active = { s, yaw: localPlayer.yaw, pitch: localPlayer.pitch, aimYaw: localPlayer.aimYaw, aimPitch: localPlayer.aimPitch, hit: new Set(), impact: null, ticks: 0, until: 0, lastHit: null };
    this.launch(s, sp.speed, sp.gravity, radius, sp.range, sp.pierce, aoe, a, j.dyaw, sp.color, true, j.dpitch);
    if (k % 3 === 0) emitSound('cast', { element: sp.tree, kind: 'stream' });
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
        if (seq === firstHit) this.launch(s, shotSpeed(m, s.charge), m.gravity, m.radius, shotRange(m, s.charge), false, 0, a); // CR 033: the draw sets speed and reach
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
        // CR 022: one beam per cast that follows your aim every frame (castState), drawn by the
        // same call that draws another player's beam from their replicated aim.
        if (a.ticks === 1) spellFx.channelBeam(sp, 'self', sp.type === 'beam' ? sp.durationMs : 150);
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
      case 'orbit': {
        // CR 020: orbs circle you (spellsim orbOffset, same as the zone's ring check) and touch what they pass.
        const o = sp.orbit!;
        if (seq === firstHit) spellFx.orbit(sp, 'self', sp.durationMs);
        if (seq >= firstHit + Math.max(1, sp.durationSteps)) return;
        a.lastHit ??= new Map();
        const hitsOn = (a.hitCount ??= new Map());
        for (let i = 0; i < o.count; i++) {
          const off = orbOffset(i, o.count, seq - s.seq, o.periodSteps, o.radius);
          const orb = { x: st.pos.x + off.x, y: st.pos.y + off.y, z: st.pos.z + off.z };
          for (const e of this.enemies()) {
            const last = a.lastHit.get(e.id);
            if ((last !== undefined && seq - last < o.hitEverySteps) || (hitsOn.get(e.id) ?? 0) >= sp.hits) continue;
            if (Math.hypot(e.x - orb.x, e.z - orb.z) > o.orbRadius + enemyInfo(e).radius || Math.abs(e.y + enemyInfo(e).height - orb.y) > 2) continue;
            a.lastHit.set(e.id, seq);
            hitsOn.set(e.id, (hitsOn.get(e.id) ?? 0) + 1);
            this.predictHit(s, e, orb, 'spell', true);
          }
        }
        return;
      }
      case 'summon':
        return; // CR 020: the zone calls the ally (castStart drew the summoning)
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

  /** The aim point on the terrain along the look ray (or at range): aim.ts, shared with the FX engine. */
  private aimPoint(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, range: number): { x: number; y: number; z: number } {
    const g = this.ground;
    return sharedAimPoint(eye, yaw, pitch, range, g ? (x, z) => g.heightAt(x, z) : null);
  }

  /** The enemy nearest the crosshair within range and `deg` degrees (aim.ts). */
  private aimTarget(eye: { x: number; y: number; z: number }, yaw: number, pitch: number, range: number, deg: number): RemoteView | null {
    return sharedAimTarget(eye, yaw, pitch, range, deg, this.enemies(), () => true);
  }

  private launch(s: Started, speed: number, gravity: number, radius: number, range: number, pierce: boolean, aoe: number, a: Active, yawOff = 0, color = '#e8d8a0', spread = false, pitchOff = 0): void {
    const eye = { x: localPlayer.pos.x, y: localPlayer.pos.y + EYE - 0.15, z: localPlayer.pos.z };
    // CR 020: a held charge flies faster and bursts wider (the zone scales the same way).
    const ch = s.spell?.charge;
    if (ch && s.charge > 0) {
      speed *= chargeMult(ch.speedMult, s.charge);
      range *= chargeMult(ch.speedMult, s.charge);
      if (aoe > 0) aoe *= chargeMult(ch.radiusMult, s.charge);
    }
    // Playtest 2: the converged aim (third person: toward what the crosshair is on).
    const yaw = localPlayer.aimYaw + yawOff;
    const pitch = localPlayer.aimPitch + pitchOff + (gravity > 0 ? 0.05 : 0);
    const cp = Math.cos(pitch);
    const hp = s.spell ? homingParams(s.spell) : null;
    const sh: LocalShot = { started: s, x: eye.x, y: eye.y, z: eye.z, vx: -Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: -Math.cos(yaw) * cp * speed, gravity, radius, left: range, hit: new Set(), pierce, aoe, fx: 0, homing: null };
    if (hp) sh.homing = { p: hp, s: launchShot(eye, yaw, pitch, speed), lock: 0, acc: 0 };
    else if (gravity > 0) {
      // CR 030: a strong wind carries arrows downwind (a degree or two at full range: inside the zone's aim slack).
      const w = arrowWindAt(eye.x, eye.z);
      if (w[0] !== 0 || w[1] !== 0) sh.wind = w;
    }
    this.shots.push(sh);
    void a;
    void color;
    // The visual starts at your off hand and is ended by update() below (hit, ground, range).
    sh.fx = spellFx.projectile(s.spell ?? null, sh.x, sh.y, sh.z, sh.vx, sh.vy, sh.vz, gravity, Math.max(0.12, s.shot !== undefined ? Math.min(radius, 0.4) : radius), range / Math.max(1, speed), { local: true, explode: aoe, pierce, spread, kind: 'arrow', homing: !!hp });
  }

  /** CR 020: one shared 1/60 s homing step for a seeking shot (acquire, steer, move). */
  private homingTick(sh: LocalShot): void {
    const h = sh.homing!;
    const s = h.s;
    if (s.state === 0 && s.age >= h.p.delay) {
      let best: RemoteView | null = null;
      let bd = Infinity;
      for (const e of this.enemies()) {
        const c = { x: e.x, y: e.y + enemyInfo(e).height, z: e.z };
        if (!canAcquire(s, c, h.p)) continue;
        const d = Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
      if (best) {
        s.state = 1;
        h.lock = best.id;
      }
    }
    let t: { x: number; y: number; z: number } | null = null;
    if (s.state === 1) {
      const e = this.enemies().find((v) => v.id === h.lock);
      if (e) t = { x: e.x, y: e.y + enemyInfo(e).height, z: e.z };
    }
    homingStep(s, t, h.p);
    sh.left -= Math.hypot(s.x - sh.x, s.y - sh.y, s.z - sh.z);
    sh.x = s.x;
    sh.y = s.y;
    sh.z = s.z;
    sh.vx = s.vx;
    sh.vy = s.vy;
    sh.vz = s.vz;
  }

  /** Per rendered frame: local projectiles and hitstop. */
  update(dtMs: number): void {
    const dt = Math.min(dtMs, 50) / 1000;
    // CR 022: your aim on your caster record every frame (your beams and held spells follow it).
    const now = performance.now();
    castState.aim('self', localPlayer.aimYaw, localPlayer.aimPitch, true, now);
    castState.expire('self', now);
    const keep: LocalShot[] = [];
    for (const sh of this.shots) {
      let alive = true;
      // Seeking shots run whole 1/60 s steps (the zone re-flies the same ones); others three substeps.
      let n = 3;
      if (sh.homing) {
        sh.homing.acc += dt;
        n = Math.floor(sh.homing.acc / SIM_DT + 1e-9);
        sh.homing.acc -= n * SIM_DT;
      }
      for (let k = 0; k < n && alive; k++) {
        const h = dt / n;
        if (sh.homing) this.homingTick(sh);
        else {
          sh.vy -= sh.gravity * h;
          if (sh.wind) {
            sh.vx += sh.wind[0] * h;
            sh.vz += sh.wind[1] * h;
          }
          sh.x += sh.vx * h;
          sh.y += sh.vy * h;
          sh.z += sh.vz * h;
          sh.left -= Math.hypot(sh.vx, sh.vy, sh.vz) * h;
        }
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
      if (alive && ((sh.homing && n > 0) || sh.wind)) spellFx.projectileMove(sh.fx, sh.x, sh.y, sh.z, sh.vx, sh.vy, sh.vz);
      if (alive) keep.push(sh);
    }
    this.shots = keep;
  }

  private explode(sh: LocalShot): void {
    // The explosion visual is the projectile's end (spellFx.projectileEnd with the radius).
    const stream = sh.started.shot !== undefined;
    // CR 020: a stream pops 8-15 times a second: one quiet impact cue in three, claims for at most 4 (the zone's per-shot limit).
    if (!stream || (sh.started.shot ?? 0) % 3 === 0) emitSound('impact', { at: { x: sh.x, y: sh.y, z: sh.z }, element: sh.started.spell?.tree ?? 'earth' });
    let n = 0;
    for (const e of this.enemies()) {
      if (Math.hypot(e.x - sh.x, e.z - sh.z) <= sh.aoe + enemyInfo(e).radius && (!stream || n++ < 4)) this.predictHit(sh.started, e, { x: sh.x, y: sh.y, z: sh.z }, sh.started.kind, true);
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
    const gem = this.timeline.loadout.gem;
    const heavyHit = kind === 'form' || s.move?.kind === 'heavy';
    fxQueue.push({ t: 'spark', x: at.x, y: at.y, z: at.z, color: s.spell?.color ?? '#fff3c0', at: now, target: e.id, heavy: heavyHit });
    // playtest 2: the number takes the colour of what hit (the spell's element, the weapon gem, else physical)
    const element = s.spell ? (s.spell.element >= 0 ? s.spell.element : 8) : gem >= 0 ? gem : 8;
    spellFx.hit(s.spell ?? null, at.x, at.y, at.z, { tint: !s.spell && gem >= 0 ? ELEMENT_COLORS[gem] : null, heavy: kind === 'form' || s.move?.kind === 'heavy' });
    if (!impactIsOrigin && (s.shot === undefined || s.shot % 3 === 0)) emitSound('impact', { at, element: s.spell?.tree, weapon: this.timeline.weapon().key }); // CR 020: a stream rings every third hit
    if (kind === 'move' || kind === 'form') this.hitstopUntil = Math.max(this.hitstopUntil, now + HITSTOP_MS);
    this.probe.localHit(s, now, kind === 'move' || kind === 'form' ? HITSTOP_MS : 0);
    const claimAt = impactIsOrigin ? origin : localPlayer.pos;
    const yaw = Math.round((((localPlayer.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 65536) & 0xffff;
    this.link.sendHitClaim({ attackSeq: s.seq, attackId: s.id, targetId: e.id, tick: this.link.latestTick(), x: Math.round(claimAt.x * 100), y: Math.round(claimAt.y * 100), z: Math.round(claimAt.z * 100), yaw, pitch: 0 });
    this.pendingClaims.set(`${s.seq}:${e.id}`, { at: now, ...at, kind, element });
  }

  /** HitResult: show the number for confirmed hits (refused: nothing). */
  onHitResult(r: HitResult): void {
    const key = `${r.attackSeq}:${r.targetId}`;
    const p = this.pendingClaims.get(key);
    this.pendingClaims.delete(key);
    this.probe.confirmed(r.accepted, p?.at ?? 0, performance.now());
    if (!p || !r.accepted) return;
    if (useCombatHud.getState().graceUntil) useCombatHud.getState().set({ graceUntil: 0 }); // CR 024: a landed hit ends the grace
    const kind = r.flags & 1 ? 'crit' : r.flags & 4 ? 'weak' : r.flags & 8 ? 'resist' : 'dealt';
    pushNumber(p.x, p.y + 0.4, p.z, r.damage, kind, p.element);
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
      case EV.cast:
      case EV.held:
        // Another player's attack, cast, form, dash or guard (214, with its exact aim; a released
        // charge's u8 fraction), or the precise aim of what they hold (CR 022: 226): their caster
        // record and the FX, at the moment their drawn body reaches it (castState.ts).
        remoteEvent(ev, self, now, spellFx);
        return;
      case EV.channel: {
        // CR 020: a stream / charge started (1, 2) or stopped (0); contracts/events.md 223.
        if (ev.entityId === self) {
          if (ev.value !== 0) return;
          const d = new DataView(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
          const start = ev.data.length >= 6 ? d.getUint32(2, true) : 0;
          // The zone ended our stream first (mana): stop predicting it.
          const c = this.timeline.channel;
          if (c && !c.charge && c.start === start) {
            this.timeline.endChannel(this.timeline.seq, null);
            spellFx.channelEnd('self', c.spell);
            castState.release('self', 'stream');
            this.streaming = null;
          }
          return;
        }
        remoteEvent(ev, self, now, spellFx); // another player's: their caster record (castState.ts)
        return;
      }
      case EV.detonate: {
        // CR 020: a delayed charge or a brand burst (the zone's own hits).
        const sp = spellById.get(ev.value);
        const r = ev.data.length >= 2 ? new DataView(ev.data.buffer, ev.data.byteOffset, 2).getUint16(0, true) / 100 : 3;
        if (sp) spellFx.detonate(sp, ev.x / 100, ev.y / 100, ev.z / 100, r);
        return;
      }
      case EV.summonAttack: {
        // CR 020: an ally attacked (its bite or bolt; the damage comes as Event 200).
        const sp = spellById.get(ev.value);
        if (sp) spellFx.summonAttack(ev.entityId, Number(ev.targetId), sp, ev.x / 100, ev.y / 100, ev.z / 100);
        return;
      }
      case EV.status:
        spellFx.status(Number(ev.targetId), ev.value);
        // playtest 2 enemy models: holds (freeze, petrify) and staggers (stun, knockback) in the pose
        fxQueue.push({ t: 'enemy', what: 'status', enemy: Number(ev.targetId), value: ev.value, at: now });
        return;
      case EV.enemyDied:
        fxQueue.push({ t: 'enemy', what: 'died', enemy: ev.entityId, value: 0, at: now });
        return;
      case EV.shield:
        if (ev.entityId === self || ev.entityId === 0) spellFx.shieldPoints(ev.value);
        else remoteEvent(ev, self, now, spellFx); // CR 022: another player's shield broke
        return;
      case EV.damage: {
        // data: u8 HitResult flags (1 crit, 4 weak, 8 resist) | u8 health %
        const fl = ev.data.length > 0 ? ev.data[0] : 0;
        pushNumber(ev.x / 100, ev.y / 100 + 0.4, ev.z / 100, ev.value, fl & 1 ? 'crit' : fl & 4 ? 'weak' : fl & 8 ? 'resist' : 'dealt');
        fxQueue.push({ t: 'spark', x: ev.x / 100, y: ev.y / 100, z: ev.z / 100, color: '#fff3c0', at: now, target: Number(ev.targetId) });
        spellFx.hit(null, ev.x / 100, ev.y / 100, ev.z / 100);
        return;
      }
      case EV.playerHurt:
        if (ev.entityId === self) {
          pushNumber(localPlayer.pos.x, localPlayer.pos.y + 2.1, localPlayer.pos.z, ev.value, 'taken');
          this.probe.strike(now, false);
        }
        return;
      case EV.evaded:
        if (ev.value === 2) fxQueue.push({ t: 'enemy', what: 'parried', enemy: Number(ev.targetId), value: 0, at: now }); // the attacker reels
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
          // Playtest 2 (CR 024): name what downed you and where you come back.
          hud.set({ downedUntil: now + ev.value, downedBy: killerName(ev.targetId, drawnRemotes.views), respawnAt: respawnSiteName(), graceUntil: 0 });
        }
        return;
      case EV.respawned:
        this.timeline.downed = false;
        hud.set({ downedUntil: 0, graceUntil: now + GRACE_MS });
        return;
      case EV.bossEngaged:
        {
          // The boss's real phase count (it used to guess 3: a two-phase boss showed "phase 1/3").
          const view = drawnRemotes.views.find((v) => v.id === ev.entityId);
          const key = view ? enemyInfo(view).key : '';
          const phases = COMBAT.bosses.find((b) => b.key === key)?.phases.length ?? 1;
          hud.set({ boss: { id: ev.entityId, name: new TextDecoder().decode(ev.data), phase: 1, phases: Math.max(1, phases), pct: 100 } });
        }
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
        if (sp && this.timeline.channel?.spell.id === sp.id) {
          this.timeline.endChannel(this.timeline.seq, null); // CR 020: a refused stream never ran
          this.timeline.refund(sp.id);
          spellFx.channelEnd('self', sp);
          castState.release('self');
          this.streaming = null;
        }
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
  return { attackDown: false, altDown: false, attackPress: 0, altPress: 0, altRelease: 0, dodgePress: 0, castPress: [null, null, null, null], castHeld: [false, false, false, false], formPress: 0, techniquePress: 0, drinkPress: 0 };
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

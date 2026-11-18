// The spell FX engine (playtest 2): one imperative manager for every spell
// visual in the game, driven from a single useFrame (SpellFxLayer).
//
// Inputs come through api.ts: the combat runtime's predicted casts (your
// own), Event 214 casts of other players (simulated here, visual only),
// enemy projectiles (205), statuses (206) and shields (219). Each becomes
//
// CR 022 (shared spell visuals): every caster-bound effect reads the one
// caster record both your prediction and replication fill
// (../castState.ts): the aim a beam or a stream follows (yours every frame,
// another player's from Events 214 / 223 / 226), whether a dash is
// thrusting (the casting bit), and draws it with the same functions for
// you and for them: where a cast leaves (castOrigin.ts casterHand), where
// the aim lands (../aim.ts), projectiles that leave the hand and ease onto
// the true path, the cast flourish, weapon swing arcs, shields that burst
// when they break.
// a recipe (recipes.ts) over the GPU particle pools (particles.ts) and the
// pooled transients (transients.ts), plus a few "ongoing" effects (flying
// projectiles, beams, lingering zones, domains, runes, dash trails,
// shields, statuses) updated here every frame.
//
// Budgets: 64 projectiles, the transient pool caps (transients.ts POOL),
// statuses on the nearest N enemies (quality.ts), 48 ongoing effects, a
// per-frame particle budget; past a cap the oldest is recycled. Effects
// beyond 90 m are skipped, and far ones emit fewer particles.

import { shotAtWall } from './shotWall';
import * as THREE from 'three';
import type { SpellDef, FormDef } from '@lodestone/contracts';
import { drawnRemotes } from '../../net/netStore';
import type { RemoteView } from '../../net/interpolation';
import { localPlayer, view } from '../../state/live';
import { enemyInfo } from '../events';
import { budget, col, fxTime, GEO, glowTexture, hot, rand, setFxTier } from './core';
import { glowPool, smokePool, SHAPE_GLOW, SHAPE_PUFF, SHAPE_SPARK } from './particles';
import { FxPrims, alive, type Held, type DecalSlot, type BeamSlot, type ShellSlot, type DomeSlot } from './transients';
import { currentFxTier, FX_PROFILES } from './quality';
import { castHooks, casterHand, gemFor } from './castOrigin';
import { weaponOfMove, weaponShotRadius, weaponShotVisual } from './weaponShot';
import { flashProfile } from '../flashSafety';
import { castState, type CasterKey } from '../castState';
import { aimPoint as sharedAimPoint, beamEnd, lookDir, AIM_EYE, SHOT_Y } from '../aim';
import { FORM_STARTUP_STEPS, moveById, shotRange, shotSpeed } from '../timeline';
import { ELEMENT_FAMILY, PALETTES, spellVisual, statusById, statusByKey, ZONE_STYLE, enemyAttackById, formById, spellById, mobilitySpellForDash, type SpellVisual, type Family } from './spellVisual';
import * as R from './recipes';
import { DASH_FX_MAX_S, DASH_FX_MIN_SPEED, dashFxStep, newDashFxState } from './dashFx'; // CR 021
import { screenKick, screenTick, screenTint } from './screen';
import type { CircleMat, ZoneMat } from './materials';
import { COMBAT } from '@lodestone/contracts';
import { canAcquire, chargeMult, homingParams, homingStep, orbOffset, rainOffset, shotJitter, SIM_DT, type HomingParams, type HomingShot } from '../spellsim';

const EYE = AIM_EYE;
const STEP_MS = 1000 / 60;
const MAX_PROJ = 64;
const MAX_ONGOING = 48;
const FAR = 90;
const UP = new THREE.Vector3(0, 1, 0);

export type V3 = R.V3;
/** Who an effect follows: your own character, an entity id (remote player, enemy), or a fixed point (feet). */
export type Anchor = 'self' | number | V3;

interface Proj {
  on: boolean;
  handle: number;
  v: SpellVisual;
  x0: number;
  y0: number;
  z0: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
  t0: number;
  life: number;
  core: number;
  /** The core mesh's scale as placed (playtest 2 calm kills: it shrinks away near the lens). */
  sx: number;
  sy: number;
  sz: number;
  local: boolean;
  /** Remote and enemy shots test the ground and bodies themselves (visual only). */
  collide: 'none' | 'enemies' | 'players';
  explode: number;
  pierce: boolean;
  spread: boolean;
  mesh: THREE.Mesh;
  halo: THREE.Sprite;
  px: number;
  py: number;
  pz: number;
  ox: number;
  oy: number;
  oz: number;
  light: ReturnType<FxPrims['holdLight']>;
  lastHit: number;
  spin: number;
  /** CR 020: a seeking shot this engine steers itself (remote casts; spellsim.ts), null otherwise. */
  hs: { p: HomingParams; s: HomingShot; lock: number; acc: number; last: number } | null;
}

interface Ongoing {
  until: number;
  /** Returns false to end early. */
  tick(t: number, dt: number): boolean;
  end?(): void;
}

interface StatusEntry {
  id: number;
  until: Float64Array; // per status id (1..12)
  /** The tinted shell it wears (medium and up), the strongest status first. */
  shell: Held<ShellSlot> | null;
  /** Playtest 2 calm kills: the shell fades in and out (0..1) instead of popping on and off with each re-applied status. */
  k: number;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const camPos = new THREE.Vector3();
const HAND = new THREE.Vector3(-0.24, -0.22, -0.5);
const tmpHand = { x: 0, y: 0, z: 0 };

const basicCache = new Map<string, THREE.MeshBasicMaterial>();
function coreMat(c: THREE.Color): THREE.MeshBasicMaterial {
  const key = c.getHexString() + (c.r > 1 || c.g > 1 || c.b > 1 ? `|${c.r.toFixed(2)}` : '');
  let m = basicCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: c.clone() });
    basicCache.set(key, m);
  }
  return m;
}
const haloCache = new Map<string, THREE.SpriteMaterial>();
function haloMat(c: THREE.Color, opacity: number): THREE.SpriteMaterial {
  const key = `${c.r.toFixed(3)},${c.g.toFixed(3)},${c.b.toFixed(3)}|${opacity}`;
  let m = haloCache.get(key);
  if (!m) {
    m = new THREE.SpriteMaterial({ map: glowTexture(), color: c.clone(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity });
    haloCache.set(key, m);
  }
  return m;
}
let boulder: THREE.MeshStandardMaterial | null = null;
const boulderMat = () => (boulder ??= new THREE.MeshStandardMaterial({ color: '#7a6040', roughness: 0.95, flatShading: true, emissive: '#2a1808', emissiveIntensity: 0.25 }));

const DOME_STYLE: Record<Family, number> = { fire: 0, ice: 1, void: 2, dark: 2, blood: 2, steel: 3, nature: 4, stone: 4, crystal: 5, lightning: 6, wind: 7, light: 8 };

let handles = 1;
const POOLS = [glowPool, smokePool];

export class SpellFxEngine {
  readonly prims: FxPrims;
  readonly group: THREE.Group;
  private readonly projs: Proj[] = [];
  private ongoing: Ongoing[] = [];
  private readonly statuses = new Map<number, StatusEntry>();
  private readonly viewById = new Map<number, RemoteView>();
  private readonly hand: { sprite: THREE.Sprite; mat: THREE.SpriteMaterial; color: THREE.Color; pulse: number; charge: number; chargeUntil: number; hold: number };
  private camera: THREE.Camera | null = null;
  private readonly handPos = new THREE.Vector3();
  /** Optional override of where your own casts leave (third person: the avatar's hand). */
  handAnchor: ((out: THREE.Vector3) => boolean) | null = null;
  private selfShield: { v: SpellVisual; until: number; o: Ongoing | null } | null = null;
  private lastT = 0;
  /** Frames left of the draw warm-up (prewarm). */
  private warmFrames = 0;
  /** Counters for the debug handle and bench. */
  readonly counts = { casts: 0, remoteCasts: 0, shots: 0, impacts: 0, maxUpdateMs: 0, maxCastMs: 0 };

  constructor(lightCount: number) {
    const p = FX_PROFILES.ultra;
    this.prims = new FxPrims(lightCount, p.spikes, p.boltSegments, 20);
    this.group = this.prims.group;
    this.group.add(glowPool.points, smokePool.points);
    for (let i = 0; i < MAX_PROJ; i++) {
      const mesh = new THREE.Mesh(GEO.sphereLow, coreMat(col('#ffffff')));
      const halo = new THREE.Sprite(haloMat(col('#ffffff'), 0.85));
      mesh.visible = halo.visible = false;
      mesh.frustumCulled = halo.frustumCulled = false;
      halo.renderOrder = 21;
      this.group.add(mesh, halo);
      this.projs.push({ on: false, handle: 0, v: spellVisual(COMBAT.spells[0]), x0: 0, y0: 0, z0: 0, vx: 0, vy: 0, vz: 0, g: 0, t0: 0, life: 0, core: 0.2, sx: 1, sy: 1, sz: 1, local: false, collide: 'none', explode: 0, pierce: false, spread: false, mesh, halo, px: 0, py: 0, pz: 0, ox: 0, oy: 0, oz: 0, light: null, lastHit: 0, spin: 0, hs: null });
    }
    const hm = new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, opacity: 0 });
    const hs = new THREE.Sprite(hm);
    hs.renderOrder = 30;
    hs.frustumCulled = false;
    hs.visible = false;
    this.group.add(hs);
    this.hand = { sprite: hs, mat: hm, color: new THREE.Color(), pulse: 0, charge: 0, chargeUntil: 0, hold: 0 };
  }

  dispose(): void {
    this.group.remove(glowPool.points, smokePool.points);
    this.prims.dispose();
    this.hand.mat.dispose();
  }

  // ── Anchors ───────────────────────────────────────────────────────────────

  /** Feet position of an anchor into `out`; false when it is gone. */
  private anchorPos(a: Anchor, out: V3): boolean {
    if (a === 'self') {
      out.x = localPlayer.pos.x;
      out.y = localPlayer.pos.y;
      out.z = localPlayer.pos.z;
      return true;
    }
    if (typeof a === 'object') {
      out.x = a.x;
      out.y = a.y;
      out.z = a.z;
      return true;
    }
    const v = this.viewById.get(a);
    if (!v) return false;
    out.x = v.x;
    out.y = v.y;
    out.z = v.z;
    return true;
  }

  /** Where your own casts leave: the off hand in first person (camera space), or the override. */
  private selfHand(out: THREE.Vector3): THREE.Vector3 {
    if (this.handAnchor?.(out)) return out;
    if (view.third) {
      // Third person (T): your avatar's staff/wand tip or raised off hand, not the lens (the same rule as everyone's body).
      const f = view.feet;
      casterHand('self', f.x, f.y, f.z, localPlayer.yaw, localPlayer.pitch, tmpHand);
      return out.set(tmpHand.x, tmpHand.y, tmpHand.z);
    }
    if (castHooks.fpOrigin?.(tmpHand)) return out.set(tmpHand.x, tmpHand.y, tmpHand.z);
    if (!this.camera) return out.set(localPlayer.pos.x, localPlayer.pos.y + EYE - 0.3, localPlayer.pos.z);
    return out.copy(HAND).applyMatrix4(this.camera.matrixWorld);
  }

  /** A remote caster's cast point: their staff/wand tip or raised off hand (castOrigin.ts casterHand). */
  private remoteHand(x: number, y: number, z: number, yaw: number, out: V3, id = 0, pitch = 0): V3 {
    return id ? casterHand(id, x, y, z, yaw, pitch, out) : casterHand(-1, x, y, z, yaw, pitch, out);
  }

  /** CR 022: the caster record an anchor names ('self', an entity id), null for a fixed point. */
  private keyOf(a: Anchor): CasterKey | null {
    return a === 'self' ? 'self' : typeof a === 'number' ? a : null;
  }

  /** CR 022: a caster's aim now (yours exactly; another player's replicated aim, else their drawn look). */
  private aimNow(a: Anchor, yaw0: number, pitch0: number): { yaw: number; pitch: number } {
    if (a === 'self') return castState.aimOf('self', localPlayer.aimYaw, localPlayer.aimPitch, performance.now());
    if (typeof a !== 'number') return { yaw: yaw0, pitch: pitch0 };
    const v = this.viewById.get(a);
    return castState.aimOf(a, v?.yaw ?? yaw0, v?.pitch ?? pitch0, performance.now());
  }

  /** CR 022: where a caster's casts leave now: your hand (first person: the view model), or any body's casterHand. */
  private handOf(a: Anchor, out: V3): boolean {
    if (a === 'self') {
      this.selfHand(tmpV);
      out.x = tmpV.x;
      out.y = tmpV.y;
      out.z = tmpV.z;
      return true;
    }
    if (typeof a !== 'number') return false;
    const v = this.viewById.get(a);
    if (!v) return false;
    this.remoteHand(v.x, v.y, v.z, v.yaw, out, a, v.pitch);
    return true;
  }

  /** Distance scale for emission (1 near, 0.35 at 60 m) and the cull. */
  private lod(x: number, y: number, z: number): number {
    const d = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
    if (d > FAR) return 0;
    return d < 20 ? 1 : Math.max(0.35, 1 - (d - 20) / 60);
  }

  /** Runs a recipe with the distance scale applied (skipped when too far). */
  private at(x: number, y: number, z: number, play: () => void, k = 1): void {
    const l = this.lod(x, y, z) * k;
    if (l <= 0) return;
    const prev = budget.scale;
    budget.scale = l;
    play();
    budget.scale = prev;
  }

  private push(o: Ongoing): void {
    if (this.ongoing.length >= MAX_ONGOING) {
      // recycle the one ending soonest
      let i = 0;
      for (let k = 1; k < this.ongoing.length; k++) if (this.ongoing[k].until < this.ongoing[i].until) i = k;
      this.ongoing[i].end?.();
      this.ongoing.splice(i, 1);
    }
    this.ongoing.push(o);
  }

  // ── Your own casts (the runtime's prediction) and remote ones ─────────────

  /**
   * A spell started: the flourish at the hand, windup telegraphs (sigil at
   * the aim point, charge at the hand), dashes, shields. `aim` is the
   * predicted aim point for area spells with a windup.
   */
  castStart(sp: SpellDef, caster: Anchor, aim: V3 | null, yaw: number, target: Anchor | null = null): void {
    this.counts.casts++;
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    const self = caster === 'self';
    if (self) {
      castHooks.selfCastAt = performance.now();
      castHooks.selfCastColor = sp.color ?? '#ffffff';
    }
    const windup = sp.windupMs;
    if (self) {
      this.hand.color.copy(c.mainH);
      this.hand.pulse = 1;
      if (windup > 0) {
        this.hand.charge = 0;
        this.hand.chargeUntil = fxTime() + windup / 1000;
      }
    }
    const pos = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, pos)) return;
    // Windup telegraph: a sigil filling up where it will land.
    if (windup > 0 && sp.type !== 'projectile' && sp.type !== 'arc' && sp.type !== 'hitscan') {
      // direct spells mark their target; areas their aim point; self-casts the caster
      const tp = { x: 0, y: 0, z: 0 };
      const onTarget = sp.type === 'direct' && target !== null && this.anchorPos(target, tp);
      const at = onTarget ? tp : sp.selfCast || sp.type === 'domain' || !aim ? pos : aim;
      const r = Math.max(1.2, sp.type === 'direct' ? 1.4 : sp.radius);
      this.windupSigil(v, at, r, windup, onTarget ? target : sp.selfCast ? caster : null);
    }
    // Flourish ahead of the hand for spells that have no projectile or beam of their own: every
    // caster's (CR 022: others saw nothing of a summon, an area or a shield leaving the hand).
    if (sp.type !== 'projectile' && sp.type !== 'arc' && sp.type !== 'hitscan' && sp.type !== 'beam' && sp.type !== 'mobility') {
      if (self && this.camera && !view.third) {
        // first person: 1.4 m ahead (particles fade within 2 m of the lens)
        this.selfHand(tmpV);
        this.camera.getWorldDirection(tmpV2);
        const d = { x: tmpV2.x, y: tmpV2.y, z: tmpV2.z };
        R.muzzle(this.prims, v, tmpV.x + d.x * 1.4, tmpV.y + d.y * 1.4 + 0.15, tmpV.z + d.z * 1.4, d, v.weight === 'minor' ? 1 : 1.6);
      } else {
        const hp = { x: 0, y: 0, z: 0 };
        if (this.handOf(caster, hp)) {
          const am = this.aimNow(caster, yaw, 0);
          const d = lookDir(am.yaw, am.pitch);
          this.at(hp.x, hp.y, hp.z, () => R.muzzle(this.prims, v, hp.x + d.x * 0.3, hp.y + d.y * 0.3, hp.z + d.z * 0.3, d, v.weight === 'minor' ? 1 : 1.6));
        }
      }
    }
    if (sp.type === 'mobility') this.dash(v, sp, caster);
    else if (sp.type === 'defensive' && !sp.familiar) this.shieldUp(v, sp, caster); // CR 042: a familiar light is no shield (world/lights)
    void yaw;
  }

  /** A sigil that fills during the windup (and an ultimate's gathering energy). */
  private windupSigil(v: SpellVisual, at: V3, r: number, ms: number, follow: Anchor | null): void {
    const h = this.prims.holdSigil();
    const c = R.cols(v.palette);
    const m = h.s.mat;
    (m.uniforms.uColor.value as THREE.Color).copy(c.main);
    (m.uniforms.uColor2.value as THREE.Color).copy(c.hotH);
    m.uniforms.uSides.value = v.sigil;
    m.uniforms.uSpin.value = 1.2;
    m.uniforms.uFill.value = 0.1;
    const p = { x: at.x, y: at.y, z: at.z };
    this.prims.conform(h.s.mesh, p.x, p.y, p.z, r * 1.05, r * 1.05, 0, 0.1);
    const t0 = fxTime();
    const dur = ms / 1000;
    this.push({
      until: t0 + dur + 0.15,
      tick: (t, dt) => {
        if (!alive(h)) return false;
        const k = Math.min(1, (t - t0) / dur);
        m.uniforms.uTime.value = t;
        m.uniforms.uProgress.value = k;
        // (a sigil under your own feet stays faint: you are looking through it)
        m.uniforms.uOpacity.value = (follow === 'self' ? 0.45 : 1) * (0.55 + 0.35 * Math.abs(Math.sin(t * (6 + k * 20)))) * Math.min(1, (t - t0) * 6) * (t - t0 > dur ? Math.max(0, 1 - (t - t0 - dur) / 0.15) : 1);
        if (follow !== null && this.anchorPos(follow, p)) h.s.mesh.position.set(p.x, h.s.mesh.position.y, p.z);
        const l = this.lod(p.x, p.y, p.z);
        if (l > 0 && v.weight !== 'minor') {
          budget.scale = l;
          if (v.setPiece === 'death_note' || v.setPiece === 'unwritten') R.targetWindup(v, p.x, p.y, p.z, k, dt);
          else R.charge(v, p.x, p.y + 0.3, p.z, r, 40 * dt * (0.5 + k));
          budget.scale = 1;
        }
        return true;
      },
      end: () => this.prims.release(h),
    });
  }

  /** Mobility: a trail behind the caster for the dash, bursts where it starts and ends. */
  private dash(v: SpellVisual, sp: SpellDef, caster: Anchor): void {
    const d = COMBAT.dashes.find((x) => x.id === sp.dash);
    const ms = Math.max(150, (d?.steps ?? 10) * STEP_MS + (d?.lift ? 250 : 0));
    const prev = { x: 0, y: 0, z: 0 };
    const cur = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, prev)) return;
    this.at(prev.x, prev.y, prev.z, () => R.dashBurst(this.prims, v, prev.x, prev.y, prev.z, false));
    const t0 = fxTime();
    const df = newDashFxState(); // CR 021: held dashes keep their FX while the caster moves at dash speed (dashFx.ts)
    const key = this.keyOf(caster);
    this.push({
      until: t0 + DASH_FX_MAX_S,
      tick: (t, dt) => {
        if (!this.anchorPos(caster, cur)) return false;
        const speed = Math.hypot(cur.x - prev.x, cur.y - prev.y, cur.z - prev.z) / Math.max(1e-3, dt);
        // CR 022: a dash its key holds (yours: the timeline; another player's: their casting bit) runs its
        // full FX for as long as it is held, for everyone; the carry after it fades with its speed.
        const held = key !== null && castState.peek(key)?.dash?.holding === true;
        if (t - t0 > ms / 1000 && speed < DASH_FX_MIN_SPEED && !held) return false;
        if (speed > 1) this.at(cur.x, cur.y, cur.z, () => dashFxStep(this.prims, v, prev, cur, speed, df, held));
        if (Math.hypot(cur.x - prev.x, cur.z - prev.z) > 0.05 || Math.abs(cur.y - prev.y) > 0.05) this.at(cur.x, cur.y, cur.z, () => R.dashTrail(this.prims, v, prev, cur));
        prev.x = cur.x;
        prev.y = cur.y;
        prev.z = cur.z;
        return true;
      },
      end: () => {
        if (this.anchorPos(caster, cur)) this.at(cur.x, cur.y, cur.z, () => R.dashBurst(this.prims, v, cur.x, cur.y, cur.z, true), 0.7);
      },
    });
  }

  /** Defensive: shell (others see it; from inside a front-faced sphere is invisible), edge tint for you. */
  private shieldUp(v: SpellVisual, sp: SpellDef, caster: Anchor): void {
    const p = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, p)) return;
    this.at(p.x, p.y, p.z, () => R.shieldBurst(this.prims, v, p.x, p.y, p.z, false));
    const dur = Math.max(1, sp.durationMs / 1000);
    const t0 = fxTime();
    const c = R.cols(v.palette);
    const halo = sp.heal > 0;
    if (caster === 'self') {
      this.selfShield = { v, until: t0 + dur, o: null };
      if (!halo) screenTint(c.main, 0.22);
    }
    const h = this.prims.holdShell();
    (h.s.mat.uniforms.uColor.value as THREE.Color).copy(c.main);
    h.s.mat.uniforms.uHex.value = halo ? 0 : 1;
    const key = this.keyOf(caster);
    const o: Ongoing = {
      until: t0 + dur,
      tick: (t, dt) => {
        if (!alive(h) || !this.anchorPos(caster, p)) return false;
        const age = t - t0;
        const k = Math.min(1, age * 4) * Math.min(1, (t0 + dur - t) * 3);
        if (halo) {
          // a golden ring over the head and motes rising
          h.s.mesh.position.set(p.x, p.y + 2.15, p.z);
          h.s.mesh.scale.set(0.45, 0.06, 0.45);
          h.s.mat.uniforms.uOpacity.value = 0.9 * k;
          this.at(p.x, p.y, p.z, () => R.haloEmit(v, p.x, p.y, p.z, dt));
        } else {
          h.s.mesh.position.set(p.x, p.y + 1, p.z);
          h.s.mesh.scale.setScalar(1.15 + Math.sin(age * 3) * 0.02);
          h.s.mat.uniforms.uOpacity.value = 0.8 * k;
        }
        h.s.mat.uniforms.uTime.value = t;
        return true;
      },
      end: () => {
        this.prims.release(h);
        if (key !== null && this.shells.get(key)?.o === o) this.shells.delete(key);
        if (caster === 'self' && this.selfShield?.o === o) {
          this.selfShield = null;
          screenTint(null);
        }
      },
    };
    if (caster === 'self' && this.selfShield) this.selfShield.o = o;
    if (key !== null && !halo) this.shells.set(key, { o, v });
    this.push(o);
  }

  /** CR 022: absorbing shells by caster (another player's breaks on Event 219 like yours). */
  private readonly shells = new Map<CasterKey, { o: Ongoing; v: SpellVisual }>();

  /** CR 022: another player's shield broke (Event 219 value 0 to observers): the shell bursts, as yours does. */
  shieldBroken(casterId: number): void {
    const s = this.shells.get(casterId);
    if (!s) return;
    this.shells.delete(casterId);
    s.o.until = 0;
    const p = { x: 0, y: 0, z: 0 };
    if (this.anchorPos(casterId, p)) this.at(p.x, p.y, p.z, () => R.shieldBurst(this.prims, s.v, p.x, p.y, p.z, true));
  }

  /** Event 219: your shield's points (0 = broken). */
  shieldPoints(points: number): void {
    if (points > 0 || !this.selfShield) return;
    const v = this.selfShield.v;
    this.selfShield.until = 0;
    screenTint(null);
    const p = localPlayer.pos;
    R.shieldBurst(this.prims, v, p.x, p.y, p.z, true);
    if (this.selfShield.o) this.selfShield.o.until = 0;
  }

  // ── Projectiles ───────────────────────────────────────────────────────────

  /**
   * A flying spell. Your own (local) start at the off hand and are ended by
   * the runtime (projectileEnd); remote and enemy shots test the ground and
   * bodies here. Returns a handle.
   */
  projectile(sp: SpellDef | null, x: number, y: number, z: number, vx: number, vy: number, vz: number, gravity: number, radius: number, life: number, o: { local?: boolean; collide?: Proj['collide']; explode?: number; pierce?: boolean; spread?: boolean; family?: Family; kind?: 'enemy' | 'arrow'; homing?: boolean; hand?: V3 | null; visual?: SpellVisual } = {}): number {
    this.counts.shots++;
    let s = this.projs.find((p) => !p.on);
    if (!s) {
      s = this.projs[0];
      for (const p of this.projs) if (p.t0 < s.t0) s = p;
      this.endProj(s, 'expire');
    }
    // playtest 2 shared basic attacks: a weapon's shot brings its own visual (weaponShot.ts), the same for every viewer
    const v = sp ? spellVisual(sp) : (o.visual ?? enemyVisual(o.family ?? 'steel', o.kind ?? 'enemy'));
    s.on = true;
    s.handle = handles++;
    s.v = v;
    s.x0 = x;
    s.y0 = y;
    s.z0 = z;
    s.vx = vx;
    s.vy = vy;
    s.vz = vz;
    s.g = gravity;
    s.t0 = fxTime();
    s.life = life;
    s.core = Math.max(0.1, Math.min(radius * 0.4, 0.42));
    s.local = !!o.local;
    s.collide = o.collide ?? 'none';
    s.explode = o.explode ?? 0;
    s.pierce = !!o.pierce;
    s.spread = !!o.spread;
    s.lastHit = 0;
    s.spin = Math.random() * 6;
    s.hs = null;
    // CR 020: a remote seeking shot steers itself (your own are moved by the runtime: projectileMove).
    const hp = o.homing && !o.local && sp ? homingParams(sp) : null;
    if (hp) s.hs = { p: hp, s: { x, y, z, vx, vy, vz, age: 0, state: 0 }, lock: 0, acc: 0, last: fxTime() };
    const c = R.cols(v.palette);
    // Look: shared geometry and cached materials (nothing allocated per shot).
    const m = s.mesh;
    m.quaternion.identity();
    m.rotation.set(0, 0, 0);
    switch (v.look) {
      case 'needle':
      case 'lance':
        m.geometry = GEO.needle;
        m.material = coreMat(c.hotH);
        m.scale.set(s.core * 0.9, s.core * (v.look === 'lance' ? 2.4 : 1.6), s.core * 0.9);
        break;
      case 'shard':
        m.geometry = GEO.octa;
        m.material = coreMat(c.mainH);
        m.scale.set(s.core * 0.8, s.core * 1.5, s.core * 0.8);
        break;
      case 'void':
        m.geometry = GEO.sphere;
        m.material = coreMat(col('#0a0014'));
        m.scale.setScalar(s.core);
        break;
      case 'boulder':
        m.geometry = GEO.dodeca;
        m.material = boulderMat();
        m.scale.set(s.core * 1.6, s.core * 1.4, s.core * 1.6);
        break;
      case 'seed':
        m.geometry = GEO.icosa1;
        m.material = coreMat(c.main);
        m.scale.setScalar(s.core * 0.9);
        break;
      case 'crescent':
        m.geometry = GEO.crescent;
        m.material = coreMat(c.hotH);
        m.scale.setScalar(s.core * 1.6);
        break;
      default:
        m.geometry = GEO.sphereLow;
        m.material = coreMat(c.hotH);
        m.scale.setScalar(s.core * 0.8);
    }
    s.sx = m.scale.x;
    s.sy = m.scale.y;
    s.sz = m.scale.z;
    s.halo.material = haloMat(v.look === 'void' ? c.main : c.mainH, v.look === 'shard' ? 0.5 : 0.85);
    s.halo.visible = v.look !== 'boulder';
    m.visible = true;
    // Shots leave the caster's hand: the visual starts there and eases onto
    // the true (eye-level) path over ~0.15 s. Yours from your hand, another
    // player's from theirs (CR 022: the same path shape for both).
    if (s.local && this.camera) {
      this.selfHand(tmpV);
      s.ox = tmpV.x - x;
      s.oy = tmpV.y - y;
      s.oz = tmpV.z - z;
    } else if (o.hand) {
      s.ox = o.hand.x - x;
      s.oy = o.hand.y - y;
      s.oz = o.hand.z - z;
    } else s.ox = s.oy = s.oz = 0;
    s.px = x + s.ox;
    s.py = y + s.oy;
    s.pz = z + s.oz;
    // One pooled light per big single shot (spreads and small ones rely on the glow).
    s.light = !s.spread && v.weight !== 'minor' && v.look !== 'boulder' ? this.prims.holdLight(c.main, 14, 10) : null;
    // Muzzle burst a little ahead of the hand (particles fade within 2 m of the lens).
    const sp1 = Math.hypot(vx, vy, vz) || 1;
    const dir = { x: vx / sp1, y: vy / sp1, z: vz / sp1 };
    const ahead = s.local && !view.third ? 1.4 : 0.2; // first person: past the lens fade
    this.at(x, y, z, () => R.muzzle(this.prims, v, s!.px + dir.x * ahead, s!.py + dir.y * ahead, s!.pz + dir.z * ahead, dir, s!.spread ? 0.6 : 1 + Math.min(1, s!.core * 2)));
    if (s.local) {
      this.hand.color.copy(c.mainH);
      this.hand.pulse = 1;
    }
    return s.handle;
  }

  /** Event 1990 (CR 056): the zone ended an enemy shot against a wall, rock or the ground: the drawn shot nearest to the impact stops there. */
  enemyShotWall(x: number, y: number, z: number): void {
    const i = shotAtWall(this.projs.map((p) => ({ on: p.on, local: p.local, collide: p.collide, x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z })), x, y, z);
    if (i < 0) return;
    const s = this.projs[i];
    s.px = x;
    s.py = y;
    s.pz = z;
    this.endProj(s, 'ground');
  }

  /** The runtime's own shot ended (hit, ground, range): impact there (an explosion when `explode` > 0). */
  projectileEnd(handle: number, x: number, y: number, z: number, kind: R.ImpactKind, explode = 0): void {
    const s = this.projs.find((p) => p.on && p.handle === handle);
    if (!s) return;
    s.px = x;
    s.py = y;
    s.pz = z;
    if (explode > 0) s.explode = explode;
    this.endProj(s, kind);
  }

  /** A piercing local shot passed through a target: impact without ending. */
  projectileHit(handle: number, x: number, y: number, z: number): void {
    const s = this.projs.find((p) => p.on && p.handle === handle);
    if (!s) return;
    this.impactAt(s.v, x, y, z, s, 'hit');
  }

  private impactAt(v: SpellVisual, x: number, y: number, z: number, s: Proj | null, kind: R.ImpactKind): void {
    this.counts.impacts++;
    let dir: V3 | null = null;
    if (s) {
      const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
      dir = { x: s.vx / sp, y: s.vy / sp, z: s.vz / sp };
    }
    const weight = s?.spread ? 0.5 : Math.min(1.6, 0.6 + (s?.core ?? 0.2) * 1.6 + (v.weight === 'major' ? 0.3 : v.weight === 'ultimate' ? 0.6 : 0));
    this.at(x, y, z, () => R.impact(this.prims, v, x, y, z, dir, weight, kind, camPos));
  }

  private endProj(s: Proj, kind: R.ImpactKind): void {
    if (!s.on) return;
    s.on = false;
    s.mesh.visible = false;
    s.halo.visible = false;
    this.prims.releaseLight(s.light);
    s.light = null;
    if (s.explode > 0 && s.spread && kind !== 'expire') {
      // CR 020: a stream's bursting shot (bubbles, hail) pops small: 8-15 of these a second.
      const v = s.v;
      const x = s.px;
      const y = s.py;
      const z = s.pz;
      this.at(x, y, z, () => {
        R.impact(this.prims, v, x, y, z, null, 0.7, 'hit', camPos);
        R.ringBurst(x, y + 0.1, z, s.explode * 0.6, R.cols(v.palette).k('hm'), 6, 2, { life: [0.15, 0.3], size: [0.04, 0.08] });
      });
    } else if (s.explode > 0 && kind !== 'expire') {
      const v = s.v;
      const x = s.px;
      const y = s.py;
      const z = s.pz;
      this.at(x, y, z, () => R.explosion(this.prims, v, x, y, z, s.explode, camPos));
    } else this.impactAt(s.v, s.px, s.py, s.pz, s, kind);
  }

  /** CR 020: rebase a projectile onto a new position and velocity (homing: the closed-form flight restarts here). */
  private rebase(s: Proj, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const age = Math.max(0, t - s.t0);
    const k = Math.exp(-age / 0.07);
    s.ox *= k;
    s.oy *= k;
    s.oz *= k;
    s.x0 = x;
    s.y0 = y;
    s.z0 = z;
    s.vx = vx;
    s.vy = vy;
    s.vz = vz;
    s.g = 0;
    s.life = Math.max(0.05, s.life - age);
    s.t0 = t;
  }

  /** CR 020: your seeking shot's position from the runtime's homing step (the path the zone re-flies). */
  projectileMove(handle: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const s = this.projs.find((p) => p.on && p.handle === handle);
    if (s) this.rebase(s, fxTime(), x, y, z, vx, vy, vz);
  }

  /** CR 020: a remote seeking shot steps the shared homing simulation against the drawn enemies. */
  private steer(s: Proj, t: number): void {
    const h = s.hs!;
    h.acc += Math.max(0, t - h.last);
    h.last = t;
    let n = Math.floor(h.acc / SIM_DT + 1e-9);
    h.acc -= n * SIM_DT;
    n = Math.min(n, 6);
    for (let i = 0; i < n; i++) {
      const hs = h.s;
      if (hs.state === 0 && hs.age >= h.p.delay) {
        let bd = Infinity;
        for (const v of drawnRemotes.views) {
          if ((v.kind !== 2 && v.kind !== 6) || v.healthPct <= 0) continue;
          const c = { x: v.x, y: v.y + enemyInfo(v).height, z: v.z };
          if (!canAcquire(hs, c, h.p)) continue;
          const d = Math.hypot(c.x - hs.x, c.y - hs.y, c.z - hs.z);
          if (d < bd) {
            bd = d;
            h.lock = v.id;
          }
        }
        if (h.lock) hs.state = 1;
      }
      const tv = hs.state === 1 ? this.viewById.get(h.lock) : undefined;
      homingStep(hs, tv && tv.healthPct > 0 ? { x: tv.x, y: tv.y + enemyInfo(tv).height, z: tv.z } : null, h.p);
    }
    if (n > 0) this.rebase(s, t, h.s.x, h.s.y, h.s.z, h.s.vx, h.s.vy, h.s.vz);
  }

  private updateProjs(t: number): void {
    for (const s of this.projs) {
      if (!s.on) continue;
      if (s.hs) this.steer(s, t);
      const age = t - s.t0;
      if (age >= s.life + (s.local ? 0.5 : 0)) {
        this.endProj(s, s.explode > 0 ? 'ground' : 'expire');
        continue;
      }
      const k = Math.exp(-age / 0.07);
      const x = s.x0 + s.vx * age + s.ox * k;
      const y = s.y0 + s.vy * age - 0.5 * s.g * age * age + s.oy * k;
      const z = s.z0 + s.vz * age + s.oz * k;
      if (s.collide !== 'none') {
        const gy = this.prims.heightAt(x, z, y);
        if (y < gy) {
          s.px = x;
          s.py = gy + 0.05;
          s.pz = z;
          this.endProj(s, 'ground');
          continue;
        }
        if (this.bodyHit(s, x, y, z, t)) continue;
      }
      const vy = s.vy - s.g * age;
      const sp = Math.hypot(s.vx, vy, s.vz) || 1;
      const m = s.mesh;
      m.position.set(x, y, z);
      if (s.v.look === 'needle' || s.v.look === 'lance') m.quaternion.setFromUnitVectors(UP, tmpV2.set(s.vx / sp, vy / sp, s.vz / sp));
      else if (s.v.look === 'shard') {
        m.rotation.x = age * 4.5 + s.spin;
        m.rotation.z = age * 3.1;
      } else if (s.v.look === 'boulder') {
        m.rotation.x = -age * 3;
        m.rotation.z = age * 2;
      } else if (s.v.look === 'crescent') {
        tmpQ.setFromUnitVectors(UP, tmpV2.set(s.vx / sp, vy / sp, s.vz / sp));
        m.quaternion.setFromAxisAngle(UP, age * 18 + s.spin).premultiply(tmpQ);
      } else if (s.v.look === 'seed') m.rotation.y = age * 6;
      // Readability: shrink the glow while the shot is still at the lens. Playtest 2 calm kills: the
      // core too (it is gone within 0.7 m and full from 2.5 m): your own shot leaves your hand and
      // eases onto the eye line, so for a frame or two its HDR core filled a third of the view (a
      // fireball) or flashed a white shape by the crosshair (every wand bolt, 12-15 a second in a stream).
      const d = Math.hypot(x - camPos.x, y - camPos.y, z - camPos.z);
      const nearK = Math.min(1, Math.max(0, (d - 0.7) / 1.8));
      const coreK = nearK * nearK;
      m.scale.set(s.sx * coreK, s.sy * coreK, s.sz * coreK);
      m.visible = coreK > 0.01;
      const flicker = s.v.family === 'fire' ? 1 + Math.sin(age * 31) * 0.12 + Math.sin(age * 13) * 0.08 : 1 + Math.sin(age * 9) * 0.06;
      const hs = s.core * (s.v.look === 'void' ? 4.5 : s.v.look === 'needle' || s.v.look === 'lance' ? 2.8 : 3.4) * flicker * nearK;
      s.halo.position.set(x, y, z);
      s.halo.scale.set(hs, hs, 1);
      if (s.light && alive(s.light)) s.light.s.light.position.set(x, y, z);
      if (d < FAR && d > 1.6) {
        budget.scale = d < 20 ? 1 : Math.max(0.35, 1 - (d - 20) / 60);
        R.trail(s.v, tmpV.set(s.px, s.py, s.pz), tmpV2.set(x, y, z), s.core, s.spread ? 0.45 : 1);
        if (s.v.look === 'ball' && Math.random() < 0.35) this.prims.bolt(x, y, z, x + rand(-1.5, 1.5) * s.core * 2, y + rand(-1, 1) * s.core * 2, z + rand(-1.5, 1.5) * s.core * 2, R.cols(s.v.palette).main, { width: 0.04, duration: 0.1, forks: 0, segs: 4, jitter: 0.3 });
        budget.scale = 1;
      }
      s.px = x;
      s.py = y;
      s.pz = z;
    }
  }

  /** Remote / enemy shot against bodies (visual only). True when it ended. */
  private bodyHit(s: Proj, x: number, y: number, z: number, t: number): boolean {
    if (s.collide === 'players') {
      const p = localPlayer.pos;
      if (Math.hypot(p.x - x, p.z - z) < 0.6 + s.core && y > p.y && y < p.y + 2) {
        s.px = x;
        s.py = y;
        s.pz = z;
        this.endProj(s, 'hit');
        return true;
      }
    }
    for (const v of drawnRemotes.views) {
      const isEnemy = v.kind === 2 || v.kind === 6;
      if ((s.collide === 'enemies') !== isEnemy || v.healthPct <= 0) continue;
      const info = isEnemy ? enemyInfo(v) : null;
      const rad = (info?.radius ?? 0.45) + s.core + 0.2;
      const h = info ? info.height * 2 : 1.9;
      if (Math.hypot(v.x - x, v.z - z) > rad || y < v.y - 0.2 || y > v.y + h + 0.2) continue;
      if (s.pierce) {
        if (t - s.lastHit > 0.15) {
          s.lastHit = t;
          this.impactAt(s.v, x, y, z, s, 'hit');
        }
        return false;
      }
      s.px = x;
      s.py = y;
      s.pz = z;
      this.endProj(s, 'hit');
      return true;
    }
    return false;
  }

  // ── Hits, beams, chains ───────────────────────────────────────────────────

  /** A predicted / confirmed hit on a body: the spell's element burst, or steel sparks for weapons. */
  hit(sp: SpellDef | null, x: number, y: number, z: number, o: { tint?: string | null; heavy?: boolean } = {}): void {
    if (sp) {
      const v = spellVisual(sp);
      this.at(x, y, z, () => R.impact(this.prims, v, x, y, z, null, v.weight === 'minor' ? 0.8 : 1.2, 'hit', camPos));
    } else this.at(x, y, z, () => R.meleeHit(this.prims, x, y, z, o.tint ? hot(o.tint, 1.5) : null, !!o.heavy));
  }

  /**
   * A beam tick (hitscan: one flash; beam: called every tick with the same
   * `id`, which keeps one beam alive and re-aims it). `from` = 'self' uses
   * your off hand.
   */
  beam(id: string, sp: SpellDef, from: Anchor | V3, to: V3, durationMs: number): void {
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    const existing = this.beams.get(id);
    const t = fxTime();
    if (existing && alive(existing.h)) {
      existing.to.x = to.x;
      existing.to.y = to.y;
      existing.to.z = to.z;
      existing.until = Math.max(existing.until, t + durationMs / 1000);
      return;
    }
    const ultimate = v.weight === 'ultimate' || sp.damage >= 150;
    const isChain = sp.chain > 0 || v.family === 'lightning';
    const width = sp.type === 'beam' ? 0.22 : ultimate ? 0.5 : 0.14;
    const h = this.prims.holdBeam();
    const m = h.s.mat;
    (m.uniforms.uColor.value as THREE.Color).copy(v.family === 'void' || v.family === 'dark' ? c.main : c.mainH);
    (m.uniforms.uCore.value as THREE.Color).copy(c.hotH);
    m.uniforms.uNoise.value = ultimate || sp.type === 'beam' ? 0.55 : 0.25;
    m.uniforms.uScroll.value = ultimate ? 10 : 6;
    const st = { h, to: { x: to.x, y: to.y, z: to.z }, until: t + durationMs / 1000 };
    this.beams.set(id, st);
    const a = { x: 0, y: 0, z: 0 };
    const resolveFrom = (): boolean => {
      if (from === 'self') {
        this.selfHand(tmpV);
        a.x = tmpV.x;
        a.y = tmpV.y;
        a.z = tmpV.z;
        return true;
      }
      if (typeof from === 'number') {
        const p = { x: 0, y: 0, z: 0 };
        if (!this.anchorPos(from, p)) return false;
        const vv = this.viewById.get(from);
        this.remoteHand(p.x, p.y, p.z, vv?.yaw ?? 0, a, from, vv?.pitch ?? 0);
        return true;
      }
      a.x = from.x;
      a.y = from.y;
      a.z = from.z;
      return true;
    };
    resolveFrom();
    let bolt: Held<ReturnType<FxPrims['bolt']>['s']> | null = null;
    if (isChain) bolt = this.prims.bolt(a.x, a.y, a.z, to.x, to.y, to.z, c.main, { width: sp.type === 'beam' ? 0.09 : 0.07, duration: durationMs / 1000 + 0.1, forks: 3 });
    // One-shot bursts at both ends, and the set pieces.
    const dir = tmpV2.set(to.x - a.x, to.y - a.y, to.z - a.z).normalize();
    const d0 = { x: dir.x, y: dir.y, z: dir.z };
    this.at(a.x, a.y, a.z, () => R.muzzle(this.prims, v, a.x + (from === 'self' ? d0.x * 1.4 : 0), a.y + (from === 'self' ? d0.y * 1.4 : 0), a.z + (from === 'self' ? d0.z * 1.4 : 0), d0, ultimate ? 2.2 : 1));
    this.at(to.x, to.y, to.z, () => {
      R.impact(this.prims, v, to.x, to.y, to.z, d0, ultimate ? 1.6 : 1, 'hit', camPos);
      if (ultimate) this.beamSetPiece(v, a, to);
    });
    const t0 = t;
    this.push({
      until: Infinity,
      tick: (now, dt) => {
        if (!alive(h)) return false;
        if (now >= st.until) return false;
        if (!resolveFrom()) return false;
        const age = now - t0;
        const total = Math.max(0.05, st.until - t0);
        const life = Math.max(0, 1 - age / total);
        const flare = sp.type === 'beam' ? 0.8 + Math.sin(now * 30) * 0.1 : age < 0.05 ? 1.25 : 0.25 + life * 0.85;
        this.prims.placeBeam(h.s, a.x, a.y, a.z, st.to.x, st.to.y, st.to.z, width * flare);
        m.uniforms.uTime.value = now;
        m.uniforms.uOpacity.value = sp.type === 'beam' ? Math.min(1, age * 8) * Math.min(1, (st.until - now) * 6) : Math.pow(life, 1.4);
        h.s.mesh.visible = !isChain || sp.type === 'beam';
        if (bolt && alive(bolt)) {
          bolt.s.ax = a.x;
          bolt.s.ay = a.y;
          bolt.s.az = a.z;
          bolt.s.bx = st.to.x;
          bolt.s.by = st.to.y;
          bolt.s.bz = st.to.z;
        }
        // Channelled beams: sparks and smoke where they bite.
        if (sp.type === 'beam') {
          budget.scale = this.lod(st.to.x, st.to.y, st.to.z);
          if (budget.scale > 0) R.beamBite(v, st.to.x, st.to.y, st.to.z);
          budget.scale = 1;
        }
        void dt;
        return true;
      },
      end: () => {
        this.prims.release(h);
        this.beams.delete(id);
      },
    });
  }
  private readonly beams = new Map<string, { h: Held<BeamSlot>; to: V3; until: number }>();

  /** Hitscan ultimates: a column from the sky, a lingering trail, spikes at the target. */
  private beamSetPiece(v: SpellVisual, a: V3, to: V3): void {
    const c = R.cols(v.palette);
    this.prims.light(to.x, to.y, to.z, c.main, 60, 14, 0.5);
    this.prims.flash(to.x, to.y, to.z, c.hotH, { size: 5, duration: 0.3 });
    R.lineEmit(a, to, c.k('hma'), 3.5, { life: [0.4, 0.9], size: [0.06, 0.14], speed: [0.3, 1.5], shape: SHAPE_SPARK, drag: 1.5, jitter: 0.4 });
    const gy = this.prims.heightAt(to.x, to.z, to.y);
    switch (v.setPiece) {
      case 'god_ray':
      case 'divine_judgement': {
        // A pillar of light from the sky onto the target.
        const h = this.prims.holdBeam();
        const m = h.s.mat;
        (m.uniforms.uColor.value as THREE.Color).copy(c.mainH);
        (m.uniforms.uCore.value as THREE.Color).copy(c.hotH);
        this.prims.placeBeam(h.s, to.x, gy, to.z, to.x, gy + 40, to.z, 1.4);
        const t0 = fxTime();
        this.push({
          until: t0 + 0.9,
          tick: (t) => {
            const k = (t - t0) / 0.9;
            m.uniforms.uTime.value = t;
            m.uniforms.uOpacity.value = Math.pow(1 - k, 1.5);
            h.s.mesh.scale.x = h.s.mesh.scale.z = 1.4 * (1 - k * 0.6);
            return alive(h);
          },
          end: () => this.prims.release(h),
        });
        R.burst(to.x, gy + 0.3, to.z, c.k('ha'), 60, { speed: [4, 12], life: [0.3, 0.8], size: [0.05, 0.1], gravity: -10, shape: SHAPE_SPARK, up: 0.4 });
        this.prims.ring(to.x, gy, to.z, c.hot, { radius: 4, duration: 0.6, width: 0.05 });
        this.prims.scorch(to.x, gy, to.z, 1.6, 5, 0.5);
        screenKick(to.x, to.y, to.z, 0.9, camPos, 0.45);
        break;
      }
      case 'null_gaze':
        R.lineEmit(a, to, c.k('s'), 1.2, { life: [1.2, 2.2], size: [0.5, 0.9], shape: SHAPE_PUFF, speed: [0.1, 0.5], drag: 1 });
        screenKick(to.x, to.y, to.z, 0.6, camPos, 0.35);
        break;
      case 'the_monolith':
      case 'verdant_lance':
        this.prims.spikeCluster(v.spike, to.x, to.z, gy, 1.0, 9, 3.2, { hold: 0.9 });
        this.prims.spikeRing(v.spike, to.x, to.z, gy, 2.2, 12, 1.6, { hold: 0.8, delay: 0.05 });
        screenKick(to.x, to.y, to.z, 0.8, camPos, 0.4);
        break;
      case 'heavens_exhale':
        R.lineEmit(a, to, c.k('s'), 1.5, { life: [0.6, 1], size: [0.5, 0.9], shape: SHAPE_PUFF, speed: [1, 3], drag: 2 });
        R.ringBurst(to.x, gy + 0.3, to.z, 0.5, c.k('hm'), 60, 10, { life: [0.3, 0.5], size: [0.04, 0.07], shape: SHAPE_SPARK, drag: 2, up: 1 });
        screenKick(to.x, to.y, to.z, 0.7, camPos, 0.4);
        break;
      default:
        screenKick(to.x, to.y, to.z, 0.5, camPos, 0.3);
    }
  }

  /** One chain-lightning hop between two bodies. */
  chain(sp: SpellDef, a: V3, b: V3): void {
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    this.at(b.x, b.y, b.z, () => {
      this.prims.bolt(a.x, a.y, a.z, b.x, b.y, b.z, c.main, { width: 0.07, duration: 0.3, forks: 2 });
      R.impact(this.prims, v, b.x, b.y, b.z, null, 0.9, 'hit', camPos);
    });
  }

  // ── Areas, domains, runes, target spells ──────────────────────────────────

  /**
   * An area spell resolves: the burst (circle, cone, line), then for
   * lingering ones a zone floor emitting for `durationMs` (following the
   * caster when `follow` is given: self-cast auras, domains).
   */
  area(sp: SpellDef, x: number, y: number, z: number, shape: R.AreaShape, durationMs: number, follow: Anchor | null): void {
    const v = spellVisual(sp);
    if (sp.type === 'domain') return this.domain(v, sp, x, y, z, durationMs, follow);
    this.at(x, y, z, () => R.areaBurst(this.prims, v, x, y, z, shape, camPos), v.weight === 'ultimate' ? 1.4 : 1);
    if (durationMs > 0 && shape.cone === 0 && shape.line === 0) this.zone(v, x, y, z, shape.radius, durationMs, follow);
  }

  private zone(v: SpellVisual, x: number, y: number, z: number, r: number, ms: number, follow: Anchor | null): void {
    const h = this.prims.holdZone();
    const c = R.cols(v.palette);
    const m = h.s.mat as ZoneMat;
    // Rich floors (deep -> main), never white: they lie under enemies and telegraphs.
    (m.uniforms.uColor.value as THREE.Color).copy(c.deep);
    (m.uniforms.uColor2.value as THREE.Color).copy(v.family === 'void' || v.family === 'dark' ? c.accent : c.main);
    m.uniforms.uStyle.value = ZONE_STYLE[v.family];
    m.uniforms.uScale.value = Math.max(2, r * 0.8);
    m.uniforms.uSector.value = 0;
    m.uniforms.uLine.value = 0;
    const p = { x, y, z };
    this.prims.conform(h.s.mesh, x, y, z, r, r, 0, 0.12);
    const t0 = fxTime();
    const dur = ms / 1000;
    let relaid = t0;
    this.push({
      until: t0 + dur,
      tick: (t, dt) => {
        if (!alive(h)) return false;
        if (follow !== null) {
          if (!this.anchorPos(follow, p)) return false;
          // re-lay the floor on the terrain as the caster moves (at most 5 Hz)
          if (t - relaid > 0.2 && Math.hypot(p.x - h.s.mesh.position.x, p.z - h.s.mesh.position.z) > 0.3) {
            relaid = t;
            this.prims.conform(h.s.mesh, p.x, p.y, p.z, r, r, 0, 0.12);
          }
        }
        const age = t - t0;
        m.uniforms.uTime.value = t;
        m.uniforms.uOpacity.value = (r > 6 ? 0.35 : 0.55) * Math.min(1, age * 4) * Math.min(1, (t0 + dur - t) * 2);
        const l = this.lod(p.x, p.y, p.z);
        if (l > 0) {
          budget.scale = l;
          R.zoneEmit(this.prims, v, p.x, p.y, p.z, r, dt);
          budget.scale = 1;
        }
        return true;
      },
      end: () => this.prims.release(h),
    });
  }

  private domain(v: SpellVisual, sp: SpellDef, x: number, y: number, z: number, ms: number, follow: Anchor | null): void {
    const r = sp.radius;
    const c = R.cols(v.palette);
    this.at(x, y, z, () => R.domainOpen(this.prims, v, x, y, z, r, camPos), 1.4);
    this.zone(v, x, y, z, r, ms, follow);
    const h = this.prims.holdDome();
    const m = h.s.mat;
    (m.uniforms.uColor.value as THREE.Color).copy(v.family === 'void' || v.family === 'dark' ? c.deep : c.main);
    (m.uniforms.uColor2.value as THREE.Color).copy(v.family === 'void' || v.family === 'dark' ? c.main : c.accent);
    m.uniforms.uStyle.value = DOME_STYLE[v.family];
    const p = { x, y, z };
    const t0 = fxTime();
    const dur = ms / 1000;
    this.push({
      until: t0 + dur,
      tick: (t, dt) => {
        if (!alive(h)) return false;
        if (follow !== null && !this.anchorPos(follow, p)) return false;
        const age = t - t0;
        h.s.mesh.position.set(p.x, p.y - 0.5, p.z);
        h.s.mesh.scale.setScalar(r);
        m.uniforms.uTime.value = t;
        m.uniforms.uReveal.value = Math.min(1, age / 0.6);
        // Readability: from inside the dome it is a faint tint, never a wall.
        const inside = Math.hypot(camPos.x - p.x, camPos.z - p.z) < r;
        m.uniforms.uOpacity.value = (inside ? 0.18 : 0.6) * Math.min(1, age * 3) * Math.min(1, (t0 + dur - t) * 1.5);
        const l = this.lod(p.x, p.y, p.z);
        if (l > 0) {
          budget.scale = l;
          R.domainEmit(this.prims, v, p.x, p.y, p.z, r, dt, age);
          budget.scale = 1;
        }
        return true;
      },
      end: () => this.prims.release(h),
    });
  }

  /** A rune laid on the ground: arms, idles, triggers on every enemy that steps in (visual). */
  rune(sp: SpellDef, x: number, y: number, z: number): void {
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    const r = sp.radius;
    const h = this.prims.holdSigil();
    const m = h.s.mat as CircleMat;
    (m.uniforms.uColor.value as THREE.Color).copy(v.family === 'void' || v.family === 'dark' || v.family === 'blood' ? c.main : c.main);
    (m.uniforms.uColor2.value as THREE.Color).copy(c.hotH);
    m.uniforms.uSides.value = v.sigil;
    m.uniforms.uSpin.value = 0.35;
    m.uniforms.uFill.value = 0.08;
    this.prims.conform(h.s.mesh, x, y, z, r, r, 0, 0.1);
    this.at(x, y, z, () => this.prims.ring(x, y, z, c.main, { radius: r * 1.2, duration: 0.4 }));
    const t0 = fxTime();
    const arm = (sp.armMs ?? 400) / 1000;
    const dur = Math.max(arm + 0.5, sp.durationMs / 1000);
    const triggered = new Set<number>();
    let lastTrigger = -1;
    this.push({
      until: t0 + dur,
      tick: (t, dt) => {
        if (!alive(h)) return false;
        const age = t - t0;
        const armed = age >= arm;
        m.uniforms.uTime.value = t;
        m.uniforms.uProgress.value = Math.min(1, age / arm);
        const flash = lastTrigger > 0 ? Math.max(0, 1 - (t - lastTrigger) / 0.4) : 0;
        m.uniforms.uOpacity.value = (armed ? 0.6 + 0.15 * Math.sin(t * 2.5) : 0.4) * Math.min(1, (t0 + dur - t) * 2) + flash;
        const l = this.lod(x, y, z);
        if (l <= 0) return true;
        budget.scale = l;
        R.runeIdle(v, x, y, z, r, dt);
        budget.scale = 1;
        if (!armed) return true;
        for (const e of drawnRemotes.views) {
          if ((e.kind !== 2 && e.kind !== 6) || e.healthPct <= 0 || triggered.has(e.id)) continue;
          if (Math.hypot(e.x - x, e.z - z) > r + enemyInfo(e).radius || Math.abs(e.y - y) > 3) continue;
          triggered.add(e.id);
          if (t - lastTrigger > 0.25) {
            lastTrigger = t;
            this.at(x, y, z, () => R.runeTrigger(this.prims, v, x, y, z, r, camPos));
          }
        }
        return true;
      },
      end: () => this.prims.release(h),
    });
  }

  /** A direct spell lands on a body at (x, y, z) feet. */
  targetHit(sp: SpellDef, x: number, y: number, z: number, height = 1.8): void {
    const v = spellVisual(sp);
    this.at(x, y, z, () => R.targetHit(this.prims, v, x, y, z, height, camPos));
  }

  /**
   * CR 022: a channelled beam (or a hitscan's flash) that follows its caster's
   * aim every frame: yours from your view, another player's from their
   * replicated aim (Event 226 while they hold it). One call for both.
   */
  channelBeam(sp: SpellDef, caster: Anchor, durationMs: number): void {
    const key = this.keyOf(caster);
    const end = this.beamTarget(sp, caster, 0, 0);
    if (!end) return;
    const id = `c${key ?? 'p'}:${sp.id}:${handles++}`;
    this.beam(id, sp, caster, end, durationMs);
    const t0 = fxTime();
    this.push({
      until: t0 + durationMs / 1000 + 0.05,
      tick: () => {
        const st = this.beams.get(id);
        if (!st) return false;
        const e = this.beamTarget(sp, caster, 0, 0);
        if (e) {
          st.to.x = e.x;
          st.to.y = e.y;
          st.to.z = e.z;
        }
        return true;
      },
    });
  }

  /** CR 022: where a caster's beam lands now (the shared aim.ts beamEnd from their eye along their aim). */
  private beamTarget(sp: SpellDef, caster: Anchor, yaw0: number, pitch0: number): V3 | null {
    const p = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, p)) return null;
    const am = this.aimNow(caster, yaw0, pitch0);
    return beamEnd({ x: p.x, y: p.y + EYE, z: p.z }, am.yaw, am.pitch, sp.range || 40, drawnRemotes.views, (x, z, ny) => this.prims.heightAt(x, z, ny)).at;
  }

  /**
   * CR 022: a weapon swing's arc in the world, for every player (yours from
   * your prediction, others' from Event 214): a bright edge sweeping the
   * move's arc at its reach during its active frames, tinted by the
   * socketed gem's element; a thrust streaks straight ahead, a spin goes
   * all the way round.
   */
  swing(caster: Anchor, moveId: number, yaw: number, gem = -1): void {
    const m = moveById.get(moveId);
    if (!m || m.speed > 0 || m.radius > 1) return;
    const family: Family = gem >= 0 ? (ELEMENT_FAMILY[gem] ?? 'steel') : 'steel';
    const c = R.cols(PALETTES[family]);
    const colors = gem >= 0 ? c.k('hm') : R.cols(PALETTES.steel).k('ha');
    const t0 = fxTime() + (m.startupSteps * STEP_MS) / 1000;
    const dur = Math.max(0.09, (m.activeSteps * STEP_MS) / 1000 + 0.04);
    const thrust = m.arc < 60;
    const spin = m.arc >= 360;
    const half = ((spin ? 360 : m.arc) * Math.PI) / 360;
    const dir = m.combo % 2 === 1 ? -1 : 1;
    const r = Math.max(1, m.reach * 0.85);
    const pos = { x: 0, y: 0, z: 0 };
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    let last = -1;
    const at = (q: number, out: V3): V3 => {
      if (thrust) {
        const d = 0.5 + (r - 0.5) * q;
        out.x = pos.x - Math.sin(yaw) * d;
        out.z = pos.z - Math.cos(yaw) * d;
        out.y = pos.y + 1.25;
        return out;
      }
      const ang = spin ? yaw - dir * Math.PI * 2 * q : yaw - dir * (half - 2 * half * q);
      out.x = pos.x - Math.sin(ang) * r;
      out.z = pos.z - Math.cos(ang) * r;
      out.y = pos.y + 1.15 + (m.kind === 'heavy' ? 0.35 * (1 - q) : 0.1 * Math.sin(q * Math.PI));
      return out;
    };
    const SWING = { life: [0.12, 0.24] as [number, number], size: [0.05, 0.1] as [number, number], speed: [0.2, 1.2] as [number, number], shape: SHAPE_SPARK, drag: 3 };
    // Playtest 2 calm kills: in first person your own arc sweeps right across the view 2-3 times a
    // second; it was a band of white-hot glow puffs. Calm: a thin, sparse streak in the steel's colour.
    // Playtest 2 shared basic attacks: someone else's arc (or yours in third person) is seen from
    // metres away and keeps more of its streak so it reads; still steel-coloured, never white-hot.
    const fp = flashProfile();
    const trail = caster === 'self' && !view.third ? fp.swingTrail : Math.max(fp.swingTrail, 0.7);
    const density = 26 * trail;
    const glowCol = fp.swingTrail < 1 ? c.main : c.hotH;
    const glowSize = 0.22 * trail;
    this.push({
      until: t0 + dur + 0.1,
      tick: (t) => {
        if (t < t0) return true;
        if (!this.anchorPos(caster, pos)) return false;
        const q = Math.min(1, (t - t0) / dur);
        const q0 = last < 0 ? 0 : last;
        if (q > q0) {
          this.at(pos.x, pos.y, pos.z, () => {
            for (let s = q0; s < q; s += 0.06) {
              at(s, a);
              at(Math.min(q, s + 0.06), b);
              R.lineEmit(a, b, colors, density, SWING);
              if (glowSize > 0.05) glowPool.emit(b.x, b.y, b.z, 0, 0, 0, glowCol, 0.09, glowSize, 0, 0, SHAPE_GLOW);
            }
          });
        }
        last = q;
        return q < 1;
      },
    });
  }

  /** CR 022: another player's weapon move from Event 214: the arc, their arrow or bolt, or their slam, on the move's own timing. */
  private remoteMove(caster: Anchor, moveId: number, yaw: number, pitch: number, charge: number): void {
    const m = moveById.get(moveId);
    if (!m) return;
    const key = this.keyOf(caster);
    if (m.speed === 0 && m.radius <= 1) return this.swing(caster, moveId, yaw, key !== null ? gemFor(key) : -1);
    const fire = () => {
      const pos = { x: 0, y: 0, z: 0 };
      if (!this.anchorPos(caster, pos)) return;
      if (m.speed > 0) {
        // the same launch as yours (runtime.launch): eye path, charged speed, the hand it leaves
        const speed = shotSpeed(m, charge);
        const pt = pitch + (m.gravity > 0 ? 0.05 : 0);
        const d = lookDir(yaw, pt);
        const hand = { x: 0, y: 0, z: 0 };
        this.remoteHand(pos.x, pos.y, pos.z, yaw, hand, typeof caster === 'number' ? caster : 0, pitch);
        // playtest 2 shared basic attacks: the bolt / arrow the attacker sees of their own shot (weaponShot.ts)
        const wk = weaponOfMove(moveId) ?? 'other';
        const visual = weaponShotVisual(wk, key !== null ? gemFor(key) : -1);
        this.projectile(null, pos.x, pos.y + SHOT_Y, pos.z, d.x * speed, d.y * speed, d.z * speed, m.gravity, weaponShotRadius(wk, m.radius), shotRange(m, charge) / Math.max(1, speed), { collide: 'enemies', kind: 'arrow', hand, visual }); // CR 033: the draw sets speed and reach
        return;
      }
      const p = sharedAimPoint({ x: pos.x, y: pos.y + EYE, z: pos.z }, yaw, pitch, m.reach, (x, z, ny) => this.prims.heightAt(x, z, ny));
      this.slam(p.x, p.y, p.z, m.radius);
    };
    const at = fxTime() + (m.startupSteps * STEP_MS) / 1000;
    this.push({ until: at, tick: () => true, end: fire });
  }

  /** Elemental form (Q): the form's shape burst plus a short aura on the caster. */
  form(f: FormDef, caster: Anchor, yaw: number): void {
    const family = ELEMENT_FAMILY[f.element] ?? 'steel';
    const v = enemyVisual(family, f.shape === 'line' ? 'line' : 'form');
    const p = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, p)) return;
    const shape: R.AreaShape = f.shape === 'cone' ? { radius: f.reach, cone: f.arc, line: 0, yaw } : f.shape === 'line' ? { radius: Math.max(0.8, f.width / 2), cone: 0, line: f.reach, yaw } : { radius: f.radius, cone: 0, line: 0, yaw };
    this.at(p.x, p.y, p.z, () => R.areaBurst(this.prims, v, p.x, p.y, p.z, shape, camPos));
    if (f.shape === 'line' && family === 'lightning') {
      const c = R.cols(v.palette);
      this.prims.bolt(p.x, p.y + 1, p.z, p.x - Math.sin(yaw) * f.reach, p.y + 1, p.z - Math.cos(yaw) * f.reach, c.main, { width: 0.1, duration: 0.35, forks: 3 });
    }
    // Aura: a shell around the caster for a moment.
    const h = this.prims.holdShell();
    const c = R.cols(v.palette);
    (h.s.mat.uniforms.uColor.value as THREE.Color).copy(c.mainH);
    h.s.mat.uniforms.uHex.value = 0;
    const t0 = fxTime();
    if (caster === 'self') {
      this.hand.color.copy(c.mainH);
      this.hand.pulse = 1.4;
    }
    this.push({
      until: t0 + 1.2,
      tick: (t, dt) => {
        if (!alive(h) || !this.anchorPos(caster, p)) return false;
        const k = (t - t0) / 1.2;
        h.s.mesh.position.set(p.x, p.y + 1, p.z);
        h.s.mesh.scale.setScalar(1 + k * 0.5);
        h.s.mat.uniforms.uOpacity.value = (1 - k) * 0.9;
        h.s.mat.uniforms.uTime.value = t;
        this.at(p.x, p.y, p.z, () => R.ringBurst(p.x, p.y + 0.1, p.z, 0.7, c.k('hma'), 40 * dt, 0, { life: [0.4, 0.7], size: [0.06, 0.12], up: 3, shape: family === 'ice' || family === 'crystal' ? 2 : SHAPE_GLOW }));
        return true;
      },
      end: () => this.prims.release(h),
    });
  }

  /** A weapon's area move (slam, plunge): a shockwave ring and dust. */
  slam(x: number, y: number, z: number, radius: number): void {
    this.at(x, y, z, () => {
      const c = R.cols(PALETTES.stone);
      this.prims.ring(x, y, z, c.main, { radius: radius * 1.2, duration: 0.45, width: 0.08 });
      R.ringBurst(x, y + 0.15, z, 0.4, c.k('sD'), 14, radius * 2, { life: [0.6, 1], size: [0.5, 0.9], shape: SHAPE_PUFF, drag: 2 });
      R.burst(x, y + 0.2, z, c.k('hmS'), 20, { speed: [3, 8], life: [0.4, 0.8], size: [0.05, 0.1], gravity: -14, shape: SHAPE_SPARK, up: 0.6 });
      screenKick(x, y, z, 0.4, camPos, 0.3);
    });
  }

  // ── Statuses (Event 206) ──────────────────────────────────────────────────

  status(targetId: number, statusId: number): void {
    const def = statusById.get(statusId);
    if (!def) return;
    let e = this.statuses.get(targetId);
    if (!e) {
      e = { id: targetId, until: new Float64Array(16), shell: null, k: 0 };
      this.statuses.set(targetId, e);
    }
    const t = fxTime();
    e.until[statusId] = t + def.durationMs / 1000;
    // the moment it lands
    const v = this.viewById.get(targetId) ?? drawnRemotes.views.find((x) => x.id === targetId);
    if (!v) return;
    const info = enemyInfo(v);
    const k = def.key;
    if (k === 'freeze' || k === 'petrify') this.at(v.x, v.y, v.z, () => this.prims.spikeRing(k === 'freeze' ? 'ice' : 'crystal', v.x, v.z, v.y, info.radius * 1.1, 7, 0.9 * info.size + 0.3, { hold: def.durationMs / 1000, sink: 0.3 }));
    if (k === 'knockback' || k === 'airborne') this.at(v.x, v.y, v.z, () => R.statusEmit(this.prims, k, v.x, v.y, v.z, info.height * 2, info.size, 0.3, t));
  }

  private updateStatuses(t: number, dt: number): void {
    const max = budget.profile.statusTargets;
    const fp = flashProfile();
    const shells = budget.tier !== 'low';
    let drawn = 0;
    for (const [id, e] of this.statuses) {
      const v = this.viewById.get(id);
      let any = false;
      // The shell: the most telling status, a soft tinted rim around the body.
      let top: string | null = null;
      for (const k of R.STATUS_PRIORITY) {
        const sid = statusByKey.get(k);
        if (sid !== undefined && e.until[sid] > t) {
          top = k;
          break;
        }
      }
      const want = shells && top && v && v.healthPct > 0 && drawn < max;
      // Playtest 2 calm kills: a stream re-applies short statuses (shock) many times a second and a
      // kill ends them: the shell eases in and out (~0.25 s) instead of switching on and off.
      e.k = want ? Math.min(1, e.k + dt * 4) : Math.max(0, e.k - dt * 4);
      if ((want || (e.k > 0 && e.shell)) && v && top) {
        if (!alive(e.shell)) e.shell = this.prims.holdShell();
        const info = enemyInfo(v);
        const sh = e.shell.s;
        const col = R.statusColor(top);
        if (col) (sh.mat.uniforms.uColor.value as THREE.Color).copy(col);
        sh.mat.uniforms.uHex.value = top === 'freeze' || top === 'petrify' ? 1 : 0;
        sh.mat.uniforms.uTime.value = t;
        // (a rim, not a wall: the enemy and its telegraph stay readable through it)
        // (and it fades when your camera is at the body: a shell 1-2 m away filled half the view)
        const camD = Math.hypot(v.x - camPos.x, v.y + info.height - camPos.y, v.z - camPos.z) - info.radius * 1.5;
        const nearK = Math.min(1, Math.max(0, (camD - 0.5) / 3));
        sh.mat.uniforms.uOpacity.value = (top === 'freeze' || top === 'petrify' ? 0.6 : 0.35) * (0.8 + 0.2 * Math.sin(t * 6 + id)) * e.k * (fp.name === 'calm' ? 0.55 : 0.8) * nearK;
        sh.mesh.position.set(v.x, v.y + info.height, v.z);
        sh.mesh.scale.set(info.radius * 1.5 + 0.1, info.height * 1.15 + 0.1, info.radius * 1.5 + 0.1);
      } else if (e.shell) {
        this.prims.release(e.shell);
        e.shell = null;
      }
      for (let s = 1; s < e.until.length; s++) {
        if (e.until[s] <= t) continue;
        any = true;
        if (!v || v.healthPct <= 0 || drawn >= max) continue;
        const l = this.lod(v.x, v.y, v.z);
        if (l <= 0) continue;
        const info = enemyInfo(v);
        const key = statusById.get(s)?.key;
        if (!key) continue;
        budget.scale = l;
        R.statusEmit(this.prims, key, v.x, v.y, v.z, info.height * 2, info.size, dt, t, fp.shockRate);
        budget.scale = 1;
      }
      if (v) drawn++;
      if (!any) {
        this.prims.release(e.shell);
        this.statuses.delete(id);
      }
    }
  }

  // ── Other players (Event 214) and enemies (205) ───────────────────────────

  /** Event 214: another player's attack / cast / form / dash started at (x, y, z) feet. */
  remoteCast(casterId: number, id: number, x: number, y: number, z: number, yaw: number, pitch: number, charge = 0): void {
    this.counts.remoteCasts++;
    // a caster we don't draw (yet): play it from the event's origin
    const caster: Anchor = this.viewById.has(casterId) ? casterId : { x, y, z };
    if (id & 0x8000) {
      const sp = mobilitySpellForDash(id & 0x7fff);
      if (sp) this.castStart(sp, caster, null, yaw);
      return;
    }
    const f = formById.get(id);
    if (f) {
      // CR 022: on its first hit frame, as yours (FORM_STARTUP_STEPS after the start).
      const at = fxTime() + (FORM_STARTUP_STEPS * STEP_MS) / 1000;
      this.push({ until: at, tick: () => true, end: () => this.form(f, caster, yaw) });
      return;
    }
    const sp = spellById.get(id);
    if (!sp) {
      if (moveById.has(id)) this.remoteMove(caster, id, yaw, pitch, charge); // CR 022: weapon moves draw for others too
      return;
    }
    this.castFrom(sp, caster, x, y, z, yaw, pitch, charge);
  }

  /** Plays a whole cast (windup, then the spell) from a caster at (x, y, z) feet: remote casts, the gallery, the bench. */
  castFrom(sp: SpellDef, caster: Anchor, x: number, y: number, z: number, yaw: number, pitch: number, charge = 0): void {
    const c0 = performance.now();
    this.castFromInner(sp, caster, x, y, z, yaw, pitch, charge);
    this.counts.maxCastMs = Math.max(this.counts.maxCastMs, performance.now() - c0);
  }

  private castFromInner(sp: SpellDef, caster: Anchor, x: number, y: number, z: number, yaw: number, pitch: number, charge = 0): void {
    const eye = { x, y: y + EYE, z };
    const aim = sp.type === 'aoe' || sp.type === 'rune' ? this.aimPoint(eye, yaw, pitch, sp.range || 30) : null;
    const tgt = sp.type === 'direct' && sp.windupMs > 0 ? this.aimTarget(eye, yaw, pitch, sp.range || 30, 12) : null;
    this.castStart(sp, caster, aim, yaw, tgt ? tgt.id : null);
    const fire = () => this.remoteResolve(sp, caster, yaw, pitch, aim, charge);
    if (sp.windupMs > 0) {
      const at = fxTime() + sp.windupMs / 1000;
      this.push({ until: at, tick: () => true, end: fire });
    } else fire();
  }

  private remoteResolve(sp: SpellDef, caster: Anchor, yaw: number, pitch: number, aim: V3 | null, charge = 0): void {
    const pos = { x: 0, y: 0, z: 0 };
    if (!this.anchorPos(caster, pos)) return;
    const casterId = typeof caster === 'number' ? caster : 0;
    const eye = { x: pos.x, y: pos.y + EYE, z: pos.z };
    const hv = casterId ? this.viewById.get(casterId) : undefined;
    const hand = this.remoteHand(pos.x, pos.y, pos.z, hv?.yaw ?? yaw, { x: 0, y: 0, z: 0 }, casterId, hv?.pitch ?? pitch);
    switch (sp.type) {
      case 'projectile':
      case 'arc': {
        const n = Math.max(1, sp.spread);
        for (let i = 0; i < n; i++) {
          const off = n > 1 ? ((i - (n - 1) / 2) * sp.spreadDeg * Math.PI) / 180 : 0;
          const yw = yaw + off;
          const pt = pitch + (sp.gravity > 0 ? 0.05 : 0);
          const cp = Math.cos(pt);
          // CR 020: a released charge flies faster and bursts wider; seekers steer themselves (steer()).
          const sm = sp.charge ? chargeMult(sp.charge.speedMult, charge) : 1;
          const rm = sp.charge ? chargeMult(sp.charge.radiusMult, charge) : 1;
          const speed = sp.speed * sm;
          const range = (sp.range || 40) * sm;
          // CR 022: the true path from the eye (as yours), the visual easing in from their hand.
          this.projectile(sp, pos.x, pos.y + SHOT_Y, pos.z, -Math.sin(yw) * cp * speed, Math.sin(pt) * speed, -Math.cos(yw) * cp * speed, sp.gravity, Math.max(0.2, Math.min(sp.radius * rm, 1.4)), range / Math.max(1, speed), { collide: 'enemies', explode: sp.radius > 1 ? sp.radius * rm : 0, pierce: sp.pierce, spread: n > 1, homing: !!sp.homing, hand });
        }
        return;
      }
      case 'orbit':
        this.orbit(sp, caster, sp.durationMs);
        return;
      case 'hitscan':
      case 'beam': {
        const t = this.aimTarget(eye, yaw, pitch, sp.range || 40, 6);
        // CR 022: it follows their aim (Event 226) for its duration, drawn like yours.
        if (typeof caster === 'number') this.channelBeam(sp, caster, sp.type === 'beam' ? sp.durationMs : 150);
        else {
          const end = t ? { x: t.x, y: t.y + enemyInfo(t).height, z: t.z } : this.aimPoint(eye, yaw, pitch, sp.range || 40);
          this.beam(`r${casterId}:${sp.id}:${handles++}`, sp, hand, end, sp.type === 'beam' ? sp.durationMs : 150);
        }
        if (t && sp.chain > 0) {
          let prev: RemoteView = t;
          const used = new Set([t.id]);
          for (let k = 0; k < sp.chain; k++) {
            let best: RemoteView | null = null;
            let bd = 8;
            for (const e of drawnRemotes.views) {
              if ((e.kind !== 2 && e.kind !== 6) || used.has(e.id) || e.healthPct <= 0) continue;
              const d = Math.hypot(e.x - prev.x, e.z - prev.z);
              if (d < bd) {
                bd = d;
                best = e;
              }
            }
            if (!best) break;
            used.add(best.id);
            this.chain(sp, { x: prev.x, y: prev.y + enemyInfo(prev).height, z: prev.z }, { x: best.x, y: best.y + enemyInfo(best).height, z: best.z });
            prev = best;
          }
        }
        return;
      }
      case 'direct': {
        const t = this.aimTarget(eye, yaw, pitch, sp.range || 30, 12);
        if (t) this.targetHit(sp, t.x, t.y, t.z, enemyInfo(t).height * 2);
        return;
      }
      case 'aoe':
      case 'domain': {
        const self = sp.selfCast || sp.type === 'domain' || sp.cone > 0 || sp.line > 0;
        const c = self ? pos : aim ?? this.aimPoint(eye, yaw, pitch, sp.range || 30);
        const shape: R.AreaShape = { radius: sp.radius, cone: sp.cone, line: sp.line, yaw };
        this.area(sp, c.x, c.y, c.z, shape, sp.durationMs, sp.selfCast || sp.type === 'domain' ? caster : null);
        return;
      }
      case 'rune': {
        const c = aim ?? this.aimPoint(eye, yaw, pitch, sp.range || 20);
        this.rune(sp, c.x, c.y, c.z);
        return;
      }
    }
  }

  /** Event 205: an enemy projectile (visual; the zone decides the hit). */
  enemyProjectile(enemyId: number, attackId: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, radius: number, range: number): void {
    const atk = enemyAttackById.get(attackId);
    const v = this.viewById.get(enemyId);
    const el = atk?.element ?? (v ? enemyInfo(v).element : 8);
    const family = ELEMENT_FAMILY[el] ?? 'steel';
    const sp = Math.max(1, Math.hypot(vx, vy, vz));
    this.projectile(null, x, y, z, vx, vy, vz, 0, Math.max(0.15, radius), range / sp, { collide: 'players', family });
  }

  // ── CR 020 mechanics: streams, charges, orbits, bursts, allies ────────────

  /** Live streams / gathering charges by caster ('self' or an entity id): what channelEnd stops. */
  private readonly channels = new Map<Anchor, Ongoing>();

  private stopChannel(key: Anchor): void {
    const o = this.channels.get(key);
    if (!o) return;
    this.channels.delete(key);
    o.until = 0; // ends on the next update (end() runs there)
  }

  /** Your stream started: the off hand glows for as long as it runs (the shots are ordinary projectiles). */
  streamStart(sp: SpellDef, caster: Anchor, seed: number): void {
    void seed;
    if (caster !== 'self') return;
    const c = R.cols(spellVisual(sp).palette);
    this.hand.color.copy(c.mainH);
    this.hand.pulse = 1;
    this.hand.charge = 0.6;
    this.hand.chargeUntil = fxTime() + 600;
  }

  /** A stream or charge ended (yours: 'self'). */
  channelEnd(caster: Anchor, sp: SpellDef | null): void {
    void sp;
    if (caster === 'self') this.hand.chargeUntil = 0;
    this.stopChannel(caster);
  }

  /** Event 223 value 0 for another player. */
  remoteChannelEnd(casterId: number): void {
    this.stopChannel(casterId);
  }

  /** A charge gathering at the caster's hand: a growing knot of the element until release (or 6 s). */
  chargeStart(sp: SpellDef, caster: Anchor): void {
    this.stopChannel(caster);
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    const t0 = fxTime();
    const max = (sp.charge?.maxMs ?? 1000) / 1000;
    if (caster === 'self') {
      this.hand.color.copy(c.mainH);
      this.hand.charge = 0;
      this.hand.chargeUntil = t0 + 6;
    }
    const pos = { x: 0, y: 0, z: 0 };
    const o: Ongoing = {
      until: t0 + 6,
      tick: (t, dt) => {
        const k = Math.min(1, (t - t0) / max);
        if (caster === 'self') {
          if (!this.camera) return true;
          this.selfHand(tmpV);
          this.camera.getWorldDirection(tmpV2);
          pos.x = tmpV.x + tmpV2.x * 0.6;
          pos.y = tmpV.y + tmpV2.y * 0.6 + 0.05;
          pos.z = tmpV.z + tmpV2.z * 0.6;
        } else {
          const v0 = this.viewById.get(caster as number);
          if (!v0) return false;
          this.remoteHand(v0.x, v0.y, v0.z, v0.yaw, pos, v0.id, v0.pitch);
        }
        this.at(pos.x, pos.y, pos.z, () => R.charge(v, pos.x, pos.y, pos.z, 0.15 + 0.45 * k, Math.max(1, Math.round((2 + 4 * k) * dt * 60))));
        if (k >= 1 && Math.random() < 0.3) R.burst(pos.x, pos.y, pos.z, [c.hotH, c.mainH], 2, { speed: [0.5, 1.5], life: [0.15, 0.3], size: [0.05, 0.1] });
        return true;
      },
      end: () => {
        if (caster === 'self') this.hand.chargeUntil = 0;
      },
    };
    this.channels.set(caster, o);
    this.push(o);
  }

  /**
   * Event 223 value 1: another player's stream, simulated from its seed:
   * one shot per interval from their hand along their drawn aim (leaning by
   * the same jitter the caster's shots do), or falling around their aim
   * point for rain, until Event 223 value 0 (or 30 s).
   */
  remoteStream(casterId: number, sp: SpellDef, x: number, y: number, z: number, yaw0: number, pitch0: number, seed: number, firstShot = 0): void {
    this.stopChannel(casterId);
    const a = sp.auto;
    if (!a) return;
    const every = (a.intervalSteps * STEP_MS) / 1000;
    // CR 022: an observer who arrives mid-stream (Event 226) starts at the next shot index of the same seed.
    const t0 = fxTime() - firstShot * every;
    let k = firstShot;
    const hand = { x: 0, y: 0, z: 0 };
    const o: Ongoing = {
      until: t0 + 30,
      tick: (t) => {
        const v0 = this.viewById.get(casterId);
        const px = v0?.x ?? x;
        const py = v0?.y ?? y;
        const pz = v0?.z ?? z;
        // CR 022: their replicated aim (Event 226, 10 Hz, eased by their drawn look between updates).
        const am = castState.aimOf(casterId, v0?.yaw ?? yaw0, v0?.pitch ?? pitch0, performance.now());
        const yaw = am.yaw;
        const pitch = am.pitch;
        let n = 0;
        while (t0 + k * every <= t && n < 3) {
          n++;
          const kk = k++;
          if (this.lod(px, py, pz) <= 0) continue;
          const radius = Math.max(0.12, Math.min(sp.radius, 0.4)); // a stream shot's visual core (bubbles burst wider than they look)
          if (sp.rain) {
            const aim = this.aimPoint({ x: px, y: py + EYE, z: pz }, yaw, pitch, sp.range || 30);
            const off = rainOffset(seed, kk, sp.rain.radius);
            const gx = aim.x + off.dx;
            const gz = aim.z + off.dz;
            const gy = this.prims.heightAt(gx, gz, aim.y);
            this.projectile(sp, gx, gy + sp.rain.height, gz, 0, -sp.speed, 0, 0, radius, (sp.rain.height + 2) / sp.speed, { collide: 'enemies', explode: sp.radius > 1 ? sp.radius : 0, spread: true });
            continue;
          }
          const j = shotJitter(seed, kk, a.jitterDeg);
          this.remoteHand(px, py, pz, v0?.yaw ?? yaw, hand, casterId, v0?.pitch ?? pitch);
          const yw = yaw + j.dyaw;
          const pt = pitch + j.dpitch;
          const cp = Math.cos(pt);
          // CR 022: the true path from the eye (as your own shots), easing in from their hand.
          this.projectile(sp, px, py + SHOT_Y, pz, -Math.sin(yw) * cp * sp.speed, Math.sin(pt) * sp.speed, -Math.cos(yw) * cp * sp.speed, sp.gravity, radius, (sp.range || 20) / Math.max(1, sp.speed), { collide: 'enemies', explode: sp.radius > 1 ? sp.radius : 0, spread: true, hand });
        }
        return true;
      },
    };
    this.channels.set(casterId, o);
    this.push(o);
  }

  /** An orbit: `count` orbs circling the caster for ms (the same positions the runtime hits with: spellsim orbOffset). */
  orbit(sp: SpellDef, caster: Anchor, ms: number): void {
    const ob = sp.orbit;
    if (!ob) return;
    const v = spellVisual(sp);
    const c = R.cols(v.palette);
    const t0 = fxTime();
    const prev: V3[] = [];
    const pos = { x: 0, y: 0, z: 0 };
    const cur = { x: 0, y: 0, z: 0 };
    this.push({
      until: t0 + ms / 1000,
      tick: (t) => {
        if (!this.anchorPos(caster, pos)) return false;
        const steps = ((t - t0) * 1000) / STEP_MS;
        for (let i = 0; i < ob.count; i++) {
          const off = orbOffset(i, ob.count, steps, ob.periodSteps, ob.radius);
          cur.x = pos.x + off.x;
          cur.y = pos.y + off.y;
          cur.z = pos.z + off.z;
          const p = (prev[i] ??= { ...cur });
          this.at(cur.x, cur.y, cur.z, () => {
            R.trail(v, p, cur, ob.orbRadius, 1.6);
            // the orb itself: a hot core re-emitted every frame (reads as a solid spinning blade of light)
            glowPool.emit(cur.x, cur.y, cur.z, 0, 0, 0, c.hotH, 0.07, ob.orbRadius * 1.1, 0, 0, SHAPE_GLOW);
            glowPool.emit(cur.x, cur.y, cur.z, 0, 0, 0, c.mainH, 0.12, ob.orbRadius * 1.8, 0, 0, SHAPE_GLOW);
            if (Math.random() < 0.25) R.burst(cur.x, cur.y, cur.z, [c.hotH, c.mainH], 1, { speed: [0.2, 0.8], life: [0.2, 0.4], size: [0.06, 0.12] });
          });
          p.x = cur.x;
          p.y = cur.y;
          p.z = cur.z;
        }
        return true;
      },
    });
  }

  /** Event 224: a delayed charge or a brand bursting (the zone's own hits). */
  detonate(sp: SpellDef, x: number, y: number, z: number, radius: number): void {
    const v = spellVisual(sp);
    this.at(x, y, z, () => R.explosion(this.prims, v, x, y + 0.6, z, Math.max(1.2, radius), camPos));
  }

  /** Event 225: an ally attacked: a bolt toward its target (visual), or a bite burst on it. */
  summonAttack(allyId: number, targetId: number, sp: SpellDef, x: number, y: number, z: number): void {
    const def = sp.summon ? COMBAT.summons.find((m) => m.key === sp.summon!.key) : undefined;
    const t = this.viewById.get(targetId);
    const v = spellVisual(sp);
    if (!def || !t) return;
    const h = enemyInfo(t).height;
    if (def.attack.shape === 'melee') {
      this.at(t.x, t.y + h, t.z, () => R.impact(this.prims, v, t.x, t.y + h, t.z, null, 0.9, 'hit', camPos));
      return;
    }
    const a = this.viewById.get(allyId);
    const ox = a?.x ?? x;
    const oy = (a ? a.y + 1.2 * def.size : y) + 0.1;
    const oz = a?.z ?? z;
    const dx = t.x - ox;
    const dy = t.y + h - oy;
    const dz = t.z - oz;
    const d = Math.max(0.5, Math.hypot(dx, dy, dz));
    const s = def.attack.speed;
    this.projectile(sp, ox, oy, oz, (dx / d) * s, (dy / d) * s, (dz / d) * s, 0, 0.25, (d + 1) / s, { collide: 'enemies', spread: true });
  }

  /** A new ally appeared (CombatLayer): a burst of its element where it stands. */
  summonAppear(sp: SpellDef, x: number, y: number, z: number): void {
    const v = spellVisual(sp);
    this.at(x, y, z, () => {
      R.areaBurst(this.prims, v, x, y, z, { radius: 1.6, cone: 0, line: 0, yaw: 0 }, camPos);
      R.dashBurst(this.prims, v, x, y + 0.8, z, true);
    });
  }

  /** An ally's idle aura (CombatLayer, a few times a second). */
  summonAura(sp: SpellDef, x: number, y: number, z: number, size: number): void {
    const v = spellVisual(sp);
    this.at(x, y, z, () => R.charge(v, x, y + 0.9 * size, z, 0.5 * size, 6), 0.6);
  }

  // ── Aim helpers (remote casts) ────────────────────────────────────────────

  /** The ground point along an aim (../aim.ts, the same walk the runtime uses for your areas and rain). */
  private aimPoint(eye: V3, yaw: number, pitch: number, range: number): V3 {
    return sharedAimPoint(eye, yaw, pitch, range, (x, z, ny) => this.prims.heightAt(x, z, ny));
  }

  private aimTarget(eye: V3, yaw: number, pitch: number, range: number, deg: number): RemoteView | null {
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;
    let best: RemoteView | null = null;
    let bestA = (deg * Math.PI) / 180;
    for (const e of drawnRemotes.views) {
      if ((e.kind !== 2 && e.kind !== 6) || e.healthPct <= 0) continue;
      const vx = e.x - eye.x;
      const vy = e.y + 0.9 - eye.y;
      const vz = e.z - eye.z;
      const d = Math.hypot(vx, vy, vz);
      if (d > range + 1 || d < 0.1) continue;
      const ang = Math.acos(Math.max(-1, Math.min(1, (vx * fx + vy * fy + vz * fz) / d))) - Math.atan2(enemyInfo(e).radius, d);
      if (ang < bestA) {
        bestA = ang;
        best = e;
      }
    }
    return best;
  }

  // ── Per frame ─────────────────────────────────────────────────────────────

  update(camera: THREE.Camera, viewport: { width: number; height: number; dpr: number; maxPoint: number }): void {
    this.camera = camera;
    const t0 = performance.now();
    const t = fxTime();
    const dt = Math.min(0.05, Math.max(0, t - (this.lastT || t)));
    this.lastT = t;
    setFxTier(currentFxTier());
    budget.emitted = 0;
    budget.scale = 1;
    camera.getWorldPosition(camPos);
    this.viewById.clear();
    for (const v of drawnRemotes.views) this.viewById.set(v.id, v);

    this.updateProjs(t);
    // Ongoing effects (swap-remove; end() runs once).
    for (let i = this.ongoing.length - 1; i >= 0; i--) {
      const o = this.ongoing[i];
      let keep = t < o.until;
      if (keep) keep = o.tick(t, dt);
      if (!keep) {
        const last = this.ongoing[this.ongoing.length - 1];
        this.ongoing[i] = last;
        this.ongoing.pop();
        o.end?.();
      }
    }
    this.updateStatuses(t, dt);
    this.updateHand(t, dt);
    this.prims.update(t, camera);
    if (this.warmFrames > 0) this.warmDraw(--this.warmFrames > 0);

    // Particle pools: clock, scale (pixels per world unit at 1 m), resolution, upload.
    const cam = camera as THREE.PerspectiveCamera;
    const h = viewport.height * viewport.dpr;
    const scale = h / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 75) / 2));
    for (const pool of POOLS) {
      // An idle pool skips its draw (15k early-out vertices a frame otherwise).
      pool.points.visible = t < pool.aliveUntil || this.warmFrames > 0;
      const u = pool.material.uniforms;
      u.uTime.value = t;
      u.uScale.value = scale;
      u.uMaxPoint.value = viewport.maxPoint;
      (u.uResolution.value as THREE.Vector2).set(viewport.width * viewport.dpr, h);
      pool.flush();
    }
    // playtest 2 calm kills: the flash profile caps the HDR and how white-hot a fresh particle starts
    const fp = flashProfile();
    const hdrNow = Math.min(budget.profile.hdr, fp.hdrMax);
    glowPool.material.uniforms.uHdr.value = 1 + (hdrNow - 1) * 0.2;
    glowPool.material.uniforms.uHotK.value = fp.particleHot;
    smokePool.material.uniforms.uHotK.value = fp.particleHot;
    this.prims.ribbons.material.uniforms.uHdr.value = hdrNow;
    screenTick(t, dt);
    this.counts.maxUpdateMs = Math.max(this.counts.maxUpdateMs, performance.now() - t0);
  }

  /**
   * Draw warm-up: for a few frames every idle pooled object, one projectile
   * per look and the hand glow are drawn invisibly next to the camera, so
   * the GPU builds every draw variant while the world is loading instead of
   * at the first casts (SpellFxLayer calls it once the world's shader
   * warm-up is done).
   */
  prewarm(frames = 3): void {
    this.warmFrames = frames;
  }

  private warmDraw(on: boolean): void {
    if (!this.camera) return;
    this.camera.getWorldPosition(tmpV);
    this.camera.getWorldDirection(tmpV2);
    // 3 m ahead of the lens, invisible (zero opacity, a speck of a boulder)
    const x = tmpV.x + tmpV2.x * 3;
    const y = tmpV.y + tmpV2.y * 3;
    const z = tmpV.z + tmpV2.z * 3;
    this.prims.warm(on, x, y, z);
    const looks: [THREE.BufferGeometry, THREE.Material][] = [
      [GEO.sphereLow, coreMat(col('#ffffff'))],
      [GEO.needle, coreMat(col('#ffffff'))],
      [GEO.octa, coreMat(col('#ffffff'))],
      [GEO.sphere, coreMat(col('#0a0014'))],
      [GEO.dodeca, boulderMat()],
      [GEO.icosa1, coreMat(col('#ffffff'))],
      [GEO.crescent, coreMat(col('#ffffff'))],
    ];
    let i = 0;
    for (const p of this.projs) {
      if (p.on) continue;
      if (i >= looks.length) break;
      p.mesh.visible = on;
      p.halo.visible = on && i === 0;
      if (on) {
        p.mesh.geometry = looks[i][0];
        p.mesh.material = looks[i][1];
        p.mesh.position.set(x, y, z);
        p.mesh.scale.setScalar(0.0005);
        p.halo.position.set(x, y, z);
        p.halo.scale.set(0.0005, 0.0005, 1);
      }
      i++;
    }
    this.hand.sprite.visible = on;
    if (on) {
      this.hand.sprite.position.set(x, y, z);
      this.hand.mat.opacity = 0;
    }
  }

  /** The off-hand glow: a pulse on every cast, a growing charge during windups. */
  private updateHand(t: number, dt: number): void {
    const hd = this.hand;
    // playtest 2 calm kills: calm, the glow fades slowly so a wand at 4 shots a second (or a stream) holds it lit instead of blinking it
    const calm = flashProfile().name === 'calm';
    hd.pulse = Math.max(0, hd.pulse - dt * (calm ? 1.2 : 2.5));
    const charging = t < hd.chargeUntil;
    hd.charge = charging ? Math.min(1, hd.charge + dt * 2) : Math.max(0, hd.charge - dt * 4);
    const shield = this.selfShield && t < this.selfShield.until ? 0.25 : 0;
    const k = Math.max(hd.pulse, hd.charge, shield);
    hd.sprite.visible = k > 0.01 && !!this.camera && !this.handAnchor;
    if (!hd.sprite.visible) return;
    this.selfHand(this.handPos);
    hd.sprite.position.copy(this.handPos);
    const s = (0.05 + 0.05 * k + (charging ? Math.sin(t * (calm ? 8 : 12)) * 0.008 : 0)) * (view.third ? 4 : 1);
    hd.sprite.scale.set(s, s, 1);
    hd.mat.color.copy(hd.color);
    hd.mat.opacity = Math.min(1, k * 1.2);
  }

  /** Debug/bench: what is live. */
  stats(): Record<string, number> {
    return { ...this.prims.stats(), projectiles: this.projs.filter((p) => p.on).length, ongoing: this.ongoing.length, statuses: this.statuses.size, particles: glowPool.liveAt(fxTime()) + smokePool.liveAt(fxTime()), ...this.counts };
  }

  /** Drops every live effect (tests, leaving a zone). */
  clear(): void {
    for (const o of this.ongoing) o.end?.();
    this.ongoing = [];
    for (const p of this.projs) if (p.on) this.endProj(p, 'expire');
    this.statuses.clear();
    this.beams.clear();
    this.shells.clear();
    this.prims.clear();
    glowPool.clear();
    smokePool.clear();
    screenTint(null);
  }
}

const enemyVisuals = new Map<string, SpellVisual>();
/** A spell-less visual for an element family (enemy projectiles, forms). */
export function enemyVisual(family: Family, kind = 'enemy'): SpellVisual {
  const key = `${kind}:${family}`;
  let v = enemyVisuals.get(key);
  if (!v) {
    v = { key, family, palette: PALETTES[family], look: kind === 'arrow' ? 'needle' : family === 'stone' || family === 'steel' ? 'boulder' : family === 'ice' ? 'needle' : family === 'void' || family === 'dark' ? 'void' : family === 'crystal' ? 'shard' : 'orb', spike: family === 'ice' ? 'ice' : family === 'nature' ? 'bramble' : family === 'crystal' || family === 'lightning' ? 'crystal' : family === 'light' ? 'light' : family === 'void' || family === 'dark' ? 'void' : 'stone', sigil: 5, weight: kind === 'form' ? 'major' : 'minor', setPiece: '' };
    enemyVisuals.set(key, v);
  }
  return v;
}

export type { DecalSlot, ShellSlot, DomeSlot };

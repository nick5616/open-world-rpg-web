// window.__lodestoneFx (debug builds): the spell FX gallery and cast-spam
// bench hooks. `cast('fireball')` plays a spell from 6 m in front of you
// toward the crosshair; `spam(10, 8000)` puts ten virtual casters on a ring
// around you, each casting a random spell about once a second.

import { COMBAT, type SpellDef } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import type { SpellFxEngine } from './engine';
import { currentFxTier, getGpuCap, setFxSetting, getFxSetting, type FxSetting } from './quality';
import { screenState } from './screen';
import { spellByKey } from './spellVisual';

const CASTABLE = COMBAT.spells.filter((s) => s.type !== 'passive');

export interface FxDebug {
  stats(): Record<string, number>;
  tier(): { setting: FxSetting; tier: string; gpuCap: string | null };
  setFx(s: FxSetting): void;
  cast(key: string, o?: { ahead?: number; side?: number; yaw?: number; pitch?: number }): boolean;
  spam(casters: number, ms: number, o?: { radius?: number; keys?: string[] }): Promise<{ casts: number }>;
  screen(): ReturnType<typeof screenState>;
  clear(): void;
}

export function installFxDebug(engine: SpellFxEngine): () => void {
  const w = window as unknown as { __lodestoneFx?: FxDebug };
  const cast = (sp: SpellDef, x: number, z: number, yaw: number, pitch: number) => {
    const g = engine.prims.heightAt(x, z, localPlayer.pos.y);
    engine.castFrom(sp, { x, y: g, z }, x, g, z, yaw, pitch);
  };
  const dbg: FxDebug = {
    stats: () => engine.stats(),
    tier: () => ({ setting: getFxSetting(), tier: currentFxTier(), gpuCap: getGpuCap() }),
    setFx: (s) => setFxSetting(s),
    cast(key, o = {}) {
      const sp = spellByKey.get(key);
      if (!sp) return false;
      const yaw = localPlayer.yaw;
      const ahead = o.ahead ?? 6;
      const side = o.side ?? 0;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const x = localPlayer.pos.x + fx * ahead - fz * side;
      const z = localPlayer.pos.z + fz * ahead + fx * side;
      cast(sp, x, z, o.yaw ?? yaw, o.pitch ?? -0.12);
      return true;
    },
    async spam(casters, ms, o = {}) {
      const radius = o.radius ?? 12;
      const pool = o.keys?.map((k) => spellByKey.get(k)).filter((s): s is SpellDef => !!s) ?? CASTABLE;
      const t0 = performance.now();
      const next = new Array<number>(casters).fill(0).map(() => t0 + Math.random() * 800);
      let casts = 0;
      await new Promise<void>((done) => {
        const tick = () => {
          const now = performance.now();
          if (now - t0 >= ms) return done();
          for (let i = 0; i < casters; i++) {
            if (now < next[i]) continue;
            next[i] = now + 600 + Math.random() * 600;
            const a = (i / casters) * Math.PI * 2;
            const x = localPlayer.pos.x + Math.cos(a) * radius;
            const z = localPlayer.pos.z + Math.sin(a) * radius;
            // aim at a point near you (not at you): the effects land in view
            const tx = localPlayer.pos.x + (Math.random() - 0.5) * 8;
            const tz = localPlayer.pos.z + (Math.random() - 0.5) * 8;
            const yaw = Math.atan2(-(tx - x), -(tz - z));
            cast(pool[(Math.random() * pool.length) | 0], x, z, yaw, -0.08);
            casts++;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { casts };
    },
    screen: () => screenState(),
    clear: () => engine.clear(),
  };
  w.__lodestoneFx = dbg;
  return () => {
    if (w.__lodestoneFx === dbg) delete w.__lodestoneFx;
  };
}

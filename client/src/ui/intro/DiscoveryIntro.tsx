// Grand location intros (playtest feedback: "take the location intros from
// 3d-portfolio-site"). Ported from Nicole's 3d-portfolio-website region reveal
// (src/components/ui/HudToasts.tsx + src/styles/gem.css: botw-title,
// botw-rule, gem-label, @keyframes botw-region): the place name in cream
// Fraunces small caps with a warm glow, an ornament rule (fading lines, a
// glowing diamond), a small-caps subtitle; fade/rise in over 18 % of the run,
// hold, fade out over the last 22 %. Here the title also tightens its letter
// spacing as it lands, the rule draws out from the diamond, and a WebAudio
// sting (sting.ts) swells under it.
//
// Sources (queue.ts holds the queue/dedupe/collapse rules):
//   - zone Events 600/601/602 (intros.ts INTRO_FOR_EVENT), via the
//     exploration store's zoneEventListeners
//   - first entry into a region this session (position poll)
//   - a small name card when walking back into a known town (rate-limited)
// Never takes input (pointer-events: none), sits in the top third under the
// compass and any remaining WP12 toasts, clear of the crosshair.

import { useEffect, useState, type CSSProperties } from 'react';
import type { Event as ZoneEvent } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { localPlayer } from '../../state/live';
import { hasBit } from '../map/events';
import { useExploration, zoneEventListeners } from '../map/store';
import { useMapWorld } from '../map/world';
import { INTRO_FOR_EVENT, INTRO_TOAST_KINDS, introForEvent, regionIndexAt, regionIntro, townCard, type IntroWorld } from './intros';
import { advanceIntro, introHistory, pushIntro, resetIntros, skipCurrentIntro, useIntro, type ActiveIntro, type IntroSpec, type IntroVariant } from './queue';
import { installStingUnlock, playSting, setStingVolume, stingVolume, type StingKind } from './sting';

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&display=swap';
/** Fraunces from Google Fonts; offline (or blocked) it falls back to Georgia. */
const DISPLAY = '"Fraunces", Georgia, "Times New Roman", serif';
const CREAM = '#f3ead2';
const CREAM_LINE = 'rgba(243, 234, 210, 0.7)';

const SIZE: Record<IntroVariant, { title: string; label: string; rule: number; gap: number }> = {
  region: { title: 'clamp(38px, 4.6vw, 64px)', label: 'clamp(13px, 1.05vw, 16px)', rule: 300, gap: 10 },
  major: { title: 'clamp(32px, 3.7vw, 52px)', label: 'clamp(12px, 0.95vw, 15px)', rule: 280, gap: 9 },
  minor: { title: 'clamp(24px, 2.5vw, 34px)', label: 'clamp(11px, 0.85vw, 13px)', rule: 200, gap: 6 },
  card: { title: 'clamp(22px, 2.2vw, 30px)', label: 'clamp(11px, 0.8vw, 12px)', rule: 170, gap: 5 },
};
const STING: Record<IntroVariant, StingKind | null> = { region: 'grand', major: 'major', minor: 'minor', card: null };

function installFont(): void {
  if (typeof document === 'undefined' || document.querySelector('link[data-lodestone-intro-font]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  link.dataset.lodestoneIntroFont = '1';
  document.head.appendChild(link);
}

const KEYFRAMES = `
@keyframes ldIntroIn { 0% { opacity: 0; transform: translateY(6px); filter: blur(3px) } 100% { opacity: 1; transform: none; filter: none } }
@keyframes ldIntroTitle { 0% { letter-spacing: 0.24em } 100% { letter-spacing: 0.03em } }
@keyframes ldIntroRule { 0% { transform: scaleX(0); opacity: 0 } 100% { transform: scaleX(1); opacity: 1 } }
@keyframes ldIntroDiamond { 0% { transform: translate(-50%, -50%) rotate(45deg) scale(0); opacity: 0 } 60% { transform: translate(-50%, -50%) rotate(45deg) scale(1.35); opacity: 1 } 100% { transform: translate(-50%, -50%) rotate(45deg) scale(1) } }
@keyframes ldIntroFade { 0% { opacity: 0 } 100% { opacity: 1 } }
@keyframes ldIntroOut { 0% { opacity: 1; filter: none } 100% { opacity: 0; filter: blur(2px) } }
@media (prefers-reduced-motion: reduce) {
  .ld-intro, .ld-intro * { animation-name: ldIntroFade !important; letter-spacing: 0.03em !important; }
  .ld-intro.ld-out { animation-name: ldIntroOut !important; }
}`;

/** Small caps parchment label (reference .gem-label). */
const label = (size: string): CSSProperties => ({
  fontFamily: DISPLAY,
  fontSize: size,
  fontWeight: 600,
  fontVariant: 'small-caps',
  textTransform: 'lowercase',
  letterSpacing: '0.18em',
  color: 'rgba(243, 234, 210, 0.85)',
  textShadow: '0 0 8px rgba(243, 234, 210, 0.25), 0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.5)',
});

/** Ornament rule (reference .botw-rule): lines fading out from a glowing diamond. */
function Rule({ width, accent, delay, ms }: { width: number; accent: string; delay: number; ms: number }) {
  return (
    <div style={{ position: 'relative', height: 11, width: `min(${width}px, 70vw)`, margin: '10px auto' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(90deg, transparent, ${CREAM_LINE} 18%, ${CREAM_LINE} 42%, transparent 46%) left center / 100% 1px no-repeat, linear-gradient(90deg, transparent 54%, ${CREAM_LINE} 58%, ${CREAM_LINE} 82%, transparent) left center / 100% 1px no-repeat`,
          animation: `ldIntroRule ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delay}ms both`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 7,
          height: 7,
          border: `1px solid ${CREAM}`,
          background: accent,
          boxShadow: `0 0 8px ${accent}, 0 0 16px ${accent}88`,
          transform: 'translate(-50%, -50%) rotate(45deg)',
          animation: `ldIntroDiamond ${Math.round(ms * 0.8)}ms ease-out ${Math.max(0, delay - 80)}ms both`,
        }}
      />
    </div>
  );
}

function IntroCard({ intro, exiting }: { intro: ActiveIntro; exiting: boolean }) {
  const sz = SIZE[intro.variant];
  const accent = intro.accent ?? '#4fdcff';
  const inMs = intro.inMs;
  const grand = intro.variant === 'region' || intro.variant === 'major';
  return (
    <div
      className={exiting ? 'ld-intro ld-out' : 'ld-intro'}
      data-testid="discovery-intro"
      data-variant={intro.variant}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        maxWidth: 'min(92vw, 980px)',
        padding: grand ? '22px clamp(28px, 6vw, 96px) 26px' : '14px 56px 16px',
        // A soft shadow pool behind the text (reference .botw-prompt): legible on a bright sky.
        background: 'radial-gradient(closest-side, rgba(4, 8, 14, 0.58), rgba(4, 8, 14, 0.3) 62%, rgba(4, 8, 14, 0))',
        animation: exiting ? `ldIntroOut ${intro.outMs}ms ease-in-out both` : `ldIntroIn ${inMs}ms ease-out both`,
      }}
    >
      {intro.eyebrow && <div style={{ ...label(sz.label), fontWeight: 700, marginBottom: sz.gap, color: accent, textShadow: `0 0 10px ${accent}66, 0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.7)`, animation: `ldIntroFade ${inMs}ms ease-out both` }}>{intro.eyebrow}</div>}
      <div
        data-testid="discovery-intro-title"
        style={{
          fontFamily: DISPLAY,
          fontSize: sz.title,
          fontWeight: grand ? 500 : 600,
          fontVariant: 'small-caps',
          fontOpticalSizing: 'auto',
          lineHeight: 1.05,
          letterSpacing: '0.03em',
          color: CREAM,
          textShadow: '0 0 18px rgba(243, 234, 210, 0.3), 0 2px 4px rgba(0,0,0,0.55), 0 0 32px rgba(0,0,0,0.35)',
          animation: `ldIntroTitle ${Math.round(inMs * 1.6)}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
        }}
      >
        {intro.title}
      </div>
      <Rule width={sz.rule} accent={accent} delay={Math.round(inMs * 0.35)} ms={Math.round(inMs * 1.2)} />
      {intro.subtitle && <div style={{ ...label(sz.label), animation: `ldIntroFade ${inMs}ms ease-out ${Math.round(inMs * 0.55)}ms both` }}>{intro.subtitle}</div>}
      {intro.detail && (
        <div style={{ marginTop: 6, font: `500 ${intro.variant === 'card' ? 11 : 13}px system-ui, sans-serif`, letterSpacing: '0.04em', color: 'rgba(243, 234, 210, 0.86)', textShadow: '0 1px 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.6)', animation: `ldIntroFade ${inMs}ms ease-out ${Math.round(inMs * 0.8)}ms both` }}>
          {intro.detail}
        </div>
      )}
    </div>
  );
}

function currentWorld(): IntroWorld | null {
  const d = useMapWorld.getState().data;
  return d ? { sites: d.sites, regions: d.regions } : null;
}

/** Longest an intro Event waits for the atlas (names, kinds) before showing with what it carries. */
const WORLD_WAIT_MS = 8000;

/** Zone Events -> intros. Events that arrive before the atlas has loaded (a join on a tower top) wait for it. */
function useEventIntros() {
  useEffect(() => {
    let pending: ZoneEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      const w = currentWorld();
      const evs = pending;
      pending = [];
      for (const ev of evs) {
        const spec = introForEvent(ev, w);
        if (spec) pushIntro(spec);
      }
    };
    const onEvent = (ev: ZoneEvent) => {
      if (!INTRO_FOR_EVENT[ev.kind]) return;
      pending.push({ ...ev, data: ev.data.slice() });
      if (currentWorld()) flush();
      else timer ??= setTimeout(flush, WORLD_WAIT_MS);
    };
    const offWorld = useMapWorld.subscribe((s) => {
      if (s.data && pending.length) flush();
    });
    zoneEventListeners.add(onEvent);
    return () => {
      zoneEventListeners.delete(onEvent);
      offWorld();
      clearTimeout(timer);
    };
  }, []);
}

const POLL_MS = 500;
/** Stay this long in a new region before it is announced (no flicker on borders). */
const REGION_SETTLE_MS = 1500;

/** First entry into each region this session; name cards for known towns. */
function usePlaceWatch() {
  useEffect(() => {
    let region = -1;
    let candidate = -1;
    let candidateSince = 0;
    let town = -2; // -2: not observed yet (no card for the town you load into)
    const id = setInterval(() => {
      const data = useMapWorld.getState().data;
      const ex = useExploration.getState();
      if (!data) return;
      if (ex.actions && ex.stats.events === 0) return; // online: wait for the zone's progress
      const { x, z } = localPlayer.pos;
      if (x === 0 && z === 0) return; // not placed yet
      const now = performance.now();
      const r = regionIndexAt(data, x, z);
      if (r !== region) {
        if (r !== candidate) {
          candidate = r;
          candidateSince = now;
        } else if (now - candidateSince >= REGION_SETTLE_MS) {
          region = r;
          const reg = data.regions[r];
          if (reg?.name && reg.landFraction > 0) pushIntro(regionIntro(reg, ((ex.progress.revealed >>> r) & 1) === 1), now);
        }
      } else candidate = r;

      let inside = -1;
      for (const s of data.sites) {
        if (s.category !== 'settlement') continue;
        const dx = x - s.x;
        const dz = z - s.z;
        if (dx * dx + dz * dz <= s.radius * s.radius) {
          inside = s.index;
          break;
        }
      }
      if (inside !== town) {
        if (town !== -2 && inside >= 0 && hasBit(ex.progress.discoveries, inside)) pushIntro(townCard(data.sites[inside]), now);
        town = inside;
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);
}

/** window.__lodestoneIntro for screenshots and the console. */
function installIntroHandle() {
  let n = 0;
  const handle = {
    /** Show an intro now (bypasses dedupe). variant: region | major | minor | card. */
    show: (spec: Partial<IntroSpec> & { title: string }) => pushIntro({ variant: 'major', ...spec, key: `dev:${++n}:${spec.key ?? spec.title}` }),
    state: () => {
      const s = useIntro.getState();
      return { current: s.current && { key: s.current.key, variant: s.current.variant, title: s.current.title, subtitle: s.current.subtitle, detail: s.current.detail, startedAt: s.current.startedAt, endsAt: s.current.endsAt, inMs: s.current.inMs, pace: s.current.pace }, queue: s.queue.map((q) => q.key), now: performance.now() };
    },
    history: () => introHistory.slice(),
    skip: () => skipCurrentIntro(),
    volume: (v?: number) => {
      if (v !== undefined) setStingVolume(v);
      return stingVolume();
    },
  };
  (window as unknown as { __lodestoneIntro: typeof handle }).__lodestoneIntro = handle;
}

export function DiscoveryIntro() {
  const current = useIntro((s) => s.current);
  const toastCount = useExploration((s) => s.toasts.filter((t) => !INTRO_TOAST_KINDS.has(t.kind)).length);
  const [exitingId, setExitingId] = useState(0);
  useEventIntros();
  usePlaceWatch();

  useEffect(() => {
    installFont();
    const offUnlock = installStingUnlock();
    if (DEBUG) installIntroHandle();
    return () => {
      offUnlock();
      resetIntros();
    };
  }, []);

  // Drive the queue: fade out at endsAt - outMs, retire at endsAt.
  useEffect(() => {
    if (!current) return;
    const now = performance.now();
    const st = STING[current.variant];
    if (st && now - current.startedAt < 250) playSting(st, current.inMs);
    const outAt = setTimeout(() => setExitingId(current.id), Math.max(0, current.endsAt - current.outMs - now));
    const endAt = setTimeout(() => advanceIntro(), Math.max(0, current.endsAt - now) + 20);
    return () => {
      clearTimeout(outAt);
      clearTimeout(endAt);
    };
    // A new object (new endsAt) when the queue collapses this intro.
  }, [current]);

  // Top third, under the compass (8-60 px) and any WP12 toasts still drawn at top: 64.
  const top = `max(18vh, ${64 + toastCount * 58 + 12}px)`;
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, top, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 14, userSelect: 'none' }}>
      <style>{KEYFRAMES}</style>
      {current && <IntroCard key={current.id} intro={current} exiting={exitingId === current.id} />}
    </div>
  );
}

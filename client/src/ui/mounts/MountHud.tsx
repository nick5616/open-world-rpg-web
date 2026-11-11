// The steed on screen (playtest 2 mounts, CR 027): key 5 whistles (bonds a
// steed the first time, with a Spirit Whistle in your pack), E mounts when
// you stand by it and gets off in the saddle, the spur pips by the crosshair
// while riding (one per RIDE_SPUR_STAMINA of your wheel), short notes
// (refusals, thrown), and the steed panel (name, colour, call, send away;
// opened from the character panel). `window.__lodestoneMounts` in debug
// builds (evidence runs).

import { useEffect, useState } from 'react';
import { RIDE_SPUR_STAMINA, STEED_MOUNT_REACH_M } from '@lodestone/contracts';
import { notGameKey } from '../../input/useKeyboard';
import { eFree } from '../../input/interact';
import { localPlayer } from '../../state/live';
import { PHASE, STEED_COLOURS, steedPose } from './events';
import { ensureMountHook } from './link';
import { useMounts } from './store';
import { trackPanel } from '../../input/panelStack';

// Esc closes the steed panel when it is the top panel (input/panelStack.ts).
trackPanel(useMounts, (s) => !!s.panel, 'steed', () => openSteedPanel(false));
import { countOf } from '../inventory/items';
import { useInventory } from '../inventory/store';

/** The whistle key (all letters are taken; 5 sits by the spell keys 1-4). */
export const WHISTLE_KEY = 'Digit5';

const GOLD = '#ffd166';
const TEXT = '#f4efe2';
const panel: React.CSSProperties = { position: 'fixed', padding: '14px 18px', borderRadius: 10, background: 'rgba(14,16,24,0.9)', border: '1px solid rgba(160,200,255,0.35)', color: TEXT, font: '13px system-ui, sans-serif', zIndex: 36, pointerEvents: 'auto' };
const btn: React.CSSProperties = { padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(255,255,255,0.08)', color: TEXT, cursor: 'pointer', font: '13px system-ui, sans-serif' };

/** Open or close the steed panel (the character panel's "Your steed" button). */
export function openSteedPanel(open = true): void {
  useMounts.setState({ panel: open });
  if (open && typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
}

/** Your steed standing (or arriving) within reach of your feet. */
function steedInReach(): boolean {
  const s = useMounts.getState();
  const v = s.steeds[s.selfId];
  if (!v || (v.phase !== PHASE.standing && v.phase !== PHASE.arriving)) return false;
  const p = localPlayer.pos;
  const at = steedPose(v, performance.now()); // an arriving steed counts where it is now, not where it will stand
  return Math.hypot(p.x - at.x, p.z - at.z) <= STEED_MOUNT_REACH_M - 0.1 && Math.hypot(p.x - v.x, p.z - v.z) <= STEED_MOUNT_REACH_M - 0.1 && Math.abs(p.y - v.y) < 2.5;
}

function panelOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[data-ui-panel]')].some((el) => el.getClientRects().length > 0);
}

function useTicker(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function MountHud() {
  useTicker(120);
  const s = useMounts();
  useEffect(() => {
    ensureMountHook();
    const iv = setInterval(ensureMountHook, 1000);
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || notGameKey(e)) return;
      const st = useMounts.getState();
      if (e.ctrlKey || e.metaKey) return;
      if (e.code === WHISTLE_KEY) {
        if (!localPlayer.mounted) st.actions?.summon();
        return;
      }
      if (e.code !== 'KeyE' || panelOpen()) return;
      // In the saddle E only gets off; on foot the steed is last in input/interact.ts E_ORDER
      // (a townsperson, loot, a camp piece or your pet beside it come first). One press, one thing.
      if (localPlayer.mounted) {
        e.stopImmediatePropagation();
        st.actions?.dismount();
      } else if (steedInReach() && eFree('steed')) {
        e.stopImmediatePropagation();
        st.actions?.mount();
      }
    };
    window.addEventListener('keydown', onDown, true);
    const dbg = {
      state: () => {
        const m = useMounts.getState();
        return { mine: m.mine, steeds: m.steeds, selfId: m.selfId, notes: m.notes.map((n) => n.text), mounted: localPlayer.mounted, gait: localPlayer.gait, speed: Math.hypot(localPlayer.vel.x, localPlayer.vel.z), pos: { ...localPlayer.pos } };
      },
      actions: () => useMounts.getState().actions,
      panel: openSteedPanel,
    };
    (window as unknown as { __lodestoneMounts?: unknown }).__lodestoneMounts = dbg;
    return () => {
      clearInterval(iv);
      window.removeEventListener('keydown', onDown, true);
    };
  }, []);

  const now = performance.now();
  const notes = s.notes.filter((n) => now - n.at < 5000);
  const mounted = localPlayer.mounted;
  const mine = s.mine;
  const spurs = Math.floor(localPlayer.stamina / RIDE_SPUR_STAMINA + 1e-6);
  const maxSpurs = Math.floor(localPlayer.staminaMax / RIDE_SPUR_STAMINA + 1e-6);
  const near = !mounted && steedInReach() && eFree('steed');
  return (
    <>
      {mounted && (
        <div data-testid="steed-ride" style={{ position: 'fixed', left: '50%', top: 'calc(50% + 46px)', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 20, textAlign: 'center', font: '12px system-ui, sans-serif', color: TEXT, textShadow: '0 1px 2px #000' }}>
          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
            {Array.from({ length: maxSpurs }, (_, i) => (
              <span key={i} style={{ width: 12, height: 12, borderRadius: '50% 50% 20% 20%', border: `2px solid ${i < spurs ? '#bfe3ff' : 'rgba(255,255,255,0.25)'}`, borderBottom: 'none', boxShadow: i < spurs ? '0 0 6px #8fd0ff' : 'none' }} />
            ))}
          </div>
          <div style={{ marginTop: 3, opacity: 0.8 }}>{['Trot', 'Walk', 'Gallop'][localPlayer.gait] ?? ''} · Shift spur · Space jump · E get off</div>
        </div>
      )}
      {near && mine && (
        <div data-testid="steed-prompt" style={{ position: 'fixed', left: '50%', top: '62%', transform: 'translateX(-50%)', color: TEXT, font: '14px system-ui, sans-serif', textShadow: '0 1px 2px #000, 0 0 6px #000', pointerEvents: 'none', zIndex: 20 }}>
          [E] Ride {mine.name}
        </div>
      )}
      {notes.length > 0 && (
        <div data-testid="steed-notes" style={{ position: 'fixed', left: '50%', top: '24%', transform: 'translateX(-50%)', pointerEvents: 'none', zIndex: 22, textAlign: 'center' }}>
          {notes.slice(-2).map((n) => (
            <div key={n.id} style={{ color: n.bad ? '#ffb3a8' : '#cfe8ff', font: '600 15px system-ui, sans-serif', textShadow: '0 1px 3px #000', marginTop: 4 }}>
              {n.text}
            </div>
          ))}
        </div>
      )}
      {s.panel && <SteedPanel />}
    </>
  );
}

function SteedPanel() {
  const s = useMounts();
  const mine = s.mine;
  const [name, setName] = useState(mine?.name ?? '');
  useEffect(() => setName(mine?.name ?? ''), [mine?.name]);
  const a = s.actions;
  return (
    <div data-testid="steed-panel" data-ui-panel style={{ ...panel, left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(420px, 92vw)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ font: '20px Georgia, serif' }}>Your steed</div>
        <button style={btn} onClick={() => openSteedPanel(false)}>
          Close <span style={{ opacity: 0.6 }}>Esc</span>
        </button>
      </div>
      {!mine?.owned ? (
        <div style={{ marginTop: 10, lineHeight: 1.5 }}>
          {mine?.whistle || countOf(useInventory.getState().inv?.items ?? [], 'tool:spirit_whistle') > 0 ? (
            <>
              You carry a <b>Spirit Whistle</b>. Press <b>5</b> to blow it: a spirit steed will answer and bond with you.
            </>
          ) : (
            <>
              No steed yet. General stores sell a <b>Spirit Whistle</b> for 40 gold. Blow it (<b>5</b>) and a spirit steed answers.
            </>
          )}
        </div>
      ) : (
        <>
          <div style={{ marginTop: 10 }}>
            <label style={{ opacity: 0.75 }}>Name</label>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input data-testid="steed-name" value={name} maxLength={16} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9 '-]/g, ''))} style={{ flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(0,0,0,0.35)', color: TEXT, font: '14px system-ui, sans-serif' }} />
              <button style={btn} disabled={!name.trim() || name === mine.name} onClick={() => a?.name(name.trim())}>
                Rename
              </button>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={{ opacity: 0.75 }}>Colour</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {STEED_COLOURS.map((c, i) => (
                <button key={c.name} data-testid={`steed-colour-${i}`} title={c.name} onClick={() => a?.colour(i)} style={{ ...btn, padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6, borderColor: i === mine.colour ? GOLD : 'rgba(255,255,255,0.25)' }}>
                  <span style={{ width: 16, height: 16, borderRadius: 8, background: `#${c.body.toString(16).padStart(6, '0')}`, boxShadow: `0 0 8px #${c.glow.toString(16).padStart(6, '0')}` }} />
                  {c.name}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button style={btn} onClick={() => a?.summon()}>
              Whistle <span style={{ opacity: 0.6 }}>5</span>
            </button>
            <button style={btn} disabled={mine.phase !== PHASE.standing && mine.phase !== PHASE.arriving} onClick={() => a?.dismiss()}>
              Send away
            </button>
          </div>
          <div style={{ marginTop: 10, opacity: 0.7, lineHeight: 1.45 }}>
            E by your steed rides it, E again gets off (Space when standing still). W trots, a Shift press spurs it to a gallop and each spur costs stamina; S reins in and backs up. It won't climb cliffs or swim, shies from demons at night, and a hard hit may throw you. Bows, staves, wands and spells work from the saddle.
          </div>
        </>
      )}
    </div>
  );
}

// Playtest 1 HUD (CR 012): the level-up fanfare, the character panel (C),
// area notices (the Haven, the wilds, "the land takes your measure") and the
// crystal tower prompt ("Climb to the crystal to reveal this land", "[E]
// Attune"). Mounted by the play screen in online and offline play; offline
// the panel shows level-1 numbers and nothing is ever attuned.

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { COMBAT } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { isTextTarget } from '../../input/useKeyboard';
import { localPlayer } from '../../state/live';
import { useCombatHud } from '../../combat/store';
import { useExploration } from '../map/store';
import { hasBit } from '../map/events';
import { useMapWorld } from '../map/world';
import { useNetStore } from '../../net/netStore';
import { learnable, nextTechnique, skillLevel, slottable, statsAt, upcoming } from './gains';
import { installProgressionDebug } from './dev';
import { FANFARE_MS, isAttuned, pruneProgression, setPanelOpen, useProgression, type Notice } from './store';
import { towerPrompt, type TowerPrompt, type TowerLike } from './towerPrompt';
import { useIntro } from '../intro/queue';
import { openSkillScreen } from '../skills/store';

const GOLD = '#ffd166';
const PANEL: CSSProperties = { background: 'rgba(12,14,20,0.94)', border: '1px solid rgba(255,209,102,0.35)', borderRadius: 6, color: '#f1f3f5', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' };

// ---- the level-up fanfare ----


function LevelUpFanfare() {
  const f = useProgression((s) => s.fanfare);
  // A discovery card owns the screen; the fanfare waits for it to finish
  // (playtest 2: a new character's first town gave both at once, stacked).
  const introUp = useIntro((s) => !!s.current);
  const id = f?.id;
  useEffect(() => {
    // The level-up sound comes from the audio system (Event 604 -> level up sound 1-3).
  }, [id]);
  if (!f || introUp) return null; // shown after the discovery card (the store holds it meanwhile)
  return (
    <div key={f.id} data-testid="levelup-fanfare" className="pt-fanfare" style={{ position: 'fixed', top: '15%', left: '50%', transform: 'translateX(-50%)', zIndex: 40, pointerEvents: 'none', textAlign: 'center', ['--pt-ms' as string]: `${FANFARE_MS}ms` }}>
      <div style={{ font: '600 15px Georgia, serif', letterSpacing: 6, color: GOLD, textShadow: '0 0 12px rgba(255,209,102,0.7)' }}>LEVEL UP</div>
      <div style={{ font: '700 64px Georgia, serif', color: '#fff8e1', lineHeight: 1.05, textShadow: '0 0 24px rgba(255,209,102,0.9), 0 2px 4px #000' }}>Level {f.level}</div>
      <div style={{ font: 'italic 16px Georgia, serif', color: '#f1f3f5', margin: '4px 0 10px', textShadow: '0 1px 3px #000' }}>You feel stronger.</div>
      <div style={{ display: 'inline-flex', flexWrap: 'wrap', justifyContent: 'center', gap: '6px 8px', maxWidth: 560 }}>
        {f.lines.map((l) => (
          <span key={l} style={{ ...PANEL, padding: '4px 10px', font: '13px system-ui, sans-serif', color: l.startsWith('Unlocked') ? GOLD : '#e9ecef' }}>
            {l}
          </span>
        ))}
      </div>
      <div style={{ font: '12px system-ui, sans-serif', opacity: 0.75, marginTop: 8, textShadow: '0 1px 2px #000' }}>Health and stamina restored · C character · N skill tree</div>
    </div>
  );
}

// ---- area notices ----

const NOTICE_ACCENT: Record<Notice['kind'], string> = { area: GOLD, danger: '#ff6b6b', safe: '#8ce99a', attuned: '#66d9ff', warn: '#ff922b' };

function AreaNotices() {
  const notices = useProgression((s) => s.notices);
  const panelOpen = useProgression((s) => s.panelOpen);
  if (panelOpen) return null; // the panel sits where the notices do
  return (
    <div style={{ position: 'fixed', left: 18, top: '28%', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 13, pointerEvents: 'none', maxWidth: 380 }}>
      {notices.map((n) => (
        <div key={n.id} data-testid={`progression-notice-${n.kind}`} className="pt-notice" style={{ ...PANEL, borderLeft: `3px solid ${NOTICE_ACCENT[n.kind]}`, padding: '8px 12px' }}>
          <div style={{ font: '15px Georgia, serif', color: NOTICE_ACCENT[n.kind] }}>{n.title}</div>
          {n.detail && <div style={{ font: '12px system-ui, sans-serif', opacity: 0.85, marginTop: 3 }}>{n.detail}</div>}
        </div>
      ))}
    </div>
  );
}

// ---- the crystal tower prompt ----

function useTowerPrompt(): TowerPrompt | null {
  const [p, setP] = useState<TowerPrompt | null>(null);
  useEffect(() => {
    let last = '';
    const id = setInterval(() => {
      const towers: TowerLike[] = useMapWorld.getState().towers.map((t) => ({ site: t.site, cx: t.shape.cx, cz: t.shape.cz, topY: t.shape.topY, maxR: t.shape.maxR }));
      const unlockedSet = useExploration.getState().progress.towers;
      const pos = localPlayer.pos;
      const next = towerPrompt(towers, pos.x, pos.y, pos.z, (s) => hasBit(unlockedSet, s), isAttuned);
      const key = next ? `${next.kind}:${next.site}` : '';
      if (key !== last) {
        last = key;
        setP(next);
      }
    }, 200);
    return () => clearInterval(id);
  }, []);
  return p;
}

function TowerPromptView({ p }: { p: TowerPrompt }) {
  const color = p.kind === 'attune' ? '#66d9ff' : p.kind === 'attuned' ? '#8ce99a' : GOLD;
  return (
    <div data-testid={`tower-prompt-${p.kind}`} className="pt-notice" style={{ position: 'fixed', left: '50%', top: '67%', transform: 'translateX(-50%)', zIndex: 14, pointerEvents: 'none', textAlign: 'center', maxWidth: 520 }}>
      <div style={{ font: '20px Georgia, serif', color, textShadow: `0 0 10px ${color}66, 0 1px 3px #000` }}>
        <span style={{ marginRight: 8 }}>◆</span>
        {p.title}
      </div>
      <div style={{ font: '13px system-ui, sans-serif', color: '#f1f3f5', opacity: 0.9, marginTop: 4, textShadow: '0 1px 2px #000, 0 0 6px #000' }}>{p.detail}</div>
    </div>
  );
}

// ---- the character panel (C) ----

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <span style={{ opacity: 0.75 }}>{label}</span>
      <span>
        {value}
        {sub && <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 11 }}>{sub}</span>}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ font: '13px Georgia, serif', color: GOLD, letterSpacing: 1, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

/** The active loadout's four spell slots: pick any known castable spell (a spell already in another slot moves). */
function SpellSlots({ slots, known, disabled, onPick }: { slots: readonly (string | null)[]; known: readonly string[]; disabled: boolean; onPick: (slot: number, spellId: number) => void }) {
  const options = slottable(known);
  return (
    <div>
      {[0, 1, 2, 3].map((i) => {
        const cur = slots[i] ?? '';
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
            <span style={{ width: 16, color: GOLD }}>{i + 1}</span>
            <select
              data-testid={`spell-slot-${i}`}
              value={cur}
              disabled={disabled}
              onChange={(e) => onPick(i, options.find((o) => o.key === e.target.value)?.id ?? 0)}
              style={{ flex: 1, font: '12px system-ui, sans-serif', background: 'rgba(0,0,0,0.35)', color: '#f1ead8', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4, padding: '2px 4px' }}
            >
              <option value="">(empty)</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name} · {o.tree} {o.tier}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>New spells fill an empty slot by themselves. Cast with 1-4, or wheel to select and right-click.</div>
    </div>
  );
}

const PANEL_BTN: CSSProperties = { flex: 1, font: '12px system-ui, sans-serif', padding: '5px 8px', borderRadius: 4, border: '1px solid rgba(255,209,102,0.5)', background: 'rgba(255,209,102,0.1)', color: '#f1f3f5', cursor: 'pointer' };

function openFromPanel(tab?: string) {
  setPanelOpen(false);
  openSkillScreen(tab);
}

const SKILL_NAMES: Record<string, string> ={ swordsmanship: 'Swordsmanship', spearmanship: 'Spearmanship', archery: 'Archery', spellcraft: 'Spellcraft', mining: 'Mining', smithing: 'Smithing' };

function CharacterPanel() {
  const stats = useProgression((s) => s.stats);
  const area = useProgression((s) => s.area);
  const actions = useProgression((s) => s.actions);
  const known = useCombatHud((s) => s.known);
  const skillXp = useCombatHud((s) => s.skillXp);
  const freePoints = useCombatHud((s) => s.skillPoints);
  const combatActive = useCombatHud((s) => s.active);
  const loadouts = useCombatHud((s) => s.loadouts);
  const activeLoadout = useCombatHud((s) => s.activeLoadout);
  const name = useNetStore((s) => s.ready?.character.name) ?? 'Adventurer';
  const level = stats?.level ?? 1;
  const base = statsAt(level, stats?.attunedCount ?? 0);
  const into = stats?.xpInto ?? 0;
  const next = stats?.xpNext ?? 100;
  const free = combatActive ? freePoints : (stats?.skillFree ?? 0);
  const spells = learnable(known, level);
  const ready = spells.filter((s) => s.ready).slice(0, 8);
  const locked = spells.filter((s) => !s.ready).slice(0, 4);
  return (
    <div data-testid="character-panel" data-ui-panel style={{ ...PANEL, position: 'fixed', left: 24, top: 70, width: 430, maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: '14px 18px', zIndex: 35, font: '13px system-ui, sans-serif', pointerEvents: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ font: '22px Georgia, serif' }}>{name}</div>
        <div style={{ font: '700 18px Georgia, serif', color: GOLD }}>Level {level}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {/* Playtest 2: the full skill tree and the build overview (client/src/ui/skills). */}
        <button data-testid="open-skill-tree" onClick={() => openFromPanel()} style={PANEL_BTN}>
          Skill tree <span style={{ opacity: 0.6 }}>N</span>
          {free > 0 && <span style={{ color: GOLD }}> · {free} to spend</span>}
        </button>
        <button data-testid="open-build" onClick={() => openFromPanel('build')} style={PANEL_BTN}>
          Build overview <span style={{ opacity: 0.6 }}>B</span>
        </button>
      </div>
      <div style={{ marginTop: 6 }}>
        <div style={{ height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' }}>
          <div data-testid="xp-bar" style={{ width: `${Math.min(100, (100 * into) / Math.max(1, next))}%`, height: '100%', background: `linear-gradient(90deg, #b388ff, ${GOLD})` }} />
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 3 }}>
          {into} / {next} XP to level {level + 1} · discoveries, towers and fights all give XP
        </div>
      </div>
      <Section title="Stats">
        <Row label="Health" value={stats?.healthMax ?? base.health} sub={`+${COMBAT.leveling.health.perLevel} per level`} />
        <Row label="Stamina" value={stats?.staminaMax ?? base.stamina} sub={`+${COMBAT.leveling.stamina.perLevel} per level`} />
        <Row label="Damage" value={`+${stats?.damagePct ?? base.damagePct}%`} sub={`+${COMBAT.leveling.damagePctPerLevel}% per level, all attacks and spells`} />
        <Row label="Mana" value={stats?.manaMax ?? base.mana} />
        <Row label="Skill points" value={<span style={{ color: free > 0 ? GOLD : undefined }}>{free} unspent</span>} sub={`of ${stats?.skillTotal ?? base.skillPoints}`} />
        <Row label="Crystals attuned" value={stats?.attunedCount ?? 0} sub="each: a permanent boon" />
      </Section>
      <Section title={`Spell slots · loadout ${activeLoadout + 1} (X swaps)`}>
        <SpellSlots slots={loadouts[activeLoadout]?.spells ?? []} known={known} disabled={!actions} onPick={(slot, id) => actions?.equipSpell(activeLoadout, slot, id)} />
      </Section>
      <Section title={`Learn spells${free > 0 ? ` (${free} point${free === 1 ? '' : 's'} to spend)` : ''}`}>
        {ready.length === 0 && <div style={{ opacity: 0.6 }}>Nothing new to learn right now.</div>}
        {ready.map((s) => (
          <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
            <span>
              {s.name}
              <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 11 }}>
                {s.tree} · tier {s.tier}
                {s.passive ? ' · passive' : ''}
              </span>
              {s.killsDemons && <span style={{ color: GOLD, marginLeft: 6, fontSize: 11 }}>kills demons</span>}
            </span>
            <button data-testid={`learn-${s.key}`} disabled={free <= 0 || !actions} onClick={() => actions?.learn(s.id)} style={{ font: '12px system-ui, sans-serif', padding: '2px 10px', cursor: free > 0 ? 'pointer' : 'default' }}>
              Learn
            </button>
          </div>
        ))}
        {locked.map((s) => (
          <div key={s.key} style={{ opacity: 0.5, padding: '2px 0' }}>
            {s.name} <span style={{ fontSize: 11 }}>· {s.tree} tier {s.tier} · needs level {s.needsLevel}</span>
          </div>
        ))}
      </Section>
      {area && (
        <Section title="Where you stand">
          <Row label={area.haven ? 'The Haven' : area.tierName} value={`area level ${area.level}`} sub={area.by && !area.haven ? `shaped by ${area.by}` : undefined} />
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 3 }}>New lands take the measure of the first explorer to reach them: the stronger you are, the harder the places you discover.</div>
        </Section>
      )}
      <Section title="Coming next">
        {upcoming(level).map((u) => (
          <div key={u.level} style={{ display: 'flex', gap: 10, padding: '2px 0' }}>
            <span style={{ width: 54, color: GOLD, flex: 'none' }}>Level {u.level}</span>
            <span style={{ opacity: 0.85 }}>{u.lines.join(' · ')}</span>
          </div>
        ))}
      </Section>
      <Section title="Weapon skills (grow by use)">
        {COMBAT.skills.list.map((sk) => {
          const lv = skillLevel(skillXp[sk.key] ?? 0);
          const t = nextTechnique(sk.key, lv);
          return <Row key={sk.key} label={SKILL_NAMES[sk.key] ?? sk.key} value={lv} sub={t ? `${t.name} at ${t.level}` : undefined} />;
        })}
      </Section>
      <div style={{ fontSize: 11, opacity: 0.55, marginTop: 10 }}>C or Esc to close</div>
    </div>
  );
}

function useProgressionKeys(prompt: TowerPrompt | null) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target) || e.repeat) return;
      if (e.code === 'KeyC') {
        setPanelOpen(!useProgression.getState().panelOpen);
        if (useProgression.getState().panelOpen && document.pointerLockElement) document.exitPointerLock();
      } else if (e.code === 'Escape' && useProgression.getState().panelOpen) {
        setPanelOpen(false);
      } else if (e.code === 'KeyE' && prompt?.kind === 'attune') {
        useProgression.getState().actions?.attune(prompt.site);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt]);
}

const CSS = `
@keyframes ptFanfare { 0% { opacity: 0; transform: translate(-50%, -12px) scale(0.92) } 8% { opacity: 1; transform: translate(-50%, 0) scale(1.04) } 14% { transform: translate(-50%, 0) scale(1) } 85% { opacity: 1 } 100% { opacity: 0 } }
.pt-fanfare { animation: ptFanfare var(--pt-ms) ease-out forwards }
@keyframes ptNotice { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }
.pt-notice { animation: ptNotice 0.35s ease-out }
`;

export function ProgressionHud() {
  const open = useProgression((s) => s.panelOpen);
  const prompt = useTowerPrompt();
  useProgressionKeys(prompt);
  useEffect(() => {
    const id = setInterval(() => pruneProgression(performance.now(), !!useIntro.getState().current), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (DEBUG) return installProgressionDebug();
  }, []);
  return (
    <>
      <style>{CSS}</style>
      <AreaNotices />
      <LevelUpFanfare />
      {prompt && <TowerPromptView p={prompt} />}
      {open && <CharacterPanel />}
    </>
  );
}

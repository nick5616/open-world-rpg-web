// The skill tree screen (playtest 2: "Skill tree you can open", "Somewhere
// to see where all your spec'd items have accumulated"). N opens it on the
// last spell tree, B on the build overview; Esc closes. One tab per spell
// tree (a graph by tier with prerequisite edges; click a node for its card,
// Learn spends a skill point; drag a learned spell onto a slot, or pick it
// and click a slot), Weapon skills (use-based skills, techniques, elemental
// forms) and Build (gear per slot, both loadouts, every bonus with where it
// comes from, points spent and unspent). Learning and slotting are the
// existing combat Interacts (ProgressionActions.learn / equipSpell).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from 'react';
import { COMBAT } from '@lodestone/contracts';
import { DEBUG } from '../../config';
import { isTextTarget } from '../../input/useKeyboard';
import { useCombatHud } from '../../combat/store';
import { useInventory } from '../inventory/store';
import { useProgression, setPanelOpen } from '../progression/store';
import { skillProgress, statsAt } from '../progression/gains';
import { buildOverview, fmt, spellHitWith, treeDamageMults, type BuildView, type LoadoutView, type SlotView, type StatLine } from './build';
import { castable, cap, ELEMENT_COLOR, layoutTree, learnedCounts, namePending, needLine, nodeState, passiveLines, SKILL_EFFECT, SKILL_NAMES, spellByKey, spellFacts, spellName, TECHNIQUE_INFO, TREE_ORDER, treeByKey, type NodeState, type TreeLayout } from './tree';
import { closeSkillScreen, setSkillTab, toggleSkillScreen, useSkillScreen } from './store';
import { installSkillsDebug } from './dev';

const GOLD = '#ffd166';
const INK = '#f1f3f5';
const DIM = 'rgba(241,243,245,0.6)';
const PANEL: CSSProperties = { background: 'rgba(11,13,19,0.985)', backdropFilter: 'blur(6px)', border: '1px solid rgba(255,209,102,0.35)', borderRadius: 8, color: INK, boxShadow: '0 16px 40px rgba(0,0,0,0.6)' };
const CARD: CSSProperties = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '10px 12px' };
const BTN: CSSProperties = { font: '12px system-ui, sans-serif', padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(255,209,102,0.5)', background: 'rgba(255,209,102,0.12)', color: INK, cursor: 'pointer' };

// ---- the data every tab reads ----

interface Char {
  level: number;
  attuned: number;
  free: number;
  total: number;
  known: string[];
  knownSet: Set<string>;
  online: boolean;
  activeLoadout: number;
  loadouts: { weapon: string; spells: (string | null)[]; gem: number }[];
  skillXp: Record<string, number>;
  view: BuildView;
}

function useChar(): Char {
  const stats = useProgression((s) => s.stats);
  const actions = useProgression((s) => s.actions);
  const known = useCombatHud((s) => s.known);
  const skillXp = useCombatHud((s) => s.skillXp);
  const combatActive = useCombatHud((s) => s.active);
  const freePoints = useCombatHud((s) => s.skillPoints);
  const loadouts = useCombatHud((s) => s.loadouts);
  const activeLoadout = useCombatHud((s) => s.activeLoadout);
  const combatLevel = useCombatHud((s) => s.level);
  const items = useInventory((s) => s.inv?.items);
  return useMemo(() => {
    const level = stats?.level ?? combatLevel ?? 1;
    const attuned = stats?.attunedCount ?? 0;
    const total = stats?.skillTotal ?? statsAt(level, attuned).skillPoints;
    // Like the character panel: combat_sync's free points while combat runs, else Event 900's.
    const free = combatActive ? freePoints : (stats?.skillFree ?? total - known.filter((k) => !COMBAT.start.spells.includes(k)).length);
    const view = buildOverview({ level, attuned, skillFree: free, skillTotal: total, known, skillXp, loadouts, activeLoadout, items: items ?? [], zone: stats ? { manaMax: stats.manaMax, staminaMax: stats.staminaMax } : null });
    return { level, attuned, free, total, known, knownSet: new Set(known), online: !!actions, activeLoadout, loadouts, skillXp, view };
  }, [stats, actions, known, skillXp, combatActive, freePoints, loadouts, activeLoadout, combatLevel, items]);
}

const learn = (key: string) => {
  const s = spellByKey.get(key);
  if (s) useProgression.getState().actions?.learn(s.id);
};
const equip = (loadout: number, slot: number, key: string | null) => {
  const id = key ? (spellByKey.get(key)?.id ?? 0) : 0;
  useProgression.getState().actions?.equipSpell(loadout, slot, id);
};

// ---- small pieces ----

function Tag({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return <span style={{ display: 'inline-block', padding: '0 6px', marginLeft: 6, borderRadius: 3, border: `1px solid ${color}55`, color, fontSize: 10, lineHeight: '15px', letterSpacing: 0.3, verticalAlign: 'middle', whiteSpace: 'nowrap' }}>{children}</span>;
}

function H({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', font: '14px Georgia, serif', color: GOLD, letterSpacing: 0.5, margin: '2px 0 6px' }}>
      <span>{children}</span>
      {right && <span style={{ font: '11px system-ui, sans-serif', color: DIM }}>{right}</span>}
    </div>
  );
}

function Bar({ frac, color }: { frac: number; color: string }) {
  return (
    <div style={{ height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%`, height: '100%', background: color }} />
    </div>
  );
}

// ---- spell card (tooltip and sidebar) ----

function SpellCard({ k, st, c, compact }: { k: string; st: NodeState; c: Char; compact?: boolean }) {
  const s = spellByKey.get(k);
  if (!s) return null;
  const color = ELEMENT_COLOR[s.tree] ?? GOLD;
  const facts = spellFacts(s);
  const passive = s.type === 'passive' ? passiveLines(s) : [];
  const hit = spellHitWith(s, c.view, c.activeLoadout, c.knownSet);
  const inSlots = c.loadouts.flatMap((l, li) => l.spells.map((x, si) => (x === k ? `loadout ${li + 1} slot ${si + 1}` : ''))).filter(Boolean);
  const need = needLine(st);
  return (
    <div data-testid={`spell-card-${k}`} style={{ font: '12px system-ui, sans-serif', lineHeight: 1.4 }}>
      <div style={{ font: '17px Georgia, serif', color }}>
        {spellName(k)}
        {namePending(k) && <Tag color={GOLD}>name pending</Tag>}
      </div>
      <div style={{ color: DIM, fontSize: 11 }}>
        {cap(s.tree)} · tier {s.tier}
        {st.needsLevel > 1 ? ` (level ${st.needsLevel}+)` : ''}
        {st.status === 'learned' && <span style={{ color: '#8ce99a' }}> · learned</span>}
      </div>
      {need && <div style={{ color: st.status === 'learnable' ? GOLD : st.status === 'noPoints' ? '#ffc078' : '#ff8787', margin: '4px 0' }}>{need}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 1, marginTop: 4 }}>
        {facts.map((f, i) => (
          <FactRow key={i} label={f.label} value={f.value} accent={f.accent ? color : undefined} />
        ))}
        {hit > 0 && <FactRow label="Your hit" value={`about ${hit} (loadout ${c.activeLoadout + 1}, before the enemy's element)`} accent={GOLD} />}
      </div>
      {passive.map((p, i) => (
        <div key={i} style={{ marginTop: 3, color: p.active ? INK : DIM }}>
          {p.text}
          {!p.active && <Tag>not in effect yet</Tag>}
        </div>
      ))}
      {!compact && s.ported && <div style={{ marginTop: 4, color: DIM, fontSize: 11 }}>Adapted from Wizard Wars: {s.ported}</div>}
      {inSlots.length > 0 && <div style={{ marginTop: 4, color: '#8ce99a', fontSize: 11 }}>In {inSlots.join(', ')}</div>}
      {st.status === 'learned' && s.type === 'passive' && <div style={{ marginTop: 4, color: DIM, fontSize: 11 }}>Passives work on their own: no slot needed.</div>}
    </div>
  );
}

function FactRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <>
      <span style={{ color: DIM }}>{label}</span>
      <span style={{ color: accent ?? INK }}>{value}</span>
    </>
  );
}

// ---- spell slots (sidebar) ----

function SlotRow({ c, loadout, picked }: { c: Char; loadout: number; picked: string | null }) {
  const lo = c.loadouts[loadout];
  const [over, setOver] = useState(-1);
  const canPlace = !!picked && c.knownSet.has(picked) && castable(picked);
  const onDrop = (e: DragEvent, slot: number) => {
    e.preventDefault();
    setOver(-1);
    const k = e.dataTransfer.getData('text/x-lodestone-spell') || e.dataTransfer.getData('text/plain');
    if (k && c.knownSet.has(k) && castable(k)) equip(loadout, slot, k);
  };
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: loadout === c.activeLoadout ? GOLD : DIM, marginBottom: 3 }}>
        Loadout {loadout + 1} · {c.view.loadouts[loadout]?.weaponName ?? lo?.weapon}
        {loadout === c.activeLoadout ? ' · active' : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        {[0, 1, 2, 3].map((i) => {
          const k = lo?.spells[i] ?? null;
          const s = k ? spellByKey.get(k) : undefined;
          const color = s ? (ELEMENT_COLOR[s.tree] ?? INK) : DIM;
          return (
            <div
              key={i}
              data-testid={`skill-slot-${loadout}-${i}`}
              draggable={!!k}
              onDragStart={(e) => k && e.dataTransfer.setData('text/x-lodestone-spell', k)}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(i);
              }}
              onDragLeave={() => setOver(-1)}
              onDrop={(e) => onDrop(e, i)}
              onClick={() => {
                if (canPlace && c.online) {
                  equip(loadout, i, picked);
                  useSkillScreen.setState({ picked: null });
                } else if (k && s) {
                  setSkillTab(s.tree);
                  useSkillScreen.setState({ picked: k });
                }
              }}
              title={k ? `${spellName(k)} · drag away or press x to clear` : 'Empty: drag a learned spell here'}
              style={{
                position: 'relative',
                minHeight: 40,
                padding: '3px 4px 3px 5px',
                borderRadius: 4,
                cursor: canPlace || k ? 'pointer' : 'default',
                background: over === i ? 'rgba(255,209,102,0.2)' : 'rgba(0,0,0,0.35)',
                border: `1px solid ${over === i || (canPlace && c.online) ? GOLD : s ? `${color}88` : 'rgba(255,255,255,0.12)'}`,
                boxShadow: canPlace && c.online ? `0 0 6px ${GOLD}66` : undefined,
                fontSize: 11,
                lineHeight: 1.2,
              }}
            >
              <div style={{ color: GOLD, fontSize: 10 }}>{i + 1}</div>
              <div style={{ color, overflow: 'hidden', textOverflow: 'ellipsis' }}>{k ? spellName(k) : 'empty'}</div>
              {k && c.online && (
                <button
                  aria-label={`clear slot ${i + 1}`}
                  data-testid={`skill-slot-clear-${loadout}-${i}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    equip(loadout, i, null);
                  }}
                  style={{ position: 'absolute', top: 1, right: 2, border: 'none', background: 'none', color: DIM, cursor: 'pointer', fontSize: 11, padding: 0 }}
                >
                  x
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- a spell tree tab ----

const STATE_STYLE: Record<NodeState['status'], { opacity: number }> = {
  learned: { opacity: 1 },
  learnable: { opacity: 1 },
  noPoints: { opacity: 0.9 },
  needsLevel: { opacity: 0.62 },
  needsPrereq: { opacity: 0.4 },
};

function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ref]);
  return size;
}

function TreeGraph({ layout, c, picked, onHover }: { layout: TreeLayout; c: Char; picked: string | null; onHover: (k: string | null, r?: DOMRect) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const color = ELEMENT_COLOR[layout.tree] ?? GOLD;
  const ncol = layout.cols.length;
  const colW = w / Math.max(1, ncol);
  const headH = 30;
  // Lanes at most 104 px apart, the graph centred vertically (Lightning has two lanes, Earth seven).
  const laneH = Math.min(104, (h - headH) / Math.max(1, layout.lanes));
  const top = headH + Math.max(0, (h - headH - laneH * layout.lanes) / 2);
  const nodeW = Math.max(56, Math.min(132, colW - 10));
  const nodeH = Math.max(34, Math.min(50, laneH - 10));
  const pos = new Map(layout.nodes.map((n) => [n.key, { x: (n.col + 0.5) * colW, y: top + (n.lane + 0.5) * laneH }]));
  const states = new Map(layout.nodes.map((n) => [n.key, nodeState(layout.tree, n.key, c.knownSet, c.level, c.free)]));
  const small = colW < 92;
  return (
    <div ref={ref} data-testid={`skill-tree-${layout.tree}`} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 300 }}>
      {w > 0 && (
        <>
          {layout.cols.map((col, i) => {
            const locked = c.level < col.level;
            return (
              <div key={col.tier} style={{ position: 'absolute', left: i * colW, top: 0, width: colW, height: '100%', borderLeft: i ? '1px solid rgba(255,255,255,0.04)' : undefined, background: locked ? 'rgba(0,0,0,0.18)' : undefined }}>
                <div style={{ textAlign: 'center', fontSize: small ? 10 : 11, color: locked ? '#ff8787' : DIM, lineHeight: '13px', paddingTop: 2 }}>
                  Tier {col.tier}
                  <br />
                  <span style={{ fontSize: 10, opacity: 0.85 }}>{col.level > 1 ? `level ${col.level}` : 'any level'}</span>
                </div>
              </div>
            );
          })}
          <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
            {layout.edges.map((e) => {
              const a = pos.get(e.from)!;
              const b = pos.get(e.to)!;
              const fromLearned = c.knownSet.has(e.from);
              const toLearned = c.knownSet.has(e.to);
              const stroke = fromLearned && toLearned ? color : fromLearned ? color : 'rgba(255,255,255,0.22)';
              const op = fromLearned && toLearned ? 0.95 : fromLearned ? 0.6 : 1;
              let d: string;
              if (e.sameCol) {
                const dir = b.y > a.y ? 1 : -1;
                const x = a.x - nodeW / 2 + 6;
                d = `M ${x} ${a.y + (dir * nodeH) / 2} C ${x - 14} ${a.y + dir * nodeH} ${x - 14} ${b.y - dir * nodeH} ${x} ${b.y - (dir * nodeH) / 2}`;
              } else {
                const x1 = a.x + nodeW / 2;
                const x2 = b.x - nodeW / 2;
                const mx = (x1 + x2) / 2;
                d = `M ${x1} ${a.y} C ${mx} ${a.y} ${mx} ${b.y} ${x2} ${b.y}`;
              }
              return <path key={`${e.from}-${e.to}`} d={d} fill="none" stroke={stroke} strokeOpacity={op} strokeWidth={fromLearned && toLearned ? 2.5 : 1.5} strokeDasharray={fromLearned && !toLearned ? '5 4' : undefined} />;
            })}
          </svg>
          {layout.nodes.map((n) => {
            const st = states.get(n.key)!;
            const s = spellByKey.get(n.key)!;
            const p = pos.get(n.key)!;
            const learned = st.status === 'learned';
            const ready = st.status === 'learnable';
            const passive = s.type === 'passive';
            const sel = picked === n.key;
            const drag = learned && castable(n.key);
            return (
              <div
                key={n.key}
                data-testid={`skill-node-${n.key}`}
                data-state={st.status}
                draggable={drag}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/x-lodestone-spell', n.key);
                  e.dataTransfer.setData('text/plain', n.key);
                  onHover(null);
                }}
                onMouseEnter={(e) => onHover(n.key, e.currentTarget.getBoundingClientRect())}
                onMouseLeave={() => onHover(null)}
                onClick={() => useSkillScreen.setState({ picked: sel ? null : n.key })}
                onDoubleClick={() => ready && c.online && learn(n.key)}
                style={{
                  position: 'absolute',
                  left: p.x - nodeW / 2,
                  top: p.y - nodeH / 2,
                  width: nodeW,
                  height: nodeH,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  textAlign: 'center',
                  padding: '2px 4px',
                  borderRadius: passive ? nodeH / 2 : 6,
                  cursor: drag ? 'grab' : 'pointer',
                  opacity: STATE_STYLE[st.status].opacity,
                  background: learned ? `${color}38` : ready ? 'rgba(255,209,102,0.10)' : 'rgba(20,22,30,0.95)',
                  border: `${learned || ready || sel ? 2 : 1}px ${st.status === 'noPoints' ? 'dashed' : 'solid'} ${sel ? '#ffffff' : ready ? GOLD : learned ? color : st.status === 'noPoints' ? `${color}aa` : 'rgba(255,255,255,0.25)'}`,
                  boxShadow: ready ? `0 0 10px ${GOLD}88` : learned ? `0 0 8px ${color}55` : undefined,
                  animation: ready ? 'skPulse 1.6s ease-in-out infinite' : undefined,
                  font: `${small ? 10.5 : 12}px/1.15 system-ui, sans-serif`,
                  color: learned ? '#ffffff' : INK,
                  userSelect: 'none',
                }}
              >
                <span style={{ fontStyle: passive ? 'italic' : undefined, overflow: 'hidden', maxHeight: '2.3em' }}>{spellName(n.key)}</span>
                <span style={{ fontSize: small ? 9 : 10, color: learned ? color : ready ? GOLD : DIM, lineHeight: 1.1 }}>
                  {learned ? (passive ? 'passive' : s.type === 'mobility' ? 'dash' : 'learned') : ready ? '+ learn' : st.status === 'needsLevel' ? `level ${st.needsLevel}` : st.status === 'noPoints' ? 'no points' : passive ? 'passive' : 'locked'}
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function TreeTab({ tree, c }: { tree: string; c: Char }) {
  const def = treeByKey.get(tree)!;
  const layout = useMemo(() => layoutTree(def), [def]);
  const picked = useSkillScreen((s) => s.picked);
  const [hover, setHover] = useState<{ k: string; r: DOMRect } | null>(null);
  const pickedInTree = picked && spellByKey.get(picked) ? picked : null;
  const pickedState = pickedInTree ? nodeState(spellByKey.get(pickedInTree)!.tree, pickedInTree, c.knownSet, c.level, c.free) : null;
  const color = ELEMENT_COLOR[tree] ?? GOLD;
  const counts = learnedCounts(c.known)[tree];
  const mults = treeDamageMults(c.known).find((m) => m.tree === tree);
  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4, fontSize: 12, color: DIM, flexWrap: 'wrap' }}>
          <span style={{ font: '18px Georgia, serif', color }}>{cap(tree)}</span>
          <span>
            {counts.learned} of {counts.total} learned
          </span>
          {def.killsDemons && <span style={{ color: GOLD }}>The anti-demon school: Light damage kills demons</span>}
          {mults && (
            <span>
              {cap(tree)} spells x{mults.mult.toFixed(2)} from {mults.from.join(', ')}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>Prerequisites: any one arrow in unlocks a node</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <TreeGraph layout={layout} c={c} picked={picked} onHover={(k, r) => setHover(k && r ? { k, r } : null)} />
        </div>
        <Legend color={color} />
      </div>
      <div style={{ width: 'clamp(250px, 22vw, 330px)', flex: 'none', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
        <div style={CARD}>
          <H right="drag a learned spell here">Spell slots</H>
          {[c.activeLoadout, 1 - c.activeLoadout].map((l) => (
            <SlotRow key={l} c={c} loadout={l} picked={pickedInTree} />
          ))}
          <div style={{ fontSize: 11, color: DIM }}>Cast with 1-4 or the wheel + right mouse. X swaps loadouts.</div>
        </div>
        <div style={{ ...CARD, flex: 'none' }} data-testid="skill-picked">
          {pickedInTree && pickedState ? (
            <>
              <SpellCard k={pickedInTree} st={pickedState} c={c} />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {pickedState.status === 'learnable' && (
                  <button data-testid="skill-learn" disabled={!c.online} onClick={() => learn(pickedInTree)} style={{ ...BTN, borderColor: GOLD, background: 'rgba(255,209,102,0.25)', fontWeight: 600 }}>
                    Learn · 1 skill point
                  </button>
                )}
                {pickedState.status === 'learned' && castable(pickedInTree) && (
                  <>
                    <span style={{ fontSize: 11, color: DIM, alignSelf: 'center' }}>Put in slot:</span>
                    {[0, 1, 2, 3].map((i) => (
                      <button key={i} data-testid={`skill-assign-${i}`} disabled={!c.online} onClick={() => equip(c.activeLoadout, i, pickedInTree)} style={{ ...BTN, padding: '4px 10px' }}>
                        {i + 1}
                      </button>
                    ))}
                  </>
                )}
              </div>
              {!c.online && <div style={{ fontSize: 11, color: '#ffc078', marginTop: 6 }}>Offline: connect to a zone to learn and slot spells.</div>}
            </>
          ) : (
            <div style={{ fontSize: 12, color: DIM, lineHeight: 1.5 }}>
              Click a node to see it here. <span style={{ color: GOLD }}>Gold</span> nodes can be learned now (Learn, or double-click). A learned spell can be dragged onto a slot, or picked and then placed with a click on the slot.
            </div>
          )}
        </div>
      </div>
      {hover && hover.k !== pickedInTree && <HoverCard k={hover.k} r={hover.r} c={c} />}
    </div>
  );
}

function HoverCard({ k, r, c }: { k: string; r: DOMRect; c: Char }) {
  const s = spellByKey.get(k);
  if (!s) return null;
  const st = nodeState(s.tree, k, c.knownSet, c.level, c.free);
  const W = 290;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
  const left = r.right + 10 + W < vw ? r.right + 10 : Math.max(8, r.left - 10 - W);
  const top = Math.max(8, Math.min(vh - 300, r.top - 10));
  return (
    <div data-testid="skill-tooltip" style={{ ...PANEL, position: 'fixed', left, top, width: W, padding: '10px 12px', zIndex: 60, pointerEvents: 'none', borderColor: `${ELEMENT_COLOR[s.tree] ?? GOLD}88` }}>
      <SpellCard k={k} st={st} c={c} compact />
    </div>
  );
}

function Legend({ color }: { color: string }) {
  const item = (label: string, style: CSSProperties) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ display: 'inline-block', width: 18, height: 11, borderRadius: 3, boxSizing: 'border-box', ...style }} />
      {label}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: DIM, marginTop: 4 }}>
      {item('learned', { background: `${color}38`, border: `2px solid ${color}` })}
      {item('learnable now', { background: 'rgba(255,209,102,0.1)', border: `2px solid ${GOLD}` })}
      {item('no free point', { border: `1px dashed ${color}aa` })}
      {item('needs level', { border: '1px solid rgba(255,255,255,0.25)', opacity: 0.62 })}
      {item('needs a prerequisite', { border: '1px solid rgba(255,255,255,0.25)', opacity: 0.4 })}
      {item('passive', { border: '1px solid rgba(255,255,255,0.4)', borderRadius: 6 })}
    </div>
  );
}

// ---- weapon skills tab ----

function SkillsTab({ c }: { c: Char }) {
  const gemEl = c.view.loadouts[c.activeLoadout]?.form?.element ?? '';
  return (
    <div style={{ overflowY: 'auto', height: '100%' }} data-testid="skill-tab-skills">
      <div style={{ fontSize: 12, color: DIM, marginBottom: 8 }}>Weapon skills grow by use, 1 to 100, and are never gated by character level. Every 10 levels unlocks a technique.</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 10 }}>
        {COMBAT.skills.list.map((sk) => {
          const p = skillProgress(c.skillXp[sk.key] ?? 0);
          return (
            <div key={sk.key} style={CARD} data-testid={`weapon-skill-${sk.key}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: '16px Georgia, serif' }}>{SKILL_NAMES[sk.key] ?? sk.key}</span>
                <span style={{ font: '700 20px Georgia, serif', color: GOLD }}>{p.level}</span>
              </div>
              <Bar frac={p.frac} color={GOLD} />
              <div style={{ fontSize: 11, color: DIM, margin: '3px 0 6px' }}>
                {p.max ? 'Mastered' : `${p.into} / ${p.span} XP to ${p.level + 1}`} · {SKILL_EFFECT[sk.key]}
              </div>
              {sk.techniques.length === 0 && <div style={{ fontSize: 12, color: DIM }}>No techniques: this skill pays off through its level.</div>}
              {sk.techniques.map((t) => {
                const has = p.level >= t.level;
                const info = TECHNIQUE_INFO[t.key];
                return (
                  <div key={t.key} style={{ display: 'flex', gap: 8, fontSize: 12, padding: '2px 0', opacity: has ? 1 : 0.6 }}>
                    <span style={{ width: 40, flex: 'none', color: has ? '#8ce99a' : DIM }}>{has ? 'have' : `lv ${t.level}`}</span>
                    <span>
                      <span style={{ color: has ? INK : undefined }}>{COMBAT.names[t.key] ?? t.name}</span>
                      {info && <span style={{ color: DIM }}> · {info.text}</span>}
                      {info && !info.active && <Tag>not in effect yet</Tag>}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ ...CARD, marginTop: 10 }}>
        <H right="Swordsmanship or Spearmanship 30 + an elemental gem socketed in the weapon · Q">Elemental forms</H>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
          {COMBAT.forms.map((f) => {
            const el = COMBAT.elements[f.element] ?? f.key;
            const mine = el === gemEl;
            return (
              <div key={f.key} style={{ padding: '5px 8px', borderRadius: 4, border: `1px solid ${mine ? ELEMENT_COLOR[el] : 'rgba(255,255,255,0.1)'}`, fontSize: 12 }}>
                <span style={{ color: ELEMENT_COLOR[el] }}>{COMBAT.names[`form_${f.key}`] ?? f.name}</span>
                <span style={{ color: DIM }}>
                  {' '}
                  · {cap(el)} · {f.damage} dmg{f.status ? ` · ${f.status}` : ''}
                  {f.killsDemons ? ' · kills demons' : ''}
                </span>
                {mine && <Tag color={GOLD}>your gem</Tag>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---- build tab ----

function Stat({ s }: { s: StatLine }) {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid={`build-stat-${s.key}`} style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div onClick={() => setOpen(!open)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', cursor: 'pointer' }}>
        <span style={{ fontSize: 12.5 }}>{s.label}</span>
        <span style={{ font: '600 14px system-ui, sans-serif', color: GOLD }}>
          {fmt(s.total, s.unit, s.unit === 'pct')}
          {s.zone !== undefined && <span style={{ fontSize: 10, color: DIM, fontWeight: 400 }}> (zone says {Math.round(s.zone)})</span>}
        </span>
      </div>
      {s.note && <div style={{ fontSize: 10.5, color: DIM }}>{s.note}</div>}
      {open &&
        s.parts.map((p, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: p.inactive ? 'rgba(241,243,245,0.4)' : DIM, paddingLeft: 10 }}>
            <span>{p.from}</span>
            <span style={{ whiteSpace: 'nowrap', color: p.inactive ? undefined : 'rgba(241,243,245,0.85)' }}>{p.text ?? fmt(p.value, s.unit === 'perS' ? 'mult' : s.unit, true)}</span>
          </div>
        ))}
      {open && s.parts.length === 0 && <div style={{ fontSize: 11, color: 'rgba(241,243,245,0.4)', paddingLeft: 10 }}>nothing yet</div>}
    </div>
  );
}

function GearSlot({ v }: { v: SlotView }) {
  return (
    <div data-testid={`build-slot-${v.slot}`} style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 10.5, color: DIM, textTransform: 'uppercase', letterSpacing: 0.6 }}>{v.label}</div>
      <div style={{ color: v.item ? v.color : DIM, fontSize: 13.5 }}>
        {v.name}
        {v.killsDemons && <Tag color={GOLD}>kills demons</Tag>}
        {v.stagger && <Tag color="#c0c8d8">staggers demons</Tag>}
      </div>
      {v.sub && <div style={{ fontSize: 11, color: DIM }}>{v.sub}</div>}
      {v.lines.map((l, i) => (
        <div key={i} style={{ fontSize: 11.5 }}>
          {l}
        </div>
      ))}
      {(v.sockets.length > 0 || v.emptySockets > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 3, fontSize: 11.5 }}>
          {v.sockets.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, transform: 'rotate(45deg)', background: s.color, display: 'inline-block', boxShadow: `0 0 5px ${s.color}` }} />
              {s.name} <span style={{ color: DIM }}>· {s.effect}</span>
            </span>
          ))}
          {Array.from({ length: v.emptySockets }, (_, i) => (
            <span key={`e${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: DIM }}>
              <span style={{ width: 9, height: 9, transform: 'rotate(45deg)', border: '1px solid rgba(255,255,255,0.4)', display: 'inline-block' }} />
              empty socket
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function LoadoutCol({ lo }: { lo: LoadoutView }) {
  return (
    <div data-testid={`build-loadout-${lo.index}`} style={{ ...CARD, borderColor: lo.active ? 'rgba(255,209,102,0.45)' : CARD.border as string, minWidth: 0 }}>
      <H right={lo.active ? 'active · X swaps' : 'X swaps'}>Loadout {lo.index + 1}</H>
      {lo.training ? (
        <div style={{ padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ fontSize: 10.5, color: DIM, textTransform: 'uppercase', letterSpacing: 0.6 }}>Main hand</div>
          <div style={{ fontSize: 13.5 }}>Training {lo.weapon}</div>
          <div style={{ fontSize: 11, color: DIM }}>No item equipped: the starting kit. Equip a weapon in the inventory (I).</div>
        </div>
      ) : (
        <GearSlot v={lo.main} />
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, margin: '8px 0' }}>
        {lo.spells.map((s) => (
          <div key={s.slot} style={{ fontSize: 11.5, padding: '3px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.3)', border: `1px solid ${s.key ? `${ELEMENT_COLOR[s.tree] ?? INK}66` : 'rgba(255,255,255,0.08)'}`, color: s.key ? (ELEMENT_COLOR[s.tree] ?? INK) : DIM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: GOLD }}>{s.slot + 1}</span> {s.key ? s.name : 'empty'}
          </div>
        ))}
      </div>
      {lo.stats.map((s) => (
        <Stat key={s.key} s={s} />
      ))}
      <div style={{ fontSize: 12, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ color: DIM }}>Elemental form: </span>
        {lo.form ? (
          <span style={{ color: ELEMENT_COLOR[lo.form.element] }}>
            {lo.form.name} ({cap(lo.form.element)}) {lo.form.unlocked ? `· about ${lo.form.damage} damage` : <span style={{ color: '#ff8787' }}>· {lo.form.need}</span>}
          </span>
        ) : (
          <span style={{ color: DIM }}>none (socket an elemental gem)</span>
        )}
      </div>
      <div style={{ fontSize: 12, paddingTop: 5, color: lo.demons.startsWith('Nothing') ? '#ffc078' : GOLD }}>{lo.demons}</div>
    </div>
  );
}

function BuildTab({ c }: { c: Char }) {
  const v = c.view;
  const mults = treeDamageMults(c.known);
  const noInv = !useInventory((s) => s.inv);
  return (
    <div data-testid="skill-tab-build" style={{ height: '100%', overflowY: 'auto' }}>
      {noInv && <div style={{ fontSize: 12, color: '#ffc078', marginBottom: 6 }}>No inventory from a zone yet (offline): gear shows as empty.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(480px, 2fr) minmax(260px, 1fr)', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={CARD}>
            <H right={`level ${v.level}`}>Character</H>
            {v.character.map((s) => (
              <Stat key={s.key} s={s} />
            ))}
          </div>
          <div style={CARD} data-testid="build-points">
            <H right={`${v.points.spent} spent · ${v.points.free} unspent`}>Skill points</H>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
              <span style={{ font: '700 22px Georgia, serif', color: v.points.free > 0 ? GOLD : INK }}>{v.points.free}</span>
              <span style={{ fontSize: 12, color: DIM }}>unspent of {v.points.total}</span>
              {v.points.free > 0 && (
                <button style={{ ...BTN, marginLeft: 'auto' }} onClick={() => setSkillTab(useSkillScreen.getState().lastTree)}>
                  Spend in the trees
                </button>
              )}
            </div>
            {v.points.parts.map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: DIM, paddingLeft: 10 }}>
                <span>{p.from}</span>
                <span>+{p.value}</span>
              </div>
            ))}
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '3px 8px', alignItems: 'center', fontSize: 11.5 }}>
              {v.points.perTree.map((t) => (
                <TreeCount key={t.tree} tree={t.tree} learned={t.learned} total={t.total} />
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: DIM, marginTop: 6 }}>Known spells per tree, the three starting spells included. Each node beyond them took a skill point or a tome.</div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {v.loadouts.map((lo) => (
            <LoadoutCol key={lo.index} lo={lo} />
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={CARD}>
            <H right="both loadouts">Armor</H>
            {v.armor.map((a) => (
              <GearSlot key={a.slot} v={a} />
            ))}
          </div>
          <div style={CARD} data-testid="build-passives">
            <H right={`${v.passives.length} learned`}>Passives</H>
            {mults.map((m) => (
              <div key={m.tree} style={{ fontSize: 12, padding: '2px 0' }}>
                <span style={{ color: ELEMENT_COLOR[m.tree] }}>{cap(m.tree)} spells x{m.mult.toFixed(2)}</span>
                <span style={{ color: DIM }}> · {m.from.join(', ')}</span>
              </div>
            ))}
            {v.passives.length === 0 && <div style={{ fontSize: 12, color: DIM }}>None yet: passives in the trees work without a slot.</div>}
            {v.passives.map((p) => (
              <div key={p.key} style={{ fontSize: 12, padding: '3px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <span style={{ color: ELEMENT_COLOR[p.tree] }}>{p.name}</span>
                {p.lines.map((l, i) => (
                  <div key={i} style={{ fontSize: 11.5, color: l.active ? INK : DIM, paddingLeft: 8 }}>
                    {l.text}
                    {!l.active && <Tag>not in effect yet</Tag>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={CARD}>
            <H>Elements and statuses</H>
            {v.elemental.length === 0 && <div style={{ fontSize: 12, color: DIM }}>Nothing elemental yet.</div>}
            {v.elemental.map((l, i) => (
              <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                {l}
              </div>
            ))}
          </div>
          <div style={CARD}>
            <H right="grow by use">Weapon skills</H>
            {v.skills.map((s) => (
              <div key={s.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '1px 0' }}>
                <span style={{ color: DIM }}>{SKILL_NAMES[s.key]}</span>
                <span>{s.level}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeCount({ tree, learned, total }: { tree: string; learned: number; total: number }) {
  const color = ELEMENT_COLOR[tree] ?? INK;
  return (
    <>
      <span style={{ color }}>{cap(tree)}</span>
      <Bar frac={learned / Math.max(1, total)} color={color} />
      <span style={{ color: DIM }}>
        {learned}/{total}
      </span>
    </>
  );
}

// ---- the screen ----

function Tabs({ c, tab }: { c: Char; tab: string }) {
  const counts = learnedCounts(c.known);
  const learnableIn = (tree: string) => treeByKey.get(tree)!.nodes.some((n) => nodeState(tree, n.key, c.knownSet, c.level, c.free).status === 'learnable');
  const tabBtn = (key: string, label: ReactNode, color: string, extra?: ReactNode) => (
    <button
      key={key}
      data-testid={`skill-tab-btn-${key}`}
      onClick={() => setSkillTab(key)}
      style={{
        font: '13px system-ui, sans-serif',
        padding: '5px 10px 6px',
        border: 'none',
        borderBottom: `3px solid ${tab === key ? color : 'transparent'}`,
        background: tab === key ? 'rgba(255,255,255,0.07)' : 'transparent',
        color: tab === key ? '#fff' : 'rgba(241,243,245,0.75)',
        cursor: 'pointer',
        borderRadius: '4px 4px 0 0',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      {extra}
    </button>
  );
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid rgba(255,255,255,0.1)', overflowX: 'auto', flex: 'none' }}>
      {TREE_ORDER.map((t) =>
        tabBtn(
          t,
          <>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: ELEMENT_COLOR[t], marginRight: 6, verticalAlign: 'middle' }} />
            {cap(t)}
          </>,
          ELEMENT_COLOR[t] ?? GOLD,
          <span style={{ fontSize: 10.5, color: learnableIn(t) ? GOLD : DIM, marginLeft: 5 }}>
            {counts[t].learned}/{counts[t].total}
            {learnableIn(t) ? ' +' : ''}
          </span>,
        ),
      )}
      <span style={{ width: 1, background: 'rgba(255,255,255,0.15)', margin: '4px 6px' }} />
      {tabBtn('skills', 'Weapon skills', GOLD)}
      {tabBtn('build', 'Build', GOLD)}
    </div>
  );
}

const CSS = `@keyframes skPulse { 0%, 100% { box-shadow: 0 0 6px rgba(255,209,102,0.45) } 50% { box-shadow: 0 0 14px rgba(255,209,102,0.95) } }`;

function Screen() {
  const tab = useSkillScreen((s) => s.tab);
  const c = useChar();
  const name = c.view.loadouts[c.activeLoadout]?.weaponName;
  return (
    <div
      data-testid="skill-screen"
      data-ui-panel
      onContextMenu={(e) => e.preventDefault()}
      style={{ ...PANEL, position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(1640px, calc(100vw - 24px))', height: 'min(940px, calc(100vh - 24px))', boxSizing: 'border-box', padding: '10px 16px 8px', zIndex: 45, display: 'flex', flexDirection: 'column', font: '13px system-ui, sans-serif', pointerEvents: 'auto' }}
    >
      <style>{CSS}</style>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flex: 'none', marginBottom: 4 }}>
        <span style={{ font: '22px Georgia, serif' }}>{tab === 'build' ? 'Build' : tab === 'skills' ? 'Weapon skills' : 'Skill tree'}</span>
        <span style={{ color: DIM, fontSize: 12 }}>
          Level {c.level} · loadout {c.activeLoadout + 1}: {name}
        </span>
        <span data-testid="skill-points" style={{ marginLeft: 'auto', font: '600 14px system-ui, sans-serif', color: c.free > 0 ? GOLD : DIM }}>
          {c.free} skill point{c.free === 1 ? '' : 's'} to spend
          <span style={{ fontWeight: 400, color: DIM, fontSize: 12 }}> · {c.total - c.free} spent of {c.total}</span>
        </span>
        <button aria-label="close" onClick={closeSkillScreen} style={{ ...BTN, padding: '2px 10px' }}>
          Esc
        </button>
      </div>
      <Tabs c={c} tab={tab} />
      <div style={{ flex: 1, minHeight: 0, paddingTop: 8 }}>
        {tab === 'build' ? <BuildTab c={c} /> : tab === 'skills' ? <SkillsTab c={c} /> : treeByKey.has(tab) ? <TreeTab key={tab} tree={tab} c={c} /> : null}
      </div>
      <div style={{ flex: 'none', fontSize: 11, color: DIM, paddingTop: 4, textAlign: 'center' }}>N skill tree · B build · C character · I inventory · Esc close{!c.online ? ' · offline: learning and slotting need a zone' : ''}</div>
    </div>
  );
}

function useSkillKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextTarget(e.target) || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyN' || e.code === 'KeyB') {
        toggleSkillScreen(e.code === 'KeyB' ? 'build' : undefined);
        if (useSkillScreen.getState().open) setPanelOpen(false);
      } else if (useSkillScreen.getState().open && (e.code === 'Escape' || e.code === 'KeyC' || e.code === 'KeyI' || e.code === 'KeyM' || e.code === 'KeyJ')) {
        closeSkillScreen(); // another screen takes over (or Esc)
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Mounted by the play screen next to the progression HUD. */
export function SkillScreen() {
  const open = useSkillScreen((s) => s.open);
  useSkillKeys();
  useEffect(() => {
    if (DEBUG) return installSkillsDebug();
  }, []);
  return open ? <Screen /> : null;
}

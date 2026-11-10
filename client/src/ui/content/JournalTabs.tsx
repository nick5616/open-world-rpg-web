// The journal's content tabs (J; playtest 2, CR 023): the bestiary (codex
// entries unlocked on a creature's first kill: stats from the combat
// tables, weaknesses from the element table, lore from content.yaml), the
// lore tablets read, feats and titles (choose the one on your nameplate),
// and renown with each town (better stock at higher tiers).

import { useEffect, useState } from 'react';
import { COMBAT, CONTENT } from '@lodestone/contracts';
import { codexEntries, useContent } from './store';

const GOLD = '#ffd166';
const ELEMENTS = ['fire', 'ice', 'lightning', 'earth', 'wind', 'light', 'dark', 'void'];

export type JournalTab = 'quests' | 'bestiary' | 'lore' | 'feats' | 'renown';
export const JOURNAL_TABS: { key: JournalTab; label: string }[] = [
  { key: 'quests', label: 'Quests' },
  { key: 'bestiary', label: 'Bestiary' },
  { key: 'lore', label: 'Lore' },
  { key: 'feats', label: 'Feats' },
  { key: 'renown', label: 'Renown' },
];

/** What an element is strong and weak against (combat.yaml effectiveness). */
export function weaknesses(element: number): { weakTo: string[]; resists: string[] } {
  if (element >= 8 || element < 0) return { weakTo: [], resists: [] };
  const name = ELEMENTS[element];
  const pairs = (COMBAT.effectiveness as unknown as { pairs: Record<string, number[]> }).pairs ?? {};
  const weakTo = Object.entries(pairs)
    .filter(([, targets]) => targets.includes(element))
    .map(([att]) => ELEMENTS[Number(att)]);
  if (name !== 'void') weakTo.push('void (a little)');
  return { weakTo, resists: [name] };
}

const btn = (on: boolean): React.CSSProperties => ({ font: '600 12px system-ui', padding: '4px 10px', borderRadius: 4, border: `1px solid ${on ? '#e0b44c' : '#6b5a3c'}`, background: on ? '#7a5a1c' : '#2c261d', color: '#f6e7c0', cursor: 'pointer' });

function Bestiary() {
  const sync = useContent((s) => s.sync);
  const entries = codexEntries(sync);
  const [sel, setSel] = useState<string | null>(null);
  const known = entries.filter((e) => e.unlocked);
  const cur = entries.find((e) => e.key === sel) ?? known[0] ?? null;
  const def = cur ? COMBAT.enemies.find((e) => e.id === cur.enemyId) : null;
  return (
    <div data-testid="journal-bestiary" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) 1fr', gap: 12, height: '100%' }}>
      <div style={{ overflowY: 'auto', borderRight: '1px solid rgba(255,209,102,0.2)', paddingRight: 6 }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{known.length} of {entries.length} creatures</div>
        {[...known, ...entries.filter((e) => !e.unlocked)].map((e) => (
          <div key={e.key} onClick={() => e.unlocked && setSel(e.key)} style={{ padding: '3px 6px', borderRadius: 3, fontSize: 13, cursor: e.unlocked ? 'pointer' : 'default', opacity: e.unlocked ? 1 : 0.35, background: cur?.key === e.key ? 'rgba(255,209,102,0.15)' : 'transparent' }}>
            {e.unlocked ? (COMBAT.enemies.find((x) => x.id === e.enemyId)?.name ?? e.key) : '???'}
          </div>
        ))}
      </div>
      <div style={{ overflowY: 'auto' }}>
        {!cur && <div style={{ opacity: 0.7, fontSize: 13 }}>Defeat a creature to add it to your bestiary.</div>}
        {cur && def && (
          <div data-testid="codex-entry">
            <div style={{ font: '600 20px Georgia, serif', color: '#f6e7c0' }}>{def.name}</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{def.family[0].toUpperCase() + def.family.slice(1)} · {cur.habitat}</div>
            <p style={{ fontSize: 13, fontStyle: 'italic', color: '#e6d6ae' }}>{cur.lore}</p>
            <table style={{ fontSize: 13, borderSpacing: '10px 2px' }}>
              <tbody>
                <tr><td style={{ opacity: 0.7 }}>Defeated</td><td style={{ color: GOLD }}>{cur.kills}</td></tr>
                <tr><td style={{ opacity: 0.7 }}>Health (level 1)</td><td>{def.hp}</td></tr>
                <tr><td style={{ opacity: 0.7 }}>Speed</td><td>{def.speed} m/s</td></tr>
                <tr><td style={{ opacity: 0.7 }}>Element</td><td style={{ textTransform: def.element < 8 ? 'capitalize' : 'none' }}>{def.element < 8 ? ELEMENTS[def.element] : 'None (an elite takes the land\'s element)'}</td></tr>
                {def.element < 8 && (
                  <>
                    <tr><td style={{ opacity: 0.7 }}>Weak to</td><td style={{ color: '#9fe08a', textTransform: 'capitalize' }}>{weaknesses(def.element).weakTo.join(', ')}</td></tr>
                    <tr><td style={{ opacity: 0.7 }}>Resists</td><td style={{ color: '#ff9a7a', textTransform: 'capitalize' }}>{weaknesses(def.element).resists.join(', ')}</td></tr>
                  </>
                )}
                {def.family === 'demon' && <tr><td style={{ opacity: 0.7 }}>Bane</td><td style={{ color: '#ffe08a' }}>Sunsteel, Light magic, the sunrise</td></tr>}
                <tr><td style={{ opacity: 0.7 }}>Attacks</td><td>{def.attacks.length}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Lore() {
  const read = useContent((s) => s.sync.tablets);
  const [sel, setSel] = useState<number | null>(null);
  const cur = CONTENT.tablets.find((t) => t.id === (sel ?? read[0]));
  return (
    <div data-testid="journal-lore" style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 210px) 1fr', gap: 12, height: '100%' }}>
      <div style={{ overflowY: 'auto', borderRight: '1px solid rgba(255,209,102,0.2)', paddingRight: 6 }}>
        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{read.length} of {CONTENT.tablets.length} tablets</div>
        {CONTENT.tablets.map((t) => (
          <div key={t.id} onClick={() => read.includes(t.id) && setSel(t.id)} style={{ padding: '3px 6px', fontSize: 13, opacity: read.includes(t.id) ? 1 : 0.35, cursor: read.includes(t.id) ? 'pointer' : 'default', background: cur?.id === t.id ? 'rgba(255,209,102,0.15)' : 'transparent', borderRadius: 3 }}>
            {read.includes(t.id) ? t.title : '???'}
          </div>
        ))}
      </div>
      <div style={{ overflowY: 'auto' }}>
        {!cur || !read.includes(cur.id) ? (
          <div style={{ opacity: 0.7, fontSize: 13 }}>Lore tablets stand at ruins, shrines and old watchtowers. Read one with E.</div>
        ) : (
          <>
            <div style={{ font: '600 20px Georgia, serif', color: '#f6e7c0' }}>{cur.title}</div>
            <p style={{ font: '14px/1.6 Georgia, serif', color: '#e6d6ae' }}>{cur.text}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Feats() {
  const sync = useContent((s) => s.sync);
  const actions = useContent((s) => s.actions);
  return (
    <div data-testid="journal-feats" style={{ overflowY: 'auto', height: '100%' }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        {sync.feats.length} of {CONTENT.feats.length} feats · title: <span style={{ color: GOLD }}>{CONTENT.feats.find((f) => f.key === sync.title)?.title ?? 'none'}</span>
        {sync.title && <button style={{ ...btn(false), marginLeft: 8 }} disabled={!actions} onClick={() => actions?.title(0)}>Hide title</button>}
      </div>
      {CONTENT.feats.map((f) => {
        const has = sync.feats.includes(f.key);
        const p = Math.min(f.n, sync.progress[f.key] ?? 0);
        return (
          <div key={f.key} data-testid={`feat-${f.key}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid rgba(255,209,102,0.08)', opacity: has ? 1 : 0.7 }}>
            <div style={{ width: 18, color: has ? GOLD : '#666' }}>{has ? '★' : '☆'}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{f.name}{f.title ? <span style={{ fontWeight: 400, color: '#d9c79c' }}> · title "{f.title}"</span> : null}</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>{f.desc}{!has && f.n > 1 ? ` (${p}/${f.n})` : ''}{f.gold ? ` · ${f.gold} gold` : ''}</div>
            </div>
            {has && f.title && (
              <button style={btn(sync.title === f.key)} disabled={!actions || sync.title === f.key} onClick={() => actions?.title(f.id)}>
                {sync.title === f.key ? 'Shown' : 'Show'}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Renown() {
  const rep = useContent((s) => s.sync.rep);
  const tiers = CONTENT.reputation.tiers;
  return (
    <div data-testid="journal-renown" style={{ overflowY: 'auto', height: '100%', fontSize: 13 }}>
      <p style={{ opacity: 0.75, marginTop: 0 }}>Help townsfolk with their requests to earn renown. Merchants and smiths keep better stock for those they know: {tiers.slice(1).map((t) => `${t.name} at ${t.min}`).join(', ')}.</p>
      {rep.length === 0 && <div style={{ opacity: 0.7 }}>No town knows your name yet.</div>}
      {rep.map((r) => {
        const next = tiers[r.tier + 1];
        const base = tiers[r.tier].min;
        const pct = next ? ((r.rep - base) / (next.min - base)) * 100 : 100;
        return (
          <div key={r.town} style={{ margin: '6px 0' }}>
            <div>
              <b>{r.name}</b> · <span style={{ color: GOLD }}>{tiers[r.tier].name}</span> <span style={{ opacity: 0.6 }}>({r.rep}{next ? ` / ${next.min}` : ''})</span>
            </div>
            <div style={{ height: 5, background: 'rgba(0,0,0,0.5)', borderRadius: 3, width: 260 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: '#8fd3ff', borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function JournalTabBar({ tab, setTab }: { tab: JournalTab; setTab: (t: JournalTab) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
      {JOURNAL_TABS.map((t) => (
        <button key={t.key} data-testid={`journal-tab-${t.key}`} style={btn(tab === t.key)} onClick={() => setTab(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The body of a content tab (asks the zone for fresh counts on open). */
export function JournalContentTab({ tab }: { tab: Exclude<JournalTab, 'quests'> }) {
  const actions = useContent((s) => s.actions);
  useEffect(() => {
    actions?.sync();
  }, [tab, actions]);
  switch (tab) {
    case 'bestiary':
      return <Bestiary />;
    case 'lore':
      return <Lore />;
    case 'feats':
      return <Feats />;
    case 'renown':
      return <Renown />;
  }
}

// The Achievements screen (playtest 2, CR 031; Y, the Esc menu, the
// character panel, the journal's Achievements tab): points, categories,
// progress bars, tier badges, filters (all / earned / unearned / hidden),
// search, recently earned, and the titles you can show on your nameplate.
// What it lists comes from model.ts over the content sync; it asks the zone
// for fresh counters on open and every few seconds while open.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { CONTENT } from '@lodestone/contracts';
import { useContent } from '../content/store';
import { BORDER, BORDER_GOLD, BTN_BG, GOLD, PANEL_BG, TEXT, TEXT_2, TEXT_3 } from '../spellcards/theme';
import { achList, catSummaries, fmt, points, recentEarned, titleText, type AchFilter, type AchView } from './model';
import { rewardLines } from './toasts';
import { setAchievementsOpen } from './store';

const SYNC_EVERY_MS = 5000;
const FILTERS: { key: AchFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'earned', label: 'Earned' },
  { key: 'unearned', label: 'Not yet' },
  { key: 'hidden', label: 'Hidden' },
];

const btn = (on: boolean): CSSProperties => ({ font: '600 12px system-ui, sans-serif', padding: '4px 10px', borderRadius: 4, border: `1px solid ${on ? BORDER_GOLD : BORDER}`, background: on ? '#4a3a12' : BTN_BG, color: TEXT, cursor: 'pointer' });

/** Ask the zone for fresh counters now and every few seconds while mounted. */
export function useAchievementSync(): void {
  const actions = useContent((s) => s.actions);
  useEffect(() => {
    actions?.sync();
    const id = setInterval(() => actions?.sync(), SYNC_EVERY_MS);
    return () => clearInterval(id);
  }, [actions]);
}

function TierBadge({ v }: { v: AchView }) {
  return (
    <div title={v.tierName} style={{ flex: 'none', width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', font: '700 11px Georgia, serif', color: v.earned ? '#1b1408' : TEXT_3, background: v.earned ? v.tierColor : 'transparent', border: `2px solid ${v.tierColor}`, opacity: v.earned ? 1 : 0.75 }}>
      {v.masked ? '?' : v.roman || v.tierName[0]}
    </div>
  );
}

function Row({ v, shown, onTitle }: { v: AchView; shown: boolean; onTitle?: (id: number) => void }) {
  const d = v.def;
  const rewards = v.masked ? [] : rewardLines({ gold: d.gold, xp: d.xp, title: d.title, item: d.item, qty: d.qty });
  return (
    <div data-testid={`ach-${d.key}`} data-earned={v.earned ? '1' : '0'} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
      <TierBadge v={v} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 13.5px Georgia, serif', color: v.earned ? TEXT : TEXT_2 }}>
          {v.name}
          {v.roman && !v.def.name.endsWith(` ${v.roman}`) && <span style={{ color: TEXT_3, fontWeight: 400 }}> · {v.roman}</span>}
          <span style={{ font: '11.5px system-ui, sans-serif', color: v.tierColor, marginLeft: 8 }}>
            {v.tierName} · {d.pts} pts
          </span>
        </div>
        <div style={{ fontSize: 12, color: v.masked ? TEXT_3 : TEXT_2, fontStyle: v.masked ? 'italic' : 'normal' }}>{v.desc}</div>
        {!v.earned && !v.masked && d.n > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
            <div data-testid={`ach-bar-${d.key}`} style={{ flex: '0 1 240px', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.round(v.pct * 100)}%`, height: '100%', background: v.tierColor }} />
            </div>
            <span style={{ fontSize: 11.5, color: TEXT_3 }}>
              {fmt(v.progress)} / {fmt(d.n)}
            </span>
          </div>
        )}
        {rewards.length > 0 && <div style={{ fontSize: 11.5, color: TEXT_3 }}>{rewards.join(' · ')}</div>}
      </div>
      {v.earned && d.title && onTitle && (
        <button data-testid={`ach-title-${d.key}`} style={btn(shown)} disabled={shown} onClick={() => onTitle(d.id)}>
          {shown ? 'Shown' : 'Show title'}
        </button>
      )}
      {v.earned && v.at > 0 && <div style={{ flex: 'none', fontSize: 11, color: TEXT_3, width: 72, textAlign: 'right' }}>{new Date(v.at).toLocaleDateString()}</div>}
    </div>
  );
}

/** The list with its categories, filters and search (the screen and the journal tab). */
export function AchievementsBody({ compact = false }: { compact?: boolean }) {
  const sync = useContent((s) => s.sync);
  const actions = useContent((s) => s.actions);
  const [cat, setCat] = useState(-1);
  const [filter, setFilter] = useState<AchFilter>('all');
  const [search, setSearch] = useState('');
  const rows = useMemo(() => achList(sync, { cat, filter, search }), [sync, cat, filter, search]);
  const cats = useMemo(() => catSummaries(sync), [sync]);
  const total = useMemo(() => points(sync), [sync]);
  const recent = useMemo(() => recentEarned(sync, 5), [sync]);
  const title = titleText(sync);
  const onTitle = actions ? (id: number) => actions.title(id) : undefined;
  return (
    <div data-testid="achievements-body" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: TEXT, font: '13px system-ui, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div data-testid="achievements-points" style={{ font: '700 18px Georgia, serif', color: GOLD }}>
          {fmt(total.earned)} <span style={{ font: '13px system-ui', color: TEXT_2 }}>/ {fmt(total.total)} points</span>
        </div>
        <div style={{ color: TEXT_2 }}>
          {total.count} of {total.of} earned
        </div>
        <div style={{ color: TEXT_2 }}>
          Title: <span style={{ color: GOLD }}>{title || 'none'}</span>
          {title && (
            <button data-testid="ach-title-none" style={{ ...btn(false), marginLeft: 8 }} disabled={!actions} onClick={() => actions?.title(0)}>
              Hide title
            </button>
          )}
        </div>
      </div>
      {!compact && recent.length > 0 && (
        <div data-testid="achievements-recent" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 2px', alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: TEXT_3, letterSpacing: 1, textTransform: 'uppercase' }}>Recently earned</span>
          {recent.map((v) => (
            <span key={v.def.key} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, border: `1px solid ${v.tierColor}`, color: TEXT }}>
              {v.name}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, margin: '8px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {FILTERS.map((f) => (
          <button key={f.key} data-testid={`ach-filter-${f.key}`} style={btn(filter === f.key)} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <input
          data-testid="achievements-search"
          type="search"
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: 'auto', width: 180, font: '13px system-ui, sans-serif', padding: '4px 8px', borderRadius: 4, border: `1px solid ${BORDER}`, background: '#10131b', color: TEXT }}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'minmax(150px, 200px) 1fr', gap: 12, flex: 1, minHeight: 0 }}>
        {compact ? (
          <select data-testid="achievements-cat-select" value={cat} onChange={(e) => setCat(Number(e.target.value))} style={{ font: '13px system-ui', padding: 4, background: '#10131b', color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4 }}>
            <option value={-1}>All categories</option>
            {cats.map((c) => (
              <option key={c.key} value={c.cat}>
                {c.name} ({c.count}/{c.of})
              </option>
            ))}
          </select>
        ) : (
          <div style={{ overflowY: 'auto', borderRight: `1px solid ${BORDER}`, paddingRight: 8 }}>
            {[{ cat: -1, key: 'all', name: 'All', ...total }, ...cats].map((c) => (
              <button key={c.key} data-testid={`ach-cat-${c.key}`} onClick={() => setCat(c.cat)} style={{ display: 'block', width: '100%', textAlign: 'left', margin: '0 0 4px', padding: '6px 8px', borderRadius: 4, border: `1px solid ${cat === c.cat ? BORDER_GOLD : 'transparent'}`, background: cat === c.cat ? '#2a2617' : 'transparent', color: TEXT, cursor: 'pointer', font: '13px system-ui, sans-serif' }}>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                <div style={{ fontSize: 11.5, color: TEXT_3 }}>
                  {c.count}/{c.of} · {fmt(c.earned)} pts
                </div>
                <div style={{ height: 3, marginTop: 3, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }}>
                  <div style={{ width: `${c.of ? (100 * c.count) / c.of : 0}%`, height: '100%', background: GOLD, borderRadius: 2 }} />
                </div>
              </button>
            ))}
          </div>
        )}
        <div data-testid="achievements-list" style={{ overflowY: 'auto', minHeight: 0, paddingRight: 4 }}>
          {rows.length === 0 && <div style={{ color: TEXT_3, padding: 8 }}>Nothing here{search ? ` matches "${search}"` : ''}.</div>}
          {rows.map((v) => (
            <Row key={v.def.key} v={v} shown={sync.title === v.def.key} onTitle={onTitle} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The centred panel (Y). */
export function AchievementsScreen() {
  useAchievementSync();
  return (
    <div data-testid="achievements-panel" data-ui-panel style={{ position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 'min(880px, 94vw)', height: 'min(640px, 86vh)', boxSizing: 'border-box', padding: '14px 18px', zIndex: 36, display: 'flex', flexDirection: 'column', background: PANEL_BG, border: `1px solid ${BORDER_GOLD}`, borderRadius: 6, boxShadow: '0 14px 40px rgba(0,0,0,0.6)', pointerEvents: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ font: '22px Georgia, serif', color: TEXT }}>Achievements</div>
        <div style={{ marginLeft: 12, fontSize: 12, color: TEXT_3 }}>{CONTENT.achievementTiers.map((t) => `${t.name} ${t.pts}`).join(' · ')} points</div>
        <button data-testid="achievements-close" style={{ ...btn(false), marginLeft: 'auto' }} onClick={() => setAchievementsOpen(false)}>
          Close (Y / Esc)
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AchievementsBody />
      </div>
    </div>
  );
}

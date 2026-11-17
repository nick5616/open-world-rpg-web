// Character select + creation (pt3 title + creation, CR 047). Presentational:
// AccountScreen owns the account/local-profile logic and hands in the rows and
// the actions; the 3D stage (a CaveBackdrop with your figure) lives behind
// this layer and is told which look to show through `onStage`.
//
// Layout: a list of characters on the left with Play / Delete under the
// stage; the creation panel on the right (name, appearance pickers, randomise,
// Create). Touching the creator previews the draft on the figure; picking a
// character in the list brings it back. Phones: the stage on top, one sheet
// below. `char-name`/`char-create` stay mounted and visible in every
// character phase (the acceptance harnesses and the live smoke type into them).

import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  BEARDS, BUILDS, DEFAULT_LOOK, EYE_COLORS, EYE_NAMES, HAIR_COLORS, HAIR_COLOR_NAMES, HAIR_STYLES, SKIN_NAMES, SKIN_TONES,
  randomLook, type Look,
} from '../net/look';

export interface CharacterRow {
  id: string;
  name: string;
  level: number;
  /** The look to show (DEFAULT_LOOK for characters made before the creator existed). */
  look: Look;
  note?: string;
}

export interface CharacterScreenProps {
  rows: CharacterRow[];
  /** 'characters' lets Play work; connecting / waking / ready disable the buttons. */
  phase: string;
  maxCharacters?: number;
  onPlay: (id: string) => void;
  onDelete: (id: string) => void;
  /** Resolves true when the character was made (the form then clears). */
  onCreate: (name: string, look: Look) => Promise<boolean>;
  /** The look the stage should wear now, and who it is ("" = a draft). */
  onStage: (look: Look, label: string, sub: string) => void;
  /** Extra content under the list (profile row, export/upgrade). */
  listFooter?: ReactNode;
  /** The status / error / waking lines. */
  messages?: ReactNode;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function CharacterScreen({ rows, phase, onPlay, onDelete, onCreate, onStage, listFooter, messages }: CharacterScreenProps) {
  const [selected, setSelected] = useState<string>(rows[0]?.id ?? '');
  const [mode, setMode] = useState<'select' | 'new'>(rows.length ? 'select' : 'new');
  const [draft, setDraft] = useState<Look>(() => ({ ...DEFAULT_LOOK, hairStyle: 2 }));
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = phase !== 'characters';

  // keep the selection valid as rows come and go (a created or deleted character)
  const sel = rows.find((r) => r.id === selected) ?? rows[0];
  useEffect(() => {
    if (!sel) setMode('new');
    else if (sel.id !== selected) setSelected(sel.id);
  }, [sel, selected]);

  const showing = mode === 'new' || !sel ? 'draft' : 'row';
  const look = showing === 'draft' ? draft : sel!.look;
  const label = showing === 'draft' ? (name.trim() || 'New character') : sel!.name;
  const sub = showing === 'draft' ? 'Drag to turn' : `Level ${sel!.level}`;
  useEffect(() => {
    onStage(look, label, sub);
  }, [look, label, sub, onStage]);

  const set = <K extends keyof Look>(k: K, v: number) => {
    setMode('new');
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onCreate(name, draft).then((ok) => {
      if (ok) {
        setName('');
        setMode('select');
      }
    });
  };

  const picked = useMemo(() => rows.map((r) => r.id).join(','), [rows]);
  // a just-created character becomes the selection
  const [seen, setSeen] = useState(picked);
  useEffect(() => {
    if (picked !== seen) {
      const added = rows.find((r) => !seen.split(',').includes(r.id));
      if (added) {
        setSelected(added.id);
        setMode('select');
      }
      setSeen(picked);
    }
  }, [picked, seen, rows]);

  return (
    <div className="cs-root" data-testid="character-screen" data-mode={mode}>
      <style>{CSS}</style>

      <aside className="cs-panel cs-list">
        <h2>Characters</h2>
        <ul data-testid="character-list">
          {rows.map((r) => (
            <li key={r.id} className="cs-li">
              <button
                type="button"
                className={'cs-row' + (showing === 'row' && sel?.id === r.id ? ' on' : '')}
                data-testid={`select-${r.name}`}
                onClick={() => {
                  setSelected(r.id);
                  setMode('select');
                  setConfirmDelete(false);
                }}
                onDoubleClick={() => !busy && onPlay(r.id)}
              >
                <span className="cs-chip" style={{ background: hex(SKIN_TONES[r.look.skin]), boxShadow: `inset 0 0 0 3px ${hex(HAIR_COLORS[r.look.hairColor])}` }} />
                <span className="cs-rowtext">
                  <b>{r.name}</b>
                  <span>lv {r.level}{r.note ? ` · ${r.note}` : ''}</span>
                </span>
              </button>
              {/* the selected character's Play is the big one under the stage; the others get a quick one here */}
              {!(showing === 'row' && sel?.id === r.id) && (
                <button type="button" className="cs-btn ghost cs-quick" data-testid={`play-${r.name}`} disabled={busy} onClick={() => onPlay(r.id)}>
                  Play
                </button>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="cs-empty">No characters in this world yet. Make one on the right.</li>}
        </ul>
        {listFooter}
      </aside>

      <section className="cs-stagebar">
        <div className="cs-nameplate">
          <h1 data-testid="stage-name">{label}</h1>
          <p>{sub}</p>
        </div>
        {showing === 'row' && sel && (
          <div className="cs-actions">
            <button className="cs-btn primary" data-testid={`play-${sel.name}`} disabled={busy} onClick={() => onPlay(sel.id)}>
              Play
            </button>
            {!confirmDelete ? (
              <button className="cs-btn ghost" data-testid="char-delete" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ) : (
              <span className="cs-confirm">
                Delete {sel.name} for good?
                <button className="cs-btn danger" data-testid="char-delete-confirm" onClick={() => { setConfirmDelete(false); onDelete(sel.id); }}>
                  Yes, delete
                </button>
                <button className="cs-btn ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </span>
            )}
            <button className="cs-btn ghost" data-testid="char-new" onClick={() => { setMode('new'); setConfirmDelete(false); }}>
              New
            </button>
          </div>
        )}
        {messages}
      </section>

      <aside className={'cs-panel cs-create' + (mode === 'new' ? ' on' : '')}>
        <h2>New character</h2>
        <form onSubmit={submit} onFocusCapture={() => setMode('new')}>
          <input className="cs-input" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="character name" data-testid="char-name" autoComplete="off" maxLength={24} />
          <div className="cs-rowbtns">
            <button type="button" className="cs-btn ghost" data-testid="look-random" onClick={() => { setMode('new'); setDraft(randomLook()); }}>
              Randomise
            </button>
            <button type="submit" className="cs-btn primary" data-testid="char-create">
              Create
            </button>
          </div>
        </form>
        <Group title="Build">
          {BUILDS.map((b, i) => (
            <Chip key={b.name} on={draft.build === i} label={b.name} id={`look-build-${i}`} onClick={() => set('build', i)} />
          ))}
        </Group>
        <Group title="Skin">
          {SKIN_TONES.map((c, i) => (
            <Swatch key={i} colour={hex(c)} on={draft.skin === i} label={SKIN_NAMES[i]} id={`look-skin-${i}`} onClick={() => set('skin', i)} />
          ))}
        </Group>
        <Group title="Hair">
          {HAIR_STYLES.map((n, i) => (
            <Chip key={n} on={draft.hairStyle === i} label={n} id={`look-hair-${i}`} onClick={() => set('hairStyle', i)} />
          ))}
        </Group>
        <Group title="Hair colour">
          {HAIR_COLORS.map((c, i) => (
            <Swatch key={i} colour={hex(c)} on={draft.hairColor === i} label={HAIR_COLOR_NAMES[i]} id={`look-haircolor-${i}`} onClick={() => set('hairColor', i)} />
          ))}
        </Group>
        <Group title="Beard">
          {BEARDS.map((n, i) => (
            <Chip key={n} on={draft.beard === i} label={n} id={`look-beard-${i}`} onClick={() => set('beard', i)} />
          ))}
        </Group>
        <Group title="Eyes">
          {EYE_COLORS.map((c, i) => (
            <Swatch key={i} colour={hex(c)} on={draft.eyes === i} label={EYE_NAMES[i]} id={`look-eyes-${i}`} onClick={() => set('eyes', i)} />
          ))}
        </Group>
      </aside>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cs-group">
      <h3>{title}</h3>
      <div className="cs-opts">{children}</div>
    </div>
  );
}
function Chip({ on, label, id, onClick }: { on: boolean; label: string; id: string; onClick: () => void }) {
  return (
    <button type="button" className={'cs-opt' + (on ? ' on' : '')} data-testid={id} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}
function Swatch({ on, colour, label, id, onClick }: { on: boolean; colour: string; label: string; id: string; onClick: () => void }) {
  const st: CSSProperties = { background: colour };
  return <button type="button" className={'cs-sw' + (on ? ' on' : '')} style={st} title={label} aria-label={label} aria-pressed={on} data-testid={id} onClick={onClick} />;
}

const CSS = `
.cs-root { position: absolute; inset: 0; pointer-events: none; display: grid; grid-template-columns: minmax(250px, 300px) 1fr minmax(290px, 340px); gap: 18px; padding: 18px; box-sizing: border-box; color: #e8eaff; font: 14px/1.35 system-ui, 'Segoe UI', sans-serif; }
.cs-root > * { pointer-events: auto; }
.cs-panel { background: linear-gradient(180deg, rgba(16,16,44,.78), rgba(8,9,26,.84)); border: 1px solid rgba(150,150,255,.26); border-radius: 6px; padding: 16px; backdrop-filter: blur(7px); box-shadow: 0 10px 40px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.07); overflow-y: auto; max-height: 100%; box-sizing: border-box; }
.cs-panel h2 { margin: 0 0 12px; font: 700 13px/1 Georgia, serif; letter-spacing: .26em; text-transform: uppercase; color: #b6bdff; }
.cs-panel h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #8d97d8; font-weight: 600; }
.cs-list ul { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cs-empty { color: #8d97d8; font-size: 13px; }
.cs-li { display: flex; gap: 6px; align-items: stretch; }
.cs-li .cs-row { flex: 1; min-width: 0; }
.cs-quick { padding: 0 12px; font-size: 11px; letter-spacing: .12em; }
.cs-row { width: 100%; display: flex; align-items: center; gap: 12px; text-align: left; cursor: pointer; padding: 9px 10px; color: inherit; background: rgba(40,40,100,.25); border: 1px solid rgba(150,150,255,.15); border-radius: 4px; font: inherit; }
.cs-row:hover { background: rgba(70,70,170,.35); }
.cs-row.on { background: linear-gradient(90deg, rgba(95,80,220,.5), rgba(60,50,150,.3)); border-color: rgba(190,180,255,.7); box-shadow: 0 0 18px rgba(120,110,255,.3); }
.cs-chip { width: 30px; height: 30px; border-radius: 50%; flex: none; }
.cs-rowtext { display: flex; flex-direction: column; }
.cs-rowtext b { font: 700 16px/1.2 Georgia, serif; letter-spacing: .04em; }
.cs-rowtext span { color: #98a2e6; font-size: 12px; }
.cs-stagebar { display: flex; flex-direction: column; justify-content: space-between; align-items: center; min-width: 0; pointer-events: none; padding: 4px 0 8px; }
.cs-stagebar > * { pointer-events: auto; }
.cs-nameplate { text-align: center; pointer-events: none; }
.cs-nameplate h1 { margin: 0; font: 800 clamp(26px, 4.2vw, 46px)/1.05 Georgia, serif; letter-spacing: .12em; text-transform: uppercase; background: linear-gradient(180deg, #fff, #c7bcff 55%, #7f8dff); -webkit-background-clip: text; background-clip: text; color: transparent; filter: drop-shadow(0 2px 0 rgba(10,8,40,.9)) drop-shadow(0 0 18px rgba(110,120,255,.5)); }
.cs-nameplate p { margin: 4px 0 0; letter-spacing: .3em; text-transform: uppercase; font-size: 12px; color: #aab4ff; text-shadow: 0 1px 8px #000; }
.cs-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; margin-top: auto; }
.cs-confirm { display: inline-flex; gap: 8px; align-items: center; background: rgba(40,10,24,.78); border: 1px solid rgba(255,100,130,.5); padding: 8px 12px; border-radius: 4px; flex-wrap: wrap; justify-content: center; }
.cs-btn { cursor: pointer; font: 700 13px/1 Georgia, serif; letter-spacing: .2em; text-transform: uppercase; padding: 11px 20px; border-radius: 3px; color: #eef0ff; border: 1px solid rgba(170,160,255,.55); background: rgba(30,28,90,.7); transition: box-shadow .2s, background .2s; }
.cs-btn:hover:not(:disabled), .cs-btn:focus-visible { box-shadow: 0 0 22px rgba(130,120,255,.55); outline: none; }
.cs-btn:disabled { opacity: .45; cursor: default; }
.cs-btn.primary { padding: 13px 44px; font-size: 16px; background: linear-gradient(180deg, rgba(90,78,215,.95), rgba(40,34,115,.95)); box-shadow: 0 0 24px rgba(110,100,255,.4), inset 0 1px 0 rgba(255,255,255,.25); }
.cs-btn.ghost { background: rgba(10,10,30,.6); border-color: rgba(150,150,230,.35); }
.cs-btn.danger { background: rgba(120,20,50,.8); border-color: rgba(255,110,140,.7); }
.cs-create { opacity: .72; transition: opacity .25s; }
.cs-create.on, .cs-create:hover, .cs-create:focus-within { opacity: 1; }
.cs-input { width: 100%; box-sizing: border-box; background: rgba(4,5,18,.8); color: #eef0ff; border: 1px solid rgba(150,150,255,.35); border-radius: 3px; padding: 10px 12px; font: 600 16px Georgia, serif; letter-spacing: .06em; }
.cs-input:focus { outline: none; border-color: #b9b0ff; box-shadow: 0 0 14px rgba(130,120,255,.5); }
.cs-rowbtns { display: flex; gap: 8px; margin: 10px 0 14px; }
.cs-rowbtns .cs-btn { flex: 1; padding: 11px 8px; }
.cs-group { margin-bottom: 12px; }
.cs-opts { display: flex; flex-wrap: wrap; gap: 6px; }
.cs-opt { cursor: pointer; padding: 6px 11px; font: 600 12px system-ui, sans-serif; color: #c9cffc; background: rgba(30,30,90,.45); border: 1px solid rgba(150,150,255,.25); border-radius: 3px; }
.cs-opt.on { color: #fff; background: rgba(95,80,220,.6); border-color: #c4baff; }
.cs-sw { width: 26px; height: 26px; border-radius: 50%; cursor: pointer; border: 2px solid rgba(255,255,255,.18); padding: 0; }
.cs-sw.on { border-color: #fff; box-shadow: 0 0 0 2px rgba(130,120,255,.9), 0 0 14px rgba(150,140,255,.7); }
@media (max-width: 859px) {
  .cs-root { display: flex; flex-direction: column; padding: 10px; gap: 8px; overflow-y: auto; pointer-events: none; }
  .cs-stagebar { order: 1; height: 42vh; flex: none; pointer-events: none; }
  .cs-list { order: 2; max-height: none; overflow: visible; }
  .cs-create { order: 3; max-height: none; overflow: visible; opacity: 1; }
  .cs-list ul { flex-direction: row; flex-wrap: wrap; }
  .cs-list li { flex: 1 1 140px; }
  .cs-actions { margin-top: 0; }
  .cs-btn.primary { padding: 12px 32px; }
}
@media (prefers-reduced-motion: reduce) { .cs-create, .cs-btn { transition: none; } }
`;

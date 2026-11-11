// Playtest 2 dev console (CR 032; Nicole: "a dev console locally where i can
// equip every item in the game, see every item, equip every spell, etc").
// F2 opens it, only on a zone started with LODESTONE_ZONE_DEV=1 (`npm run
// dev`) in a debug build. Four tabs (Items, Spells, Character, World) and a
// command line that mirrors every button (/help). Everything goes to the
// zone as Interact 250 (events.ts); the zone applies it through the normal
// item, combat and progression paths and answers in the log below.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { WORLD_SIZE_M } from '@lodestone/contracts';
import { localPlayer } from '../../state/live';
import { useInventory } from '../inventory/store';
import { countOf } from '../inventory/items';
import { ItemIcon } from '../inventory/ItemIcon';
import { useQuests } from '../quests/store';
import { equipSpell, useChar } from '../skills/char';
import { SpellCardFace } from '../spellcards/SpellCards';
import { spellCardData } from '../spellcards/card';
import { BORDER, BTN_BG, CARD_BG, GOLD, GREEN, PANEL_BG, RED, SLOT_BG, TEXT, TEXT_2, TEXT_3 } from '../spellcards/theme';
import { STEED_COLOURS } from '../mounts/events';
import { mapTerrain } from '../map/world';
import { ACHIEVEMENTS, BOSSES, CUTS, ELEMENTS, ELITES, ENEMIES, GEAR_AFFIXES, GEMS, ITEM_GROUPS, itemCatalog, RARITIES, SKILLS, SPECIES, SPELLS, WEATHER, WORLD_EVENTS, type CatalogItem } from './catalog';
import { COMMANDS, complete, parseCommand, type CmdCtx, type CmdPlace } from './commands';
import { DEV_ACT, DEV_FLAG, DEV_FLAG_LABEL, giveSend, petSend, send, spawnSend, teleportSend, type DevFlagName, type GiveOpts } from './events';
import { ensureDevHook } from './link';
import { devLog, sendDev, setDevOpen, useDev, type DevTab } from './store';
import { trackPanel } from '../../input/panelStack';

// Esc closes the console when it is the top panel (input/panelStack.ts); its command line keeps its own Esc.
trackPanel(useDev, (s) => s.open && s.dev, 'dev-console', () => setDevOpen(false));

/** The console's key (input/bindings.ts, Esc menu Controls "Dev"). */
export const DEV_KEY = 'F2';

const S = {
  panel: { position: 'fixed', left: 16, top: 16, bottom: 16, width: 'min(860px, calc(100vw - 32px))', zIndex: 40, display: 'flex', flexDirection: 'column', background: PANEL_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 8, font: '13px/1.35 system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,0.5)' } as CSSProperties,
  head: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${BORDER}` } as CSSProperties,
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: 12 } as CSSProperties,
  btn: { background: BTN_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12 } as CSSProperties,
  input: { background: SLOT_BG, color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 4, padding: '3px 6px', font: 'inherit', fontSize: 12 } as CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', margin: '6px 0' } as CSSProperties,
  h: { fontWeight: 700, color: GOLD, margin: '12px 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 } as CSSProperties,
};

function Btn({ onClick, children, title, testid, active }: { onClick: () => void; children: ReactNode; title?: string; testid?: string; active?: boolean }) {
  return (
    <button type="button" style={{ ...S.btn, ...(active ? { borderColor: GOLD, color: GOLD } : null) }} onClick={onClick} title={title} data-testid={testid}>
      {children}
    </button>
  );
}

function Num({ value, onChange, width = 64, min, max, step, label }: { value: number; onChange: (v: number) => void; width?: number; min?: number; max?: number; step?: number; label: string }) {
  return <input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} style={{ ...S.input, width }} />;
}

function Pick<T extends { id: number; name: string }>({ list, value, onChange, label, none }: { list: readonly T[]; value: number; onChange: (v: number) => void; label: string; none?: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} style={S.input}>
      {none !== undefined && <option value={-1}>{none}</option>}
      {list.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </select>
  );
}

const go = (s: ReturnType<typeof send>) => sendDev(s);

// ---- Items ----

function ItemsTab() {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all');
  const [qty, setQty] = useState(1);
  const [rarity, setRarity] = useState(3);
  const [level, setLevel] = useState(0);
  const [gem, setGem] = useState(-1);
  const [cut, setCut] = useState(2);
  const [affix, setAffix] = useState(-1);
  const [loadout, setLoadout] = useState(0);
  const inv = useInventory((s) => s.inv);
  const all = itemCatalog();
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((i) => (group === 'all' || i.group === group) && (!n || i.search.includes(n)));
  }, [all, q, group]);
  const opts = (it: CatalogItem, equip: boolean): GiveOpts => (it.gear ? { qty: equip ? 1 : Math.min(qty, 10), rarity, level, gem, cut, affix, equip, loadout } : { qty, equip });
  const give = (it: CatalogItem, equip: boolean) => {
    devLog('cmd', `${equip ? 'equip' : 'give'} ${it.key}`);
    go(giveSend(it.key, opts(it, equip)));
  };
  return (
    <div data-testid="dev-items">
      <div style={S.row}>
        <input aria-label="search items" placeholder={`Search ${all.length} items...`} value={q} onChange={(e) => setQ(e.target.value)} style={{ ...S.input, flex: '1 1 200px' }} data-testid="dev-item-search" />
        <select aria-label="item category" value={group} onChange={(e) => setGroup(e.target.value)} style={S.input} data-testid="dev-item-group">
          <option value="all">All categories</option>
          {ITEM_GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label} ({all.filter((i) => i.group === g.key).length})
            </option>
          ))}
        </select>
        Qty <Num label="quantity" value={qty} onChange={setQty} min={1} max={9999} width={60} />
      </div>
      <div style={{ ...S.row, padding: 6, background: CARD_BG, borderRadius: 4 }}>
        <b style={{ color: TEXT_2 }}>Gear rolls:</b>
        <Pick label="rarity" list={RARITIES} value={rarity} onChange={setRarity} />
        level <Num label="item level" value={level} onChange={setLevel} min={0} max={60} width={52} />
        <span style={{ color: TEXT_3 }}>(0 = base)</span>
        gem <Pick label="gem" list={GEMS} value={gem} onChange={setGem} none="none" />
        {gem >= 0 && <Pick label="cut" list={CUTS} value={cut} onChange={setCut} />}
        affix <Pick label="affix" list={GEAR_AFFIXES} value={affix} onChange={setAffix} none="random" />
        <select aria-label="loadout" value={loadout} onChange={(e) => setLoadout(Number(e.target.value))} style={S.input}>
          <option value={0}>Loadout 1</option>
          <option value={1}>Loadout 2</option>
        </select>
      </div>
      <div style={{ color: TEXT_3, fontSize: 12 }}>{shown.length} shown</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 6, marginTop: 6 }}>
        {shown.map((it) => {
          const have = inv ? (it.key === 'currency:gold' ? inv.gold : countOf(inv.items, it.key)) : 0;
          return (
            <div key={it.key} data-testid={`dev-item-${it.key}`} style={{ display: 'flex', gap: 8, alignItems: 'center', background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: 6 }}>
              <ItemIcon itemKey={it.key} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.key}>
                  {it.name}
                </div>
                <div style={{ fontSize: 11, color: TEXT_2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={it.line}>
                  {it.kind}
                  {it.level > 1 ? ` · lv ${it.level}` : ''}
                  {it.line ? ` · ${it.line}` : ''}
                </div>
                <div style={{ fontSize: 11, color: TEXT_3 }}>
                  {it.key}
                  {have > 0 && <span style={{ color: GREEN }}> · have {have}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <Btn onClick={() => give(it, false)}>Give</Btn>
                {it.key !== 'currency:gold' && (
                  <Btn onClick={() => give(it, true)} title={it.gear ? 'Give and equip' : 'Give and use (learn, load, drink key)'}>
                    {it.gear ? 'Equip' : 'Use'}
                  </Btn>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Spells ----

function SpellsTab() {
  const c = useChar();
  const flags = useDev((s) => s.status.flags);
  const [q, setQ] = useState('');
  const [tree, setTree] = useState('all');
  const [loadout, setLoadout] = useState(0);
  const trees = useMemo(() => [...new Set(SPELLS.map((s) => s.tree))], []);
  const shown = SPELLS.filter((s) => (tree === 'all' || s.tree === tree) && (!q || `${s.key} ${s.name} ${s.type}`.toLowerCase().includes(q.toLowerCase())));
  const equip = (key: string, id: number, slot: number) => {
    if (!c.knownSet.has(key)) go(send(DEV_ACT.learn, id));
    equipSpell(loadout, slot, key);
    devLog('cmd', `equip ${key} in loadout ${loadout + 1} slot ${slot + 1}`);
  };
  return (
    <div data-testid="dev-spells">
      <div style={S.row}>
        <input aria-label="search spells" placeholder={`Search ${SPELLS.length} spells...`} value={q} onChange={(e) => setQ(e.target.value)} style={{ ...S.input, flex: '1 1 180px' }} />
        <select aria-label="school" value={tree} onChange={(e) => setTree(e.target.value)} style={S.input}>
          <option value="all">All schools</option>
          {trees.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Btn onClick={() => go(send(DEV_ACT.learn, 0))} testid="dev-learn-all">
          Learn all
        </Btn>
        <Btn onClick={() => go(send(DEV_ACT.unlearn, 0))}>Unlearn all</Btn>
        <Btn onClick={() => go(send(DEV_ACT.flags, 0, flags ^ DEV_FLAG.freeLearn))} active={(flags & DEV_FLAG.freeLearn) !== 0} title="The skill tree (N) learns any spell: every tier, no points or prerequisites">
          Unlock every tier
        </Btn>
      </div>
      <div style={S.row}>
        <span style={{ color: TEXT_2 }}>Equip into</span>
        {[0, 1].map((l) => (
          <Btn key={l} onClick={() => setLoadout(l)} active={loadout === l}>
            Loadout {l + 1}
          </Btn>
        ))}
        <span style={{ color: TEXT_3, fontSize: 12 }}>
          now: {c.loadouts[loadout]?.spells.map((k, i) => `${i + 1} ${k ? (spellCardData(k)?.name ?? k) : '-'}`).join(' · ')}
        </span>
      </div>
      <div style={{ color: TEXT_3, fontSize: 12 }}>
        {c.known.length} known of {SPELLS.length} · {shown.length} shown
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 6, marginTop: 6 }}>
        {shown.map((s) => {
          const d = spellCardData(s.key);
          const known = c.knownSet.has(s.key);
          return (
            <div key={s.key} data-testid={`dev-spell-${s.key}`} style={{ background: CARD_BG, border: `1px solid ${known ? GREEN + '88' : BORDER}`, borderRadius: 4, padding: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {d && <SpellCardFace d={d} compact />}
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                {known ? <Btn onClick={() => go(send(DEV_ACT.unlearn, s.id))}>Unlearn</Btn> : <Btn onClick={() => go(send(DEV_ACT.learn, s.id))}>Learn</Btn>}
                {!d?.passive &&
                  [0, 1, 2, 3].map((slot) => (
                    <Btn key={slot} onClick={() => equip(s.key, s.id, slot)} title={`Learn if needed and put in loadout ${loadout + 1} slot ${slot + 1}`}>
                      {slot + 1}
                    </Btn>
                  ))}
                {known && <span style={{ color: GREEN, fontSize: 11 }}>known</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Character ----

function CharacterTab() {
  const c = useChar();
  const st = useDev((s) => s.status);
  const [level, setLevel] = useState(20);
  const [xp, setXp] = useState(0);
  const [gold, setGold] = useState(10000);
  const [sp, setSp] = useState(10);
  const [skill, setSkill] = useState(0);
  const [skillLv, setSkillLv] = useState(40);
  const [speed, setSpeed] = useState(2);
  const [sure, setSure] = useState(false);
  const flip = (f: DevFlagName) => go(send(DEV_ACT.flags, 0, st.flags ^ DEV_FLAG[f]));
  return (
    <div data-testid="dev-character">
      <div style={{ color: TEXT_2 }}>
        Level {c.level} · {c.free}/{c.total} skill points free · {c.attuned} towers attuned
      </div>
      <div style={S.h}>Progress</div>
      <div style={S.row}>
        Level <Num label="level" value={level} onChange={setLevel} min={1} max={255} />
        <Btn onClick={() => go(send(DEV_ACT.level, 0, level))}>Set level</Btn>
        XP <Num label="xp" value={xp} onChange={setXp} min={0} width={90} />
        <Btn onClick={() => go(send(DEV_ACT.xp, BigInt(Math.max(0, Math.floor(xp)))))}>Set XP</Btn>
      </div>
      <div style={S.row}>
        Gold <Num label="gold" value={gold} onChange={setGold} min={0} width={90} />
        <Btn onClick={() => go(send(DEV_ACT.gold, 0, gold))}>Set gold</Btn>
        Extra skill points <Num label="skill points" value={sp} onChange={setSp} min={0} max={1000} />
        <Btn onClick={() => go(send(DEV_ACT.skillPoints, 0, sp))}>Set</Btn>
        <span style={{ color: TEXT_3, fontSize: 12 }}>now +{st.skillBonus} (this session)</span>
      </div>
      <div style={S.row}>
        Skill
        <select aria-label="skill" value={skill} onChange={(e) => setSkill(Number(e.target.value))} style={S.input}>
          <option value={0}>All skills</option>
          {SKILLS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        level <Num label="skill level" value={skillLv} onChange={setSkillLv} min={1} max={100} />
        <Btn onClick={() => go(send(DEV_ACT.weaponSkill, skill, skillLv))}>Set skill</Btn>
        <Btn onClick={() => go(send(DEV_ACT.weaponSkill, 0, 100))}>All skills 100</Btn>
      </div>
      <div style={S.h}>Cheats</div>
      <div style={S.row}>
        <Btn onClick={() => go(send(DEV_ACT.refill))} testid="dev-refill">
          Refill health, mana, stamina
        </Btn>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 4 }}>
        {(Object.keys(DEV_FLAG) as DevFlagName[]).map((f) => (
          <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={(st.flags & DEV_FLAG[f]) !== 0} onChange={() => flip(f)} data-testid={`dev-flag-${f}`} /> {DEV_FLAG_LABEL[f]}
          </label>
        ))}
      </div>
      <div style={S.row}>
        Fly speed x<Num label="fly speed" value={speed} onChange={setSpeed} min={0.1} max={50} step={0.5} />
        <Btn onClick={() => go(send(DEV_ACT.speed, 0, Math.round(speed * 100)))}>Set</Btn>
        <span style={{ color: TEXT_3, fontSize: 12 }}>now x{st.speed} (20 m/s, Shift x4). Walking speed is the shared movement step's: not cheatable.</span>
      </div>
      <div style={S.h}>Start over</div>
      <div style={S.row}>
        {sure ? (
          <>
            <span style={{ color: RED }}>Level 1, starting kit, no spells, map or quests (pets, steed, achievements stay).</span>
            <Btn
              onClick={() => {
                go(send(DEV_ACT.reset));
                setSure(false);
              }}
            >
              Yes, reset
            </Btn>
            <Btn onClick={() => setSure(false)}>Cancel</Btn>
          </>
        ) : (
          <Btn onClick={() => setSure(true)}>Reset character...</Btn>
        )}
      </div>
    </div>
  );
}

// ---- World ----

function MiniMap({ onPick }: { onPick: (x: number, z: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 220;
  useEffect(() => {
    const draw = () => {
      const cv = ref.current;
      const ctx = cv?.getContext('2d');
      if (!cv || !ctx) return;
      ctx.fillStyle = '#20283a';
      ctx.fillRect(0, 0, size, size);
      const t = mapTerrain();
      if (t) ctx.drawImage(t, 0, 0, size, size);
      const p = localPlayer.pos;
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc((p.x / WORLD_SIZE_M) * size, (p.z / WORLD_SIZE_M) * size, 4, 0, Math.PI * 2);
      ctx.fill();
    };
    draw();
    const id = setInterval(draw, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      data-testid="dev-minimap"
      title="Click to teleport there"
      style={{ width: size, height: size, borderRadius: 4, border: `1px solid ${BORDER}`, cursor: 'crosshair', flex: 'none' }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onPick(((e.clientX - r.left) / r.width) * WORLD_SIZE_M, ((e.clientY - r.top) / r.height) * WORLD_SIZE_M);
      }}
    />
  );
}

function WorldTab() {
  const st = useDev((s) => s.status);
  const places = useDev((s) => s.places);
  const quests = useQuests((s) => s.log.quests);
  const [tx, setTx] = useState(() => Math.round(localPlayer.pos.x));
  const [tz, setTz] = useState(() => Math.round(localPlayer.pos.z));
  const [hour, setHour] = useState(st.hour);
  useEffect(() => setHour(st.hour), [st.hour]); // follow the zone's clock (1400)
  const [enemy, setEnemy] = useState(ENEMIES[0].id);
  const [count, setCount] = useState(3);
  const [lvl, setLvl] = useState(0);
  const [elite, setElite] = useState(-1);
  const [boss, setBoss] = useState(0);
  const [ev, setEv] = useState(1);
  const [species, setSpecies] = useState(SPECIES[0]?.id ?? 1);
  const [variant, setVariant] = useState(1);
  const [petLv, setPetLv] = useState(10);
  const [element, setElement] = useState(0);
  const [colour, setColour] = useState(0);
  const [ach, setAch] = useState(ACHIEVEMENTS[0]?.id ?? 1);
  const tp = (x: number, z: number, what = '') => {
    devLog('cmd', `tp ${Math.round(x)} ${Math.round(z)}${what ? ` (${what})` : ''}`);
    go(teleportSend(x, z));
  };
  const placeList = (label: string, list: { n: string; x: number; z: number }[]) => (
    <div style={S.row}>
      <span style={{ width: 54, color: TEXT_2 }}>{label}</span>
      <select
        aria-label={`teleport to ${label}`}
        value=""
        onChange={(e) => {
          const p = list[Number(e.target.value)];
          if (p) tp(p.x, p.z, p.n);
        }}
        style={{ ...S.input, flex: 1 }}
      >
        <option value="">{list.length ? `${list.length} ${label.toLowerCase()}: pick one to go` : 'none known'}</option>
        {list.map((p, i) => (
          <option key={i} value={i}>
            {p.n} ({Math.round(p.x)}, {Math.round(p.z)})
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <div data-testid="dev-world">
      <div style={S.h}>Teleport</div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <MiniMap onPick={(x, z) => tp(x, z, 'map')} />
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <div style={S.row}>
            x <Num label="x" value={tx} onChange={setTx} width={70} /> z <Num label="z" value={tz} onChange={setTz} width={70} />
            <Btn onClick={() => tp(tx, tz)}>Go</Btn>
            <span style={{ color: TEXT_3, fontSize: 12 }}>
              you: {Math.round(localPlayer.pos.x)}, {Math.round(localPlayer.pos.z)}
            </span>
          </div>
          {placeList('Towers', places.towers)}
          {placeList('Towns', places.towns)}
          {placeList('Vaults', places.vaults)}
          <div style={S.row}>
            <Btn onClick={() => go(send(DEV_ACT.reveal))}>Reveal map</Btn>
            <Btn onClick={() => go(send(DEV_ACT.attune))}>Attune all towers</Btn>
          </div>
        </div>
      </div>
      <div style={S.h}>Time and weather</div>
      <div style={S.row}>
        <input aria-label="hour" type="range" min={0} max={24} step={0.25} value={hour} onChange={(e) => setHour(Number(e.target.value))} style={{ width: 160 }} />
        <span style={{ width: 40 }}>
          {String(Math.floor(hour)).padStart(2, '0')}:{String(Math.round((hour % 1) * 60)).padStart(2, '0')}
        </span>
        <Btn onClick={() => go(send(DEV_ACT.time, 0, Math.round(hour * 100)))}>Set time</Btn>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={st.frozen} onChange={() => go(send(DEV_ACT.flags, 0, st.flags ^ DEV_FLAG.freezeTime))} /> Freeze time
        </label>
        <span style={{ color: TEXT_3, fontSize: 12 }}>zone clock {st.hour.toFixed(2)} h</span>
      </div>
      <div style={S.row}>
        <Btn onClick={() => go(send(DEV_ACT.weather, 0, 0))} active={st.weather < 0}>
          Seeded
        </Btn>
        {WEATHER.map((w) => (
          <Btn key={w.id} onClick={() => go(send(DEV_ACT.weather, 0, w.id + 1))} active={st.weather === w.id}>
            {w.name}
          </Btn>
        ))}
      </div>
      <div style={S.h}>Spawn ({st.spawned} groups out)</div>
      <div style={S.row}>
        <Pick label="enemy" list={ENEMIES} value={enemy} onChange={setEnemy} />
        x<Num label="count" value={count} onChange={setCount} min={1} max={20} width={48} />
        level <Num label="spawn level" value={lvl} onChange={setLvl} min={0} max={255} width={52} />
        <Pick label="elite" list={ELITES} value={elite} onChange={setElite} none="not elite" />
        <Btn onClick={() => go(spawnSend(enemy, count, lvl, false, Math.max(0, elite)))}>Spawn</Btn>
      </div>
      <div style={S.row}>
        <Pick label="boss" list={BOSSES} value={boss} onChange={setBoss} />
        <Btn onClick={() => go(spawnSend(boss, 1, lvl, true))}>Spawn boss</Btn>
        <Btn onClick={() => go(send(DEV_ACT.despawn))}>Despawn all</Btn>
        <span style={{ color: TEXT_3, fontSize: 12 }}>level 0 = yours</span>
      </div>
      <div style={S.row}>
        <Pick label="world event" list={WORLD_EVENTS} value={ev} onChange={setEv} />
        <Btn onClick={() => go(send(DEV_ACT.event, 0, ev))}>Start world event</Btn>
      </div>
      <div style={S.h}>Creatures</div>
      <div style={S.row}>
        <Pick label="species" list={SPECIES} value={species} onChange={setSpecies} />
        <Btn onClick={() => go(send(DEV_ACT.tameable, species))} title="A weakened one ahead: feed it its favourite food">
          Tameable creature
        </Btn>
        <select aria-label="pet variant" value={variant} onChange={(e) => setVariant(Number(e.target.value))} style={S.input}>
          <option value={0}>plain</option>
          <option value={1}>shiny</option>
          <option value={2}>elemental</option>
        </select>
        {variant === 2 && (
          <select aria-label="pet element" value={element} onChange={(e) => setElement(Number(e.target.value))} style={S.input}>
            {ELEMENTS.map((el, i) => (
              <option key={el} value={i}>
                {el}
              </option>
            ))}
          </select>
        )}
        lv <Num label="pet level" value={petLv} onChange={setPetLv} min={1} max={60} width={48} />
        <Btn onClick={() => go(petSend(species, variant, petLv, variant === 2 ? element : -1))}>Give pet</Btn>
      </div>
      <div style={S.row}>
        <select aria-label="steed colour" value={colour} onChange={(e) => setColour(Number(e.target.value))} style={S.input}>
          {STEED_COLOURS.map((c, i) => (
            <option key={c.name} value={i}>
              {c.name}
            </option>
          ))}
        </select>
        <Btn onClick={() => go(send(DEV_ACT.steed, 0, colour))}>Give steed (+ whistle, key 5)</Btn>
      </div>
      <div style={S.h}>Quests ({quests.length} active)</div>
      {quests.map((qq) => (
        <div key={qq.id} style={S.row}>
          <span style={{ flex: 1 }}>
            {qq.title} <span style={{ color: TEXT_3 }}>#{qq.id}</span>
          </span>
          <Btn onClick={() => go(send(DEV_ACT.quest, qq.id, 1))}>Finish step</Btn>
          <Btn onClick={() => go(send(DEV_ACT.quest, qq.id, 2))}>Complete</Btn>
          <Btn onClick={() => go(send(DEV_ACT.quest, qq.id, 3))}>Abandon</Btn>
        </div>
      ))}
      {quests.length > 1 && (
        <div style={S.row}>
          <Btn onClick={() => go(send(DEV_ACT.quest, 0, 2))}>Complete all</Btn>
        </div>
      )}
      <div style={S.h}>Achievements ({ACHIEVEMENTS.length})</div>
      <div style={S.row}>
        <Pick label="achievement" list={ACHIEVEMENTS} value={ach} onChange={setAch} />
        <Btn onClick={() => go(send(DEV_ACT.achieve, ach))}>Unlock</Btn>
        <Btn onClick={() => go(send(DEV_ACT.achieve, 0))}>Unlock all</Btn>
      </div>
    </div>
  );
}

// ---- the console ----

const TABS: { key: DevTab; label: string }[] = [
  { key: 'items', label: 'Items' },
  { key: 'spells', label: 'Spells' },
  { key: 'character', label: 'Character' },
  { key: 'world', label: 'World' },
];

function cmdCtx(): CmdCtx {
  const d = useDev.getState();
  const pl: CmdPlace[] = [...d.places.towers.map((p) => ({ kind: 'tower', name: p.n, x: p.x, z: p.z })), ...d.places.towns.map((p) => ({ kind: 'town', name: p.n, x: p.x, z: p.z })), ...d.places.vaults.map((p) => ({ kind: 'vault', name: p.n, x: p.x, z: p.z }))];
  return { flags: d.status.flags, places: pl, quests: useQuests.getState().log.quests.map((q) => ({ id: q.id, title: q.title })) };
}

/** Run one command line (the box, and window.__lodestoneDev.run for headless runs). */
export function runDevCommand(line: string): void {
  const t = line.trim();
  if (!t) return;
  useDev.setState((s) => ({ history: [...s.history.filter((h) => h !== t), t].slice(-50) }));
  devLog('cmd', t.startsWith('/') ? t : `/${t}`);
  const r = parseCommand(t, cmdCtx());
  if ('error' in r) {
    devLog('err', r.error);
    return;
  }
  if (r.local === 'clear') {
    useDev.setState({ log: [] });
    return;
  }
  if (r.local === 'help') {
    if (r.note) devLog('info', r.note);
    else for (const c of COMMANDS) devLog('info', `${c.usage}  ${c.does}`);
    return;
  }
  if (r.note) devLog('info', r.note);
  for (const s of r.sends) sendDev(s);
}

function CommandLine() {
  const [text, setText] = useState('');
  const [hi, setHi] = useState(-1);
  const history = useDev((s) => s.history);
  const sugg = useMemo(() => (text ? complete(text, cmdCtx()) : []), [text]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div style={{ position: 'relative', padding: '6px 12px 10px' }}>
      {sugg.length > 0 && (
        <div style={{ position: 'absolute', bottom: '100%', left: 12, right: 12, background: SLOT_BG, border: `1px solid ${BORDER}`, borderRadius: 4, padding: 4, fontSize: 12 }} data-testid="dev-suggest">
          {sugg.map((s) => (
            <div key={s} style={{ cursor: 'pointer', color: TEXT_2, padding: '1px 4px' }} onMouseDown={(e) => (e.preventDefault(), setText(s))}>
              {s}
            </div>
          ))}
        </div>
      )}
      <input
        ref={ref}
        aria-label="dev command"
        data-testid="dev-command"
        placeholder="/give weapon:voidglass_sword mythic   /learn all   /tp 1200 900   /help  (Tab completes, arrows: history)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setHi(-1);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            runDevCommand(text);
            setText('');
            setHi(-1);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            if (sugg[0]) setText(sugg[0]);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (!history.length) return;
            const n = e.key === 'ArrowUp' ? (hi < 0 ? history.length - 1 : Math.max(0, hi - 1)) : hi < 0 ? -1 : hi + 1;
            if (n < 0 || n >= history.length) {
              setHi(-1);
              setText('');
            } else {
              setHi(n);
              setText(history[n]);
            }
          } else if (e.key === 'Escape') setDevOpen(false);
        }}
        style={{ ...S.input, width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace', fontSize: 13, padding: '6px 8px' }}
      />
    </div>
  );
}

function Log() {
  const log = useDev((s) => s.log);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);
  const color = { cmd: TEXT_2, ok: GREEN, err: RED, info: TEXT_3 } as const;
  return (
    <div ref={ref} data-testid="dev-log" style={{ height: 110, overflow: 'auto', borderTop: `1px solid ${BORDER}`, padding: '6px 12px', font: '12px/1.4 ui-monospace, monospace' }}>
      {log.length === 0 && <div style={{ color: TEXT_3 }}>Every button and command answers here. /help lists the commands.</div>}
      {log.map((l) => (
        <div key={l.id} style={{ color: color[l.kind] }}>
          {l.kind === 'cmd' ? '> ' : ''}
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function DevConsole() {
  const dev = useDev((s) => s.dev);
  const open = useDev((s) => s.open);
  const tab = useDev((s) => s.tab);
  useEffect(() => {
    ensureDevHook();
    const id = setInterval(ensureDevHook, 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.code === DEV_KEY && !e.repeat) {
        if (!useDev.getState().dev) return;
        e.preventDefault();
        setDevOpen(!useDev.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    if (typeof window !== 'undefined') (window as unknown as { __lodestoneDev?: unknown }).__lodestoneDev = { run: runDevCommand, open: setDevOpen, state: () => useDev.getState() };
    return () => {
      clearInterval(id);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  if (!dev || !open) return null;
  return (
    <div data-ui-panel data-testid="dev-console" style={S.panel}>
      <div style={S.head}>
        <b style={{ color: GOLD, marginRight: 8 }}>Dev console</b>
        {TABS.map((t) => (
          <Btn key={t.key} onClick={() => useDev.setState({ tab: t.key })} active={tab === t.key} testid={`dev-tab-${t.key}`}>
            {t.label}
          </Btn>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ color: TEXT_3, fontSize: 11 }}>local dev zone · F2 closes</span>
        <Btn onClick={() => setDevOpen(false)}>Close</Btn>
      </div>
      <div style={S.body}>
        {tab === 'items' && <ItemsTab />}
        {tab === 'spells' && <SpellsTab />}
        {tab === 'character' && <CharacterTab />}
        {tab === 'world' && <WorldTab />}
      </div>
      <Log />
      <CommandLine />
    </div>
  );
}

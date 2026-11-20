// Small inline-SVG item icons (WP14): one silhouette per item kind, tinted by
// material, gem or metal. No image assets: an icon is a few paths.

import { GEM_COLOR, itemDef } from './items';

const METAL: Record<string, string> = {
  wood: '#a77b4f',
  leather: '#9a6a43',
  copper: '#d0814e',
  iron: '#a9adb3',
  silver: '#dfe6ee',
  sunsteel: '#ffcb57',
  starmetal: '#9fb6ff',
  voidglass: '#b77cff',
};

/**
 * `weapon` / `armor` draw an empty equipment slot's silhouette (playtest 6
 * polish: the training weapon in an empty main hand, the outline of a helm,
 * cuirass or greaves) instead of an item's.
 */
export function ItemIcon({ itemKey, size = 34, weapon, armor }: { itemKey: string; size?: number; weapon?: string; armor?: string }) {
  const d0 = itemDef(itemKey);
  const d = weapon || armor ? ({ ...(d0 ?? {}), kind: weapon ? 'weapon' : 'armor', weapon, armor, material: weapon ? 'wood' : 'leather' } as NonNullable<typeof d0>) : d0;
  const kind = d?.kind ?? (itemKey.startsWith('tome:') ? 'tome' : 'material');
  const metal = METAL[d?.material ?? d?.metal ?? d?.arrow ?? ''] ?? '#c9c2b0';
  let body: JSX.Element;
  switch (kind) {
    case 'weapon': {
      const w = d?.weapon;
      if (w === 'bow')
        body = (
          <g fill="none" strokeLinecap="round">
            <path d="M10 4 Q28 16 10 28" stroke={metal} strokeWidth="2.6" />
            <path d="M10 4 L10 28" stroke="#e9e1cf" strokeWidth="1" />
          </g>
        );
      else if (w === 'staff' || w === 'wand')
        body = (
          <g strokeLinecap="round">
            <path d={w === 'staff' ? 'M9 28 L23 6' : 'M11 26 L21 10'} stroke="#8a6a44" strokeWidth={w === 'staff' ? 2.6 : 2.2} />
            <circle cx={w === 'staff' ? 23.5 : 21.5} cy={w === 'staff' ? 5.5 : 9.5} r={w === 'staff' ? 3.6 : 2.6} fill={metal} />
          </g>
        );
      else if (w === 'spear')
        body = (
          <g strokeLinecap="round">
            <path d="M7 27 L22 9" stroke="#8a6a44" strokeWidth="2.2" />
            <path d="M20 7 L27 4 L24 11 Z" fill={metal} />
          </g>
        );
      else
        body = (
          <g strokeLinecap="round">
            <path d="M8 26 L23 7 L26 6 L25 9 L10 28 Z" fill={metal} />
            <path d="M6 22 L12 28" stroke="#c9a650" strokeWidth="2.4" />
            <path d="M5 29 L8 26" stroke="#6a4a2a" strokeWidth="2.6" />
          </g>
        );
      break;
    }
    case 'armor': {
      const a = d?.armor;
      body =
        a === 'head' ? (
          <path d="M7 20 Q7 7 16 7 Q25 7 25 20 L25 24 L20 24 L20 18 L12 18 L12 24 L7 24 Z" fill={metal} />
        ) : a === 'legs' ? (
          <path d="M9 6 L23 6 L24 27 L18 27 L16 13 L14 27 L8 27 Z" fill={metal} />
        ) : (
          <path d="M8 7 L13 5 Q16 8 19 5 L24 7 L27 13 L23 15 L23 27 L9 27 L9 15 L5 13 Z" fill={metal} />
        );
      break;
    }
    case 'consumable':
      body = d?.category === 'potion' ? (
        <g>
          <path d="M13 5 L19 5 L19 11 Q25 14 25 20 Q25 28 16 28 Q7 28 7 20 Q7 14 13 11 Z" fill="#c9d6e0" opacity="0.5" />
          <path d="M8.5 19 Q8.5 27 16 27 Q23.5 27 23.5 19 Z" fill={itemKey.includes('antidote') ? '#5fd07a' : '#e0405a'} />
          <rect x="12.5" y="3" width="7" height="3" rx="1" fill="#8a6a44" />
        </g>
      ) : (
        foodIcon(itemKey)
      );
      break;
    case 'gem': {
      const g = GEM_COLOR[d?.gem ?? ''] ?? '#ddd';
      body = (
        <g>
          <path d="M16 4 L26 13 L16 28 L6 13 Z" fill={g} />
          <path d="M16 4 L20 13 L16 28 L12 13 Z" fill="#ffffff" opacity="0.28" />
          <path d="M6 13 L26 13" stroke="#ffffff" strokeOpacity="0.4" strokeWidth="1" />
        </g>
      );
      break;
    }
    case 'ore':
      body = (
        <g>
          <path d="M6 22 L9 12 L17 7 L25 11 L27 20 L20 27 L11 27 Z" fill="#5d564d" />
          <circle cx="13" cy="16" r="2.6" fill={metal} />
          <circle cx="20" cy="13" r="2" fill={metal} />
          <circle cx="19" cy="21" r="2.4" fill={metal} />
        </g>
      );
      break;
    case 'ingot':
      body = (
        <g>
          <path d="M5 21 L10 13 L27 13 L22 21 Z" fill={metal} />
          <path d="M5 21 L22 21 L22 25 L5 25 Z" fill={metal} opacity="0.7" />
          <path d="M22 21 L27 13 L27 17 L22 25 Z" fill={metal} opacity="0.55" />
        </g>
      );
      break;
    case 'blueprint':
      body = (
        <g>
          <rect x="6" y="7" width="20" height="18" rx="2" fill="#2f5f9e" />
          <path d="M9 21 L15 12 L18 16 L23 10" stroke="#cfe3ff" strokeWidth="1.4" fill="none" />
          <rect x="6" y="7" width="20" height="18" rx="2" fill="none" stroke="#cfe3ff" strokeOpacity="0.6" />
        </g>
      );
      break;
    case 'tome':
      body = (
        <g>
          <rect x="7" y="5" width="18" height="22" rx="2" fill="#6b2f6e" />
          <rect x="9" y="5" width="2" height="22" fill="#3e1a40" />
          <circle cx="18" cy="16" r="4" fill="none" stroke="#ffd36b" strokeWidth="1.6" />
        </g>
      );
      break;
    case 'ammo':
      body = (
        <g strokeLinecap="round">
          {[0, 4, 8].map((o) => (
            <g key={o}>
              <path d={`M${6 + o} 27 L${20 + o} 7`} stroke="#b08a5a" strokeWidth="1.6" />
              <path d={`M${19 + o} 5 L${23 + o} 5 L${21 + o} 10 Z`} fill={metal} />
            </g>
          ))}
        </g>
      );
      break;
    case 'currency':
      body = (
        <g>
          <ellipse cx="16" cy="20" rx="9" ry="4" fill="#b8892c" />
          <ellipse cx="16" cy="17" rx="9" ry="4" fill="#f0c048" />
        </g>
      );
      break;
    case 'tool':
      if (d?.category === 'instrument') {
        body = instrumentIcon(itemKey);
        break;
      }
      body = toolIcon(itemKey);
      break;
    case 'key':
      body = (
        <g fill="none" stroke="#d9b45a" strokeWidth="2.6" strokeLinecap="round">
          <circle cx="10" cy="11" r="5" />
          <path d="M14 15 L26 27 M21 22 L24 19 M24 25 L27 22" />
        </g>
      );
      break;
    default:
      body = materialIcon(itemKey);
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ display: 'block', pointerEvents: 'none' }}>
      {body}
    </svg>
  );
}

/** Playtest 2 instruments (CR 028): a lute, a flute, a hand drum, handbells. */
function instrumentIcon(key: string): JSX.Element {
  if (key.endsWith('flute'))
    return (
      <g strokeLinecap="round">
        <path d="M5 26 L27 6" stroke="#8a5a2e" strokeWidth="3.2" />
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} cx={11 + i * 3.4} cy={20.6 - i * 3.1} r="0.9" fill="#2a1a10" />
        ))}
      </g>
    );
  if (key.endsWith('drum'))
    return (
      <g>
        <path d="M7 12 L9 25 Q16 29 23 25 L25 12 Z" fill="#7a4a24" />
        <ellipse cx="16" cy="12" rx="9" ry="3.6" fill="#e9dcbc" stroke="#2a1a10" strokeWidth="1" />
        <path d="M10 15 L13 24 M16 16 L16 26 M22 15 L19 24" stroke="#c9a77a" strokeWidth="0.8" />
      </g>
    );
  if (key.endsWith('bells'))
    return (
      <g>
        {[
          [11, 12],
          [21, 15],
        ].map(([x, y]) => (
          <g key={x}>
            <path d={`M${x} ${y - 7} L${x} ${y - 3}`} stroke="#2a1a10" strokeWidth="2" strokeLinecap="round" />
            <path d={`M${x - 3} ${y - 3} Q${x - 4} ${y + 5} ${x - 6} ${y + 7} L${x + 6} ${y + 7} Q${x + 4} ${y + 5} ${x + 3} ${y - 3} Z`} fill="#c99a4c" />
          </g>
        ))}
      </g>
    );
  return (
    <g>
      <ellipse cx="12" cy="21" rx="7.5" ry="6.5" fill="#d2a868" stroke="#7a4a24" strokeWidth="1.2" />
      <circle cx="13" cy="19.5" r="1.8" fill="#2a1a10" />
      <path d="M16 16 L26 5" stroke="#2a1a10" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M25 4 L29 6" stroke="#7a4a24" strokeWidth="2.4" strokeLinecap="round" />
    </g>
  );
}

/** Playtest 6 polish: every starter tool drew the pickaxe; each tool has its own silhouette. */
function toolIcon(key: string): JSX.Element {
  const handle = '#8a6a44';
  const steel = '#a9adb3';
  if (key.startsWith('camp:')) return campIcon(key.slice(5));
  switch (key) {
    case 'tool:axe':
      return (
        <g strokeLinecap="round">
          <path d="M9 28 L20 6" stroke={handle} strokeWidth="2.6" />
          <path d="M17.5 7 L25 4 Q29 10 25.5 16 L19.5 12 Z" fill={steel} />
          <path d="M25 4 Q29 10 25.5 16" stroke="#e7eaee" strokeWidth="1" fill="none" />
        </g>
      );
    case 'tool:shovel':
      return (
        <g strokeLinecap="round">
          <path d="M23 5 L14 19" stroke={handle} strokeWidth="2.6" />
          <path d="M20 4 L26 7" stroke={handle} strokeWidth="2.6" />
          <path d="M12.5 17 L18 20.5 Q15.5 29 7 28.5 Q5.5 22 12.5 17 Z" fill={steel} />
        </g>
      );
    case 'tool:torch':
      return (
        <g strokeLinecap="round">
          <path d="M16 29 L16 14" stroke={handle} strokeWidth="3" />
          <path d="M14 14 L18 14 L18 17 L14 17 Z" fill="#5a4630" />
          <path d="M16 3 Q23 9 20 13.5 L12 13.5 Q9 9 16 3 Z" fill="#ff8a2a" />
          <path d="M16 7 Q19.5 10.5 18 13.5 L14 13.5 Q12.5 10.5 16 7 Z" fill="#ffe08a" />
        </g>
      );
    case 'tool:rope':
      return (
        <g fill="none" stroke="#c9a77a" strokeWidth="2.4">
          <ellipse cx="16" cy="16" rx="10" ry="8" />
          <ellipse cx="16" cy="16" rx="6" ry="4.6" />
          <path d="M24 21 Q27 26 23 29" strokeLinecap="round" />
        </g>
      );
    case 'tool:whetstone':
      return (
        <g transform="rotate(-18 16 16)">
          <rect x="5" y="12" width="22" height="9" rx="3" fill="#7d8790" />
          <rect x="6" y="12" width="20" height="3" rx="1.5" fill="#b8c1c9" />
        </g>
      );
    case 'tool:fishing_rod':
      return (
        <g strokeLinecap="round" fill="none">
          <path d="M5 29 L26 4" stroke={handle} strokeWidth="2.2" />
          <path d="M5 29 L9 24" stroke="#3a2a1a" strokeWidth="3.2" />
          <path d="M26 4 Q29 14 25 20" stroke="#e9e1cf" strokeWidth="0.9" />
          <circle cx="25" cy="22" r="2.3" fill="#e0405a" stroke="#fff" strokeWidth="0.8" />
        </g>
      );
    case 'tool:spirit_whistle':
      return (
        <g>
          <circle cx="16" cy="16" r="11" fill="#8fd3ff" opacity="0.18" />
          <path d="M6 18 L20 12 Q26 11 26.5 16 Q26.5 21 21 20.5 L7 22 Z" fill="#cfe9f5" stroke="#5d8aa8" strokeWidth="1.2" />
          <circle cx="22" cy="16.3" r="2" fill="#5d8aa8" />
          <path d="M12 14 L13 11" stroke="#5d8aa8" strokeWidth="1.2" />
        </g>
      );
    default:
      // the pickaxe (and any tool without its own drawing)
      return (
        <g strokeLinecap="round">
          <path d="M10 27 L21 9" stroke={handle} strokeWidth="2.4" />
          <path d="M12 8 Q20 3 28 10" stroke={steel} strokeWidth="3" fill="none" />
        </g>
      );
  }
}

/** Food by what it is: a loaf, a wedge of cheese, an apple, a bowl, a skewer, a pie, a fish dish, a cut of meat. */
function foodIcon(key: string): JSX.Element {
  const k = key.slice(key.indexOf(':') + 1);
  if (k === 'cheese')
    return (
      <g>
        <path d="M5 22 L27 22 L27 14 L9 9 Z" fill="#f2c94c" />
        <path d="M5 22 L9 9 L27 14" fill="none" stroke="#c99a2e" strokeWidth="1" />
        <circle cx="14" cy="17" r="1.8" fill="#d4a63a" />
        <circle cx="21" cy="18.5" r="1.4" fill="#d4a63a" />
      </g>
    );
  if (k === 'apple')
    return (
      <g>
        <path d="M16 10 Q8 7 7 16 Q8 27 16 26 Q24 27 25 16 Q24 7 16 10 Z" fill="#d6443a" />
        <path d="M16 10 L17 5" stroke="#6a4a2a" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M17 7 Q22 4 23 8 Q19 9 17 7 Z" fill="#5fae4a" />
        <ellipse cx="11.5" cy="15" rx="1.6" ry="3" fill="#fff" opacity="0.35" />
      </g>
    );
  if (/stew|broth|chowder|curry|feast|banquet/.test(k))
    return (
      <g>
        <path d="M5 16 L27 16 Q26 27 16 27 Q6 27 5 16 Z" fill="#8a5a34" />
        <ellipse cx="16" cy="16" rx="11" ry="3" fill={/curry/.test(k) ? '#e08a2a' : /frost|chowder/.test(k) ? '#e9dcc0' : '#b5652e'} />
        <path d="M12 12 Q10 9 12 6 M17 12 Q15 9 17 5 M22 12 Q20 9 22 6" stroke="#fff" strokeOpacity="0.5" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </g>
    );
  if (k.includes('skewer'))
    return (
      <g strokeLinecap="round">
        <path d="M5 27 L27 5" stroke="#b08a5a" strokeWidth="1.6" />
        {[10, 16, 22].map((o) => (
          <circle key={o} cx={o} cy={32 - o} r="3.4" fill={o === 16 && k.includes('ember') ? '#e0612f' : '#9a4a2a'} />
        ))}
      </g>
    );
  if (/pie|tart/.test(k))
    return (
      <g>
        <path d="M5 22 L27 22 L22 12 Q16 9 10 12 Z" fill="#d9a05a" />
        <path d="M8 18 L24 18" stroke={k.includes('berry') ? '#8a2a5a' : '#b5652e'} strokeWidth="3" />
        <path d="M10 12 Q16 9 22 12" stroke="#f0c483" strokeWidth="1.6" fill="none" />
      </g>
    );
  if (/perch|trout|eel|fillet|fish/.test(k)) return fishShape('#c98a4a', '#e3b06a');
  if (/meat|steak/.test(k))
    return (
      <g>
        <path d="M7 14 Q9 6 19 7 Q27 9 26 17 Q24 25 15 25 Q6 24 7 14 Z" fill="#8a4a2a" />
        <path d="M11 15 Q13 10 19 11 Q23 13 22 17" stroke="#c98a4a" strokeWidth="1.4" fill="none" />
      </g>
    );
  return (
    <g>
      <ellipse cx="16" cy="19" rx="11" ry="7" fill="#c98a4a" />
      <ellipse cx="16" cy="16" rx="9" ry="5" fill="#e3b06a" />
      <path d="M10 15 L12 13 M15 14 L17 12 M20 15 L22 13" stroke="#b07a3a" strokeWidth="1.2" strokeLinecap="round" />
    </g>
  );
}

function fishShape(body: string, belly: string): JSX.Element {
  return (
    <g>
      <path d="M4 16 Q11 7 21 11 L28 6 L26 16 L28 26 L21 21 Q11 25 4 16 Z" fill={body} />
      <path d="M6 17 Q12 22 20 19" stroke={belly} strokeWidth="2" fill="none" />
      <circle cx="9" cy="14.5" r="1.3" fill="#1d140a" />
    </g>
  );
}

const HERB_COLOR: Record<string, string> = { heartleaf: '#5fbf4a', emberroot: '#e0612f', frostcap: '#a8dcff', glowmoss: '#c4ff6e', duskpetal: '#9a6bff' };

/** A stable pair of colours per fish species. */
function fishColors(k: string): [string, string] {
  let h = 0;
  for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
  const hue = /ember/.test(k) ? 18 : /frost/.test(k) ? 200 : /gloam|deep/.test(k) ? 265 : /koi/.test(k) ? 32 : h % 360;
  return [`hsl(${hue} 32% 52%)`, `hsl(${hue} 40% 78%)`];
}

/** Materials (herbs, meat, hides, fish, wood, stone, earth, plants, camp kits, quest items, seeds). */
function materialIcon(key: string): JSX.Element {
  const cat = key.slice(0, Math.max(0, key.indexOf(':')));
  const k = key.slice(key.indexOf(':') + 1);
  switch (cat) {
    case 'herb': {
      const c = HERB_COLOR[k] ?? '#5fae4a';
      return (
        <g>
          <path d="M16 28 L16 14" stroke="#4a6a2a" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M16 15 Q6 13 7 5 Q15 5 16 15 Z" fill={c} />
          <path d="M16 18 Q26 16 25 8 Q17 8 16 18 Z" fill={c} opacity="0.85" />
          <path d="M16 15 L10 8 M16 18 L22 11" stroke="#000" strokeOpacity="0.2" strokeWidth="0.8" />
        </g>
      );
    }
    case 'meat':
      return (
        <g>
          <path d="M6 14 Q8 6 18 7 Q26 9 25 17 Q23 25 14 24 Q5 23 6 14 Z" fill="#d0606a" />
          <path d="M10 15 Q13 10 19 12" stroke="#f5d0c8" strokeWidth="1.6" fill="none" />
          <path d="M23 21 L28 26" stroke="#efe6d6" strokeWidth="2.6" strokeLinecap="round" />
        </g>
      );
    case 'hide':
      return <path d="M9 6 L13 9 L19 9 L23 6 L24 12 L28 14 L25 19 L26 27 L19 24 L13 24 L6 27 L7 19 L4 14 L8 12 Z" fill="#8a7a6a" stroke="#5a4a3a" strokeWidth="1" />;
    case 'fish': {
      const [b, l] = fishColors(k);
      return fishShape(b, l);
    }
    case 'wood':
      if (k === 'log')
        return (
          <g>
            <path d="M7 11 L24 11 L24 23 L7 23 Z" fill="#8a5a34" />
            <ellipse cx="24" cy="17" rx="4" ry="6" fill="#d9b07a" />
            <ellipse cx="24" cy="17" rx="2" ry="3" fill="none" stroke="#a77b4f" strokeWidth="0.9" />
            <ellipse cx="7" cy="17" rx="2.5" ry="6" fill="#6a4426" />
          </g>
        );
      if (k === 'resin') return <path d="M16 5 Q24 16 22 22 Q20 28 16 28 Q12 28 10 22 Q8 16 16 5 Z" fill="#e8a33d" opacity="0.9" />;
      if (k === 'stick') return <path d="M6 26 L26 7 M16 16 L21 18" stroke="#8a6a44" strokeWidth="2.4" strokeLinecap="round" fill="none" />;
      return (
        <g strokeLinecap="round" strokeWidth="3.2">
          <path d="M5 22 L27 15" stroke="#8a5a34" />
          <path d="M6 16 L26 22" stroke="#a77b4f" />
          <path d="M8 26 L25 26" stroke="#6a4426" />
          <path d="M14 13 L18 29" stroke="#c9a650" strokeWidth="1.4" />
        </g>
      );
    case 'stone':
      if (k === 'flint') return <path d="M8 22 L12 8 L22 6 L26 15 L19 27 Z" fill="#4a4e57" stroke="#8a919c" strokeWidth="1" />;
      return (
        <g>
          <path d="M6 12 L16 7 L26 12 L26 23 L16 28 L6 23 Z" fill="#8d9196" />
          <path d="M6 12 L16 17 L26 12 M16 17 L16 28" stroke="#5f6368" strokeWidth="1.2" fill="none" />
        </g>
      );
    case 'earth':
      return (
        <g>
          <path d="M4 25 Q9 11 16 10 Q24 11 28 25 Z" fill="#7a5532" />
          <circle cx="12" cy="20" r="1.4" fill="#5a3a1e" />
          <circle cx="19" cy="17" r="1.2" fill="#5a3a1e" />
          <circle cx="21" cy="22" r="1.5" fill="#9a7550" />
        </g>
      );
    case 'plant':
      if (k === 'berries')
        return (
          <g>
            <path d="M16 6 Q18 10 16 13" stroke="#4a6a2a" strokeWidth="1.4" fill="none" />
            {[
              [12, 17],
              [19, 16],
              [15, 22],
              [21, 22],
              [10, 23],
            ].map(([x, y]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r="3.4" fill="#7a2a6a" stroke="#4a1040" strokeWidth="0.8" />
            ))}
          </g>
        );
      return <path d="M8 28 Q10 16 6 5 M14 28 Q15 15 13 4 M20 28 Q19 16 22 5 M25 28 Q23 18 27 8" stroke="#8fae5a" strokeWidth="1.6" fill="none" strokeLinecap="round" />;
    case 'camp':
      return campIcon(k);
    case 'seed':
      return (
        <g>
          <ellipse cx="11" cy="18" rx="3" ry="4.5" fill="#b08a5a" transform="rotate(-20 11 18)" />
          <ellipse cx="20" cy="15" rx="3" ry="4.5" fill="#c9a06a" transform="rotate(25 20 15)" />
          <ellipse cx="17" cy="24" rx="3" ry="4.5" fill="#9a7a4a" transform="rotate(80 17 24)" />
        </g>
      );
    case 'quest':
      return (
        <g>
          <path d="M8 7 L24 7 L24 25 L8 25 Z" fill="#e9dcbc" />
          <path d="M8 7 Q5 7 5 10 Q5 13 8 13 M24 25 Q27 25 27 22 Q27 19 24 19" fill="#d6c7a0" />
          <path d="M11 12 L21 12 M11 15.5 L21 15.5 M11 19 L17 19" stroke="#8a7a5a" strokeWidth="1" />
          <circle cx="20" cy="22" r="2.6" fill="#b8323c" />
        </g>
      );
    default:
      return <circle cx="16" cy="16" r="8" fill="#b0a890" />;
  }
}

/** Camp kits (CR 025) by what they build: a campfire, a bedroll, a chest, a workbench, a signpost. */
function campIcon(k: string): JSX.Element {
  switch (k) {
    case 'campfire':
      return (
        <g strokeLinecap="round">
          <path d="M6 27 L24 21 M8 21 L26 27" stroke="#6a4426" strokeWidth="3" />
          <path d="M16 5 Q24 13 21 20 Q16 24 11 20 Q8 13 16 5 Z" fill="#ff8a2a" />
          <path d="M16 11 Q20 15 18.5 19 Q16 21 13.5 19 Q12 15 16 11 Z" fill="#ffe08a" />
        </g>
      );
    case 'bedroll':
      return (
        <g>
          <rect x="4" y="15" width="22" height="10" rx="5" fill="#6a7fa8" />
          <circle cx="24" cy="20" r="5" fill="#8fa3c8" />
          <circle cx="24" cy="20" r="2.4" fill="none" stroke="#4a5a7a" strokeWidth="1" />
          <path d="M10 15 L10 25 M15 15 L15 25" stroke="#c9a650" strokeWidth="1.6" />
        </g>
      );
    case 'chest':
      return (
        <g>
          <path d="M5 14 Q5 7 16 7 Q27 7 27 14 Z" fill="#9a6a3a" />
          <rect x="5" y="14" width="22" height="13" fill="#8a5a2e" />
          <path d="M5 14 L27 14 M10 7.5 L10 27 M22 7.5 L22 27" stroke="#c9a650" strokeWidth="1.4" />
          <rect x="14" y="13" width="4" height="5" rx="1" fill="#e8c47a" />
        </g>
      );
    case 'workbench':
      return (
        <g strokeLinecap="round">
          <rect x="4" y="12" width="24" height="4" fill="#a77b4f" />
          <path d="M7 16 L7 27 M25 16 L25 27" stroke="#8a5a34" strokeWidth="2.6" />
          <path d="M12 11 L17 5" stroke="#8a6a44" strokeWidth="2" />
          <rect x="15" y="3" width="6" height="3.4" rx="0.8" fill="#a9adb3" transform="rotate(40 18 5)" />
        </g>
      );
    case 'signpost':
      return (
        <g>
          <path d="M15 8 L15 29" stroke="#8a5a34" strokeWidth="2.6" strokeLinecap="round" />
          <path d="M6 7 L23 7 L27 11 L23 15 L6 15 Z" fill="#c9a06a" stroke="#6a4426" strokeWidth="1" />
          <path d="M9 11 L19 11" stroke="#6a4426" strokeWidth="1" />
        </g>
      );
    default:
      return (
        <g>
          <rect x="6" y="11" width="20" height="15" rx="2" fill="#8a6a44" />
          <path d="M6 15 L26 15" stroke="#6a4a2a" strokeWidth="1.2" />
          <path d="M14 11 L14 26 M18 11 L18 26" stroke="#c9a650" strokeWidth="1.6" />
        </g>
      );
  }
}

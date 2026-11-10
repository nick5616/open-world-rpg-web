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

export function ItemIcon({ itemKey, size = 34 }: { itemKey: string; size?: number }) {
  const d = itemDef(itemKey);
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
        <g>
          <ellipse cx="16" cy="19" rx="11" ry="7" fill="#c98a4a" />
          <ellipse cx="16" cy="16" rx="9" ry="5" fill="#e3b06a" />
        </g>
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
      body = (
        <g strokeLinecap="round">
          <path d="M10 27 L21 9" stroke="#8a6a44" strokeWidth="2.4" />
          <path d="M12 8 Q20 3 28 10" stroke="#a9adb3" strokeWidth="3" fill="none" />
        </g>
      );
      break;
    default:
      body = <circle cx="16" cy="16" r="8" fill={itemKey.startsWith('herb') ? '#5fae4a' : itemKey.startsWith('meat') ? '#c0504a' : itemKey.startsWith('hide') ? '#8a6a4a' : '#b0a890'} />;
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

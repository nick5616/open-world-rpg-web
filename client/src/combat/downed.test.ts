import { describe, expect, it } from 'vitest';
import { COMBAT, PLAYER_RESPAWN_GRACE_S } from '@lodestone/contracts';
import { downedLines, GRACE_MS, graceLine, killerName, siteName } from './downed';

const slime = COMBAT.enemies.find((e) => e.key === 'slime')!;

describe('downed screen (CR 024)', () => {
  it('names the enemy or player that downed you', () => {
    const drawn = [
      { id: 7, kind: 2, typeId: slime.id },
      { id: 9, kind: 1, name: 'Corin' },
    ];
    expect(killerName(7, drawn)).toBe(`a ${slime.name}`);
    expect(killerName(9, drawn)).toBe('Corin');
    expect(killerName(0, drawn)).toBe('');
    expect(killerName(42, drawn)).toBe(''); // not drawn: no name rather than a wrong one
  });

  it('uses "an" before a vowel', () => {
    const e = COMBAT.enemies.find((x) => /^[aeiou]/i.test(x.name));
    if (e) expect(killerName(1, [{ id: 1, kind: 2, typeId: e.id }])).toBe(`an ${e.name}`);
  });

  it('says where, when and what you keep', () => {
    const l = downedLines({ until: 3000, by: 'a Dewdrop Slime', respawnAt: 'Draedmore' }, 0);
    expect(l.by).toBe('by a Dewdrop Slime');
    expect(l.when).toBe('Back on your feet at Draedmore in 3 s');
    expect(l.keep).toMatch(/keep everything/);
    const unknown = downedLines({ until: 500, by: '', respawnAt: '' }, 600);
    expect(unknown.by).toBe('');
    expect(unknown.when).toBe('Back on your feet where you first arrived…');
  });

  it('names the respawn waypoint, or the town it belongs to', () => {
    const sites = [
      { name: 'Draedmore', category: 'settlement', link: 1 },
      { name: null, category: 'poi', link: -1 },
      { name: 'Old Shrine', category: 'poi', link: -1 },
    ];
    expect(siteName(-1, sites)).toBe('');
    expect(siteName(2, sites)).toBe('Old Shrine');
    expect(siteName(1, sites)).toBe('the Draedmore waypoint');
    expect(siteName(0, undefined)).toBe('');
  });

  it('counts the respawn grace down from the shared constant', () => {
    expect(GRACE_MS).toBe(PLAYER_RESPAWN_GRACE_S * 1000);
    expect(graceLine(GRACE_MS, 0)).toBe(`Enemies leave you alone for ${PLAYER_RESPAWN_GRACE_S} s, or until you strike`);
    expect(graceLine(GRACE_MS, GRACE_MS)).toBeNull();
  });
});

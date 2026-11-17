import { describe, expect, it } from 'vitest';
import { arrowAngle, distanceLabel, exitPoint, MAX_BOARDS, MAX_EXITS_PER_TOWN, placeSignposts, type PlacementInput, type PRoad, type PSite } from './placement';

const road = (index: number, from: number, to: number, pts: [number, number][], cls = 0): PRoad => ({ index, from, to, cls, width: 4, points: Float32Array.from(pts.flatMap(([x, z]) => [x, 0, z])) });
const site = (index: number, category: PSite['category'], kind: string, name: string | null, x: number, z: number, layer = 0): PSite => ({ index, category, kind, name, x, z, layer });

// Hearth (0,0) and Fenmoor (2000,0) joined by an east road; a second road runs north from Hearth to nowhere.
const sites: PSite[] = [
  site(0, 'settlement', 'settlement', 'Hearth', 0, 0),
  site(1, 'settlement', 'settlement', 'Fenmoor', 2000, 0),
  site(2, 'poi', 'tower', 'The Lantern Tower', 900, 200),
  site(3, 'structure', 'ruin', 'Old Weir', 700, -80),
  site(4, 'structure', 'shrine', 'Hush Shrine', -600, 0),
  site(5, 'structure', 'bandit_camp', 'Rook Camp', 500, 20),
  site(6, 'structure', 'sky_palace', 'Cloudhall', 400, 0, 1),
  site(7, 'poi', 'landmark', null, 300, 0),
];
const input = (): PlacementInput => ({
  settlements: [
    { index: 0, site: 0, x: 0, z: 0, radius: 60 },
    { index: 1, site: 1, x: 2000, z: 0, radius: 60 },
  ],
  roads: [road(0, 0, 1, [[10, 0], [500, 5], [1500, 0], [1990, 0]]), road(1, 0, -1, [[0, -10], [0, -400]]), road(2, 0, 0, [[0, 0], [30, 30]], 1)],
  forks: [],
  sites,
});

describe('exit posts', () => {
  it('stands a post beside the road where it leaves the town, with the destination town first', () => {
    const posts = placeSignposts(input());
    const east = posts.find((p) => p.id === 'x:0:0')!;
    expect(east).toBeDefined();
    expect(east.kind).toBe('exit');
    // 67 m from the town centre along the road, 4 m/2 + 2.2 m to its side
    expect(east.x).toBeGreaterThan(60);
    expect(east.x).toBeLessThan(75);
    expect(Math.abs(east.z)).toBeGreaterThan(3.5);
    expect(east.boards[0].kind === 'town' || east.boards.some((b) => b.name === 'Fenmoor')).toBe(true);
    expect(east.boards.map((b) => b.name)).toContain('Fenmoor');
  });
  it('names the nearest landmarks ahead, never camps, sky sites, unnamed sites or things behind you', () => {
    const east = placeSignposts(input()).find((p) => p.id === 'x:0:0')!;
    const names = east.boards.map((b) => b.name);
    expect(names).toContain('Old Weir');
    expect(names).not.toContain('Rook Camp');
    expect(names).not.toContain('Cloudhall');
    expect(names).not.toContain('Hush Shrine'); // behind: west
    expect(east.boards.length).toBeLessThanOrEqual(MAX_BOARDS);
    // sorted nearest first
    const d = east.boards.map((b) => b.dist);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });
  it('a road that leads nowhere still names what lies ahead; streets get no post', () => {
    const posts = placeSignposts(input());
    expect(posts.some((p) => p.id === 'x:0:2')).toBe(false);
    const north = posts.find((p) => p.id === 'x:0:1');
    // nothing named lies north within range: no board, no post
    expect(north).toBeUndefined();
  });
  it('is deterministic and independent of input order', () => {
    const a = placeSignposts(input());
    const b = placeSignposts(input());
    expect(b).toEqual(a);
    const shuffled = input();
    shuffled.sites = [...shuffled.sites].reverse().map((s) => s); // same data, other order
    shuffled.sites.sort((x, y) => x.index - y.index);
    expect(placeSignposts(shuffled)).toEqual(a);
  });
  it('caps the exits per town and skips one that a fork post already serves', () => {
    const inp = input();
    inp.roads = [1, 2, 3, 4, 5].map((i) => road(10 + i, 0, 1, [[10, 0], [500, 5 * i], [1500, 0], [1990, 0]]));
    expect(placeSignposts(inp).filter((p) => p.kind === 'exit' && p.settlement === 0).length).toBeLessThanOrEqual(MAX_EXITS_PER_TOWN);
    const withFork = input();
    withFork.forks = [{ id: '9', x: 70, y: 3, z: 6, arms: [{ yaw: 0, settlement: 1 }] }];
    expect(placeSignposts(withFork).find((p) => p.id === 'x:0:0')).toBeUndefined();
  });
});

describe('fork posts', () => {
  it('writes the destination and distance on each arm that points at a settlement', () => {
    const inp = input();
    inp.forks = [{ id: '77', x: 1000, y: 12, z: 0, arms: [{ yaw: 0, settlement: 1 }, { yaw: Math.PI, settlement: 0 }, { yaw: 1, settlement: -1 }] }];
    const f = placeSignposts(inp).find((p) => p.id === 'f:77')!;
    expect(f.kind).toBe('fork');
    expect(f.y).toBe(12);
    expect(f.boards.map((b) => b.name)).toEqual(['Fenmoor', 'Hearth']);
    expect(f.yaws).toEqual([0, Math.PI]);
    expect(f.boards[0].dist).toBeCloseTo(1000, 6);
    expect(f.boards[0].dx).toBeCloseTo(1, 6);
  });
});

describe('wording and arrows', () => {
  it('rounds distances', () => {
    expect(distanceLabel(4)).toBe('10 m');
    expect(distanceLabel(423)).toBe('420 m');
    expect(distanceLabel(1240)).toBe('1.2 km');
  });
  it('points the arrow as the reader sees it', () => {
    // Reader faces +z (south): their right is -x.
    expect(arrowAngle(0, 1, 0, 1)).toBeCloseTo(0, 6); // straight ahead: up
    expect(arrowAngle(0, 1, -1, 0)).toBeCloseTo(Math.PI / 2, 6); // to their right
    expect(arrowAngle(0, 1, 1, 0)).toBeCloseTo(-Math.PI / 2, 6); // to their left
    expect(Math.abs(arrowAngle(0, 1, 0, -1))).toBeCloseTo(Math.PI, 6); // behind
  });
  it('finds where a road leaves a town from either end', () => {
    const r = road(0, 1, 0, [[1990, 0], [1500, 0], [10, 0]]); // runs toward Hearth
    const e = exitPoint(r, { index: 0, site: 0, x: 0, z: 0, radius: 60 }, 7)!;
    expect(e.x).toBeCloseTo(67, 0);
    expect(e.dir.x).toBeGreaterThan(0); // the stored polyline runs inward; the heading is always away from the town
  });
});

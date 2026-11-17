// build.yaml -> the building pieces appended to the camps tables (playtest 3, CR 041).
//
// Structural pieces x materials and furnishings become camp piece records
// (`build` carries the grid class, sockets, collision boxes and costs, all in
// integer centimetres so the zone and the client compute the same numbers).
// Called from camps.mjs.

function fail(msg) {
  throw new Error(`build.yaml: ${msg}`);
}

const cm = (m, what) => {
  if (typeof m !== 'number' || !Number.isFinite(m)) fail(`${what}: a number`);
  return Math.round(m * 100);
};
const num = (v, what, min = 0) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail(`${what}: a number >= ${min}`);
  return v;
};

const NAMED = {
  edges: [[100, 0], [-100, 0], [0, 100], [0, -100]],
  corners: [[100, 100], [-100, 100], [100, -100], [-100, -100]],
  mid: [[0, 0]],
  ends: [[100, 0], [-100, 0]],
  w: [[-100, 0]],
  e: [[100, 0]],
  wc: [[-100, 100], [-100, -100]],
  ec: [[100, 100], [100, -100]],
};

/** "edges@0+corners@0" -> [[xcm, zcm, ycm], ...] */
function sockets(spec, what) {
  if (spec === undefined || spec === null) return [];
  if (typeof spec !== 'string') fail(`${what}: a socket string`);
  const out = [];
  for (const part of spec.split('+')) {
    const [tok, ys] = part.trim().split('@');
    const y = cm(Number(ys), `${what} height`);
    let pts = NAMED[tok];
    if (!pts) {
      const xz = tok.split(',').map(Number);
      if (xz.length !== 2 || xz.some((n) => !Number.isFinite(n))) fail(`${what}: unknown socket ${tok}`);
      pts = [[Math.round(xz[0] * 100), Math.round(xz[1] * 100)]];
    }
    for (const [x, z] of pts) out.push([x, z, y]);
  }
  return out;
}

const box = (b, what) => {
  if (!Array.isArray(b) || b.length !== 6) fail(`${what}: [x0, x1, z0, z1, y0, y1]`);
  const v = b.map((n, i) => cm(n, `${what}[${i}]`));
  if (v[0] >= v[1] || v[2] >= v[3] || v[4] >= v[5]) fail(`${what}: min < max`);
  return v;
};

const PAR = { odd: 100, even: 0 };

const ANCHORS = new Set(['foundation', 'ground', 'sockets', 'surface', 'wall']);

function shape(pc, what, kind) {
  const b = {};
  if (pc.par !== undefined) {
    if (!Array.isArray(pc.par) || pc.par.length !== 2 || pc.par.some((p) => !(p in PAR))) fail(`${what}.par: [odd|even, odd|even]`);
    b.par = pc.par.map((p) => PAR[p]);
  } else {
    b.par = null; // furnishings: every 0.5 m
  }
  const anchor = pc.anchor ?? (kind === 'furnish' ? ['surface'] : ['sockets']);
  for (const a of anchor) if (!ANCHORS.has(a)) fail(`${what}.anchor: unknown ${a}`);
  b.anchor = anchor;
  b.gpt = pc.gpt ? [cm(pc.gpt[0], `${what}.gpt`), cm(pc.gpt[1], `${what}.gpt`)] : [0, 0];
  b.boxes = (pc.boxes ?? []).map((x, i) => box(x, `${what}.boxes[${i}]`));
  b.openBoxes = pc.openBoxes ? pc.openBoxes.map((x, i) => box(x, `${what}.openBoxes[${i}]`)) : null;
  b.door = pc.state === 'door';
  if (pc.state !== undefined && pc.state !== 'door') fail(`${what}.state: door`);
  if (pc.surface) {
    const s = pc.surface;
    b.surface = [cm(s.x[0], what), cm(s.x[1], what), cm(s.z[0], what), cm(s.z[1], what), cm(s.y[0], what), cm(s.y[1], what)];
  } else {
    b.surface = null;
  }
  if (pc.occ) {
    b.occ = box(pc.occ, `${what}.occ`);
  } else {
    const w = cm(pc.fp[0], what), d = cm(pc.fp[1], what), h = cm(pc.height, what);
    b.occ = [-Math.round(w / 2), Math.round(w / 2), -Math.round(d / 2), Math.round(d / 2), 0, h];
  }
  b.up = sockets(pc.up, `${what}.up`);
  b.down = sockets(pc.down, `${what}.down`);
  b.side = sockets(pc.side, `${what}.side`);
  b.face = sockets(pc.face, `${what}.face`);
  b.reach = pc.reach ?? 0;
  b.coexist = pc.coexist ?? [];
  return b;
}

/** Parse; `itemKeys` is the set of item keys. Returns {config, pieces} (ids not yet 1-based indexes: explicit). */
export function parseBuild(doc, itemKeys) {
  if (doc.version !== 1) fail('version must be 1');
  const item = (k, what) => {
    if (!itemKeys.has(k)) fail(`${what}: unknown item ${k}`);
    return k;
  };
  const g = doc.grid;
  if (g.cellM !== 2 || g.levelM !== 2.5) fail('grid: cellM 2 and levelM 2.5 (the piece sockets assume them)');
  const b = doc.build;
  const f = b.foundation;
  const config = {
    grid: { cellM: g.cellM, levelM: g.levelM, maxLevels: num(g.maxLevels, 'grid.maxLevels', 1) },
    budget: num(b.budget, 'build.budget', 1),
    areaBudget: num(b.areaBudget, 'build.areaBudget', 1),
    reachM: num(b.reachM, 'build.reachM', 1),
    townMarginM: num(b.townMarginM, 'build.townMarginM'),
    siteMarginM: num(b.siteMarginM, 'build.siteMarginM'),
    roadMarginM: num(b.roadMarginM, 'build.roadMarginM'),
    otherBuildM: num(b.otherBuildM, 'build.otherBuildM'),
    refundPct: num(b.refundPct, 'build.refundPct'),
    repairPct: num(b.repairPct, 'build.repairPct'),
    weatherFloor: num(b.weatherFloor, 'build.weatherFloor'),
    mendPerDay: num(b.mendPerDay, 'build.mendPerDay'),
    decayDays: num(b.decayDays, 'build.decayDays', 1),
    foundation: { maxSpreadM: num(f.maxSpreadM, 'foundation'), maxBuriedM: num(f.maxBuriedM, 'foundation'), skirtM: num(f.skirtM, 'foundation'), snapM: num(f.snapM, 'foundation', 0.01) },
    maxHeightM: num(b.maxHeightM, 'build.maxHeightM', 1),
    hearth: { wardRadiusM: num(doc.hearth.wardRadiusM, 'hearth.wardRadiusM', 1), warmthM: num(doc.hearth.warmthM, 'hearth.warmthM', 1) },
    comfort: {
      radiusM: num(doc.comfort.radiusM, 'comfort.radiusM', 1),
      perKindCap: num(doc.comfort.perKindCap, 'comfort.perKindCap', 1),
      maxScore: num(doc.comfort.maxScore, 'comfort.maxScore', 1),
      tiers: doc.comfort.tiers.map((t) => ({ score: num(t.score, 'comfort.tiers'), name: String(t.name) })),
      durationPct: num(doc.comfort.durationPct, 'comfort.durationPct'),
      regenPct: num(doc.comfort.regenPct, 'comfort.regenPct'),
    },
    home: { cooldownS: num(doc.home.cooldownS, 'home.cooldownS') },
    materials: [],
  };
  const mats = Object.keys(doc.materials);
  if (mats.length > 4) fail('materials: at most 4 (ids are 100 + 4*piece + material)');
  config.materials = mats.map((key, i) => {
    const m = doc.materials[key];
    const per = Object.entries(m.perUnit).map(([k, q]) => ({ item: item(k, `materials.${key}.perUnit`), qty: num(q, `materials.${key}.perUnit.${k}`, 0.01) }));
    return { key, index: i, name: m.name, perUnit: per, weather: num(m.weather, `materials.${key}.weather`) };
  });
  const pieces = [];
  const structure = Object.keys(doc.structure);
  if (structure.length > 38) fail('structure: at most 38 pieces');
  structure.forEach((key, i) => {
    const pc = doc.structure[key];
    const what = `structure.${key}`;
    const sh = shape(pc, what, 'structure');
    const fp = [num(pc.fp[0], what, 0.05), num(pc.fp[1], what, 0.05)];
    const units = num(pc.units, `${what}.units`, 1);
    const extra = Object.entries(pc.extra ?? {}).map(([k, q]) => ({ item: item(k, `${what}.extra`), qty: num(q, `${what}.extra.${k}`, 1) }));
    const top = Math.max(...sh.occ.slice(5), ...(sh.surface ? [sh.surface[4], sh.surface[5]] : [0])) / 100;
    for (const m of config.materials) {
      const cost = new Map();
      for (const { item: it, qty } of m.perUnit) cost.set(it, Math.max(1, Math.ceil(units * qty - 1e-9)));
      for (const { item: it, qty } of extra) cost.set(it, (cost.get(it) ?? 0) + qty);
      pieces.push({
        key: `${key}_${m.key}`,
        id: 100 + 4 * i + m.index,
        name: `${m.name} ${pc.name}`,
        kit: '',
        w: fp[0],
        d: fp[1],
        height: Math.max(top, 0.05),
        solid: sh.boxes.length > 0,
        max: config.budget,
        desc: pc.desc ?? '',
        build: { cat: 'structure', base: key, mat: m.index, ...sh, cost: [...cost].map(([it, qty]) => ({ item: it, qty })), comfort: 0, use: '', slots: 0, light: 0 },
      });
    }
  });
  const used = new Set();
  for (const key of Object.keys(doc.furnish)) {
    const pc = doc.furnish[key];
    const what = `furnish.${key}`;
    const id = pc.id;
    if (!Number.isInteger(id) || id < 200 || id > 255 || used.has(id)) fail(`${what}.id: a unique integer 200-255`);
    used.add(id);
    const sh = shape(pc, what, 'furnish');
    const cost = Object.entries(pc.cost).map(([k, q]) => ({ item: item(k, `${what}.cost`), qty: num(q, `${what}.cost.${k}`, 1) }));
    pieces.push({
      key,
      id,
      name: pc.name,
      kit: '',
      w: num(pc.fp[0], what, 0.05),
      d: num(pc.fp[1], what, 0.05),
      height: num(pc.height, `${what}.height`, 0.01),
      solid: sh.boxes.length > 0,
      max: pc.max ?? config.budget,
      desc: pc.desc ?? '',
      build: { cat: 'furnish', base: key, mat: -1, ...sh, cost, comfort: pc.comfort ?? 0, use: pc.use ?? '', slots: pc.slots ?? 0, light: pc.light ?? 0 },
    });
  }
  const keys = new Set();
  for (const p of pieces) {
    if (keys.has(p.key)) fail(`duplicate piece key ${p.key}`);
    keys.add(p.key);
  }
  for (const p of pieces) for (const c of p.build.coexist) if (!structureKey(doc, c)) fail(`${p.key}.coexist: unknown piece ${c}`);
  return { config, pieces };
}

function structureKey(doc, k) {
  return k in doc.structure || k in doc.furnish;
}

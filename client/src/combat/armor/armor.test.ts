// Playtest 2 visible armor (CR 034): the appearance number (the zone's
// twin), its model spec for every armor item in items.yaml, the meshes
// built from it (shared, built once per appearance), and the avatar wearing
// it: bones, hidden bare parts, draw calls, LOD.

import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ITEMS } from '@lodestone/contracts';
import { ARMOR_ITEMS, appearanceOfItems, armorVisualId, gemIndex, packAppearance, unpackAppearance } from './appearance';
import { ARMOR_BONES, armorPalette, armorSpec, BONE_INDEX, GLOW_FROM_RARITY, HOLO_RARITY } from './spec';
import { ARMOR_PART_IDS, acquireArmor, armorBuilds, buildFpForearm, buildMidArmor, buildRigArmor, cachedArmor, releaseArmor } from './model';
import type { RemoteView } from '../../net/interpolation';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
});

const SLOT_BONES: Record<string, readonly string[]> = {
  head: ['neck'],
  body: ['torso', 'body', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR'],
  legs: ['hipL', 'hipR', 'kneeL', 'kneeR', 'body'],
};

const one = (key: string, rarity = 0, gem = -1): number => {
  const def = ITEMS.items.find((i) => i.key === key)!;
  const pieces = [null, null, null] as ({ key: string; rarity: number; gem: number } | null)[];
  pieces[['head', 'body', 'legs'].indexOf(def.armor!)] = { key, rarity, gem };
  return packAppearance(pieces);
};

describe('appearance number (the zone twin, server/zone/internal/game/appearance.go)', () => {
  it('round-trips and matches the zone vector', () => {
    const ap = packAppearance([{ key: 'armor:iron_helm', rarity: 3, gem: 0 }, { key: 'armor:cloth_robe', rarity: 7, gem: -1 }, null]);
    expect(ap).toBe(1017261316); // TestAppearancePackRoundTrip's vector
    const [h, b, l] = unpackAppearance(ap);
    expect(h).toEqual({ slot: 'head', key: 'armor:iron_helm', style: 'helm', material: 'iron', rarity: 3, gem: 0 });
    expect(b).toMatchObject({ slot: 'body', key: 'armor:cloth_robe', style: 'robe', material: 'cloth', rarity: 7, gem: -1 });
    expect(l).toBeNull();
    expect(unpackAppearance(BigInt(ap))).toEqual(unpackAppearance(ap));
    expect(packAppearance([null, null, null])).toBe(0);
    // the inventory's equipped items give the same number (gem from the first socket)
    expect(appearanceOfItems([{ b: 'armor:iron_helm', s: 'eq:head', r: 3, k: ['gem:ruby:cut'] }, { b: 'armor:cloth_robe', s: 'eq:body', r: 7 }, { b: 'armor:iron_greaves', s: 'inv:3', r: 1 }])).toBe(ap);
    expect(gemIndex('gem:opal:rough')).toBe(ITEMS.gems.findIndex((g) => g.key === 'opal'));
  });

  it('every armor piece has a visual id, a style for its slot, and the biggest outfit stays below 2^53', () => {
    expect(ARMOR_ITEMS.length).toBeGreaterThan(15);
    expect(ARMOR_ITEMS.length).toBeLessThan(64);
    for (const it of ARMOR_ITEMS) {
      expect(armorVisualId(it.key)).toBeGreaterThan(0);
      expect(it.style).toBeTruthy();
    }
    const last = (slot: string) => ARMOR_ITEMS.filter((i) => i.armor === slot).at(-1)!.key;
    const max = packAppearance([{ key: last('head'), rarity: 7, gem: 9 }, { key: last('body'), rarity: 7, gem: 9 }, { key: last('legs'), rarity: 7, gem: 9 }]);
    expect(max).toBeLessThan(2 ** 53);
    expect(unpackAppearance(max).map((p) => p?.key)).toEqual([last('head'), last('body'), last('legs')]);
  });
});

describe('model spec for every armor item', () => {
  for (const item of ARMOR_ITEMS) {
    it(`${item.key} (${item.style}, ${item.material})`, () => {
      for (const rarity of [0, GLOW_FROM_RARITY, HOLO_RARITY]) {
        const spec = armorSpec(one(item.key, rarity, rarity === GLOW_FROM_RARITY ? 0 : -1));
        const slot = item.armor!;
        expect(spec.parts.length).toBeGreaterThan(0);
        for (const p of spec.parts) {
          expect(ARMOR_PART_IDS, p.id).toContain(p.id);
          expect(SLOT_BONES[slot], `${p.id} on ${p.bone}`).toContain(p.bone);
          expect(p.slot).toBe(slot);
        }
        const f = spec.finish[slot]!;
        expect(f).toBeTruthy();
        // the rarity's accent: plain for common, a glow from relic up, holographic (negative glow) for Bitchin'
        if (rarity === 0) expect(f.trim.glow).toBe(armorPalette(item.material!).edge.glow); // no rarity glow: the metal's own
        if (rarity === GLOW_FROM_RARITY) {
          expect(f.trim.glow).toBeGreaterThan(0);
          expect(f.gem).not.toBeNull();
          expect(spec.parts.some((p) => p.id.startsWith('gem.'))).toBe(true);
        }
        if (rarity === HOLO_RARITY) expect(f.trim.glow).toBeLessThan(0);
        if (item.material === 'sunsteel' && rarity < HOLO_RARITY) expect(f.base.glow).toBeGreaterThan(0); // sunsteel glows (Bitchin': holographic instead)
        // the bare parts it replaces
        if (slot === 'body') expect(spec.hides).toMatchObject({ torso: true, upperArms: true, forearms: true, head: false });
        if (slot === 'legs') expect(spec.hides.shins).toBe(true);
        if (slot === 'legs') expect(spec.hides.thighs).toBe(item.style !== 'boots');
        if (slot === 'head') expect(spec.hides.head).toBe(item.style === 'helm' && item.material !== 'iron');
        expect(spec.tint).not.toBeNull();
        expect(spec.midHead !== 'none' || spec.midBody !== 'none' || spec.midLegs).toBe(true);

        // the meshes: one skinned geometry, every vertex on a real bone; a mid silhouette; a sleeve for body armor
        const rig = buildRigArmor(spec);
        const n = rig.getAttribute('position').count;
        expect(n).toBeGreaterThan(30);
        expect(rig.index!.count / 3).toBeLessThan(3000);
        const si = rig.getAttribute('skinIndex');
        const bones = new Set<number>();
        for (let i = 0; i < n; i++) bones.add(si.getX(i));
        for (const b of bones) expect(b).toBeLessThan(ARMOR_BONES.length);
        expect([...bones].sort()).toEqual([...new Set(spec.parts.map((p) => BONE_INDEX[p.bone]))].sort());
        for (const a of ['normal', 'color', 'surf', 'skinWeight']) expect(rig.getAttribute(a).count).toBe(n);
        const mid = buildMidArmor(spec);
        expect(mid.getAttribute('position').count).toBeGreaterThan(8);
        expect(mid.index!.count / 3).toBeLessThan(400);
        const fp = buildFpForearm(spec);
        if (slot === 'body') expect(fp!.getAttribute('position').count).toBeGreaterThan(20);
        else expect(fp).toBeNull();
        rig.dispose();
        mid.dispose();
        fp?.dispose();
      }
    });
  }
});

function view(appearance: number, z = 20): RemoteView {
  return { id: 9, kind: 1, name: 'Knight', level: 3, healthPct: 100, activity: 0, partyId: 0, typeId: 0, appearance, ring: 0, delayMs: 0, x: 10, y: 0, z, yaw: 0, pitch: 0, speed: 0, mode: 'interp' } as unknown as RemoteView;
}

function drawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.updateMatrixWorld(true);
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if ((o as THREE.Mesh).isMesh) n++;
    for (const c of o.children) walk(c);
  };
  walk(root);
  return n;
}

describe('the avatar wearing it', () => {
  const full = packAppearance([{ key: 'armor:starmetal_helm', rarity: 5, gem: 1 }, { key: 'armor:silver_cuirass', rarity: 4, gem: -1 }, { key: 'armor:iron_greaves', rarity: 0, gem: -1 }]);

  it('one skinned outfit on the rig bones, bare parts hidden, fewer draw calls, rebuilt only on change', async () => {
    const { Avatar } = await import('../../net/avatar');
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(10, 1.6, 24);
    const a = new Avatar(9, { nameplate: false });
    a.update(view(0), cam, 0.016);
    expect(a.lodLevel).toBe(0);
    const bare = drawCalls(a.root);
    // playtest 2 immersion pass: a bare head shows its hair and face
    expect(a.root.getObjectByName('avatar-hair')!.visible).toBe(true);
    expect(a.root.getObjectByName('avatar-face')!.visible).toBe(true);

    const built = armorBuilds.count;
    a.update(view(full), cam, 0.016);
    expect(armorBuilds.count).toBe(built + 1);
    for (let i = 0; i < 20; i++) a.update(view(full), cam, 0.016);
    expect(armorBuilds.count).toBe(built + 1); // nothing rebuilt while it stays the same
    const dressed = drawCalls(a.root);
    expect(dressed).toBeLessThan(bare); // one outfit mesh replaces head, visor, chest, arms and legs
    expect(a.root.getObjectByName('avatar-hair')!.visible).toBe(false); // no hair through the helm

    const rig = a.root.getObjectByName('avatar-armor') as THREE.SkinnedMesh;
    expect(rig.isSkinnedMesh).toBe(true);
    expect(rig.skeleton.bones.length).toBe(ARMOR_BONES.length);
    expect(a.root.getObjectByName('avatar-chest')!.visible).toBe(false);
    // the helm sits on the head, the greaves on the legs: skinned positions in the world
    a.root.updateMatrixWorld(true);
    rig.skeleton.update();
    const ys = { head: [] as number[], legs: [] as number[] };
    const v = new THREE.Vector3();
    const si = rig.geometry.getAttribute('skinIndex');
    for (let i = 0; i < si.count; i += 7) {
      rig.getVertexPosition(i, v);
      rig.localToWorld(v);
      const bone = ARMOR_BONES[si.getX(i)];
      if (bone === 'neck') ys.head.push(v.y);
      if (bone === 'kneeL' || bone === 'kneeR') ys.legs.push(v.y);
    }
    expect(Math.min(...ys.head)).toBeGreaterThan(1.4);
    expect(Math.max(...ys.head)).toBeLessThan(2.1);
    expect(Math.max(...ys.legs)).toBeLessThan(0.6);
    expect(Math.min(...ys.legs)).toBeGreaterThan(-0.05);

    // a second avatar in the same outfit shares the geometry (no new build)
    const b = new Avatar(10, { nameplate: false });
    b.update({ ...view(full), id: 10 }, cam, 0.016);
    expect(armorBuilds.count).toBe(built + 1);
    expect((b.root.getObjectByName('avatar-armor') as THREE.Mesh).geometry).toBe(rig.geometry);

    // taking it all off brings the bare rig back; the last wearer leaving frees the outfit
    a.update(view(0), cam, 0.016);
    expect(drawCalls(a.root)).toBe(bare);
    expect(a.root.getObjectByName('avatar-chest')!.visible).toBe(true);
    expect(a.root.getObjectByName('avatar-hair')!.visible).toBe(true);
    expect(cachedArmor()).toContain(full);
    b.dispose();
    expect(cachedArmor()).not.toContain(full);
    a.dispose();
  });

  it('mid LOD shows the silhouette, the far box takes the armor colour', async () => {
    const { Avatar } = await import('../../net/avatar');
    const cam = new THREE.PerspectiveCamera();
    const a = new Avatar(11, { nameplate: false });
    cam.position.set(10, 1.6, 20 + 50);
    a.update(view(full), cam, 0.016);
    expect(a.lodLevel).toBe(1);
    const mid = a.root.getObjectByName('avatar-armor-mid') as THREE.Mesh;
    expect(mid.visible).toBe(true);
    expect(mid.geometry.name).toBe(`armor-mid:${full}`);
    cam.position.set(10, 1.6, 20 + 200);
    a.update(view(full), cam, 0.016);
    expect(a.lodLevel).toBe(2);
    const box = a.root.children.find((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry.type === 'BoxGeometry' && ((c as THREE.Mesh).geometry as THREE.BoxGeometry).parameters.height === 1.8) as THREE.Mesh;
    const tint = armorSpec(full).tint!;
    expect((box.material as THREE.MeshStandardMaterial).color.getHex()).toBe(tint.getHex());
    a.update(view(0), cam, 0.016);
    expect((box.material as THREE.MeshStandardMaterial).color.getHex()).not.toBe(tint.getHex());
    a.dispose();
  });

  it('first-person forearms wear the body armor and go back to the sleeve', async () => {
    const { dressForearms } = await import('./fp');
    const { forearmGeometry } = await import('../weapons/models');
    const mk = () => new THREE.Mesh(forearmGeometry());
    const rig = { rArm: mk(), lArm: mk(), castArm: mk() };
    const ap = one('armor:iron_cuirass', 2);
    dressForearms(rig, ap);
    expect(rig.rArm.geometry.name).toBe(`armor-fp:${ap}`);
    expect(rig.castArm.geometry).toBe(rig.rArm.geometry);
    dressForearms(rig, one('armor:iron_helm'));
    expect(rig.rArm.geometry).toBe(forearmGeometry()); // a helmet alone: the plain sleeve
    dressForearms(rig, 0);
    expect(rig.lArm.geometry).toBe(forearmGeometry());
    const held = acquireArmor(ap);
    releaseArmor(ap);
    expect(held.spec.ap).toBe(ap);
  });
});

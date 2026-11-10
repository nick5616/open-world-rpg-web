// Taming and pets in the world (playtest 2, CR 029): a bobbing paw-and-
// question mark over every calm creature (it sniffs: feed it), a ring of
// sparkles and rising hearts when a creature is tamed, hearts when a pet is
// petted, a coloured burst ring when a pet uses its ability, and crumbs
// when one is fed. The pets themselves are the enemy renderer's models
// (combat/enemies, petSpec: a collar, a friendly tint); this layer only
// draws the moments. Pooled sprites; nothing allocated per frame.

import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { drawnRemotes } from '../../net/netStore';
import { ELEMENT_COLORS } from '../../combat/events';
import { ACT, abilityById2 } from './events';
import { usePets } from './store';

function glyphTexture(glyph: string, color: string, ring = false): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  if (ring) {
    g.strokeStyle = color;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(32, 32, 26, 0, Math.PI * 2);
    g.stroke();
  } else {
    g.font = 'bold 46px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.8)';
    g.shadowBlur = 6;
    g.fillStyle = color;
    g.fillText(glyph, 32, 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const POOL = 48;

export function PetLayer() {
  const kit = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'pets-fx';
    const sniff = glyphTexture('?', '#ffe9a8');
    const heart = glyphTexture('♥', '#ff7aa2');
    const spark = glyphTexture('✦', '#ffd166');
    const ring = glyphTexture('', '#ffffff', true);
    const sprites: THREE.Sprite[] = [];
    for (let i = 0; i < POOL; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: sniff, transparent: true, depthWrite: false, depthTest: false }));
      s.visible = false;
      s.renderOrder = 12;
      sprites.push(s);
      group.add(s);
    }
    return { group, sprites, sniff, heart, spark, ring };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as unknown as { __lodestonePetFx?: unknown }).__lodestonePetFx = () => kit.sprites.filter((s) => s.visible).length;
    }
    return () => {
      for (const t of [kit.sniff, kit.heart, kit.spark, kit.ring]) t?.dispose();
      for (const sp of kit.sprites) sp.material.dispose();
    };
  }, [kit]);

  useFrame(({ scene }) => {
    if (kit.group.parent !== scene) scene.add(kit.group);
    const now = performance.now();
    const s = usePets.getState();
    let n = 0;
    const put = (tex: THREE.Texture | null, x: number, y: number, z: number, size: number, opacity: number, color?: string) => {
      if (n >= POOL) return;
      const sp = kit.sprites[n++];
      const m = sp.material;
      m.map = tex;
      sp.position.set(x, y, z);
      sp.scale.set(size, size, 1);
      sp.visible = true;
      m.opacity = Math.max(0, Math.min(1, opacity));
      if (color) m.color.set(color);
      else m.color.set('#ffffff');
    };
    const pos = (id: number) => drawnRemotes.views.find((v) => v.id === id);
    // calm creatures: a bobbing "?" (it sniffs at you)
    for (const c of Object.values(s.calm)) {
      if (c.until < now) continue;
      const v = pos(c.id);
      const x = v?.x ?? c.x;
      const y = (v?.y ?? c.y) + 1.9 + 0.12 * Math.sin(now / 260 + c.id);
      put(kit.sniff, x, y, v?.z ?? c.z, 0.55, 0.9);
    }
    // the meter: hearts rising from the creature being fed
    if (s.meter) {
      const v = pos(s.meter.creature);
      if (v) for (let i = 0; i < 3; i++) {
        const k = ((now / 900 + i / 3) % 1);
        put(kit.heart, v.x + Math.sin(i * 2.1 + now / 500) * 0.4, v.y + 1.0 + k * 1.2, v.z + Math.cos(i * 2.1) * 0.3, 0.32, 1 - k);
      }
    }
    // tamed: a burst of sparkles and hearts for 2 s
    if (s.tamed && now - s.tamed.at < 2000) {
      const k = (now - s.tamed.at) / 2000;
      const t = s.tamed;
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + k * 2;
        const r = 0.4 + k * 1.6;
        put(i % 2 ? kit.heart : kit.spark, t.x + Math.cos(a) * r, t.y + 0.6 + k * 1.4 + (i % 3) * 0.15, t.z + Math.sin(a) * r, 0.35 + (t.variant === 1 ? 0.1 : 0), 1 - k, t.variant === 1 ? '#ffd166' : undefined);
      }
    }
    // pet acts
    for (const a of s.acts) {
      const age = now - a.at;
      if (age > 1400) continue;
      const k = age / 1400;
      const v = pos(a.pet);
      const x = v?.x ?? a.x;
      const y = v?.y ?? a.y;
      const z = v?.z ?? a.z;
      if (a.act === ACT.petted) {
        for (let i = 0; i < 3; i++) put(kit.heart, x + (i - 1) * 0.3, y + 1.0 + k * 1.1 + i * 0.12, z, 0.3, 1 - k);
      } else if (a.act === ACT.fed) {
        put(kit.spark, x, y + 1.0 + k * 0.6, z, 0.28, 1 - k, '#c8f0a0');
      } else if (a.act === ACT.ability) {
        const ab = abilityById2(a.target);
        const col = ab && ab.element >= 0 ? ELEMENT_COLORS[ab.element] : ab?.kind === 'heal' ? '#7dff9a' : ab?.kind === 'buff' ? '#ffb347' : '#ffffff';
        const at = a.on ? pos(a.on) : undefined;
        put(kit.ring, at?.x ?? x, (at?.y ?? y) + 0.6, at?.z ?? z, 0.8 + k * 2.4, 1 - k, col);
      } else if (a.act === ACT.arrived) {
        put(kit.spark, x, y + 0.8 + k, z, 0.5, 1 - k);
      }
    }
    for (let i = n; i < POOL; i++) kit.sprites[i].visible = false;
  });

  return null;
}

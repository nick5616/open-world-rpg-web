// The inventory's right-hand pane: your character as other players see them
// (Nicole: "include a right justified pane of your character as they appear
// to others"). The same Avatar rig, armor appearance (CR 034) and weapon
// look (snapshot typeId) everyone else's client draws from your snapshot,
// in a small canvas of its own: drag to turn, idles otherwise.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Avatar } from '../../net/avatar';
import type { RemoteView } from '../../net/interpolation';
import { ownAppearance } from '../../combat/armor/own';
import { useCombatHud } from '../../combat/store';
import { combatRuntime } from '../../combat/link';
import { materialKey, packLook, type WeaponKind } from '../../combat/weapons/look';
import { netRuntime, useNetStore } from '../../net/netStore';

const W = 240;
const H = 380;

/** The look other players get for you (weapon kind, material, gem): the same packing the zone sends. */
function ownLook(): number {
  const hud = useCombatHud.getState();
  const lo = hud.loadouts[hud.activeLoadout];
  const kind = (combatRuntime.current?.weaponName() as WeaponKind | undefined) ?? (lo?.weapon as WeaponKind | undefined) ?? 'sword';
  return packLook({ weapon: kind, material: materialKey(lo?.material ?? 0), gem: lo?.gem ?? -1 });
}

export function CharacterPreview() {
  const host = useRef<HTMLDivElement>(null);
  const name = useNetStore((s) => s.ready?.character.name) ?? '';
  const selfId = netRuntime.session?.welcome?.entityId ?? 0;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      return; // no second context available: the pane stays a plain frame
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W, H);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.cursor = 'grab';

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2e22, 1.15));
    const key = new THREE.DirectionalLight(0xfff2dd, 2.2);
    key.position.set(2.5, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    rim.position.set(-3, 2.5, -3);
    scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    floor.position.y = 0.005;
    scene.add(floor);

    const camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
    camera.position.set(0, 1.15, 4.4);
    camera.lookAt(0, 0.95, 0);

    const avatar = new Avatar(selfId || 1, { nameplate: false });
    scene.add(avatar.root);
    const v = { id: selfId || 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, kind: 1, name, level: 0, healthPct: 100, activity: 0, partyId: 0, typeId: 0, ring: 'near', delayMs: 0, mode: 'interp' } as RemoteView;

    // Drag to turn; it eases back to a slow idle turn when let go.
    let yaw = Math.PI; // face the viewer (yaw 0 faces -Z)
    let drag: number | null = null;
    let idle = 0;
    const down = (e: PointerEvent) => {
      drag = e.clientX;
      renderer.domElement.setPointerCapture(e.pointerId);
      renderer.domElement.style.cursor = 'grabbing';
    };
    const move = (e: PointerEvent) => {
      if (drag === null) return;
      yaw += (e.clientX - drag) * 0.012;
      drag = e.clientX;
      idle = 0;
    };
    const up = () => {
      drag = null;
      renderer.domElement.style.cursor = 'grab';
    };
    renderer.domElement.addEventListener('pointerdown', down);
    renderer.domElement.addEventListener('pointermove', move);
    renderer.domElement.addEventListener('pointerup', up);
    renderer.domElement.addEventListener('pointercancel', up);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      idle += dt;
      if (drag === null && idle > 2.5) yaw += dt * 0.35;
      v.yaw = yaw;
      v.appearance = ownAppearance();
      v.typeId = ownLook();
      avatar.update(v, camera, dt, 1000);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('pointerdown', down);
      renderer.domElement.removeEventListener('pointermove', move);
      renderer.domElement.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('pointercancel', up);
      avatar.root.removeFromParent();
      avatar.dispose();
      floor.geometry.dispose();
      (floor.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [selfId, name]);

  return (
    <div data-testid="inventory-preview" style={{ width: W }}>
      <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.7, marginBottom: 6 }}>As others see you</div>
      <div ref={host} style={{ width: W, height: H, borderRadius: 8, background: 'radial-gradient(ellipse at 50% 35%, rgba(120,140,170,0.28), rgba(10,12,18,0.6) 70%)', border: '1px solid #ffffff18', overflow: 'hidden' }} />
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4, textAlign: 'center' }}>{name ? `${name} · drag to turn` : 'drag to turn'}</div>
    </div>
  );
}

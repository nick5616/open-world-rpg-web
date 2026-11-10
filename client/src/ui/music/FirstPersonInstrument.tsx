// Playtest 2 instruments (CR 028) in first person: you don't see your body,
// so the instrument is held up in the lower view with your hands on it (the
// weapon view model and the arms step aside: view.fpInstrument): the lute
// across you with the left hand on its neck and the right strumming, the
// flute to the right of your lips, the drum below with both hands over the
// skin, a handbell in each hand. Each note you play moves them (a strum, a
// strike, a ring, a breath). Mounted after PlayerController (it only adds
// children to the camera); third person and photo mode show the body.

import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { CONTENT } from '@lodestone/contracts';
import { instrumentMeshes } from '../../net/avatar';
import { view } from '../../state/live';
import { selfHit, useMusic } from './store';

const SKIN = 0xc9a27e;
const SLEEVE = 0x3b4a6b;

function hand(): THREE.Group {
  const g = new THREE.Group();
  const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.26, 3, 8), new THREE.MeshStandardMaterial({ color: SLEEVE, roughness: 0.8 }));
  fore.position.y = -0.19;
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.7 }));
  palm.scale.set(1, 1.25, 0.65);
  g.add(fore, palm);
  return g;
}

/** Hit envelope: 1 at a note, falling over ~110 ms (pure; the avatars use the same shape). */
export function hitEnvelope(sinceMs: number): number {
  return sinceMs < 0 ? 0 : Math.exp(-sinceMs / 110);
}

export function FirstPersonInstrument() {
  const camera = useThree((s) => s.camera);
  const st = useMemo(() => {
    const m = instrumentMeshes();
    const root = new THREE.Group();
    root.name = 'fp-instrument';
    root.visible = false;
    const props: Record<string, THREE.Group> = { strum: m.lute, flute: m.flute, drum: m.drum, bells: new THREE.Group() };
    const bl = m.bell.clone();
    const br = m.bell.clone();
    props.bells.add(bl, br);
    for (const g of Object.values(props)) {
      g.visible = false;
      g.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.renderOrder = 2;
          mesh.frustumCulled = false;
        }
      });
      root.add(g);
    }
    const hl = hand();
    const hr = hand();
    root.add(hl, hr);
    return { root, props, bl, br, hl, hr, seen: 0, side: 1, smooth: 0 };
  }, []);

  useFrame((_, delta) => {
    const ms = useMusic.getState();
    const def = ms.active ? CONTENT.instruments.list.find((i) => i.id === ms.instrument) : undefined;
    const fp = !view.third && !view.photo;
    const show = !!def && fp;
    view.fpInstrument = show;
    if (st.root.parent !== camera) camera.add(st.root);
    st.root.visible = show;
    if (!show || !def) return;
    if (selfHit.n !== st.seen) {
      st.seen = selfHit.n;
      st.side = -st.side;
    }
    const k = hitEnvelope(performance.now() - selfHit.at) * (0.55 + 0.45 * (selfHit.vel / 7));
    st.smooth += (k - st.smooth) * Math.min(1, delta * 30);
    const t = performance.now() / 1000;
    const sway = Math.sin(t * 1.3) * 0.006;
    for (const [pose, g] of Object.entries(st.props)) g.visible = pose === def.pose;
    const { hl, hr } = st;
    switch (def.pose) {
      case 'strum': {
        // across the lower view, its face tipped up to you, the neck up to the left
        const g = st.props.strum;
        g.position.set(0.1, -0.4 + sway, -0.5);
        g.rotation.set(1.0, 0.25, -0.38);
        hl.position.set(-0.27, -0.26 + sway, -0.66);
        hl.rotation.set(-0.9, 0, 0.9);
        hr.position.set(0.14, -0.33 + 0.035 * st.side * st.smooth, -0.46);
        hr.rotation.set(-0.8, 0, -0.5 + 0.25 * st.side * st.smooth);
        break;
      }
      case 'flute': {
        // from your lips out to the right, both hands on it; a breath lifts it a little
        const g = st.props.flute;
        g.position.set(-0.03, -0.13 + 0.008 * st.smooth + sway * 0.5, -0.24);
        g.rotation.set(0, 0.35, -0.22);
        hl.position.set(0.1, -0.2 + 0.008 * st.smooth, -0.3);
        hl.rotation.set(-1.2, 0, -0.3);
        hr.position.set(0.3, -0.27 + 0.008 * st.smooth, -0.36);
        hr.rotation.set(-1.1, 0, -0.5);
        break;
      }
      case 'drum': {
        // below you, the skin up; the hands fall on it in turn (both for the low notes)
        const g = st.props.drum;
        g.position.set(0, -0.56 + sway, -0.5);
        g.rotation.set(0.55, 0, 0);
        const both = selfHit.midi < 48;
        const r = st.side > 0 || both ? st.smooth : 0;
        const l = st.side < 0 || both ? st.smooth : 0;
        hl.position.set(-0.12, -0.32 - 0.07 * l, -0.5);
        hl.rotation.set(-1.4 + 0.3 * l, 0, 0.3);
        hr.position.set(0.12, -0.32 - 0.07 * r, -0.5);
        hr.rotation.set(-1.4 + 0.3 * r, 0, -0.3);
        break;
      }
      default: {
        // a handbell in each hand; the one that rings swings up
        const r = st.side > 0 ? st.smooth : 0;
        const l = st.side < 0 ? st.smooth : 0;
        hl.position.set(-0.26, -0.33 + 0.05 * l, -0.55);
        hl.rotation.set(-0.5 - 0.5 * l, 0, 0.2);
        hr.position.set(0.26, -0.33 + 0.05 * r, -0.55);
        hr.rotation.set(-0.5 - 0.5 * r, 0, -0.2);
        st.bl.position.copy(hl.position).add(new THREE.Vector3(0, -0.03, -0.01));
        st.bl.rotation.set(-0.3 - 0.6 * l, 0, 0.15);
        st.br.position.copy(hr.position).add(new THREE.Vector3(0, -0.03, -0.01));
        st.br.rotation.set(-0.3 - 0.6 * r, 0, -0.15);
        break;
      }
    }
  });
  return null;
}

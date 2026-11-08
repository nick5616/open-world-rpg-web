// Tree impostor atlas, rendered once at load from the LOD0 tree meshes (spec
// 12 asks for octahedral impostors baked at asset build; until real tree
// models exist, a single side view per archetype rendered at runtime is the
// honest equivalent: same silhouette as the mesh it replaces, ~1 ms once).
// Unlit albedo with the meshes' baked canopy shading; the billboard shader
// lights it with the current sun and sky.

import * as THREE from 'three';

export const IMPOSTOR_PX = 256;

export function renderImpostorAtlas(renderer: THREE.WebGLRenderer, geometries: THREE.BufferGeometry[]): THREE.WebGLRenderTarget {
  const n = geometries.length;
  const rt = new THREE.WebGLRenderTarget(IMPOSTOR_PX * n, IMPOSTOR_PX, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const scene = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  // Trees are ~1 unit tall and ~0.7 wide around x = 0: frame [-0.55, 0.55] x [0, 1.1].
  const cam = new THREE.OrthographicCamera(-0.55, 0.55, 1.1, 0, -5, 5);
  cam.position.set(0, 0, 2);
  cam.lookAt(0, 0, 0);
  const prevTarget = renderer.getRenderTarget();
  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  renderer.clear();
  geometries.forEach((g, i) => {
    const mesh = new THREE.Mesh(g, mat);
    scene.add(mesh);
    rt.viewport.set(i * IMPOSTOR_PX, 0, IMPOSTOR_PX, IMPOSTOR_PX);
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    scene.remove(mesh);
  });
  rt.viewport.set(0, 0, IMPOSTOR_PX * n, IMPOSTOR_PX);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.setViewport(prevViewport);
  mat.dispose();
  return rt;
}

/** Unit quad for billboards: x in [-0.5, 0.5], y in [0, 1]. */
export function billboardQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

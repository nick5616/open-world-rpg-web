// Tree impostor atlas, rendered once at load from the LOD0 tree meshes (spec
// 12 asks for octahedral impostors baked at asset build; until real tree
// models exist, a single side view per archetype rendered at runtime is the
// honest equivalent: same silhouette as the mesh it replaces, ~1 ms once).
// Unlit albedo with the meshes' baked canopy shading; the billboard shader
// lights it with the current sun and sky.

import * as THREE from 'three';

export const IMPOSTOR_PX = 256;

/**
 * One column per tree, `views` rows per tree (playtest 5, CR 057): the tree seen from 0, 90, 180, 270 degrees
 * of yaw (row k = the tree turned k * 360 / views about its own axis in front of the camera). The billboard
 * shader picks the two rows nearest the viewing angle and blends between them, so a distant forest no longer
 * shows the same side of every tree and the canopy shape turns as you walk past. views = 1 is the old atlas.
 */
export function renderImpostorAtlas(renderer: THREE.WebGLRenderer, geometries: THREE.BufferGeometry[], material?: THREE.Material | THREE.Material[], views = 1): THREE.WebGLRenderTarget {
  const n = geometries.length;
  const rt = new THREE.WebGLRenderTarget(IMPOSTOR_PX * n, IMPOSTOR_PX * views, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const scene = new THREE.Scene();
  const mat = material ?? new THREE.MeshBasicMaterial({ vertexColors: true });
  const matFor = (i: number) => (Array.isArray(mat) ? mat[i] : mat);
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
    const mesh = new THREE.Mesh(g, matFor(i));
    scene.add(mesh);
    for (let k = 0; k < views; k++) {
      mesh.rotation.y = (k / views) * Math.PI * 2;
      rt.viewport.set(i * IMPOSTOR_PX, k * IMPOSTOR_PX, IMPOSTOR_PX, IMPOSTOR_PX);
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    }
    scene.remove(mesh);
  });
  rt.viewport.set(0, 0, IMPOSTOR_PX * n, IMPOSTOR_PX * views);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevColor, prevAlpha);
  renderer.autoClear = prevAutoClear;
  renderer.setViewport(prevViewport);
  if (!material) (mat as THREE.Material).dispose();
  return rt;
}

/** Unit quad for billboards: x in [-0.5, 0.5], y in [0, 1]. */
export function billboardQuad(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

/**
 * Unlit albedo of the rich trees for the impostor bake: leaf atlas with alpha
 * cut, bark texture on wood, vertex colours (canopy shade) on both. Same
 * sampling as the rich scatter material so the far billboard matches the mesh.
 */
export function createBakeMaterial(atlas: THREE.Texture, bark: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uBark: { value: bark } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec2 aBarkUv;
      varying vec2 vUv;
      varying vec2 vBarkUv;
      varying float vBark;
      varying vec3 vCol;
      void main() {
        vUv = uv;
        vBarkUv = aBarkUv;
        vBark = step(0.25, aBarkUv.x);
        vCol = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform sampler2D uBark;
      varying vec2 vUv;
      varying vec2 vBarkUv;
      varying float vBark;
      varying vec3 vCol;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        if (vBark > 0.5) t = vec4(texture2D(uBark, vBarkUv).rgb, 1.0);
        if (t.a < 0.42) discard;
        gl_FragColor = vec4(t.rgb * vCol, 1.0);
      }`,
    vertexColors: true,
  });
}

const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('client/src/sim/README.md', [
  ["browser run (`traversal-browser.ts`), `?ground=worldgen` debug play (`WorldgenDebugCanvas`, `DebugTerrain`), divergence probe. |", "browser run (`traversal-browser.ts`), divergence probe (`window.__lodestone.probe()`). |"],
]);
patch('client/src/sim/worldgenGround.ts', [
  [`// the movement goldens, the Node acceptance client and the debug
// ?ground=worldgen mode. WP05's streamed terrain should answer the same
// queries from LOD 0 chunks with chunkSurfaceHeight / chunkWaterHeight (same
// bits, no wasm call per query).`, `// the movement goldens and the Node acceptance client (the game itself uses
// WP05's WorldGround, the same wasm calls, under WP12's StructureGround).`],
]);
patch('client/README.md', [
  ["WP10 dev params:\n`?ground=worldgen` walks on worldgen.wasm's terrain with a debug heightfield\nvisual (offline: `&spawn=x,z`), `?rain=1|0`, `?updraft=x,z,r,top,lift`.", "WP10 dev params:\n`?rain=1|0`, `?updraft=x,z,r,top,lift`."],
]);
let d = fs.readFileSync('docs/decisions/0010-movement-extensions.md', 'utf8');
d = d.replace(/## Browser debug ground[\s\S]*$/, `## Towers are just ground

WP12's towers are a structure overlay combined with the terrain by max
(\`StructureGround\` / \`structures.Ground\`), with 80° walls and a walkable
ledge. The step reads only \`heightAt\`/\`waterAt\` of whatever ground it is
given, so on the combined ground towers are climbed with stamina (resting on
the ledge refills the wheel), mantled, and glided from, with no
tower-specific code. Water passes through to the terrain's.
`);
fs.writeFileSync('docs/decisions/0010-movement-extensions.md', d);
console.log('ok');

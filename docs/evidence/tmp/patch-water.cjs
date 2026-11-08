const fs = require('fs');
function patch(p, pairs) {
  let s = fs.readFileSync(p, 'utf8');
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(p + ' missing ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(p, s);
}
patch('client/src/world/core/ground.ts', [
  [`  normalAt(x: number, z: number): { x: number; y: number; z: number } {`, `  /**
   * Water surface (WP10: swimming): the wasm water_height, the same function
   * the zone's worldhost.Terrain.WaterAt answers, so client and zone agree on
   * where you swim. Clamped like heightAt.
   */
  waterAt(x: number, z: number): number {
    const cx = x < MIN ? MIN : x > MAX ? MAX : x;
    const cz = z < MIN ? MIN : z > MAX ? MAX : z;
    return this.wg.waterHeight(this.atlas, cx, cz);
  }

  normalAt(x: number, z: number): { x: number; y: number; z: number } {`],
]);
patch('client/src/world/structures/overlay.ts', [
  [`  /** Index of the structure forming the ground at (x, z), -1 for terrain. */`, `  /**
   * Water is the base ground's (WP10): structures stand on land, and where a
   * structure top is above the water the swim test (water - ground >= 1.5 m)
   * fails by itself. Go twin: structures.Ground.WaterAt.
   */
  waterAt(x: number, z: number): number {
    return this.base.waterAt ? this.base.waterAt(x, z) : -Infinity;
  }

  /** Index of the structure forming the ground at (x, z), -1 for terrain. */`],
]);
patch('server/pkg/structures/overlay.go', [
  [`// StructureAt reports which structure forms the ground at (x, z)`, `// WaterAt implements movement.Water (WP10) with the base ground's water:
// structures stand on land, and where a structure top is above the water
// the swim depth test fails by itself. Without a water-aware base there is
// no water. TS twin: StructureGround.waterAt.
func (g *Ground) WaterAt(x, z float64) float64 {
	return movement.WaterAt(g.Base, x, z)
}

// StructureAt reports which structure forms the ground at (x, z)`],
]);
console.log('ok');

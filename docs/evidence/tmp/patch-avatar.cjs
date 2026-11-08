const fs = require('fs');
const p = 'client/src/net/avatar.ts';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b) => {
  if (!s.includes(a)) throw new Error('missing ' + a.slice(0, 70));
  s = s.replace(a, b);
};
rep(`  low: THREE.BufferGeometry;
  visorMat: THREE.Material;
} | null = null;`, `  low: THREE.BufferGeometry;
  visorMat: THREE.Material;
  /** WP10: the glider wing shown while the activity bit says gliding. */
  glider: THREE.BufferGeometry;
  gliderMat: THREE.Material;
} | null = null;`);
rep(`      visorMat: new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.3, metalness: 0.4 }),
    };`, `      visorMat: new THREE.MeshStandardMaterial({ color: 0x1b1f2a, roughness: 0.3, metalness: 0.4 }),
      glider: new THREE.BoxGeometry(2.2, 0.04, 0.9),
      gliderMat: new THREE.MeshStandardMaterial({ color: 0xc98a3a, roughness: 0.8, side: THREE.DoubleSide }),
    };`);
rep(`  private plateKey = '';
  private phase = 0;`, `  private plateKey = '';
  private phase = 0;
  private high: THREE.Group;
  private glider: THREE.Mesh;`);
rep(`    for (const m of high.children) m.castShadow = true;
`, `    for (const m of high.children) m.castShadow = true;
    this.high = high;
    // WP10: a simple wing above the head, held by the raised arms while gliding.
    this.glider = new THREE.Mesh(r.glider, r.gliderMat);
    this.glider.position.set(0, 2.25, 0);
    this.glider.visible = false;
    this.root.add(this.glider);
`);
rep(`    // Walk cycle on the high LOD: limbs swing with speed; airborne tucks legs.
    const airborne = (v.activity & Activity.airborne) !== 0;
    this.phase += dt * (2.2 + v.speed * 1.4);
    const amp = airborne ? 0 : Math.min(v.speed / 5, 1) * 0.7;
    const s = Math.sin(this.phase) * amp;
    this.limbs[0].rotation.x = s;
    this.limbs[1].rotation.x = -s;
    this.limbs[2].rotation.x = airborne ? -0.6 : -s;
    this.limbs[3].rotation.x = airborne ? -0.3 : s;
`, `    // Walk cycle on the high LOD: limbs swing with speed; airborne tucks legs.
    // WP10 poses from the activity bits (cheap: limb angles, a body tilt, a
    // wing mesh): climbing reaches up hand over hand, gliding holds the wing
    // overhead with legs trailing, swimming lies forward and strokes.
    const airborne = (v.activity & Activity.airborne) !== 0;
    const climbing = (v.activity & Activity.climbing) !== 0;
    const gliding = (v.activity & Activity.gliding) !== 0;
    const swimming = (v.activity & Activity.swimming) !== 0;
    this.phase += dt * (2.2 + v.speed * 1.4);
    this.glider.visible = gliding;
    this.high.rotation.x = swimming ? -1.2 : gliding ? -0.25 : 0;
    this.high.position.y = swimming ? 0.9 : 0;
    if (climbing) {
      const c = Math.sin(this.phase * 1.5) * Math.min(v.speed / 2, 1);
      this.limbs[0].rotation.x = Math.PI - 0.4 + c * 0.5;
      this.limbs[1].rotation.x = Math.PI - 0.4 - c * 0.5;
      this.limbs[2].rotation.x = -0.5 - c * 0.4;
      this.limbs[3].rotation.x = -0.5 + c * 0.4;
    } else if (gliding) {
      this.limbs[0].rotation.x = Math.PI - 0.15;
      this.limbs[1].rotation.x = Math.PI - 0.15;
      this.limbs[2].rotation.x = 0.35;
      this.limbs[3].rotation.x = 0.25;
    } else if (swimming) {
      const c = Math.sin(this.phase * 1.2);
      this.limbs[0].rotation.x = Math.PI * (0.5 + 0.5 * c);
      this.limbs[1].rotation.x = Math.PI * (0.5 - 0.5 * c);
      this.limbs[2].rotation.x = c * 0.3;
      this.limbs[3].rotation.x = -c * 0.3;
    } else {
      const amp = airborne ? 0 : Math.min(v.speed / 5, 1) * 0.7;
      const s = Math.sin(this.phase) * amp;
      this.limbs[0].rotation.x = s;
      this.limbs[1].rotation.x = -s;
      this.limbs[2].rotation.x = airborne ? -0.6 : -s;
      this.limbs[3].rotation.x = airborne ? -0.3 : s;
    }
`);
fs.writeFileSync(p, s);
console.log('ok');

// Visual for the flat placeholder ground: a big lit plane, a 1 m grid with
// chunk-sized (64 m) section lines that follows the camera, and a couple of
// landmarks so motion and scale read on screen. Purely visual and
// collision-free: the landmarks are flat or far away on purpose, since
// nothing on this plane blocks movement. WP05 replaces this whole component
// with streamed terrain chunks.

import { Grid } from '@react-three/drei';
import { CHUNK_SIZE_M, WORLD_SIZE_M } from '@lodestone/contracts';
import { SPAWN } from './PlayerController';

interface Props {
  height?: number;
}

export function FlatTerrain({ height = 0 }: Props) {
  const c = WORLD_SIZE_M / 2;
  return (
    <group>
      {/* The plane is drawn first (after the sky) and writes no depth, so the
          grid and inlaid stones a centimeter above it can never z-fight with
          it. They vanished in headless SwiftShader after a canvas resize or
          tier change, even with polygonOffset (its depth precision there was
          worse than 0.1 m at 10 m). Nothing is ever below this plane, so not
          writing depth costs nothing. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[c, height, c]} receiveShadow renderOrder={-1}>
        <planeGeometry args={[WORLD_SIZE_M * 2, WORLD_SIZE_M * 2]} />
        <meshStandardMaterial color="#5d7a4c" roughness={1} depthWrite={false} />
      </mesh>
      <Grid
        position={[c, height + 0.01, c]}
        infiniteGrid
        followCamera
        cellSize={1}
        cellThickness={0.6}
        cellColor="#4c6640"
        sectionSize={CHUNK_SIZE_M}
        sectionThickness={1.2}
        sectionColor="#2f4428"
        fadeDistance={220}
        fadeStrength={1.2}
      />
      {/* spawn ring: flat inlaid stones, walkable */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[SPAWN.x + Math.cos(a) * 10, height + 0.02, SPAWN.z + Math.sin(a) * 10]} receiveShadow>
            <circleGeometry args={[0.9, 20]} />
            <meshStandardMaterial color="#9a9a8e" roughness={0.9} />
          </mesh>
        );
      })}
      {/* distant landmark (the "strange peak" you walk toward), 300 m north */}
      <mesh position={[SPAWN.x, height + 40, SPAWN.z - 300]} castShadow>
        <coneGeometry args={[14, 80, 5]} />
        <meshStandardMaterial color="#6d6a7a" roughness={0.95} flatShading />
      </mesh>
      <mesh position={[SPAWN.x, height + 82, SPAWN.z - 300]}>
        <octahedronGeometry args={[3, 0]} />
        <meshStandardMaterial color="#8fd4ff" emissive="#4fb4ff" emissiveIntensity={1.5} />
      </mesh>
    </group>
  );
}

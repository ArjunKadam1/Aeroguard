import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import type { Scenario } from "../api/types";
import { TERRAIN_SIZE, Terrain } from "./terrain";

// Deterministic scatter RNG. Same seed => same world (NFR-01), so a scenario
// replays against the same terrain and the same landmarks.
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export interface World {
  terrain: Terrain;
  /** Ground height at a world position, for the flight model and collision. */
  heightAt(x: number, z: number): number;
  dispose(): void;
}

export function buildWorld(scene: THREE.Scene, scenario: Scenario): World {
  const disposables: Array<{ dispose: () => void }> = [];
  const night = scenario.time_of_day === "night";
  const terrain = new Terrain({ seed: scenario.seed, environment: scenario.environment });

  // ---- Sky -------------------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(10000);
  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = night ? 12 : 6;
  uniforms.rayleigh.value = night ? 0.6 : 2.4;
  uniforms.mieCoefficient.value = 0.005;
  uniforms.mieDirectionalG.value = 0.8;
  // Sun low for a golden dusk, high for midday.
  const elevation = night ? -8 : scenario.time_of_day === "day" ? 42 : 12;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  uniforms.sunPosition.value.setFromSphericalCoords(1, phi, Math.PI * 0.25);
  scene.add(sky);
  disposables.push(sky.material);

  // ---- Lighting --------------------------------------------------------
  const sun = new THREE.DirectionalLight(night ? 0x9db4ff : 0xfff3d6, night ? 0.35 : 2.6);
  sun.position.setFromSphericalCoords(300, phi, Math.PI * 0.25);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(
    night ? 0x1a2436 : 0xbcd4f0,
    night ? 0x0a0d10 : 0x4a5a3a,
    night ? 0.4 : 0.9,
  ));

  // ---- Terrain mesh ----------------------------------------------------
  const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, 128, 128);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    pos.setY(i, terrain.heightAt(pos.getX(i), pos.getZ(i)));
  }
  geometry.computeVertexNormals();

  const groundColor = scenario.environment === "urban" ? 0x4a5348 : 0x5c6b42;
  const material = new THREE.MeshStandardMaterial({
    color: groundColor,
    roughness: 1,
    metalness: 0,
    // Slight vertex tint so hills read as relief rather than a flat silhouette.
    vertexColors: true,
  });
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const h = pos.getY(i);
    const t = THREE.MathUtils.clamp(h / 45, 0, 1);
    const shade = 0.75 + t * 0.35;
    colors[i * 3] = shade;
    colors[i * 3 + 1] = shade * (1 - t * 0.08);
    colors[i * 3 + 2] = shade * (1 - t * 0.18);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const ground = new THREE.Mesh(geometry, material);
  scene.add(ground);
  disposables.push(geometry, material);

  // ---- Horizon water ---------------------------------------------------
  const waterGeo = new THREE.PlaneGeometry(20000, 20000);
  const waterMat = new THREE.MeshStandardMaterial({
    color: night ? 0x0a1420 : 0x2d4a63,
    roughness: 0.35,
    metalness: 0.4,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = -6;
  scene.add(water);
  disposables.push(waterGeo, waterMat);

  // ---- Environment dressing -------------------------------------------
  const rng = makeRng(scenario.seed ^ 0x5eed);
  if (scenario.environment === "urban") {
    // Buildings on a jittered grid, kept off the launch pad.
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const bMat = new THREE.MeshStandardMaterial({
      color: night ? 0x2c3038 : 0x8a8f98,
      roughness: 0.85,
    });
    const count = 220;
    const buildings = new THREE.InstancedMesh(boxGeo, bMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      const gx = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      const gz = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      if (Math.hypot(gx, gz) < 150) { scale.set(0, 0, 0); }
      else {
        const h = 12 + rng() * 55;
        scale.set(16 + rng() * 20, h, 16 + rng() * 20);
      }
      p.set(gx, terrain.heightAt(gx, gz) + scale.y / 2, gz);
      m.compose(p, q, scale);
      buildings.setMatrixAt(i, m);
    }
    buildings.instanceMatrix.needsUpdate = true;
    scene.add(buildings);
    disposables.push(boxGeo, bMat);
  } else {
    // Trees as cones on trunks, scattered off the pad.
    const treeGeo = new THREE.ConeGeometry(2.2, 9, 6);
    const treeMat = new THREE.MeshStandardMaterial({
      color: night ? 0x1e3a24 : 0x2f6b34,
      roughness: 1,
    });
    const count = 900;
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) {
      const x = (rng() - 0.5) * TERRAIN_SIZE * 0.92;
      const z = (rng() - 0.5) * TERRAIN_SIZE * 0.92;
      if (Math.hypot(x, z) < 120) { scale.set(0, 0, 0); }
      else {
        const s = 0.7 + rng() * 1.1;
        scale.set(s, s * (0.8 + rng() * 0.7), s);
      }
      p.set(x, terrain.heightAt(x, z) + scale.y * 4.5, z);
      m.compose(p, q, scale);
      trees.setMatrixAt(i, m);
    }
    trees.instanceMatrix.needsUpdate = true;
    scene.add(trees);
    disposables.push(treeGeo, treeMat);
  }

  // ---- Fog tied to visibility ------------------------------------------
  // Kept far enough out that it grades the horizon without washing out
  // anything the trainee needs to identify.
  const visFactor = { clear: 0, reduced: 1, poor: 2 }[scenario.visibility];
  scene.fog = new THREE.Fog(
    night ? 0x0b1018 : 0x9fb4c7,
    night ? 120 : 400 - visFactor * 130,
    night ? 700 : 1500 - visFactor * 420,
  );

  return {
    terrain,
    heightAt: (x, z) => terrain.heightAt(x, z),
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Scenario } from "../api/types";
import { TERRAIN_SIZE, Terrain } from "./terrain";

// Water sits just below the terrain edge, which is forced to y=0.
const WATER_LEVEL = -1.2;
// Fog far plane must clear the terrain's far corner or the square edge shows.
const HORIZON_FAR = 3000;
const HORIZON_NEAR = 380;
// Distance the directional light sits from its target when aiming shadows.
const SUN_OFFSET = 300;

// Paints a merged tree geometry: brown trunk, green canopy. Using vertex
// colours keeps a single instanced draw call instead of one mesh per tree.
function applyTreeColors(geometry: THREE.BufferGeometry, night: boolean): void {
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const bark = night ? new THREE.Color(0x2a2018) : new THREE.Color(0x5a4630);
  const leaf = night ? new THREE.Color(0x16301f) : new THREE.Color(0x3f8a3f);
  for (let i = 0; i < position.count; i += 1) {
    const y = position.getY(i);
    // Below the first canopy tier is trunk; above it is foliage.
    const c = y < 4.2 ? bark : leaf;
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

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
  /** Keeps the shadow frustum centred on the aircraft as it flies. */
  aimSunAt(x: number, y: number, z: number): void;
  dispose(): void;
}

export function buildWorld(
  scene: THREE.Scene,
  scenario: Scenario,
  renderer: THREE.WebGLRenderer,
): World {
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

  // Shadows: enable for real. Without castShadow the shadow map flag costs
  // bookkeeping and renders nothing, which is why the scene previously read
  // as flat and unlit. The frustum is tight and is re-aimed at the aircraft
  // each frame (see aimSunAt), otherwise a 2000-unit world puts nothing
  // inside the default shadow camera.
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.left = -160;
  sun.shadow.camera.right = 160;
  sun.shadow.camera.top = 160;
  sun.shadow.camera.bottom = -160;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  scene.add(sun.target);

  scene.add(new THREE.HemisphereLight(
    night ? 0x1a2436 : 0xbcd4f0,
    night ? 0x0a0d10 : 0x4a5a3a,
    night ? 0.4 : 0.9,
  ));

  // ---- Environment map -------------------------------------------------
  // Feed the sky through PMREM so MeshStandardMaterial gets image-based
  // lighting. Without it, metals (water, aircraft body) render near-black.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(10000);
  for (const key of Object.keys(uniforms) as Array<keyof typeof uniforms>) {
    const target = envSky.material.uniforms[key];
    const source = uniforms[key];
    if (target && source && "value" in source && "value" in target) {
      (target as { value: unknown }).value = source.value;
    }
  }
  envScene.add(envSky);
  const envTarget = pmrem.fromScene(envScene);
  scene.environment = envTarget.texture;
  envSky.geometry.dispose();
  (envSky.material as THREE.Material).dispose();
  pmrem.dispose();

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
  ground.receiveShadow = true;
  scene.add(ground);
  disposables.push(geometry, material);

  // ---- Horizon water ---------------------------------------------------
  const waterGeo = new THREE.PlaneGeometry(20000, 20000);
  const waterMat = new THREE.MeshStandardMaterial({
    color: night ? 0x0a1420 : 0x2d4a63,
    roughness: 0.18,
    metalness: 0.55,
    // Image-based lighting gives the water something to reflect; without it a
    // metallic surface has nothing to sample and renders near-black.
    envMapIntensity: 1.2,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  // Terrain is forced to y=0 at the map edge, so the water must sit just below
  // it. The previous -6 left a visible 6-unit cliff around the whole square.
  water.position.y = WATER_LEVEL;
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
    buildings.castShadow = true;
    buildings.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (let i = 0; i < count; i += 1) {
      const gx = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      const gz = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      if (Math.hypot(gx, gz) < 150) { scale.set(0, 0, 0); }
      else {
        const h = 12 + rng() * 55;
        scale.set(16 + rng() * 20, h, 16 + rng() * 20);
        // Jitter the plan rotation; previously every building was perfectly
        // axis-aligned, which reads as a placeholder grid.
        euler.set(0, rng() * Math.PI, 0);
        q.setFromEuler(euler);
        // Vary the facade tone per instance so the skyline is not uniform grey.
        const tone = 0.78 + rng() * 0.34;
        buildings.setColorAt(
          i,
          new THREE.Color(tone * 0.62, tone * 0.64, tone * 0.68),
        );
      }
      p.set(gx, terrain.heightAt(gx, gz) + scale.y / 2, gz);
      m.compose(p, q, scale);
      buildings.setMatrixAt(i, m);
    }
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    scene.add(buildings);
    disposables.push(boxGeo, bMat);
  } else {
    // Trees: a tapered trunk plus stacked canopy cones merged into one
    // geometry. The previous single ConeGeometry(radius, height, 6) had six
    // radial segments, so the silhouette was a visible hexagon.
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.45, 4.2, 6);
    trunkGeo.translate(0, 2.1, 0);
    const canopyParts: THREE.BufferGeometry[] = [];
    const lower = new THREE.ConeGeometry(2.6, 6.0, 9);
    lower.translate(0, 5.6, 0);
    canopyParts.push(lower);
    const upper = new THREE.ConeGeometry(1.9, 4.6, 9);
    upper.translate(0, 8.6, 0);
    canopyParts.push(upper);
    const treeGeo = mergeGeometries([trunkGeo, ...canopyParts], false) ?? trunkGeo;
    trunkGeo.dispose();
    for (const part of canopyParts) part.dispose();

    // Vertex colours separate the trunk from the canopy so a single material
    // and a single instanced draw call can still show both.
    const treeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      vertexColors: true,
    });
    applyTreeColors(treeGeo, night);

    const count = 700;
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, count);
    trees.castShadow = true;
    trees.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    const euler = new THREE.Euler();
    for (let i = 0; i < count; i += 1) {
      const x = (rng() - 0.5) * TERRAIN_SIZE * 0.92;
      const z = (rng() - 0.5) * TERRAIN_SIZE * 0.92;
      if (Math.hypot(x, z) < 120) { scale.set(0, 0, 0); }
      else {
        const s = 0.7 + rng() * 1.2;
        scale.set(s, s * (0.75 + rng() * 0.75), s);
        euler.set(0, rng() * Math.PI * 2, 0);
        q.setFromEuler(euler);
        // Per-instance hue variation stops the field reading as one flat green.
        const tint = 0.8 + rng() * 0.45;
        trees.setColorAt(i, new THREE.Color(tint, tint * (0.95 + rng() * 0.12), tint * 0.94));
      }
      p.set(x, terrain.heightAt(x, z), z);
      m.compose(p, q, scale);
      trees.setMatrixAt(i, m);
    }
    trees.instanceMatrix.needsUpdate = true;
    if (trees.instanceColor) trees.instanceColor.needsUpdate = true;
    scene.add(trees);
    disposables.push(treeGeo, treeMat);
  }

  // ---- Fog tied to visibility ------------------------------------------
  // The terrain square's far corner sits at TERRAIN_SIZE/sqrt(2) units, so the
  // fog far plane must exceed that or the rectangular edge of the world is
  // visible. Degraded visibility tightens the fog but never far enough to
  // expose the boundary.
  const visFactor = { clear: 0, reduced: 1, poor: 2 }[scenario.visibility];
  const worldCorner = (TERRAIN_SIZE * Math.SQRT2) / 2;
  const fogFar = Math.max(worldCorner * 1.35, HORIZON_FAR - visFactor * 420);
  const fogNear = Math.min(HORIZON_NEAR, fogFar * 0.45);
  scene.fog = new THREE.Fog(
    night ? 0x0b1018 : 0x9fb4c7,
    fogNear,
    fogFar,
  );

  // ---- Night sky -------------------------------------------------------
  if (night) {
    // Stars on a large sphere. Deterministic so the sky is reproducible.
    const starCount = 900;
    const starPositions = new Float32Array(starCount * 3);
    const starSizes = new Float32Array(starCount);
    const starRng = makeRng(scenario.seed ^ 0x57a2);
    for (let i = 0; i < starCount; i += 1) {
      // Uniform on a sphere shell above the horizon.
      const u = starRng() * 2 - 1;
      const theta = starRng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const radius = 8000;
      starPositions[i * 3] = r * Math.cos(theta) * radius;
      starPositions[i * 3 + 1] = Math.abs(u) * radius * 0.9 + 400;
      starPositions[i * 3 + 2] = r * Math.sin(theta) * radius;
      starSizes[i] = starRng() * 2 + 1;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xdfe9ff,
      size: 26,
      sizeAttenuation: true,
      fog: false,
      transparent: true,
      opacity: 0.9,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.frustumCulled = false;
    scene.add(stars);
    disposables.push(starGeo, starMat);

    // Moon disc, placed opposite the sun so it reads as a night sky.
    const moonGeo = new THREE.CircleGeometry(180, 24);
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xe8eef7, fog: false });
    const moon = new THREE.Mesh(moonGeo, moonMat);
    moon.position.set(-3200, 2600, 4200);
    moon.lookAt(0, 0, 0);
    scene.add(moon);
    disposables.push(moonGeo, moonMat);
  }

  return {
    terrain,
    heightAt: (x, z) => terrain.heightAt(x, z),
    aimSunAt(x, y, z) {
      // Keep the directional light and its shadow frustum centred on the
      // aircraft so the tight ortho box always contains what is in view.
      sun.target.position.set(x, y, z);
      sun.target.updateMatrixWorld();
      sun.position.setFromSphericalCoords(SUN_OFFSET, phi, Math.PI * 0.25)
        .add(new THREE.Vector3(x, y, z));
    },
    dispose() {
      for (const d of disposables) d.dispose();
      envTarget.dispose();
      scene.environment = null;
    },
  };
}
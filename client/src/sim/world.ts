import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PublicScenario } from "../api/types";
import { TERRAIN_SIZE, Terrain } from "./terrain";

// Water sits just below the terrain edge, which is forced to y=0.
const WATER_LEVEL = -1.2;
// Fog far plane must clear the terrain's far corner or the square edge shows.
const HORIZON_FAR = 3000;
const HORIZON_NEAR = 380;
// Distance the directional light sits from its target when aiming shadows.
const SUN_OFFSET = 300;
// Window rows per world unit. A typical floor is ~3.5 units tall, so ~0.29
// repeats per unit puts roughly one window row per storey.
const WINDOW_UV_PER_UNIT = 0.29;

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

// Patches a MeshStandardMaterial so instanced building facades tile their
// window texture by real-world size. Exported and pure so it can be unit-tested
// without a renderer -- an onBeforeCompile patch that fails to apply is silent,
// three just compiles the unpatched shader.
export function patchFacadeUvShader(
  shader: { vertexShader: string },
  windowsPerUnit: number,
): void {
  const k = windowsPerUnit.toFixed(5);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
       attribute vec3 instanceScale;`,
    )
    .replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
       #ifdef USE_MAP
         vMapUv *= vec2(max(instanceScale.x, instanceScale.z) * ${k}, instanceScale.y * ${k});
       #endif
       #ifdef USE_EMISSIVEMAP
         vEmissiveMapUv *= vec2(max(instanceScale.x, instanceScale.z) * ${k}, instanceScale.y * ${k});
       #endif`,
    );
}

// Facade window grid drawn on a 2D canvas. Returns an albedo texture plus a
// matching emissive mask so lit windows glow after dark. Generated at runtime
// rather than shipped as a file, so there is no asset to license or download.
//
// One texture is shared by every building and the UV is scaled per instance by
// patchFacadeUvShader, so a single grid reads correctly on facades of very
// different heights.
const WINDOW_COLS = 8;
const WINDOW_ROWS = 10;

function drawFacade(seedValue: number, night: boolean): {
  map: THREE.Texture;
  emissiveMap: THREE.Texture;
} {
  const size = 256;
  const rng = makeRng(seedValue);

  const albedo = document.createElement("canvas");
  albedo.width = size; albedo.height = size;
  const a = albedo.getContext("2d");
  const emissiveCanvas = document.createElement("canvas");
  emissiveCanvas.width = size; emissiveCanvas.height = size;
  const e = emissiveCanvas.getContext("2d");
  // Guard: buildWorld only runs in a browser, but a missing 2D context would
  // otherwise throw a null-dereference deep inside the drawing loop.
  if (!a || !e) {
    const fallback = new THREE.DataTexture(
      new Uint8Array([200, 200, 200, 255]), 1, 1, THREE.RGBAFormat,
    );
    fallback.needsUpdate = true;
    return { map: fallback, emissiveMap: fallback };
  }
  // Concrete base with subtle vertical banding.
  // Concrete base. Kept mid-dark: a light grey multiplied by the per-instance
  // tone and lit by a 2.6 sun with ACES tone mapping clipped to white.
  a.fillStyle = night ? "#1b1f25" : "#6f747c";
  a.fillRect(0, 0, size, size);
  for (let i = 0; i < 24; i += 1) {
    a.fillStyle = `rgba(0,0,0,${0.02 + rng() * 0.05})`;
    a.fillRect(rng() * size, 0, 1 + rng() * 3, size);
  }

  // Black everywhere; only lit windows will emit at night.
  e.fillStyle = "#000000";
  e.fillRect(0, 0, size, size);

  const cellW = size / WINDOW_COLS;
  const cellH = size / WINDOW_ROWS;
  const pad = cellW * 0.24;

  for (let row = 0; row < WINDOW_ROWS; row += 1) {
    for (let col = 0; col < WINDOW_COLS; col += 1) {
      const x = col * cellW + pad;
      const y = row * cellH + pad;
      const w = cellW - pad * 2;
      const h = cellH - pad * 2;

      // A real skyline is mostly dark with scattered lit rooms, so keep the
      // lit fraction low; the previous 42% read as a uniformly amber slab.
      const lit = rng() < (night ? 0.17 : 0.10);
      // Albedo stays neutral: an unlit window is dark glass and a lit one is
      // only slightly brighter. The glow comes from the emissive map alone --
      // painting the albedo amber as well double-counted it and turned the
      // whole facade orange.
      a.fillStyle = lit ? (night ? "#5d5347" : "#c9d6e2") : "#2b3138";
      a.fillRect(x, y, w, h);

      // Recess outline so the grid reads as depth, not a decal.
      a.strokeStyle = "rgba(0,0,0,0.5)";
      a.lineWidth = 1;
      a.strokeRect(x, y, w, h);

      if (lit) {
        // Slight per-window variation keeps the emissive from looking uniform.
        const glow = 0.5 + rng() * 0.5;
        const warmth = 0.75 + rng() * 0.25;
        e.fillStyle = `rgb(${Math.round(255)},${Math.round(200 * warmth)},${Math.round(150 * warmth)})`;
        e.globalAlpha = glow;
        e.fillRect(x, y, w, h);
        e.globalAlpha = 1;
      }
    }
  }

  const map = new THREE.CanvasTexture(albedo);
  const emissiveMap = new THREE.CanvasTexture(emissiveCanvas);
  for (const tex of [map, emissiveMap]) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  return { map, emissiveMap };
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
  scenario: PublicScenario,
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
    // Buildings on a jittered grid, kept off the launch pad. Facades use a
    // generated window grid so they are not plain untextured boxes.
    //
    // The box is built 1x1x1 and instanced with a per-building scale, so every
    // face would otherwise carry exactly one window stretched over it. To keep
    // window rows roughly square regardless of building height, the shader is
    // patched to derive UV repeats from the instance scale.
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const { map, emissiveMap } = drawFacade(scenario.seed ^ 0xfaca, night);
    disposables.push(map, emissiveMap);
    const bMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map,
      emissiveMap,
      // Lit windows are what makes the night skyline read as a city. The value is
      // deliberately low: at 1.5 every lit window clipped to flat amber and the
      // facades read as uniformly orange slabs rather than scattered lights.
      emissive: 0xffffff,
      emissiveIntensity: night ? 0.75 : 0,
      roughness: 0.9,
    });
// Each instance is scaled to its own width/height, so a fixed 0..1 UV would
    // stretch a single window across the whole facade. Scaling the UV by the
    // instance's dimensions keeps window rows square and correctly counted on
    // buildings of very different sizes.
    bMat.onBeforeCompile = (shader) => patchFacadeUvShader(shader, WINDOW_UV_PER_UNIT);

    const count = 220;
    const buildings = new THREE.InstancedMesh(boxGeo, bMat, count);
    buildings.castShadow = true;
    buildings.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    const euler = new THREE.Euler();
    // Per-instance dimensions feed the shader patch that scales facade UVs.
    const instanceScale = new Float32Array(count * 3);
    // Placed buildings, recorded so rooftop units can sit exactly on them
    // instead of being scattered at unrelated random positions.
    const placed: Array<{ x: number; y: number; z: number; w: number; h: number; d: number; rot: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const gx = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      const gz = Math.round(rng() * 14 - 7) * 90 + (rng() - 0.5) * 40;
      if (Math.hypot(gx, gz) < 150) { scale.set(0, 0, 0); }
      else {
        const h = 12 + rng() * 55;
        const w = 16 + rng() * 20;
        const d = 16 + rng() * 20;
        scale.set(w, h, d);
        // Jitter the plan rotation; previously every building was perfectly
        // axis-aligned, which reads as a placeholder grid.
        const rot = rng() * Math.PI;
        euler.set(0, rot, 0);
        q.setFromEuler(euler);
        // Vary the facade tone per instance so the skyline is not uniform grey.
        // Multiplied with the window map. Stays at or below 1.0 so the sun
        // cannot push the brightest facades past the tone-mapper's shoulder.
        const tone = 0.72 + rng() * 0.26;
        buildings.setColorAt(i, new THREE.Color(tone, tone, tone * 1.03));
        placed.push({
          x: gx,
          y: terrain.heightAt(gx, gz) + h / 2,
          z: gz,
          w, h, d, rot,
        });
      }
      instanceScale[i * 3] = scale.x;
      instanceScale[i * 3 + 1] = scale.y;
      instanceScale[i * 3 + 2] = scale.z;
      p.set(gx, terrain.heightAt(gx, gz) + scale.y / 2, gz);
      m.compose(p, q, scale);
      buildings.setMatrixAt(i, m);
    }
    buildings.instanceMatrix.needsUpdate = true;
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    boxGeo.setAttribute("instanceScale", new THREE.InstancedBufferAttribute(instanceScale, 3));
    scene.add(buildings);
    disposables.push(boxGeo, bMat);

    // Rooftop plant (AC units, stair housings) breaks the flat-top silhouette
    // that otherwise makes every tower read as the same extruded box. These
    // must be derived from the placed buildings above: re-rolling positions
    // here placed them at unrelated points in mid-air.
    const roofGeo = new THREE.BoxGeometry(1, 1, 1);
    const roofMat = new THREE.MeshStandardMaterial({
      color: night ? 0x1c2027 : 0x6b7078,
      roughness: 0.95,
    });
    const roofs = new THREE.InstancedMesh(roofGeo, roofMat, placed.length);
    roofs.castShadow = true;
    roofs.receiveShadow = true;
    const rm = new THREE.Matrix4();
    const rq = new THREE.Quaternion();
    const rs = new THREE.Vector3();
    const rp = new THREE.Vector3();
    const re = new THREE.Euler();
    for (let i = 0; i < placed.length; i += 1) {
      const b = placed[i];
      if (rng() < 0.45) {
        // No plant on this roof; collapse the instance out of sight.
        rs.set(0, 0, 0);
        rp.set(b.x, b.y, b.z);
        rq.identity();
      } else {
        const unitH = 2 + rng() * 5;
        rs.set(b.w * (0.2 + rng() * 0.35), unitH, b.d * (0.2 + rng() * 0.35));
        // Offset in the building's own rotated frame so the unit sits within
        // the roof plate, then sit exactly on top of it.
        const ox = (rng() - 0.5) * b.w * 0.4;
        const oz = (rng() - 0.5) * b.d * 0.4;
        const cos = Math.cos(b.rot);
        const sin = Math.sin(b.rot);
        rp.set(
          b.x + ox * cos - oz * sin,
          b.y + b.h / 2 + unitH / 2,
          b.z + ox * sin + oz * cos,
        );
        re.set(0, b.rot, 0);
        rq.setFromEuler(re);
      }
      rm.compose(rp, rq, rs);
      roofs.setMatrixAt(i, rm);
    }
    roofs.instanceMatrix.needsUpdate = true;
    scene.add(roofs);
    disposables.push(roofGeo, roofMat);
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
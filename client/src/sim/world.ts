import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PublicScenario } from "../api/types";
import { drawGroundTexture } from "./ground";
import { STREET_BLOCK, STREET_HALF_WIDTH, STREET_OFFSET } from "./ground";
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

// Downtown core near the origin, sprawl outward: real cities cluster height
// instead of rolling it uniformly. Pure so district skylines stay testable.
export function districtHeight(rng: () => number, x: number, z: number): number {
  const core = Math.max(0, 1 - Math.hypot(x, z) / 700);
  return 10 + rng() * 20 + core * (30 + rng() * 45);
}

// Per-instance facade tint: neutral grey tone plus a subtle warm/cool spread
// so the skyline is not uniform. Stays at or below 1.0 so the sun cannot push
// the brightest facades past the tone-mapper's shoulder.
export function facadeTint(rng: () => number): [number, number, number] {
  const tone = 0.7 + rng() * 0.24;
  const warm = (rng() - 0.5) * 0.08;
  const clamp = (v: number) => Math.max(0.6, Math.min(1, v));
  return [clamp(tone + warm), clamp(tone), clamp(tone * 1.03 - warm)];
}

// Axis-aligned half-extents of a rotated w×d footprint. Pure so the
// no-overlap rule stays testable without a renderer.
export function footprintHalfExtents(w: number, d: number, rot: number): [number, number] {
  const cos = Math.abs(Math.cos(rot));
  const sin = Math.abs(Math.sin(rot));
  return [(w * cos + d * sin) / 2, (w * sin + d * cos) / 2];
}

export interface Footprint {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

/** True when two footprints (plus padding) intersect. */
export function footprintsOverlap(a: Footprint, b: Footprint, padding = 6): boolean {
  return Math.abs(a.x - b.x) < a.hx + b.hx + padding
    && Math.abs(a.z - b.z) < a.hz + b.hz + padding;
}

// Streetlight plan positions on the road edges (not the centre lines):
// ±8.5u perpendicular to the street puts the pole on the sidewalk ring,
// alternating sides per segment. armX/armZ is the unit direction the lamp arm
// reaches, back over the road. Deterministic with no RNG: the grid is the plan.
// Heights are resolved against the terrain at build time.
export interface StreetlightSpot {
  x: number;
  z: number;
  armX: number;
  armZ: number;
}

export function streetlightPositions(): StreetlightSpot[] {
  const points: StreetlightSpot[] = [];
  const edge = STREET_HALF_WIDTH + 1.5;
  for (let k = -7; k <= 6; k += 1) {
    const line = STREET_OFFSET + k * STREET_BLOCK;
    for (let t = -630; t <= 630; t += 90) {
      // Alternating sides so lamps don't march down one kerb in a row.
      const side = Math.round(t / 90) % 2 === 0 ? 1 : -1;
      if (Math.hypot(line, t) >= 150) {
        points.push({ x: line + side * edge, z: t, armX: -side, armZ: 0 });
      }
      if (Math.hypot(t, line) >= 150) {
        points.push({ x: t, z: line + side * edge, armX: 0, armZ: -side });
      }
    }
  }
  return points;
}

// Soft radial glow sprite for lamp halos. Generated at runtime like the
// facades, so there is no asset to license. Falls back to a plain dot if the
// 2D context is unavailable.
export function makeGlowSprite(size = 64): THREE.Texture {
  const fallback = new THREE.DataTexture(
    new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat,
  );
  fallback.needsUpdate = true;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return fallback;
  const gradient = context.createRadialGradient(
    size / 2, size / 2, 0, size / 2, size / 2, size / 2,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.55)");
  gradient.addColorStop(0.6, "rgba(255,255,255,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Facade archetypes, painted on 2D canvases at runtime so there is no asset
// to license or download. One shared texture per archetype; the UV shader
// patch scales the grid per instance so rows stay square on any height.
export type FacadeArchetype = "glass" | "brick" | "concrete";

export interface FacadePalette {
  /** Day/night albedo base. */
  base: string;
  baseNight: string;
  /** Window grid density. */
  cols: number;
  rows: number;
  /** Window inset fraction (0 = wall-to-wall glass, 0.3 = punched openings). */
  pad: number;
  /** Unlit window glass. */
  glass: string;
  /** Lit window albedo, day and night. */
  litDay: string;
  litNight: string;
  /** Share of windows lit, day and night. */
  litDayFraction: number;
  litNightFraction: number;
  /** Horizontal floor-slab band color, or null for flat curtain walls. */
  spandrel: string | null;
}

// Cool city palette: blue-grey glass downtown, muted brick mid-rise, pale
// concrete sprawl. Assignment follows the district logic (core -> glass,
// ring -> mixed, edge -> concrete) so zoning reads in the skyline.
export const FACADE_PALETTES: Record<FacadeArchetype, FacadePalette> = {
  glass: {
    base: "#3d4a55", baseNight: "#12161c",
    cols: 12, rows: 14, pad: 0.18,
    glass: "#1d262e",
    litDay: "#b8cdd8", litNight: "#4a4239",
    litDayFraction: 0.12, litNightFraction: 0.08,
    spandrel: "#242d34",
  },
  brick: {
    base: "#6e6259", baseNight: "#241f1b",
    cols: 6, rows: 8, pad: 0.3,
    glass: "#23282c",
    litDay: "#c9d6e2", litNight: "#4a4239",
    litDayFraction: 0.08, litNightFraction: 0.1,
    spandrel: null,
  },
  concrete: {
    base: "#8b9094", baseNight: "#232629",
    cols: 8, rows: 10, pad: 0.24,
    glass: "#2b3138",
    litDay: "#c9d6e2", litNight: "#4a4239",
    litDayFraction: 0.1, litNightFraction: 0.1,
    spandrel: "#6f747c",
  },
};

/** Archetype for a building plot: glass core, mixed ring, concrete edge. Pure. */
export function facadeArchetype(x: number, z: number, mix: number): FacadeArchetype {
  const distance = Math.hypot(x, z);
  if (distance < 260) return "glass";
  if (distance > 620) return "concrete";
  return mix < 0.45 ? "brick" : "concrete";
}

function paintFacade(
  seedValue: number,
  night: boolean,
  palette: FacadePalette,
): { map: THREE.Texture; emissiveMap: THREE.Texture } {
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
  a.fillStyle = night ? palette.baseNight : palette.base;
  a.fillRect(0, 0, size, size);
  for (let i = 0; i < 24; i += 1) {
    a.fillStyle = `rgba(0,0,0,${0.02 + rng() * 0.05})`;
    a.fillRect(rng() * size, 0, 1 + rng() * 3, size);
  }

  // Black everywhere; only lit windows will emit at night.
  e.fillStyle = "#000000";
  e.fillRect(0, 0, size, size);

  const cellW = size / palette.cols;
  const cellH = size / palette.rows;
  const pad = cellW * palette.pad;
  const litFraction = night ? palette.litNightFraction : palette.litDayFraction;

  for (let row = 0; row < palette.rows; row += 1) {
    // Mood: whole dark floors so lit rooms cluster instead of peppering evenly.
    const floorDark = rng() < 0.25;
    // Floor-slab shadow line above each row, where the archetype has one.
    if (palette.spandrel) {
      a.fillStyle = palette.spandrel;
      a.fillRect(0, row * cellH, size, Math.max(1, cellH * 0.08));
    }
    for (let col = 0; col < palette.cols; col += 1) {
      const x = col * cellW + pad;
      const y = row * cellH + pad;
      const w = cellW - pad * 2;
      const h = cellH - pad * 2;

      // A real skyline is mostly dark with scattered lit rooms, so keep the
      // lit fraction low; the previous 42% read as a uniformly amber slab.
      const lit = !floorDark && rng() < litFraction;
      // Albedo stays neutral: an unlit window is dark glass and a lit one is
      // only slightly brighter. The glow comes from the emissive map alone --
      // painting the albedo amber as well double-counted it and turned the
      // whole facade orange.
      a.fillStyle = lit ? (night ? palette.litNight : palette.litDay) : palette.glass;
      a.fillRect(x, y, w, h);

      // Recess outline so the grid reads as depth, not a decal.
      a.strokeStyle = "rgba(0,0,0,0.5)";
      a.lineWidth = 1;
      a.strokeRect(x, y, w, h);

      if (lit) {
        // Cool dim interior light: near-white with faint warm variance. The
        // old hot orange (255, ~150, ~110) mip-averaged at distance until whole
        // facades glowed like lava under ACES tone mapping.
        const glow = 0.35 + rng() * 0.45;
        const warmth = 0.85 + rng() * 0.15;
        e.fillStyle = `rgb(${Math.round(255 * glow)},`
          + `${Math.round(228 * warmth * glow)},${Math.round(198 * warmth * glow)})`;
        e.fillRect(x, y, w, h);
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
  // Midday sun sits below the clip point: with ACES exposure 0.9, 2.6 pushed
  // bright facades to flat white. Compare against screenshots before raising.
  const sun = new THREE.DirectionalLight(night ? 0x9db4ff : 0xfff3d6, night ? 0.35 : 2.3);
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

  const groundTexture = drawGroundTexture(scenario.seed ^ 0x691d, scenario.environment);
  disposables.push(groundTexture);
  const material = new THREE.MeshStandardMaterial({
    // The baked albedo carries the true colors (streets, blocks, grass), so
    // the base stays white; the vertex tint below still shades relief.
    color: 0xffffff,
    map: groundTexture,
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
    // Buildings on a jittered grid, kept off the launch pad. One baked facade
    // texture per archetype (glass/brick/concrete); the UV shader patch scales
    // each grid per instance so rows stay square on any height.
    const baked: Record<FacadeArchetype, { map: THREE.Texture; emissiveMap: THREE.Texture }> = {
      glass: paintFacade(scenario.seed ^ 0x61a55, night, FACADE_PALETTES.glass),
      brick: paintFacade(scenario.seed ^ 0xb21c, night, FACADE_PALETTES.brick),
      concrete: paintFacade(scenario.seed ^ 0xc0cc, night, FACADE_PALETTES.concrete),
    };
    const materials: Record<FacadeArchetype, THREE.MeshStandardMaterial> = {
      // Glass towers catch the sky: metalness plus environment intensity so
      // faces read reflective rather than flat grey.
      glass: new THREE.MeshStandardMaterial({
        color: 0xffffff, map: baked.glass.map, emissiveMap: baked.glass.emissiveMap,
        emissive: 0xffffff, emissiveIntensity: night ? 0.45 : 0,
        roughness: 0.35, metalness: 0.55, envMapIntensity: 1.2,
      }),
      brick: new THREE.MeshStandardMaterial({
        color: 0xffffff, map: baked.brick.map, emissiveMap: baked.brick.emissiveMap,
        emissive: 0xffffff, emissiveIntensity: night ? 0.45 : 0,
        roughness: 0.95, metalness: 0,
      }),
      concrete: new THREE.MeshStandardMaterial({
        color: 0xffffff, map: baked.concrete.map, emissiveMap: baked.concrete.emissiveMap,
        emissive: 0xffffff, emissiveIntensity: night ? 0.45 : 0,
        roughness: 0.9, metalness: 0,
      }),
    };
    for (const arch of ["glass", "brick", "concrete"] as const) {
      materials[arch].onBeforeCompile = (shader) => patchFacadeUvShader(shader, WINDOW_UV_PER_UNIT);
      disposables.push(baked[arch].map, baked[arch].emissiveMap, materials[arch]);
    }

    const count = 220;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const p = new THREE.Vector3();
    const euler = new THREE.Euler();
    // Per-archetype transform batches: one InstancedMesh per material, each
    // with its own geometry (the instanceScale attribute is per-geometry).
    interface BatchedBuilding {
      x: number; groundY: number; z: number;
      w: number; h: number; d: number; rot: number;
      tint: [number, number, number];
    }
    const batches: Record<FacadeArchetype, BatchedBuilding[]> = {
      glass: [], brick: [], concrete: [],
    };
    // Per-instance dimensions feed the shader patch that scales facade UVs.
    // Placed buildings, recorded so rooftop units can sit exactly on them
    // instead of being scattered at unrelated random positions.
    const placed: Array<{ x: number; y: number; z: number; w: number; h: number; d: number; rot: number }> = [];
    // Claimed cells and accepted footprints: two buildings must never share a
    // cell or intersect, which the old pure-random cells plus ±20 jitter
    // allowed. Bounded re-rolls keep the layout deterministic per seed.
    const occupiedCells = new Set<string>();
    const footprints: Footprint[] = [];
    for (let i = 0; i < count; i += 1) {
      let cx = 0;
      let cz = 0;
      let claimed = false;
      for (let attempt = 0; attempt < 8 && !claimed; attempt += 1) {
        cx = Math.round(rng() * 14 - 7);
        cz = Math.round(rng() * 14 - 7);
        const key = `${cx},${cz}`;
        if (!occupiedCells.has(key)) {
          occupiedCells.add(key);
          claimed = true;
        }
      }
      // Tight jitter: with capped 32u footprints the worst rotated corner
      // reaches ~22.6 + 14 = 36.6u from the cell centre, still inside the
      // 38u street kerb.
      const gx = cx * 90 + (rng() - 0.5) * 28;
      const gz = cz * 90 + (rng() - 0.5) * 28;
      if (claimed && Math.hypot(gx, gz) >= 150) {
        const h = districtHeight(rng, gx, gz);
        const w = 16 + rng() * 16;
        const d = 16 + rng() * 16;
        const rot = rng() * Math.PI;
        const [hx, hz] = footprintHalfExtents(w, d, rot);
        const candidate: Footprint = { x: gx, z: gz, hx, hz };
        if (footprints.some((other) => footprintsOverlap(candidate, other))) {
          // Overlaps a neighbour (possible across cell borders with rotation);
          // skip rather than interpenetrate.
        } else {
          footprints.push(candidate);
          // Vary the facade tone per instance so the skyline is not uniform grey.
          // Multiplied with the window map. Stays at or below 1.0 so the sun
          // cannot push the brightest facades past the tone-mapper's shoulder.
          const [tr, tg, tb] = facadeTint(rng);
          const arch = facadeArchetype(gx, gz, rng());
          batches[arch].push({
            x: gx, groundY: terrain.heightAt(gx, gz), z: gz,
            w, h, d, rot, tint: [tr, tg, tb],
          });
          placed.push({
            x: gx,
            y: terrain.heightAt(gx, gz) + h / 2,
            z: gz,
            w, h, d, rot,
          });
        }
      }
    }
    // One instanced mesh per archetype: each material needs its own geometry
    // because the instanceScale UV attribute is per-geometry.
    for (const arch of ["glass", "brick", "concrete"] as const) {
      const list = batches[arch];
      if (list.length === 0) continue;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mesh = new THREE.InstancedMesh(geo, materials[arch], list.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const scales = new Float32Array(list.length * 3);
      for (let j = 0; j < list.length; j += 1) {
        const b = list[j];
        euler.set(0, b.rot, 0);
        q.setFromEuler(euler);
        p.set(b.x, b.groundY + b.h / 2, b.z);
        scale.set(b.w, b.h, b.d);
        m.compose(p, q, scale);
        mesh.setMatrixAt(j, m);
        mesh.setColorAt(j, new THREE.Color(b.tint[0], b.tint[1], b.tint[2]));
        scales[j * 3] = b.w;
        scales[j * 3 + 1] = b.h;
        scales[j * 3 + 2] = b.d;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      geo.setAttribute("instanceScale", new THREE.InstancedBufferAttribute(scales, 3));
      scene.add(mesh);
      disposables.push(geo);
    }

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

    // Streetlights on the road edges, night only. Tapered poles with an arm
    // reaching over the road, a lamp head, and one additive glow layer so the
    // lamps pool light instead of floating as bare dots. Four draw calls
    // total, no shadow flags, no real lights.
    if (night) {
      const spots = streetlightPositions();
      const poleGeo = new THREE.CylinderGeometry(0.22, 0.38, 7, 6);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.9 });
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, spots.length);
      const armGeo = new THREE.BoxGeometry(3.4, 0.22, 0.22);
      const armMat = new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.9 });
      const arms = new THREE.InstancedMesh(armGeo, armMat, spots.length);
      const headGeo = new THREE.BoxGeometry(1.5, 0.35, 0.7);
      const headMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
      const heads = new THREE.InstancedMesh(headGeo, headMat, spots.length);
      const lm = new THREE.Matrix4();
      const lp = new THREE.Vector3();
      const lq = new THREE.Quaternion();
      const armQ = new THREE.Quaternion();
      const armEuler = new THREE.Euler();
      const ls = new THREE.Vector3(1, 1, 1);
      const glowPositions = new Float32Array(spots.length * 3);
      for (let i = 0; i < spots.length; i += 1) {
        const spot = spots[i];
        const groundY = terrain.heightAt(spot.x, spot.z);
        lp.set(spot.x, groundY + 3.5, spot.z);
        lm.compose(lp, lq, ls);
        poles.setMatrixAt(i, lm);
        // Arm runs from the pole top toward the road; the head hangs at its end.
        armEuler.set(0, spot.armX !== 0 ? 0 : Math.PI / 2, 0);
        armQ.setFromEuler(armEuler);
        lp.set(spot.x + spot.armX * 1.7, groundY + 6.9, spot.z + spot.armZ * 1.7);
        lm.compose(lp, armQ, ls);
        arms.setMatrixAt(i, lm);
        lp.set(spot.x + spot.armX * 3.2, groundY + 6.8, spot.z + spot.armZ * 3.2);
        lm.compose(lp, armQ, ls);
        heads.setMatrixAt(i, lm);
        glowPositions[i * 3] = spot.x + spot.armX * 3.2;
        glowPositions[i * 3 + 1] = groundY + 6.8;
        glowPositions[i * 3 + 2] = spot.z + spot.armZ * 3.2;
      }
      poles.instanceMatrix.needsUpdate = true;
      arms.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      scene.add(poles);
      scene.add(arms);
      scene.add(heads);
      const glowGeo = new THREE.BufferGeometry();
      glowGeo.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
      const glowMat = new THREE.PointsMaterial({
        map: makeGlowSprite(),
        size: 16,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        color: 0xffb45e,
      });
      const glow = new THREE.Points(glowGeo, glowMat);
      glow.frustumCulled = false;
      scene.add(glow);
      disposables.push(poleGeo, poleMat, armGeo, armMat, headGeo, headMat, glowGeo, glowMat);
    }
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
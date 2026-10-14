// Procedural ground albedo. The terrain used to be one flat shaded color,
// which reads as placeholder. This bakes streets/blocks (urban) or
// grass/dirt variation (rural) into a single canvas texture: one texture,
// zero new draw calls, fully deterministic per seed.
//
// Layout math is pure (world units, no DOM) so street alignment and color
// rules are unit-testable; only the final pixel loop needs a canvas.

import * as THREE from "three";
import type { TerrainEnvironment } from "./terrain";
import { TERRAIN_SIZE } from "./terrain";

export const GROUND_TEXTURE_SIZE = 1024;
// Building cells sit on multiples of 90 (see world.ts placement); streets run
// on the cell boundaries between them.
export const STREET_BLOCK = 90;
export const STREET_OFFSET = 45;
export const STREET_HALF_WIDTH = 7;
export const SIDEWALK_WIDTH = 3;

export type RGB = [number, number, number];

/** True within a street band centred on a cell-boundary line. */
export function isStreetLine(coordinate: number): boolean {
  const m = (((coordinate - STREET_OFFSET) % STREET_BLOCK) + STREET_BLOCK) % STREET_BLOCK;
  return m < STREET_HALF_WIDTH || m > STREET_BLOCK - STREET_HALF_WIDTH;
}

/** True on the sidewalk ring just outside a street band. */
export function isSidewalk(coordinate: number): boolean {
  if (isStreetLine(coordinate)) return false;
  const m = (((coordinate - STREET_OFFSET) % STREET_BLOCK) + STREET_BLOCK) % STREET_BLOCK;
  const edge = Math.min(m, STREET_BLOCK - m);
  return edge < STREET_HALF_WIDTH + SIDEWALK_WIDTH;
}

// Deterministic integer hash -> [0, 1). Same pattern as terrain height so the
// ground stays stable across platforms and browsers.
function hash3(seed: number, x: number, z: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h = Math.imul(h ^ (z | 0), 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function shade(base: RGB, variation: number, rng: number): RGB {
  const f = 1 + (rng - 0.5) * 2 * variation;
  return [
    Math.max(0, Math.min(255, Math.round(base[0] * f))),
    Math.max(0, Math.min(255, Math.round(base[1] * f))),
    Math.max(0, Math.min(255, Math.round(base[2] * f))),
  ];
}

const ASPHALT: RGB = [46, 50, 54];
const SIDEWALK_GRAY: RGB = [122, 124, 118];
const CONCRETE: RGB = [86, 90, 82];
const GRASS: RGB = [92, 107, 66];
const GRASS_DARK: RGB = [70, 84, 50];
const GRASS_DRY: RGB = [110, 110, 70];
const DIRT: RGB = [122, 106, 79];

/**
 * Albedo color at a world position. Urban: asphalt streets on the block
 * boundaries, sidewalk rings, per-block concrete tint. Rural: grass with
 * coarse blotches and a dirt road along z = 0.
 */
export function sampleGround(
  x: number,
  z: number,
  environment: TerrainEnvironment,
  seed: number,
): RGB {
  if (environment === "urban") {
    if (isStreetLine(x) || isStreetLine(z)) {
      return shade(ASPHALT, 0.08, hash3(seed, Math.round(x), Math.round(z)));
    }
    if (isSidewalk(x) || isSidewalk(z)) {
      return shade(SIDEWALK_GRAY, 0.06, hash3(seed ^ 0x51de, Math.round(x), Math.round(z)));
    }
    const bx = Math.floor((x + TERRAIN_SIZE / 2) / STREET_BLOCK);
    const bz = Math.floor((z + TERRAIN_SIZE / 2) / STREET_BLOCK);
    const tint = 0.9 + hash3(seed ^ 0xb10c, bx, bz) * 0.2;
    const base = shade(CONCRETE, 0.05, hash3(seed, Math.round(x / 4), Math.round(z / 4)));
    return [
      Math.max(0, Math.min(255, Math.round(base[0] * tint))),
      Math.max(0, Math.min(255, Math.round(base[1] * tint))),
      Math.max(0, Math.min(255, Math.round(base[2] * tint))),
    ];
  }
  // Rural: dirt road first so it cuts through the grass.
  if (Math.abs(z) <= 8) {
    return shade(DIRT, 0.08, hash3(seed, Math.round(x), Math.round(z)));
  }
  const cell = 45;
  const pick = hash3(seed ^ 0x9a17, Math.floor(x / cell), Math.floor(z / cell));
  if (pick < 0.3) return shade(GRASS_DARK, 0.06, hash3(seed, Math.round(x / 3), Math.round(z / 3)));
  if (pick > 0.75) return shade(GRASS_DRY, 0.06, hash3(seed, Math.round(x / 3), Math.round(z / 3)));
  return shade(GRASS, 0.05, hash3(seed, Math.round(x / 3), Math.round(z / 3)));
}

/**
 * Bake the albedo into a canvas texture. PlaneGeometry UVs map u -> +x and
 * v = 1 at -z after the ground rotation, so pixel (px, py) covers
 * x = px/size*SIZE - SIZE/2, z = py/size*SIZE - SIZE/2.
 */
export function drawGroundTexture(
  seedValue: number,
  environment: TerrainEnvironment,
  size: number = GROUND_TEXTURE_SIZE,
): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const fallback = new THREE.DataTexture(
    new Uint8Array([90, 90, 90, 255]), 1, 1, THREE.RGBAFormat,
  );
  fallback.needsUpdate = true;
  if (!context) return fallback;
  const image = context.createImageData(size, size);
  const data = image.data;
  for (let py = 0; py < size; py += 1) {
    const z = (py / size) * TERRAIN_SIZE - TERRAIN_SIZE / 2;
    for (let px = 0; px < size; px += 1) {
      const x = (px / size) * TERRAIN_SIZE - TERRAIN_SIZE / 2;
      const [r, g, b] = sampleGround(x, z, environment, seedValue);
      const i = (py * size + px) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

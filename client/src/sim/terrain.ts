// Pure terrain height field. No Three.js import, so it stays unit-testable under
// vitest's node environment (same pattern as state/session.ts).
//
// The field is a deterministic function of (seed, x, z) only. That is required
// by NFR-01: the same scenario seed must reproduce the same world, so the
// collision surface a trainee flies against matches the terrain they see.

export type TerrainEnvironment = "urban" | "rural";

export interface TerrainOptions {
  seed: number;
  environment: TerrainEnvironment;
}

export const TERRAIN_SIZE = 2000;
export const TERRAIN_SEGMENTS = 128;
// Flat pad at the origin so a session always starts on usable ground.
export const SPAWN_CLEAR_RADIUS = 60;
// Falloff extends to this radius so the pad blends into open terrain.
const SPAWN_BLEND_RADIUS = 160;
export const MAX_TERRAIN_HEIGHT = 55;

// Layered octaves give rolling hills; the exact weights are derived from the
// amplitude halving inside fbm() rather than fixed here.
const BASE_FREQUENCY = 1 / 900;

// Deterministic 32-bit hash -> [0,1). Integer maths only, so it is stable
// across platforms and browsers (Math.random and float hashing are not).
function hash2(seed: number, x: number, z: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ x, 0x27d4eb2d);
  h = Math.imul(h ^ z, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Value noise with smooth interpolation, sampled at an arbitrary frequency.
function valueNoise(seed: number, x: number, z: number, frequency: number): number {
  const sx = x * frequency;
  const sz = z * frequency;
  const x0 = Math.floor(sx);
  const z0 = Math.floor(sz);
  const tx = smoothstep(sx - x0);
  const tz = smoothstep(sz - z0);

  const n00 = hash2(seed, x0, z0);
  const n10 = hash2(seed, x0 + 1, z0);
  const n01 = hash2(seed, x0, z0 + 1);
  const n11 = hash2(seed, x0 + 1, z0 + 1);

  const nx0 = n00 + (n10 - n00) * tx;
  const nx1 = n01 + (n11 - n01) * tx;
  return nx0 + (nx1 - nx0) * tz;
}

// Fractal brownian motion: summed octaves of value noise. Normalized by the
// total amplitude so the result is always within 0..1 regardless of octave
// count -- otherwise the extra urban/rural octave would inflate the peak and
// push terrain past MAX_TERRAIN_HEIGHT.
function fbm(seed: number, x: number, z: number, octaves: number): number {
  let total = 0;
  let frequency = BASE_FREQUENCY;
  let amplitude = 1;
  let amplitudeSum = 0;
  for (let i = 0; i < octaves; i += 1) {
    total += valueNoise(seed + i * 7919, x, z, frequency) * amplitude;
    amplitudeSum += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return total / amplitudeSum;
}

export class Terrain {
  readonly seed: number;
  readonly environment: TerrainEnvironment;
  private readonly octaves: number;

  constructor(options: TerrainOptions) {
    this.seed = options.seed;
    this.environment = options.environment;
    // Rural is rolling open ground; urban is flatter, as cleared/graded land.
    this.octaves = options.environment === "urban" ? 3 : 4;
  }

  // Height in world units at a world-space point.
  heightAt(x: number, z: number): number {
    const raw = fbm(this.seed, x, z, this.octaves);
    // Remap 0..1 to a rolling profile, flattened toward the edges so the
    // terrain meets the horizon plane without a cliff.
    const edge = Math.max(Math.abs(x), Math.abs(z)) / (TERRAIN_SIZE / 2);
    const edgeFalloff = Math.max(0, 1 - Math.pow(Math.max(0, edge - 0.65) / 0.35, 2));

    const urbanScale = this.environment === "urban" ? 0.45 : 1;
    let height = raw * MAX_TERRAIN_HEIGHT * edgeFalloff * urbanScale;

    // Flatten the launch pad so a session never starts on a slope. The
    // falloff extends past the radius so the pad blends into open ground
    // instead of ending in a step.
    const dist = Math.sqrt(x * x + z * z);
    if (dist < SPAWN_BLEND_RADIUS) {
      const blend = smoothstep(Math.min(1, dist / SPAWN_BLEND_RADIUS));
      height *= blend;
    }
    return height;
  }

  // Approximate surface normal via central differences. Used to orient the
  // aircraft and to decide whether a landing is on a slope.
  slopeAt(x: number, z: number): number {
    const d = 2;
    const dx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const dz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return Math.sqrt(dx * dx + dz * dz) / (2 * d);
  }
}
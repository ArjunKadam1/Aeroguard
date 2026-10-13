// Screen-space contact selection.
//
// This replaces a THREE.Raycaster that had silently stopped working: threats are
// Groups (outline shell + core) and the raycast was called with
// `recursive = false`, which cannot descend into a Group, so no click ever
// selected anything.
//
// Selecting in screen space is also the right tool here. Contacts are small
// (roughly 20px from the ground station) and distant, so a pixel-exact raycast
// would be unreasonably hard to hit. Selecting the nearest contact within a
// tolerance is how an operator actually acquires one.
//
// Pure functions, no Three.js, so this is unit-testable in the node environment.

export interface ScreenContact {
  id: string;
  /** Viewport pixels, origin top-left. */
  x: number;
  y: number;
  visible: boolean;
}

/** Contacts further apart than this on screen are treated as distinct targets. */
export const PICK_TOLERANCE_PX = 26;

/**
 * Nearest visible contact to the click, within tolerance.
 * Returns null when nothing is close enough -- so a miss is a miss, and the
 * trainee must keep looking rather than snapping to whatever is nearest.
 */
export function pickContact(
  contacts: readonly ScreenContact[],
  clickX: number,
  clickY: number,
  tolerance = PICK_TOLERANCE_PX,
): string | null {
  let bestId: string | null = null;
  let bestDistance = Infinity;
  for (const contact of contacts) {
    if (!contact.visible) continue;
    if (!Number.isFinite(contact.x) || !Number.isFinite(contact.y)) continue;
    const distance = Math.hypot(contact.x - clickX, contact.y - clickY);
    if (distance <= tolerance && distance < bestDistance) {
      bestDistance = distance;
      bestId = contact.id;
    }
  }
  return bestId;
}

/** True when a click did not land on any contact (clicking empty sky). */
export function isMiss(contacts: readonly ScreenContact[], clickX: number, clickY: number): boolean {
  return pickContact(contacts, clickX, clickY) === null;
}

// --- Heading ---------------------------------------------------------------
// The ground station is stationary: its camera pans from a fixed position, so
// heading is a value the trainee changes on purpose, never one that advances on
// its own from the clock.

export const STATION_SWEEP_RATE = 0.55; // radians per second

/**
 * Advance the station heading while the sweep key is held.
 * Pure so the "camera is still unless asked to move" rule is directly testable.
 */
export function advanceStationHeading(
  heading: number,
  sweeping: boolean,
  dt: number,
): number {
  if (!sweeping) return heading;
  const step = dt > 0 ? Math.min(dt, 0.1) * STATION_SWEEP_RATE : 0;
  // Bounded to a sector rather than a full circle: a real mast has a traverse
  // limit, and an unbounded spin is disorienting.
  return Math.max(-0.9, Math.min(0.9, heading - step));
}
import { describe, expect, it } from "vitest";
import { STATION_AIM, STATION_POSITION } from "./aircraft";
import {
  HOVER_THROTTLE,
  SCOUT_HOLD_RANGE,
  SCOUT_PATROL_PERIOD_S,
  SCOUT_PATROL_RADIUS,
  assistAim,
  assistResponseClass,
  autopilotInput,
  nextAssistActions,
  patrolWaypoint,
  shortestAngle,
  slewHeading,
  smoothAim,
  stationHeadingFor,
  trackTarget,
  wrapTwoPi,
  type AssistContact,
} from "./assist";
import { GRAVITY, createFlightState, stepFlight, type FlightState, type Vec3 } from "./flight";
import { SCOUT_VISUAL_RANGE } from "./observation";
import { STATION_SWEEP_RATE } from "./picking";

function contact(over: Partial<AssistContact> = {}): AssistContact {
  return {
    id: "T01",
    stage: "spawned",
    tracked: false,
    visual: false,
    workflow: "none",
    ...over,
  };
}

describe("nextAssistActions", () => {
  it("detects a spawned contact once a track exists", () => {
    expect(nextAssistActions([contact({ tracked: true })], new Set()))
      .toEqual([{ kind: "detect", id: "T01" }]);
  });

  it("waits for a track before detecting", () => {
    expect(nextAssistActions([contact({ tracked: false })], new Set())).toEqual([]);
  });

  it("classifies only with a visual track -- the assistant cannot skip the sensor", () => {
    const detected = contact({ stage: "detected", tracked: true, visual: false });
    expect(nextAssistActions([detected], new Set())).toEqual([]);
    expect(nextAssistActions([{ ...detected, visual: true }], new Set()))
      .toEqual([{ kind: "classify", id: "T01" }]);
  });

  it("responds once classified, without waiting for a sensor track", () => {
    expect(nextAssistActions([contact({ stage: "classified" })], new Set()))
      .toEqual([{ kind: "respond", id: "T01" }]);
  });

  it("requests then approves the simulated measure for a responded contact", () => {
    const responded = contact({ stage: "responded" });
    expect(nextAssistActions([{ ...responded, workflow: "ready" }], new Set()))
      .toEqual([{ kind: "request", id: "T01" }]);
    expect(nextAssistActions([{ ...responded, workflow: "awaiting_approval" }], new Set()))
      .toEqual([{ kind: "approve", id: "T01" }]);
  });

  it("leaves a running or finished measure alone", () => {
    for (const workflow of [
      "in_progress", "neutralized", "failed", "aborted", "rejected", "unavailable", "none",
    ] as const) {
      expect(nextAssistActions([contact({ stage: "responded", workflow })], new Set())).toEqual([]);
    }
  });

  it("never advances the same contact twice while a decision is in flight", () => {
    const pending = new Set(["T01"]);
    expect(nextAssistActions([contact({ tracked: true })], pending)).toEqual([]);
  });

  it("takes one step per contact, in scenario order", () => {
    const contacts = [
      contact({ id: "T01", tracked: true }),
      contact({ id: "T02", stage: "detected", visual: true }),
      contact({ id: "T03", stage: "classified" }),
    ];
    expect(nextAssistActions(contacts, new Set())).toEqual([
      { kind: "detect", id: "T01" },
      { kind: "classify", id: "T02" },
      { kind: "respond", id: "T03" },
    ]);
  });

  it("ignores contacts that have not spawned", () => {
    expect(nextAssistActions([contact({ stage: "pending", tracked: true })], new Set())).toEqual([]);
  });
});

describe("assistAim", () => {
  it("holds the oldest observed contact still waiting for a classification", () => {
    const contacts = [
      contact({ id: "T01", stage: "detected" }),
      contact({ id: "T02", stage: "detected", tracked: true }),
      contact({ id: "T03", stage: "spawned", tracked: true }),
    ];
    expect(assistAim(contacts)).toEqual({ target: "T02", search: false });
  });

  it("stays with the contact it is already working while that contact is tracked", () => {
    const contacts = [
      contact({ id: "T01", stage: "detected", tracked: true }),
      contact({ id: "T02", stage: "detected", tracked: true }),
    ];
    expect(assistAim(contacts, "T02")).toEqual({ target: "T02", search: false });
    // A lost track is not a target: fall back to another observed contact.
    expect(assistAim([
      contact({ id: "T01", stage: "detected", tracked: true }),
      contact({ id: "T02", stage: "detected", tracked: false }),
    ], "T02")).toEqual({ target: "T01", search: false });
  });

  it("calls for a search while pending contacts are still unobserved", () => {
    expect(assistAim([contact({ id: "T01", stage: "spawned" })]))
      .toEqual({ target: null, search: true });
    // A classified contact is no longer a reason to search.
    expect(assistAim([contact({ id: "T01", stage: "classified" })]))
      .toEqual({ target: null, search: false });
  });

  it("stops searching once every contact is classified or beyond", () => {
    expect(assistAim([
      contact({ id: "T01", stage: "classified" }),
      contact({ id: "T02", stage: "responded" }),
    ])).toEqual({ target: null, search: false });
  });
});

describe("assistResponseClass", () => {
  it("maps a hostile classification to the authorization class and others to mitigation", () => {
    expect(assistResponseClass("hostile")).toBe("weapon-class");
    for (const label of ["friendly", "civilian", "unknown", "suspicious"]) {
      expect(assistResponseClass(label)).toBe("mitigation");
    }
  });
});

describe("angle helpers", () => {
  it("wraps to [0, 2π)", () => {
    expect(wrapTwoPi(0)).toBe(0);
    expect(wrapTwoPi(Math.PI * 2)).toBe(0);
    expect(wrapTwoPi(-Math.PI / 2)).toBeCloseTo((Math.PI * 3) / 2);
  });

  it("finds the shortest signed difference", () => {
    expect(shortestAngle(0.5)).toBeCloseTo(0.5);
    expect(shortestAngle(Math.PI * 2 - 0.5)).toBeCloseTo(-0.5);
    expect(shortestAngle(-Math.PI * 2 + 0.5)).toBeCloseTo(0.5);
  });
});

describe("stationHeadingFor", () => {
  it("heads at zero when the target is the default aim point", () => {
    expect(stationHeadingFor(STATION_AIM)).toBeCloseTo(0, 6);
  });

  it("pans a quarter turn to look due east of the mast", () => {
    const east = { x: STATION_POSITION.x + 100, y: 0, z: STATION_POSITION.z };
    const heading = stationHeadingFor(east);
    // The mast heading rotates the aim bearing by the same amount, so the
    // resulting look direction must carry the target's own bearing.
    const aimBearing = Math.atan2(
      STATION_AIM.x - STATION_POSITION.x,
      -(STATION_AIM.z - STATION_POSITION.z),
    );
    expect(wrapTwoPi(aimBearing + heading)).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("slewHeading", () => {
  it("steps toward the target at the trainee sweep rate", () => {
    const step = slewHeading(0, 1, 0.1);
    expect(step).toBeCloseTo(STATION_SWEEP_RATE * 0.1, 6);
  });

  it("does not overshoot a nearby target", () => {
    expect(slewHeading(0.99, 1, 1)).toBeCloseTo(1, 6);
  });

  it("takes the short way around the wrap", () => {
    const heading = slewHeading(0.05, Math.PI * 2 - 0.05, 0.5);
    // Moving backwards through 0 to just under 2π is shorter than swinging the
    // long way around, so the heading wraps high rather than climbing to it.
    expect(heading).toBeGreaterThan(Math.PI * 2 - 0.06);
    expect(heading).toBeLessThan(Math.PI * 2);
  });

  it("clamps dt so a background tab cannot jump the mast", () => {
    const huge = slewHeading(0, Math.PI, 10);
    // At exactly half a turn either direction is equally short, so measure
    // the step taken rather than the side it chose: one sweep tick, no jump.
    const step = Math.min(huge, Math.PI * 2 - huge);
    expect(step).toBeCloseTo(STATION_SWEEP_RATE * 0.1, 6);
  });
});

const FLIGHT_ENV = { groundAt: () => 0, gravity: GRAVITY };

/** Fly the real airframe under the assistant controller toward a fixed point. */
function flyFor(state: FlightState, target: Vec3, seconds: number): FlightState {
  const dt = 1 / 60;
  let next = state;
  for (let t = 0; t < seconds; t += dt) {
    const input = autopilotInput(next.position, next.attitude.y, target, {
      velocity: next.velocity,
    });
    next = stepFlight(next, input, dt, FLIGHT_ENV);
  }
  return next;
}

describe("autopilotInput", () => {
  it("hovers in place with no target", () => {
    expect(autopilotInput({ x: 0, y: 100, z: 0 }, 0, null)).toEqual({
      pitch: 0, roll: 0, yaw: 0, throttle: HOVER_THROTTLE, forward: 0,
    });
  });

  it("flies forward at a distant target dead ahead", () => {
    const input = autopilotInput({ x: 0, y: 100, z: 0 }, 0, { x: 0, y: 100, z: -400 });
    expect(input.yaw).toBeCloseTo(0, 6);
    expect(input.forward).toBeCloseTo(0.9, 6);
  });

  it("turns hard toward a target behind the nose", () => {
    const input = autopilotInput({ x: 0, y: 100, z: 0 }, 0, { x: 0, y: 100, z: 400 });
    expect(Math.abs(input.yaw)).toBeCloseTo(1, 6);
  });

  it("does not thrust forward while the target is behind the nose", () => {
    // Full thrust along the old nose is what made the scout fly out, turn, and
    // come back. Alignment scaling means it turns first, then commits.
    const input = autopilotInput({ x: 0, y: 100, z: 0 }, 0, { x: 0, y: 100, z: 400 });
    expect(input.forward).toBe(0);
  });

  it("holds at the visual standoff", () => {
    const input = autopilotInput(
      { x: 0, y: 100, z: 0 }, 0, { x: 0, y: 100, z: -SCOUT_HOLD_RANGE },
    );
    expect(input.forward).toBe(0);
  });

  it("brakes instead of coasting through the standoff", () => {
    const input = autopilotInput(
      { x: 0, y: 100, z: 0 }, 0, { x: 0, y: 100, z: -(SCOUT_HOLD_RANGE - 40) },
    );
    expect(input.forward).toBeLessThan(0);
  });

  it("climbs toward a higher target and descends to a lower one", () => {
    const higher = autopilotInput({ x: 0, y: 100, z: 0 }, 0, { x: 0, y: 160, z: -200 });
    const lower = autopilotInput({ x: 0, y: 100, z: 0 }, 0, { x: 0, y: 40, z: -200 });
    expect(higher.throttle).toBeGreaterThan(HOVER_THROTTLE);
    expect(lower.throttle).toBeLessThan(HOVER_THROTTLE);
  });

  it("damps a climb with airframe velocity so it does not overshoot", () => {
    const target = { x: 0, y: 120, z: -200 };
    const atRest = autopilotInput({ x: 0, y: 100, z: 0 }, 0, target);
    const climbing = autopilotInput(
      { x: 0, y: 100, z: 0 }, 0, target, { velocity: { x: 0, y: 12, z: 0 } },
    );
    expect(climbing.throttle).toBeLessThan(atRest.throttle);
  });

  it("settles at the standoff from a long approach", () => {
    const target = { x: 0, y: 100, z: -100 };
    const state = flyFor(createFlightState(0, 100, 200), target, 20);
    const horizontal = Math.hypot(
      state.position.x - target.x, state.position.z - target.z,
    );
    expect(horizontal).toBeGreaterThan(SCOUT_HOLD_RANGE - 40);
    expect(horizontal).toBeLessThan(SCOUT_HOLD_RANGE + 40);
    expect(Math.abs(state.position.y - target.y)).toBeLessThan(10);
  });

  it("arrives with the contact inside the visual gate, altitude included", () => {
    const target = { x: 0, y: 220, z: -100 };
    const state = flyFor(createFlightState(0, 100, 200), target, 26);
    const horizontal = Math.hypot(
      state.position.x - target.x, state.position.z - target.z,
    );
    const vertical = target.y - state.position.y;
    const range = Math.hypot(horizontal, vertical);
    expect(range).toBeLessThan(SCOUT_VISUAL_RANGE);
    // The scout camera looks level, so the contact must not sit above its cone.
    expect(Math.abs(vertical)).toBeLessThan(
      Math.tan(Math.PI / 6) * Math.max(horizontal, 1),
    );
  });

  it("keeps flying the moving search orbit instead of stalling on the waypoint", () => {
    const dt = 1 / 60;
    let state = createFlightState(0, 120, -SCOUT_PATROL_RADIUS);
    for (let t = 0; t < 30; t += dt) {
      const input = autopilotInput(
        state.position, state.attitude.y,
        patrolWaypoint(t, state.position.y),
        { standoff: 0, velocity: state.velocity },
      );
      state = stepFlight(state, input, dt, FLIGHT_ENV);
    }
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeGreaterThan(6);
    const radius = Math.hypot(state.position.x, state.position.z);
    expect(radius).toBeGreaterThan(120);
    expect(radius).toBeLessThan(360);
  });
});

describe("smoothAim", () => {
  it("starts on the first aim point", () => {
    expect(smoothAim(null, { x: 1, y: 2, z: 3 }, 1 / 60)).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("moves partway toward a new fix and then converges", () => {
    const first = smoothAim({ x: 0, y: 0, z: 0 }, { x: 100, y: 20, z: -50 }, 1 / 60);
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(100);
    let point = first;
    for (let i = 0; i < 240; i += 1) {
      point = smoothAim(point, { x: 100, y: 20, z: -50 }, 1 / 60);
    }
    expect(Math.abs(point.x - 100)).toBeLessThan(1);
    expect(Math.abs(point.y - 20)).toBeLessThan(1);
    expect(Math.abs(point.z + 50)).toBeLessThan(1);
  });
});

describe("trackTarget", () => {
  it("places a zero-bearing fix straight ahead of the observer", () => {
    expect(trackTarget({ x: 0, y: 50, z: 90 }, 0, 100, 45))
      .toEqual({ x: 0, y: 45, z: -10 });
  });

  it("places an east fix on the +x side, matching the radar bearing convention", () => {
    const target = trackTarget({ x: 0, y: 50, z: 90 }, 90, 100, 45);
    expect(target.x).toBeCloseTo(100, 6);
    expect(target.z).toBeCloseTo(90, 6);
  });
});

describe("patrolWaypoint", () => {
  it("starts due south of the corridor centre and keeps the supplied altitude", () => {
    expect(patrolWaypoint(0, 120)).toEqual({ x: 0, y: 120, z: -SCOUT_PATROL_RADIUS });
  });

  it("stays on the orbit at every moment of the session", () => {
    for (let second = 0; second <= 600; second += 7) {
      const point = patrolWaypoint(second, 100);
      expect(Math.hypot(point.x, point.z)).toBeCloseTo(SCOUT_PATROL_RADIUS, 6);
      // The orbit must stay inside the airspace box at every point.
      expect(Math.abs(point.x)).toBeLessThanOrEqual(550);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(360);
    }
  });

  it("completes one lap per patrol period", () => {
    const start = patrolWaypoint(0, 100);
    const lap = patrolWaypoint(SCOUT_PATROL_PERIOD_S, 100);
    expect(lap.x).toBeCloseTo(start.x, 6);
    expect(lap.z).toBeCloseTo(start.z, 6);
  });
});

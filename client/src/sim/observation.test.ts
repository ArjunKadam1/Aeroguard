import { describe, expect, it } from "vitest";
import {
  PATTERN_ACQUIRE,
  RADAR_CONFIRM_HITS,
  SCOUT_RADAR_RANGE,
  SCOUT_VISUAL_RANGE,
  TRACK_BEARING_RATE_LIMIT,
  TRACK_MAX_STALE_TICKS,
  acquireModifier,
  bearingDegOf,
  detectRadar,
  detectVisual,
  falseDetections,
  observeContact,
  radarDetectionProbability,
  radarTick,
  rcsClassForId,
  roll01,
  scoutObserver,
  stationObserver,
  trackPermissions,
  trackState,
  trackTick,
  updateTracks,
  type ContactTruth,
  type Detection,
  type SensorConditions,
  type Track,
} from "./observation";

const PERFECT: SensorConditions = { sensorQuality: 1, night: false, visibility: "clear" };
const DEAD: SensorConditions = { sensorQuality: 0, night: true, visibility: "poor" };

function truth(id: string, x: number, y: number, z: number): ContactTruth {
  return { id, position: { x, y, z }, spawned: true, pattern: null };
}

function det(id: string): Detection {
  return { id, bearingDeg: 90, range: 200 };
}

describe("roll01", () => {
  it("is deterministic and bounded", () => {
    expect(roll01("a|T01|visual")).toBe(roll01("a|T01|visual"));
    expect(roll01("a|T01|visual")).toBeGreaterThanOrEqual(0);
    expect(roll01("a|T01|visual")).toBeLessThan(1);
  });

  it("varies across keys", () => {
    const values = new Set(
      ["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"].map((k) => roll01(k)),
    );
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("bearingDegOf", () => {
  it("measures clockwise from -Z", () => {
    expect(bearingDegOf({ x: 0, y: 0, z: -10 })).toBeCloseTo(0, 6);
    expect(bearingDegOf({ x: 10, y: 0, z: 0 })).toBeCloseTo(90, 6);
    expect(bearingDegOf({ x: 0, y: 0, z: 10 })).toBeCloseTo(180, 6);
    expect(bearingDegOf({ x: -10, y: 0, z: 0 })).toBeCloseTo(270, 6);
  });
});

describe("observers", () => {
  it("stations the mast with no radar fitted", () => {
    const observer = stationObserver(0);
    expect(observer.kind).toBe("station");
    expect(observer.position).toEqual({ x: 0, y: 50, z: 90 });
    expect(observer.radarRange).toBe(0);
  });

  it("aims the station look direction along the pan heading", () => {
    const centre = stationObserver(0);
    const panned = stationObserver(0.5);
    // Same mast, different aim.
    expect(panned.position).toEqual(centre.position);
    const dot = centre.lookDirection.x * panned.lookDirection.x
      + centre.lookDirection.y * panned.lookDirection.y
      + centre.lookDirection.z * panned.lookDirection.z;
    const mag = (v: { x: number; y: number; z: number }) =>
      Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    expect(dot / (mag(centre.lookDirection) * mag(panned.lookDirection))).toBeLessThan(1);
  });

  it("builds a scout observer from pose and camera axis", () => {
    const observer = scoutObserver({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: -1 });
    expect(observer.kind).toBe("scout");
    expect(observer.visualRange).toBe(SCOUT_VISUAL_RANGE);
    expect(observer.radarRange).toBe(SCOUT_RADAR_RANGE);
  });

  it("computes sweep ticks by flooring", () => {
    expect(radarTick(0)).toBe(0);
    expect(radarTick(1.99)).toBe(0);
    expect(radarTick(2)).toBe(1);
    expect(radarTick(-5)).toBe(0);
  });

  it("quantizes track ticks to half-second quanta, never frames", () => {
    expect(trackTick(0)).toBe(0);
    expect(trackTick(0.49)).toBe(0);
    expect(trackTick(0.5)).toBe(1);
    expect(trackTick(7.3)).toBe(14);
    expect(trackTick(-2)).toBe(0);
  });
});

describe("observeContact", () => {
  const station = stationObserver(0);

  it("reports nothing for unspawned contacts", () => {
    const contact: ContactTruth = { id: "T01", position: { x: -10, y: 45, z: 0 }, spawned: false, pattern: null };
    expect(observeContact(station, contact, PERFECT, 7, 0)).toMatchObject({
      id: "T01", visual: false, radar: false,
    });
  });

  it("sees a contact on the station aim under perfect conditions", () => {
    const contact = truth("T01", -10, 45, 0);
    const obs = observeContact(station, contact, PERFECT, 7, 0);
    expect(obs.visual).toBe(true);
    expect(obs.radar).toBe(false); // the mast has no radar
  });

  it("loses the contact when the mast pans away", () => {
    const contact = truth("T01", -10, 45, 0);
    const obs = observeContact(stationObserver(0.9), contact, PERFECT, 7, 0);
    expect(obs.visual).toBe(false);
  });

  it("misses intermittently under degradation, keyed by tick", () => {
    const contact = truth("T01", -10, 45, 0);
    const conditions: SensorConditions = { sensorQuality: 0.5, night: false, visibility: "clear" };
    // Same tick, same answer; different ticks may differ. Either way the
    // lifecycle absorbs it -- nothing here is permanently locked out.
    const first = observeContact(station, contact, conditions, 7, 0).visual;
    expect(observeContact(station, contact, conditions, 7, 0).visual).toBe(first);
    expect(first).toBe(roll01("7|T01|visual:0") < 0.5);
  });

  it("misses everything when the sensor is dead", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const contact = truth("T01", 0, 100, -100);
    expect(observeContact(scout, contact, DEAD, 7, 0).visual).toBe(false);
  });

  it("gives the scout radar without visual behind the camera", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const behind = truth("T01", 0, 100, 100); // 100 units behind, inside radar range
    const obs = observeContact(scout, behind, PERFECT, 7, 3);
    expect(obs.visual).toBe(false);
    expect(obs.radar).toBe(true);
    expect(obs.range).toBeCloseTo(100, 6);
  });

  it("sees ahead visually within range", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const ahead = truth("T01", 0, 100, -100);
    const obs = observeContact(scout, ahead, PERFECT, 7, 3);
    expect(obs.visual).toBe(true);
    expect(obs.radar).toBe(true);
  });

  it("leaves corridor and pattern-less contacts exactly as before", () => {
    const station = stationObserver(0);
    for (const pattern of ["straight-transit", "direct-approach", "orbit-hold", null] as const) {
      const contact: ContactTruth = { ...truth("T01", -10, 45, 0), pattern };
      expect(observeContact(station, contact, PERFECT, 7, 0).visual).toBe(true);
    }
  });  it("loses radar beyond range", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const far = truth("T01", 0, 100, -(SCOUT_RADAR_RANGE + 50));
    expect(observeContact(scout, far, PERFECT, 7, 3).radar).toBe(false);
  });

  it("keeps bearing noise within the documented bound", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const behind = truth("T01", 0, 100, 100); // true bearing 180
    for (let tick = 0; tick < 12; tick += 1) {
      const obs = observeContact(scout, behind, PERFECT, 7, tick);
      if (obs.radar) {
        const error = Math.abs(((obs.bearingDeg - 180 + 540) % 360) - 180);
        expect(error).toBeLessThanOrEqual(6.001);
      }
    }
  });

  it("is deterministic for identical inputs", () => {
    const scout = scoutObserver({ x: 5, y: 90, z: -40 }, { x: 0.2, y: -0.1, z: -1 });
    const contact = truth("T02", -30, 60, -120);
    expect(observeContact(scout, contact, PERFECT, 42, 9))
      .toEqual(observeContact(scout, contact, PERFECT, 42, 9));
  });
});

describe("channel detectors", () => {
  const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
  const ahead = truth("T01", 0, 100, -100);
  const behind = truth("T02", 0, 100, 100);

  it("splits visual and radar channels", () => {
    expect(detectVisual(scout, [ahead, behind], PERFECT, 7, 3).map((d) => d.id)).toEqual(["T01"]);
    expect(detectRadar(scout, [ahead, behind], PERFECT, 7, 3).map((d) => d.id).sort())
      .toEqual(["T01", "T02"]);
  });

  it("gives the station no radar channel at all", () => {
    expect(detectRadar(stationObserver(0), [ahead], PERFECT, 7, 3)).toEqual([]);
  });
});

describe("updateTracks", () => {
  it("confirms on first visual sight", () => {
    const tracks = updateTracks([], [det("T01")], [], 0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: "T01", lastSource: "visual", seenVisual: true, hits: 1 });
    expect(trackState(tracks[0], 0)).toBe("confirmed");
  });

  it("holds radar-only contacts tentative until repeated hits", () => {
    const first = updateTracks([], [], [det("T01")], 0);
    expect(trackState(first[0], 0)).toBe("tentative");
    expect(trackPermissions(first[0])).toEqual({ detect: true, classify: false });
    const second = updateTracks(first, [], [det("T01")], 1);
    expect(second[0].hits).toBe(RADAR_CONFIRM_HITS);
    expect(trackState(second[0], 1)).toBe("confirmed");
  });

  it("upgrades to both when the camera finds a radar track", () => {
    const radar = updateTracks([], [], [det("T01")], 0);
    const fused = updateTracks(radar, [det("T01")], [det("T01")], 1);
    expect(fused[0]).toMatchObject({ lastSource: "both", seenVisual: true });
    expect(trackPermissions(fused[0])).toEqual({ detect: true, classify: true });
  });

  it("coasts missed ticks on the last fix, then drops", () => {
    const first = updateTracks([], [det("T01")], [], 0);
    const coasted = updateTracks(first, [], [], 1);
    expect(coasted).toHaveLength(1);
    expect(trackState(coasted[0], 1)).toBe("coasting");
    // Coasting tracks stay actionable until they drop.
    expect(trackPermissions(coasted[0])).toEqual({ detect: true, classify: true });
    expect(updateTracks(first, [], [], TRACK_MAX_STALE_TICKS)).toHaveLength(1);
    expect(updateTracks(first, [], [], TRACK_MAX_STALE_TICKS + 1)).toEqual([]);
  });

  it("re-acquires a coasting track with fresh hits", () => {
    const first = updateTracks([], [], [det("T01")], 0);
    const coasted = updateTracks(first, [], [], 1);
    const reacquired = updateTracks(coasted, [det("T01")], [], 2);
    expect(reacquired[0]).toMatchObject({ hits: 2, lastTick: 2, seenVisual: true });
    expect(trackState(reacquired[0], 2)).toBe("confirmed");
  });

  it("is deterministic for identical tick sequences", () => {
    const run = () => {
      let tracks: Track[] = [];
      tracks = updateTracks(tracks, [det("T01")], [], 0);
      tracks = updateTracks(tracks, [], [det("T01")], 1);
      tracks = updateTracks(tracks, [], [], 2);
      return tracks;
    };
    expect(run()).toEqual(run());
  });
});

describe("trackPermissions", () => {
  it("forbids everything without a track", () => {
    expect(trackPermissions(null)).toEqual({ detect: false, classify: false });
  });

  it("allows detection but not classification on tentative radar tracks", () => {
    const [tentative] = updateTracks([], [], [det("T01")], 0);
    expect(trackPermissions(tentative)).toEqual({ detect: true, classify: false });
  });

  it("allows the full chain once seen visually", () => {
    const [confirmed] = updateTracks([], [det("T01")], [], 0);
    expect(trackPermissions(confirmed)).toEqual({ detect: true, classify: true });
  });
});

describe("falseDetections", () => {
  it("emits nothing under perfect conditions", () => {
    for (let sweep = 0; sweep < 10; sweep += 1) {
      expect(falseDetections(7, sweep, PERFECT)).toEqual([]);
    }
  });

  it("is deterministic for identical inputs", () => {
    const conditions: SensorConditions = { sensorQuality: 0.2, night: true, visibility: "poor" };
    expect(falseDetections(7, 5, conditions)).toEqual(falseDetections(7, 5, conditions));
  });

  it("caps concurrent blips and keeps them radar-shaped", () => {
    const conditions: SensorConditions = { sensorQuality: 0.2, night: true, visibility: "poor" };
    for (let sweep = 0; sweep < 20; sweep += 1) {
      const blips = falseDetections(7, sweep, conditions);
      expect(blips.length).toBeLessThanOrEqual(2);
      for (const blip of blips) {
        expect(blip.id).toMatch(/^F-0[12]$/);
        expect(blip.bearingDeg).toBeGreaterThanOrEqual(0);
        expect(blip.bearingDeg).toBeLessThan(360);
        expect(blip.range).toBeGreaterThanOrEqual(100);
        expect(blip.range).toBeLessThanOrEqual(350);
      }
    }
  });

  it("schedules the same blips for the same seed and sweep", () => {
    const conditions: SensorConditions = { sensorQuality: 0.3, night: false, visibility: "reduced" };
    // Find a sweep that actually emits (deterministic search, not luck).
    let sweep = -1;
    for (let candidate = 0; candidate < 200; candidate += 1) {
      if (falseDetections(99, candidate, conditions).length > 0) {
        sweep = candidate;
        break;
      }
    }
    expect(sweep).toBeGreaterThanOrEqual(0);
    const first = falseDetections(99, sweep, conditions);
    expect(first).toEqual(falseDetections(99, sweep, conditions));
    // ...but a different seed tells a different story somewhere.
    let differs = false;
    for (let candidate = 0; candidate < 200; candidate += 1) {
      if (JSON.stringify(falseDetections(100, candidate, conditions))
        !== JSON.stringify(falseDetections(99, candidate, conditions))) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

describe("pattern acquisition difficulty", () => {
  const station = stationObserver(0);

  it("covers every known pattern with a bounded multiplier", () => {
    expect(Object.keys(PATTERN_ACQUIRE)).toHaveLength(7);
    for (const value of Object.values(PATTERN_ACQUIRE)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("treats missing or unknown patterns as neutral", () => {
    expect(acquireModifier(null)).toBe(1);
    expect(acquireModifier(undefined)).toBe(1);
    expect(acquireModifier("warp-drive")).toBe(1);
  });

  it("ranks agile patterns strictly harder than steady ones", () => {
    expect(acquireModifier("erratic-jink")).toBeLessThan(acquireModifier("wide-weave"));
    expect(acquireModifier("wide-weave")).toBeLessThan(acquireModifier("straight-transit"));
    expect(acquireModifier("straight-transit")).toBe(1);
  });

  it("drops agile contacts intermittently even under perfect conditions", () => {
    const contact: ContactTruth = { ...truth("T01", -10, 45, 0), pattern: "erratic-jink" };
    let seen = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      if (observeContact(station, contact, PERFECT, 7, tick).visual) seen += 1;
    }
    // p = 0.65 per tick: must miss some ticks but hold most of them.
    expect(seen).toBeGreaterThan(10);
    expect(seen).toBeLessThan(40);
  });

  it("leaves radar acquisition pattern-independent", () => {
    const scout = scoutObserver({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: -1 });
    const behind: ContactTruth = { ...truth("T01", 0, 100, 100), pattern: "erratic-jink" };
    // Same seeded roll as the unpatterned case: radar ignores the modifier.
    expect(observeContact(scout, behind, PERFECT, 7, 3).radar).toBe(true);
  });
});

describe("radar equation", () => {
  it("assigns RCS classes by id hash, covering every class", () => {
    expect(rcsClassForId("T01")).toBe(rcsClassForId("T01"));
    const classes = new Set(Array.from({ length: 200 }, (_, i) => rcsClassForId(`T${i}`)));
    expect(classes).toEqual(new Set(["small", "medium", "large"]));
  });

  it("scales the detectability knee with the RCS class", () => {
    expect(radarDetectionProbability(400, "small", PERFECT))
      .toBeLessThan(radarDetectionProbability(400, "medium", PERFECT));
    expect(radarDetectionProbability(400, "medium", PERFECT))
      .toBeLessThan(radarDetectionProbability(400, "large", PERFECT));
  });

  it("matches the R^-4 falloff curve at unit pressure", () => {
    // Absolute calibration pins: at full quality, clear weather, the medium
    // class sits exactly on 1/(1 + (R/600)^4). A drifting pressure term (or a
    // missing clamp) shifts these and fails here.
    expect(radarDetectionProbability(100, "medium", PERFECT))
      .toBeCloseTo(1 / (1 + (100 / 600) ** 4), 6);
    expect(radarDetectionProbability(400, "medium", PERFECT))
      .toBeCloseTo(1 / (1 + (400 / 600) ** 4), 6);
    const close = radarDetectionProbability(100, "medium", PERFECT);
    const far = radarDetectionProbability(400, "medium", PERFECT);
    expect(close).toBeGreaterThan(0.95);
    expect(far).toBeGreaterThan(0.5);
    expect(far).toBeLessThan(close);
  });

  it("is attenuated by weather but never by night", () => {
    const base: SensorConditions = { sensorQuality: 1, night: false, visibility: "clear" };
    const clear = radarDetectionProbability(300, "medium", base);
    const reduced = radarDetectionProbability(300, "medium", { ...base, visibility: "reduced" });
    const poor = radarDetectionProbability(300, "medium", { ...base, visibility: "poor" });
    const night = radarDetectionProbability(300, "medium", { ...base, night: true });
    expect(reduced).toBeLessThan(clear);
    expect(poor).toBeLessThan(reduced);
    expect(night).toBe(clear);
  });

  it("is zero for a dead system at any range or class", () => {
    for (const cls of ["small", "medium", "large"] as const) {
      expect(radarDetectionProbability(50, cls, DEAD)).toBe(0);
    }
  });
});

describe("urban radar clutter", () => {
  it("adds ghost returns in urban environments", () => {
    const base: SensorConditions = { sensorQuality: 0.2, night: false, visibility: "clear" };
    let rural = 0;
    let urban = 0;
    for (let sweep = 0; sweep < 60; sweep += 1) {
      rural += falseDetections(7, sweep, base).length;
      urban += falseDetections(7, sweep, { ...base, environment: "urban" }).length;
    }
    expect(urban).toBeGreaterThan(rural);
  });
});

describe("tracker filtering", () => {
  // The target crosses 5 deg and 2.5u per 0.5s tick: 10 deg/s and -5 u/s.
  function movingDet(tick: number): Detection {
    return { id: "T01", bearingDeg: 90 + 5 * tick, range: 200 - 2.5 * tick };
  }

  it("estimates bearing and range rates from successive fixes", () => {
    let tracks: Track[] = [];
    for (let tick = 0; tick < 6; tick += 1) {
      tracks = updateTracks(tracks, [movingDet(tick)], [], tick);
    }
    const [t] = tracks;
    expect(t.bearingRate ?? 0).toBeGreaterThan(7);
    expect(t.bearingRate ?? 0).toBeLessThan(14);
    expect(t.rangeRate ?? 0).toBeLessThan(-3.5);
    expect(t.rangeRate ?? 0).toBeGreaterThan(-12);
  });

  it("extrapolates a coasting track along its estimated rates", () => {
    let tracks: Track[] = [];
    tracks = updateTracks(tracks, [movingDet(0)], [], 0);
    tracks = updateTracks(tracks, [movingDet(1)], [], 1);
    const before = tracks[0];
    const coasted = updateTracks(tracks, [], [], 2);
    expect(coasted).toHaveLength(1);
    expect(coasted[0].lastTick).toBe(1); // still a coast
    expect(coasted[0].bearingDeg).toBeGreaterThan(before.bearingDeg);
    expect(coasted[0].range).toBeLessThan(before.range);
  });

  it("leaves a single-fix coast exactly on the last fix", () => {
    const first = updateTracks([], [det("T01")], [], 0);
    const coasted = updateTracks(first, [], [], 3);
    expect(coasted[0]).toMatchObject({ bearingDeg: 90, range: 200 });
  });

  it("clamps rates under wild measurement swings", () => {
    let tracks: Track[] = [];
    for (let tick = 0; tick < 12; tick += 1) {
      const bearingDeg = tick % 2 === 0 ? 0 : 180;
      tracks = updateTracks(tracks, [{ id: "T01", bearingDeg, range: 200 }], [], tick);
    }
    expect(Math.abs(tracks[0].bearingRate ?? 0))
      .toBeLessThanOrEqual(TRACK_BEARING_RATE_LIMIT + 1e-9);
  });
});

import { describe, expect, it } from "vitest";
import {
  BOOST_THROTTLE,
  MAX_THROTTLE,
  THROTTLE_RATE,
  actionForKey,
  clearControls,
  createControlState,
  isFlightKey,
  press,
  readControls,
  release,
} from "./input";

describe("control mapping", () => {
  it("maps W/S to forward and reverse travel", () => {
    expect(actionForKey("w")).toBe("forward");
    expect(actionForKey("s")).toBe("reverse");
  });

  it("maps R/F and Space/Ctrl to climb and descend", () => {
    expect(actionForKey("r")).toBe("throttleUp");
    expect(actionForKey("f")).toBe("throttleDown");
    expect(actionForKey(" ")).toBe("throttleUp");
    expect(actionForKey("Control")).toBe("throttleDown");
  });

  it("maps A/D to yaw", () => {
    expect(actionForKey("a")).toBe("yawLeft");
    expect(actionForKey("d")).toBe("yawRight");
  });

  it("maps arrows to attitude", () => {
    expect(actionForKey("ArrowUp")).toBe("pitchDown");
    expect(actionForKey("ArrowDown")).toBe("pitchUp");
    expect(actionForKey("ArrowLeft")).toBe("rollLeft");
    expect(actionForKey("ArrowRight")).toBe("rollRight");
  });

  it("ignores unmapped keys", () => {
    expect(actionForKey("z")).toBeUndefined();
    expect(actionForKey("F13")).toBeUndefined();
  });

  it("matches letters regardless of Caps Lock", () => {
    expect(actionForKey("W")).toBe("forward");
    expect(actionForKey("A")).toBe("yawLeft");
    expect(actionForKey("S")).toBe("reverse");
    expect(actionForKey("D")).toBe("yawRight");
    expect(actionForKey("R")).toBe("throttleUp");
  });

  it("still matches the Shift modifier itself", () => {
    expect(actionForKey("Shift")).toBe("boost");
  });

  it("treats Shift+W as travel plus boost", () => {
    const state = createControlState(0.2);
    press(state, "Shift");
    press(state, "W");
    const input = readControls(state, 1 / 60);
    expect(input.forward).toBe(1);
    expect(input.throttle).toBe(BOOST_THROTTLE);
  });

  it("releases correctly when the key is released with a different case", () => {
    const state = createControlState();
    press(state, "w");
    expect(readControls(state, 1 / 60).forward).toBe(1);
    release(state, "W");
    expect(readControls(state, 1 / 60).forward).toBe(0);
  });
});

describe("isFlightKey", () => {
  it("recognises mapped keys in either case", () => {
    expect(isFlightKey("w")).toBe(true);
    expect(isFlightKey("W")).toBe(true);
    expect(isFlightKey("ArrowUp")).toBe(true);
    expect(isFlightKey("Shift")).toBe(true);
  });

  it("rejects unrelated keys", () => {
    expect(isFlightKey("Enter")).toBe(false);
    expect(isFlightKey("k")).toBe(false);
  });
});

describe("readControls", () => {
  it("returns neutral axes when nothing is held", () => {
    const state = createControlState();
    const input = readControls(state, 1 / 60);
    expect(input.pitch).toBe(0);
    expect(input.roll).toBe(0);
    expect(input.yaw).toBe(0);
    expect(input.forward).toBe(0);
    expect(input.throttle).toBeCloseTo(0.55, 6);
  });

  it("W/S changes travel, not altitude", () => {
    const state = createControlState(0.55);
    press(state, "w");
    const input = readControls(state, 0.016);
    expect(input.forward).toBe(1);
    // Throttle is untouched by W, so the aircraft does not climb.
    expect(input.throttle).toBeCloseTo(0.55, 6);
  });

  it("R/F changes altitude, not travel", () => {
    const state = createControlState(0.55);
    press(state, "r");
    const input = readControls(state, 1);
    expect(state.throttle).toBeGreaterThan(0.55);
    expect(input.forward).toBe(0);
  });

  it("raises throttle while held and stops when released", () => {
    const state = createControlState(0.5);
    press(state, "r");
    readControls(state, 1);
    const raised = state.throttle;
    expect(raised).toBeGreaterThan(0.5);
    release(state, "r");
    readControls(state, 1);
    expect(state.throttle).toBeCloseTo(raised, 6);
  });

  it("clamps throttle at both ends", () => {
    const state = createControlState(0);
    press(state, "r");
    for (let i = 0; i < 100; i += 1) readControls(state, 0.1);
    expect(state.throttle).toBe(MAX_THROTTLE);

    release(state, "r");
    press(state, "f");
    for (let i = 0; i < 100; i += 1) readControls(state, 0.1);
    expect(state.throttle).toBe(0);
  });

  it("throttle rate is time-based, not frame-based", () => {
    const a = createControlState(0);
    press(a, "r");
    readControls(a, 1);
    const b = createControlState(0);
    press(b, "r");
    for (let i = 0; i < 10; i += 1) readControls(b, 0.1);
    expect(a.throttle).toBeCloseTo(b.throttle, 6);
    expect(a.throttle).toBeCloseTo(THROTTLE_RATE, 6);
  });

  it("boost overrides a low throttle but never lowers a high one", () => {
    const low = createControlState(0.2);
    press(low, "Shift");
    expect(readControls(low, 1 / 60).throttle).toBe(BOOST_THROTTLE);

    const high = createControlState(0.99);
    press(high, "Shift");
    expect(readControls(high, 1 / 60).throttle).toBeCloseTo(0.99, 6);
  });

  it("produces opposing values for opposing keys, not a sum", () => {
    const state = createControlState();
    press(state, "ArrowLeft");
    press(state, "ArrowRight");
    expect(readControls(state, 1 / 60).roll).toBe(0);
  });

  it("produces opposing values for opposing travel keys", () => {
    const state = createControlState();
    press(state, "w");
    press(state, "s");
    expect(readControls(state, 1 / 60).forward).toBe(0);
  });

  it("clearControls releases everything", () => {
    const state = createControlState();
    press(state, "ArrowUp");
    press(state, "w");
    clearControls(state);
    const input = readControls(state, 1);
    expect(input.pitch).toBe(0);
    expect(state.throttle).toBeCloseTo(0.55, 6);
  });

  it("survives a non-positive time step", () => {
    const state = createControlState(0.5);
    press(state, "w");
    readControls(state, 0);
    readControls(state, -1);
    expect(state.throttle).toBeCloseTo(0.5, 6);
  });
});
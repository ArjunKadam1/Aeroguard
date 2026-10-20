import { describe, expect, it, vi } from "vitest";
import { createAudioEngine } from "./audio";

function stubContext() {
  const osc = {
    type: "",
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gain = { gain: { value: 0 }, connect: vi.fn() };
  return {
    state: "running",
    currentTime: 10,
    destination: {},
    createOscillator: vi.fn(() => osc),
    createGain: vi.fn(() => gain),
    resume: vi.fn(() => Promise.resolve()),
    __osc: osc,
    __gain: gain,
  };
}

describe("audio engine", () => {
  it("stays muted by default and plays nothing", () => {
    const ctx = stubContext();
    const audio = createAudioEngine(() => ctx as unknown as AudioContext);
    expect(audio.enabled()).toBe(false);
    audio.arrival();
    audio.confirm();
    audio.error();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it("plays arrival as a two-tone chime once enabled", () => {
    const ctx = stubContext();
    const audio = createAudioEngine(() => ctx as unknown as AudioContext);
    audio.setEnabled(true);
    expect(audio.enabled()).toBe(true);
    audio.arrival();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctx.__osc.start).toHaveBeenCalledTimes(2);
    expect(ctx.__osc.stop).toHaveBeenCalledTimes(2);
  });

  it("plays single tones for confirm and error", () => {
    const ctx = stubContext();
    const audio = createAudioEngine(() => ctx as unknown as AudioContext);
    audio.setEnabled(true);
    audio.confirm();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
  });

  it("plays a two-tone outcome cue once enabled", () => {
    const ctx = stubContext();
    const audio = createAudioEngine(() => ctx as unknown as AudioContext);
    audio.setEnabled(true);
    audio.outcome();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctx.__osc.start).toHaveBeenCalledTimes(2);
  });

  it("can be muted again", () => {
    const ctx = stubContext();
    const audio = createAudioEngine(() => ctx as unknown as AudioContext);
    audio.setEnabled(true);
    audio.setEnabled(false);
    audio.arrival();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it("is a silent no-op with no AudioContext available", () => {
    const audio = createAudioEngine(() => null);
    audio.setEnabled(true);
    expect(() => {
      audio.arrival();
      audio.confirm();
      audio.error();
      audio.outcome();
    }).not.toThrow();
  });
});

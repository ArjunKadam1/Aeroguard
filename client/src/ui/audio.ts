// Subtle WebAudio cues for training events: contact arrival, action
// confirmation, validation failure, and simulated-outcome resolution.
// Oscillators only -- no audio files, no dependencies.
// Muted by default; the AudioContext is created lazily on the enabling gesture
// so autoplay policies never block a session. With no AudioContext available
// (or while muted) every method is a silent no-op, which also makes the engine
// unit-testable in node by injecting a stub context.

export interface AudioEngine {
  enabled(): boolean;
  setEnabled(value: boolean): void;
  /** A contact entered the sensor picture. */
  arrival(): void;
  /** An action was recorded. */
  confirm(): void;
  /** An action was rejected with feedback. */
  error(): void;
  /** An approved simulated response reached a result. */
  outcome(): void;
}

interface Tone {
  /** Oscillator frequency in Hz. */
  freq: number;
  /** Note length in seconds. */
  duration: number;
  /** Delay after the previous tone, in seconds. */
  delay?: number;
}

const ARRIVAL: Tone[] = [
  { freq: 660, duration: 0.1 },
  { freq: 880, duration: 0.14, delay: 0.09 },
];
const CONFIRM: Tone[] = [{ freq: 520, duration: 0.08 }];
const ERROR: Tone[] = [{ freq: 196, duration: 0.16 }];
// A neutral "something concluded" pair: the strip carries the good/bad tone,
// so the cue itself stays valence-free.
const OUTCOME: Tone[] = [
  { freq: 587, duration: 0.09 },
  { freq: 392, duration: 0.16, delay: 0.09 },
];

const MASTER_GAIN = 0.06;

type ContextFactory = () => AudioContext | null;

function defaultFactory(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  try {
    return new AudioContext();
  } catch {
    return null;
  }
}

export function createAudioEngine(factory: ContextFactory = defaultFactory): AudioEngine {
  let ctx: AudioContext | null = null;
  let muted = true;

  function context(): AudioContext | null {
    if (!ctx) ctx = factory();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  }

  function play(tones: Tone[]): void {
    if (muted) return;
    const audio = context();
    if (!audio) return;
    try {
      const gain = audio.createGain();
      gain.gain.value = MASTER_GAIN;
      gain.connect(audio.destination);
      let at = audio.currentTime;
      for (const tone of tones) {
        at += tone.delay ?? 0;
        const osc = audio.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(tone.freq, at);
        osc.connect(gain);
        osc.start(at);
        osc.stop(at + tone.duration);
      }
    } catch {
      // Audio must never break training: drop the cue on any failure.
    }
  }

  return {
    enabled: () => !muted,
    setEnabled: (value) => {
      muted = !value;
      if (value) context();
    },
    arrival: () => play(ARRIVAL),
    confirm: () => play(CONFIRM),
    error: () => play(ERROR),
    outcome: () => play(OUTCOME),
  };
}

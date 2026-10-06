/**
 * Synthesized WebAudio sound effects from the reference, plus unlock and countdown sounds. No
 * audio files to download. The context is created on the first sound after a user gesture.
 */

export type Sound =
  "jump" | "jump2" | "pick" | "hit" | "caught" | "start" | "mile" | "unlock" | "tick" | "go";

type Ctor = typeof AudioContext;

export class Sfx {
  private ctx: AudioContext | null = null;
  muted: boolean;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  private tone(
    f1: number,
    f2: number,
    dur: number,
    type: OscillatorType = "square",
    vol = 0.045,
    delay = 0,
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  play(sound: Sound): void {
    if (this.muted) return;
    try {
      if (!this.ctx) {
        const AC: Ctor | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === "suspended") void this.ctx.resume();
      switch (sound) {
        case "jump":
          this.tone(420, 760, 0.11);
          break;
        case "jump2":
          this.tone(640, 1150, 0.1);
          break;
        case "pick":
          this.tone(880, 880, 0.06, "triangle", 0.06);
          this.tone(1320, 1320, 0.1, "triangle", 0.06, 0.06);
          break;
        case "hit":
          this.tone(260, 70, 0.26, "sawtooth", 0.06);
          break;
        case "caught":
          this.tone(520, 80, 0.65, "square", 0.05);
          break;
        case "start":
          [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.08, "square", 0.04, i * 0.07));
          break;
        case "mile":
          this.tone(988, 988, 0.07, "triangle", 0.05);
          this.tone(1319, 1319, 0.14, "triangle", 0.05, 0.07);
          break;
        case "unlock":
          [784, 988, 1175, 1568, 1319, 1568].forEach((f, i) =>
            this.tone(f, f, i === 5 ? 0.28 : 0.09, "square", 0.045, i * 0.08),
          );
          break;
        case "tick":
          this.tone(660, 660, 0.08, "square", 0.04);
          break;
        case "go":
          this.tone(990, 990, 0.16, "square", 0.045);
          break;
      }
    } catch {
      // Audio is optional.
    }
  }
}

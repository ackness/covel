/**
 * Background music for a session: one track at a time, changed with a
 * crossfade. The player is told what should be playing — it is given the same
 * track again on every projection — and acts only when that changes, so the
 * music does not restart because the page re-rendered.
 *
 * It keeps out of the way: it lowers itself while other audio of the page
 * plays (a narrated line), pauses while the page is hidden, and waits for the
 * first click or key press when the browser refuses to start sound by itself.
 */

export interface BgmTrack {
  /** Identity of the track: the same key never restarts it. */
  readonly key: string;
  readonly url: string;
  readonly loop: boolean;
  /** The author's level for this track, 0–1. */
  readonly volume: number;
  readonly fadeMs: number;
}

export const DEFAULT_FADE_MS = 1500;
/** Share of its level the music keeps while other audio plays. */
const DUCKED_SHARE = 0.25;
const FADE_STEP_MS = 50;

interface Voice {
  readonly audio: HTMLAudioElement;
  readonly track: BgmTrack;
}

export class BgmPlayer {
  private voice: Voice | null = null;
  private level = 1;
  private muted = false;
  private readonly others = new Set<EventTarget>();
  private readonly fades = new Map<HTMLAudioElement, number>();
  private waitingForGesture = false;

  constructor(
    private readonly createAudio: (url: string) => HTMLAudioElement = (url) =>
      new Audio(url),
  ) {
    document.addEventListener("play", this.onOtherPlay, true);
    document.addEventListener("pause", this.onOtherStop, true);
    document.addEventListener("ended", this.onOtherStop, true);
    document.addEventListener("emptied", this.onOtherStop, true);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** The track that should be playing now; null for silence. */
  play(track: BgmTrack | null): void {
    const current = this.voice;
    if (current && track && current.track.key === track.key) {
      // The same track: only its level may have changed.
      this.voice = { audio: current.audio, track };
      current.audio.loop = track.loop;
      this.settle(300);
      return;
    }
    if (current) this.release(current, track?.fadeMs ?? DEFAULT_FADE_MS);
    this.voice = null;
    if (!track) return;

    const audio = this.createAudio(track.url);
    audio.loop = track.loop;
    audio.volume = 0;
    audio.preload = "auto";
    this.voice = { audio, track };
    this.start(track.fadeMs);
  }

  /** The player's own volume, 0–1. */
  setLevel(level: number): void {
    this.level = Math.min(1, Math.max(0, level));
    this.settle(200);
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (!muted && this.voice?.audio.paused) this.start(400);
    else this.settle(400);
  }

  dispose(): void {
    document.removeEventListener("play", this.onOtherPlay, true);
    document.removeEventListener("pause", this.onOtherStop, true);
    document.removeEventListener("ended", this.onOtherStop, true);
    document.removeEventListener("emptied", this.onOtherStop, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.stopWaiting();
    if (this.voice) this.release(this.voice, 0);
    this.voice = null;
  }

  private target(): number {
    if (!this.voice || this.muted) return 0;
    const share = this.others.size > 0 ? DUCKED_SHARE : 1;
    return this.voice.track.volume * this.level * share;
  }

  private start(fadeMs: number): void {
    const voice = this.voice;
    if (!voice || this.muted || document.hidden) return;
    void voice.audio.play().then(
      () => {
        if (this.voice === voice) this.settle(fadeMs);
      },
      () => {
        // The browser starts no sound before the player touches the page.
        if (this.voice === voice) this.waitForGesture();
      },
    );
  }

  private settle(fadeMs: number): void {
    const voice = this.voice;
    if (!voice) return;
    this.fade(voice.audio, this.target(), fadeMs, () => {
      // A muted track stops, so a silent tab does not keep decoding audio.
      if (this.muted && this.voice === voice) voice.audio.pause();
    });
  }

  private release(voice: Voice, fadeMs: number): void {
    this.fade(voice.audio, 0, fadeMs, () => {
      voice.audio.pause();
      voice.audio.removeAttribute("src");
      voice.audio.load?.();
    });
  }

  private fade(
    audio: HTMLAudioElement,
    to: number,
    ms: number,
    done?: () => void,
  ): void {
    const running = this.fades.get(audio);
    if (running !== undefined) window.clearInterval(running);
    this.fades.delete(audio);
    const from = audio.volume;
    const steps = Math.round(ms / FADE_STEP_MS);
    if (steps <= 0 || from === to) {
      audio.volume = to;
      done?.();
      return;
    }
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      audio.volume = Math.min(
        1,
        Math.max(0, from + ((to - from) * step) / steps),
      );
      if (step < steps) return;
      window.clearInterval(timer);
      this.fades.delete(audio);
      done?.();
    }, FADE_STEP_MS);
    this.fades.set(audio, timer);
  }

  private waitForGesture(): void {
    if (this.waitingForGesture) return;
    this.waitingForGesture = true;
    document.addEventListener("pointerdown", this.onGesture, true);
    document.addEventListener("keydown", this.onGesture, true);
  }

  private stopWaiting(): void {
    this.waitingForGesture = false;
    document.removeEventListener("pointerdown", this.onGesture, true);
    document.removeEventListener("keydown", this.onGesture, true);
  }

  private readonly onGesture = (): void => {
    this.stopWaiting();
    this.start(this.voice?.track.fadeMs ?? DEFAULT_FADE_MS);
  };

  private readonly onOtherPlay = (event: Event): void => {
    if (event.target && event.target !== this.voice?.audio) {
      this.others.add(event.target);
      this.settle(300);
    }
  };

  private readonly onOtherStop = (event: Event): void => {
    if (event.target && this.others.delete(event.target)) this.settle(600);
  };

  private readonly onVisibility = (): void => {
    const voice = this.voice;
    if (!voice) return;
    if (document.hidden) voice.audio.pause();
    else this.start(400);
  };
}

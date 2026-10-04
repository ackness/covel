import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BgmPlayer, type BgmTrack } from "../bgm-player.js";

/** Stands in for an audio element: it records what the player asked of it. */
class FakeAudio {
  volume = 1;
  loop = false;
  preload = "";
  paused = true;
  released = false;
  refuse = false;
  constructor(readonly url: string) {}
  play(): Promise<void> {
    if (this.refuse) return Promise.reject(new Error("NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(): void {
    this.released = true;
  }
  load(): void {}
}

const track = (key: string, extra: Partial<BgmTrack> = {}): BgmTrack => ({
  key,
  url: `blob:${key}`,
  loop: true,
  volume: 1,
  fadeMs: 1000,
  ...extra,
});

describe("background music player", () => {
  let created: FakeAudio[];
  let refuseNext: boolean;
  let player: BgmPlayer;
  /** Run the promise callbacks of `play()`, then the fade. */
  const settle = async (ms = 1000) => {
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    created = [];
    refuseNext = false;
    player = new BgmPlayer((url) => {
      const audio = new FakeAudio(url);
      audio.refuse = refuseNext;
      created.push(audio);
      return audio as unknown as HTMLAudioElement;
    });
  });
  afterEach(() => {
    player.dispose();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("fades a track in, and does not restart it when asked for it again", async () => {
    player.play(track("theme"));
    expect(created[0]!.volume).toBe(0);
    await settle();
    expect(created[0]).toMatchObject({ paused: false, loop: true, volume: 1 });

    player.play(track("theme", { volume: 0.5 }));
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]!.volume).toBe(0.5);
  });

  it("crosses from one track to the next and releases the old one", async () => {
    player.play(track("theme"));
    await settle();
    player.play(track("battle", { loop: false }));
    await settle(500);
    // Half way: the old track is still going down while the new one comes up.
    expect(created[0]!.volume).toBeCloseTo(0.5, 1);
    await settle(600);
    expect(created[0]).toMatchObject({ paused: true, released: true });
    expect(created[1]).toMatchObject({ paused: false, loop: false, volume: 1 });

    player.play(null);
    await settle(1600);
    expect(created[1]).toMatchObject({ paused: true, released: true });
  });

  it("applies the player's own volume and stops while muted", async () => {
    player.setLevel(0.6);
    player.play(track("theme", { volume: 0.5 }));
    await settle();
    expect(created[0]!.volume).toBeCloseTo(0.3);

    player.setMuted(true);
    await settle();
    expect(created[0]).toMatchObject({ paused: true, volume: 0 });

    player.setMuted(false);
    await settle();
    expect(created[0]!.paused).toBe(false);
    expect(created[0]!.volume).toBeCloseTo(0.3);
  });

  it("lowers itself while other audio of the page plays", async () => {
    player.play(track("theme"));
    await settle();
    const narration = document.body.appendChild(
      document.createElement("audio"),
    );

    narration.dispatchEvent(new Event("play"));
    await settle();
    expect(created[0]!.volume).toBeCloseTo(0.25);

    narration.dispatchEvent(new Event("ended"));
    await settle();
    expect(created[0]!.volume).toBe(1);
  });

  it("waits for the first press when the browser refuses to start sound", async () => {
    refuseNext = true;
    player.play(track("theme"));
    await settle();
    expect(created[0]!.paused).toBe(true);

    created[0]!.refuse = false;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(created[0]).toMatchObject({ paused: false, volume: 1 });
  });
});

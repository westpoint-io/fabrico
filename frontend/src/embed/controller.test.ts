import { describe, expect, it } from 'vitest';
import { createBoardClock, MAX_STEP_PER_FRAME, ticksThisFrame, type ClockPlayer, type FrameClock } from './controller';

/** A player that counts ticks from `boot` to `end` and hashes each tick as `h<tick>`. */
function fakePlayer(boot: number, end: number, opts: { failAt?: number } = {}): ClockPlayer & {
  steps: number[];
  restarts: number;
} {
  let tick = boot;
  const p = {
    steps: [] as number[],
    restarts: 0,
    step(n: number): void {
      p.steps.push(n);
      for (let i = 0; i < n && tick < end; i++) {
        if (opts.failAt !== undefined && tick === opts.failAt) {
          throw new Error(`the script entry at tick ${tick} names handle 42, which isn't minted yet`);
        }
        tick += 1;
      }
    },
    restart(): void {
      p.restarts += 1;
      tick = boot;
    },
    tick: (): number => tick,
    endTick: (): number => end,
    tickHash: (): string => `h${tick}`,
  };
  return p;
}

/** A frame clock the test advances by hand. */
function fakeFrames(): FrameClock & { run(ms: number): void; pending(): number } {
  let next = 1;
  let now = 0;
  const queue = new Map<number, (t: number) => void>();
  return {
    request(cb): number {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancel(id): void {
      queue.delete(id);
    },
    run(ms): void {
      now += ms;
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb(now);
    },
    pending: (): number => queue.size,
  };
}

function setup(boot = 10, end = 100, opts: { failAt?: number; trace?: boolean } = {}) {
  const player = fakePlayer(boot, end, opts);
  const frames = fakeFrames();
  let drained = 0;
  const faults: unknown[] = [];
  const clock = createBoardClock({
    player,
    drain: () => {
      drained += 1;
    },
    onFault: (e) => faults.push(e),
    frames,
    trace: opts.trace,
  });
  return { player, frames, clock, faults, drained: () => drained };
}

describe('ticksThisFrame', () => {
  it('adds elapsed_ms * 60 * speed / 1000 to the due count', () => {
    expect(ticksThisFrame(0, 1000 / 60, 1, 100)).toEqual({ step: 1, due: expect.closeTo(0, 9) });
    expect(ticksThisFrame(0, 1000 / 60, 4, 100).step).toBe(4);
    const quarter = ticksThisFrame(0, 1000 / 60, 0.25, 100);
    expect(quarter.step).toBe(0);
    expect(quarter.due).toBeCloseTo(0.25, 9);
  });

  it('steps at most 16 ticks a frame and drops the rest', () => {
    const r = ticksThisFrame(0, 60_000, 4, 1_000_000);
    expect(r.step).toBe(MAX_STEP_PER_FRAME);
    expect(r.due).toBeLessThan(1);
  });

  it('never steps past the end tick', () => {
    expect(ticksThisFrame(0, 1000, 4, 3).step).toBe(3);
    expect(ticksThisFrame(5, 1000, 1, 0).step).toBe(0);
  });
});

describe('createBoardClock', () => {
  it('plays at 60 ticks a second times the speed', () => {
    const { clock, frames, player } = setup();
    clock.play();
    frames.run(0);
    frames.run(1000 / 60);
    expect(player.tick()).toBe(11);
    clock.setSpeed(4);
    frames.run(1000 / 60);
    expect(player.tick()).toBe(15);
    clock.setSpeed(0.25);
    for (let i = 0; i < 5; i++) frames.run(1000 / 60);
    expect(player.tick()).toBe(16);
    expect(clock.speed()).toBe(0.25);
  });

  it('refuses a speed that is not one of the five', () => {
    const { clock } = setup();
    expect(() => clock.setSpeed(3 as never)).toThrow();
    expect(clock.speed()).toBe(1);
  });

  it('stops at the end tick and reads the hash there once', () => {
    const { clock, frames, player } = setup(10, 20);
    clock.play();
    frames.run(0);
    frames.run(10_000);
    expect(player.tick()).toBe(20);
    expect(clock.playing()).toBe(false);
    expect(clock.endHash()).toBe('h20');
    expect(frames.pending()).toBe(0);
  });

  it('Step while playing pauses first, then advances exactly one tick', () => {
    const { clock, frames, player } = setup();
    clock.play();
    frames.run(0);
    frames.run(1000 / 60);
    const before = player.tick();
    clock.stepOne();
    expect(clock.playing()).toBe(false);
    expect(player.tick()).toBe(before + 1);
    frames.run(1000);
    expect(player.tick()).toBe(before + 1);
  });

  it('Step at the end tick does nothing', () => {
    const { clock, frames, player } = setup(10, 12);
    clock.play();
    frames.run(0);
    frames.run(1000);
    expect(player.tick()).toBe(12);
    const stepsBefore = player.steps.length;
    clock.stepOne();
    expect(player.tick()).toBe(12);
    expect(player.steps.length).toBe(stepsBefore);
  });

  it('Step onto the end tick reads the end hash', () => {
    const { clock, player } = setup(10, 11);
    clock.stepOne();
    expect(player.tick()).toBe(11);
    expect(clock.endHash()).toBe('h11');
  });

  it('Restart returns to the boot tick, keeps the speed, and plays', () => {
    const { clock, frames, player } = setup();
    clock.setSpeed(2);
    clock.play();
    frames.run(0);
    frames.run(100);
    clock.pause();
    expect(player.tick()).toBeGreaterThan(10);
    clock.restart();
    expect(player.restarts).toBe(1);
    expect(player.tick()).toBe(10);
    expect(clock.bootTick()).toBe(10);
    expect(clock.speed()).toBe(2);
    expect(clock.playing()).toBe(true);
    expect(clock.endHash()).toBeNull();
  });

  it('Play at the end tick restarts from the boot tick and plays', () => {
    const { clock, frames, player } = setup(10, 15);
    clock.play();
    frames.run(0);
    frames.run(1000);
    expect(clock.endHash()).toBe('h15');
    clock.play();
    expect(player.restarts).toBe(1);
    expect(player.tick()).toBe(10);
    expect(clock.playing()).toBe(true);
    expect(clock.endHash()).toBeNull();
  });

  it('hands the queued packets to the renderer after every step and after a restart', () => {
    const { clock, frames, drained } = setup();
    clock.play();
    frames.run(0);
    frames.run(1000 / 60);
    const afterStep = drained();
    expect(afterStep).toBeGreaterThan(0);
    clock.restart();
    expect(drained()).toBe(afterStep + 1);
  });

  it('a step error stops the clock and reports the tick it stopped at', () => {
    const { clock, frames, faults } = setup(10, 100, { failAt: 12 });
    clock.play();
    frames.run(0);
    frames.run(1000);
    expect(clock.playing()).toBe(false);
    expect(faults).toHaveLength(1);
    expect(clock.fault()).toEqual({
      tick: 12,
      message: "the script entry at tick 12 names handle 42, which isn't minted yet",
    });
    clock.play();
    expect(clock.playing()).toBe(false);
    clock.restart();
    expect(clock.fault()).toBeNull();
    expect(clock.playing()).toBe(true);
  });

  it('in trace mode steps one tick at a time and records every tick hash from boot', () => {
    const { clock, frames, player } = setup(10, 30, { trace: true });
    clock.setSpeed(4);
    clock.play();
    frames.run(0);
    frames.run(1000 / 60);
    expect(player.steps.every((n) => n === 1)).toBe(true);
    frames.run(1000);
    const trace = clock.tickHashes();
    expect(trace.map(([t]) => t)).toEqual(Array.from({ length: 21 }, (_, i) => 10 + i));
    expect(trace.every(([t, h]) => h === `h${t}`)).toBe(true);
    clock.restart();
    expect(clock.tickHashes()).toEqual([[10, 'h10']]);
  });

  it('records nothing outside trace mode', () => {
    const { clock, frames } = setup();
    clock.play();
    frames.run(0);
    frames.run(100);
    expect(clock.tickHashes()).toEqual([]);
  });

  it('pause stops the ticks and stop cancels the pending frame', () => {
    const { clock, frames, player } = setup();
    clock.play();
    frames.run(0);
    clock.pause();
    frames.run(1000);
    expect(player.tick()).toBe(10);
    clock.play();
    clock.stop();
    expect(frames.pending()).toBe(0);
  });
});

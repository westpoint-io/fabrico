import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecodeError } from '../protocol/decode';

const decodeRenderPacket = vi.fn();
vi.mock('../protocol/decode', async (importOriginal) => {
  const real = await importOriginal<typeof import('../protocol/decode')>();
  return { ...real, decodeRenderPacket: (bytes: Uint8Array) => decodeRenderPacket(bytes) };
});
const applyPacket = vi.fn();
vi.mock('./sceneState', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sceneState')>();
  return { ...real, applyPacket: (...a: unknown[]) => applyPacket(...a) };
});

const { createPacketPipeline } = await import('./packetPipeline');
const { createSceneState } = await import('./sceneState');

const BYTES = new Uint8Array([1]);

afterEach(() => {
  decodeRenderPacket.mockReset();
  applyPacket.mockReset();
  vi.restoreAllMocks();
});

describe('createPacketPipeline', () => {
  it('skips a diff older than the scene without counting or applying it', () => {
    const scene = createSceneState();
    scene.tick = 10;
    decodeRenderPacket.mockReturnValue({ full: false, generation: scene.generation, tick: 9 });
    const before = vi.fn();
    const p = createPacketPipeline(() => scene, { beforeApply: before });
    p.handle(BYTES);
    expect(p.stats()).toEqual({ packetsApplied: 0, decodeErrors: 0 });
    expect(before).not.toHaveBeenCalled();
    expect(applyPacket).not.toHaveBeenCalled();
  });

  it('counts and applies a current packet, passing beforeApply\'s value to afterApply', () => {
    const scene = createSceneState();
    const packet = { full: true, generation: 0, tick: 0 };
    decodeRenderPacket.mockReturnValue(packet);
    const order: string[] = [];
    applyPacket.mockImplementation(() => order.push('apply'));
    const after = vi.fn(() => order.push('after'));
    const p = createPacketPipeline(() => scene, {
      beforeApply: () => {
        order.push('before');
        return 'ctx-value';
      },
      afterApply: after,
    });
    p.handle(BYTES);
    expect(order).toEqual(['before', 'apply', 'after']);
    expect(after).toHaveBeenCalledWith(packet, scene, 'ctx-value');
    expect(p.stats()).toEqual({ packetsApplied: 1, decodeErrors: 0 });
  });

  it('counts a decode error without throwing or logging', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    decodeRenderPacket.mockImplementation(() => {
      throw new DecodeError('truncated');
    });
    const p = createPacketPipeline(() => createSceneState());
    expect(() => p.handle(BYTES)).not.toThrow();
    expect(p.stats()).toEqual({ packetsApplied: 0, decodeErrors: 1 });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs any other error with console.error and does not throw', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    decodeRenderPacket.mockReturnValue({ full: true, generation: 0, tick: 0 });
    const boom = new Error('hook broke');
    const p = createPacketPipeline(() => createSceneState(), {
      afterApply: () => {
        throw boom;
      },
    });
    expect(() => p.handle(BYTES)).not.toThrow();
    expect(log).toHaveBeenCalledWith('packet handler failed', boom);
    expect(p.stats()).toEqual({ packetsApplied: 1, decodeErrors: 0 });
  });

  it('hands every dropped packet to onDropped, a decode error and any other, after counting it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dropped: unknown[] = [];
    const truncated = new DecodeError('truncated');
    decodeRenderPacket.mockImplementationOnce(() => {
      throw truncated;
    });
    const boom = new Error('apply broke');
    applyPacket.mockImplementationOnce(() => {
      throw boom;
    });
    decodeRenderPacket.mockReturnValue({ full: true, generation: 0, tick: 0 });
    const p = createPacketPipeline(() => createSceneState(), {
      onDropped: (error) => {
        dropped.push(error);
        expect(p.stats().decodeErrors).toBe(1);
      },
    });
    p.handle(BYTES);
    p.handle(BYTES);
    p.handle(BYTES);
    expect(dropped).toEqual([truncated, boom]);
    expect(p.stats()).toEqual({ packetsApplied: 2, decodeErrors: 1 });
  });
});

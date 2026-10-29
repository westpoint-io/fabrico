// plotRead.ts - read back what a Pixi `Graphics` has PLOTTED (review fix IN-B-06).
//
// The test probes behind `window.__fabrico` (the ring centres, the target rings, the reject flash
// cell, the ghost, the junction collar, the wire preview) answer from the drawing itself, never
// from the point list a caller handed to the paint, because a probe that reads the request passes
// on a build whose draw call plots nothing (the phase 73 lesson). Pixi v8 keeps what a Graphics
// drew in `context.instructions`: each `fill` or `stroke` instruction carries the path it drew,
// built into shape primitives (`circle`, `rectangle`, `roundedRectangle`, `polygon`, ...), each with
// the transform the context recorded. That layout is Pixi's own and not a public API, so every
// probe used to cast its way in and, when a field was missing, `continue` past it, which made a
// Pixi upgrade read as "nothing plotted": a negative grade ("no flash", "no ring") would then pass
// on a layout this code can no longer see. The cast now lives here once, and a `fill` or `stroke`
// instruction that does not carry the layout THROWS (`PlotLayoutError`), so a changed layout fails
// every probe loudly instead of answering empty.
//
// Read-only: walks the instructions, copies plain numbers out, keeps no reference.

import type { Graphics } from 'pixi.js';

/** The instruction layout this module reads is not the one the running Pixi wrote. */
export class PlotLayoutError extends Error {
  constructor(detail: string) {
    super(`plotRead: ${detail}: Pixi's GraphicsContext layout changed, so this plot read cannot answer`);
    this.name = 'PlotLayoutError';
  }
}

/** One plotted shape primitive, with the instruction that drew it. */
export interface PlottedShape {
  /** Whether the shape was filled or stroked. */
  action: 'fill' | 'stroke';
  /** The fill or stroke colour, or -1 when the style carries none. */
  color: number;
  /** Pixi's shape type: `circle`, `rectangle`, `roundedRectangle`, `polygon`, ... */
  type: string;
  /** The shape's x and y (a circle's centre, a rectangle's corner), mapped through its transform. */
  x: number;
  y: number;
  /** A rectangle's width and height, as drawn (not transformed). */
  width?: number;
  height?: number;
  /** A circle's radius. */
  radius?: number;
  /** A polygon's vertices, mapped through its transform. */
  points?: Array<{ x: number; y: number }>;
}

type Transform = { apply(p: { x: number; y: number }): { x: number; y: number } };
type Primitive = {
  shape?: { type?: unknown; x?: number; y?: number; width?: number; height?: number; radius?: number; points?: number[] };
  transform?: Transform;
};

/**
 * Every fill and stroke instruction `g` holds, in drawing order: its action, its colour and how
 * many shape primitives its path built. One entry per INSTRUCTION, even one whose path built no
 * primitive (a preview stroke can hold a path Pixi has not built into shapes on that frame), so a
 * caller that asks "what colour is being stroked" gets the answer the old instruction walk gave.
 * The layout check is the same as {@link plottedShapes}: an instruction without the path layout
 * throws.
 */
export function plottedInstructions(g: Graphics): Array<{ action: 'fill' | 'stroke'; color: number; primitives: number }> {
  const out: Array<{ action: 'fill' | 'stroke'; color: number; primitives: number }> = [];
  for (const ins of g.context.instructions) {
    if (ins.action !== 'stroke' && ins.action !== 'fill') {
      continue;
    }
    const data = ins.data as unknown as {
      path?: { shapePath?: { shapePrimitives?: unknown } };
      style?: { color?: number };
    };
    const prims = data?.path?.shapePath?.shapePrimitives;
    if (!Array.isArray(prims)) {
      throw new PlotLayoutError(`a ${ins.action} instruction carries no path.shapePath.shapePrimitives array`);
    }
    out.push({ action: ins.action, color: data.style?.color ?? -1, primitives: prims.length });
  }
  return out;
}

/** Every shape primitive `g` has filled or stroked, in drawing order. */
export function plottedShapes(g: Graphics): PlottedShape[] {
  const out: PlottedShape[] = [];
  for (const ins of g.context.instructions) {
    if (ins.action !== 'stroke' && ins.action !== 'fill') {
      continue;
    }
    const data = ins.data as unknown as {
      path?: { shapePath?: { shapePrimitives?: unknown } };
      style?: { color?: number };
    };
    const prims = data?.path?.shapePath?.shapePrimitives;
    if (!Array.isArray(prims)) {
      throw new PlotLayoutError(`a ${ins.action} instruction carries no path.shapePath.shapePrimitives array`);
    }
    for (const prim of prims as Primitive[]) {
      const shape = prim?.shape;
      if (!shape || typeof shape.type !== 'string') {
        throw new PlotLayoutError(`a ${ins.action} primitive carries no shape type`);
      }
      const map = (p: { x: number; y: number }) => (prim.transform ? prim.transform.apply(p) : p);
      const at = map({ x: shape.x ?? 0, y: shape.y ?? 0 });
      const plotted: PlottedShape = { action: ins.action, color: data.style?.color ?? -1, type: shape.type, x: at.x, y: at.y };
      if (shape.width !== undefined) plotted.width = shape.width;
      if (shape.height !== undefined) plotted.height = shape.height;
      if (shape.radius !== undefined) plotted.radius = shape.radius;
      if (Array.isArray(shape.points)) {
        const flat = shape.points;
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const v = map({ x: flat[i], y: flat[i + 1] });
          pts.push({ x: v.x, y: v.y });
        }
        plotted.points = pts;
      }
      out.push(plotted);
    }
  }
  return out;
}

/**
 * Every circle `g` has plotted, its centre mapped through the recorded transform. `action` and
 * `color` come from the instruction that drew it, so a caller can tell a ring (stroke) from a disc
 * (fill) and an armed ring from a passive one.
 */
export function plottedCircles(g: Graphics): Array<{ x: number; y: number; action: 'stroke' | 'fill'; color: number }> {
  return plottedShapes(g)
    .filter((s) => s.type === 'circle')
    .map((s) => ({ x: s.x, y: s.y, action: s.action, color: s.color }));
}

/** Every rectangle (plain or rounded) `g` has filled, as drawn: corner, width and height, colour. */
export function plottedFilledRects(g: Graphics): Array<{ x: number; y: number; w: number; h: number; color: number }> {
  return plottedShapes(g)
    .filter((s) => s.action === 'fill' && (s.type === 'rectangle' || s.type === 'roundedRectangle'))
    .map((s) => ({ x: s.x, y: s.y, w: s.width ?? 0, h: s.height ?? 0, color: s.color }));
}

/**
 * Every open polyline `g` has stroked: a `moveTo`/`lineTo` run builds into one polygon primitive
 * whose vertices are the run's points. Fills and every non-polygon primitive are skipped, so a ring
 * or a disc on the same Graphics never reads as a run.
 */
export function plottedPolylines(g: Graphics): Array<Array<{ x: number; y: number }>> {
  return plottedShapes(g)
    .filter((s) => s.action === 'stroke' && s.type === 'polygon' && s.points !== undefined)
    .map((s) => s.points!);
}

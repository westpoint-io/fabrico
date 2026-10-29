import { isTimelineRestructure } from './portEditLatch.ts';

/**
 * The take-the-fit rule (DEMO-07, D-12, plan 85-06): whether the packet now arriving frames
 * the camera on the board.
 *
 * App.tsx keeps a `fitPendingRef`. It starts pending (boot), is set when the demo or an example
 * is requested, and is cleared when a Load is refused. NEW and a user's `.fab` Open do not set
 * it: an empty board has nothing to frame, and a user's own board keeps the camera they had
 * (the done-walk spec reopens a board and expects its label back at the same place on screen).
 * This function decides which packet TAKES a pending fit:
 *
 * - a TIMELINE-RESTRUCTURE keyframe (`full` and not a lag `resync`, the same predicate the
 *   queued-edit hold reads). A load's keyframe is one; a diff never is, so a user's first
 *   placement on a board never yanks the camera (WR-01). A lag resync resends the timeline
 *   the client already had and frames nothing new.
 * - that carries at least one node, since a fit over an empty board has nothing to frame.
 *
 * Before plan 85-06 the rule was a per-mount latch (`hasFramed`) that fired once, at boot, so
 * an example loaded later kept the previous board's zoom (walk-113). The caller clears the
 * pending flag BEFORE it schedules the fit (WR-01's latch-before-fit order), so a second
 * keyframe arriving while the chrome lays out cannot schedule a second fit.
 */
export function takeFit(pending: boolean, packet: { full: boolean; resync: boolean }, nodeCount: number): boolean {
  return pending && isTimelineRestructure(packet) && nodeCount > 0;
}

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import {
  DEMO_NODE_COUNT,
  applyConfig,
  armAndPlaceAt,
  backedUpMarkPaintedOn,
  beltEndInstructionsOn,
  cablePolylines,
  cameraOf,
  CELL,
  clickAt,
  deselectViaEmptyCell,
  drawnNodesOf,
  drawOffloadBelt,
  drawWireBetweenPorts,
  ensurePlaying,
  expectHeadOn,
  expectRefusalStayedSilent,
  expectRenderLoopAlive,
  fillPanelField,
  CAPTURE_FRAMES,
  CAPTURE_POLL_TRIES,
  captureClip,
  captureCostLine,
  DRAWN_STATE_FRAMES,
  HOST_APPLY_TICKS,
  glyphSubjectOn,
  handPlaceAt,
  itemDotsPerCell,
  loadGaugeFormOn,
  labelBoxOn,
  labelWordsOf,
  loadDemoViaExamples,
  newBoard,
  nodeAtAnchor,
  nubAnchor,
  noteCaptureMs,
  pollScene,
  pressSegment,
  readFactorySource,
  readPanelUrl,
  readScene,
  readTickRecorder,
  recordStatusStripDuring,
  resetToDemo,
  resetZoomToActualSize,
  screenCellCentre,
  screenPoint,
  selectMachineAt,
  startTickRecorder,
  stopTickRecorder,
  typeFactorySource,
  waitForAppReady,
  waitForCameraSettle,
  watchPageErrors,
  webhookUrl,
  ENDPOINT_URL_SHAPE,
  type PortFacts,
  type SceneFacts,
  type TickRecord,
  type WireFacts,
} from './support/oracle';
import {
  flowingBaseline,
  gaugeFormsByDrawnTick,
  gaugeReleaseViolations,
  gradeReleaseOrder,
  jamFractions,
  mergedBarAgainstDrips,
  mergedFraction,
  outletSteadyReading,
  outletSteadyViolations,
  packsBackwards,
  pseudoRLine,
  releaseOrderLine,
  releaseSustained,
  thinningTicks,
  type JamIds,
  type JamRecord,
} from './support/jamGrading';
import { drawnItemsLine, gradeDrawnItems, type WatchedBelt } from './support/itemFrames';
import { gradeDrawnCables, type CableTraceGrade, type ModelCable } from './support/cableTrace';
import {
  cablesOnCanvas,
  collarInk,
  gaugeOnCanvas,
  gradeGrowth,
  boundaryBrackets,
  packOrderViolations,
  labelOnCanvas,
  packedDepth,
  resolvingSamples,
  unresolvedStages,
  visibleDotsPerTile,
  GAUGE_OUTSET_PX,
  GAUGE_RUN_PX,
  GAUGE_THICK_PX,
  type CableToRead,
  type CablesOnCanvas,
  type CollarInk,
  type DecodedImage,
  type GaugeOnCanvas,
  type LabelOnCanvas,
  type TileInImage,
} from './support/canvasDots';
import { PNG } from 'playwright-core/lib/utilsBundle';
import { addFrameBudget, addWaitBudget, frameBudgetMs, tickBudgetMs } from '../e2e/support/frameSampler';
import { decodePngRows } from './support/pngRows';
import { captureFrameInPage, type CaptureMode, type CapturedFrame } from './support/frameCapture';

// 77-one-board-all-five.live.spec.ts - COMP-01: the v9.0 milestone done-test, walked as ONE
// composed walk on ONE board booted empty, on the real host.
//
// WHY THIS FILE EXISTS. v8.0's phase 69 lesson: every live spec in this suite runs on a board
// carrying exactly ONE phase's feature, so a milestone whose done-test needs several features
// on one board can pass every single-feature spec and still not be walkable. This file walks the
// five legs below IN ORDER, on ONE board and ONE page, starting from EMPTY. The v8.0 walk
// (`24-one-board-all-six.spec.ts`) is left exactly as it is (77 D-01).
//
// ===========================================================================
// THE DONE-TEST, WORD FOR WORD (the v9.0 requirements, "The milestone
// done-test"). `src/gates/oneBoardAllFive.source.test.ts` rule R8 compares each sentence below
// with that file on every `npm test`, so a reworded leg reddens there.
// ===========================================================================
//
// 1. Place an HTTP Endpoint and an HTTP Handler from the palette, draw one wire between them,
//    POST to the endpoint's URL, and get back a 200 whose body the JS in the Handler's own
//    panel produced.
//
// 2. Place a Source, draw a belt from it, then press that belt's end nub and draw a second belt
//    from there: the panel reads "This run is 2 belts." Set the run's downstream belt to its
//    slowest pace and watch items pack solid tile by tile back through the junction.
//
// 3. Run that belt into a machine and slow the machine's outlet: the machine carries the
//    backed-up mark, and the tile touching it stops emptying while the line packs backwards -
//    then release and watch the jam clear from the front.
//
// 4. (AMENDED 2026-10-06; the original leg 4, which also resized a machine from 3x3 to 5x4, is
//    SUPERSEDED: the resize half moved with the footprints phase to SEED-261004-vfw.)
//    Drop a Label beside that belt, type on it and set its size and colour, then save, reload,
//    and find the text, the size and the colour exactly as you left them, with items running
//    past the label untouched.
//
// 5. Press Disconnect on the wire from leg 1, then Ctrl+Z once: the cable comes back in the same
//    place, routed head-on into both prongs, and no message appears at the top of the screen.
//
// ===========================================================================
// NAMED DEVIATIONS AND NAMING NOTES (77 D-08). Later plans extend this list; nothing that
// departs from the literal wording above is absorbed silently.
// ===========================================================================
//
// N1 (naming note, leg 1, D-09). The done-test's "HTTP Endpoint" is the palette row `Route`.
//    Phase 72 renamed it on purpose (`72-CONTEXT.md:19`): same machine, same kind byte (9),
//    same catalog ports. The URL still carries the `/endpoint/` host prefix (72 D-12a).
//
// N2 (naming note, leg 1, D-09). "draw one wire between them" is ONE drag that mints TWO wires,
//    a forward leg (Route Out to Handler In) and a return leg (Handler Out to Route In), from the
//    two machines' declarations (72 D-04, `crates/fabrico-command/tests/wire_pair.rs:123`). The
//    leg grades the pair by ENDPOINTS and never by a wire count, because a count cannot say
//    which machine a wire leaves or reaches.
//
// D-11 (deviation, leg 2). "Set the run's downstream belt to its slowest pace" is walked
//    literally: the DOWNSTREAM belt's panel, the slowest step (25 px per second, 20 ticks per
//    slot), Apply. Under phase 74's D-08 one Apply paces the WHOLE run, so BOTH belts end at
//    the slowest pace, and the leg asserts both. The packing therefore comes from the
//    downstream belt's open head end, where an item has nowhere to go and is held, and NOT
//    from a pace difference between the two belts. Per-belt pace inside a run would override
//    74 D-08; it is a deferred product change and is not built.
//
// D-12 (deviation, leg 2). The palette Source defaults to a Webhook trigger and emits
//    nothing on its own, so the leg sets its Trigger to Timer, interval 30, through the
//    Source's own panel. The leg text does not name this setup. 30 is the fastest feed at
//    which the growth is still observable (measured by the phase 77 research probe): at a
//    feed as fast as the belt or faster (Every 20, Every 2) the line arrives already solid
//    and "tile by tile" cannot be seen.
//
// D-04 (naming note, the item read-back). Every item claim in this file reads
//    `occupiedSlots` off the MODEL, and an item layer that draws nothing, or stale
//    positions, passes those reads and both render-health helpers. So each item claim is
//    also read OFF THE CANVAS, in SCREEN PIXELS: `canvasDotsPerCell` screenshots the tiles
//    and counts the dots visible on each (`support/canvasDots.ts`), compared with the model's
//    items per cell in the same poll. Leg 2 reads the pack's growth and its packed end that
//    way (`PACK GROWS ON THE CANVAS`, `PACK DRAWN ON THE CANVAS`), leg 3 the jam (`JAM DRAWN ON
//    THE CANVAS`). Leg 4's flowing items are graded frame by frame on the dots the item layer
//    PLACED (`ItemLayer.plottedDotsFrame`, positions it stores), and `ITEMS VISIBLE ON THE
//    CANVAS` ties those to pixels: the visible dots per tile equal the placed ones on a
//    screenshot taken between two equal reads of them. Plan 77-02 read the placed dots for
//    every leg; a hidden, zero-scale or transparent item layer still places them, and the
//    walk stayed green (the 77-02 refuter round, refuters 1 and 4).
//
// D-13 (naming note, leg 3). "Run that belt into a machine": the machine is a palette TEE at
//    (11,12), its first Out belted to a palette Sink at (16,12), its second Out left unlinked
//    (dropped silently, no demand). Not a Sink: a Sink with no fault belt is never blocked
//    (ruling R-13, `tick.rs:1322-1331`), so no jam forms behind it. Not a Balancer or a Factory:
//    when this leg was written the Balancer drained only its port 0 and a Factory whose JS
//    emitted twice faulted (WINDOWS 175 and 165, both fixed in phase 87). The leg keeps the Tee
//    it was written against: its one docked Out is its only branch, so under phase 87's
//    per-branch hold a full outlet still stalls the Tee (D-04) and the line packs backwards.
//    Not leg 1's Route or Handler: a belt docked to their
//    ports would make leg 5's restored DrawWire refuse (`command.rs:2365`). No leg-1 node is
//    touched and no machine is Deleted (D-21).
//
// D-14 (deviation, leg 3). Setup the leg text does not name. Leg 2 leaves the whole run at the
//    slowest pace, and an outlet slowed to that same pace makes no jam, so leg 3 first speeds
//    the run back to the fastest step (one Apply paces the run, 74 D-08), docks it into the
//    Tee, and sets the Source to Every 4 (between the fast run's 1 item per 2 ticks and the
//    slowed outlet's 1 per 20). Every 2 is never used: at 2 a released jam does not clear
//    (found in the phase 71 walkthrough). Only then is the outlet slowed, so "the line packs backwards" is
//    measured from a FLOWING state, not inherited from leg 2. The baseline is recorded first
//    (`FLOWING BASELINE`), and it reads the inlet's item COUNT as well as its head: a packed
//    run that is still moving delivers its head on every advance, so its slot 0 reads empty
//    too, and only the count says leg 2's pack has drained. `PACKS BACKWARDS` then refuses a
//    boundary already met at the first graded record (a tie), the second guard against an
//    inherited pack.
//
// D-14 (grading note, leg 3). The jam is graded as FRACTIONS over a recorded window, never as
//    "every sample": in the steady jam the Tee emits one item per outlet advance, reads
//    WORKING for a tick, and takes the inlet's head, which is empty for about 2 ticks in every
//    20. The thresholds (BACKED_UP on at least 0.85, the head held on at least 0.80, the head
//    occupied on at most 0.10 in the flowing baseline) come from the research probe's measured
//    rates. The jam's items are also read OFF THE CANVAS through plan 77-02's dot read
//    (`JAM DRAWN ON THE CANVAS`), per D-04 above. `MARK PAINTED` reads that the Tee's load
//    gauge holds any drawn instruction, which its partial levels also satisfy, so the mark's
//    FORM is read off the canvas too (plan 77-07): the gauge Graphics' instruction count and
//    drawn width go into every record (`loadGaugeFormOn`), each form keyed by the tick it was
//    drawn FROM, because the model runs about a frame ahead of the canvas. The merged full bar
//    on at least 0.85 of the steady jam's drawn ticks (`MERGED BAR ON THE CANVAS`), and on none
//    drawn from the flowing window on (`BAR BROKEN ON THE CANVAS`).
//    Those read the gauge GRAPHICS, which a hidden gauge still holds (the 77-03 refuter round,
//    refuter 1), so the band is also screenshotted: the merged bar shows in screen pixels in the
//    jam (`MARK SEEN ON SCREEN`), and no screenshot after the release shows it (`BAR SEEN BROKEN
//    ON SCREEN`). The release and the close were graded on the model alone, which an item layer
//    still drawing the packed jam passed (refuter 3), so the drawn frames from the flowing window
//    on and at the close are graded against the model of their drawn tick (`RUN DRAWN AFTER THE
//    RELEASE`, `RUN DRAWN AT THE CLOSE`), and the close's placed dots against screen pixels (`RUN
//    VISIBLE AT THE CLOSE`).
//
// D-15 (leg 3, the release). "Watch the jam clear from the front" is MEASURED before anything
//    asserts it. Plan 77-03 measured it on 12 releases and CUT it: its grader read 2 correct
//    releases wrong-way. The 77-03 refuter round found that was the GRADER, not a tie in the
//    product: both releases landed while a drip was part-way through, and the grader took that
//    drip's refill, scheduled before the release, for the release reaching the belt behind
//    (`support/jamGrading.ts`, "A DRIP IN FLIGHT AT R"). Re-measured with the refill set aside, on
//    the committed traces and on 12 fresh releases, every release graded front first, no drip in
//    a steady jam did (`PSEUDO_R ... frontFirst=0`), and a product defect (the fold stepping nodes
//    in descending id) turned the assertion red: 77-MUTATION-PROOF.md, "77-03 refuter round D-15
//    re-measurement", DECISION: ASSERT. The clause was then asserted as that order on the sim
//    clock, under a named deviation (A1) because the eye cannot see it. The maintainers overturned A1 on
//    2026-10-08 and the clause is CUT (the next entry). The leg still logs the order
//    (`RELEASE_ORDER`) and the grader's verdict on drips with no release in them (`PSEUDO_R`), and
//    asserts that the release has a witness, FRONT FREE (the Tee off BACKED_UP with the inlet's
//    head slot empty), from which the Tee never reads BACKED_UP again to the end of the sustained
//    window (`STAYS RELEASED`), that the released line thins and stays clear on a window placed
//    after the thinning measured in that run (`RELEASE SUSTAINED`) and that the board closes
//    flowing into the Sink (`ENDS FLOWING`). Measured by research and on every run, the packed line
//    visibly thins from the SOURCE end, back to front (`RELEASE_THINNING`).
//
// CUT (D-15, ruling of 2026-10-08). Leg 3's last clause, "then release and watch the jam
//    clear from the front", is CUT and asserted nowhere. The maintainers overturned named deviation A1 on
//    2026-10-08 with the ruling "cut it and carry on". Reason: on release the packed line visibly
//    thins from the Source end, and the front-first order is a sim-clock fact of about 50 ms that
//    nobody can see, so a "watch" clause cannot be graded on it. Measured on the committed release
//    trace 1 (`src/gates/fixtures/77-release-trace-1.json`), the order runs 3 ticks from the front
//    freeing to the belt behind moving:
//    RELEASE_ORDER R=2290 teeOff=2290 frontFree=2291 junction=2294 missed=2 witness=3 wrongway=0
//    and the line the eye watches thins one tile at a time from the Source end, 137 to 173 ticks
//    after the release:
//    RELEASE_THINNING 5,12=2427(R+137) 6,12=2435(R+145) 7,12=2442(R+152) 8,12=2449(R+159) 9,12=2459(R+169) 10,12=2463(R+173)
//    This engine releases a packed belt rigidly (`belt_slots.rs` `advance_slots`), so it cannot
//    clear back from the front. The clause is declared LAST, titled `CUT - leg 3 clause "clears
//    from the front": ...`, and its body throws this reason with both measured lines;
//    `src/gates/jamGrading.test.ts` `CUT REASON (maintainer ruling) ...` reproduces both from the
//    committed traces. What the eye sees on release is still asserted: the Tee's mark breaks (`BAR
//    BROKEN ON THE CANVAS`, `BAR SEEN BROKEN ON SCREEN`), the Tee stays released (`STAYS
//    RELEASED`), the line thins and stays clear (`RELEASE SUSTAINED`), the released run is drawn as
//    the model holds it (`RUN DRAWN AFTER THE RELEASE`) and the board closes flowing into the Sink
//    (`ENDS FLOWING`). Leg 3's title names what it still proves, "clears when released".
//
// D-08 (naming note, leg 4). The leg walked is the AMENDED leg 4 above. The original leg 4 also
//    resized a machine from 3x3 to 5x4; that half moved with the footprints phase to
//    SEED-261004-vfw and is not walked here.
//
// D-17 (correction, leg 4). 77 D-17 proved the Load by "the tick restarts below the pre-load
//    tick" (`09-save-load-status.spec.ts`). Research measured, and every run of this leg logs
//    (`COMP_SAVE_LOAD`), that a loaded board resumes at its SAVED tick: Ctrl+S on a flowing
//    board drains first (about 60 ticks here) and saves at the drained tick, and the Load comes
//    back a few ticks above it (measured tickAtSave=2963, drained to 3026, first tick after the
//    Load 3033). So the tick-restart test does not apply to this board. The discriminator is
//    the empty swap `newBoard` measures (an empty scene whose tick restarted below the pre-New
//    tick) followed by the whole composed topology reappearing, keyed by place: six nodes by
//    kind and anchor, three belts by cells and docks, both cables by cells (`ONLY THE LOAD
//    REBUILDS`). Nothing but the Load can put that on the empty board. Handles are re-read
//    after the Load, because the keyframe remints them.
//
// D-17 (grading note, leg 4). "With items running past the label untouched" is graded on the
//    RELOADED, running board, with no Play pressed since the Load (`RUNS UNAIDED after the
//    Load`), at steady state past the Sink's 16-item inbox (`ITEMS RUN PAST`: over the last 60
//    records the inlet beside the label changes occupancy on at least 5 and the outlet drains into
//    the Sink, R-01 d), with the label's facts and drawn box equal at the window's start and
//    end. That a label changes no item's path, tick for tick, is proved one layer down in
//    `crates/fabrico-core/tests/label_inert.rs`
//    (a label beside a Source to belt to Sink flow, belt slots and Sink effects identical with
//    and without it); this leg does not re-prove inertness, it shows the flow running past.
//    The items are also read OFF THE CANVAS (D-04 above): the recorder copies the item layer's
//    drawn frame beside each model copy, and each frame is graded against the model of the
//    tick it was DRAWN FROM (`support/itemFrames.ts`), because on these flowing belts the model
//    runs a frame or more ahead of the canvas and a same-breath read would disagree on a
//    correct build. Between the Ctrl+S and the New no render-health read is taken (the New
//    follows the save at once); it is read on both sides.
//
// D-19 (naming note, leg 5). "The cable comes back" means BOTH legs of the leg-1 drag (forward
//    and return) come back on ONE Ctrl+Z, graded by endpoints and cells. The endpoints are keyed
//    by each machine's ANCHOR CELL and port (`8,8:1 -> 12,7:0`), never by wire or node id,
//    because leg 4's Load and the Undo keyframe both remint handles (spec 28's `cellsByEnds`,
//    keyed by place instead of by handle). "In the same place, routed head-on into both prongs"
//    is the identical cell list per endpoint key, before the Disconnect and after the Undo, with
//    `expectHeadOn` passing on each leg (phase 75's claim), and since the 77-05 refuter round both
//    cables and all four prongs SEEN in screen pixels (R-05 a). "No message appears at the top of the
//    screen" is graded by the refusal region (`#fab-refusal`) latched across the Undo and the
//    status strip (`[data-fab-status-strip]`) recorded on EVERY change across the same window,
//    read only after its readout settled to idle: on this one page leg 4's Load leaves `Loaded`
//    there for 4 s, and every strip transient clears itself after 4 s, so a before-and-after
//    read could not see one shown inside the window. Leg 5 runs on the board leg 4 reloaded,
//    Deletes nothing (D-21), and sends no edit after the Ctrl+Z; it is the last walking leg.
//
// R-01 (the 77-01 refuter round, three corrections to what the walk reads).
//    (a) WHERE A CABLE IS DRAWN. Counting the drawn strokes (leg 1) and comparing them with leg 1's
//    own drawing (leg 5) both pass a wire layer that strokes every cable three cells off its
//    route. So every drawn-cable read also grades each stroke against the cells the model
//    routed that cable on (`support/cableTrace.ts` `gradeDrawnCables`: every point of the stroke
//    inside its cells widened by a quarter cell, every cell visited, one stroke per cable).
//    (b) ONE PAGE, MEASURED. "The page never reloads" was held only by the source gate, which
//    reads text, so a `location.href = '/'` inside `page.evaluate` passed it while the board,
//    which lives on the host, passed every opening check on the fresh page. The boot now leaves
//    a mark on the page's window (`PAGE_MARK`), every attach asserts it is still there, and so
//    does the last walking leg as its last check (`SAME PAGE`): a reload or a navigation leaves
//    a fresh window without it.
//    (c) THE REPLY ON THE RETURN LEG, LOSSLESS. A wire carries a pulse for about two ticks, and
//    the old read polled `wires[].pulses` only after the POST had resolved, so it went red on a
//    correct build about one run in six under load. The leg now reads the scene's reply latch
//    (`replyPulsesObserved`, counted on every applied packet, `sceneState.ts`) rising across the
//    POST, on a board holding exactly the two leg 1 wires, of which only the return leg ends at
//    the caller: the host classes a pulse REPLY only on the wire whose `to` endpoint is the
//    message's `return_addr` node (`render_packet.rs` `derive_wire_direction`), and the caller of
//    a webhook is the Route. So the latch rising on that board is the reply riding the return
//    leg, read without sampling.
//    (d) ITEMS RUN PAST, AT STEADY STATE. Leg 4 counted distinct inlet occupancy patterns over a
//    window whose start rides on the polls before it; the steady inlet repeats with two patterns,
//    so the third was only the refill after the Load, and the check went red in suite order on a
//    correct build. The inlet is now graded like the outlet, on the last 60 records: its
//    occupancy changes on at least 5 of them while items move along it, and on none while they
//    stand.
//
// R-04 (the 77-04 refuter round, two corrections to leg 4).
//    (a) THE LABEL ON SCREEN. `LABEL DRAWN` and `LABEL BACK EXACTLY` read the box Graphics'
//    instructions and the words' DOM text with Playwright's `isVisible`; a box Graphics set
//    invisible and a words overlay at opacity 0 pass both, and leg 4 stayed green on each. So the
//    label's own 12 cells are also read in SCREEN PIXELS (`labelOnScreen`, `support/canvasDots.ts`
//    `labelOnCanvas`): the Lilac stroke on all four sides, the fill at its alpha, and the words'
//    pixels, once placed (`LABEL SEEN ON SCREEN`) and once reloaded (`LABEL BACK ON SCREEN`, with
//    the words on as many pixels as before the save). The words' place is compared across the Load.
//    (b) SAVE, THEN RELOAD (naming note, leg 4, T-77-31). The leg walks Save, New, Load (the New
//    gives `ONLY THE LOAD REBUILDS` its empty board), and the New resumes the host in its own tail,
//    so that Load always reaches a Playing host. So the leg then walks the done-test's own "save,
//    reload" with nothing between: a plain Ctrl+S re-writes the board's file with no prompt
//    (SAVE-03), the board is measured running on after it (phase 90, D-08: a Save on a running
//    board carries on running), the same file is loaded, and the board must run unaided after that
//    Load. Since D-08 that Load reaches a Playing host too, so the immediate Load arm's resume from
//    a Frozen host is pinned by the host tests `a_file_load_after_a_save_drain_resumes_the_sim` and
//    `a_refused_file_load_leaves_the_sim_frozen_and_says_why` (`sim_loop.rs`), not by this leg.
//
// R-05 (the 77-05 refuter round, three corrections to how legs 1 and 5 read the cable).
//    (a) THE CABLE AND ITS PRONGS ON SCREEN. Every cable read listed the stroke instructions the
//    wire layer's cables Graphics holds (`WireLayer.cablePolylines`). That is a PLOT read: a cable
//    stroked at alpha 0 or a hidden cables Container still lists both polylines, and it never read
//    the terminals, so a renderer that dropped every prong after the Load passed too. So both legs
//    also read SCREEN PIXELS (`cablesOnScreen`, `support/canvasDots.ts` `cablesOnCanvas`): every
//    cell between the two machines must hold the cable's one on-screen colour, and a box around
//    each of the four nub anchors the electric prong, once after leg 1's drag (`TWO CABLES SEEN ON
//    SCREEN`) and three times in leg 5 (`CABLE SEEN ON SCREEN`: on the reloaded board, GONE after
//    the Disconnect, back after the Ctrl+Z).
//    (b) A PLOT READ IS NAMED ONE. Leg 5's three plot reads were titled `CABLE DRAWN ON THE CANVAS`
//    and said "read off the canvas". They are `CABLE PLOTTED` now and say what they read.
//    (c) THE WIRING IS PINNED. The source gate refuses `drawnCableSet` reading anything but the
//    plot (a model read in its place passed both tiers), counts every `expectHeadOn` as an
//    assertion, and pins leg 5's one Ctrl+Z and the strip recording `NOTHING ON TOP` grades.
//
// ===========================================================================
// WHAT THIS FILE CANNOT ASSERT, AND WHAT IT DELIBERATELY STAYS AWAY FROM.
// ===========================================================================
//
// D-18. Byte identity of the saved snapshot is not visible through `window.__fabrico`: its
// surface is plain-data scene and render reads, with no hash and no snapshot bytes. The byte
// claim lives in `crates/fabrico-command/tests/composition_save_load.rs`; this file's green
// is never evidence for it. Leg 4 proves what a user can see come back: the topology, the
// label's words, size and colour, and the drawn box.
//
// D-21. Two phase-76 defects stay deferred and the board routes around them: no leg Deletes a
// turned machine (T-76-31), and no leg edits and Deletes one machine inside a paused pass
// (T-76-30).
//
// R-05. The cable and prong reads COUNT pixels of the right colour on the right cells and around
// the right nub anchors; they do not read a prong's shape, so a glyph drawn facing the wrong way
// passes them (the 77-06 walk judges the shape by eye). They are taken with no pulse in flight,
// because a forward comet is drawn in the prongs' own colour, and only at camera scale 1 and
// device pixel ratio 1, where their floors were measured; `cablesOnScreen` throws by name at any
// other scale.
//
// ===========================================================================
// THE ORDER IS LOAD-BEARING. READ THIS BEFORE APPENDING TO THIS FILE.
// ===========================================================================
//
// The legs share a BOARD and ONE PAGE: each continues on what the previous one left standing,
// in the same page session, with no reload, as the shipped app never reloads. Under
// `mode: 'serial'` a test declared after a failing one never runs, and the live config locks
// `retries: 0`, so anything appended below the last leg is silently un-run whenever anything
// above it goes red. A leg or clause that cannot be walked honestly is CUT: declared LAST,
// titled `CUT - leg <n> ...`, and its body throws its reason (77 D-15, D-20).
// `src/gates/oneBoardAllFive.source.test.ts` holds all of this on every `npm test`: the order,
// serial mode, no skip/fixme/fail/only, a fresh board only in leg 1, no navigation in a later
// leg, render health in every leg, the required handoff before every later leg's first gesture,
// the done-test wording above, no fixed sleep, and each leg's defining assertions. The text
// cannot see everything (R-01 b above): the one page is also MEASURED, by the boot's mark.
//
// ===========================================================================
// THE SHARED PAGE KEEPS THE PROJECT'S `use` OPTIONS.
// ===========================================================================
//
// The one page every leg drives is created in `test.beforeAll` from `browser.newContext`,
// passing ONLY `baseURL` (read off `testInfo.project.use.baseURL`, the way
// `17-order-example.live.spec.ts:829-832` reaches it outside a `page` fixture) and `viewport`.
// No `use` option is dropped by that: Playwright 1.61 fills every context option of the
// project's `use` block that the call leaves out into any context created during a test or
// hook (`runBeforeCreateBrowserContext`, `frontend/node_modules/playwright/lib/index.js:129-134`),
// which is how `permissions: ['clipboard-write']` and the `Desktop Chrome` device fields reach
// this page, and it starts a trace chunk on every existing context at each test's start
// (`ArtifactsRecorder.willStartTest`, `index.js:616-621`), so `trace: 'retain-on-failure'`
// still keeps a red leg's trace. Only `viewport` is overridden, on purpose, to the shipped
// 1280 by 800 window. Passing any other key (`permissions` above all) would stop Playwright
// filling it from `use`. The boot ASSERTS the inherited clipboard permission (token
// `USE OPTIONS INHERITED`), so a Playwright upgrade that stops the fill-in fails loudly here.
//
// ===========================================================================
// SHARED-HOST NOTE: THE BOOT CLEARS A HOST PAUSE, THE ATTACH DOES NOT.
// ===========================================================================
//
// The live suite runs `workers: 1` against ONE mutable dev host, and pause is host-global. A
// spec before this one can leave the host USER-paused (its page pressed Pause and timed out
// before its `finally` pressed Play). After a user Pause, LoadDemo and New swap the board but
// stay Frozen (`crates/fabrico-host/src/sim_loop.rs`, the `!drain_from_user_pause` resume
// tails), and a fresh page cannot see it: the transport glyph boots reading `Pause`
// (`bootState.ts` `SIM_BOOTS_PLAYING`) and nothing syncs it from the host, so `ensurePlaying`
// never presses and throws. So the boot sends Pause and then Resume through the shipped
// transport button BEFORE anything else: Resume clears the recorded user pause
// (`sim_loop.rs` `ControlMsg::Resume`), and on a host that was already running the pair is a
// drain begun and cancelled. That is the boot's job alone. A later leg ASSERTS the board it
// inherits runs unaided (`expectRunningUnaided`) and never presses Play: a leg that leaves the
// board stopped must be a loud red in the leg after it, not a silent rescue.

test.describe.configure({ mode: 'serial' });

const KIND_ROUTE = 9;
const KIND_HANDLER = 10;
const ROLE_IN = 0;
const ROLE_OUT = 1;
const MEDIUM_ELECTRICAL = 1;
/** `WirePulseView.direction`: 0 = FORWARD (request out), 1 = REPLY (response home). */
const WIRE_DIR_REPLY = 1;

// ---------------------------------------------------------------------------
// THE BOARD LAYOUT. Named constants, because later legs address the SAME cells.
// ---------------------------------------------------------------------------
//
// Leg 1 keeps `25-route-and-handler.spec.ts`'s geometry block (77 D-10): the 1x1 Route at
// (8,8) and the 3x3 Handler at anchor (12,7), whose W-facing electrical In at local (0,1)
// sits opposite the Route's E-facing Out. Measured by the phase 77 research probe at camera
// scale 1, viewport 1280x800: forward cable (8,8) to (12,8), return cable round row 10.

/** The 1x1 Route: the front door a webhook arrives at. */
const ROUTE_CELL: readonly [number, number] = [8, 8];
/** The 3x3 HTTP Handler, spanning (12..14, 7..9). */
const HANDLER_CELL: readonly [number, number] = [12, 7];
/** An empty floor cell used to close the config panel (research: (2,15) failed, (2,2) holds). */
const EMPTY_CELL: readonly [number, number] = [2, 2];

/** The exact body a palette-placed HTTP Handler answers with BEFORE any edit:
 *  `fabrico_core::tick::DEFAULT_HANDLER_SOURCE` (spec 25's `HANDLER_PRESET_BODY`). */
const HANDLER_PRESET_BODY = 'hello from fabrico';
/** The body the leg types into the Handler's own panel. Not equal to, and not a substring
 *  of, the preset. */
const PANEL_BODY = 'made in the panel 77';

// Leg 2's row (77-RESEARCH.md "The measured board"): row 12, two rows below leg 1's return
// cable (row 10), so nothing of leg 1 is touched and row 11 stays empty between them.

const KIND_SOURCE = 0;
const MEDIUM_MECHANICAL = 0;
/** The 1x1 palette Source; its Out faces east onto (5,12). */
const SOURCE_CELL: readonly [number, number] = [4, 12];
/** The first belt, drawn off the Source's Out. Its Head is (7,12). */
const UP_CELLS: readonly (readonly [number, number])[] = [
  [5, 12],
  [6, 12],
  [7, 12],
];
/** The upstream belt's Head tile: the junction is read here. */
const UP_HEAD: readonly [number, number] = [7, 12];
/** The upstream Head's DOORSTEP, the empty tile it faces: the press-on-end lands here and it
 *  is the seed cell, so the second belt's Tail is this cell (74.1 D-04). */
const DOORSTEP: readonly [number, number] = [8, 12];
/** Where the second belt is drawn to. Its Head (10,12) is left FREE. */
const DOWN_END: readonly [number, number] = [10, 12];
/** A tile of each belt away from the seam, for click-to-select. */
const UP_TILE: readonly [number, number] = [6, 12];
const DOWN_TILE: readonly [number, number] = [9, 12];

/** Every cell of the run, tail to head: the cells the pack is drawn on. */
const RUN_CELLS: readonly (readonly [number, number])[] = [
  [5, 12],
  [6, 12],
  [7, 12],
  [8, 12],
  [9, 12],
  [10, 12],
];
/** The panel's sentence for a joined run of two, verbatim (`BeltConfigBody.tsx` `runPlural`,
 *  spec 24's `RUN_TWO_COPY`), pinned by exact equality. */
const RUN_TWO_COPY = 'This run is 2 belts. Apply sets the pace on all of them.';
/** The slowest `Belt pace` segment's accessible name (`BeltConfigBody.tsx` `PACE_STEPS`: 20
 *  ticks per slot is 25 px per second, and the segment's name carries the unit). */
const SLOWEST_SEGMENT = '25 px per second';
const SLOWEST_TICKS = 20;
/** The Source Timer interval in sim ticks (D-12). */
const FEED_INTERVAL = '30';
/** `fabrico_core` `SLOTS_PER_TILE`: four item slots per belt tile. */
const SLOTS_PER_TILE = 4;
/** Each run belt is three tiles, so twelve slots. */
const BELT_SLOTS = 3 * SLOTS_PER_TILE;
/** The pack boundaries graded front to back: every tile edge of the six-tile run. */
const PACK_BOUNDARIES = [4, 8, 12, 16, 20, 24] as const;
/** What `rebuildEnds` plots for one belt-to-belt collar: the ground disc's fill and the
 *  ring's stroke, two instructions (`belts.ts`, the `belt-seam` branch). */
const COLLAR_INSTRUCTIONS = 2;
/** The collar ON THE CANVAS (the 77-02 refuter round): each quadrant of the ring's annulus holds at
 *  least this many `ramp[4]` pixels. Half the smallest quadrant measured on the joined seam (16,
 *  `src/gates/canvasDots.test.ts`); the seam before the join measured 0 in every quadrant. */
const COLLAR_QUADRANT_MIN = 8;
/** The run's tiles from the HEAD back: the order the pack must fill them on the canvas. */
const RUN_HEAD_FIRST: readonly string[] = [...RUN_CELLS].reverse().map(([x, y]) => `${x},${y}`);
/** The Source Timer interval as a count of sim ticks, the number `FEED_INTERVAL` types. */
const FEED_TICKS = Number(FEED_INTERVAL);
/** The run's item slots, both belts. */
const RUN_SLOTS = 2 * BELT_SLOTS;
/**
 * How many frames the growth sampler keeps reading once the model is packed and the canvas is not
 * (plan 84-18, D-12; was 3 s): the packed run is drawn `DRAWN_STATE_FRAMES` after the page holds
 * it, and a capture taken before that is followed by one taken after, `CAPTURE_POLL_TRIES` in
 * all at `CAPTURE_FRAMES` each (an in-page capture's latency at the GPU proxy, `PACK_GROWTH_SAMPLER
 * latencyMs max`, was 4088 to 4534 ms over plan 84-18's green runs, inside the 6061 ms that set
 * `CAPTURE_FRAMES`).
 */
const GROWTH_GRACE_FRAMES = CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES;
/**
 * How many sim ticks the growth sampler waits for the model to pack at all, `PACKED SOLID`'s wait
 * (plan 84-18, D-12; was 40 s): the feed's Apply folds within `HOST_APPLY_TICKS`, the k-th of the
 * run's `RUN_SLOTS` items leaves the Source within k x `FEED_TICKS` of it, and no item travels
 * more than the run's `RUN_SLOTS` slots at `SLOWEST_TICKS` a slot, so the last one is in its slot
 * within `RUN_SLOTS x (FEED_TICKS + SLOWEST_TICKS) + HOST_APPLY_TICKS`, 1204 ticks.
 */
const GROWTH_PACK_TICKS = RUN_SLOTS * (FEED_TICKS + SLOWEST_TICKS) + HOST_APPLY_TICKS;
/** How leg 2's growth captures read the canvas in the page (plan 84-16, `support/frameCapture.ts`):
 *  `pbo` through a WebGL2 pixel-pack buffer read back on a later frame, or `sync` with a blocking
 *  `readPixels` in the callback. Chosen on measured numbers (84-EVIDENCE.md `CAPTURE_DECISION`): the
 *  synchronous read stalled the page about 380 ms per capture at the GPU proxy in the 84-15 spike,
 *  and the buffered read removed that stall (`blockMs` p90 0.1 ms) but its fence signaled 20 to 23
 *  animation frames (about 3.7 s) after the read at the proxy, above the 10 frames the plan allowed,
 *  so `sync`, its stall written down as `STALL_FINDING`. */
const GROWTH_CAPTURE_MODE: CaptureMode = 'sync';
/** A hang guard for a buffered read, counted in animation frames, never wall-clock: a read whose
 *  fence has not signaled after this many frames throws `CAPTURE NEVER READ BACK`. 30 frames is 6 s at
 *  the 5 frames a second floor (D-12). Measured at the GPU proxy (plan 84-16): `readbackFrames` max
 *  20 to 23. Unused while `GROWTH_CAPTURE_MODE` is `sync`. */
const READBACK_FRAMES_MAX = 30;

// Leg 3's cells (77-RESEARCH.md "The measured board"): the Tee closes the run's free Head at
// (10,12), its outlet runs on along row 12 to a Sink, and row 13 under the Tee stays free.

const KIND_TEE = 3;
const KIND_SINK = 7;
/** `frontend/src/protocol/kinds.ts` `state_tag.BACKED_UP`, mirrored (GATE-01: no product import). */
const STATE_BACKED_UP = 3;
/** Port sides: E = 1, W = 3 (`PortFacts.side`). */
const SIDE_E = 1;
const SIDE_W = 3;
/** The 2x2 palette Tee, over (11..12, 12..13): In on (11,12) facing W, first Out on (12,12)
 *  facing E (routing key 0), second Out on (12,13) left unlinked (an unlinked Tee output is
 *  dropped silently and adds no demand). */
const TEE_CELL: readonly [number, number] = [11, 12];
const TEE_OUT0_CELL: readonly [number, number] = [12, 12];
/** The 1x1 palette Sink at the outlet's end. Right of the 793 px panel edge at this camera, so
 *  it is placed with no panel open. */
const SINK_CELL: readonly [number, number] = [16, 12];
/** The outlet belt, Tee first Out to Sink In. */
const OUTLET_CELLS: readonly (readonly [number, number])[] = [
  [13, 12],
  [14, 12],
  [15, 12],
];
const OUTLET_TILE: readonly [number, number] = [14, 12];
/** The fastest `Belt pace` segment: 2 ticks per slot (`BeltConfigBody.tsx` `PACE_STEPS`). */
const FASTEST_SEGMENT = '250 px per second';
const FASTEST_TICKS = 2;
/** The Source Timer interval for the jam (D-14): between the fast run (1 item per 2 ticks) and
 *  the slowed outlet (1 per 20). Never 2: at 2 a released jam does not clear (found in the phase 71 walkthrough). */
const JAM_FEED_INTERVAL = '4';
/** Records graded in the flowing baseline and in the steady jam. */
const BASELINE_RECORDS = 120;
const JAM_RECORDS = 120;
/** The thresholds, from the research probe's measured rates (77-RESEARCH.md, leg 3): in the
 *  flowing baseline the inlet's head is occupied on 0%; in the steady jam the Tee reads
 *  BACKED_UP on 95% and the head is held on 90%. */
const BASELINE_HEAD_MAX = 0.1;
const JAM_BACKED_UP_MIN = 0.85;
const JAM_HEAD_HELD_MIN = 0.8;
const RELEASED_MIN = 0.95;
/** The gauge band screenshots `BAR SEEN BROKEN ON SCREEN` grades after the release. */
const BROKEN_SHOTS = 10;
/** The tries `JAM DRAWN ON THE CANVAS` is budgeted for, one clip capture each (plan 84-18): the
 *  passing proxy runs measured needed 1 try each, so `CAPTURE_POLL_TRIES`. */
const JAM_DRAWN_TRIES = CAPTURE_POLL_TRIES;
/** A flowing run at the fast pace fed every 4 ticks spaces its items two slots apart, about 6
 *  per 12-slot belt; leg 2's pack is 12. The baseline waits for the inlet to drain to at most
 *  this many and grades the baseline's mean against it (`FLOWING BASELINE`). */
const FLOWING_INLET_MAX = 8;
/** The release window's margin past the latest thinning tick: one slow outlet period. */
const SUSTAIN_MARGIN_TICKS = 20;
const SUSTAIN_WINDOW_RECORDS = 60;
const SUSTAIN_AFTER_RECORDS = 80;
/** The close: records after the outlet first holds an item in slots 0 to 2 (past the Sink's
 *  16-item inbox, `admit::MECHANICAL_INBOX_CAP`, which a stopped Sink would fill in about 64
 *  ticks at interval 4), and the last records graded. */
const CLOSE_AFTER_RECORDS = 160;
const CLOSE_WINDOW_RECORDS = 60;
/**
 * The sim ticks the release poll needs after the release (review 84 WR-03): the latest run tile's
 * thinning, then `SUSTAIN_AFTER_RECORDS` records past it (the sustained window, from
 * `SUSTAIN_MARGIN_TICKS` past it for `SUSTAIN_WINDOW_RECORDS`, lies inside them). Thinning was
 * read from `RELEASE_ORDER R=` to the sustained window's first record (its `lastRecord` less its
 * `records`, an upper bound since records can skip ticks) less the margin, over ten logged runs: 171 to 172 ticks on a desktop, 195 to 208 at the GPU proxy, 225 on the
 * evening 2026-10-13 CI run (R=5122, window from 5367). The most is used.
 */
const RELEASE_THIN_TICKS = 225;
const RELEASE_POLL_TICKS = RELEASE_THIN_TICKS + SUSTAIN_AFTER_RECORDS;
/**
 * The sim ticks the close poll needs (review 84 WR-03): an item reaching the outlet's Sink end,
 * then `CLOSE_AFTER_RECORDS`. Reaching was measured on a desktop at no more than 95 ticks (the
 * release window's last record to the close's first graded record, which also spans steps 8 and
 * 9), in line with the Sink's 16-item inbox at feed interval 4 (64) plus the outlet's 12 slots at
 * 2 ticks (24).
 */
const CLOSE_REACH_TICKS = 95;
const CLOSE_POLL_TICKS = CLOSE_REACH_TICKS + CLOSE_AFTER_RECORDS;

// Leg 4's cells (77-RESEARCH.md "Leg 4: the label round trip"): the label goes on row 13, the
// free row directly under the run (5..10,12), a label taking its cells (76 D-01). Its 6 by 2 box
// covers (5..10, 13..14): column 11 is the Tee's, so the box stops at column 10.

const KIND_LABEL = 11;
/** The label's anchor, under the run's tail. */
const LABEL_CELL: readonly [number, number] = [5, 13];
/** The words typed on it (no `.`: a `.` with the board focused is the step key). */
const LABEL_TEXT = 'Order intake';
/** Lilac, label colour byte 3, as the integer the box probe reads (`76-label-size-colour`). */
const LILAC = 0xbea2ea;
const LILAC_BYTE = 3;
/** The applied size: the default 4 by 1, `Increase width` twice and `Increase depth` once. */
const LABEL_W = 6;
const LABEL_H = 2;
/** The box's centreline inset from the cell edges, world px (`76-label-size-colour`). */
const LABEL_BOX_INSET = 4;
/** The label's 12 cells, row-major, as `x,y`. */
const LABEL_CELLS: readonly string[] = [13, 14].flatMap((y) =>
  [5, 6, 7, 8, 9, 10].map((x) => `${x},${y}`),
);
/** The same 12 cells as pairs, for the screenshot of exactly the label (`labelOnScreen`). */
const LABEL_CELL_PAIRS: readonly (readonly [number, number])[] = [13, 14].flatMap((y) =>
  [5, 6, 7, 8, 9, 10].map((x) => [x, y] as const),
);
/** How far the reloaded label's word pixels may sit from the count read before the save, as a
 *  fraction of it. Measured: the clip after the Load was byte-identical to the clip before the save
 *  on every run (the 77-04 refuter round), so the slack only absorbs a sub-pixel camera move. */
const LABEL_WORDS_BACK_SLACK = 0.1;
/** What the canvas probe reads for that box (`76-label-size-colour` `expectBoxPlotted`, copied
 *  as data): two instructions, Lilac fill at alpha 0.16, Lilac stroke, the 6 by 2 rectangle. */
const LABEL_BOX_EXPECTED = {
  instructions: 2,
  fill: { color: LILAC, alpha: 0.16 },
  stroke: { color: LILAC, alpha: 1 },
  rect: {
    x: LABEL_CELL[0] * CELL + LABEL_BOX_INSET,
    y: LABEL_CELL[1] * CELL + LABEL_BOX_INSET,
    w: LABEL_W * CELL - 2 * LABEL_BOX_INSET,
    h: LABEL_H * CELL - 2 * LABEL_BOX_INSET,
  },
} as const;
/** Records after the outlet first holds an item at its Sink end, then the last records graded
 *  (the same placement past the Sink's 16-item inbox as leg 3's close). */
const RUN_PAST_AFTER_RECORDS = 160;
const RUN_PAST_WINDOW_RECORDS = 60;
/** Records of the last `RUN_PAST_WINDOW_RECORDS` on which the inlet's occupancy changed from the
 *  record before: items moving past the label at steady state. The outlet's own "items are moving"
 *  floor (`outletSteadyViolations`, 5). Replaces a count of distinct inlet patterns over the whole
 *  window, which read the refill after the Load and went red in suite order on a correct build
 *  (R-01 d). */
const INLET_CHANGES_MIN = 5;
/** The drawn items, graded frame by frame against the model of each frame's drawn tick: at
 *  least this many frames graded, at least 3 distinct drawn sets, and the match rate measured on
 *  three runs before this assertion was committed (77-MUTATION-PROOF.md, "Plan 77-04 item frame
 *  measurement"). */
const DRAWN_ALIGNED_MIN = 30;
const DRAWN_DISTINCT_MIN = 3;
const DRAWN_MATCH_MIN = 0.95;
/** Leg 3's released run, fed every 4 ticks at 2 ticks per slot, holds an item every 2 slots and
 *  moves a slot every 2 ticks, so a moving run draws exactly 2 dot sets in turn (measured: 2 on
 *  the first run of the 77-03 refuter round, 68 of 68 frames matching the model). A frozen item
 *  layer draws 1 and aligns no frame at all. */
const RUN_DISTINCT_MIN = 2;

/**
 * How far the drawn frames may trail a window, for leg 3's drawn-run grades (the 77-03 refuter
 * round). A grade that counts each drawn tick once passes a layer that froze half way through the
 * window, on the frames it drew before freezing (bite BR03-3c2). So the latest drawn tick must be
 * within `DRAWN_TRAIL_MAX` ticks of the window's last record, and the distinct drawn ticks must
 * number at least `DRAWN_COVER_MIN` of the window's records. Measured on two correct runs: the
 * latest frame 0 or 1 tick behind the last record, and 0.83 to 0.98 of the records drawn (the
 * renderer sometimes draws two ticks in one frame); the frozen close drew 76 frames over about 185
 * records, 0.41.
 *
 * THE COVER IS OF THE FRAMES THE PAGE DREW (plan 84-11). The floor counted the records, one per sim
 * tick the page saw, so it measured the machine's frame rate against the sim's: pinned to two cores
 * a correct run drew 42 frames over 84 records (0.50), and the leg went red with every frame
 * matching the model. A layer can draw at most one new tick per animation frame, so the floor is
 * now of the frames on which the page had a new tick to draw (`frameTicksDuring`), or of the
 * records where those are more: on a desktop that is the records, as before, and on a slow machine
 * the frames it drew. A layer frozen part way still draws on fewer of them.
 */
const DRAWN_TRAIL_MAX = 8;
/**
 * THE TRAIL IS ALSO OF THE FRAMES THE PAGE DREW (plan 84-12). `DRAWN_TRAIL_MAX` counts sim ticks,
 * and between two of the page's frames the records go on at the sim's rate, so on a machine
 * drawing a frame every eight ticks a correct layer trailed the window's last record by more than
 * eight whenever the recorder was read late in a frame: the early 2026-10-13 CI run drew 47 frames over 368
 * records (7.8 ticks a frame) and read the latest drawn tick 11 behind, with every graded frame
 * matching. So the drawn frames are current while they trail by at most `DRAWN_TRAIL_MAX` ticks OR
 * by at most this many of the page's frames with a new tick, whichever is looser: on a desktop the
 * ticks, as before, and on a slow machine the frames (one the recorder may miss, one in flight). A
 * layer frozen part way still trails by the frames drawn after it froze (`drawnCurrent`).
 */
const DRAWN_TRAIL_FRAMES = 2;
const DRAWN_COVER_MIN = 0.6;
/**
 * The release window is recorded until the page has drawn this many frames with a new tick in it
 * beyond `DRAWN_ALIGNED_MIN` (plan 84-11). The window is a count of sim records (the sustained
 * window and the records after it), and a machine drawing a frame for every two to five of them
 * (pinned to two cores: 45 page frames over 82 records) draws fewer than `DRAWN_ALIGNED_MIN` in it,
 * so the grade would measure the frame rate. A frame whose tick the recorder missed is not graded
 * (0 to 7 a window, measured), hence the headroom.
 */
const DRAWN_FRAMES_HEADROOM = 10;

/**
 * The page's animation frames on which the scene held a NEW sim tick, from `startFrameTicks` on: the
 * tick each one held, in order (plan 84-11). An item layer that draws every frame draws one new tick
 * on each of them, so they are what its drawn frames are counted against, at any frame rate.
 */
async function startFrameTicks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabrico?: { scene(): { tick: number } };
      __fabFrameTicks?: { ticks: number[]; live: boolean };
    };
    if (!w.__fabrico) throw new Error('window.__fabrico not installed');
    if (w.__fabFrameTicks) w.__fabFrameTicks.live = false;
    const rec = { ticks: [] as number[], live: true };
    w.__fabFrameTicks = rec;
    let last = Number.NaN;
    const step = (): void => {
      if (!rec.live) return;
      const t = w.__fabrico!.scene().tick;
      if (t !== last) {
        rec.ticks.push(t);
        last = t;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** The tick of each frame that held a new one so far, without stopping `startFrameTicks`. */
async function readFrameTicks(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const rec = (window as unknown as { __fabFrameTicks?: { ticks: number[] } }).__fabFrameTicks;
    if (!rec) throw new Error('frame ticks not started');
    return [...rec.ticks];
  });
}

/** Stop `startFrameTicks` and return the tick of each frame that held a new one. */
async function stopFrameTicks(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __fabFrameTicks?: { ticks: number[]; live: boolean } };
    const rec = w.__fabFrameTicks;
    if (!rec) throw new Error('frame ticks not started');
    rec.live = false;
    w.__fabFrameTicks = undefined;
    return rec.ticks;
  });
}

/** How many of `frameTicks` fall in the window `[from, to]` of sim ticks. */
function frameTicksDuring(frameTicks: readonly number[], from: number, to: number): number {
  return frameTicks.filter((t) => t >= from && t <= to).length;
}

/** The coverage of a window's drawn frames: its records, the latest drawn tick, the last record. */
function drawnCoverage(records: readonly TickRecord[]): { records: number; lastRecord: number; lastDrawn: number } {
  let lastDrawn = -1;
  for (const r of records) {
    const t = r.d?.drawnAtTick;
    if (typeof t === 'number' && t > lastDrawn) lastDrawn = t;
  }
  return { records: records.length, lastRecord: records[records.length - 1]?.t ?? -1, lastDrawn };
}

/** The page's frames with a new tick after a window's latest drawn tick, up to its last record. */
function framesAfterDrawn(cover: { lastRecord: number; lastDrawn: number }, frameTicks: readonly number[]): number {
  return frameTicks.filter((t) => t > cover.lastDrawn && t <= cover.lastRecord).length;
}

/** Whether a window's drawn frames are current: within `DRAWN_TRAIL_MAX` ticks or `DRAWN_TRAIL_FRAMES` frames. */
function drawnCurrent(cover: { lastRecord: number; lastDrawn: number }, frameTicks: readonly number[]): boolean {
  return cover.lastDrawn >= cover.lastRecord - DRAWN_TRAIL_MAX || framesAfterDrawn(cover, frameTicks) <= DRAWN_TRAIL_FRAMES;
}

// ---------------------------------------------------------------------------
// THE SHARED BOARD STATE. The composition, expressed as data.
// ---------------------------------------------------------------------------
//
// Leg 1 populates it and later legs READ it through `required`. Every field is optional at
// rest, so a leg run without its predecessor fails NAMING the predecessor rather than by an
// undefined dereference deeper in.
interface WalkBoard {
  /** Leg 1: the palette-placed Route's handle (re-read after any Load or Undo keyframe). */
  routeId?: number;
  /** Leg 1: the palette-placed HTTP Handler's handle. */
  handlerId?: number;
  /** Leg 1: the Route's POST URL, read off its panel and matched to the host bridge. */
  endpointUrl?: string;
  /** Leg 1: both cables' routed cells, keyed by ANCHOR-CELL endpoints
   *  (`8,8:1 -> 12,7:0`), never by wire id, because a Load or an Undo keyframe remints ids. */
  leg1CableCells?: Record<string, [number, number][]>;
  /** Leg 1: both cables as DRAWN, read off the wire layer's cables Graphics (`drawnCableSet`),
   *  so leg 5 can see the reloaded board draw them where leg 1 drew them (D-04). */
  leg1DrawnCables?: string[];
  /** Leg 2: the palette Source feeding the run. */
  sourceId?: number;
  /** Leg 2: the belt drawn off the Source (cells (5..7,12)). */
  upstreamBeltId?: number;
  /** Leg 2: the belt drawn on from the upstream Head's doorstep (cells (8..10,12)). */
  downstreamBeltId?: number;
  /** Leg 3: the palette Tee the run's Head docks into (anchor (11,12)). Written by leg 3. */
  teeId?: number;
  /** Leg 3: the palette Sink at the outlet's end ((16,12)). Written by leg 3. */
  sinkId?: number;
  /** Leg 3: the outlet belt, Tee first Out to Sink In (cells (13..15,12)). Written by leg 3. */
  outletBeltId?: number;
  /** Leg 3: the Tee's anchor cell. Written by leg 3. */
  teeAnchor?: [number, number];
  /** Leg 3: the outlet's dock set keyed by each docked node's ANCHOR (`Head@16,12:0`), so it
   *  survives a keyframe that remints handles. Written by leg 3. */
  outletDocks?: string[];
  /** Leg 4: the `.fab` file the composed board was saved to and loaded back from. */
  savePath?: string;
  /** Leg 4: the label's handle AFTER the Load (the keyframe remints handles). From leg 4 on,
   *  every id field above is the post-load handle too, re-read by leg 4 after the Load. */
  labelId?: number;
}

const board: WalkBoard = {};

/** Read a field leg N depends on, naming the leg that should have set it
 *  (`24-one-board-all-six.spec.ts`, `required`). */
function required<K extends keyof WalkBoard>(key: K, setBy: string): NonNullable<WalkBoard[K]> {
  const value = board[key];
  expect(
    value,
    `${setBy} recorded \`${String(key)}\` on the shared board - if this is undefined, ` +
      `${setBy} did not run, and this file's legs are meant to run in order on ONE board`,
  ).toBeDefined();
  return value as NonNullable<WalkBoard[K]>;
}

// ---------------------------------------------------------------------------
// THE ONE PAGE every leg drives.
// ---------------------------------------------------------------------------

let sharedContext: BrowserContext | undefined;
let theSharedPage: Page | undefined;

test.beforeAll(async ({ browser }, testInfo) => {
  sharedContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 1280, height: 800 },
  });
  theSharedPage = await sharedContext.newPage();
});

/** The mark the boot leaves on the shared page's window (R-01 b). A reload or a navigation gives
 *  the page a fresh window without it, so `expectSamePage` reading it back proves the one page
 *  survived. Unique per run, so a mark left by an earlier run can never be read as this one. */
const PAGE_MARK = `comp-walk-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The page `test.beforeAll` created. Throws a named Error when it is missing, so a leg run
 *  without the hook fails saying so rather than on an undefined page. */
function sharedPage(): Page {
  if (theSharedPage === undefined) {
    throw new Error(
      'the shared page was never created: test.beforeAll did not run, and every leg drives the one page it opens',
    );
  }
  return theSharedPage;
}

// RENDER HEALTH AROUND EVERY TEST of the walk, the CUT declaration included (plan 85-08, THE
// RENDER-HEALTH COUNT; fabrico-model-oracle-blindspot). Each walking leg already watches its own
// page errors and asserts the loop alive at its own checkpoints; these hooks add one watcher
// installed before every test and one liveness read after it, so the declared CUT, whose body
// must stay a single throw (the source audit's R4), is bracketed by a real render-health read
// on the shared page too.
let healthErrs: ReturnType<typeof watchPageErrors> | undefined;

test.beforeEach(async () => {
  healthErrs = watchPageErrors(sharedPage());
});

test.afterEach(async () => {
  await expectRenderLoopAlive(sharedPage(), 'after the test, on the shared page');
  healthErrs?.assertNone('during the test, on the shared page');
});

// ---------------------------------------------------------------------------
// Spec-local helpers.
// ---------------------------------------------------------------------------

/** One recorded HTTP exchange (`25-route-and-handler.spec.ts`, `Reading`). */
interface Reading {
  label: string;
  url: string;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** POST a JSON body and record the answer verbatim. COPIED from
 *  `25-route-and-handler.spec.ts` (`post`), where it is spec-local. `timeoutMs` is the
 *  client-side bound, so a socket the host parks becomes a recorded reading. */
async function post(
  page: Page,
  label: string,
  url: string,
  data: string,
  timeoutMs = 20_000,
): Promise<Reading> {
  const resp = await page.request.post(url, {
    data,
    headers: { 'content-type': 'application/json' },
    timeout: timeoutMs,
    failOnStatusCode: false,
  });
  const reading: Reading = {
    label,
    url,
    status: resp.status(),
    body: await resp.text(),
    headers: resp.headers(),
  };
  console.log(`COMP_READING ${JSON.stringify(reading)}`);
  return reading;
}

/** The transport button. Icon-only: its accessible name is its `aria-label`, `Pause` while
 *  the page believes the sim runs and `Play` while it believes it is paused. */
function transportOf(page: Page) {
  return page.getByRole('button', { name: /^(Play|Pause)$/ });
}

/**
 * Assert the board runs WITHOUT HELP: the transport reads `Pause` and the tick advances past
 * the tick read on entry, with nothing pressed. Both reads, because a host held by something the
 * page is not told about stops ticking while the button STILL reads `Pause` (before phase 90 a
 * Ctrl+S drain did exactly that, FAIL-04).
 */
async function expectRunningUnaided(page: Page, context: string): Promise<void> {
  const label = await transportOf(page).getAttribute('aria-label');
  expect(
    label,
    `RUNS UNAIDED ${context}: the transport offered ${String(label)}, so the board was left paused`,
  ).toBe('Pause');
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick, {
    timeout: 5_000,
    message: `RUNS UNAIDED ${context}: the tick stayed at ${t0} for 5 s with nothing pressed`,
  }).toBeGreaterThan(t0);
}

/**
 * Clear any pause the host carries from an earlier spec, BOOT ONLY (see the shared-host note
 * in the header). Sends Pause then Resume through the shipped transport button, reading the
 * glyph flip after each press, then requires the tick to advance.
 */
async function clearHostPause(page: Page): Promise<void> {
  const btn = transportOf(page);
  if ((await btn.getAttribute('aria-label')) === 'Pause') {
    await btn.click();
    await expect(
      btn,
      'HOST PAUSE CLEARED: the first press sent Pause and the glyph now offers Play',
    ).toHaveAttribute('aria-label', 'Play');
  }
  await btn.click();
  await expect(
    btn,
    'HOST PAUSE CLEARED: the second press sent Resume and the glyph now offers Pause',
  ).toHaveAttribute('aria-label', 'Pause');
  const t0 = (await readScene(page)).tick;
  await pollScene(page, (s) => s.tick, {
    timeout: 5_000,
    message: `HOST PAUSE CLEARED: after Pause then Resume the host ticks again (tick was ${t0})`,
  }).toBeGreaterThan(t0);
}

/**
 * Record where the shared page's camera sits at the start of a leg, and that no right-docked
 * panel covers the board. Every leg keeps leg 1's camera (the page never reloads, and the
 * boot fit is fire-once per mount), so the centre is logged once per leg as a measurement a
 * reader can compare across legs, and a placement right of the panel edge is never made with
 * a panel open.
 */
async function recordCamera(page: Page, leg: string): Promise<void> {
  const cam = await cameraOf(page);
  const vp = page.viewportSize();
  const w = vp?.width ?? 0;
  const h = vp?.height ?? 0;
  const cx = (w / 2 - cam.x) / cam.scale / CELL;
  const cy = (h / 2 - cam.y) / cam.scale / CELL;
  console.log(
    `COMP_CAMERA ${leg} scale=${cam.scale} pan=(${cam.x.toFixed(1)},${cam.y.toFixed(1)}) ` +
      `viewport=${w}x${h} centre_cell=(${cx.toFixed(2)},${cy.toFixed(2)})`,
  );
  await expect(
    page.locator('#fab-config-heading'),
    `NO PANEL OVER THE BOARD at the start of ${leg}: a right-docked config panel would take clicks meant for the board`,
  ).toHaveCount(0);
}

/**
 * Assert the shared page is the one the boot opened (R-01 b): its window still holds the boot's
 * `PAGE_MARK`. A reload, `location.href = ...` or any navigation hands the page a fresh window,
 * and the board, which lives on the host, would pass every opening check on it; this does not.
 */
async function expectSamePage(page: Page, context: string): Promise<void> {
  const mark = await page.evaluate(
    () => (window as unknown as { __fabCompWalkPage?: string }).__fabCompWalkPage ?? null,
  );
  expect(
    mark,
    `SAME PAGE ${context}: the shared page still holds the mark the boot left on its window, so nothing reloaded or navigated it since the boot`,
  ).toBe(PAGE_MARK);
}

/**
 * The mandatory preamble, LEG 1 ONLY. The watcher is installed BEFORE the spec's only
 * navigation; then the inherited `use` options are asserted; then any host pause is cleared;
 * then the host is reset to the demo (LoadDemo resumes a host the user did not pause) and wiped
 * with New, so "booted empty" is a measurement taken by leg 1 and not a description of intent.
 */
async function bootOnEmptyBoard(page: Page): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await page.goto('/');
  await waitForAppReady(page);
  await page.evaluate((mark) => {
    (window as unknown as { __fabCompWalkPage?: string }).__fabCompWalkPage = mark;
  }, PAGE_MARK);
  const clipboard = await page.evaluate(async () => {
    const status = await navigator.permissions.query({
      name: 'clipboard-write' as PermissionName,
    });
    return status.state;
  });
  expect(
    clipboard,
    'USE OPTIONS INHERITED: the shared context carries the project\'s clipboard-write permission',
  ).toBe('granted');
  await clearHostPause(page);
  await resetToDemo(page, DEMO_NODE_COUNT);
  await newBoard(page);
  await ensurePlaying(page);
  await waitForCameraSettle(page);
  await resetZoomToActualSize(page);
  await recordCamera(page, 'leg 1');
  return errs;
}

/**
 * Attach a LATER leg to the board the previous leg left, on the same page.
 *
 * It ASSERTS, it does not rescue. No navigation, no reload, no reset and no New: that absence
 * IS the composition. And before anything else it requires the board to be running without
 * help, so a leg that left the host paused or frozen is a loud red here instead of being
 * Play-pressed by the test, and that the page is still the one the boot opened (R-01 b).
 * `ensurePlaying` follows only so "ensures Playing first" (D-19) holds literally; on a running
 * board it presses nothing. Nothing may press anything before `expectRunningUnaided` here
 * (source gate R6).
 */
async function attachToRunningBoard(
  page: Page,
  leg: string,
): Promise<ReturnType<typeof watchPageErrors>> {
  const errs = watchPageErrors(page);
  await expectRunningUnaided(page, 'the board the previous leg left');
  await expectSamePage(page, `at the start of ${leg}`);
  await ensurePlaying(page);
  await waitForCameraSettle(page);
  await resetZoomToActualSize(page);
  await recordCamera(page, leg);
  return errs;
}

/** A wire's identity by its endpoints' handles and ports, the key a count cannot replace. */
function wireKey(w: { from: { node: number; port: number }; to: { node: number; port: number } }): string {
  return `${w.from.node}:${w.from.port}->${w.to.node}:${w.to.port}`;
}

/** The same identity keyed by each end's ANCHOR CELL instead of its handle: survives a
 *  keyframe that remints handles. */
function anchorKey(scene: SceneFacts, w: WireFacts): string {
  const end = (e: { node: number; port: number }): string => {
    const n = scene.nodes.find((x) => x.id === e.node);
    if (n === undefined) return `?${e.node}:${e.port}`;
    const ax = Math.min(...n.cells.map((c) => c[0]));
    const ay = Math.min(...n.cells.map((c) => c[1]));
    return `${ax},${ay}:${e.port}`;
  };
  return `${end(w.from)} -> ${end(w.to)}`;
}

/** The node the scene holds at a cell anchor, as a plain {kind, anchor} reading. */
function placedReading(scene: SceneFacts): { kind: number; anchor: string }[] {
  return scene.nodes
    .map((n) => ({
      kind: n.kind,
      anchor: `${Math.min(...n.cells.map((c) => c[0]))},${Math.min(...n.cells.map((c) => c[1]))}`,
    }))
    .sort((a, b) => a.kind - b.kind);
}

/** The belt that covers a cell, or undefined. */
function beltAt(scene: SceneFacts, cell: readonly [number, number]) {
  return scene.belts.find((b) => b.tiles.some((t) => t.cell_x === cell[0] && t.cell_y === cell[1]));
}

/**
 * The leg 2 junction read from BOTH sides and resolved BY CELL
 * (`74-belt-join-press-on-end.live.spec.ts`, `junction`, on this leg's cells): `'1/1'` is
 * joined (the upstream Head names the downstream, the downstream Tail names the upstream),
 * `'0/0'` is two abutting runs, `'MISSING'` is fewer than two belts.
 */
function junction(scene: SceneFacts): string {
  const up = beltAt(scene, UP_HEAD);
  const down = beltAt(scene, DOORSTEP);
  if (!up || !down || up.id === down.id) return 'MISSING';
  const a = (up.docks ?? []).filter((d) => d.end === 'Head' && d.node === down.id).length;
  const b = (down.docks ?? []).filter((d) => d.end === 'Tail' && d.node === up.id).length;
  return `${a}/${b}`;
}

/** Select the belt covering `cell` with a real click and wait for the panel's Belt arm. */
async function selectBeltAt(page: Page, cell: readonly [number, number]): Promise<number> {
  const belt = beltAt(await readScene(page), cell);
  expect(belt, `a belt really occupies (${cell[0]},${cell[1]})`).toBeTruthy();
  const at = await screenCellCentre(page, cell[0], cell[1]);
  await clickAt(page, at.x, at.y);
  await expect(
    page.locator('#fab-belt-config'),
    `clicking (${cell[0]},${cell[1]}) selected a belt, so the panel's Belt arm is open on it`,
  ).toBeVisible({ timeout: 15_000 });
  return (belt as SceneFacts['belts'][number]).id;
}

/** The count of contiguous occupied slots from slot 0, the head end. */
function prefix(occupiedSlots: readonly number[]): number {
  let n = 0;
  while (n < occupiedSlots.length && occupiedSlots[n] === n) n++;
  return n;
}

/** The run's packed stretch, front to back: the downstream prefix, plus the upstream prefix
 *  once the downstream is solid. */
function packedRun(down: readonly number[], up: readonly number[]): number {
  const d = prefix(down);
  return d + (d === BELT_SLOTS ? prefix(up) : 0);
}

/**
 * The MODEL's items per run cell, keyed `x,y`, every run cell present (0 when empty). A belt
 * with T tiles carries 4T slots, slot 0 at the head; counted from the tail, occupied slot s
 * lies in tile `floor((4T - 1 - s) / 4)` (`frontend/src/render/interp.ts` `slotArcLength`,
 * the `fromTail` arithmetic). The scene lists a belt's tiles TAIL FIRST, which leg 2 reads
 * once before it relies on it (`TILES LIST TAIL FIRST`).
 */
function modelItemsPerCell(scene: SceneFacts, beltIds: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [x, y] of RUN_CELLS) out[`${x},${y}`] = 0;
  for (const id of beltIds) {
    const b = scene.belts.find((x) => x.id === id);
    if (b === undefined) continue;
    const slots = b.tiles.length * SLOTS_PER_TILE;
    for (const s of b.occupiedSlots) {
      const tile = b.tiles[Math.floor((slots - 1 - s) / SLOTS_PER_TILE)];
      if (tile === undefined) continue;
      const key = `${tile.cell_x},${tile.cell_y}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** One recorded belt by id, or undefined. */
function recordedBelt(r: TickRecord, id: number): TickRecord['belts'][number] | undefined {
  return r.belts.find((b) => b[0] === id);
}

/** A belt's dock set as sorted `End@node:port` strings (the settle key, never a belt count). */
function dockSet(belt: SceneFacts['belts'][number] | undefined): string[] {
  return (belt?.docks ?? []).map((d) => `${d.end}@${d.node}:${d.port}`).sort();
}

/** The same dock set keyed by each docked node's ANCHOR cell, which survives a remint. */
function dockSetByAnchor(scene: SceneFacts, belt: SceneFacts['belts'][number] | undefined): string[] {
  return (belt?.docks ?? [])
    .map((d) => {
      const n = scene.nodes.find((x) => x.id === d.node);
      const at = n === undefined ? `?${d.node}` : `${Math.min(...n.cells.map((c) => c[0]))},${Math.min(...n.cells.map((c) => c[1]))}`;
      return `${d.end}@${at}:${d.port}`;
    })
    .sort();
}

/** The run's two paces, by handle. */
function runPace(s: SceneFacts, upId: number, downId: number): { up?: number; down?: number } {
  return {
    up: s.belts.find((b) => b.id === upId)?.ticksPerSlot,
    down: s.belts.find((b) => b.id === downId)?.ticksPerSlot,
  };
}

/** A recorded node's state byte, or undefined. */
function recordedState(r: TickRecord, id: number): number | undefined {
  return r.nodes.find((n) => n[0] === id)?.[2];
}

/** A recording cut down to the four leg 3 grades, for the trace files. */
function trimToJam(records: readonly TickRecord[], ids: JamIds): JamRecord[] {
  const belts = [ids.inletId, ids.upstreamId, ids.outletId];
  return records.map((r) => ({
    t: r.t,
    nodes: r.nodes.filter((n) => n[0] === ids.teeId),
    belts: r.belts.filter((b) => belts.includes(b[0])),
    ...(r.g === undefined ? {} : { g: r.g.filter((f) => f[0] === ids.teeId) }),
  }));
}

/**
 * The lag between the model and the canvas over a recording (plan 77-07): for every record that
 * carries a drawn form for `id`, the record's tick minus the tick the form was drawn FROM.
 */
function gaugeLag(records: readonly TickRecord[], id: number): { max: number; median: number; records: number } {
  const lags = records
    .map((r) => r.g?.find((f) => f[0] === id)?.[1])
    .map((f, i) => (f == null ? null : records[i].t - f.drawnAtTick))
    .filter((x): x is number => x !== null)
    .sort((x, y) => x - y);
  return {
    max: lags.length === 0 ? -1 : lags[lags.length - 1],
    median: lags.length === 0 ? -1 : lags[Math.floor(lags.length / 2)],
    records: lags.length,
  };
}

/** A node's anchor cell as `x,y`. */
function anchorText(n: SceneFacts['nodes'][number]): string {
  return `${Math.min(...n.cells.map((c) => c[0]))},${Math.min(...n.cells.map((c) => c[1]))}`;
}

/**
 * What a belt end docks, named by PLACE so it survives a keyframe that remints handles: a
 * dock's `node` is a machine handle for a machine dock and the other belt's handle for a
 * belt-to-belt dock, and the two handle spaces can collide, so the target is the one whose cells
 * touch this end's tile (`node@<anchor>:<port>` or `belt@<tail cell>:<port>`).
 */
function dockByPlace(scene: SceneFacts, belt: SceneFacts['belts'][number], d: { end: string; node: number; port: number }): string {
  const end = d.end === 'Head' ? belt.tiles[belt.tiles.length - 1] : belt.tiles[0];
  const touches = (cells: readonly (readonly [number, number])[]): boolean =>
    end !== undefined &&
    cells.some(([x, y]) => Math.abs(x - end.cell_x) + Math.abs(y - end.cell_y) === 1);
  const node = scene.nodes.find((n) => n.id === d.node && touches(n.cells));
  const other = scene.belts.find(
    (b) => b.id === d.node && b.id !== belt.id && touches(b.tiles.map((t) => [t.cell_x, t.cell_y])),
  );
  if (node !== undefined && other !== undefined) return `${d.end}@ambiguous${d.node}:${d.port}`;
  if (node !== undefined) return `${d.end}@node${anchorText(node)}:${d.port}`;
  if (other !== undefined) {
    return `${d.end}@belt${other.tiles[0].cell_x},${other.tiles[0].cell_y}:${d.port}`;
  }
  return `${d.end}@?${d.node}:${d.port}`;
}

/**
 * THE COMPOSED TOPOLOGY, keyed by place and never by handle: every node by kind and anchor, every
 * belt by its covered cells (tail first) with its dock set by place, and every cable by its
 * endpoints' anchors with its routed cells. What a Load must rebuild from an empty board.
 */
function composedTopology(scene: SceneFacts): {
  nodes: { kind: number; anchor: string }[];
  belts: Record<string, string[]>;
  cables: Record<string, [number, number][]>;
} {
  const belts: Record<string, string[]> = {};
  for (const b of scene.belts) {
    belts[b.tiles.map((t) => `${t.cell_x},${t.cell_y}`).join(' ')] = (b.docks ?? [])
      .map((d) => dockByPlace(scene, b, d))
      .sort();
  }
  const cables: Record<string, [number, number][]> = {};
  for (const w of scene.wires) cables[anchorKey(scene, w)] = w.path.map((c) => [c.cell_x, c.cell_y]);
  return {
    nodes: placedReading(scene).sort((a, b) => a.kind - b.kind || a.anchor.localeCompare(b.anchor)),
    belts,
    cables,
  };
}

/** The one label node of a scene, as the facts leg 4 compares: anchor, cells and words. */
function labelFacts(scene: SceneFacts): { anchor: string; cells: string[]; label: unknown }[] {
  return scene.nodes
    .filter((n) => n.kind === KIND_LABEL)
    .map((n) => ({
      anchor: anchorText(n),
      cells: [...n.cells].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([x, y]) => `${x},${y}`),
      label: n.label,
    }));
}

/** The ids leg 4 re-reads by place after the Load. */
function idsByPlace(scene: SceneFacts): Record<string, number | undefined> {
  return {
    route: nodeAtAnchor(scene, ROUTE_CELL[0], ROUTE_CELL[1])?.id,
    handler: nodeAtAnchor(scene, HANDLER_CELL[0], HANDLER_CELL[1])?.id,
    source: nodeAtAnchor(scene, SOURCE_CELL[0], SOURCE_CELL[1])?.id,
    tee: nodeAtAnchor(scene, TEE_CELL[0], TEE_CELL[1])?.id,
    sink: nodeAtAnchor(scene, SINK_CELL[0], SINK_CELL[1])?.id,
    label: nodeAtAnchor(scene, LABEL_CELL[0], LABEL_CELL[1])?.id,
    upstream: beltAt(scene, UP_TILE)?.id,
    inlet: beltAt(scene, DOWN_TILE)?.id,
    outlet: beltAt(scene, OUTLET_TILE)?.id,
  };
}

/** The Route's electrical Out row in its Ports section: the control spec 25 and spec 28 press.
 *  On leg 1's pair the Route also shows an In row, because the return cable docks the Route's
 *  In; this one Disconnect removes BOTH legs (`25-route-and-handler.spec.ts`). */
const DISCONNECT_CONTROL_NAME = 'Disconnect Output - Wire';

/** The status strip's readout, the FIRST `role="status"` live region in the strip
 *  (`Toolbar.tsx`: the readout precedes the `Unsaved` badge in DOM order, so `.first()` finds
 *  it; it holds the empty string at idle, `STATUS_COPY.idle`). */
const STRIP_READOUT = '[data-fab-status-strip] [role="status"]';

/** How long the strip may take to settle to idle: a transient clears after
 *  `STATUS_AUTOCLEAR_MS` = 4000 (`App.tsx`). */
const STRIP_SETTLE_MS = 8_000;

/** How far the tick must run past the restore inside the recorded window, so a sentence the
 *  undo path shows a moment after the cable lands is still inside it. */
const PAST_RESTORE_TICKS = 60;

/**
 * The cables on the board as sorted ANCHOR-keyed endpoint keys (`8,8:1 -> 12,7:0`), the id
 * dropped (`28-undo-restores-the-cable.spec.ts`, `cableEnds`, keyed by place because the Load
 * and the Undo keyframe remint handles).
 */
function cableKeysByPlace(scene: SceneFacts): string[] {
  return scene.wires.map((w) => anchorKey(scene, w)).sort((a, b) => a.localeCompare(b));
}

/**
 * The resting cables AS PLOTTED (D-04): the wire layer's plotted polylines
 * (`window.__fabrico.cablePolylines`, the re-route mark excluded by colour), each rounded to
 * half a world pixel and written `x,y x,y ...`, sorted. A PLOT read: it sees what the layer
 * stroked and where, not whether a user can see it (R-05 a; `cablesOnScreen` reads that). The
 * source gate refuses any other read in this body (R-05 c). Read it with `expect.poll` and the
 * expected set, never once straight after a model poll: the renderer draws a frame after the
 * packet lands.
 */
async function drawnCableSet(page: Page): Promise<string[]> {
  const half = (v: number): number => Math.round(v * 2) / 2;
  return (await cablePolylines(page))
    .map((pl) => pl.map((p) => `${half(p.x)},${half(p.y)}`).join(' '))
    .sort((a, b) => a.localeCompare(b));
}

/** Each cable's routed cells keyed by its anchor-keyed endpoints (spec 28's `cellsByEnds`). */
function cableCellsByPlace(scene: SceneFacts): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  for (const w of scene.wires) out[anchorKey(scene, w)] = w.path.map((c) => [c.cell_x, c.cell_y]);
  return out;
}

/** The grade a correct drawing of leg 1's pair reads: two strokes, each on its own cable's cells. */
const PAIR_DRAWN_ON_ITS_CELLS: CableTraceGrade = { drawn: 2, model: 2, unmatchedModel: [], strayDrawn: 0 };

/**
 * WHERE the cables were drawn (R-01 a): the wire layer's resting strokes graded against the
 * model's routed cells (`support/cableTrace.ts`), each cable keyed by its anchor-keyed endpoints.
 * Poll it with the expected grade, never read it once: the renderer draws a frame after the
 * packet lands, so a read straight after a change can pair a new model with an old drawing.
 */
async function drawnCableGrade(page: Page): Promise<CableTraceGrade> {
  const drawn = await cablePolylines(page);
  const scene = await readScene(page);
  const model: ModelCable[] = scene.wires.map((w) => ({
    key: anchorKey(scene, w),
    cells: w.path.map((c) => [c.cell_x, c.cell_y] as const),
  }));
  return gradeDrawnCables(drawn, model, CELL);
}

/**
 * The cables a scene holds, as the screen read takes them (R-05 a): each wire's anchor-keyed
 * endpoints, its routed cells, and the nub anchor of the port at each end (`nubAnchor`, the one
 * place a nub's world position is computed), sorted by key.
 */
function cablesToRead(scene: SceneFacts): CableToRead[] {
  const nubOf = (end: { node: number; port: number }): { x: number; y: number } => {
    const port = scene.nodes.find((n) => n.id === end.node)?.ports.find((q) => q.index === end.port);
    if (port === undefined) throw new Error(`cablesToRead: node ${end.node} carries no port ${end.port}`);
    return nubAnchor(port.cell_x, port.cell_y, port.side);
  };
  return scene.wires
    .map((w) => ({
      key: anchorKey(scene, w),
      cells: w.path.map((c) => [c.cell_x, c.cell_y] as const),
      ends: [nubOf(w.from), nubOf(w.to)] as const,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The cables AS THE SCREEN SHOWS THEM (R-05 a): one screenshot of the box around every cell of
 * `cables` plus one cell, read for the cable's on-screen colour on each run cell and the electric
 * prong around each nub anchor (`support/canvasDots.ts` `cablesOnCanvas`). `covered` lists the run
 * cells and nub anchors whose screen point is not the canvas (chrome over the board), keyed
 * `cell x,y` or `nub x,y`. Scale 1 only.
 */
async function cablesOnScreen(page: Page, cables: readonly CableToRead[]): Promise<CablesOnCanvas & { covered: string[] }> {
  const cam = await cameraOf(page);
  if (cam.scale !== 1) {
    throw new Error(`cablesOnScreen: the camera is at scale ${cam.scale}; the cable floors are measured at scale 1`);
  }
  const all = cables.flatMap((c) => c.cells);
  const cx0 = Math.min(...all.map((c) => c[0])) - 1;
  const cy0 = Math.min(...all.map((c) => c[1])) - 1;
  const cx1 = Math.max(...all.map((c) => c[0])) + 2;
  const cy1 = Math.max(...all.map((c) => c[1])) + 2;
  const origin = await screenPoint(page, { x: 0, y: 0 });
  const x0 = Math.round(origin.x + cx0 * CELL);
  const y0 = Math.round(origin.y + cy0 * CELL);
  const x1 = Math.round(origin.x + cx1 * CELL);
  const y1 = Math.round(origin.y + cy1 * CELL);
  const probes = [
    ...cables.flatMap((c) =>
      c.cells.slice(1, -1).map(([cx, cy]) => ({ name: `cell ${cx},${cy}`, x: origin.x + (cx + 0.5) * CELL, y: origin.y + (cy + 0.5) * CELL })),
    ),
    ...cables.flatMap((c) => c.ends.map((e) => ({ name: `nub ${e.x},${e.y}`, x: origin.x + e.x, y: origin.y + e.y }))),
  ];
  const covered = await page.evaluate(
    (ps) => ps.filter((p) => document.elementFromPoint(p.x, p.y)?.tagName !== 'CANVAS').map((p) => p.name),
    probes,
  );
  const png = PNG.sync.read(await captureClip(page, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
  const dpr = png.width / (x1 - x0);
  const read = cablesOnCanvas({ width: png.width, height: png.height, data: png.data }, cables, {
    originX: origin.x - x0,
    originY: origin.y - y0,
    scale: 1,
    dpr,
    cell: CELL,
  });
  return { ...read, covered };
}

/** One line for a cable screen read. */
function cablesScreenLine(r: CablesOnCanvas & { covered: string[] }): string {
  return `${r.cables.map((c) => `${c.key} cells=${c.cellInk.join(',')} ends=${c.endInk.join(',')}`).join(' | ')} seen=${r.seen} gone=${r.gone} covered=${JSON.stringify(r.covered)}`;
}

// ---------------------------------------------------------------------------
// THE 77-CABLES CAPTURE HELPER (plan 92-04, CHROME-19, D-19, 92-RESEARCH.md Pitfall 4).
// ---------------------------------------------------------------------------
//
// WHAT IT IS FOR. `src/gates/canvasDots.test.ts` grades `cablesOnCanvas` (the screen read the two
// legs above use) on four committed captures of leg 1's pair, `src/gates/fixtures/77-cables-*.png`:
//   - `drawn`: after leg 5's Ctrl+Z and the deselect, both legs back on screen;
//   - `gone`: after leg 5's Disconnect, the Route still selected, its delete chip over cell (7,8);
//   - `unseen`: the `drawn` moment in a build whose resting cable is stroked at alpha 0 (refuter 1);
//   - `prongs-dropped`: the `drawn` moment in a build that leaves every wire terminal undrawn
//     (refuter 7: the terminals of wires that arrived by a keyframe, which every wire is after the
//     Undo).
// The captures hold the cable's on-screen colour, so a change to the cable's colour, alpha or
// width moves them, and before plan 92-04 they came from a probe that was never committed. This
// helper is that probe, kept: when `FABRICO_CAPTURE_DIR` names a folder it writes the `drawn` and
// `gone` clips there as `77-cables-<moment>.png` at the camera the reader's `FRAME` records, and
// logs what `cablesOnScreen` reads at that moment; unset (or empty), it does nothing, so the
// walk's behaviour is unchanged.
//
// THE ONE COMMAND (host on 8787 and Vite on 5173 already running, from `frontend/`):
//   FABRICO_CAPTURE_DIR=src/gates/fixtures npx playwright test --config=playwright.live.reuse.config.ts --no-deps e2e-live/77-one-board-all-five.live.spec.ts
// re-shoots `drawn` and `gone` in place. `unseen` and `prongs-dropped` are the same command run
// on a throwaway worktree carrying its break (the resting stroke's alpha 0, or the terminals left
// undrawn, switched on just before the `drawn` capture so the walk reaches it), each `drawn`
// capture renamed. Then recount `DRAWN_CELLS` and the end-ink literals in `canvasDots.test.ts`
// and declare the four moved PNGs by `BASELINE` lines.
//
// THE FRAME. Every leg keeps leg 1's camera (`recordCamera`); at 1280x800 it sits at
// `CAPTURE_CAMERA`, and the clip is the 352 by 160 px box from cell (6,7) to cell (16,11), whose
// top-left is the camera origin plus (6, 7) cells, rounded. A camera anywhere else would shoot
// pixels the reader's `FRAME` does not describe, so the helper refuses it by name.
const CAPTURE_DIR = process.env.FABRICO_CAPTURE_DIR ?? '';
/** The camera the four captures were shot at, measured on the walk (plan 92-04). */
const CAPTURE_CAMERA = { x: 243.5131914893617, y: 304.24882011605416, scale: 1, dpr: 1 };
/** The clip, CSS px: the camera origin plus cells (6, 7), rounded, 11 cells by 5. */
const CAPTURE_CLIP = { x: 436, y: 528, width: 352, height: 160 };

/** Write `77-cables-<moment>.png` when `FABRICO_CAPTURE_DIR` is set; otherwise nothing. */
async function captureCablesFixture(page: Page, moment: 'drawn' | 'gone', cables: readonly CableToRead[]): Promise<void> {
  if (CAPTURE_DIR === '') return;
  const cam = await cameraOf(page);
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  expect(
    { x: cam.x, y: cam.y, scale: cam.scale, dpr },
    `CAPTURE FRAME: the ${moment} capture is shot at the camera canvasDots.test.ts FRAME records`,
  ).toEqual(CAPTURE_CAMERA);
  expect(
    { x: Math.round(cam.x + 6 * CELL), y: Math.round(cam.y + 7 * CELL) },
    'CAPTURE CLIP: the clip is the camera origin plus cells (6, 7), rounded',
  ).toEqual({ x: CAPTURE_CLIP.x, y: CAPTURE_CLIP.y });
  const file = join(CAPTURE_DIR, `77-cables-${moment}.png`);
  await captureClip(page, CAPTURE_CLIP, file);
  console.log(
    `CAPTURE_77_CABLES moment=${moment} file=${file} camera=${cam.x},${cam.y} clip=${JSON.stringify(CAPTURE_CLIP)} ` +
      `read ${cablesScreenLine(await cablesOnScreen(page, cables))}`,
  );
}

// ---------------------------------------------------------------------------
// The canvas read-backs (the 77-02 refuter round, D-04): SCREEN PIXELS, not renderer state.
// ---------------------------------------------------------------------------

/**
 * A screenshot of the box around `cells`, decoded, with each cell's rectangle in IMAGE px. Every
 * leg's attach resets the camera to actual size, and the dot and collar floors are measured at
 * scale 1, so any other scale throws by name. The clip's four corners are checked to be on the
 * canvas, so chrome over the board cannot be read as an empty belt. Each cell is read as flowing
 * along `x`: every belt these legs read runs along row 12.
 */
async function canvasClip(
  page: Page,
  cells: readonly (readonly [number, number])[],
): Promise<{ img: DecodedImage; dpr: number; tiles: TileInImage[]; x0: number; y0: number }> {
  const clip = await clipOfCells(page, cells);
  const { x0, y0, x1, y1 } = clip.rect;
  const png = PNG.sync.read(await captureClip(page, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
  const dpr = png.width / (x1 - x0);
  return { img: { width: png.width, height: png.height, data: png.data }, dpr, tiles: tilesOfClip(clip, cells, dpr), x0, y0 };
}

/** Where `cells` lie on the page: the CSS px box around them and each cell's centre. The camera's
 *  scale and the box's four corners are checked here (`canvasClip`'s rules). */
async function clipOfCells(
  page: Page,
  cells: readonly (readonly [number, number])[],
): Promise<{ rect: CssRect; centres: { x: number; y: number }[] }> {
  const cam = await cameraOf(page);
  if (cam.scale !== 1) {
    throw new Error(`canvasClip: the camera is at scale ${cam.scale}; the canvas floors are measured at scale 1`);
  }
  const centres = await Promise.all(cells.map(([cx, cy]) => screenCellCentre(page, cx, cy)));
  const half = CELL / 2;
  const rect = {
    x0: Math.round(Math.min(...centres.map((c) => c.x)) - half),
    y0: Math.round(Math.min(...centres.map((c) => c.y)) - half),
    x1: Math.round(Math.max(...centres.map((c) => c.x)) + half),
    y1: Math.round(Math.max(...centres.map((c) => c.y)) + half),
  };
  await expectAllCanvas(page, rect, 'canvasClip');
  return { rect, centres };
}

/** Throws by name unless every corner of `rect` (CSS px) is the canvas, so chrome over the board is
 *  never read as an empty board. */
async function expectAllCanvas(page: Page, rect: CssRect, who: string): Promise<void> {
  const { x0, y0, x1, y1 } = rect;
  const corners = [
    { x: x0, y: y0 },
    { x: x1 - 1, y: y0 },
    { x: x0, y: y1 - 1 },
    { x: x1 - 1, y: y1 - 1 },
  ];
  const tags = await page.evaluate(
    (ps) => ps.map((pt) => document.elementFromPoint(pt.x, pt.y)?.tagName ?? null),
    corners,
  );
  if (tags.some((tag) => tag !== 'CANVAS')) {
    throw new Error(`${who}: the clip (${x0},${y0})-(${x1},${y1}) is not all canvas: corners read ${tags.join(',')}`);
  }
}

/** Each cell's rectangle in the pixels of a capture of `clip`, at `dpr` device px per CSS px. Each
 *  cell is read as flowing along `x`: every belt these legs read runs along row 12. */
function tilesOfClip(
  clip: { rect: CssRect; centres: { x: number; y: number }[] },
  cells: readonly (readonly [number, number])[],
  dpr: number,
): TileInImage[] {
  const half = CELL / 2;
  return cells.map(([cx, cy], i) => ({
    key: `${cx},${cy}`,
    rect: {
      x0: Math.round((clip.centres[i].x - half - clip.rect.x0) * dpr),
      y0: Math.round((clip.centres[i].y - half - clip.rect.y0) * dpr),
      x1: Math.round((clip.centres[i].x + half - clip.rect.x0) * dpr),
      y1: Math.round((clip.centres[i].y + half - clip.rect.y0) * dpr),
    },
    axis: 'x',
  }));
}

// ---------------------------------------------------------------------------
// THE SCREEN, REQUESTED NOW (plan 84-11)
// ---------------------------------------------------------------------------
//
// WHY. The 2026-10-09 CI run ran this walk on a two-CPU runner and failed leg 2's growth; plan 84-11
// reproduced it pinned to two cores, where one leg 2 screenshot read took 0.83 to 0.94 s, and at a
// 100% CPU quota (one CPU's time), where it took 2.5 to 3.0 s (a raw `Page.captureScreenshot` the
// same), against about 35 ms at full speed. Every read below that a screenshot sits inside, a series
// of samples or a screenshot taken between two reads of what the renderer placed, then measured the
// machine: the growth skipped stages, ten gauge screenshots did not fit their 10 s, and two placed
// reads seconds apart rarely agree on a flowing belt.
//
// WHAT WAS MEASURED. Chromium captures the frame on screen when the request ARRIVES and spends the
// seconds after it reading the frame back and encoding it: on that machine each capture's packed
// depth matched the model's at its request, not at its reply 2 s later, and requests in flight
// overlap. So a read here REQUESTS a capture and returns at once; the pixels come later. A request
// between two renderer reads is then bracketed by those two reads, however slow the reply (the
// frame on screen may still trail the renderer by a frame or two, `screenBrackets`).
//
// HOW. One DevTools session per page, a capture of the WHOLE viewport, cropped to the clip. Never a
// raw capture with a clip: Chromium emulates the clip's size as the viewport for each one and
// overlapping requests restore each other's emulation, so the page was left 192 by 32 CSS px
// (measured, with and without `captureBeyondViewport: false`). Only the clip's rows are decoded
// (`support/pngRows.ts`). Each capture's size is checked against the viewport taken when the session
// opened, so a resized page is a named failure, never a read of the wrong pixels.

/** A rectangle of the page in CSS px, `[x0, x1)` by `[y0, y1)`. */
interface CssRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface ScreenSession {
  cdp: CDPSession;
  vw: number;
  vh: number;
  dpr: number;
  /** When the last capture of this session came back (Node ms), for each capture's own time. */
  lastReplyAt: number;
}

const screenSessions = new WeakMap<Page, Promise<ScreenSession>>();

/** The page's DevTools session for captures, opened once, with the viewport it opened on. */
function screenSession(page: Page): Promise<ScreenSession> {
  let session = screenSessions.get(page);
  if (session === undefined) {
    session = (async () => {
      const cdp = await page.context().newCDPSession(page);
      const [vw, vh, dpr] = await page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]);
      return { cdp, vw, vh, dpr, lastReplyAt: 0 };
    })();
    screenSessions.set(page, session);
  }
  return session;
}

/** A capture's pixels inside `clip`, and the device px per CSS px. `png` encodes just the clip. */
interface ClipPixels {
  img: DecodedImage;
  dpr: number;
  png: () => Buffer;
}

/** pngjs as bundled: its typings declare only `sync.read`; the encoder is there too. */
const PngWriter = PNG as unknown as {
  new (o: { width: number; height: number }): { data: Buffer };
  sync: { write(png: { data: Buffer }): Buffer };
};

/**
 * Request a capture of the whole viewport NOW, and get back, later, its pixels inside `clip` (CSS
 * px). The request is on its way when this returns; `pixels` resolves when the capture comes back.
 */
async function requestScreen(page: Page, clip: CssRect): Promise<{ pixels: Promise<ClipPixels> }> {
  const session = await screenSession(page);
  const { cdp, vw, vh, dpr } = session;
  const askedAt = Date.now();
  const sent = cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, optimizeForSpeed: true });
  const pixels = sent.then((shot) => {
    // The capture's own time (plan 84-18): from the later of its request and the previous reply,
    // since requests in flight are answered one after another.
    const now = Date.now();
    noteCaptureMs(now - Math.max(askedAt, session.lastReplyAt));
    session.lastReplyAt = now;
    const rx0 = Math.round(clip.x0 * dpr);
    const ry0 = Math.round(clip.y0 * dpr);
    const rx1 = Math.round(clip.x1 * dpr);
    const ry1 = Math.round(clip.y1 * dpr);
    const full = decodePngRows(Buffer.from(shot.data, 'base64'), ry0, ry1);
    if (full.width !== Math.round(vw * dpr) || full.height !== Math.round(vh * dpr)) {
      throw new Error(
        `requestScreen: a capture came back ${full.width} by ${full.height}; the viewport was ${vw} by ${vh} at ${dpr} device px per CSS px`,
      );
    }
    const width = rx1 - rx0;
    const height = ry1 - ry0;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const from = ((ry0 + y) * full.width + rx0) * 4;
      data.set(full.data.subarray(from, from + width * 4), y * width * 4);
    }
    const img = { width, height, data };
    const png = (): Buffer => {
      const out = new PngWriter({ width, height });
      out.data.set(data);
      return PngWriter.sync.write(out);
    };
    return { img, dpr, png };
  });
  // Marked handled now; whoever awaits `pixels` still sees the failure.
  pixels.catch(() => undefined);
  return { pixels };
}

/** The item dots visible per cell in a capture of `clip` (`canvasDotsPerCell`'s read). */
function dotsInClip(
  pixels: ClipPixels,
  clip: { rect: CssRect; centres: { x: number; y: number }[] },
  cells: readonly (readonly [number, number])[],
): Record<string, number> {
  const read = visibleDotsPerTile(pixels.img, tilesOfClip(clip, cells, pixels.dpr), pixels.dpr);
  return Object.fromEntries(Object.entries(read).map(([k, v]) => [k, v.dots]));
}

/** One screen read bracketed by two renderer reads (plan 84-11). */
interface Bracket<R, S> {
  before: R;
  after: R;
  screen: S;
}

/**
 * BRACKETED SCREEN READS, PIPELINED (plan 84-11). Each `take()` reads the renderer (`read`),
 * requests a capture of `clip`, reads the renderer again, and returns without waiting for the
 * capture, so the request lies between the two reads at any machine speed, as the old screenshot did
 * only on a fast machine. The frame on screen can still trail the renderer by a frame or two: at full
 * speed 5 of 6 brackets whose two placed reads agreed showed other dots on screen, and with two
 * frames left between the first read and the request no two placed reads agreed at all, so a
 * caller that needs a match retries on a mismatch and never grades one as a pass. `settled()` lists the
 * brackets whose capture has come back, in the order they were taken, and `all()` waits for every
 * one (and rethrows the first failed capture). `clip` is taken once, on the first `take()`, and the
 * camera must not move after it: `all()` throws by name if it did.
 */
function screenBrackets<C extends { rect: CssRect }, R, S>(
  page: Page,
  clipOf: () => Promise<C>,
  read: () => Promise<R>,
  fromPixels: (pixels: ClipPixels, clip: C) => S,
): { take: () => Promise<void>; settled: () => Bracket<R, S>[]; all: () => Promise<Bracket<R, S>[]> } {
  let clip: C | null = null;
  let cam: { x: number; y: number; scale: number } | null = null;
  const done: (Bracket<R, S> | undefined)[] = [];
  const pending: Promise<Bracket<R, S>>[] = [];
  return {
    async take(): Promise<void> {
      if (clip === null) {
        cam = await cameraOf(page);
        clip = await clipOf();
      }
      const c = clip;
      const before = await read();
      const { pixels } = await requestScreen(page, c.rect);
      const after = await read();
      const slot = done.length;
      done.push(undefined);
      const bracket = pixels.then((px) => {
        const b = { before, after, screen: fromPixels(px, c) };
        done[slot] = b;
        return b;
      });
      bracket.catch(() => undefined);
      pending.push(bracket);
    },
    settled: () => done.filter((b): b is Bracket<R, S> => b !== undefined),
    async all(): Promise<Bracket<R, S>[]> {
      const out = await Promise.all(pending);
      const now = await cameraOf(page);
      if (cam !== null && (now.x !== cam.x || now.y !== cam.y || now.scale !== cam.scale)) {
        throw new Error(`screenBrackets: the camera moved from ${JSON.stringify(cam)} to ${JSON.stringify(now)} while the clip was read`);
      }
      return out;
    },
  };
}

/** The item dots VISIBLE on each of `cells`, keyed `x,y`, off one screenshot (`support/canvasDots.ts`). */
async function canvasDotsPerCell(
  page: Page,
  cells: readonly (readonly [number, number])[],
): Promise<Record<string, number>> {
  const { img, dpr, tiles } = await canvasClip(page, cells);
  const read = visibleDotsPerTile(img, tiles, dpr);
  return Object.fromEntries(Object.entries(read).map(([k, v]) => [k, v.dots]));
}

/** One growth sample: the dots visible per run tile, and its place on the model clock (plan 84-15). */
interface GrowthSample {
  dots: Record<string, number>;
  /** The model tick the capture is stamped with (plan 84-16: read in the animation-frame callback
   *  whose frame the pixels are, so the capture was requested and answered on that tick). */
  requestTick: number;
  /** The same tick as `requestTick` (plan 84-16): an in-page read is requested and answered on the
   *  frame it read, so 84-15's rule (`unresolvedStages`) places it exactly. */
  replyTick: number;
  /** Node milliseconds from the start of the call that issued the capture to the end of the call
   *  that returned it. */
  latencyMs: number;
  /** The model's packed run in slots, read from the scene in the callback whose frame the capture is
   *  (plan 84-17), or null when the reply's scene is from another tick than the stamp (a buffered read
   *  drained on a later frame). Leg 2 places each capture by this reading and brackets each pack
   *  boundary with it (`boundaryBrackets`), because the tick recorder, starved by the synchronous
   *  read at the GPU proxy, logs a boundary's first tick up to 37 ticks late (84-16's series). */
  modelRun: number | null;
}

/** What the growth captures cost and whether each was its stamped frame (`PACK_GROWTH_CAPTURE`). */
interface GrowthCaptureStats {
  context: string;
  captures: number;
  /** Captures whose item layer drew from another tick than the stamp. */
  unpaired: number;
  /** Captures whose every pixel was one RGBA value (a cleared buffer). */
  flat: number;
  blockMs: number[];
  readbackFrames: number[];
  readbackMs: number[];
}

/**
 * THE GROWTH SAMPLER'S READ (plans 84-11, 84-15, 84-16). The same pixels as `canvasDotsPerCell`, of
 * the same clip (`clipOfCells`: scale 1, every corner on the canvas), taken fast enough to see every
 * stage on a slow renderer.
 *
 * HISTORY. Plan 84-11 sampled with CDP screenshots requested without waiting for the one before,
 * after the 2026-10-09 CI run failed `PACK GROWS ON THE CANVAS` on a two-CPU runner over 9 screenshots.
 * Plan 84-15 stamped each with a reply tick and resolved a stage only by a capture requested and
 * answered inside it, and then stopped for a decision: one `Page.captureScreenshot` takes about 3.8 s at the
 * GPU proxy (about 240 model ticks) against a 40-tick stage, so no capture could be requested and
 * answered inside a stage at any depth in flight (84-EVIDENCE.md `### Plan 84-15: no in-flight depth
 * fits at the proxy`).
 *
 * THE READ (plan 84-16, a design decision, not a grading change). Each capture reads the
 * Pixi WebGL canvas in the page (`support/frameCapture.ts` `captureFrameInPage`), in one animation
 * frame callback that runs after Pixi drew that frame, and is stamped with `window.__fabrico.scene()`'s
 * tick read in that same callback; in `pbo` mode the bytes come back on a later frame and still carry
 * the issuing frame's tick. The 84-15 spike read the canvas synchronously and passed legs 1 and 2
 * three times at the proxy and three times unthrottled, with both of 84-11's drawing bites red, at
 * about 380 ms of stall per read at the proxy. So `requestTick` and `replyTick` are both the stamp,
 * and 84-15's rule is unchanged.
 *
 * THE PAIRING CHECK. Each capture also reads the item layer's `drawnAtTick` in the callback whose
 * frame it read (only the tick, never the dots): a capture whose `drawnAtTick` is not its stamp, or
 * whose pixels are all one value, is counted, and leg 2 refuses either (`CAPTURE IS ITS STAMPED
 * FRAME`) before grading the growth. The caller checks afterwards that neither the camera nor the
 * viewport moved.
 *
 * THE CAPTURE'S OWN READING (plan 84-17). `runOf` reads the model's packed run from a scene; each
 * capture records it from the scene read in its own callback (`modelRun`) whenever that scene's tick
 * is the capture's stamp (every `sync` capture), so leg 2 can place the capture by what the model was
 * on that very tick instead of by the tick recorder's first record of each boundary, which a starved
 * recorder logs late (84-16's series runs 3 and 5 credited a stage with a capture of the next depth).
 */
async function openGrowthSampler(
  page: Page,
  runOf: (scene: SceneFacts) => number,
): Promise<{
  /** One animation frame: issue a read of the clip, collect every read that came back, and return
   *  the scene read in that frame. */
  capture: () => Promise<SceneFacts>;
  /** True once a capture showed four dots on every run tile. */
  shownWhole: () => boolean;
  /** Drain every read still in flight, one frame per call, and return the samples in issue order. */
  finish: () => Promise<{ samples: GrowthSample[]; stats: GrowthCaptureStats }>;
}> {
  const clip = await clipOfCells(page, RUN_CELLS);
  // A fresh in-page store: any buffer and fence a previous sampler left are deleted.
  await page.evaluate(() => {
    const w = window as unknown as {
      __fabGrowthCapture?: {
        gl?: WebGL2RenderingContext | null;
        queue?: { buffer: WebGLBuffer; fence: WebGLSync }[];
        pool?: { buffer: WebGLBuffer }[];
      };
    };
    const st = w.__fabGrowthCapture;
    if (st?.gl) {
      for (const q of st.queue ?? []) {
        st.gl.deleteSync(q.fence);
        st.gl.deleteBuffer(q.buffer);
      }
      for (const p of st.pool ?? []) st.gl.deleteBuffer(p.buffer);
    }
    if (st?.queue) st.queue.length = 0;
    delete w.__fabGrowthCapture;
  });
  const samples: GrowthSample[] = [];
  const issuedAt = new Map<number, number>();
  let issued = 0;
  let whole = false;
  let context = '-';
  let inFlight = 0;
  const caps: CapturedFrame[] = [];
  const take = async (issue: boolean): Promise<SceneFacts> => {
    const started = Date.now();
    if (issue) issuedAt.set(issued++, started);
    const reply = await page.evaluate(captureFrameInPage, {
      rect: clip.rect,
      mode: GROWTH_CAPTURE_MODE,
      issue,
      readbackFramesMax: READBACK_FRAMES_MAX,
    });
    const ended = Date.now();
    context = reply.context;
    inFlight = reply.inFlight;
    for (const c of reply.captures) {
      const from = issuedAt.get(c.seq);
      if (from === undefined) throw new Error(`openGrowthSampler: capture ${c.seq} came back without a call that issued it`);
      const data = new Uint8Array(Buffer.from(c.b64, 'base64'));
      const png = (): Buffer => {
        const out = new PngWriter({ width: c.w, height: c.h });
        out.data.set(data);
        return PngWriter.sync.write(out);
      };
      const dots = dotsInClip({ img: { width: c.w, height: c.h, data }, dpr: c.k, png }, clip, RUN_CELLS);
      if (Object.values(dots).every((n) => n === SLOTS_PER_TILE)) whole = true;
      const scene = reply.scene as SceneFacts;
      const modelRun = scene.tick === c.tick ? runOf(scene) : null;
      samples.push({ dots, requestTick: c.tick, replyTick: c.tick, latencyMs: ended - from, modelRun });
      caps.push({ ...c, b64: '' });
    }
    return reply.scene as SceneFacts;
  };
  return {
    capture: () => take(true),
    shownWhole: () => whole,
    async finish() {
      while (inFlight > 0) await take(false);
      return {
        samples,
        stats: {
          context,
          captures: caps.length,
          // Compared here from the two ticks each capture carries, not taken from its own flag.
          unpaired: caps.filter((c) => c.drawnAtTick !== c.tick).length,
          flat: caps.filter((c) => c.flat).length,
          blockMs: caps.map((c) => c.blockMs),
          readbackFrames: caps.map((c) => c.readbackFrames),
          readbackMs: caps.map((c) => c.readbackMs),
        },
      };
    },
  };
}

/**
 * The label AS THE SCREEN SHOWS IT (the 77-04 refuter round, refuters 2 and 3): a screenshot of
 * exactly the label's 12 cells, the words overlay composited over the canvas as the user sees it,
 * read for the Lilac box (stroke on all four sides, the fill at its alpha) and the words' pixels
 * (`support/canvasDots.ts`, "WHAT A LABEL IS, IN PIXELS"). `labelBoxOn` reads the box Graphics'
 * instructions and `labelWordsOf` the words' DOM text and `isVisible`; a box set invisible and words
 * at opacity 0 pass both. Scale 1 only, and every corner of the clip must be canvas (`canvasClip`).
 */
async function labelOnScreen(page: Page): Promise<LabelOnCanvas> {
  const { img, dpr } = await canvasClip(page, LABEL_CELL_PAIRS);
  return labelOnCanvas(img, LILAC, dpr);
}

/** A words read as leg 4 compares it across the Load: the text, Playwright's visibility, and the
 *  box rounded to whole px (refuter 3: the place was read and never compared). */
function wordsAt(
  w: { text: string; visible: boolean; rect: { x: number; y: number; width: number; height: number } | null } | null,
): { text: string; visible: boolean; at: number[] | null } | null {
  if (w === null) return null;
  const at = w.rect === null ? null : [w.rect.x, w.rect.y, w.rect.width, w.rect.height].map((v) => Math.round(v));
  return { text: w.text, visible: w.visible, at };
}

/** One line for a label screen read. */
function labelScreenLine(r: LabelOnCanvas): string {
  return `sides=${r.sides.join(',')} min=${r.sideMin.join(',')} fillAlpha=${r.fillAlpha.toFixed(3)} residual=${r.fillResidual.toFixed(1)} words=${r.words} box=${r.boxDrawn} wordsDrawn=${r.wordsDrawn}`;
}

/** The collar ring ink on the seam between two tiles of a row (`support/canvasDots.ts` `collarInk`). */
async function collarOnCanvas(
  page: Page,
  left: readonly [number, number],
  right: readonly [number, number],
): Promise<CollarInk> {
  const { img, dpr, tiles } = await canvasClip(page, [left, right]);
  return collarInk(img, tiles[0].rect.x1, (tiles[0].rect.y0 + tiles[0].rect.y1) / 2, 'x', dpr);
}

/**
 * A machine's load gauge AS THE CANVAS SHOWS IT (the 77-03 refuter round, refuter 1): the clip
 * around the band `drawLoadGauge` plots above the machine's box (`support/canvasDots.ts`, "WHAT A
 * LOAD GAUGE IS, IN PIXELS"), read off a capture (`gaugeInPixels`) for its runs of `ramp[4]` ink.
 * `cells` are the machine's cells (the band is centred on their box's top edge). Scale 1 only, and
 * every corner of the clip must be canvas, as `canvasClip` requires. Since plan 84-11 it is read
 * through `screenBrackets`, between two reads of the gauge Graphics.
 */
async function gaugeClipOf(
  page: Page,
  cells: readonly (readonly [number, number])[],
): Promise<{ rect: CssRect; by0: number }> {
  const cam = await cameraOf(page);
  if (cam.scale !== 1) {
    throw new Error(`gaugeOnScreen: the camera is at scale ${cam.scale}; the gauge read is measured at scale 1`);
  }
  const minX = Math.min(...cells.map((c) => c[0]));
  const maxX = Math.max(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  const centre = await screenCellCentre(page, minX, minY);
  const left = centre.x - CELL / 2;
  const top = centre.y - CELL / 2;
  const bx0 = left + ((maxX - minX + 1) * CELL) / 2 - GAUGE_RUN_PX / 2;
  const by0 = top - GAUGE_OUTSET_PX - GAUGE_THICK_PX;
  const rect = {
    x0: Math.floor(bx0) - 8,
    x1: Math.ceil(bx0 + GAUGE_RUN_PX) + 8,
    y0: Math.floor(by0) - 4,
    y1: Math.ceil(by0 + GAUGE_THICK_PX) + 4,
  };
  await expectAllCanvas(page, rect, 'gaugeOnScreen');
  return { rect, by0 };
}

/** The gauge read off a capture of `gaugeClipOf`'s clip. */
function gaugeInPixels(px: ClipPixels, clip: { rect: CssRect; by0: number }): GaugeOnCanvas {
  const band = {
    x0: 0,
    x1: px.img.width,
    y0: Math.round((clip.by0 - 1 - clip.rect.y0) * px.dpr),
    y1: Math.round((clip.by0 + GAUGE_THICK_PX + 1 - clip.rect.y0) * px.dpr),
  };
  return gaugeOnCanvas(px.img, band, px.dpr);
}

/** A gauge form off its Graphics as a LEVEL: 4 for the merged bar, else its instruction count. */
function graphicsLevel(f: { instructions: number; merged: boolean } | null): number | null {
  return f === null ? null : f.merged ? 4 : f.instructions;
}

/**
 * The verdict on bracketed reads of placed against visible dots (plan 84-11): the first bracket
 * whose two placed reads agree (`steady`), whose visible dots equal them (`same`) and that carries
 * items (at least 3 dots placed), else the latest bracket's reading, else none. `log` gets the line
 * of the bracket the verdict comes from.
 */
function visibleAgreement(
  brackets: readonly Bracket<Record<string, number>, Record<string, number>>[],
  log: (line: string) => void,
): { steady: boolean; same: boolean; carried: boolean } {
  const graded = brackets.map((b) => {
    const steady = JSON.stringify(b.before) === JSON.stringify(b.after);
    const placed = Object.values(b.before).reduce((a, n) => a + n, 0);
    return {
      b,
      verdict: { steady, same: steady && JSON.stringify(b.screen) === JSON.stringify(b.before), carried: placed >= 3 },
    };
  });
  const shown = graded.find((g) => g.verdict.steady && g.verdict.same && g.verdict.carried) ?? graded[graded.length - 1];
  if (shown === undefined) return { steady: false, same: false, carried: false };
  const steadyN = graded.filter((g) => g.verdict.steady).length;
  const sameN = graded.filter((g) => g.verdict.same).length;
  log(
    `placed=${Object.values(shown.b.before).join('')} visible=${Object.values(shown.b.screen).join('')} settled=${graded.length} steady=${steadyN} same=${sameN}`,
  );
  return shown.verdict;
}

/** Of the plotted dots (renderer state), how many sit on each of `cells`. */
function plottedOn(perCell: Record<string, number>, cells: readonly (readonly [number, number])[]): Record<string, number> {
  return Object.fromEntries(cells.map(([x, y]) => [`${x},${y}`, perCell[`${x},${y}`] ?? 0]));
}

// ---------------------------------------------------------------------------
// The legs, in done-test order.
// ---------------------------------------------------------------------------

test('leg 1 - a Route and an HTTP Handler from the palette, joined by one drag, answer a POST with the body the Handler panel JS produced', async () => {
  const page = sharedPage();

  // 1. BOOT, and measure the board empty.
  const errs = await bootOnEmptyBoard(page);
  const booted = await readScene(page);
  expect(
    { nodes: booted.nodes.length, belts: booted.belts.length, wires: booted.wires.length },
    'BOOTED EMPTY: a measurement, not an assumption',
  ).toEqual({ nodes: 0, belts: 0, wires: 0 });
  await expectRenderLoopAlive(page, 'leg 1 on the empty board');

  // 2. TWO MACHINES, TWO PALETTE CLICKS, both plotted with their own art.
  await armAndPlaceAt(page, 'Route', ROUTE_CELL[0], ROUTE_CELL[1]);
  await armAndPlaceAt(page, 'HTTP Handler', HANDLER_CELL[0], HANDLER_CELL[1]);
  await pollScene(page, placedReading, {
    message:
      'TWO NODES PLACED: exactly a Route (kind 9) at anchor (8,8) and an HTTP Handler (kind 10) at anchor (12,7), nothing else',
  }).toEqual([
    { kind: KIND_ROUTE, anchor: `${ROUTE_CELL[0]},${ROUTE_CELL[1]}` },
    { kind: KIND_HANDLER, anchor: `${HANDLER_CELL[0]},${HANDLER_CELL[1]}` },
  ]);
  const placed = await readScene(page);
  const route = nodeAtAnchor(placed, ROUTE_CELL[0], ROUTE_CELL[1])!;
  const handler = nodeAtAnchor(placed, HANDLER_CELL[0], HANDLER_CELL[1])!;
  // D-04: what the machine layer PLOTTED for each machine, beside the census. The census lists
  // every handle whose machine ROOT is a child of the layer, so a Route whose body draws nothing
  // still passes it; the art is what is drawn. Polled with the expected value, because the
  // renderer draws a frame after the model moves.
  await expect
    .poll(
      async () => {
        const drawn = await drawnNodesOf(page);
        return {
          census: drawn.machines.includes(route.id) && drawn.machines.includes(handler.id),
          art: [
            await glyphSubjectOn(page, route.id),
            await glyphSubjectOn(page, handler.id),
          ],
        };
      },
      {
        timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'DRAWN ON THE CANVAS poll'),
        intervals: [100, 250, 500],
        message: 'DRAWN ON THE CANVAS: each placed machine plots its own art',
      },
    )
    .toEqual({ census: true, art: ['endpoint', 'factory'] });
  await expectRenderLoopAlive(page, 'leg 1 after both placements');

  // 3. THE URL, read off the Route's own panel and matched to the host bridge.
  await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
  const url = await readPanelUrl(page);
  console.log(`COMP_PANEL_URL ${url}`);
  expect(url, 'URL ON THE PANEL: the placed Route minted its own loopback POST route').toMatch(
    ENDPOINT_URL_SHAPE,
  );
  expect(
    await webhookUrl(page, route.id),
    'URL ON THE PANEL: the panel URL is the same string the host-side webhook_url bridge answers',
  ).toBe(url);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expectRenderLoopAlive(page, 'leg 1 after reading the URL');

  // 4. ONE DRAG, TWO WIRES, graded by endpoints.
  const routeOut = route.ports.find((p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL);
  const routeIn = route.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL);
  const handlerIn = handler.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_ELECTRICAL);
  const handlerOut = handler.ports.find(
    (p) => p.role === ROLE_OUT && p.medium === MEDIUM_ELECTRICAL,
  );
  expect(
    [routeOut, routeIn, handlerIn, handlerOut].every((p) => p !== undefined),
    'ONE DRAG TWO WIRES: both machines declare an electrical In and Out to join',
  ).toBe(true);
  const forwardKey = wireKey({
    from: { node: route.id, port: routeOut!.index },
    to: { node: handler.id, port: handlerIn!.index },
  });
  const returnKey = wireKey({
    from: { node: handler.id, port: handlerOut!.index },
    to: { node: route.id, port: routeIn!.index },
  });
  await recordCamera(page, 'leg 1 before the drag');
  await drawWireBetweenPorts(page, routeOut as PortFacts, handlerIn as PortFacts);
  await pollScene(page, (s) => s.wires.map(wireKey).sort(), {
    message:
      'ONE DRAG TWO WIRES: the one drag minted exactly the forward leg (Route Out to Handler In) and the return leg (Handler Out to Route In)',
  }).toEqual([forwardKey, returnKey].sort());
  const wired = await readScene(page);
  const forward = wired.wires.find((w) => wireKey(w) === forwardKey)!;
  const returnLeg = wired.wires.find((w) => wireKey(w) === returnKey)!;
  expectHeadOn(wired, forward, 'ONE DRAG TWO WIRES forward leg');
  expectHeadOn(wired, returnLeg, 'ONE DRAG TWO WIRES return leg');
  const cableCells: Record<string, [number, number][]> = {};
  for (const w of [forward, returnLeg]) {
    cableCells[anchorKey(wired, w)] = w.path.map((c) => [c.cell_x, c.cell_y]);
  }
  console.log(`COMP_LEG1_CABLES ${JSON.stringify(cableCells)}`);
  // D-04: the two legs as DRAWN, read off the wire layer's cables Graphics, beside the model's
  // two endpoint keys. Polled, because the renderer draws a frame after the packet lands.
  // R-01 a: and WHERE, each stroke graded against its own wire's routed cells, so a layer that
  // strokes the pair anywhere but on its route is red here and not only in a later leg.
  await expect
    .poll(async () => drawnCableGrade(page), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'TWO CABLES DRAWN poll'),
      intervals: [100, 250, 500],
      message: 'TWO CABLES DRAWN: the wire layer plotted exactly two resting cable strokes, the forward and the return leg, each lying on the cells the model routed it on (read off the plot, graded against wires[].path)',
    })
    .toEqual(PAIR_DRAWN_ON_ITS_CELLS);
  const drawnCables = await drawnCableSet(page);
  console.log(`COMP_LEG1_DRAWN ${JSON.stringify(drawnCables)}`);
  // R-05 a: and SEEN, in screen pixels: the cable on every cell between the two machines and the
  // electric prong at all four nubs. Before the POST, so no comet rides the cable.
  const pairToRead = cablesToRead(wired);
  await expect
    .poll(async () => {
      const r = await cablesOnScreen(page, pairToRead);
      return { seen: r.seen, gone: r.gone, covered: r.covered };
    }, {
      timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'TWO CABLES SEEN ON SCREEN poll'),
      intervals: [100, 250, 500],
      message: "TWO CABLES SEEN ON SCREEN: in screen pixels every cell between the Route and the Handler holds each leg's cable, and each of the four nubs its electric prong (support/canvasDots.ts cablesOnCanvas)",
    })
    .toEqual({ seen: true, gone: false, covered: [] });
  console.log(`COMP_LEG1_SCREEN ${cablesScreenLine(await cablesOnScreen(page, pairToRead))}`);
  await expectRenderLoopAlive(page, 'leg 1 after the drag');

  // 5. THE POST answers with the preset body, and THAT return wire carries the reply (R-01 c:
  // the scene's lossless reply latch, read before the POST and polled after it).
  const replyBefore = (await readScene(page)).replyPulsesObserved;
  const first = await post(page, 'leg 1: the preset Handler answers', url, '{"probe":"comp-leg1-preset"}');
  expect(first.status, 'ANSWERS THE PRESET: the hand-built route answers its caller with 200').toBe(
    200,
  );
  expect(first.body, 'ANSWERS THE PRESET: with the Handler preset body').toBe(HANDLER_PRESET_BODY);
  const afterPost = await readScene(page);
  console.log(
    `COMP_LEG1_REPLY latch_before=${replyBefore} latch_after_post=${afterPost.replyPulsesObserved} ` +
      `pulse_on_return_wire_at_read=${(afterPost.wires.find((w) => w.id === returnLeg.id)?.pulses ?? []).some((p) => p.direction === WIRE_DIR_REPLY)}`,
  );
  await pollScene(
    page,
    (s) => ({
      wires: s.wires.map(wireKey).sort(),
      endingAtTheCaller: s.wires.filter((w) => w.to.node === route.id).map(wireKey),
      replyLatched: s.replyPulsesObserved > replyBefore,
    }),
    {
      timeout: 30_000,
      message:
        'REPLY ON THE RETURN LEG: a REPLY-direction pulse was applied to the scene during the POST (the reply latch rose), on a board whose only wires are the pair and whose only wire ending at the caller, the one wire the host classes a REPLY on, is the return leg',
    },
  ).toEqual({ wires: [forwardKey, returnKey].sort(), endingAtTheCaller: [returnKey], replyLatched: true });
  await expectRenderLoopAlive(page, 'leg 1 after the preset POST');

  // 6. THE BODY FROM THE PANEL: edit the Handler's JS in its own panel and POST again.
  await selectMachineAt(page, HANDLER_CELL[0], HANDLER_CELL[1]);
  expect(
    await readFactorySource(page),
    'BODY FROM THE PANEL: the panel opened on the Handler this leg placed, holding the preset',
  ).toContain(HANDLER_PRESET_BODY);
  await typeFactorySource(
    page,
    `export default function (input, ctx) {\n  ctx.command({\n    status: 200,\n    headers: { "content-type": "text/plain" },\n    body: "${PANEL_BODY}",\n  }, 0);\n}`,
  );
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  const edited = await post(page, 'leg 1: the edited Handler answers', url, '{"probe":"comp-leg1-panel"}');
  expect(edited.status, 'BODY FROM THE PANEL: the edited route still answers 200').toBe(200);
  expect(
    { body: edited.body, differsFromPreset: edited.body !== HANDLER_PRESET_BODY },
    'BODY FROM THE PANEL: the body is the string typed into the Handler panel, not the preset',
  ).toEqual({ body: PANEL_BODY, differsFromPreset: true });
  await expectRenderLoopAlive(page, 'leg 1 after the panel edit');

  // 7. RECORD for the later legs. No Disconnect and no Delete (D-10, D-21): leg 5 needs this
  // cable.
  board.routeId = route.id;
  board.handlerId = handler.id;
  board.endpointUrl = url;
  board.leg1CableCells = cableCells;
  board.leg1DrawnCables = drawnCables;
  errs.assertNone('during leg 1');
});

test('leg 2 - a belt from a Source and a second from its end nub read as one run of 2 belts and pack solid back through the junction at the slowest pace', async () => {
  const page = sharedPage();

  // 1. THE HANDOFF, then the attach, then the board leg 1 left, MEASURED.
  const routeId = required('routeId', 'leg 1');
  const handlerId = required('handlerId', 'leg 1');
  const leg1Cables = required('leg1CableCells', 'leg 1');
  const errs = await attachToRunningBoard(page, 'leg 2');
  const opened = await readScene(page);
  const openedCables: Record<string, [number, number][]> = {};
  for (const w of opened.wires) {
    openedCables[anchorKey(opened, w)] = w.path.map((c) => [c.cell_x, c.cell_y]);
  }
  console.log(`COMP_LEG2_OPEN route=${routeId} handler=${handlerId} nodes=${opened.nodes.length}`);
  expect(
    {
      route: nodeAtAnchor(opened, ROUTE_CELL[0], ROUTE_CELL[1])?.kind,
      handler: nodeAtAnchor(opened, HANDLER_CELL[0], HANDLER_CELL[1])?.kind,
      cables: openedCables,
    },
    "leg 2 opens on the composed board: leg 1's Route, Handler and both cables",
  ).toEqual({ route: KIND_ROUTE, handler: KIND_HANDLER, cables: leg1Cables });
  await expectRenderLoopAlive(page, 'leg 2 on the board leg 1 left');

  // 2. A SOURCE FROM THE PALETTE.
  await armAndPlaceAt(page, 'Source', SOURCE_CELL[0], SOURCE_CELL[1]);
  await pollScene(page, (s) => nodeAtAnchor(s, SOURCE_CELL[0], SOURCE_CELL[1])?.kind ?? -1, {
    message: 'SOURCE PLACED: a Source (kind 0) sits at anchor (4,12)',
  }).toBe(KIND_SOURCE);
  const source = nodeAtAnchor(await readScene(page), SOURCE_CELL[0], SOURCE_CELL[1])!;
  const sourceOuts = source.ports.filter((p) => p.role === ROLE_OUT && p.medium === MEDIUM_MECHANICAL);
  expect(sourceOuts.length, 'SOURCE PLACED: the Source declares exactly one mechanical Out to draw a belt from').toBe(1);
  const sourceOut = sourceOuts[0];
  await expectRenderLoopAlive(page, 'leg 2 after placing the Source');

  // 3. THE FIRST BELT, off the Source's Out, settled on its DOCK SET (never on a count).
  await drawOffloadBelt(page, sourceOut as PortFacts, UP_CELLS);
  await pollScene(
    page,
    (s) => (beltAt(s, UP_TILE)?.docks ?? []).map((d) => `${d.end}@${d.node}`).sort(),
    { message: 'FIRST BELT DOCKED: the belt drawn off the Source names the Source at its Tail, and only that' },
  ).toEqual([`Tail@${source.id}`]);
  const upstreamId = beltAt(await readScene(page), UP_TILE)!.id;
  // THE COLLAR BASELINE, taken while the upstream Head is joined to NOTHING. It is not zero:
  // the upstream Tail plugs the Source, and that stem and cap live in the same Graphics
  // (`24-one-board-all-six.spec.ts`, `collarBefore`). Polled until the plug is plotted, so the
  // baseline is never a frame read before the dock reached the screen.
  await expect
    .poll(async () => beltEndInstructionsOn(page, upstreamId), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'COLLAR BASELINE poll'),
      intervals: [100, 250, 500],
      message: 'COLLAR BASELINE: the upstream Tail plots its Source plug before the join',
    })
    .toBeGreaterThan(0);
  const collarBefore = await beltEndInstructionsOn(page, upstreamId);
  // THE SEAM ON THE CANVAS BEFORE THE JOIN (the 77-02 refuter round): no ring ink on it yet, so the
  // read after the join below cannot be passed by ink that was already there.
  const seamBefore = await collarOnCanvas(page, UP_HEAD, DOORSTEP);
  expect(
    seamBefore.quads.map((q) => q >= COLLAR_QUADRANT_MIN),
    `COLLAR ON THE CANVAS: before the join the seam (7,12)|(8,12) shows no ring in any quadrant (ink ${seamBefore.quads.join(',')})`,
  ).toEqual([false, false, false, false]);
  await expectRenderLoopAlive(page, 'leg 2 after the first belt');

  // 4. THE SECOND BELT, BY PRESSING THE FIRST BELT'S END: spec 74's hand-driven gesture
  // (`74-belt-join-press-on-end.live.spec.ts`, `pressEndAndDrawOn` with the sub-cell sample),
  // on this leg's cells. `drawOffloadBelt` ended with Escape, which disarms the Belt tool, so
  // it is re-armed. The sub-cell offset is in WORLD px applied to a SCREEN point, so the
  // camera scale is read, not assumed.
  await resetZoomToActualSize(page);
  await waitForCameraSettle(page);
  expect(
    (await cameraOf(page)).scale,
    'the camera is at scale 1, so one world px is one screen px and the quarter-cell nudge stays inside the doorstep',
  ).toBe(1);
  await page.getByTitle(/^Draw belts/).click();
  const door = await screenCellCentre(page, DOORSTEP[0], DOORSTEP[1]);
  await page.mouse.move(door.x, door.y);
  await page.mouse.down();
  await page.mouse.move(door.x + CELL / 4, door.y);
  for (let cx = DOORSTEP[0] + 1; cx <= DOWN_END[0]; cx++) {
    const pt = await screenCellCentre(page, cx, DOWN_END[1]);
    await page.mouse.move(pt.x, pt.y);
  }
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await pollScene(page, junction, {
    message:
      'JOINED BY THE END: the second belt drawn from the first belt\'s end nub is joined to it in one gesture, the upstream Head naming the downstream and the downstream Tail naming the upstream',
  }).toBe('1/1');
  const joined = await readScene(page);
  expect(joined.belts.length, 'JOINED BY THE END: two belts on the board, no more').toBe(2);
  const downstreamId = beltAt(joined, DOORSTEP)!.id;
  expect(
    beltAt(joined, UP_HEAD)!.id,
    'JOINED BY THE END: the upstream handle survived the join (a keyframe would remint it)',
  ).toBe(upstreamId);
  // THE PAINT, beside the model and substituting for neither. The collar is drawn by the
  // belt whose end carries the Out role, the upstream HEAD (`belts.ts` `rebuildEnds`, the
  // ownership rule), so it is graded as the upstream count's rise over its Source-plug
  // baseline, by exactly the collar's two instructions. The downstream draws nothing: its
  // Tail's seam is owned upstream and its Head is free.
  await expect
    .poll(async () => (await beltEndInstructionsOn(page, upstreamId)) - collarBefore, {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'JUNCTION COLLAR PLOTTED poll'),
      intervals: [100, 250, 500],
      message:
        'JUNCTION COLLAR PLOTTED: the upstream end marks rose over the Source-plug baseline by exactly the collar disc and ring',
    })
    .toBe(COLLAR_INSTRUCTIONS);
  expect(
    await beltEndInstructionsOn(page, downstreamId),
    'JUNCTION COLLAR PLOTTED once: the downstream belt plots nothing, one junction draws one collar owned by the upstream Head',
  ).toBe(0);
  // THE COLLAR READ OFF THE CANVAS (the 77-02 refuter round, refuter 2). The two counts above say
  // how many instructions the belt Graphics holds, never WHERE they were drawn: a collar stroked
  // 9999 px away passed them. This reads the ring's own pixels on the seam's annulus, per quadrant
  // (`support/canvasDots.ts` `collarInk`), polled because the canvas draws a frame after the packet.
  await expect
    .poll(async () => (await collarOnCanvas(page, UP_HEAD, DOORSTEP)).quads.map((q) => q >= COLLAR_QUADRANT_MIN), {
      timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'COLLAR ON THE CANVAS poll'),
      intervals: [100, 250, 500],
      message: `COLLAR ON THE CANVAS: after the join the ring is drawn on the seam (7,12)|(8,12), at least ${COLLAR_QUADRANT_MIN} ring pixels in each quadrant`,
    })
    .toEqual([true, true, true, true]);
  console.log(`COLLAR_CANVAS before=${seamBefore.quads.join(',')} after=${(await collarOnCanvas(page, UP_HEAD, DOORSTEP)).quads.join(',')}`);
  await expectRenderLoopAlive(page, 'leg 2 after the press-on-end join');

  // 5. THE RUN SENTENCE, read from BOTH belts.
  await selectBeltAt(page, UP_TILE);
  await expect(
    page.locator('#fab-belt-run'),
    'ONE RUN OF 2 BELTS: the upstream belt\'s panel names the run in the shipped words',
  ).toHaveText(RUN_TWO_COPY);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await selectBeltAt(page, DOWN_TILE);
  await expect(
    page.locator('#fab-belt-run'),
    'ONE RUN OF 2 BELTS: the downstream belt\'s panel names the same run',
  ).toHaveText(RUN_TWO_COPY);
  await expectRenderLoopAlive(page, 'leg 2 after reading the run sentence');

  // 6. THE SLOWEST PACE, APPLIED ON THE DOWNSTREAM (D-11). The downstream panel is still open.
  const paceOf = (s: SceneFacts) => ({
    up: s.belts.find((b) => b.id === upstreamId)?.ticksPerSlot,
    down: s.belts.find((b) => b.id === downstreamId)?.ticksPerSlot,
  });
  const before = paceOf(await readScene(page));
  expect(
    [before.up, before.down].includes(SLOWEST_TICKS),
    `BOTH BELTS AT THE SLOWEST PACE: neither belt already sits at ${SLOWEST_TICKS} ticks per slot, or the poll below proves nothing (read ${JSON.stringify(before)})`,
  ).toBe(false);
  await pressSegment(page, 'Belt pace', SLOWEST_SEGMENT);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await pollScene(page, paceOf, {
    message: `BOTH BELTS AT THE SLOWEST PACE: one Apply on the downstream paced the whole run at ${SLOWEST_TICKS} ticks per slot`,
  }).toEqual({ up: SLOWEST_TICKS, down: SLOWEST_TICKS });
  await expectRenderLoopAlive(page, 'leg 2 after the pace Apply');

  // 7. THE FEED (D-12), with the recorder running FIRST so the growth is seen from empty belts.
  await startTickRecorder(page);
  await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
  await pressSegment(page, 'Trigger', 'Timer');
  await fillPanelField(page, 'fab-timer-interval', FEED_INTERVAL);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  // THE GROWTH ON THE CANVAS, SAMPLED WHILE IT HAPPENS (the 77-02 refuter round, refuter 6). The
  // recorder above copies the MODEL; the canvas is read here, in pixels of the six run tiles read off
  // the Pixi canvas in the page, once per animation frame, each capture stamped with the model tick
  // read in the callback whose frame it read (`openGrowthSampler`, plan 84-16: a CDP screenshot took
  // about 3.8 s at the GPU proxy, which is why plan 84-15 stopped), until the model is packed and a
  // capture has shown it whole, `GROWTH_GRACE_FRAMES` after the model packed, or `GROWTH_PACK_TICKS` with
  // the model never packed (`PACKED SOLID` then reddens at once). `CAPTURE IS ITS STAMPED FRAME`,
  // `GROWTH UNMEASURED` and `PACK GROWS ON THE CANVAS` grade the series below, after the model's grade.
  const viewportOf = (): Promise<number[]> => page.evaluate(() => [window.innerWidth, window.innerHeight]);
  const camBefore = await cameraOf(page);
  const viewBefore = await viewportOf();
  // The model's packed run read from a scene, exactly as `pOf` reads a recorder record (plan 84-17).
  const runOf = (sc: SceneFacts): number =>
    packedRun(
      sc.belts.find((b) => b.id === downstreamId)?.occupiedSlots ?? [],
      sc.belts.find((b) => b.id === upstreamId)?.occupiedSlots ?? [],
    );
  const sampler = await openGrowthSampler(page, runOf);
  // The two caps, derived (plan 84-18, D-12): the model's pack in ticks, the canvas after it in frames.
  const growthTimeoutMs = addWaitBudget(tickBudgetMs(GROWTH_PACK_TICKS), `growth: the model packs the run in ${GROWTH_PACK_TICKS} ticks`);
  const growthGraceMs = addWaitBudget(frameBudgetMs(GROWTH_GRACE_FRAMES), `growth: the canvas shows the packed run in ${GROWTH_GRACE_FRAMES} frames`);
  const growthStarted = Date.now();
  let modelPackedAt: number | null = null;
  for (;;) {
    const s = await sampler.capture();
    const packedNow =
      prefix(s.belts.find((b) => b.id === upstreamId)?.occupiedSlots ?? []) === BELT_SLOTS &&
      prefix(s.belts.find((b) => b.id === downstreamId)?.occupiedSlots ?? []) === BELT_SLOTS;
    if (packedNow && modelPackedAt === null) modelPackedAt = Date.now();
    if (modelPackedAt !== null && (sampler.shownWhole() || Date.now() - modelPackedAt > growthGraceMs)) break;
    if (Date.now() - growthStarted > growthTimeoutMs) break;
  }
  const { samples: growthSamples, stats: captureStats } = await sampler.finish();
  expect(
    { camera: await cameraOf(page), viewport: await viewportOf(), samples: growthSamples.length > 0 },
    'GROWTH SAMPLER HELD ITS CLIP: neither the camera nor the viewport moved while the run tiles were sampled, and the sampler took captures',
  ).toEqual({ camera: camBefore, viewport: viewBefore, samples: true });
  const growth = growthSamples.map((g) => g.dots);
  const latencies = growthSamples.map((g) => g.latencyMs).sort((a, b) => a - b);
  const tickGaps = growthSamples
    .slice(1)
    .map((g, i) => g.requestTick - growthSamples[i].requestTick)
    .sort((a, b) => a - b);
  // Each capture's round trip on the MODEL clock (plan 84-15): reply tick minus request tick.
  const roundTrips = growthSamples.map((g) => g.replyTick - g.requestTick).sort((a, b) => a - b);
  const at = (xs: number[], q: number): number | undefined => xs[Math.min(xs.length - 1, Math.floor(xs.length * q))];
  console.log(
    `PACK_GROWTH_SAMPLER samples=${growthSamples.length} ms=${Date.now() - growthStarted} ticks=${growthSamples[0]?.requestTick}..${growthSamples[growthSamples.length - 1]?.requestTick} tickGap p50=${at(tickGaps, 0.5)} p90=${at(tickGaps, 0.9)} max=${at(tickGaps, 1)} latencyMs p50=${at(latencies, 0.5)} max=${at(latencies, 1)} roundTripTicks p50=${at(roundTrips, 0.5)} p90=${at(roundTrips, 0.9)} max=${at(roundTrips, 1)}`,
  );
  // What each in-page read cost the page and whether it was its stamped frame (plan 84-16).
  const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
  const ms = (v: number | undefined): string => (v === undefined ? '-' : v.toFixed(1));
  const blockMs = sorted(captureStats.blockMs);
  const readbackFrames = sorted(captureStats.readbackFrames);
  const readbackMs = sorted(captureStats.readbackMs);
  console.log(
    `PACK_GROWTH_CAPTURE mode=${GROWTH_CAPTURE_MODE} context=${captureStats.context} captures=${captureStats.captures} unpaired=${captureStats.unpaired} flat=${captureStats.flat} blockMs p50=${ms(at(blockMs, 0.5))} p90=${ms(at(blockMs, 0.9))} max=${ms(at(blockMs, 1))} readbackFrames p50=${at(readbackFrames, 0.5)} max=${at(readbackFrames, 1)} readbackMs p50=${ms(at(readbackMs, 0.5))} max=${ms(at(readbackMs, 1))}`,
  );
  await pollScene(
    page,
    (s) => ({
      up: prefix(s.belts.find((b) => b.id === upstreamId)?.occupiedSlots ?? []),
      down: prefix(s.belts.find((b) => b.id === downstreamId)?.occupiedSlots ?? []),
    }),
    {
      timeout: 5_000,
      message: 'PACKED SOLID: both belts hold twelve contiguous items from the head end',
    },
  ).toEqual({ up: BELT_SLOTS, down: BELT_SLOTS });
  const recording = await readTickRecorder(page);
  await stopTickRecorder(page);
  await expectRenderLoopAlive(page, 'leg 2 with the run packed');

  // 8. THE PACK, GRADED FRONT TO BACK ON THE SIM CLOCK.
  const recs = recording.records;
  expect(recs.length, 'PACK ORDER STRICT: the recorder captured ticks').toBeGreaterThan(0);
  const pOf = (r: TickRecord): number =>
    packedRun(recordedBelt(r, downstreamId)?.[2] ?? [], recordedBelt(r, upstreamId)?.[2] ?? []);
  expect(
    pOf(recs[0]),
    'PACK ORDER STRICT: the recording opens on an empty run, so the growth below is seen from the start',
  ).toBe(0);
  const firsts = PACK_BOUNDARIES.map((k) => recs.find((r) => pOf(r) >= k)?.t ?? null);
  const pMax = Math.max(...recs.map(pOf));
  // For each boundary, the ticks the recorder missed just before its first record (plan 84-16): a
  // page stalled by a read starves the recorder, so a boundary's first RECORDED tick can be up to
  // this many ticks later than the tick it was reached.
  const boundaryGaps = PACK_BOUNDARIES.map((k) => {
    const j = recs.findIndex((r) => pOf(r) >= k);
    return j > 0 ? recs[j].t - recs[j - 1].t - 1 : '-';
  });
  console.log(
    `PACK_ORDER boundaries=${PACK_BOUNDARIES.join(',')} ticks=${firsts.join(',')} pmax=${pMax} records=${recs.length} missed=${recording.missed} boundaryGaps=${boundaryGaps.join(',')}`,
  );
  // THE STAGE BRACKETS (plan 84-17). The model's grade above stays the recorder's. The growth's
  // stages are placed by brackets: each boundary lies between the last reading below it and the first
  // at or above it, the readings being every recorder record and every capture's own reading of the
  // model on its stamped tick (`support/canvasDots.ts` `boundaryBrackets`).
  const readings = [
    ...recs.map((r) => ({ t: r.t, packed: pOf(r) })),
    ...growthSamples.flatMap((g) => (g.modelRun === null ? [] : [{ t: g.requestTick, packed: g.modelRun }])),
  ];
  const brackets = boundaryBrackets(readings, PACK_BOUNDARIES);
  expect(pMax, 'PACK ORDER STRICT: the packed stretch reaches the whole run, 24 slots').toBe(
    2 * BELT_SLOTS,
  );
  // Graded from the brackets (plan 84-18, D-12 "Grade from brackets"): each boundary
  // lies between the last reading below it and the first at or past it, and the order is broken
  // only when a boundary's bracket leaves no tick later than the one before it. A recorder that
  // missed 63 ticks put boundaries 4 and 8 on one record in run 5 without the pack being out of
  // order; a run that crosses two boundaries between consecutive readings still fails.
  const orderViolations = packOrderViolations(readings, PACK_BOUNDARIES);
  expect(
    orderViolations,
    `PACK ORDER STRICT: each tile boundary ${PACK_BOUNDARIES.join(', ')} is first reached on a LATER tick than the one before (first readings ${firsts.join(', ')}; brackets ${brackets.map((b) => (b === null ? '-' : `${b.lo}..${b.hi}`)).join(',')})`,
  ).toEqual([]);
  const joinedEvery = recs.every((r) => {
    const up = recordedBelt(r, upstreamId);
    const down = recordedBelt(r, downstreamId);
    return (
      up !== undefined &&
      down !== undefined &&
      up[3].some((d) => d.end === 'Head' && d.node === downstreamId) &&
      down[3].some((d) => d.end === 'Tail' && d.node === upstreamId)
    );
  });
  expect(joinedEvery, 'PACK ORDER STRICT: the junction read 1/1 on every recorded packet').toBe(true);
  const slowEvery = recs.every(
    (r) =>
      recordedBelt(r, upstreamId)?.[1] === SLOWEST_TICKS &&
      recordedBelt(r, downstreamId)?.[1] === SLOWEST_TICKS,
  );
  expect(
    slowEvery,
    `PACK ORDER STRICT: both belts read ${SLOWEST_TICKS} ticks per slot on every recorded packet`,
  ).toBe(true);
  await expectRenderLoopAlive(page, 'leg 2 after grading the pack');

  // 8b. THE PACK DRAWN ON THE CANVAS (D-04). Every read above is the MODEL's; an item layer
  // drawing nothing while the model packs passes all of them and both render-health helpers.
  // So the canvas is read in SCREEN PIXELS (`support/canvasDots.ts`): the growth sampled above,
  // and the packed run's visible dots per tile against the model's items per tile, both inside
  // ONE poll callback. Plan 77-02 read the particles' stored x and y instead, which a hidden,
  // zero-scale or transparent item layer still sets (the 77-02 refuter round, refuters 1 and 4).
  // After the model grade on purpose: a drawing defect reddens HERE, at its own token.
  const tileOrder = await readScene(page);
  expect(
    {
      up: tileOrder.belts.find((b) => b.id === upstreamId)?.tiles.map((t) => `${t.cell_x},${t.cell_y}`),
      down: tileOrder.belts.find((b) => b.id === downstreamId)?.tiles.map((t) => `${t.cell_x},${t.cell_y}`),
    },
    'TILES LIST TAIL FIRST: each run belt\'s tiles are listed from its Tail (the Source end, then the doorstep) to its Head',
  ).toEqual({ up: ['5,12', '6,12', '7,12'], down: ['8,12', '9,12', '10,12'] });
  // THE GROWTH AS THE CANVAS SHOWED IT (the 77-02 refuter round, refuter 6). Each sample's packed
  // depth is the run of tiles showing four visible dots from the head (10,12) back; items in
  // transit can bunch four to a tile behind a gap, so a full tile further back does not count
  // until every tile ahead of it is full. The depth never falls and passes through 0 to 6 one
  // tile at a time. A pack drawn filling from each belt's Source end jumps 0, 3, 6, and a pack
  // never drawn stays at 0, while the model's order above passes (`support/canvasDots.ts`).
  const grown = gradeGrowth(growth, RUN_HEAD_FIRST);
  console.log(`PACK_GROWTH samples=${grown.samples} stages=${grown.stages.join(',')} shrank=${JSON.stringify(grown.shrank)}`);
  // FIRST, WHETHER THE SAMPLES COULD SEE EVERY STAGE (plan 84-11, the 2026-10-09 CI run; plan 84-15).
  // Each stage lasts on the model from the tick its boundary was first reached up to, not including,
  // the next one's. Since plan 84-17 those ticks are bracketed (`brackets`, the `stageBounds` of the
  // PACK_GROWTH_RESOLUTION line): 84-16's series at the GPU proxy credited a stage with a capture of
  // the next depth twice in five runs, because the recorder, starved by the synchronous read, logged
  // a boundary's first tick up to 37 ticks after it was reached. A capture is now placed only on a
  // tick the model was certainly in a stage, between one bracket's `hi` and the next one's `lo`; a
  // capture strictly inside a bracket counts for no stage. A stage is seen only by a capture
  // requested AND answered while the model was in it: at R4 at the GPU proxy (plan 84-14)
  // stage 4 had captures requested inside it whose frames came back seconds later, none showed it,
  // and the request-only rule let the drawing's token below go red on a pack drawn rightly. A stage
  // no capture resolved could not have been seen, so a missing stage there is the sampling's
  // failure, named here, and never graded as the drawing's below; and never a pass
  // (`support/canvasDots.ts` `unresolvedStages`). `resolvedBy` counts the captures resolving each
  // stage and `depthsSeen` lists the distinct packed depths they read (`,` within a stage, `|`
  // between stages, `-` for none).
  const stageSamples = growthSamples.map(({ requestTick, replyTick }) => ({ requestTick, replyTick }));
  const resolving = resolvingSamples(stageSamples, brackets);
  const unresolved = unresolvedStages(stageSamples, brackets);
  const depthsSeen = resolving.map((by) => {
    const ds = [...new Set(by.map((i) => packedDepth(growthSamples[i].dots, RUN_HEAD_FIRST)))].sort((a, b) => a - b);
    return ds.length === 0 ? '-' : ds.join(',');
  });
  const stageOf = growthSamples.map((_, i) => resolving.findIndex((by) => by.includes(i)));
  const edge = (t: number): string => (t === Number.NEGATIVE_INFINITY ? '-inf' : String(t));
  const stageBounds = brackets.map((b) => (b === null ? '-' : `${edge(b.lo)}..${edge(b.hi)}`));
  const fromCaptures = growthSamples.filter((g) => g.modelRun !== null).length;
  const unplaced = stageOf.filter((st) => st < 0).length;
  console.log(
    `PACK_GROWTH_RESOLUTION stageTicks=${firsts.join(',')} stageBounds=${stageBounds.join(',')} fromCaptures=${fromCaptures} unplaced=${unplaced} unresolved=${unresolved.join(',')} resolvedBy=${resolving.map((by) => by.length).join(',')} depthsSeen=${depthsSeen.join('|')}`,
  );
  // Every capture that resolves no stage, or whose canvas packed depth is not the stage it resolves.
  const offstage = growthSamples.flatMap((g, i) => {
    const depth = packedDepth(g.dots, RUN_HEAD_FIRST);
    return stageOf[i] < 0 || depth !== stageOf[i]
      ? [`${g.requestTick}:${stageOf[i] < 0 ? '-' : stageOf[i]}:${depth}`]
      : [];
  });
  console.log(`PACK_GROWTH_OFFSTAGE captures=${offstage.join(',')}`);
  // THE PAIRING (plan 84-16): a capture is graded against the stage its stamp places it in, so its
  // pixels must be that stamp's frame. The item layer's `drawnAtTick`, read in the callback whose
  // frame was read, is the tick the drawn items came from; a cleared buffer reads as one flat value.
  expect(
    { unpaired: captureStats.unpaired, flat: captureStats.flat },
    `CAPTURE IS ITS STAMPED FRAME: every one of the ${captureStats.captures} growth captures was read on a frame the item layer drew from the tick it is stamped with, and none was a cleared buffer`,
  ).toEqual({ unpaired: 0, flat: 0 });
  expect(
    unresolved,
    `GROWTH UNMEASURED: every stage of the growth, 0 to 6 full tiles from the head, had at least one of the ${growthSamples.length} captures stamped on a tick the model was certainly in it (each boundary bracketed between the last reading below it and the first at or above it: ${stageBounds.join(', ')})`,
  ).toEqual([]);
  expect(
    { stages: grown.stages, shrank: grown.shrank },
    `PACK GROWS ON THE CANVAS: over ${grown.samples} screenshots of the run, the packed depth from the head (10,12) back never fell and went 0 to 6 one tile at a time`,
  ).toEqual({ stages: [0, 1, 2, 3, 4, 5, 6], shrank: null });
  const FULL: Record<string, number> = {};
  for (const [x, y] of RUN_CELLS) FULL[`${x},${y}`] = SLOTS_PER_TILE;
  await expect
    .poll(
      async () => {
        const drawn = await canvasDotsPerCell(page, RUN_CELLS);
        const model = modelItemsPerCell(await readScene(page), [upstreamId, downstreamId]);
        return { drawn, model };
      },
      {
        timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'PACK DRAWN ON THE CANVAS poll'),
        intervals: [100, 250, 500],
        message: 'PACK DRAWN ON THE CANVAS: every run tile shows, in screen pixels, the four dots the model holds there',
      },
    )
    .toEqual({ drawn: FULL, model: FULL });
  await expectRenderLoopAlive(page, 'leg 2 with the pack drawn');

  // 9. RECORD for the later legs.
  board.sourceId = source.id;
  board.upstreamBeltId = upstreamId;
  board.downstreamBeltId = downstreamId;
  errs.assertNone('during leg 2');
});

test('leg 3 - that run jams behind a Tee whose outlet is slowed, packs backwards, and clears when released', async () => {
  const page = sharedPage();

  // 1. THE HANDOFF, then the attach, then the board legs 1 and 2 left, MEASURED.
  const sourceId = required('sourceId', 'leg 2');
  const upstreamId = required('upstreamBeltId', 'leg 2');
  const downstreamId = required('downstreamBeltId', 'leg 2');
  const routeId = required('routeId', 'leg 1');
  const errs = await attachToRunningBoard(page, 'leg 3');
  const opened = await readScene(page);
  const cellsOf = (id: number): string[] | undefined =>
    opened.belts.find((b) => b.id === id)?.tiles.map((t) => `${t.cell_x},${t.cell_y}`);
  const prefixOf = (s: SceneFacts, id: number): number =>
    prefix(s.belts.find((b) => b.id === id)?.occupiedSlots ?? []);
  expect(
    {
      route: nodeAtAnchor(opened, ROUTE_CELL[0], ROUTE_CELL[1])?.id,
      handler: nodeAtAnchor(opened, HANDLER_CELL[0], HANDLER_CELL[1])?.kind,
      source: nodeAtAnchor(opened, SOURCE_CELL[0], SOURCE_CELL[1])?.id,
      up: cellsOf(upstreamId),
      down: cellsOf(downstreamId),
      junction: junction(opened),
      pace: runPace(opened, upstreamId, downstreamId),
      packed: { up: prefixOf(opened, upstreamId), down: prefixOf(opened, downstreamId) },
    },
    "leg 3 opens on the composed board: leg 2's packed run of 2 belts and leg 1's Route and Handler",
  ).toEqual({
    route: routeId,
    handler: KIND_HANDLER,
    source: sourceId,
    up: ['5,12', '6,12', '7,12'],
    down: ['8,12', '9,12', '10,12'],
    junction: '1/1',
    pace: { up: SLOWEST_TICKS, down: SLOWEST_TICKS },
    packed: { up: BELT_SLOTS, down: BELT_SLOTS },
  });
  await expectRenderLoopAlive(page, 'leg 3 on the board leg 2 left');

  // 2. THE RUN SPED BACK UP (D-14), from one belt's panel: one Apply paces the run (74 D-08).
  await selectBeltAt(page, DOWN_TILE);
  await pressSegment(page, 'Belt pace', FASTEST_SEGMENT);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await pollScene(page, (s) => runPace(s, upstreamId, downstreamId), {
    message: `RUN SPED BACK UP: one Apply paced both run belts at ${FASTEST_TICKS} ticks per slot`,
  }).toEqual({ up: FASTEST_TICKS, down: FASTEST_TICKS });
  await expectRenderLoopAlive(page, 'leg 3 after the run is sped back up');

  // 3. A TEE AND A SINK FROM THE PALETTE (D-13).
  await armAndPlaceAt(page, 'Tee', TEE_CELL[0], TEE_CELL[1]);
  await armAndPlaceAt(page, 'Sink', SINK_CELL[0], SINK_CELL[1]);
  await pollScene(
    page,
    (s) => ({
      tee: nodeAtAnchor(s, TEE_CELL[0], TEE_CELL[1])?.kind ?? -1,
      sink: nodeAtAnchor(s, SINK_CELL[0], SINK_CELL[1])?.kind ?? -1,
    }),
    { message: 'TEE AND SINK PLACED: a Tee (kind 3) at anchor (11,12) and a Sink (kind 7) at (16,12)' },
  ).toEqual({ tee: KIND_TEE, sink: KIND_SINK });
  const placed = await readScene(page);
  const tee = nodeAtAnchor(placed, TEE_CELL[0], TEE_CELL[1])!;
  const sink = nodeAtAnchor(placed, SINK_CELL[0], SINK_CELL[1])!;
  const teeIn = tee.ports.find((p) => p.role === ROLE_IN && p.medium === MEDIUM_MECHANICAL);
  const teeOut0 = tee.ports.find(
    (p) =>
      p.role === ROLE_OUT &&
      p.medium === MEDIUM_MECHANICAL &&
      p.cell_x === TEE_OUT0_CELL[0] &&
      p.cell_y === TEE_OUT0_CELL[1],
  );
  expect(
    {
      in: teeIn === undefined ? null : [teeIn.cell_x, teeIn.cell_y, teeIn.side],
      out0: teeOut0 === undefined ? null : [teeOut0.cell_x, teeOut0.cell_y, teeOut0.side],
    },
    "TEE AND SINK PLACED: the Tee's In faces W on (11,12) and its first Out faces E on (12,12)",
  ).toEqual({ in: [TEE_CELL[0], TEE_CELL[1], SIDE_W], out0: [TEE_OUT0_CELL[0], TEE_OUT0_CELL[1], SIDE_E] });
  await expectRenderLoopAlive(page, 'leg 3 after placing the Tee and the Sink');

  // 4. THE OUTLET, off the Tee's first Out, settled on its DOCK SET. The Tail dock carries the
  // ROUTING KEY 0, not the catalog index (77-RESEARCH.md Pitfall 5).
  await drawOffloadBelt(page, teeOut0 as PortFacts, OUTLET_CELLS);
  await pollScene(page, (s) => dockSet(beltAt(s, OUTLET_TILE)), {
    message: "OUTLET DOCKED: the outlet's Head docks the Sink's In and its Tail the Tee's first Out",
  }).toEqual([`Head@${sink.id}:0`, `Tail@${tee.id}:0`]);
  const outletId = beltAt(await readScene(page), OUTLET_TILE)!.id;
  await expectRenderLoopAlive(page, 'leg 3 after the outlet');

  // 5. THE RUN INTO THE TEE: the downstream belt's free Head dragged onto the Tee's In nub
  // (`22-stranded-reconnect.spec.ts`, a selected belt's end dragged onto a nub).
  await selectBeltAt(page, DOWN_TILE);
  const headPt = await screenCellCentre(page, DOWN_END[0], DOWN_END[1]);
  const nubPt = await screenPoint(page, nubAnchor(teeIn!.cell_x, teeIn!.cell_y, teeIn!.side));
  await page.mouse.move(headPt.x, headPt.y);
  await page.mouse.down();
  await page.mouse.move(nubPt.x, nubPt.y, { steps: 4 });
  await page.mouse.up();
  await pollScene(page, (s) => dockSet(s.belts.find((b) => b.id === downstreamId)), {
    message: "INLET DOCKED INTO THE TEE: the run's Head docks the Tee's In and its Tail stays on the upstream",
  }).toEqual([`Head@${tee.id}:0`, `Tail@${upstreamId}:0`]);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expectRenderLoopAlive(page, 'leg 3 after docking the run into the Tee');

  // 6. THE FEED AT EVERY 4 (D-14). The Trigger is already Timer (leg 2).
  await selectMachineAt(page, SOURCE_CELL[0], SOURCE_CELL[1]);
  await fillPanelField(page, 'fab-timer-interval', JAM_FEED_INTERVAL);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expectRenderLoopAlive(page, 'leg 3 after the feed is set');

  const ids: JamIds = { teeId: tee.id, inletId: downstreamId, upstreamId, outletId };
  console.log(
    `JAM_IDS source=${sourceId} upstream=${upstreamId} inlet=${downstreamId} tee=${tee.id} sink=${sink.id} outlet=${outletId}`,
  );

  // 7. THE FLOWING BASELINE, recorded BEFORE anything is slowed (D-14). The wait reads the
  // inlet's ITEM COUNT as well as its head: a packed run that is still moving delivers its head
  // on every advance, so its slot 0 reads empty too, and only the count says it has drained.
  await pollScene(
    page,
    (s) => {
      const inlet = s.belts.find((b) => b.id === downstreamId);
      return {
        headEmpty: inlet !== undefined && !inlet.occupiedSlots.includes(0),
        drained: inlet !== undefined && inlet.items <= FLOWING_INLET_MAX,
      };
    },
    {
      timeout: 30_000,
      message: `FLOWING BASELINE: leg 2's pack drained through the Tee to a flowing line, the inlet's head empty and at most ${FLOWING_INLET_MAX} items on it`,
    },
  ).toEqual({ headEmpty: true, drained: true });
  await startTickRecorder(page);
  await expect
    .poll(async () => (await readTickRecorder(page)).records.length, {
      timeout: 15_000,
      intervals: [100, 250, 500],
      message: `FLOWING BASELINE: the recorder holds ${BASELINE_RECORDS} records of the flowing line`,
    })
    .toBeGreaterThanOrEqual(BASELINE_RECORDS);
  const baseRec = await readTickRecorder(page);
  await stopTickRecorder(page);
  const base = flowingBaseline(baseRec.records, ids);
  console.log(
    `FLOWING_BASELINE records=${base.records} missed=${baseRec.missed} headOccupied=${base.headOccupied.toFixed(3)} ` +
      `inletMean=${base.inletMean.toFixed(2)} inletMax=${base.inletMax} upstreamMean=${base.upstreamMean.toFixed(2)} upstreamMax=${base.upstreamMax}`,
  );
  expect(
    {
      headFree: base.headOccupied <= BASELINE_HEAD_MAX,
      inletThin: base.inletMean <= FLOWING_INLET_MAX,
      upstreamThin: base.upstreamMean <= FLOWING_INLET_MAX,
    },
    `FLOWING BASELINE: over ${base.records} records the inlet's head was occupied on ${base.headOccupied.toFixed(3)} (at most ${BASELINE_HEAD_MAX}) and the run's belts held ${base.inletMean.toFixed(2)} and ${base.upstreamMean.toFixed(2)} items on average (at most ${FLOWING_INLET_MAX})`,
  ).toEqual({ headFree: true, inletThin: true, upstreamThin: true });
  await expectRenderLoopAlive(page, 'leg 3 with the line flowing');

  // 8. THE OUTLET SLOWED, the jam formed, and graded as FRACTIONS (the Tee emits one item per
  // outlet advance, so the jam is a drip, not a stop).
  await startTickRecorder(page, { gaugeOf: [tee.id] });
  await selectBeltAt(page, OUTLET_TILE);
  await pressSegment(page, 'Belt pace', SLOWEST_SEGMENT);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await pollScene(
    page,
    (s) => ({
      tee: s.nodes.find((n) => n.id === tee.id)?.state,
      inlet: prefixOf(s, downstreamId),
      up: prefixOf(s, upstreamId),
    }),
    {
      timeout: 30_000,
      message: 'THE JAM FORMS: the Tee reads BACKED_UP and both run belts hold twelve contiguous items from the head end',
    },
  ).toEqual({ tee: STATE_BACKED_UP, inlet: BELT_SLOTS, up: BELT_SLOTS });
  const formedAt = (recs: readonly TickRecord[]): number =>
    recs.findIndex(
      (r) =>
        recordedState(r, tee.id) === STATE_BACKED_UP &&
        prefix(recordedBelt(r, downstreamId)?.[2] ?? []) === BELT_SLOTS &&
        prefix(recordedBelt(r, upstreamId)?.[2] ?? []) === BELT_SLOTS,
    );
  await expect
    .poll(
      async () => {
        const recs = (await readTickRecorder(page)).records;
        const i = formedAt(recs);
        return i < 0 ? -1 : recs.length - i;
      },
      {
        timeout: 15_000,
        intervals: [100, 250, 500],
        message: `THE JAM FORMS: the recording holds the formed jam and ${JAM_RECORDS} records of it`,
      },
    )
    .toBeGreaterThanOrEqual(JAM_RECORDS);
  const jamRec = await readTickRecorder(page);
  await stopTickRecorder(page);
  await expectRenderLoopAlive(page, 'leg 3 with the line jammed');

  const recs = jamRec.records;
  const slowAt = recs.findIndex((r) => recordedBelt(r, outletId)?.[1] === SLOWEST_TICKS);
  const pack = packsBackwards(slowAt < 0 ? [] : recs.slice(slowAt), ids);
  const jamRecords = recs.slice(formedAt(recs));
  const fr = jamFractions(jamRecords, ids);
  console.log(
    `PACK_BACKWARDS slow=${slowAt < 0 ? 'none' : recs[slowAt].t} ticks=${pack.firsts.join(',')} records=${recs.length} missed=${jamRec.missed}`,
  );
  console.log(
    `JAM_FRACTIONS records=${fr.records} backedUp=${fr.backedUp.toFixed(3)} headHeld=${fr.headHeld.toFixed(3)} formed=${jamRecords[0]?.t}`,
  );
  console.log(pseudoRLine(jamRecords, ids));
  expect(
    pack.violations,
    `PACKS BACKWARDS: from the slow-pace record the packed stretch reaches each tile boundary on a later tick than the one before, none already met (${pack.firsts.join(', ')})`,
  ).toEqual([]);
  expect(
    fr.backedUp,
    `JAM HOLDS BACKED_UP: over ${fr.records} records of the formed jam the Tee read BACKED_UP on ${fr.backedUp.toFixed(3)}`,
  ).toBeGreaterThanOrEqual(JAM_BACKED_UP_MIN);
  expect(
    fr.headHeld,
    `FRONT TILE HELD: over ${fr.records} records of the formed jam the inlet's slot 0 was occupied on ${fr.headHeld.toFixed(3)}`,
  ).toBeGreaterThanOrEqual(JAM_HEAD_HELD_MIN);
  await expect
    .poll(async () => backedUpMarkPaintedOn(page, tee.id), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'MARK PAINTED poll'),
      intervals: [100, 250, 500],
      message: 'MARK PAINTED: the load gauge is painted on the jammed Tee',
    })
    .toBe(true);
  // THE MARK'S FORM, OFF THE CANVAS (D-04, plan 77-07). `MARK PAINTED` holds at gauge levels 1
  // to 3 too; the backed-up mark is the MERGED bar, one rect spanning the whole run, read off the
  // gauge Graphics into every record and keyed by the tick each form was drawn FROM (the model
  // runs about a frame ahead of the canvas, 77-MUTATION-PROOF.md "Plan 77-07 gauge lag
  // measurement"). The steady jam drips: the Tee drops to 15 of 16 for the one tick it emits into
  // the outlet, once per outlet advance, so the bar breaks on exactly those ticks. Graded against
  // the drips (plan 84-18, D-12 "Check against drips"): the bar may show broken
  // only on a frame drawn on a drip tick, so the grade does not depend on how many frames a slow
  // page happens to draw there (run 4 on CI: 3 of 18 frames landed on drips, 0.833 under the old
  // fixed 0.85 share).
  const jamFrom = jamRecords[0]?.t ?? Number.MAX_SAFE_INTEGER;
  const jamTo = jamRecords[jamRecords.length - 1]?.t ?? -1;
  const jamForms = gaugeFormsByDrawnTick(recs, tee.id);
  const jamGauge = mergedFraction(jamForms, jamFrom, jamTo);
  console.log(
    `GAUGE_JAM drawn=${jamGauge.drawn} merged=${jamGauge.merged} fraction=${jamGauge.fraction.toFixed(3)} from=${jamFrom} to=${jamTo}`,
  );
  const jamDrips = mergedBarAgainstDrips(recs, jamForms, ids, jamFrom, jamTo);
  console.log(
    `GAUGE_DRIPS pace=${jamDrips.pace} phase=${jamDrips.phase} drips=${jamDrips.drips.length} drawn=${jamDrips.drawn} merged=${jamDrips.merged} brokenOnDrips=${jamDrips.brokenOnDrips} violations=${jamDrips.violations.length}`,
  );
  expect(
    jamDrips.violations,
    `MERGED BAR ON THE CANVAS: of the ${jamDrips.drawn} ticks the canvas drew the steady jam from (${jamFrom} to ${jamTo}), the Tee's gauge Graphics held the one merged full bar on every frame but those drawn on a drip tick (${jamDrips.brokenOnDrips} broken there, drips every ${jamDrips.pace} ticks at ${jamDrips.phase})`,
  ).toEqual([]);
  // THE MARK SEEN ON SCREEN (the 77-03 refuter round, refuter 1). The two checks above read the
  // gauge Graphics, which a hidden gauge still holds. So the gauge band is screenshotted between
  // two reads of the Graphics that agree, and the merged bar must show in screen pixels: one run of
  // `ramp[4]` ink, the bar's width (`support/canvasDots.ts` `gaugeOnCanvas`). The steady jam breaks
  // the bar for a tick per drip, so a read that lands there is retried, never graded.
  // Each try is bracketed and pipelined (`screenBrackets`, plan 84-11), so the two Graphics reads lie
  // either side of the capture however long the capture takes to come back.
  let markTries = 0;
  let markLast = '';
  let markShown = false;
  const markShots = screenBrackets(
    page,
    () => gaugeClipOf(page, tee.cells),
    () => loadGaugeFormOn(page, tee.id),
    (px, clip) => ({ read: gaugeInPixels(px, clip), png: px.png }),
  );
  await expect
    .poll(
      async () => {
        markTries++;
        await markShots.take();
        const graded = markShots.settled().map((b) => {
          const steady = graphicsLevel(b.before) !== null && graphicsLevel(b.before) === graphicsLevel(b.after);
          return { b, steady, graphicsMerged: steady && b.before?.merged === true, screenMerged: b.screen.read.merged };
        });
        const hit = graded.find((g) => g.steady && g.graphicsMerged && g.screenMerged);
        const shown = hit ?? graded[graded.length - 1];
        if (shown !== undefined) {
          markLast = `graphics=${graphicsLevel(shown.b.before)} screen=${shown.b.screen.read.level} runs=${shown.b.screen.read.runs.join('+')} settled=${graded.length}`;
        }
        if (hit !== undefined && !markShown) {
          writeFileSync(test.info().outputPath('77-gauge-jam.png'), hit.b.screen.png());
          markShown = true;
        }
        return shown === undefined
          ? { steady: false, graphicsMerged: false, screenMerged: false }
          : { steady: shown.steady, graphicsMerged: shown.graphicsMerged, screenMerged: shown.screenMerged };
      },
      {
        // Derived (plan 84-18, D-12): the pipelined captures come back one after another, so
        // `CAPTURE_POLL_TRIES` of them at `CAPTURE_FRAMES` each, after the bar is drawn.
        timeout: addWaitBudget(
          frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES),
          `MARK SEEN ON SCREEN poll: ${CAPTURE_POLL_TRIES} captures`,
        ),
        intervals: [50, 100, 250],
        message: "MARK SEEN ON SCREEN: the jammed Tee's merged bar shows in screen pixels while its gauge Graphics holds it",
      },
    )
    .toEqual({ steady: true, graphicsMerged: true, screenMerged: true });
  // The captures still in flight come back before `all()` returns, each at `CAPTURE_FRAMES`.
  const markInFlight = markTries - markShots.settled().length;
  addFrameBudget(markInFlight * CAPTURE_FRAMES, `MARK SEEN ON SCREEN: ${markInFlight} captures in flight`);
  await markShots.all();
  console.log(`GAUGE_SCREEN jam tries=${markTries} ${markLast}`);
  // THE JAM DRAWN (D-04): the dots VISIBLE per run cell in screen pixels (the 77-02 refuter
  // round), against the model's items per cell, both read inside ONE callback.
  await expect
    .poll(
      async () => {
        const drawn = await canvasDotsPerCell(page, RUN_CELLS);
        const model = modelItemsPerCell(await readScene(page), [upstreamId, downstreamId]);
        return {
          same: JSON.stringify(drawn) === JSON.stringify(model),
          heldEverywhere: Object.values(model).every((n) => n >= 3),
          drawn,
          model,
        };
      },
      {
        // Derived (plan 84-18, D-12): one clip capture a try, `JAM_DRAWN_TRIES` tries.
        timeout: addWaitBudget(
          frameBudgetMs(JAM_DRAWN_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES),
          `JAM DRAWN ON THE CANVAS poll: ${JAM_DRAWN_TRIES} tries of one clip capture`,
        ),
        intervals: [100, 250, 500],
        message: 'JAM DRAWN ON THE CANVAS: the jammed run is plotted as the model holds it',
      },
    )
    .toMatchObject({ same: true, heldEverywhere: true });
  await expectRenderLoopAlive(page, 'leg 3 with the jam graded');

  // 9. THE RELEASE: the outlet back to the fastest pace. The line thins and then stays clear, on a
  // window placed after the thinning measured in this run. The ORDER in which the release reaches
  // the jam is logged, never asserted: the clause "clears from the front" is CUT by the maintainers' ruling of
  // 2026-10-08 and declared last in this file (header, CUT (D-15, ruling of 2026-10-08)).
  await startTickRecorder(page, { gaugeOf: [tee.id], itemDots: true });
  await startFrameTicks(page);
  await selectBeltAt(page, OUTLET_TILE);
  await pressSegment(page, 'Belt pace', FASTEST_SEGMENT);
  await applyConfig(page);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expect
    .poll(
      async () => {
        const r = (await readTickRecorder(page)).records;
        const thin = thinningTicks(r, ids);
        if (thin.some((t) => t === null)) return `thinning ${thin.join(',')}`;
        const latest = Math.max(...(thin as number[]));
        const after = r.filter((x) => x.t > latest).length;
        const win = releaseSustained(r, ids, latest + SUSTAIN_MARGIN_TICKS, SUSTAIN_WINDOW_RECORDS);
        // The drawn grade below reads the frames from the sustained window's start on, so the
        // recording runs on until the page has drawn enough of them (plan 84-11).
        const drawnFrames =
          win.from === null
            ? 0
            : frameTicksDuring(await readFrameTicks(page), win.from, Number.MAX_SAFE_INTEGER);
        return after >= SUSTAIN_AFTER_RECORDS &&
          win.count === SUSTAIN_WINDOW_RECORDS &&
          drawnFrames >= DRAWN_ALIGNED_MIN + DRAWN_FRAMES_HEADROOM
          ? 'thinned and followed'
          : `thinned ${thin.join(',')} with ${after} records and ${drawnFrames} page frames after`;
      },
      {
        // Derived, not picked (D-12, review 84 WR-03): the page frames at the frame floor plus
        // the sim ticks at the tick floor; the two run together, so their sum is a ceiling. It
        // is added to the test's limit, so this message fires before the test's timeout can.
        timeout: addWaitBudget(
          frameBudgetMs(DRAWN_ALIGNED_MIN + DRAWN_FRAMES_HEADROOM) + tickBudgetMs(RELEASE_POLL_TICKS),
          'RELEASE SUSTAINED poll',
        ),
        intervals: [250, 500],
        message: `RELEASE SUSTAINED: every run tile thinned after the release and ${SUSTAIN_AFTER_RECORDS} records followed the last`,
      },
    )
    .toBe('thinned and followed');
  const relRec = await readTickRecorder(page);
  await stopTickRecorder(page);
  const relFrameTicks = await stopFrameTicks(page);
  const rel = relRec.records;
  const grade = gradeReleaseOrder(rel, ids, FASTEST_TICKS);
  console.log(releaseOrderLine(grade));
  const lag = gaugeLag(rel, tee.id);
  console.log(`GAUGE_LAG max=${lag.max} median=${lag.median} records=${lag.records}`);
  const R = grade.R ?? rel[0].t;
  const gaps: number[] = [];
  for (let i = 1; i < rel.length; i++) {
    for (let t = rel[i - 1].t + 1; t < rel[i].t; t++) if (Math.abs(t - R) <= 10) gaps.push(t - R);
  }
  const gapWords = gaps.map((g) => (g < 0 ? 'R' + String(g) : 'R+' + String(g)));
  console.log(
    'RELEASE_GAPS missedNearR=' +
      (gapWords.length === 0 ? 'none' : gapWords.join(',')) +
      ' missedTotal=' +
      String(relRec.missed),
  );
  const thin = thinningTicks(rel, ids) as number[];
  const thinWords = RUN_CELLS.map(
    ([x, y], i) => String(x) + ',' + String(y) + '=' + String(thin[i]) + '(R+' + String(thin[i] - R) + ')',
  );
  console.log('RELEASE_THINNING ' + thinWords.join(' '));
  const latestThin = Math.max(...thin);
  const win = releaseSustained(rel, ids, latestThin + SUSTAIN_MARGIN_TICKS, SUSTAIN_WINDOW_RECORDS);
  console.log(
    `RELEASE_SUSTAINED latestThin=${latestThin} from=${win.from} to=${win.to} teeOff=${win.teeOff.toFixed(3)} headEmpty=${win.headEmpty.toFixed(3)}`,
  );
  const rIndex = Math.max(0, rel.findIndex((r) => r.t >= R) - 10);
  writeFileSync(
    test.info().outputPath('77-release-trace.json'),
    JSON.stringify({ ids, R, records: trimToJam(rel.slice(rIndex), ids) }),
  );
  writeFileSync(
    test.info().outputPath('77-jam-trace.json'),
    JSON.stringify({ ids, records: trimToJam(jamRecords, ids) }),
  );
  expect(
    { teeOff: win.teeOff >= RELEASED_MIN, headEmpty: win.headEmpty >= RELEASED_MIN, records: win.count },
    `RELEASE SUSTAINED: over the ${win.count} records from tick ${win.from} (the latest tile thinned at ${latestThin}) the Tee was off BACKED_UP on ${win.teeOff.toFixed(3)} and the inlet's slot 0 empty on ${win.headEmpty.toFixed(3)}`,
  ).toEqual({ teeOff: true, headEmpty: true, records: SUSTAIN_WINDOW_RECORDS });
  // IT STAYS RELEASED (D-15): the release has a witness, FRONT FREE (the first record after R with
  // the Tee off BACKED_UP and the inlet's head slot empty), and from it to the sustained window's
  // last record the Tee never reads BACKED_UP again. Only the ORDER is cut (header); with no witness
  // the window below would be empty and pass on nothing, so the witness is part of the grade.
  const relapse = rel
    .filter((r) => r.t >= (grade.frontFree ?? Number.MAX_SAFE_INTEGER) && r.t <= (win.to ?? -1))
    .filter((r) => recordedState(r, tee.id) === STATE_BACKED_UP)
    .map((r) => r.t);
  console.log(`STAYS_RELEASED from=${grade.frontFree} to=${win.to} backedUpAt=${relapse.length === 0 ? 'none' : relapse.join(',')}`);
  expect(
    { witness: grade.frontFree !== null, backedUpAt: relapse },
    `STAYS RELEASED: from FRONT FREE (tick ${grade.frontFree}) to the sustained window's end (tick ${win.to}) the Tee never read BACKED_UP again`,
  ).toEqual({ witness: true, backedUpAt: [] });
  // THE MARK BROKEN, OFF THE CANVAS (D-04, plan 77-07): no frame drawn from the release witness
  // (FRONT FREE) on holds the merged bar, and at least one frame was drawn there, as plan 77-07
  // specified. The witness is read whether or not the clause is cut: the cut drops only the order
  // (header). Measured on the 13 releases of the 77-03 refuter round: the latest merged bar was drawn at
  // R itself, with the Tee still BACKED_UP (one run), never at or after FRONT FREE. Forms keyed by
  // their drawn tick.
  const relForms = gaugeFormsByDrawnTick(rel, tee.id);
  const brokenFrom = grade.frontFree ?? win.from ?? Number.MAX_SAFE_INTEGER;
  const flowFrom = win.from ?? Number.MAX_SAFE_INTEGER;
  const sinceR = mergedFraction(relForms, R, Number.MAX_SAFE_INTEGER);
  const inWindow = mergedFraction(relForms, brokenFrom, Number.MAX_SAFE_INTEGER);
  console.log(
    `GAUGE_RELEASE fromR drawn=${sinceR.drawn} merged=${sinceR.merged} window from=${brokenFrom} drawn=${inWindow.drawn} merged=${inWindow.merged}`,
  );
  expect(
    gaugeReleaseViolations(relForms, brokenFrom),
    `BAR BROKEN ON THE CANVAS: from tick ${brokenFrom}, the release witness, the Tee's gauge Graphics drew no merged bar on any of the ${inWindow.drawn} ticks the canvas drew`,
  ).toEqual([]);
  // THE BAR SEEN BROKEN ON SCREEN (the 77-03 refuter round, refuter 1): ten screenshots of the
  // gauge band in the flowing window. None may show the merged bar, and on every one taken between
  // two agreeing reads of the Graphics the screen shows the level the Graphics holds. A gauge that
  // kept the merged bar on screen after the release reddens here.
  // Taken bracketed and pipelined (`screenBrackets`, plan 84-11): one screenshot took about 1 s
  // pinned to two cores and 2.5 to 3.0 s at a 100% CPU quota, so ten taken one after another did
  // not fit the 10 s (9 pinned), and the poll counts the captures that have come back.
  const brokenReads = screenBrackets(
    page,
    () => gaugeClipOf(page, tee.cells),
    () => loadGaugeFormOn(page, tee.id),
    (px, clip) => ({ read: gaugeInPixels(px, clip), png: px.png }),
  );
  let brokenTaken = 0;
  await expect
    .poll(
      async () => {
        brokenTaken++;
        await brokenReads.take();
        return brokenReads.settled().length;
      },
      {
        // Derived (plan 84-18, D-12): `BROKEN_SHOTS` captures, answered one after another.
        timeout: addWaitBudget(
          frameBudgetMs(BROKEN_SHOTS * CAPTURE_FRAMES),
          `BAR SEEN BROKEN ON SCREEN poll: ${BROKEN_SHOTS} captures`,
        ),
        intervals: [100],
        message: 'BAR SEEN BROKEN ON SCREEN: ten screenshots of the gauge band taken',
      },
    )
    .toBeGreaterThanOrEqual(BROKEN_SHOTS);
  // The captures still in flight come back before `all()` returns, each at `CAPTURE_FRAMES`.
  const brokenInFlight = brokenTaken - brokenReads.settled().length;
  addFrameBudget(brokenInFlight * CAPTURE_FRAMES, `BAR SEEN BROKEN ON SCREEN: ${brokenInFlight} captures in flight`);
  const brokenBrackets = await brokenReads.all();
  writeFileSync(test.info().outputPath('77-gauge-released.png'), brokenBrackets[0].screen.png());
  const brokenShots = brokenBrackets.map((b) => ({
    steady: graphicsLevel(b.before) !== null && graphicsLevel(b.before) === graphicsLevel(b.after),
    graphics: graphicsLevel(b.before),
    screen: b.screen.read.level,
    merged: b.screen.read.merged,
  }));
  console.log(
    `GAUGE_SCREEN released ${brokenShots.map((b) => `${b.steady ? 's' : 'u'}${b.graphics}/${b.screen}`).join(' ')}`,
  );
  expect(
    {
      mergedOnScreen: brokenShots.filter((b) => b.merged).length,
      steady: brokenShots.filter((b) => b.steady).length >= 5,
      disagreeing: brokenShots.filter((b) => b.steady && b.screen !== b.graphics).length,
    },
    `BAR SEEN BROKEN ON SCREEN: of ${brokenShots.length} screenshots of the gauge band after the release, none shows the merged bar and each taken between two agreeing Graphics reads shows the level the Graphics holds`,
  ).toEqual({ mergedOnScreen: 0, steady: true, disagreeing: 0 });
  // THE RUN DRAWN AFTER THE RELEASE (the 77-03 refuter round, refuter 3). The release clause and
  // the close were graded on the model alone, so an item layer that kept drawing the packed jam
  // passed both. Each drawn frame the recorder copied from the flowing window on is graded against
  // the model OF THE TICK IT WAS DRAWN FROM, as leg 4 grades its run (`support/itemFrames.ts`).
  const runWatched: WatchedBelt[] = [
    { id: upstreamId, cells: RUN_CELLS.slice(0, 3) },
    { id: downstreamId, cells: RUN_CELLS.slice(3) },
  ];
  const relSlice = rel.filter((r) => r.t >= flowFrom);
  const relDrawn = gradeDrawnItems(relSlice, runWatched, CELL);
  const relRate = relDrawn.aligned === 0 ? 0 : relDrawn.matched / relDrawn.aligned;
  const relCover = drawnCoverage(relSlice);
  const relFrames = frameTicksDuring(relFrameTicks, relSlice[0]?.t ?? Number.MAX_SAFE_INTEGER, relCover.lastRecord);
  console.log(
    `RELEASE_DRAWN ${drawnItemsLine(relDrawn)} records=${relCover.records} pageFrames=${relFrames} lastRecord=${relCover.lastRecord} lastDrawn=${relCover.lastDrawn} framesAfterDrawn=${framesAfterDrawn(relCover, relFrameTicks)}`,
  );
  if (relDrawn.mismatches.length > 0) console.log(`RELEASE_DRAWN_MISMATCH ${JSON.stringify(relDrawn.mismatches.slice(0, 3))}`);
  expect(
    {
      moving: relDrawn.distinctDrawn >= RUN_DISTINCT_MIN,
      graded: relDrawn.aligned >= DRAWN_ALIGNED_MIN,
      matching: relRate >= DRAWN_MATCH_MIN,
      carried: relDrawn.matchedWithItems >= 1,
      current: drawnCurrent(relCover, relFrameTicks),
      covered: relDrawn.frames >= DRAWN_COVER_MIN * Math.min(relCover.records, relFrames),
    },
    `RUN DRAWN AFTER THE RELEASE: of ${relDrawn.frames} frames drawn from tick ${flowFrom} on (${relCover.records} records, ${relFrames} page frames with a new tick, the last at ${relCover.lastRecord}, the latest frame drawn at ${relCover.lastDrawn} with ${framesAfterDrawn(relCover, relFrameTicks)} page frames after it), ${relDrawn.aligned} were graded against the model of their drawn tick and ${relDrawn.matched} matched it cell for cell (${relRate.toFixed(3)}, at least ${DRAWN_MATCH_MIN}), over ${relDrawn.distinctDrawn} distinct drawn dot sets`,
  ).toEqual({ moving: true, graded: true, matching: true, carried: true, current: true, covered: true });
  await expectRenderLoopAlive(page, 'leg 3 after the release');

  // 10. THE CLOSE, RELEASED AND FLOWING (D-16), graded at steady state past the Sink's inbox.
  await startTickRecorder(page, { itemDots: true });
  await startFrameTicks(page);
  // The drawn grade below reads the frames from the record where items reached the Sink end on,
  // so the recording runs on until the page has drawn enough of them as well (plan 84-12, the
  // release window's rule from plan 84-11). A count of records alone measured the frame rate: at
  // a frame every seven ticks (the CI-shaped proxy, the GPU process held to a tenth of its time)
  // the 160 records held 27 page frames, fewer than `DRAWN_ALIGNED_MIN`, every one matching.
  const closeFramesWanted = DRAWN_ALIGNED_MIN + DRAWN_FRAMES_HEADROOM;
  await expect
    .poll(
      async () => {
        const r = (await readTickRecorder(page)).records;
        const i = r.findIndex((x) => (recordedBelt(x, outletId)?.[2] ?? []).some((s) => s <= 2));
        if (i < 0) return 'no item at the Sink end yet';
        const after = r.length - 1 - i;
        const drawnFrames = frameTicksDuring(await readFrameTicks(page), r[i].t, Number.MAX_SAFE_INTEGER);
        return after >= CLOSE_AFTER_RECORDS && drawnFrames >= closeFramesWanted
          ? 'reached and followed'
          : `reached with ${after} records and ${drawnFrames} page frames after`;
      },
      {
        // Derived, not picked (D-12, review 84 WR-03), and added to the test's limit, as the
        // release poll's cap is.
        timeout: addWaitBudget(frameBudgetMs(closeFramesWanted) + tickBudgetMs(CLOSE_POLL_TICKS), 'ENDS FLOWING poll'),
        intervals: [100, 250, 500],
        message: `ENDS FLOWING: items reached the Sink end of the outlet and ${CLOSE_AFTER_RECORDS} records and ${closeFramesWanted} page frames followed`,
      },
    )
    .toBe('reached and followed');
  const closeRec = await readTickRecorder(page);
  await stopTickRecorder(page);
  const closeFrameTicks = await stopFrameTicks(page);
  const last = closeRec.records.slice(-CLOSE_WINDOW_RECORDS);
  const steady = outletSteadyReading(last, outletId);
  const closing = releaseSustained(last, ids, last[0].t, CLOSE_WINDOW_RECORDS);
  console.log(
    `OUTLET_STEADY slot0=${steady.slot0.toFixed(3)} grow=${steady.grow} changes=${steady.changes} teeOff=${closing.teeOff.toFixed(3)} headEmpty=${closing.headEmpty.toFixed(3)}`,
  );
  expect(
    {
      teeOff: closing.teeOff >= RELEASED_MIN,
      headEmpty: closing.headEmpty >= RELEASED_MIN,
      outlet: outletSteadyViolations(last, outletId),
    },
    `ENDS FLOWING: over the last ${last.length} records the Tee was off BACKED_UP on ${closing.teeOff.toFixed(3)}, the inlet's slot 0 empty on ${closing.headEmpty.toFixed(3)}, and the outlet drained into the Sink`,
  ).toEqual({ teeOff: true, headEmpty: true, outlet: [] });
  // THE CLOSE AS DRAWN (the 77-03 refuter round, refuter 3): the run and the outlet's drawn frames
  // against the model of their drawn ticks, from the record where items first reached the Sink end.
  const closeWatched: WatchedBelt[] = [...runWatched, { id: outletId, cells: OUTLET_CELLS }];
  const reachedAt = closeRec.records.findIndex((x) => (recordedBelt(x, outletId)?.[2] ?? []).some((s) => s <= 2));
  const closeSlice = closeRec.records.slice(Math.max(0, reachedAt));
  const closeDrawn = gradeDrawnItems(closeSlice, closeWatched, CELL);
  const closeRate = closeDrawn.aligned === 0 ? 0 : closeDrawn.matched / closeDrawn.aligned;
  const closeCover = drawnCoverage(closeSlice);
  const closeFrames = frameTicksDuring(closeFrameTicks, closeSlice[0]?.t ?? Number.MAX_SAFE_INTEGER, closeCover.lastRecord);
  console.log(
    `CLOSE_DRAWN ${drawnItemsLine(closeDrawn)} records=${closeCover.records} pageFrames=${closeFrames} lastRecord=${closeCover.lastRecord} lastDrawn=${closeCover.lastDrawn} framesAfterDrawn=${framesAfterDrawn(closeCover, closeFrameTicks)}`,
  );
  if (closeDrawn.mismatches.length > 0) console.log(`CLOSE_DRAWN_MISMATCH ${JSON.stringify(closeDrawn.mismatches.slice(0, 3))}`);
  expect(
    {
      moving: closeDrawn.distinctDrawn >= RUN_DISTINCT_MIN,
      graded: closeDrawn.aligned >= DRAWN_ALIGNED_MIN,
      matching: closeRate >= DRAWN_MATCH_MIN,
      carried: closeDrawn.matchedWithItems >= 1,
      current: drawnCurrent(closeCover, closeFrameTicks),
      covered: closeDrawn.frames >= DRAWN_COVER_MIN * Math.min(closeCover.records, closeFrames),
    },
    `RUN DRAWN AT THE CLOSE: of ${closeDrawn.frames} frames drawn after items reached the Sink end (${closeCover.records} records, ${closeFrames} page frames with a new tick, the last at ${closeCover.lastRecord}, the latest frame drawn at ${closeCover.lastDrawn} with ${framesAfterDrawn(closeCover, closeFrameTicks)} page frames after it), ${closeDrawn.aligned} were graded against the model of their drawn tick and ${closeDrawn.matched} matched it cell for cell (${closeRate.toFixed(3)}, at least ${DRAWN_MATCH_MIN}), over ${closeDrawn.distinctDrawn} distinct drawn dot sets`,
  ).toEqual({ moving: true, graded: true, matching: true, carried: true, current: true, covered: true });
  // THE PLACED DOTS ARE THE VISIBLE ONES at the close: the frames above are positions the item
  // layer STORED, which a hidden layer stores too. So the dots visible in screen pixels on the run
  // and the outlet equal the placed ones, on a screenshot taken between two reads of the placed
  // dots that agree (leg 4's `ITEMS VISIBLE ON THE CANVAS`, here on leg 3's released board).
  const closeCells = closeWatched.flatMap((b) => b.cells);
  // Each try is bracketed and pipelined (`screenBrackets`, plan 84-11): the two placed reads lie
  // either side of the capture however long it takes to come back. With the capture inside the
  // bracket the read took about 1 s pinned to two cores and 2.5 to 3.0 s at a 100% CPU quota, and
  // two placed reads that far apart rarely agree on a flowing belt (84-10's full pass: `steady`
  // false for the whole 15 s).
  let closeTries = 0;
  let closeLast = '';
  const closeReads = screenBrackets(
    page,
    () => clipOfCells(page, closeCells),
    async () => plottedOn(await itemDotsPerCell(page), closeCells),
    (px, clip) => dotsInClip(px, clip, closeCells),
  );
  await expect
    .poll(
      async () => {
        closeTries++;
        await closeReads.take();
        return visibleAgreement(closeReads.settled(), (line) => {
          closeLast = line;
        });
      },
      {
        timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'RUN VISIBLE AT THE CLOSE poll'),
        intervals: [50, 100, 250],
        message: `RUN VISIBLE AT THE CLOSE: on the ${closeCells.length} run and outlet tiles the dots visible in screen pixels equal the dots the item layer placed, with items on the belts`,
      },
    )
    .toEqual({ steady: true, same: true, carried: true });
  // The captures still in flight come back before `all()` returns, each at `CAPTURE_FRAMES` (plan 84-18).
  const closeInFlight = closeTries - closeReads.settled().length;
  addFrameBudget(closeInFlight * CAPTURE_FRAMES, `RUN VISIBLE AT THE CLOSE: ${closeInFlight} captures in flight`);
  await closeReads.all();
  console.log(`CLOSE_VISIBLE tries=${closeTries} ${closeLast}`);
  await expectRenderLoopAlive(page, 'leg 3 released and flowing');

  // 11. RECORD for the later legs (plan 77-04 step (1) reads exactly these).
  const final = await readScene(page);
  board.teeId = tee.id;
  board.sinkId = sink.id;
  board.outletBeltId = outletId;
  board.teeAnchor = [TEE_CELL[0], TEE_CELL[1]];
  board.outletDocks = dockSetByAnchor(final, final.belts.find((b) => b.id === outletId));
  errs.assertNone('during leg 3');
  console.log(captureCostLine());
});

test('leg 4 - a label beside the belt keeps its words, size and colour through save and reload while items run past it untouched', async () => {
  const page = sharedPage();

  // 1. THE HANDOFF, then the attach, then the board legs 1 to 3 left, MEASURED.
  const routeId = required('routeId', 'leg 1');
  const leg1Cables = required('leg1CableCells', 'leg 1');
  const sourceId = required('sourceId', 'leg 2');
  const downstreamId = required('downstreamBeltId', 'leg 2');
  const teeId = required('teeId', 'leg 3');
  const sinkId = required('sinkId', 'leg 3');
  const outletBeltId = required('outletBeltId', 'leg 3');
  const outletDocks = required('outletDocks', 'leg 3');
  const errs = await attachToRunningBoard(page, 'leg 4');
  const opened = await readScene(page);
  const openedTopo = composedTopology(opened);
  const openedIds = idsByPlace(opened);
  console.log(`COMP_LEG4_OPEN ${JSON.stringify(openedTopo.belts)} ids=${JSON.stringify(openedIds)}`);
  expect(
    {
      ids: {
        route: openedIds.route,
        source: openedIds.source,
        inlet: openedIds.inlet,
        tee: openedIds.tee,
        sink: openedIds.sink,
        outlet: openedIds.outlet,
      },
      nodes: openedTopo.nodes,
      belts: openedTopo.belts,
      outletDocks: dockSetByAnchor(opened, opened.belts.find((b) => b.id === outletBeltId)),
      cables: openedTopo.cables,
    },
    "leg 4 opens on the composed board: legs 1 to 3's machines and belts, docked as legs 2 and 3 left them, and leg 1's cables",
  ).toEqual({
    ids: { route: routeId, source: sourceId, inlet: downstreamId, tee: teeId, sink: sinkId, outlet: outletBeltId },
    nodes: [
      { kind: KIND_SOURCE, anchor: `${SOURCE_CELL[0]},${SOURCE_CELL[1]}` },
      { kind: KIND_TEE, anchor: `${TEE_CELL[0]},${TEE_CELL[1]}` },
      { kind: KIND_SINK, anchor: `${SINK_CELL[0]},${SINK_CELL[1]}` },
      { kind: KIND_ROUTE, anchor: `${ROUTE_CELL[0]},${ROUTE_CELL[1]}` },
      { kind: KIND_HANDLER, anchor: `${HANDLER_CELL[0]},${HANDLER_CELL[1]}` },
    ],
    belts: {
      '5,12 6,12 7,12': ['Head@belt8,12:0', 'Tail@node4,12:0'],
      '8,12 9,12 10,12': ['Head@node11,12:0', 'Tail@belt5,12:0'],
      '13,12 14,12 15,12': ['Head@node16,12:0', 'Tail@node11,12:0'],
    },
    outletDocks,
    cables: leg1Cables,
  });
  await expectRenderLoopAlive(page, 'leg 4 on the board leg 3 left');

  // 2. A LABEL BESIDE THE BELT, by hand from the palette, on the free row under the run.
  await handPlaceAt(page, 'Label', LABEL_CELL[0], LABEL_CELL[1]);
  await pollScene(page, (s) => labelFacts(s).map((l) => l.anchor), {
    message: `the real host echoed ONE label anchored at (${LABEL_CELL[0]},${LABEL_CELL[1]})`,
  }).toEqual([`${LABEL_CELL[0]},${LABEL_CELL[1]}`]);
  const labelId = nodeAtAnchor(await readScene(page), LABEL_CELL[0], LABEL_CELL[1])!.id;
  await expect(page.locator('#fab-label-text'), 'the placed label focuses its Text field').toBeFocused();
  await page.keyboard.type(LABEL_TEXT);
  await page.getByRole('button', { name: 'Lilac', exact: true }).click();
  const wider = page.getByRole('button', { name: 'Increase width', exact: true });
  await wider.click();
  await wider.click();
  await page.getByRole('button', { name: 'Increase depth', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await pollScene(page, labelFacts, {
    message: `LABEL PLACED AS APPLIED: one label at (${LABEL_CELL[0]},${LABEL_CELL[1]}) over the 12 cells of a ${LABEL_W} by ${LABEL_H} box, holding "${LABEL_TEXT}" in Lilac`,
  }).toEqual([
    {
      anchor: `${LABEL_CELL[0]},${LABEL_CELL[1]}`,
      cells: LABEL_CELLS,
      label: { text: LABEL_TEXT, colour: LILAC_BYTE },
    },
  ]);
  await expectRenderLoopAlive(page, 'leg 4 after the label is applied');
  // D-04: the box and the words as DRAWN, beside the model, each polled (the box re-plots on
  // the frame after the packet lands).
  await expect
    .poll(async () => labelBoxOn(page, labelId), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'LABEL DRAWN poll'),
      intervals: [100, 250, 500],
      message: `LABEL DRAWN: the label-box Graphics plotted the Lilac ${LABEL_W} by ${LABEL_H} box at its anchor`,
    })
    .toMatchObject(LABEL_BOX_EXPECTED);
  await expect
    .poll(async () => {
      const w = await labelWordsOf(page, labelId);
      return w === null ? null : { text: w.text, visible: w.visible };
    }, {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: `LABEL DRAWN: the words overlay shows "${LABEL_TEXT}" on the label`,
    })
    .toEqual({ text: LABEL_TEXT, visible: true });
  // D-04, ON SCREEN (the 77-04 refuter round, refuters 2 and 3). The two reads above are the box
  // Graphics' instructions and the words' DOM text, and a box set invisible or words at opacity 0
  // pass both. So the label's own cells are read in screen pixels: the Lilac box and the words.
  let placedOnScreen = '';
  await expect
    .poll(
      async () => {
        const r = await labelOnScreen(page);
        placedOnScreen = labelScreenLine(r);
        return { box: r.boxDrawn, words: r.wordsDrawn };
      },
      {
        timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'LABEL SEEN ON SCREEN poll'),
        intervals: [100, 250, 500],
        message: `LABEL SEEN ON SCREEN: the label's cells show the Lilac box, stroked on all four sides and filled at alpha 0.16, and the words "${LABEL_TEXT}"`,
      },
    )
    .toEqual({ box: true, words: true });
  console.log(`LABEL_SCREEN placed ${placedOnScreen}`);
  // NO MACHINE COUNT HERE (phase 91 review WR-C02). A read stood here for the folded todo about
  // the bottom-right readout counting a label as a machine; plan 91-03 deleted that readout, and
  // the replacement read applied the label filter itself and compared a model tick with itself, so
  // it could not fail on what it named. The board's five machines and the label are graded by kind
  // and anchor after the Load (`ONLY THE LOAD REBUILDS`), and the label's box and words here.
  const boxBefore = await labelBoxOn(page, labelId);
  const wordsBefore = await labelWordsOf(page, labelId);
  const beforeSave = { box: boxBefore, words: wordsAt(wordsBefore) };
  await expectRenderLoopAlive(page, 'leg 4 with the label drawn');

  // 3. THE SAVE, to a real file, the dialog asserted to fire. A click on empty floor first, so
  // the shortcut reaches the board rather than the label panel. On a flowing board the save
  // drains first (up to 512 ticks, `sim_loop.rs`), writes the file and runs on (D-08).
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  // The label as the screen shows it with nothing selected: the reference LABEL BACK ON SCREEN
  // compares the reloaded label's words with.
  const screenBeforeSave = await labelOnScreen(page);
  console.log(`LABEL_SCREEN beforeSave ${labelScreenLine(screenBeforeSave)}`);
  const topoBeforeSave = composedTopology(await readScene(page));
  const tickAtSave = (await readScene(page)).tick;
  const savePath = join(tmpdir(), `fabrico-e2e-77-one-board-leg4-${Date.now()}.fab`);
  let saveDialogFired = false;
  page.once('dialog', (d) => {
    saveDialogFired = true;
    void d.accept(savePath);
  });
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => saveDialogFired, {
      timeout: 10_000,
      message: 'SAVE DIALOG FIRED: Ctrl+S opened the save prompt and the walk answered it',
    })
    .toBe(true);
  await expect
    .poll(() => existsSync(savePath), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
      message: `SAVE DIALOG FIRED and the host wrote the .fab file at ${savePath}`,
    })
    .toBe(true);
  // No render-health read HERE: the New follows at once, and render health is read again after
  // it (the render loop's frame index follows the sim clock, `frame()` is the quantized render
  // clock, so a read here would only time the save's drain).
  const tickBeforeNew = (await readScene(page)).tick;

  // 4. NEW: `newBoard` itself asserts the swap to an empty scene whose tick restarted below the
  // tick read before it. Then the old label's box is gone from the canvas.
  await newBoard(page);
  await expect
    .poll(async () => labelBoxOn(page, labelId), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'New left no label box poll'),
      intervals: [100, 250, 500],
      message: 'New left no label box on the canvas',
    })
    .toBeNull();
  await expectRenderLoopAlive(page, 'leg 4 on the new empty board');

  // 5. THE LOAD, from the toolbar, the dialog answered with the saved file. Nothing but the Load
  // can bring the composed topology back onto the empty board `newBoard` measured.
  let loadDialogFired = false;
  page.once('dialog', (d) => {
    loadDialogFired = true;
    void d.accept(savePath);
  });
  await page.getByTitle('Load a saved factory').click();
  await pollScene(page, composedTopology, {
    timeout: 30_000,
    message:
      'ONLY THE LOAD REBUILDS this from the empty board newBoard measured: the six nodes by kind and anchor, the three belts by cells and docks, and both cables by their cells',
  }).toEqual(topoBeforeSave);
  expect(loadDialogFired, 'ONLY THE LOAD REBUILDS: the Load prompt fired and was answered').toBe(true);
  const firstTickAfterLoad = (await readScene(page)).tick;
  console.log(
    `COMP_SAVE_LOAD tickAtSave=${tickAtSave} tickBeforeNew=${tickBeforeNew} firstTickAfterLoad=${firstTickAfterLoad} path=${savePath}`,
  );

  // 6. RUNNING UNAIDED after the Load: nothing has pressed Play since the Load, and this leg's
  // body never does. On THIS path the New before the Load already resumed the host (its own tail,
  // `sim_loop.rs` `ControlMsg::New`). Step 9 walks Save then Load with nothing between (T-77-31,
  // the 77-04 refuter round, refuter 9); since D-08 the save no longer holds the host, so the
  // immediate Load arm's resume from a Frozen host is pinned by the host tests instead.
  await expectRunningUnaided(page, 'after the Load');
  const loaded = await readScene(page);
  const ids = idsByPlace(loaded);
  console.log(`COMP_LEG4_LOADED ids=${JSON.stringify(ids)}`);
  expect(
    labelFacts(loaded),
    'LABEL BACK EXACTLY: the reloaded label holds the same anchor, the same 12 cells, the same words and Lilac',
  ).toEqual([
    {
      anchor: `${LABEL_CELL[0]},${LABEL_CELL[1]}`,
      cells: LABEL_CELLS,
      label: { text: LABEL_TEXT, colour: LILAC_BYTE },
    },
  ]);
  const loadedLabelId = ids.label!;
  await expect
    .poll(async () => labelBoxOn(page, loadedLabelId), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'LABEL BACK EXACTLY box poll'),
      intervals: [100, 250, 500],
      message: 'LABEL BACK EXACTLY: the canvas plots the same box it plotted before the save',
    })
    .toEqual(beforeSave.box);
  await expect
    .poll(async () => {
      return wordsAt(await labelWordsOf(page, loadedLabelId));
    }, {
      timeout: 10_000,
      intervals: [100, 250, 500],
      message: 'LABEL BACK EXACTLY: the words overlay shows the same words it showed before the save, at the same place',
    })
    .toEqual(beforeSave.words);
  let backOnScreen = '';
  await expect
    .poll(
      async () => {
        const r = await labelOnScreen(page);
        backOnScreen = labelScreenLine(r);
        return {
          box: r.boxDrawn,
          words: r.wordsDrawn,
          sameWords: Math.abs(r.words - screenBeforeSave.words) <= LABEL_WORDS_BACK_SLACK * screenBeforeSave.words,
        };
      },
      {
        timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'LABEL BACK ON SCREEN poll'),
        intervals: [100, 250, 500],
        message: `LABEL BACK ON SCREEN: the reloaded label's cells show the Lilac box on all four sides at its fill, and the words on ${screenBeforeSave.words} word pixels as before the save (within ${LABEL_WORDS_BACK_SLACK * 100}%)`,
      },
    )
    .toEqual({ box: true, words: true, sameWords: true });
  console.log(`LABEL_SCREEN reloaded ${backOnScreen}`);
  // (The reloaded board's machines and label: `ONLY THE LOAD REBUILDS` above, review WR-C02.)
  await expectRenderLoopAlive(page, 'leg 4 on the reloaded board');

  // 7. ITEMS RUNNING PAST, graded at STEADY STATE on the reloaded board. The save drained the
  // board, so the outlet starts empty; the window lies past the Sink's 16-item inbox buffer, so a
  // Sink that stopped taking cannot hide in the refill. The recorder also copies the item layer's
  // drawn frame beside each model copy, for step 8.
  const upstreamId = ids.upstream!;
  const inletId = ids.inlet!;
  const outletId = ids.outlet!;
  const labelAtStart = { facts: labelFacts(await readScene(page)), box: await labelBoxOn(page, loadedLabelId) };
  await startTickRecorder(page, { itemDots: true });
  await startFrameTicks(page);
  await expect
    .poll(
      async () => {
        const r = (await readTickRecorder(page)).records;
        const i = r.findIndex((x) => (recordedBelt(x, outletId)?.[2] ?? []).some((s) => s <= 2));
        return i < 0 ? -1 : r.length - 1 - i;
      },
      {
        timeout: 30_000,
        intervals: [100, 250, 500],
        message: `ITEMS RUN PAST: items reached the Sink end of the outlet on the reloaded board and ${RUN_PAST_AFTER_RECORDS} records followed`,
      },
    )
    .toBeGreaterThanOrEqual(RUN_PAST_AFTER_RECORDS);
  // Step 8 grades the frames drawn from the record where items reached the Sink end on, so the
  // recording also runs on until the page has drawn enough of them (plan 84-13, the close
  // window's rule from plan 84-12). A count of records alone measured the frame rate: at the GPU
  // proxy (4 to 5 frames a second) the 160 records held 13 drawn frames, 10 graded, fewer than
  // `DRAWN_ALIGNED_MIN`, every one matching. The wait is on page frames, so its cap is their own
  // budget at the `FLOOR_FPS` floor (D-12).
  const pastFramesWanted = DRAWN_ALIGNED_MIN + DRAWN_FRAMES_HEADROOM;
  await expect
    .poll(
      async () => {
        const r = (await readTickRecorder(page)).records;
        const i = r.findIndex((x) => (recordedBelt(x, outletId)?.[2] ?? []).some((s) => s <= 2));
        return i < 0 ? 0 : frameTicksDuring(await readFrameTicks(page), r[i].t, Number.MAX_SAFE_INTEGER);
      },
      {
        timeout: addWaitBudget(frameBudgetMs(pastFramesWanted), 'run-past recording poll'),
        intervals: [100, 250, 500],
        message: `the run-past recording ran on until ${pastFramesWanted} page frames with a new tick were drawn from the record where items reached the Sink end`,
      },
    )
    .toBeGreaterThanOrEqual(pastFramesWanted);
  const pastRec = await readTickRecorder(page);
  await stopTickRecorder(page);
  const pastFrameTicks = await stopFrameTicks(page);
  const labelAtEnd = { facts: labelFacts(await readScene(page)), box: await labelBoxOn(page, loadedLabelId) };
  const recs = pastRec.records;
  const held = recs.findIndex((x) => (recordedBelt(x, outletId)?.[2] ?? []).some((s) => s <= 2));
  const inletPatterns = new Set(recs.map((r) => JSON.stringify(recordedBelt(r, inletId)?.[2] ?? []))).size;
  const lastPast = recs.slice(-RUN_PAST_WINDOW_RECORDS);
  const steadyPast = outletSteadyReading(lastPast, outletId);
  // R-01 d: the inlet, the belt beside the label, graded on the same steady window as the outlet.
  // Its occupancy changes while items move along it and never while they stand, whenever the
  // window opens. `inletPatterns` is logged only, for comparison with the runs before R-01 d.
  const inletChanges = outletSteadyReading(lastPast, inletId).changes;
  console.log(
    `RUN_PAST records=${recs.length} missed=${pastRec.missed} heldAt=${recs[held]?.t} inletPatterns=${inletPatterns} ` +
      `inletChanges=${inletChanges} slot0=${steadyPast.slot0.toFixed(3)} grow=${steadyPast.grow} changes=${steadyPast.changes}`,
  );
  expect(
    { inletMoving: inletChanges >= INLET_CHANGES_MIN, outlet: outletSteadyViolations(lastPast, outletId) },
    `ITEMS RUN PAST: over the last ${lastPast.length} records the inlet beside the label changed occupancy on ${inletChanges} (at least ${INLET_CHANGES_MIN}), and the outlet drained into the Sink at steady state`,
  ).toEqual({ inletMoving: true, outlet: [] });
  expect(
    labelAtEnd,
    'ITEMS RUN PAST the label untouched: its anchor, cells, words, colour and drawn box are the same at the end of the window as at its start',
  ).toEqual(labelAtStart);
  await expectRenderLoopAlive(page, 'leg 4 with items running past the label');

  // 8. THE ITEMS SEEN RUNNING PAST, OFF THE CANVAS (D-04). Each drawn frame the recorder copied is
  // graded against the model OF THE TICK IT WAS DRAWN FROM (`support/itemFrames.ts`): on these
  // flowing belts the model runs a frame or more ahead of the canvas, so a read of both in one
  // breath would disagree on a correct build (the 77-04 review blocker). Graded from the record
  // where the outlet first held an item at its Sink end. The match rate was measured on three
  // runs before this assertion was committed: 526 of 526 frames matched, against 0.35 to 0.38 for
  // a same-breath read (77-MUTATION-PROOF.md, "Plan 77-04 item frame measurement").
  const watched: WatchedBelt[] = [
    { id: upstreamId, cells: UP_CELLS },
    { id: inletId, cells: RUN_CELLS.slice(3) },
    { id: outletId, cells: OUTLET_CELLS },
  ];
  const drawnGrade = gradeDrawnItems(recs.slice(Math.max(0, held)), watched, CELL);
  const drawnRate = drawnGrade.aligned === 0 ? 0 : drawnGrade.matched / drawnGrade.aligned;
  console.log(`${drawnItemsLine(drawnGrade)} pageFrames=${frameTicksDuring(pastFrameTicks, recs[Math.max(0, held)]?.t ?? 0, Number.MAX_SAFE_INTEGER)}`);
  if (drawnGrade.mismatches.length > 0) {
    console.log(`ITEM_FRAMES_MISMATCH ${JSON.stringify(drawnGrade.mismatches.slice(0, 3))}`);
  }
  writeFileSync(
    test.info().outputPath('77-leg4-run-past.json'),
    JSON.stringify({ watched, held: recs[held]?.t, records: recs }),
  );
  expect(
    {
      moving: drawnGrade.distinctDrawn >= DRAWN_DISTINCT_MIN,
      graded: drawnGrade.aligned >= DRAWN_ALIGNED_MIN,
      matching: drawnRate >= DRAWN_MATCH_MIN,
      carried: drawnGrade.matchedWithItems >= 1,
    },
    `ITEMS DRAWN RUNNING PAST: of ${drawnGrade.frames} drawn frames, ${drawnGrade.aligned} were graded against the model of their drawn tick and ${drawnGrade.matched} matched it cell for cell (${drawnRate.toFixed(3)}, at least ${DRAWN_MATCH_MIN}), ${drawnGrade.matchedWithItems} with items on the belts, over ${drawnGrade.distinctDrawn} distinct drawn dot sets`,
  ).toEqual({ moving: true, graded: true, matching: true, carried: true });
  // THE PLACED DOTS ARE THE VISIBLE ONES (the 77-02 refuter round, refuter 1). The frames above
  // are the positions the item layer STORED on its particles; a hidden, zero-scale or transparent
  // layer stores the same. So the dots visible in screen pixels on the watched tiles are compared
  // with the placed ones, on a screenshot taken between two reads of the placed dots that agree
  // (the items move every 2 ticks, so a read that straddles a move is retried, never graded).
  const watchedCells = watched.flatMap((b) => b.cells);
  // Each try is bracketed and pipelined (`screenBrackets`, plan 84-11), as leg 3's close.
  let visibleTries = 0;
  let visibleLast = '';
  const visibleReads = screenBrackets(
    page,
    () => clipOfCells(page, watchedCells),
    async () => plottedOn(await itemDotsPerCell(page), watchedCells),
    (px, clip) => dotsInClip(px, clip, watchedCells),
  );
  await expect
    .poll(
      async () => {
        visibleTries++;
        await visibleReads.take();
        return visibleAgreement(visibleReads.settled(), (line) => {
          visibleLast = line;
        });
      },
      {
        timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'ITEMS VISIBLE ON THE CANVAS poll'),
        intervals: [50, 100, 250],
        message: `ITEMS VISIBLE ON THE CANVAS: on the ${watchedCells.length} watched tiles the dots visible in screen pixels equal the dots the item layer placed, with items on the belts`,
      },
    )
    .toEqual({ steady: true, same: true, carried: true });
  // The captures still in flight come back before `all()` returns, each at `CAPTURE_FRAMES` (plan 84-18).
  const visibleInFlight = visibleTries - visibleReads.settled().length;
  addFrameBudget(visibleInFlight * CAPTURE_FRAMES, `ITEMS VISIBLE ON THE CANVAS: ${visibleInFlight} captures in flight`);
  await visibleReads.all();
  console.log(`ITEMS_VISIBLE tries=${visibleTries} ${visibleLast}`);
  await expectRenderLoopAlive(page, 'leg 4 with the items drawn running past');

  // 9. SAVE, THEN RELOAD (the 77-04 refuter round, refuter 9; T-77-31; phase 90, D-08). Steps 3 to
  // 5 walk Save, New, Load, and the New resumes the host in its own tail. Here is the done-test's own
  // order, "save, reload", with nothing between: a plain Ctrl+S (the board's file is known since the
  // Load, so the smart Save writes it with no prompt, SAVE-03), the board measured running on after
  // that save with nothing pressed (a Save on a running board carries on running, D-08), then the
  // Load of that same file, and the board must run unaided after it.
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  const topoBeforeResave = composedTopology(await readScene(page));
  const mtimeBeforeResave = statSync(savePath).mtimeMs;
  await page.keyboard.press('Control+s');
  await expect
    .poll(() => statSync(savePath).mtimeMs, {
      timeout: 30_000,
      intervals: [200, 500, 1000],
      message: `SAVED AGAIN: a plain Ctrl+S re-wrote the board's file ${savePath} with no prompt`,
    })
    .toBeGreaterThan(mtimeBeforeResave);
  // RUNS ON, measured: the tick read once the file was re-written, then a SUSTAINED run past it
  // with nothing pressed (review WR-C-06). A one-tick rise is not a run: the last packet before a
  // freeze can land a frame after the file (packets were measured over 300 ms apart under the CPU
  // quota), which the leg before D-08 was written around. Thirty ticks is half a second of a
  // running board, and no stall dim may cover it.
  const tickAtResave = (await readScene(page)).tick;
  await expect
    .poll(async () => (await readScene(page)).tick, {
      timeout: 10_000,
      intervals: [100, 250],
      message: `RUNS ON AFTER THE SAVE: after the save re-wrote the file the tick ran 30 past ${tickAtResave} with nothing pressed`,
    })
    .toBeGreaterThanOrEqual(tickAtResave + 30);
  await expect(page.locator('[data-fab-disconnected-dim]'), 'RUNS ON AFTER THE SAVE: no stall dim over the running board').toHaveCount(0);
  let reloadDialogFired = false;
  page.once('dialog', (d) => {
    reloadDialogFired = true;
    void d.accept(savePath);
  });
  await page.getByTitle('Load a saved factory').click();
  await expect
    .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
      timeout: 10_000,
      intervals: [50, 100, 250],
      message: 'RELOADED AFTER THE SAVE: the status strip reads Loaded, the host answered the Load with the file\'s board',
    })
    .toBe('Loaded');
  expect(reloadDialogFired, 'RELOADED AFTER THE SAVE: the Load prompt fired and was answered with the saved file').toBe(true);
  await pollScene(page, composedTopology, {
    timeout: 30_000,
    message: 'RELOADED AFTER THE SAVE: the six nodes, three belts and both cables are back by place',
  }).toEqual(topoBeforeResave);
  const firstTickAfterReload = (await readScene(page)).tick;
  console.log(`COMP_RELOAD tickAtResave=${tickAtResave} firstTickAfterReload=${firstTickAfterReload}`);
  await expectRunningUnaided(page, 'after the Load of the re-saved file');
  const reloadedAgain = await readScene(page);
  expect(
    labelFacts(reloadedAgain),
    'LABEL BACK EXACTLY after the reload of the re-saved file: the same anchor, the same 12 cells, the same words and Lilac',
  ).toEqual([
    {
      anchor: `${LABEL_CELL[0]},${LABEL_CELL[1]}`,
      cells: LABEL_CELLS,
      label: { text: LABEL_TEXT, colour: LILAC_BYTE },
    },
  ]);
  await expectRenderLoopAlive(page, 'leg 4 after the reload of the re-saved file');
  const idsAgain = idsByPlace(reloadedAgain);
  console.log(`COMP_LEG4_RELOADED ids=${JSON.stringify(idsAgain)}`);

  // 10. LEG 1'S ROUTE STILL ANSWERS on the reloaded board (quick 261009-rhl, v9.0 audit Part 1
  // gap 1). Every check above grades what the reload brought back to LOOK at; none of them sent a
  // request, so a reloaded board whose Route no longer answered passed them all. The URL is
  // resolved again the way leg 1 resolved it, off the reloaded Route's own panel and matched to
  // the host bridge, never reused from leg 1: the Load remints handles and the address follows
  // the Route. The body is the one leg 1 typed into the Handler panel, so a Handler that came back
  // holding its preset, or no code at all, is red here too.
  await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
  const reloadedUrl = await readPanelUrl(page);
  console.log(`COMP_RELOADED_URL ${reloadedUrl} leg1=${required('endpointUrl', 'leg 1')}`);
  expect(
    reloadedUrl,
    'STILL ANSWERS AFTER THE RELOAD: the reloaded Route shows a loopback POST URL on its panel',
  ).toMatch(ENDPOINT_URL_SHAPE);
  expect(
    await webhookUrl(page, idsAgain.route!),
    'STILL ANSWERS AFTER THE RELOAD: the panel URL is the same string the host-side webhook_url bridge answers for the reloaded Route',
  ).toBe(reloadedUrl);
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  const afterReload = await post(page, 'leg 4: leg 1\'s Route after the reload', reloadedUrl, '{"probe":"comp-leg4-reloaded"}');
  expect(
    { status: afterReload.status, body: afterReload.body },
    'STILL ANSWERS AFTER THE RELOAD: a POST to the reloaded Route returns 200 with the body leg 1 typed into the Handler panel',
  ).toEqual({ status: 200, body: PANEL_BODY });
  await expectRenderLoopAlive(page, 'leg 4 after the reloaded Route answered');

  // 11. RECORD for leg 5: every handle re-read after the last Load.
  board.savePath = savePath;
  board.labelId = idsAgain.label!;
  board.routeId = idsAgain.route;
  board.handlerId = idsAgain.handler;
  board.sourceId = idsAgain.source;
  board.upstreamBeltId = idsAgain.upstream!;
  board.downstreamBeltId = idsAgain.inlet!;
  board.teeId = idsAgain.tee;
  board.sinkId = idsAgain.sink;
  board.outletBeltId = idsAgain.outlet!;
  errs.assertNone('during leg 4');
});

test('leg 5 - Disconnect on the leg 1 cable then one Ctrl+Z brings both legs back head-on into both prongs with no message on top', async () => {
  const page = sharedPage();

  // 1. THE HANDOFF, then the attach (it asserts the board runs unaided before it presses
  // anything, then ensures Playing: a paused board holds Ctrl+Z, D-19), then the board leg 4
  // reloaded, MEASURED.
  required('savePath', 'leg 4');
  const labelId = required('labelId', 'leg 4');
  const leg1Cables = required('leg1CableCells', 'leg 1');
  const leg1Drawn = required('leg1DrawnCables', 'leg 1');
  const errs = await attachToRunningBoard(page, 'leg 5');
  const opened = await readScene(page);
  expect(
    {
      nodes: composedTopology(opened).nodes,
      label: labelFacts(opened).map((l) => l.label),
      labelId: nodeAtAnchor(opened, LABEL_CELL[0], LABEL_CELL[1])?.id,
      cables: cableCellsByPlace(opened),
    },
    "leg 5 opens on the composed, reloaded board: legs 1 to 4's machines, the label and leg 1's cable",
  ).toEqual({
    nodes: [
      { kind: KIND_SOURCE, anchor: `${SOURCE_CELL[0]},${SOURCE_CELL[1]}` },
      { kind: KIND_TEE, anchor: `${TEE_CELL[0]},${TEE_CELL[1]}` },
      { kind: KIND_SINK, anchor: `${SINK_CELL[0]},${SINK_CELL[1]}` },
      { kind: KIND_ROUTE, anchor: `${ROUTE_CELL[0]},${ROUTE_CELL[1]}` },
      { kind: KIND_HANDLER, anchor: `${HANDLER_CELL[0]},${HANDLER_CELL[1]}` },
      { kind: KIND_LABEL, anchor: `${LABEL_CELL[0]},${LABEL_CELL[1]}` },
    ],
    label: [{ text: LABEL_TEXT, colour: LILAC_BYTE }],
    labelId,
    cables: leg1Cables,
  });
  await expect
    .poll(async () => ({ drawn: await drawnCableSet(page), onItsCells: await drawnCableGrade(page) }), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'CABLE PLOTTED on the reloaded board poll'),
      intervals: [100, 250, 500],
      message: "CABLE PLOTTED: the reloaded board plots leg 1's two cables exactly where leg 1 plotted them, each on the cells the model routes it on (read off the wire layer's plot, graded against wires[].path)",
    })
    .toEqual({ drawn: leg1Drawn, onItsCells: PAIR_DRAWN_ON_ITS_CELLS });
  const reloadedToRead = cablesToRead(opened);
  await expect
    .poll(async () => {
      const r = await cablesOnScreen(page, reloadedToRead);
      return { seen: r.seen, gone: r.gone, covered: r.covered };
    }, {
      timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'CABLE SEEN ON SCREEN on the reloaded board poll'),
      intervals: [100, 250, 500],
      message: 'CABLE SEEN ON SCREEN: on the reloaded board, in screen pixels, every cell between the two machines holds each leg of the cable and each of the four nubs its electric prong',
    })
    .toEqual({ seen: true, gone: false, covered: [] });
  await expectRenderLoopAlive(page, 'leg 5 on the board leg 4 reloaded');

  // 2. SELECT THE ROUTE by its cell, and record the cable by its endpoints and cells, keyed by
  // place (never by wire id or count: the Load reminted the handles, and the Undo will again).
  await selectMachineAt(page, ROUTE_CELL[0], ROUTE_CELL[1]);
  const before = await readScene(page);
  const endsBefore = cableKeysByPlace(before);
  const cellsBefore = cableCellsByPlace(before);
  const drawnBefore = await drawnCableSet(page);
  console.log(`COMP_LEG5_CABLE ends=${JSON.stringify(endsBefore)} cells=${JSON.stringify(cellsBefore)} drawn=${JSON.stringify(drawnBefore)}`);
  await expectRenderLoopAlive(page, 'leg 5 with the Route selected');

  // 3. ONE DISCONNECT on the Route's Out row takes BOTH legs (D-09). Then focus moves off the
  // button: the app-wide LW-02 guard stands Ctrl+Z down while a button holds focus, and a click
  // on the panel's own heading keeps the selection (spec 28). Then the strip is SETTLED before
  // it is read: on this one page leg 4's Load left `Loaded` in it, a transient that clears
  // itself after 4 s, so the readout is polled until it is empty (idle), and only then is the
  // strip's whole text read as the text it must keep (the `Unsaved` badge stays in it).
  await page.getByRole('button', { name: DISCONNECT_CONTROL_NAME, exact: true }).click();
  await pollScene(page, (s) => endsBefore.filter((k) => cableKeysByPlace(s).includes(k)), {
    message: `ONE DISCONNECT TAKES BOTH legs (D-09): after one Disconnect neither ${endsBefore.join(' nor ')} is on the board`,
  }).toEqual([]);
  await expect
    .poll(async () => drawnCableSet(page), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'CABLE PLOTTED after the Disconnect poll'),
      intervals: [100, 250, 500],
      message: 'CABLE PLOTTED: after the Disconnect the wire layer plots no cable (read off the plot)',
    })
    .toEqual([]);
  const beforeToRead = cablesToRead(before);
  await expect
    .poll(async () => {
      const r = await cablesOnScreen(page, beforeToRead);
      return { seen: r.seen, gone: r.gone };
    }, {
      timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'CABLE SEEN ON SCREEN after the Disconnect poll'),
      intervals: [100, 250, 500],
      message: 'CABLE SEEN ON SCREEN: after the Disconnect, in screen pixels, no cell the cable ran on holds it and no nub it plugged into shows its electric prong',
    })
    .toEqual({ seen: false, gone: true });
  console.log(`COMP_LEG5_SCREEN gone ${cablesScreenLine(await cablesOnScreen(page, beforeToRead))}`);
  await captureCablesFixture(page, 'gone', beforeToRead);
  await page.locator('#fab-config-heading').click();
  await expect
    .poll(async () => ((await page.locator(STRIP_READOUT).first().textContent()) ?? '').trim(), {
      timeout: STRIP_SETTLE_MS,
      intervals: [100, 250, 500],
      message: 'the status strip readout settled to idle (empty) before the Ctrl+Z, so no transient such as leg 4\'s Loaded is still showing',
    })
    .toBe('');
  const stripBefore = ((await page.locator('[data-fab-status-strip]').textContent()) ?? '').trim();
  console.log(`COMP_LEG5_STRIP_BEFORE ${JSON.stringify(stripBefore)}`);
  await expectRenderLoopAlive(page, 'leg 5 after the Disconnect');

  // 4. ONE CTRL+Z, with the refusal region latched and the status strip recorded on every
  // change across the WHOLE window: the key press, both legs back, and 60 ticks past the
  // restore, so a sentence the undo path shows just after the cable lands is inside it.
  const seen = await recordStatusStripDuring(page, () =>
    expectRefusalStayedSilent(page, 'one Ctrl+Z after the Disconnect on the reloaded board', async () => {
      await page.keyboard.press('Control+z');
      await pollScene(page, (s) => endsBefore.filter((k) => cableKeysByPlace(s).includes(k)), {
        message: `BOTH LEGS BACK after one Ctrl+Z: ${endsBefore.join(' and ')} are on the board again`,
      }).toEqual(endsBefore);
      const restoredAt = (await readScene(page)).tick;
      await pollScene(page, (s) => s.tick, {
        timeout: 10_000,
        message: `the board ran ${PAST_RESTORE_TICKS} ticks past the restore at tick ${restoredAt} inside the recorded window`,
      }).toBeGreaterThanOrEqual(restoredAt + PAST_RESTORE_TICKS);
    }),
  );
  console.log(`COMP_LEG5_STRIP_SEEN ${JSON.stringify(seen)}`);
  await expectRenderLoopAlive(page, 'leg 5 after the Ctrl+Z');

  // 5. THE SAME CABLE ON THE SAME CELLS, HEAD-ON, re-read (the Undo keyframe reminted ids), and
  // nothing on top across the whole window.
  const after = await readScene(page);
  expect(
    { ends: cableKeysByPlace(after), cells: cableCellsByPlace(after) },
    'SAME CELLS HEAD-ON: both restored legs run between the same endpoints, by place, on the IDENTICAL cells they ran on before the Disconnect',
  ).toEqual({ ends: endsBefore, cells: cellsBefore });
  for (const w of after.wires) {
    expectHeadOn(after, w, `SAME CELLS HEAD-ON the restored leg ${anchorKey(after, w)}`);
  }
  await expect
    .poll(async () => ({ drawn: await drawnCableSet(page), onItsCells: await drawnCableGrade(page) }), {
      timeout: addWaitBudget(frameBudgetMs(DRAWN_STATE_FRAMES), 'CABLE PLOTTED after Ctrl+Z poll'),
      intervals: [100, 250, 500],
      message: 'CABLE PLOTTED: after one Ctrl+Z the wire layer plots both legs exactly where it plotted them before the Disconnect, each on the cells the model routes it on (read off the plot, graded against wires[].path)',
    })
    .toEqual({ drawn: drawnBefore, onItsCells: PAIR_DRAWN_ON_ITS_CELLS });
  const afterToRead = cablesToRead(after);
  await expect
    .poll(async () => {
      const r = await cablesOnScreen(page, afterToRead);
      return { seen: r.seen, gone: r.gone, covered: r.covered };
    }, {
      timeout: addWaitBudget(frameBudgetMs(CAPTURE_POLL_TRIES * CAPTURE_FRAMES + DRAWN_STATE_FRAMES), 'CABLE SEEN ON SCREEN after Ctrl+Z poll'),
      intervals: [100, 250, 500],
      message: 'CABLE SEEN ON SCREEN: after one Ctrl+Z, in screen pixels, every cell between the two machines holds each restored leg and each of the four nubs its electric prong, head-on where the model plugs it',
    })
    .toEqual({ seen: true, gone: false, covered: [] });
  console.log(`COMP_LEG5_SCREEN back ${cablesScreenLine(await cablesOnScreen(page, afterToRead))}`);
  expect(
    seen,
    'NOTHING ON TOP: the status strip showed only what it showed before the Ctrl+Z, sampled on every change across the whole window',
  ).toEqual([stripBefore]);

  // 6. DESELECT, so the walk judges the prongs with no selection chip over them. No edit is
  // sent after the Ctrl+Z, and nothing is Deleted (D-21).
  await deselectViaEmptyCell(page, EMPTY_CELL[0], EMPTY_CELL[1]);
  await expectRenderLoopAlive(page, 'leg 5 deselected with the cable back');
  await captureCablesFixture(page, 'drawn', afterToRead);
  await expectSamePage(page, 'at the end of leg 5, the last walking leg');
  errs.assertNone('during leg 5');
});

// The host is left on the demo for any spec that runs after this one, even when a leg fails:
// a FRESH page at the project's baseURL, LoadDemo through the Examples popover, then the
// shared context is closed. No `ensurePlaying` here: LoadDemo resumes a host the user did not
// pause by itself, and `ensurePlaying` throws on a host that a failed leg holds while the button
// still reads `Pause`.
test.afterAll(async ({ browser }, testInfo) => {
  try {
    const baseURL = testInfo.project.use.baseURL;
    if (baseURL !== undefined) {
      const page = await browser.newPage({ baseURL });
      try {
        await page.goto('/');
        await waitForAppReady(page);
        await loadDemoViaExamples(page);
        await pollScene(page, (s) => s.nodes.length === DEMO_NODE_COUNT && s.wires.length === 2, {
          message: 'DEMO RESTORED: the shared host is back on the demo baseline after the composed walk',
        }).toBe(true);
      } finally {
        await page.close();
      }
    }
  } finally {
    await sharedContext?.close();
  }
});

// ---------------------------------------------------------------------------
// CUT DECLARATIONS. Declared LAST, after every walking leg and after `test.afterAll`, so a cut can
// never stop a walking leg from running; every later leg is declared ABOVE this block. Each is titled
// `CUT - leg <n> ...` and fails loudly with its measured reason (77 D-15, D-20, SC2). One stands:
// leg 3's "clears from the front", cut by the maintainers' ruling of 2026-10-08 (header, CUT (D-15,
// ruling of 2026-10-08)). Plan 77-09 cut the same clause on a grader fault the 77-03 refuter round
// fixed; this cut rests on what the eye sees, not on the grader.
// ---------------------------------------------------------------------------

test('CUT - leg 3 clause "clears from the front": cut by design decision on 2026-10-08, the line visibly thins from the Source end', async () => {
  throw new Error(
    [
      'CUT (D-15, design decision of 2026-10-08): leg 3\'s clause "then release and watch the jam clear from the front" is not asserted.',
      'The maintainers overturned named deviation A1: "cut it and carry on".',
      'On release the packed line visibly thins from the Source end; the front-first order is a sim-clock fact of about 50 ms',
      'that nobody can see, so a "watch" clause cannot be graded on it. Measured on the committed release trace 1',
      '(src/gates/fixtures/77-release-trace-1.json), 3 ticks from the front freeing to the belt behind moving:',
      '  RELEASE_ORDER R=2290 teeOff=2290 frontFree=2291 junction=2294 missed=2 witness=3 wrongway=0',
      'and the line thinning one tile at a time from the Source end, 137 to 173 ticks after the release:',
      '  RELEASE_THINNING 5,12=2427(R+137) 6,12=2435(R+145) 7,12=2442(R+152) 8,12=2449(R+159) 9,12=2459(R+169) 10,12=2463(R+173)',
      'Leg 3 still asserts what the eye sees: the mark breaks, the Tee stays released, the line thins and stays clear,',
      'the released run is drawn as the model holds it, and the board closes flowing into the Sink.',
    ].join('\n'),
  );
});

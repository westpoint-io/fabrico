//! Phase 68-06 (BELT-02 / BELT-04, verification rows V17 and V18): the pins that
//! keep the belt-pace surface honest across the language boundary: the SCALE (V17),
//! the absence of any ticks-per-second term under the render tree (V18), and - added
//! by 68-REVIEW WR-03 - the RUN CAP the client now enforces before it dispatches.
//!
//! # The failure these make impossible
//! `68-UI-SPEC.md` FINDING 1 is the worked example, and it is not hypothetical: every
//! user-facing px/sec figure in the phase's original decisions was derived from an
//! ASSUMED sixty ticks per second. The host runs at `1000 / 16 = 62.5`, so every one
//! of those figures was **4.17% low**, and nothing in the tree could see it, because
//! the derivation lived in prose and the result lived as a literal.
//!
//! Two independently-pinned constants can drift apart silently. ONE cross-language pin
//! cannot: test 1 below DERIVES the scale from the three sources it actually depends on
//! (two read from Rust, two parsed out of the TypeScript that declares them) and
//! compares the derivation to the figure the chrome ships. Move `TICK_PAUSE`, move
//! `CELL`, move `SLOTS_PER_TILE` or move the chrome's constant, and this reddens.
//!
//! # The parse discipline is copied, in substance, from the shipped analog
//! `command_error_view.rs`'s `frontend_refusal_tags` `include_str!`s a TypeScript file,
//! finds an anchor, and PANICS on a missing anchor, a missing terminator or an
//! unrecognised body line - by design, because a parser that quietly returned an empty
//! list would make the comparison pass vacuously, which is the exact failure that test
//! exists to end. Every parser here does the same, and test 3 is the positive control
//! on it.
//!
//! # Why `include_str!` and not a runtime read
//! A moved or renamed TypeScript file is then a COMPILE error in this crate rather
//! than a test that quietly stops finding anything to check. The directory WALKS
//! (tests 4, 5 and 6) cannot use it (a walk needs a real path), so they carry their
//! own non-zero file floor instead, which is the same shape and the same reason as the
//! freeze gate's minimum-fixture floor.
//!
//! NOT feature-gated in any way: `cargo test -p fabrico-host` runs every case here.

use fabrico_core::belt_slots::SLOTS_PER_TILE;
use fabrico_host::sim_loop::{MAX_RUN_PACE_BELTS, TICK_PAUSE};
use std::fs;
use std::path::{Path, PathBuf};

// =================================================================================
// The three TypeScript sources, embedded at COMPILE time
// =================================================================================

/// The chrome module that DECLARES the pace scale and the five offered steps.
const BELT_CONFIG_BODY_TS: &str =
    include_str!("../../../frontend/src/chrome/BeltConfigBody.tsx");

/// The ONE shared geometry values module: the home of the world cell size.
const GEOMETRY_TS: &str = include_str!("../../../frontend/shared/geometry.ts");

/// The wire module that DECLARES the frontend's mirror of the run cap.
const DECODE_TS: &str = include_str!("../../../frontend/src/protocol/decode.ts");

/// The anchor for the scale constant. Named so a failure can quote what went missing.
const SCALE_ANCHOR: &str = "export const PACE_PX_PER_SEC_AT_ONE_TICK = ";

/// The anchor for the offered steps. The declaration is
/// `export const PACE_STEPS: readonly PaceStep[] = [2, 4, 5, 10, 20].map(...)`, so the
/// anchor stops at the opening bracket and the terminator is the closing one.
const STEPS_ANCHOR: &str = "export const PACE_STEPS: readonly PaceStep[] = [";

/// The anchor for the world cell size in the shared geometry module.
const CELL_ANCHOR: &str = "export const CELL = ";

/// The anchor for the frontend's mirror of [`MAX_RUN_PACE_BELTS`].
const RUN_CAP_ANCHOR: &str = "export const MAX_RUN_PACE_BELTS = ";

/// Parse `<anchor><digits>;` out of a TypeScript source.
///
/// PANICS on a missing anchor and on a body that is not a bare integer, for the
/// `frontend_refusal_tags` reason: a parser that returned a default would make every
/// comparison below pass against a number this file invented.
fn parse_u64_const(src: &str, anchor: &str, whence: &str) -> u64 {
    let start = src.find(anchor).unwrap_or_else(|| {
        panic!(
            "{whence} no longer declares {anchor:?} - the cross-language pace pin cannot see \
             the frontend's constant and must not pass silently"
        )
    });
    let body = &src[start + anchor.len()..];
    let end = body.find(';').unwrap_or_else(|| {
        panic!("the declaration after {anchor:?} in {whence} is not terminated by `;`")
    });
    let literal = body[..end].trim();
    literal.parse::<u64>().unwrap_or_else(|_| {
        panic!(
            "the value after {anchor:?} in {whence} is {literal:?}, which is not a bare \
             integer - this parser certifies only a literal it can read, never an expression \
             it would have to evaluate"
        )
    })
}

/// Parse the `ticks_per_slot` values of the five offered steps out of the chrome source.
///
/// PANICS on a missing anchor, a missing terminator, or a body element that is not a
/// bare integer. Test 3 is the control proving this parser found something.
fn parse_offered_steps() -> Vec<u64> {
    let start = BELT_CONFIG_BODY_TS.find(STEPS_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/chrome/BeltConfigBody.tsx no longer declares {STEPS_ANCHOR:?} - \
             the whole-number pin cannot see the offered steps and must not pass silently"
        )
    });
    let body = &BELT_CONFIG_BODY_TS[start + STEPS_ANCHOR.len()..];
    let end = body
        .find(']')
        .unwrap_or_else(|| panic!("the PACE_STEPS array in BeltConfigBody.tsx is not closed by `]`"));
    let mut out = Vec::new();
    for part in body[..end].split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        // Every element must be a bare integer. A spread, a computed value or an
        // identifier is a shape this parser cannot certify, so it fails loudly rather
        // than skipping the element and shrinking the set it checks.
        out.push(part.parse::<u64>().unwrap_or_else(|_| {
            panic!("unrecognised PACE_STEPS element in BeltConfigBody.tsx: {part:?}")
        }));
    }
    out
}

/// The scale as DERIVED from its three real sources, in exact integer arithmetic.
///
///   (CELL / SLOTS_PER_TILE) px per slot  x  (1000ms / TICK_PAUSE) slots per second
///
/// Written as one fraction rather than two divisions on purpose: `1000 / 16` is 62.5
/// and would truncate to 62 in integer arithmetic, which is precisely the kind of
/// silent 0.8% error this file exists to prevent. Both divisions are asserted EXACT.
fn derived_scale(cell: u64) -> u64 {
    let tick_pause_ms = u64::try_from(TICK_PAUSE.as_millis()).expect("TICK_PAUSE fits a u64");
    assert_ne!(tick_pause_ms, 0, "TICK_PAUSE must be a non-zero number of whole milliseconds");
    let slots_per_tile = u64::from(SLOTS_PER_TILE);
    let numerator = cell * 1000;
    let denominator = slots_per_tile * tick_pause_ms;
    assert_eq!(
        numerator % denominator,
        0,
        "the pace scale is not a whole number: CELL {cell} x 1000ms does not divide by \
         SLOTS_PER_TILE {slots_per_tile} x TICK_PAUSE {tick_pause_ms}ms. Every offered label \
         is a px/sec figure and 68-UI-SPEC 4.3 requires them whole"
    );
    numerator / denominator
}

// =================================================================================
// V17: the scale cannot drift from the cadence
// =================================================================================

/// TEST 1. THE CROSS-LANGUAGE PIN, and the point of this whole file.
///
/// The derivation is computed HERE from the three sources; the chrome's declared
/// figure is PARSED. The product is never restated as a literal on both sides - that
/// would pin the test to itself and would have been perfectly green throughout the
/// entire life of the wrong `480`.
#[test]
fn the_chrome_scale_equals_the_cadence_it_is_derived_from() {
    let cell = parse_u64_const(GEOMETRY_TS, CELL_ANCHOR, "frontend/shared/geometry.ts");
    let declared = parse_u64_const(
        BELT_CONFIG_BODY_TS,
        SCALE_ANCHOR,
        "frontend/src/chrome/BeltConfigBody.tsx",
    );
    let derived = derived_scale(cell);
    assert_eq!(
        declared,
        derived,
        "PACE_PX_PER_SEC_AT_ONE_TICK is {declared}, but the cadence it claims to be derived \
         from produces {derived}: CELL {cell} / SLOTS_PER_TILE {SLOTS_PER_TILE} px per slot x \
         1000ms / TICK_PAUSE {}ms. 68-UI-SPEC FINDING 1 is what happens when these two drift: \
         every user-facing px/sec label was 4.17% low and nothing could see it",
        TICK_PAUSE.as_millis()
    );
}

/// TEST 2. Every offered step divides the scale EXACTLY, so every visible label is a
/// whole number rather than a rounded approximation. The steps are parsed rather than
/// restated, so adding a sixth step that breaks the property reddens here.
#[test]
fn every_offered_step_divides_the_scale_exactly() {
    let scale = parse_u64_const(
        BELT_CONFIG_BODY_TS,
        SCALE_ANCHOR,
        "frontend/src/chrome/BeltConfigBody.tsx",
    );
    for ticks in parse_offered_steps() {
        assert_ne!(ticks, 0, "an offered step of 0 ticks/slot is a stopped belt, not a pace");
        assert_eq!(
            scale % ticks,
            0,
            // The quotient is shown as a RATIONAL, not a float. `f64` is a disallowed type
            // workspace-wide (clippy.toml, CORE-04) and the ban is worth more than the
            // convenience of a decimal in a message that only ever renders on failure:
            // {scale}/{ticks} states the same non-whole fact exactly.
            "the offered step ticks_per_slot={ticks} does not divide the scale {scale}, so its \
             label would render as {scale}/{ticks} rather than a whole figure. The superseded \
             set {{2,3,4,8,16}} is exactly what this catches"
        );
    }
}

/// TEST 3. THE ANTI-VACUITY CONTROL on the parser.
///
/// Tests 1 and 2 would both pass over a parser that silently found nothing: an empty
/// step list satisfies "every step divides the scale" for free. This asserts the parse
/// actually produced steps, and that they are the five the design offers.
#[test]
fn the_step_parser_found_a_non_zero_number_of_steps() {
    let steps = parse_offered_steps();
    assert!(
        !steps.is_empty(),
        "the PACE_STEPS parser found NO steps, which would make the whole-number pin above \
         pass vacuously - the failure the panicking parser exists to prevent"
    );
    assert_eq!(
        steps.len(),
        5,
        "the design offers five pace steps (68-UI-SPEC 4.3); the parser read {steps:?}"
    );
}

/// TEST 3b (68-REVIEW WR-03). THE RUN-CAP PIN.
///
/// `commitConfig`'s Belt branch declines to dispatch a run longer than the cap, because
/// the host refuses it as `Malformed` and that refusal reaches the user as a sentence
/// naming no cause. That client-side guard is only honest while its number is the
/// host's number, and two independently-declared constants drift silently - the exact
/// failure mode `68-UI-SPEC.md` FINDING 1 records for the pace scale.
///
/// So the frontend's figure is PARSED here rather than restated: the literal is read out
/// of `frontend/src/protocol/decode.ts` and compared to the Rust constant the host
/// actually enforces. Move either and this reddens. The parser panics on a missing
/// anchor, so deleting the frontend declaration is a loud failure rather than a quiet
/// green - which is this file's standing discipline and the reason test 3 above exists.
#[test]
fn the_frontend_run_cap_equals_the_host_run_cap() {
    let declared = parse_u64_const(
        DECODE_TS,
        RUN_CAP_ANCHOR,
        "frontend/src/protocol/decode.ts",
    );
    let host = u64::try_from(MAX_RUN_PACE_BELTS).expect("MAX_RUN_PACE_BELTS fits a u64");
    assert_eq!(
        declared, host,
        "the frontend mirrors MAX_RUN_PACE_BELTS as {declared} but the host enforces {host}. \
         The client declines to dispatch a run longer than its own figure; if that figure is \
         SMALLER than the host's it silently refuses runs the host would have accepted, and if \
         it is LARGER it dispatches frames the host answers with a causeless Malformed - which \
         is the whole defect 68-REVIEW WR-03 names"
    );
}

// =================================================================================
// V18: no ticks-per-second term under the render tree
// =================================================================================

/// The render tree: the path 68-UI-SPEC section 2's BINDING RULE is about.
fn render_tree() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src/render")
}

/// The chrome tree: the ONE place the scale constant is allowed to live.
fn chrome_tree() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src/chrome")
}

/// Every PRODUCTION `.ts` / `.tsx` file under `root`, recursively, as (path, source).
///
/// Test files are excluded and that is a scoping decision rather than an oversight:
/// the binding rule is about what the RENDERER COMPUTES, and a `*.test.ts` ships in no
/// bundle and drives no frame. PANICS if the directory is missing, so a moved tree is a
/// loud failure rather than a walk that finds nothing and greps clean.
fn production_sources(root: &Path) -> Vec<(PathBuf, String)> {
    assert!(
        root.is_dir(),
        "{} is not a directory - the source scan has nothing to walk and must not report \
         clean (the freeze gate's missing-fixture-floor shape)",
        root.display()
    );
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}")) {
            let path = entry.unwrap_or_else(|e| panic!("dir entry under {dir:?}: {e}")).path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !(name.ends_with(".ts") || name.ends_with(".tsx")) {
                continue;
            }
            if name.contains(".test.") {
                continue;
            }
            // A cross-language source-text pin reading tracked `.ts`/`.tsx` files, not sim-core
            // I/O: refusing the read would delete the pin. Same narrowly-scoped exemption, and
            // the same reason, as the capability-JSON gate in `fabrico-app/src/lib.rs`. The ban
            // stays deny-level where it means something (`fabrico-core/src/lib.rs`
            // `#![deny(clippy::disallowed_methods)]`); allowing it HERE does not weaken it there.
            #[allow(clippy::disallowed_methods)]
            let src = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
            out.push((path, src));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Strip `//` line comments and `/* */` block comments, preserving line numbering by
/// replacing removed characters with spaces and newlines.
///
/// MANDATORY, not tidy. `beltGeometry.ts:329-352` is a long docblock that NAMES the
/// deleted rate constants and quotes the retired `480 px/sec` and `62.5 t/s` figures
/// verbatim - that record is exactly what a reader needs and exactly what an unstripped
/// scan would flag. This is the discipline plan 68-05 established for the same reason.
///
/// KNOWN BLIND SPOT, stated because a scan whose exclusions are undocumented becomes
/// vacuous the first time somebody widens them: this stripper does not model string or
/// template literals, so a `//` inside a string (a URL, say) begins a "comment" and
/// blanks the rest of that line. A rate literal hidden after a URL on the same line is
/// therefore invisible here. That is an accepted cost (the alternative is a TypeScript
/// tokenizer in a test), and it is the ONLY hole in the stripper.
fn strip_comments(src: &str) -> String {
    let bytes: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '/' && i + 1 < bytes.len() && bytes[i + 1] == '/' {
            while i < bytes.len() && bytes[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if bytes[i] == '/' && i + 1 < bytes.len() && bytes[i + 1] == '*' {
            while i < bytes.len() {
                let closing = bytes[i] == '*' && i + 1 < bytes.len() && bytes[i + 1] == '/';
                out.push(if bytes[i] == '\n' { '\n' } else { ' ' });
                i += 1;
                if closing {
                    out.push(' ');
                    i += 1;
                    break;
                }
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Does `line` contain `literal` as a standalone NUMBER, not as part of a longer
/// number and not as part of an identifier?
fn contains_number(line: &str, literal: &str) -> bool {
    let boundary = |c: char| c.is_ascii_digit() || c.is_alphanumeric() || c == '_' || c == '.';
    let mut from = 0;
    while let Some(at) = line[from..].find(literal) {
        let start = from + at;
        let end = start + literal.len();
        let before_ok = start == 0 || !boundary(line[..start].chars().next_back().unwrap());
        let after_ok = end >= line.len() || !boundary(line[end..].chars().next().unwrap());
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// TEST 4 (V18 scan a). The scale constant's IDENTIFIER lives under `chrome/` and
/// appears nowhere under `render/`.
///
/// This scan alone is NOT the guard, and 68-UI-SPEC says so explicitly: a future edit
/// that hand-inlines a rate into the render path undoes Phase 62's D-05 deletion
/// without ever mentioning this name. Test 5 is the one that can see that. This one is
/// still worth having because a re-EXPORT is the cheap version of the same mistake.
#[test]
fn the_scale_identifier_appears_only_under_the_chrome_tree() {
    const IDENT: &str = "PACE_PX_PER_SEC_AT_ONE_TICK";

    // Anti-vacuity first: the scan must be able to FIND the identifier where it does
    // live, or "absent from render/" is a statement about a broken walk.
    let chrome_hits = production_sources(&chrome_tree())
        .into_iter()
        .filter(|(_, src)| strip_comments(src).contains(IDENT))
        .count();
    assert!(
        chrome_hits > 0,
        "{IDENT} was not found anywhere under frontend/src/chrome - this scan is looking for \
         something that no longer exists, so its render-tree half proves nothing"
    );

    let offenders: Vec<String> = production_sources(&render_tree())
        .into_iter()
        .filter(|(_, src)| strip_comments(src).contains(IDENT))
        .map(|(p, _)| p.display().to_string())
        .collect();
    assert!(
        offenders.is_empty(),
        "{IDENT} reached the render tree ({offenders:?}). 68-UI-SPEC section 2's BINDING RULE: \
         the render path carries NO ticks-per-second term. Its aliasing ceiling is stated in px \
         per SIM TICK and carries no clock at all, and converting it to px per second needs \
         exactly the term Phase 62's D-05 deleted on the record \
         (frontend/src/render/synth/beltGeometry.ts:329-352)"
    );
}

/// The numeric literals that ARE a rate in this codebase, each with the reason it is
/// scanned and the context rule that keeps it from firing on an innocent digit.
///
/// `(literal, needs_time_word)`:
///
/// - `500`: the pace scale itself. It has no other meaning anywhere in the render
///   tree, so any value-producing occurrence is flagged.
/// - `62.5`: the host's ticks per second. Same: no other meaning here.
/// - `16`: the tick period in MILLISECONDS. It is flagged ONLY on a line that also
///   names a time or rate word, because 16 is a legitimate PIXEL figure in this tree
///   (`LINE_HEIGHT_PX`, `LOD_MIN_MACHINE_PX`, `ICON_MD_PX`, a march bucket count) and
///   because `>> 16` is how every colour channel in `synth/` is unpacked. Measured this
///   session: a bare-16 rule fires on 17 innocent lines and zero real ones.
///
/// `1000` is DELIBERATELY NOT SCANNED, and the omission is the interesting one.
/// `render/loop.ts:32` declares `SIM_TICK_MS = 1000 / 60`, which is the render clock's
/// smoothing coefficient and NOT a claim about the host's cadence - `beltGeometry.ts`
/// says so by name and says "do not finish the job by re-pointing it". Two more
/// legitimate `/ 1000` millisecond conversions and one luminance divisor share the
/// tree. A `1000` rule would fire on all four and would be switched off within a week,
/// which is worse than not having it. **That is this scan's second blind spot: a rate
/// spelled only as `1000 / <period>` with no other tell is invisible to it.**
const RATE_LITERALS: &[(&str, bool)] = &[("500", false), ("62.5", false), ("16", true)];

/// Words that make a line read as a TIME or RATE context rather than a pixel one.
const TIME_WORDS: &[&str] = &["ms", "milli", "sec", "hz", "rate", "tick", "cadence"];

/// Is this line a value-producing context: a declaration, an assignment, or an
/// arithmetic expression? The plan's own wording, and what separates `const X = 500`
/// from a bare 500 sitting in a comment-stripped blank.
fn is_rate_context(line: &str) -> bool {
    line.contains('=') || line.contains('*') || line.contains('/')
}

/// Does the line name a time or rate concept (case-insensitively)?
fn names_time(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    TIME_WORDS.iter().any(|w| lower.contains(w))
}

/// TEST 5 (V18 scan b). THE SCAN THAT MATTERS: the numeric rate literals themselves,
/// nowhere under the render tree.
///
/// The failure Phase 62's D-05 deletion actually guards against is a HAND-INLINED rate,
/// not a re-exported name, so test 4 passes cleanly straight over it. The mutation
/// proof recorded in `68-06-SUMMARY.md` is exactly that contrast: adding
/// `const PACE_PX_PER_SEC = 500;` to a render-tree file reddens THIS test while test 4
/// stays fully green.
///
/// The scoping rule and both known blind spots are stated on [`RATE_LITERALS`] and
/// [`strip_comments`]. The accepted cost of the `500` / `62.5` rules is a false
/// positive on some future innocent 500 (a settle time, say); the failure message below
/// says what the rule is, so that conversation happens here rather than by deletion.
#[test]
fn no_rate_literal_appears_under_the_render_tree() {
    let mut offenders: Vec<String> = Vec::new();
    for (path, src) in production_sources(&render_tree()) {
        for (n, line) in strip_comments(&src).lines().enumerate() {
            if !is_rate_context(line) {
                continue;
            }
            for (literal, needs_time_word) in RATE_LITERALS {
                if !contains_number(line, literal) {
                    continue;
                }
                if *needs_time_word && !names_time(line) {
                    continue;
                }
                offenders.push(format!(
                    "{}:{}: [{literal}] {}",
                    path.display(),
                    n + 1,
                    line.trim()
                ));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "a ticks-per-second term reached the render tree:\n  {}\n\n\
         THE RULE (68-UI-SPEC section 2, BINDING): the render path carries no clock. Its \
         aliasing ceiling (`MARCH_NYQUIST_CEILING_PX_PER_TICK`) is stated in px per SIM TICK, \
         `marchPxPerTick` derives and clamps entirely in px per tick, and both take every input \
         off the render packet. Converting either to px per SECOND needs a ticks-per-second \
         term, and Phase 62's D-05 DELETED all three such constants from \
         `frontend/src/render/synth/beltGeometry.ts` on the record rather than correcting them. \
         The one legitimate home for the term is `PACE_PX_PER_SEC_AT_ONE_TICK` in \
         `frontend/src/chrome/BeltConfigBody.tsx`, where it is a LABEL unit and never a render \
         input.",
        offenders.join("\n  ")
    );
}

/// TEST 6. THE ANTI-VACUITY CONTROL ON BOTH SCANS, and it is not optional: a walk that
/// discovers zero files greps clean and reports green on every rule it runs.
///
/// A FLOOR rather than a pin, the same shape and the same reason as the freeze gate's
/// minimum-fixture count: the render tree grows and shrinks with ordinary work, and a
/// pin would turn every such change into a red here. Measured at this commit: 36
/// production sources under `render/` and 45 under `chrome/`. The floors are set well
/// below both, low enough never to be noise and high enough that a walk pointed at the
/// wrong directory (or one that silently stopped recursing) cannot satisfy them.
#[test]
fn both_source_walks_visited_a_non_zero_number_of_files() {
    const RENDER_FLOOR: usize = 25;
    const CHROME_FLOOR: usize = 25;

    let render = production_sources(&render_tree()).len();
    assert!(
        render >= RENDER_FLOOR,
        "the render-tree walk visited {render} production sources, under the floor of \
         {RENDER_FLOOR}. A walk that discovers nothing passes every scan above for the wrong \
         reason, so a shrinking walk is a RED here rather than a quiet green"
    );

    let chrome = production_sources(&chrome_tree()).len();
    assert!(
        chrome >= CHROME_FLOOR,
        "the chrome-tree walk visited {chrome} production sources, under the floor of \
         {CHROME_FLOOR} - see the render half above for why this is asserted at all"
    );
}

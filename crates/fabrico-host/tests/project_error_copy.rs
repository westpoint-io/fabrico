//! Phase 73, UNDO-09 - the PROJECT ERROR COPY gate.
//!
//! # Why this file exists now and did not before
//! Until plan 73-04 the `ProjectError` `Display` strings were developer-facing text.
//! They terminated at an `eprintln!` on the sim thread (`sim_loop.rs`, the `Err(e)` arm
//! of `load_swap`) and reached a screen never. `62-CONTEXT.md` D-15 recorded that gap in
//! place and said it was not Phase 62's to fix.
//!
//! 73-04 fixes it: the sentence now rides a `loadRefused` frame to a `LoadRefusedCard` in
//! the webview, on both transports. THE MOMENT IT IS RENDERED IT STOPS BEING DEVELOPER
//! TEXT AND BECOMES SHIPPED USER COPY, and two properties nobody had ever checked have to
//! hold. This file is the check.
//!
//! It is the discipline `refusal_copy_truth.rs` already applies to `REFUSAL_COPY`,
//! pointed at a second copy table.
//!
//! # GATE 1: house voice, over EVERY variant
//! Per variant: no U+2014, no U+2013, a terminal period, no debug payload. Measured on
//! 2026-09-05 before the fix: 22 arms, 10 em dashes, 0 en dashes, ZERO arms ending in a
//! period, and one arm (`InvalidSnapshot`) rendering `{e:?}` straight into user copy.
//! The em dash in particular is the one character this project bans absolutely, and
//! `TooOld` - which plan 73-07's `PROJECT_FILE_VERSION` 9 -> 10 bump makes the ORDINARY
//! refusal rather than an edge one - carried one.
//!
//! # GATE 2: the loaded path never reaches the card
//! `Io(e)` and `Store(e)` embed a foreign error whose `Display` could carry a filesystem
//! path. This file drives a REAL `load_project` against a KNOWN temp path, once per
//! failure mode reachable that way, and asserts the formatted `Display` never contains
//! it. That is threat T-32-06-01 applied to a new surface, and it is the reason the card
//! renders the host's sentence rather than the host's sentence plus a filename.
//!
//! # The enumeration is COMPILER-CHECKED, not hand-picked
//! [`variant_name`] matches `ProjectError` exhaustively, so ADDING A VARIANT IS A COMPILE
//! ERROR IN THIS FILE rather than a silent gap in the gate. That matters immediately:
//! **plan 73-07 adds a new `ProjectError` variant for the out-of-log seed marker bound,
//! and its arm must satisfy all four GATE 1 properties.** A gate over a hand-picked
//! subset is not a gate, and this repository has already missed one class by reading.
//!
//! Run target: `cargo test -p fabrico-host --test project_error_copy`

// `fabrico-host` is the project's sanctioned I/O home and does NOT carry the determinism
// clippy gate (that lives only in `fabrico-core`). GATE 2 has to write real fixture files
// to a real temp path and hand them to the real `load_project`, because a hand-built
// `ProjectError` cannot prove what the LOAD path puts in front of a user. Scoped
// defensively in case CI promotes the lint workspace-wide. Same reasoning, same wording,
// as `tests/route_table_write_load_agreement.rs` and `tests/fuzz_two_log.rs`.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

use fabrico_core::event::{DecodeError, StateInvariant};
use fabrico_core::persist::StoreError;
use fabrico_host::project::{
    PRE_SLOT_CHANGE_PROJECT_VERSION, PRE_SPEED_CHANGE_PROJECT_VERSION, PROJECT_FILE_VERSION,
    ProjectError, load_project,
};

/// The em dash. Banned absolutely in anything a user reads.
const EM_DASH: char = '\u{2014}';
/// The en dash. Green before this plan by measurement, and asserted anyway: a reword is
/// exactly the moment one gets introduced.
const EN_DASH: char = '\u{2013}';

/// `project.rs` embedded at COMPILE time - a moved or renamed file is a compile error in
/// this crate, never a test that quietly stops finding anything to check. The same
/// `include_str!` discipline `refusal_copy_truth.rs` and `command_error_view.rs` use.
const PROJECT_RS: &str = include_str!("../src/project.rs");

// ---------------------------------------------------------------------------
// The compiler-checked enumeration
// ---------------------------------------------------------------------------

/// The variant's name, through an EXHAUSTIVE match.
///
/// This function is the whole reason the gate cannot rot. Add a `ProjectError` variant
/// and this stops compiling; there is no path by which a new arm's copy goes unchecked.
fn variant_name(e: &ProjectError) -> &'static str {
    match e {
        ProjectError::Io(_) => "Io",
        ProjectError::Store(_) => "Store",
        ProjectError::Malformed => "Malformed",
        ProjectError::UnknownVersion(_) => "UnknownVersion",
        ProjectError::TooOld { .. } => "TooOld",
        ProjectError::InvalidSnapshot(_) => "InvalidSnapshot",
        ProjectError::TooLarge { .. } => "TooLarge",
        ProjectError::NotQuiescent(_) => "NotQuiescent",
        ProjectError::HeadTickMismatch { .. } => "HeadTickMismatch",
        ProjectError::UnreadableLogEvent(_) => "UnreadableLogEvent",
        ProjectError::NonMonotonicLog { .. } => "NonMonotonicLog",
        ProjectError::UnreadableEditRecord(_) => "UnreadableEditRecord",
        ProjectError::NonMonotonicEditLog { .. } => "NonMonotonicEditLog",
        ProjectError::TickOverflow { .. } => "TickOverflow",
        ProjectError::ReplaySpanTooLong { .. } => "ReplaySpanTooLong",
        ProjectError::EditFootprintOutOfRange { .. } => "EditFootprintOutOfRange",
        ProjectError::EditAnchorOutOfBounds { .. } => "EditAnchorOutOfBounds",
        ProjectError::EditPortOutOfFootprint { .. } => "EditPortOutOfFootprint",
        ProjectError::EditRouteTableTooLong { .. } => "EditRouteTableTooLong",
        ProjectError::EditRoutePatternTooLong { .. } => "EditRoutePatternTooLong",
        ProjectError::SlotModelChanged { .. } => "SlotModelChanged",
        ProjectError::BeltSpeedModelChanged { .. } => "BeltSpeedModelChanged",
        // 74.1-23: the shared port-edit envelope refusal and the post-replay gate.
        ProjectError::EditPortEditOutOfEnvelope { .. } => "EditPortEditOutOfEnvelope",
        ProjectError::EditReplayStateInvalid(_) => "EditReplayStateInvalid",
        // 76-04: the two label load refusals.
        ProjectError::EditLabelTextTooLong { .. } => "EditLabelTextTooLong",
        ProjectError::EditLabelSizeOutOfRange { .. } => "EditLabelSizeOutOfRange",
        // 85-06: a forged undo history that reaches below the scene's undo floor.
        ProjectError::UndoFloorBreached { .. } => "UndoFloorBreached",
        // 86-02: a forged rotation above 3 on a Place or a Delete capture.
        ProjectError::EditRotationOutOfRange { .. } => "EditRotationOutOfRange",
        // 86-07: a file that joins a label to a port, a belt or a cable.
        ProjectError::LabelConnected => "LabelConnected",
    }
}

/// The number of `ProjectError` variants, pinned so that a variant ADDED to
/// [`variant_name`] but never constructed below reddens here rather than passing on the
/// twenty-two that were.
///
/// 73-07 moved it 22 -> 23 for the refusal of an out-of-range record of nodes minted
/// outside the edit log, which is the one gap the exhaustive match CANNOT close on its
/// own: a variant can be named in [`variant_name`] and never constructed below, and its
/// copy would then go unchecked while the file still compiles. 74.1-23 moved it 23 -> 25
/// for `EditPortEditOutOfEnvelope` and `EditReplayStateInvalid`. 76-04 moved it 25 -> 27
/// for `EditLabelTextTooLong` and `EditLabelSizeOutOfRange`. 85-06 moved it 27 -> 28 for
/// `UndoFloorBreached`. 85-09 moved it 28 -> 27: project file v12 carries no such record
/// (every node is minted by the edit log), so the 73-07 refusal was deleted with it.
/// 86-02 moved it 27 -> 28 for `EditRotationOutOfRange`. 86-07 moved it 28 -> 29 for
/// `LabelConnected`.
const VARIANT_COUNT: usize = 29;

/// A real `std::io::Error`, produced by a real failed syscall against a known path, so
/// the `Io` arm is exercised against the shape it actually carries rather than a
/// hand-built one.
fn real_io_error(path: &Path) -> std::io::Error {
    std::fs::metadata(path).expect_err("a path that does not exist has no metadata")
}

/// One value of every variant. Paired with [`variant_name`]'s exhaustive match: that
/// match is what makes a MISSING variant a compile error, and `VARIANT_COUNT` is what
/// makes a missing CONSTRUCTOR a red test.
///
/// The inner values are chosen to be representative rather than minimal - in particular
/// every `DecodeError` shape is exercised through `InvalidSnapshot`, because that arm's
/// bounded summary matches on them exhaustively too.
fn every_variant(missing: &Path) -> Vec<ProjectError> {
    vec![
        ProjectError::Io(real_io_error(missing)),
        ProjectError::Store(StoreError::Backend("a backend said no".to_owned())),
        ProjectError::Store(StoreError::TooLarge),
        ProjectError::Malformed,
        ProjectError::UnknownVersion(PROJECT_FILE_VERSION + 3),
        ProjectError::TooOld {
            found: 1,
            expected: PROJECT_FILE_VERSION,
        },
        ProjectError::InvalidSnapshot(DecodeError::UnknownVersion(99)),
        ProjectError::InvalidSnapshot(DecodeError::Malformed),
        ProjectError::InvalidSnapshot(DecodeError::InvalidState(StateInvariant::BeltSlotCount)),
        ProjectError::InvalidSnapshot(DecodeError::SnapshotTooOld(2)),
        ProjectError::TooLarge {
            size: 9_000,
            limit: 8_000,
        },
        ProjectError::NotQuiescent(3),
        ProjectError::HeadTickMismatch {
            expected: 10,
            actual: 11,
        },
        ProjectError::UnreadableLogEvent(77),
        ProjectError::NonMonotonicLog {
            partition: 0,
            sequence: 4,
        },
        ProjectError::UnreadableEditRecord(7),
        ProjectError::NonMonotonicEditLog {
            partition: 0,
            sequence: 4,
        },
        ProjectError::TickOverflow {
            max_event_tick: u64::MAX,
        },
        ProjectError::ReplaySpanTooLong {
            span: 1 << 40,
            limit: 1 << 20,
        },
        ProjectError::EditFootprintOutOfRange {
            w: u16::MAX,
            h: u16::MAX,
        },
        ProjectError::EditAnchorOutOfBounds {
            cell_x: i32::MAX,
            cell_y: i32::MIN,
        },
        ProjectError::EditPortOutOfFootprint {
            local_offset: (9, 9),
            w: 3,
            h: 3,
        },
        ProjectError::EditRouteTableTooLong {
            routes: 1_000_000,
            cap: 64,
        },
        ProjectError::EditRoutePatternTooLong {
            len: 1_000_000,
            cap: 256,
        },
        ProjectError::SlotModelChanged {
            found: PRE_SLOT_CHANGE_PROJECT_VERSION,
        },
        ProjectError::BeltSpeedModelChanged {
            found: PRE_SPEED_CHANGE_PROJECT_VERSION,
        },
        // 74.1-23. The replay arm carries the exact refusal its forged-file test pins.
        ProjectError::EditPortEditOutOfEnvelope { sequence: 41 },
        ProjectError::EditReplayStateInvalid(DecodeError::InvalidState(
            StateInvariant::PortOutOfFootprint,
        )),
        // 76-04. The forged shapes the load gate refuses, absurd numbers included: the
        // copy names none of them.
        ProjectError::EditLabelTextTooLong {
            len: 4 << 20,
            cap: fabrico_core::edit::MAX_LABEL_BYTES,
        },
        ProjectError::EditLabelSizeOutOfRange {
            w: u16::MAX,
            h: 0,
            cap: fabrico_core::state::MAX_FOOTPRINT_DIM,
        },
        // 85-06. The shape the forged-history load test pins (floor 1, cursor 0) has a
        // zero in it; these are distinct non-zero numbers so the gate below can find each.
        ProjectError::UndoFloorBreached { floor: 12, cursor: 3 },
        // 86-02. A forged turn; the copy names no number.
        ProjectError::EditRotationOutOfRange { rot: u8::MAX },
        // 86-07. Payload-free: the one sentence covers every forged connect shape.
        ProjectError::LabelConnected,
        // And the snapshot-side refusal of an over-long label, through the bounded
        // summary that never names the invariant.
        ProjectError::InvalidSnapshot(DecodeError::InvalidState(StateInvariant::LabelTextTooLong)),
    ]
}

/// A temp dir whose NAME is distinctive, so a path leak into the copy is unmistakable
/// rather than a coincidental substring.
fn known_temp_dir() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("fabrico-copy-gate-zzq")
        .tempdir()
        .expect("temp dir")
}

// ---------------------------------------------------------------------------
// GATE 1
// ---------------------------------------------------------------------------

#[test]
fn the_enumeration_covers_every_variant_and_is_not_a_sample() {
    let dir = known_temp_dir();
    let missing = dir.path().join("absent.fab");
    let names: std::collections::BTreeSet<&'static str> = every_variant(&missing)
        .iter()
        .map(variant_name)
        .collect();
    assert_eq!(
        names.len(),
        VARIANT_COUNT,
        "every ProjectError variant must be CONSTRUCTED here, not merely matched. \
         `variant_name`'s exhaustive match makes a new variant a compile error; this \
         count is what makes a new variant with no constructor a red test. Covered: {names:?}"
    );
}

#[test]
fn no_variant_carries_an_em_dash() {
    let dir = known_temp_dir();
    let missing = dir.path().join("absent.fab");
    for e in every_variant(&missing) {
        let s = e.to_string();
        assert!(
            !s.contains(EM_DASH),
            "{} renders a U+2014 em dash, which this project bans absolutely in user \
             copy. Use a hyphen, a comma, a colon or a restructured sentence.\n  {s}",
            variant_name(&e)
        );
    }
}

#[test]
fn no_variant_carries_an_en_dash() {
    let dir = known_temp_dir();
    let missing = dir.path().join("absent.fab");
    for e in every_variant(&missing) {
        let s = e.to_string();
        assert!(
            !s.contains(EN_DASH),
            "{} renders a U+2013 en dash.\n  {s}",
            variant_name(&e)
        );
    }
}

#[test]
fn every_variant_ends_with_a_terminal_period() {
    let dir = known_temp_dir();
    let missing = dir.path().join("absent.fab");
    for e in every_variant(&missing) {
        let s = e.to_string();
        assert!(
            s.trim_end().ends_with('.'),
            "{} does not end in a terminal period. Every one of these is now a sentence \
             a user reads on the load-refusal card.\n  {s}",
            variant_name(&e)
        );
    }
}

#[test]
fn no_variant_renders_a_debug_payload() {
    let dir = known_temp_dir();
    let missing = dir.path().join("absent.fab");

    // (a) THE BEHAVIOURAL HALF. For every variant that embeds a foreign error, the
    //     rendered copy must not contain that error's `Debug` shape. RED before this
    //     plan on `InvalidSnapshot`, whose whole payload was `{e:?}` and which therefore
    //     showed a user `project file snapshot rejected: InvalidState(BeltSlotCount)`
    //     about a file that is byte-for-byte intact - which any reasonable person files
    //     as a corruption bug.
    for e in every_variant(&missing) {
        let rendered = e.to_string();
        let debug_shapes: Vec<String> = match &e {
            ProjectError::Io(inner) => vec![format!("{inner:?}")],
            ProjectError::Store(inner) => vec![format!("{inner:?}")],
            ProjectError::InvalidSnapshot(inner) => vec![format!("{inner:?}")],
            // 74.1-23: the replay refusal carries a `DecodeError` and never prints it.
            ProjectError::EditReplayStateInvalid(inner) => {
                vec![format!("{inner:?}"), "PortOutOfFootprint".to_owned()]
            }
            _ => Vec::new(),
        };
        for shape in debug_shapes {
            assert!(
                !rendered.contains(&shape),
                "{} renders its inner error's Debug shape into user copy.\n  \
                 debug: {shape}\n  copy:  {rendered}",
                variant_name(&e)
            );
        }
    }

    // (b) THE SOURCE HALF, which catches a debug format added to ANY arm including one
    //     carrying no inner error at all. Scoped to the `Display` impl block so the
    //     enum's own docblocks and the rest of the file are out of scope, and to CODE
    //     within it: a comment that discusses a debug specifier is not one, and a gate
    //     that reddens on prose about itself teaches people to delete the prose.
    let code = strip_line_comments(display_impl_block());
    assert!(
        !code.contains(":?}"),
        "a debug format specifier survives inside `impl Display for ProjectError`. \
         Everything in that block is now user-facing copy."
    );
}

/// Blank out `//` line comments, preserving newlines so a failure's line arithmetic still
/// works. The `Display` block carries no block comments and no string literal containing
/// `//`, so this stays a two-line function rather than a parser.
fn strip_line_comments(src: &str) -> String {
    src.lines()
        .map(|l| match l.find("//") {
            Some(i) => l[..i].to_owned(),
            None => l.to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The body of `impl std::fmt::Display for ProjectError`, sliced out of the embedded
/// source. Panics rather than silently returning an empty string: a slicer that found
/// nothing would make the assertion above vacuous, which is the exact defect class this
/// repository keeps meeting.
fn display_impl_block() -> &'static str {
    const OPEN: &str = "impl std::fmt::Display for ProjectError {";
    const CLOSE: &str = "impl std::error::Error for ProjectError {}";
    let start = PROJECT_RS
        .find(OPEN)
        .expect("the Display impl for ProjectError must be findable in project.rs");
    let end = PROJECT_RS[start..]
        .find(CLOSE)
        .expect("the Error impl that follows the Display impl must be findable")
        + start;
    let block = &PROJECT_RS[start..end];
    assert!(
        block.len() > 2_000,
        "the sliced Display block is implausibly short ({} bytes) - the slicer has lost \
         its anchors and every assertion over it would be vacuous",
        block.len()
    );
    block
}

#[test]
fn the_display_block_carries_no_em_dash_at_source_either() {
    // The behavioural gate above only sees arms that are CONSTRUCTED. This one sees the
    // whole block, including a comment an author might copy an em dash into on the way
    // to writing the next arm's copy. `73-PATTERNS.md` records that em dashes are
    // endemic in this repo's internal docblocks; inside THIS block they are user copy or
    // one careless paste away from it.
    let block = display_impl_block();
    assert!(
        !block.contains(EM_DASH),
        "a U+2014 survives inside `impl Display for ProjectError`"
    );
}

// ---------------------------------------------------------------------------
// GATE 2: threat T-73-04-01 / T-32-06-01 on a new surface
// ---------------------------------------------------------------------------

/// Every load-failure mode reachable by driving the real `load_project` against a file we
/// control, paired with the variant each is expected to produce.
///
/// The three version-gated arms are produced from a bare leading `u16` varint, which is
/// exactly what `load_project`'s peek reads before it commits to any bundle shape.
fn load_failure_modes(dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let mut out = Vec::new();

    // Io: a path that does not exist. The FIRST thing `load_project` does is stat it.
    out.push(("Io", dir.join("no-such-board.fab")));

    let write = |name: &str, bytes: Vec<u8>| -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, bytes).expect("write fixture");
        p
    };

    // Malformed: bytes that cannot even yield a leading version varint.
    out.push(("Malformed", write("garbage.fab", vec![0xff; 8])));

    let version_only = |v: u16| -> Vec<u8> {
        postcard::to_allocvec(&v).expect("encode a bare u16 version varint")
    };

    out.push((
        "UnknownVersion",
        write("forward.fab", version_only(PROJECT_FILE_VERSION + 5)),
    ));
    out.push(("TooOld", write("ancient.fab", version_only(1))));
    out.push((
        "SlotModelChanged",
        write("v6.fab", version_only(PRE_SLOT_CHANGE_PROJECT_VERSION)),
    ));
    out.push((
        "BeltSpeedModelChanged",
        write("v7.fab", version_only(PRE_SPEED_CHANGE_PROJECT_VERSION)),
    ));

    out
}

#[test]
fn no_variant_produced_from_a_load_leaks_the_path() {
    let dir = known_temp_dir();
    let work = known_temp_dir();
    let dir_str = dir.path().to_string_lossy().into_owned();

    let modes = load_failure_modes(dir.path());
    assert!(
        modes.len() >= 6,
        "the reachable-failure-mode set must not shrink silently to nothing"
    );

    for (expected, path) in modes {
        let err = load_project(&path, work.path(), None)
            .err()
            .unwrap_or_else(|| panic!("{expected}: this fixture must REFUSE, not load"));
        assert_eq!(
            variant_name(&err),
            expected,
            "the fixture for {expected} produced {} instead, so the assertions below are \
             not covering the arm they name",
            variant_name(&err)
        );

        let rendered = err.to_string();
        let file_name = path
            .file_name()
            .expect("fixture path has a file name")
            .to_string_lossy()
            .into_owned();
        assert!(
            !rendered.contains(&dir_str),
            "{expected} leaked the containing DIRECTORY into user copy \
             (threat T-32-06-01 on a new surface).\n  dir:  {dir_str}\n  copy: {rendered}"
        );
        assert!(
            !rendered.contains(&file_name),
            "{expected} leaked the FILE NAME into user copy.\n  \
             file: {file_name}\n  copy: {rendered}"
        );

        // And the GATE 1 properties hold on the arms a real load actually produces, not
        // only on the hand-constructed ones. A construction that diverged from the live
        // path would make this whole file a check that cannot fail.
        assert!(!rendered.contains(EM_DASH), "{expected}: em dash in {rendered}");
        assert!(!rendered.contains(EN_DASH), "{expected}: en dash in {rendered}");
        assert!(
            rendered.trim_end().ends_with('.'),
            "{expected}: no terminal period in {rendered}"
        );
    }
}

#[test]
fn the_clause_the_live_spec_pins_is_actually_what_a_malformed_load_says() {
    // `frontend/e2e-live/29-load-refused-card.spec.ts` pins the exact clause
    // `postcard decode failed`, on ruling R-16 route (a): a clause from a span this
    // plan's reword does not touch, so the live assertion could genuinely have been red.
    // THIS test is what stops the two drifting apart. Reword `Malformed` and the live
    // spec would start passing for the wrong reason (or failing for a reason nobody
    // could locate from the frontend); this reddens in the same commit.
    let dir = known_temp_dir();
    let work = known_temp_dir();
    let path = dir.path().join("garbage.fab");
    std::fs::write(&path, vec![0xff; 8]).expect("write fixture");
    let err = load_project(&path, work.path(), None)
        .err()
        .expect("undecodable bytes must refuse");
    assert_eq!(variant_name(&err), "Malformed");
    assert!(
        err.to_string().contains("postcard decode failed"),
        "the live spec 29-load-refused-card pins this exact clause; it must survive every \
         reword of this arm.\n  got: {err}"
    );
}

// ---------------------------------------------------------------------------
// 85-06: the undo-floor refusal names both numbers
// ---------------------------------------------------------------------------

/// `UndoFloorBreached`'s sentence names the floor and the cursor it was given (D-10: the
/// refusal says what the file claims), ends with a period and carries no em dash. GATE 1
/// above holds the period and the dashes for every arm; this pins the two numbers, which
/// no generic gate can.
#[test]
fn the_undo_floor_refusal_names_both_numbers() {
    let rendered = ProjectError::UndoFloorBreached { floor: 12, cursor: 3 }.to_string();
    assert!(rendered.contains("12"), "the floor is named: {rendered}");
    assert!(rendered.contains(" 3 "), "the cursor is named: {rendered}");
    assert!(rendered.ends_with('.'), "a terminal period: {rendered}");
    assert!(!rendered.contains(EM_DASH), "no em dash: {rendered}");
    assert!(rendered.contains("undo history"), "it says what is wrong in plain words: {rendered}");
}

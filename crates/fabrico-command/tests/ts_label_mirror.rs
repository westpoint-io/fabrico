//! Phase 76 (SHAPE-10, SHAPE-12, D-02, D-05): the label's CROSS-LANGUAGE locks.
//!
//! # What this file holds
//! The label is described twice, once in Rust and once in TypeScript, and every value the
//! two must agree on is locked here, one test per value:
//! - the kind byte: `frontend/src/protocol/kinds.ts` `LABEL:` equals
//!   [`fabrico_protocol::machine_kind::LABEL`];
//! - the colour order: the Rust `LabelColour` variant order (its postcard byte) equals the
//!   TypeScript `LABEL_COLOURS` order in `frontend/src/render/synth/skin.ts`, and byte 6
//!   fails to decode, because the colour set is closed (the `NonZeroU32` precedent: a bad
//!   byte is a decode error, never a silent default).
//!
//! Plans 76-02 and 76-03 add the text bound (`MAX_LABEL_BYTES`), the size caps and the
//! grid bound the label's pending-size outline reads to this file, so one red here always
//! names a label mirror and nothing else.
//!
//! # Why it panics instead of skipping
//! The `include_str!` plus named-anchor plus panic-on-miss idiom of `ts_bound_mirror.rs`
//! and `ts_catalog_mirror.rs`: an extractor that returned nothing and let the comparison
//! pass over it would be a green that measured nothing.
//!
//! Run target: `cargo test -p fabrico-command --test ts_label_mirror`

use fabrico_core::state::LabelColour;
use fabrico_protocol::machine_kind;

/// The frontend kind table, embedded at COMPILE time.
const KINDS_TS: &str = include_str!("../../../frontend/src/protocol/kinds.ts");

/// The skin module that declares the label colour order, embedded at COMPILE time.
const SKIN_TS: &str = include_str!("../../../frontend/src/render/synth/skin.ts");

/// The `machine_kind` entry for the label. Written with its leading newline and indent so
/// a mention of `LABEL:` inside a comment cannot satisfy it.
const KIND_ANCHOR: &str = "\n  LABEL: ";

/// The TypeScript colour-order declaration.
const COLOURS_ANCHOR: &str = "export const LABEL_COLOURS = [";

/// The label kind byte the TypeScript side declares. PANICS on a missing anchor, an
/// unterminated entry, or a value that is not a plain integer.
fn ts_label_kind() -> u8 {
    let start = KINDS_TS.find(KIND_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/protocol/kinds.ts no longer declares {KIND_ANCHOR:?} - the label kind \
             lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &KINDS_TS[start + KIND_ANCHOR.len()..];
    let end = rest
        .find(',')
        .unwrap_or_else(|| panic!("the LABEL entry in kinds.ts is not terminated by `,`"));
    rest[..end].trim().parse::<u8>().unwrap_or_else(|_| {
        panic!(
            "the LABEL entry in kinds.ts is not a plain integer literal (found {:?})",
            rest[..end].trim()
        )
    })
}

/// The colour names the TypeScript side declares, in order. PANICS on a missing anchor, an
/// unterminated array, an element that is not a single-quoted string, or an empty list.
fn ts_label_colours() -> Vec<String> {
    let start = SKIN_TS.find(COLOURS_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/render/synth/skin.ts no longer declares {COLOURS_ANCHOR:?} - the label \
             colour lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &SKIN_TS[start + COLOURS_ANCHOR.len()..];
    let end = rest
        .find(']')
        .unwrap_or_else(|| panic!("the LABEL_COLOURS array in skin.ts is never closed by `]`"));
    let names: Vec<String> = rest[..end]
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| {
            e.strip_prefix('\'')
                .and_then(|e| e.strip_suffix('\''))
                .unwrap_or_else(|| {
                    panic!("a LABEL_COLOURS element in skin.ts is not a single-quoted string: {e:?}")
                })
                .to_owned()
        })
        .collect();
    assert!(
        !names.is_empty(),
        "LABEL_COLOURS in skin.ts declares no colours - nothing to compare"
    );
    names
}

/// THE KIND BYTE. The palette row arms `machine_kind.LABEL`; the host mints a label from
/// `machine_kind::LABEL`. A drift places some other machine, or nothing.
///
/// MUTATION: change the TypeScript literal and this reddens, quoting both values.
#[test]
fn the_typescript_label_kind_equals_the_rust_kind() {
    assert_eq!(
        ts_label_kind(),
        machine_kind::LABEL,
        "frontend/src/protocol/kinds.ts declares LABEL as {}, but \
         fabrico_protocol::machine_kind::LABEL is {}",
        ts_label_kind(),
        machine_kind::LABEL,
    );
}

/// THE COLOUR ORDER. The postcard byte of each `LabelColour` variant is its position; the
/// swatches and the board read the TypeScript position. They must be one order, and the
/// set must be closed at six.
///
/// MUTATION: swap two names in `LABEL_COLOURS` and this reddens at the first index that
/// differs.
#[test]
fn the_rust_colour_order_equals_the_typescript_order_and_the_set_is_closed() {
    let ts = ts_label_colours();
    assert_eq!(ts.len(), 6, "the label palette has six colours (UI-SPEC 3.1), TS has {ts:?}");
    for (b, ts_name) in ts.iter().enumerate() {
        let byte = u8::try_from(b).expect("six colours fit a byte");
        let colour: LabelColour = postcard::from_bytes(&[byte])
            .unwrap_or_else(|e| panic!("LabelColour byte {byte} must decode, got {e:?}"));
        assert_eq!(
            format!("{colour:?}").to_lowercase(),
            *ts_name,
            "LabelColour byte {byte} is {colour:?} in Rust and {ts_name:?} in TypeScript",
        );
        assert_eq!(
            postcard::to_allocvec(&colour).expect("encode"),
            vec![byte],
            "LabelColour {colour:?} must encode as the single byte {byte}",
        );
    }
    assert!(
        postcard::from_bytes::<LabelColour>(&[6]).is_err(),
        "byte 6 must FAIL to decode: the label colour set is closed, and a bad byte is a \
         decode error, never a silent default"
    );
    assert_eq!(LabelColour::default(), LabelColour::Sand, "byte 0, Sand, is the default");
}

// ── plan 76-02: the text bound, MAX_LABEL_BYTES (SHAPE-13 write half) ──────────────────

/// The label panel body, the ONE TypeScript file that may declare the text bound, embedded
/// at COMPILE time so a moved or renamed file is a compile error rather than a check that
/// quietly stops finding anything.
const LABEL_CONFIG_BODY_TSX: &str = include_str!("../../../frontend/src/chrome/LabelConfigBody.tsx");

/// The TypeScript declaration of the text bound.
const TEXT_BOUND_ANCHOR: &str = "export const MAX_LABEL_BYTES = ";

/// The value `LabelConfigBody.tsx` declares for `MAX_LABEL_BYTES`. PANICS on a missing
/// anchor, an unterminated declaration, or a value that is not a plain integer literal.
fn ts_text_bound() -> usize {
    let start = LABEL_CONFIG_BODY_TSX.find(TEXT_BOUND_ANCHOR).unwrap_or_else(|| {
        panic!(
            "frontend/src/chrome/LabelConfigBody.tsx no longer declares {TEXT_BOUND_ANCHOR:?} - \
             the label text bound lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &LABEL_CONFIG_BODY_TSX[start + TEXT_BOUND_ANCHOR.len()..];
    let end = rest.find(';').unwrap_or_else(|| {
        panic!("the MAX_LABEL_BYTES declaration in LabelConfigBody.tsx is not terminated by `;`")
    });
    rest[..end].trim().parse::<usize>().unwrap_or_else(|_| {
        panic!(
            "the MAX_LABEL_BYTES declaration in LabelConfigBody.tsx is not a plain integer \
             literal (found {:?})",
            rest[..end].trim()
        )
    })
}

/// Every production `.ts` / `.tsx` file under `frontend/src`, recursively, as (path,
/// source). Test files are excluded: they ship in no bundle. PANICS if the directory is
/// missing, so a moved tree is a loud failure rather than a walk that finds nothing (the
/// `pace_scale_pin.rs` shape).
fn frontend_sources() -> Vec<(std::path::PathBuf, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../frontend/src");
    assert!(root.is_dir(), "{} is not a directory - nothing to walk", root.display());
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read_dir {dir:?}: {e}")) {
            let path = entry.unwrap_or_else(|e| panic!("dir entry under {dir:?}: {e}")).path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !(name.ends_with(".ts") || name.ends_with(".tsx")) || name.contains(".test.") {
                continue;
            }
            // A cross-language source-text pin reading tracked frontend files, not sim-core
            // I/O; the same narrowly-scoped exemption `pace_scale_pin.rs` takes.
            #[allow(clippy::disallowed_methods)]
            let src = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path:?}: {e}"));
            out.push((path, src));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// THE TEXT BOUND, MIRRORED ONCE AND NEVER RESTATED (D-06, SHAPE-13 write half).
///
/// Three claims, one test, so one red names the one mirror:
/// 1. the literal `LabelConfigBody.tsx` declares equals `fabrico_core::edit::MAX_LABEL_BYTES`
///    (the panel's over-length row counts against the TS value, so a drift tells the user
///    to delete the wrong number of characters, or lets Apply send a text the engine
///    refuses);
/// 2. the frontend source tree declares it in exactly ONE file (a second copy would be an
///    unchecked second truth: `find` reads only the first);
/// 3. no non-comment line of `LabelConfigBody.tsx` other than the declaration carries the
///    numeral (the over-length sentence states the OVERAGE and the bound is never written
///    in copy).
///
/// RED AT THE START REVISION: `LabelConfigBody.tsx` does not exist and
/// `MAX_LABEL_BYTES` is not in `fabrico_core::edit`, so the target fails to compile. RED at
/// a later revision (the body existed, the constant did not): `LabelConfigBody.tsx no longer
/// declares "export const MAX_LABEL_BYTES = "`.
///
/// MUTATION (2026-10-07, throwaway worktree, reverted): the TypeScript literal set to 511
/// reddens this test with `mirrors MAX_LABEL_BYTES as 511, but
/// fabrico_core::edit::MAX_LABEL_BYTES is 512` (left: 511, right: 512).
#[test]
fn the_text_bound_is_mirrored_once_and_never_restated() {
    use fabrico_core::edit::MAX_LABEL_BYTES;
    assert_eq!(
        ts_text_bound(),
        MAX_LABEL_BYTES,
        "frontend/src/chrome/LabelConfigBody.tsx mirrors MAX_LABEL_BYTES as {}, but \
         fabrico_core::edit::MAX_LABEL_BYTES is {}",
        ts_text_bound(),
        MAX_LABEL_BYTES,
    );
    let declaring: Vec<String> = frontend_sources()
        .into_iter()
        .filter(|(_, src)| src.contains(TEXT_BOUND_ANCHOR))
        .map(|(path, _)| path.display().to_string())
        .collect();
    assert_eq!(
        declaring.len(),
        1,
        "MAX_LABEL_BYTES must be declared in exactly one frontend file, found {declaring:?}"
    );
    assert!(
        declaring[0].ends_with("LabelConfigBody.tsx"),
        "the one declaration must be LabelConfigBody.tsx's, found {declaring:?}"
    );
    let numeral = MAX_LABEL_BYTES.to_string();
    for line in LABEL_CONFIG_BODY_TSX.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//")
            || trimmed.starts_with('*')
            || trimmed.starts_with("/*")
            || trimmed.contains(TEXT_BOUND_ANCHOR)
        {
            continue;
        }
        assert!(
            !line.contains(&numeral),
            "LabelConfigBody.tsx restates the bound's numeral ({numeral}) outside its one \
             declaration:\n  {line}\nThe over-length sentence states the OVERAGE"
        );
    }
}

// ── plan 76-03: the size caps, LABEL_MAX_W and LABEL_MAX_H (SHAPE-12, D-04) ─────────────

/// The TypeScript declarations of the two size caps.
const MAX_W_ANCHOR: &str = "export const LABEL_MAX_W = ";
const MAX_H_ANCHOR: &str = "export const LABEL_MAX_H = ";

/// The value `LabelConfigBody.tsx` declares after `anchor`. PANICS on a missing anchor, an
/// unterminated declaration, or a value that is not a plain integer literal.
fn ts_cap(anchor: &str) -> u16 {
    let start = LABEL_CONFIG_BODY_TSX.find(anchor).unwrap_or_else(|| {
        panic!(
            "frontend/src/chrome/LabelConfigBody.tsx no longer declares {anchor:?} - the label \
             size cap lock cannot see the mirror and must not pass silently"
        )
    });
    let rest = &LABEL_CONFIG_BODY_TSX[start + anchor.len()..];
    let end = rest.find(';').unwrap_or_else(|| {
        panic!("the {anchor:?} declaration in LabelConfigBody.tsx is not terminated by `;`")
    });
    rest[..end].trim().parse::<u16>().unwrap_or_else(|_| {
        panic!(
            "the {anchor:?} declaration in LabelConfigBody.tsx is not a plain integer literal \
             (found {:?})",
            rest[..end].trim()
        )
    })
}

/// THE SIZE CAPS, MIRRORED ONCE AND NEVER TYPED IN COPY (D-04, SHAPE-12, UI-SPEC 5.3).
///
/// The steppers disable their plus button at the TypeScript caps; the `Configure` write
/// gate refuses a size outside `fabrico_command::LABEL_MAX_W` by `LABEL_MAX_H` as
/// `Malformed`. A drift either strands a user one press short of a size the engine
/// accepts, or offers a press the engine refuses with a sentence that does not explain it.
///
/// Three claims, one test:
/// 1. both TypeScript literals equal the Rust constants;
/// 2. each is declared in exactly ONE frontend file, `LabelConfigBody.tsx`;
/// 3. no non-comment line of `LabelConfigBody.tsx` carries `16 wide` or `8 deep`: the hint
///    is BUILT from the constants, so a cap change moves the sentence with it.
///
/// RED AT THE START REVISION: `LabelConfigBody.tsx no longer declares
/// "export const LABEL_MAX_W = "`.
#[test]
fn the_size_caps_are_mirrored_once() {
    use fabrico_command::{LABEL_MAX_H, LABEL_MAX_W};
    for (anchor, ts, rust, name) in [
        (MAX_W_ANCHOR, ts_cap(MAX_W_ANCHOR), LABEL_MAX_W, "LABEL_MAX_W"),
        (MAX_H_ANCHOR, ts_cap(MAX_H_ANCHOR), LABEL_MAX_H, "LABEL_MAX_H"),
    ] {
        assert_eq!(
            ts, rust,
            "frontend/src/chrome/LabelConfigBody.tsx mirrors {name} as {ts}, but \
             fabrico_command::{name} is {rust}",
        );
        let declaring: Vec<String> = frontend_sources()
            .into_iter()
            .filter(|(_, src)| src.contains(anchor))
            .map(|(path, _)| path.display().to_string())
            .collect();
        assert_eq!(
            declaring.len(),
            1,
            "{name} must be declared in exactly one frontend file, found {declaring:?}"
        );
        assert!(
            declaring[0].ends_with("LabelConfigBody.tsx"),
            "the one {name} declaration must be LabelConfigBody.tsx's, found {declaring:?}"
        );
    }
    let typed = [format!("{LABEL_MAX_W} wide"), format!("{LABEL_MAX_H} deep")];
    for line in LABEL_CONFIG_BODY_TSX.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*") {
            continue;
        }
        for t in &typed {
            assert!(
                !line.contains(t.as_str()),
                "LabelConfigBody.tsx types the cap as {t:?} in code:\n  {line}\nThe size hint is \
                 built from LABEL_MAX_W and LABEL_MAX_H"
            );
        }
    }
}

// ── plan 76-03: the grid bound the pending-size prediction reads ────────────────────────

/// The client prediction module, which declares the frontend's one copy of the grid
/// bound, embedded at COMPILE time.
const GHOST_TS: &str = include_str!("../../../frontend/src/input/ghost.ts");

/// The value `ghost.ts` declares after `anchor`. PANICS on a missing anchor, an
/// unterminated declaration, or a value that is not a plain integer literal.
fn ts_grid_bound(anchor: &str) -> i32 {
    let start = GHOST_TS.find(anchor).unwrap_or_else(|| {
        panic!(
            "frontend/src/input/ghost.ts no longer declares {anchor:?} - the grid bound lock \
             cannot see the mirror and must not pass silently"
        )
    });
    let rest = &GHOST_TS[start + anchor.len()..];
    let end = rest
        .find(';')
        .unwrap_or_else(|| panic!("the {anchor:?} declaration in ghost.ts is not terminated by `;`"));
    rest[..end].trim().parse::<i32>().unwrap_or_else(|_| {
        panic!(
            "the {anchor:?} declaration in ghost.ts is not a plain integer literal (found {:?})",
            rest[..end].trim()
        )
    })
}

/// THE GRID BOUND THE LABEL'S PENDING-SIZE OUTLINE READS (plan 76-03, 76-UI-SPEC 5.4).
///
/// The outline turns `fault` for a growth past the grid edge, which the `Configure` arm
/// refuses as `OutOfBounds`. Until this plan the frontend kept no copy of the bound
/// (`protocol/addOutput.ts` records why: an unchecked second copy drifts); this is the
/// one copy, and it is checked. Both literals equal `fabrico_core::state::GRID_MIN` /
/// `GRID_MAX`, each declared in exactly one frontend file, `ghost.ts`.
///
/// MUTATION (2026-10-07, throwaway worktree, reverted): `GRID_MAX` set to 511 in
/// `ghost.ts` reddens this with `ghost.ts mirrors GRID_MAX as 511, but
/// fabrico_core::state::GRID_MAX is 512`.
#[test]
fn the_grid_bound_the_prediction_reads_is_the_engines() {
    use fabrico_core::state::{GRID_MAX, GRID_MIN};
    for (anchor, rust, name) in [
        ("export const GRID_MIN = ", GRID_MIN, "GRID_MIN"),
        ("export const GRID_MAX = ", GRID_MAX, "GRID_MAX"),
    ] {
        let ts = ts_grid_bound(anchor);
        assert_eq!(
            ts, rust,
            "frontend/src/input/ghost.ts mirrors {name} as {ts}, but \
             fabrico_core::state::{name} is {rust}",
        );
        let declaring: Vec<String> = frontend_sources()
            .into_iter()
            .filter(|(_, src)| src.contains(anchor))
            .map(|(path, _)| path.display().to_string())
            .collect();
        assert_eq!(
            declaring.len(),
            1,
            "{name} must be declared in exactly one frontend file, found {declaring:?}"
        );
        assert!(
            declaring[0].ends_with("ghost.ts"),
            "the one {name} declaration must be ghost.ts's, found {declaring:?}"
        );
    }
}

// ── plan 89-09: the belt length cap the belt preview reads ──────────────────────────────

/// The anchor of the frontend's one copy of the belt length cap, in `ghost.ts`.
const MAX_BELT_TILES_ANCHOR: &str = "export const MAX_BELT_TILES = ";

/// THE BELT LENGTH CAP THE PREVIEW READS (plan 89-09, D-12, WINDOWS 251, UI-SPEC 6.1).
///
/// The belt preview turns red for a path of more tiles than the host draws, which the DrawBelt arm
/// refuses as `BeltTooLong`, and a release of such a path sends at most one tile more than the cap.
/// The literal is read through the same panicking extractor as the grid bound above, so a missing
/// or computed declaration fails here instead of passing silently.
///
/// MUTATION (2026-10-23, throwaway worktree, reverted): `MAX_BELT_TILES` set to 1023 in `ghost.ts`
/// reddens this with `ghost.ts mirrors MAX_BELT_TILES as 1023, but
/// fabrico_core::edit::MAX_BELT_TILES is 1024` (89-EVIDENCE.md, `mirror-mut.out`).
#[test]
fn the_belt_length_cap_the_preview_reads_is_the_engines() {
    let ts = ts_grid_bound(MAX_BELT_TILES_ANCHOR);
    let rust = fabrico_core::edit::MAX_BELT_TILES;
    assert_eq!(
        i64::from(ts),
        i64::from(rust),
        "frontend/src/input/ghost.ts mirrors MAX_BELT_TILES as {ts}, but \
         fabrico_core::edit::MAX_BELT_TILES is {rust}",
    );
    assert!(
        GHOST_TS.contains(&format!("{MAX_BELT_TILES_ANCHOR}{ts};")),
        "the parsed value {ts} does not round-trip against the ghost.ts source text the anchor \
         introduces - the extractor read something other than the declaration"
    );
}

/// THE CAP IS MIRRORED ONCE (plan 89-09). `find` returns the first match, so a second declaration
/// anywhere in the frontend would be an unchecked second truth this file's anchor is blind to.
#[test]
fn the_belt_length_cap_is_declared_in_one_place() {
    assert_eq!(
        GHOST_TS.matches(MAX_BELT_TILES_ANCHOR).count(),
        1,
        "ghost.ts declares MAX_BELT_TILES more than once"
    );
    let declaring: Vec<String> = frontend_sources()
        .into_iter()
        .filter(|(_, src)| src.contains(MAX_BELT_TILES_ANCHOR))
        .map(|(path, _)| path.display().to_string())
        .collect();
    assert_eq!(
        declaring.len(),
        1,
        "MAX_BELT_TILES must be declared in exactly one frontend file, found {declaring:?}"
    );
    assert!(
        declaring[0].ends_with("ghost.ts"),
        "the one MAX_BELT_TILES declaration must be ghost.ts's, found {declaring:?}"
    );
}

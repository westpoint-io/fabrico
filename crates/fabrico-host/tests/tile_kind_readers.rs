//! CORNER-01 (phase 74.1 gap closure, plan 74.1-07): A SECOND TRUTH FOR A TILE KIND
//! CANNOT LEAK.
//!
//! # The risk this guards (74.1-SEAM-DESIGN.md section 8, risk 1)
//!
//! Since plan 74.1-07 a belt has two kinds at a docked end: the STORED kind `route()`
//! authored (hashed, snapshotted, logged, replayed) and the DRAWN kind
//! `GridState::effective_belt_tiles` derives from the seam and the render packet ships.
//! They differ at every perpendicular dock, on purpose. That is safe exactly as long as
//! nothing in the simulation reads a tile kind: the sim moves items by slot index, so
//! today no fold, no tick and no command decision looks at a kind at all. A future reader
//! that picked up the stored kind would quietly disagree with the picture.
//!
//! # The rule
//!
//! Any non-test code that reads a tile kind lives in one of four files:
//! `fabrico-host/src/render_packet.rs` (the one display reader),
//! `fabrico-command/src/route.rs` and `fabrico-command/src/wire_route.rs` (the producers),
//! and `fabrico-core/src/state.rs` (the type and the derivation). If a later phase needs
//! a kind inside the sim (a corner's length or speed), it calls `effective_belt_tiles`
//! from inside the fold, which is a DECLARED replay move at that point, and adds its file
//! here with that reason.
//!
//! # The type enforces the field; this guard enforces the accessor (plan 74.1-21)
//!
//! Review WR-04 found the line-text detector below blind to the likeliest read shapes: a
//! loop binding (`for t in &b.geometry {` then `t.kind`), an end-tile binding
//! (`let end = b.geometry.last()?;` then `end.kind`), a destructure
//! (`let BeltTile { kind, .. } = ..`) and a read off `effective_belt_tiles`' result
//! (`drawn[0].kind`). None of those lines names a tile or a geometry next to `.kind`.
//!
//! So `BeltTile`'s `kind` field is now PRIVATE to `fabrico-core/src/state.rs`. Outside that
//! module every one of those shapes is a compile error (two `compile_fail` doctests on
//! `BeltTile` pin the field read and the destructure), and the only way left to read a
//! stored kind is the accessor `BeltTile::tile_kind()`. This guard counts that one name,
//! so whatever binding or expression the tile sits in, the read is seen.
//!
//! # What counts as a read (the token set)
//!
//! On every non-comment line outside a `#[cfg(test)]` item:
//! 1. the identifier `tile_kind` (the one read path, `BeltTile::tile_kind()`, on any
//!    receiver);
//! 2. the word `TileKind` (an import, a match arm, a construction);
//! 3. `TileKindView::` (a wire kind variant matched or built);
//! 4. a `.kind` field access on a line that also names a tile or a geometry
//!    (`geometry[0].kind`, `tile.kind`, `tiles[i].kind`), the receiver being a belt tile.
//!    Kept from plan 74.1-07; outside `state.rs` such a line no longer compiles.
//!
//! The protocol crate's own `pub enum TileKindView { .. }` / `pub kind: TileKindView`
//! DEFINITIONS match none of the four, so the wire type can live where it lives. The
//! walk is deterministic: `crates/*/src`, every `.rs` file, sorted by path. Watched RED by
//! two planted readers in a throwaway worktree (a `geometry[0].kind` read in non-test
//! `fabrico-core/src/tick.rs`, a `TileKind::Corner` match in non-test
//! `fabrico-command/src/command.rs`); see `74.1-07-SUMMARY.md`. Plan 74.1-21 planted the
//! loop-binding form the old token set missed (`for t in &b.geometry {` then
//! `t.tile_kind()`, non-test `tick.rs`) and watched this guard go RED; see
//! `74.1-21-SUMMARY.md`.
//!
//! Run target: `cargo test -p fabrico-host --test tile_kind_readers`.

// `fabrico-host` is the project's sanctioned I/O home; reading source files off disk is
// exactly the test IO that belongs here. Same allowance, same reason, as
// `tests/belt_run_save_reload.rs`.
#![allow(clippy::disallowed_methods)]

use std::path::{Path, PathBuf};

/// The four files allowed to read a tile kind, as paths relative to the `crates` dir.
const ALLOWED: [&str; 4] = [
    "fabrico-engine/src/render_packet.rs",
    "fabrico-command/src/route.rs",
    "fabrico-command/src/wire_route.rs",
    "fabrico-core/src/state.rs",
];

/// The `crates` directory, resolved from this crate's manifest dir.
fn crates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("fabrico-host sits inside crates/")
        .to_path_buf()
}

/// Every `.rs` file under `dir`, recursively, sorted by path.
fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|e| e.expect("dir entry").path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// Every non-test `.rs` file under `crates/*/src`, as `(path relative to crates/, text)`,
/// sorted by path.
fn source_files() -> Vec<(String, String)> {
    let crates = crates_dir();
    let mut roots: Vec<PathBuf> = std::fs::read_dir(&crates)
        .expect("read crates/")
        .map(|e| e.expect("dir entry").path().join("src"))
        .filter(|p| p.is_dir())
        .collect();
    roots.sort();
    let mut files = Vec::new();
    for r in &roots {
        rust_files(r, &mut files);
    }
    files
        .into_iter()
        .map(|p| {
            let rel = p
                .strip_prefix(&crates)
                .expect("under crates/")
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {rel}: {e}"));
            (rel, text)
        })
        .collect()
}

/// The line's leading whitespace.
fn indent(line: &str) -> &str {
    &line[..line.len() - line.trim_start().len()]
}

/// The 1-based numbers and texts of the code lines OUTSIDE every `#[cfg(test)]` item, with
/// comment lines dropped and a trailing ` // ...` comment cut.
///
/// A `#[cfg(test)]` item is skipped from the attribute to its end: a one-line item ending
/// in `;`, or every line up to the `}` at the item's own indentation (the house layout,
/// which every file under `crates/*/src` follows). An item whose end cannot be found
/// PANICS, naming the file and line, rather than silently hiding the rest of the file.
fn code_lines<'a>(rel: &str, text: &'a str) -> Vec<(usize, &'a str)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let t = lines[i].trim();
        if t == "#[cfg(test)]" {
            // Find the item line: past further attributes and doc comments.
            let mut j = i + 1;
            while j < lines.len() {
                let u = lines[j].trim();
                if u.starts_with("#[") || u.starts_with("//") || u.is_empty() {
                    j += 1;
                } else {
                    break;
                }
            }
            assert!(j < lines.len(), "{rel}:{}: #[cfg(test)] with no item after it", i + 1);
            if lines[j].trim_end().ends_with(';') {
                i = j + 1;
                continue;
            }
            let close = format!("{}}}", indent(lines[j]));
            let end = (j..lines.len())
                .find(|&k| lines[k].trim_end() == close)
                .unwrap_or_else(|| {
                    panic!("{rel}:{}: cannot find the end of this #[cfg(test)] item", i + 1)
                });
            i = end + 1;
            continue;
        }
        if !t.starts_with("//") && !t.is_empty() {
            let code = match lines[i].find(" // ") {
                Some(c) => &lines[i][..c],
                None => lines[i],
            };
            out.push((i + 1, code));
        }
        i += 1;
    }
    out
}

fn is_ident(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether `line` contains `word` as a whole identifier.
fn has_word(line: &str, word: &str) -> bool {
    line.match_indices(word).any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + word.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

/// Whether `line` reads a `.kind` field (not `.kinds`, not `.kind_of`).
fn reads_kind_field(line: &str) -> bool {
    line.match_indices(".kind").any(|(at, _)| {
        let after = line[at + ".kind".len()..].chars().next();
        !after.is_some_and(is_ident)
    })
}

/// Why `line` reads a tile kind, or `None`.
fn tile_kind_read(line: &str) -> Option<&'static str> {
    if has_word(line, "tile_kind") {
        return Some("calls `tile_kind()`, the one read path for a stored kind");
    }
    if has_word(line, "TileKind") {
        return Some("names `TileKind`");
    }
    if line.contains("TileKindView::") {
        return Some("names a `TileKindView::` variant");
    }
    let lower = line.to_ascii_lowercase();
    if reads_kind_field(line) && (lower.contains("tile") || lower.contains("geometry")) {
        return Some("reads `.kind` off a tile or a geometry element");
    }
    None
}

/// Every tile-kind read in the non-test code of `files`, as `file:line: why: code`.
fn reads_in(files: &[(String, String)]) -> Vec<String> {
    let mut found = Vec::new();
    for (rel, text) in files {
        for (n, code) in code_lines(rel, text) {
            if let Some(why) = tile_kind_read(code) {
                found.push(format!("{rel}:{n}: {why}: {}", code.trim()));
            }
        }
    }
    found
}

#[test]
fn no_file_outside_the_four_reads_a_tile_kind() {
    let files = source_files();
    assert!(
        files.len() >= 50,
        "the walk found {} source files under crates/*/src; it is not looking where it should",
        files.len()
    );
    let others: Vec<(String, String)> = files
        .iter()
        .filter(|(rel, _)| !ALLOWED.contains(&rel.as_str()))
        .cloned()
        .collect();
    let leaks = reads_in(&others);
    assert!(
        leaks.is_empty(),
        "a tile kind is read outside the four files allowed to (render_packet.rs, route.rs, \
         wire_route.rs, state.rs). The stored kind and the drawn kind differ at a docked end; \
         a sim reader must call GridState::effective_belt_tiles from inside the fold as a \
         DECLARED replay move, and then be added to ALLOWED here:\n{}",
        leaks.join("\n")
    );
}

/// The allowed files that DO read a tile kind in non-test code today. `wire_route.rs` is
/// allowed (it produces cable tiles through `route()`) but reads no kind itself yet.
const READING_TODAY: [&str; 3] = [
    "fabrico-engine/src/render_packet.rs",
    "fabrico-command/src/route.rs",
    "fabrico-core/src/state.rs",
];

#[test]
fn the_detector_fires_on_the_allowed_files_that_read_a_kind() {
    // Non-vacuity: the walk finds all four allowed files, and the three that read a tile
    // kind in non-test code today are SEEN reading it. If the token set stopped matching
    // real code, or the walk stopped finding these files, the guard above would pass on
    // nothing.
    let files = source_files();
    for allowed in ALLOWED {
        assert_eq!(
            files.iter().filter(|(rel, _)| rel == allowed).count(),
            1,
            "the walk finds {allowed}"
        );
    }
    for reader in READING_TODAY {
        let file: Vec<(String, String)> = files
            .iter()
            .filter(|(rel, _)| rel == reader)
            .cloned()
            .collect();
        assert!(
            !reads_in(&file).is_empty(),
            "the detector sees the tile-kind reads in {reader}"
        );
    }
}

#[test]
fn the_detector_reads_each_token_and_ignores_test_items_and_comments() {
    let probe = "\
fn live(b: &Belt) -> bool {
    let k = b.geometry[0].kind;
    // a comment naming TileKind is not a read
    matches!(k, TileKind::Corner { .. })
}
fn wire(v: TileKindView) -> u8 {
    match v { TileKindView::Straight { axis } => axis, _ => 0 }
}
pub struct NotARead { pub kind: TileKindView }
#[cfg(test)]
mod tests {
    fn t(b: &Belt) { let _ = b.geometry[0].kind; let _ = TileKind::default(); }
}
#[cfg(test)]
fn helper() -> TileKind {
    TileKind::default()
}
fn machine(e: &Entry) -> u8 { e.kind }
";
    let hits: Vec<usize> = code_lines("probe.rs", probe)
        .into_iter()
        .filter(|(_, code)| tile_kind_read(code).is_some())
        .map(|(n, _)| n)
        .collect();
    assert_eq!(
        hits,
        vec![2, 4, 7],
        "the geometry `.kind` read, the TileKind match and the TileKindView:: match are hits; \
         the comment, the struct definition, both test items and a machine `.kind` are not"
    );
}

#[test]
fn the_detector_sees_every_read_shape_the_review_named() {
    // Review WR-04's four shapes, written as they must be written now that `BeltTile`'s
    // `kind` is private. Three go through the accessor and are REQUIRED hits here, each on
    // the accessor token and on nothing else (none of these lines names a tile or a
    // geometry next to a `.kind`, which is why the 74.1-07 token set missed them). The
    // fourth, the destructure `let BeltTile { kind, .. } = ..`, no longer compiles outside
    // `state.rs`; the `compile_fail` doctest on `BeltTile` covers it.
    let probe = "\
fn loop_binding(b: &Belt, prev: Kind) -> bool {
    for t in &b.geometry {
        if t.tile_kind() != prev {
            return true;
        }
    }
    false
}
fn end_tile(b: &Belt) -> Option<bool> {
    let end = b.geometry.last()?;
    Some(is_corner(end.tile_kind()))
}
fn drawn_tile(s: &GridState, id: NodeId) -> Option<bool> {
    let drawn = s.effective_belt_tiles(id, None)?;
    Some(is_corner(drawn[0].tile_kind()))
}
fn not_a_read(m: &Machine) -> u8 { m.tile_kinds_seen }
";
    let hits: Vec<(usize, &'static str)> = code_lines("probe.rs", probe)
        .into_iter()
        .filter_map(|(n, code)| tile_kind_read(code).map(|why| (n, why)))
        .collect();
    let accessor = "calls `tile_kind()`, the one read path for a stored kind";
    assert_eq!(
        hits,
        vec![(3, accessor), (11, accessor), (15, accessor)],
        "the loop binding (`t.tile_kind()`), the end-tile binding (`end.tile_kind()`) and the \
         drawn tile off effective_belt_tiles (`drawn[0].tile_kind()`) are each a hit on the \
         accessor; an identifier that merely starts with `tile_kind` is not"
    );
}

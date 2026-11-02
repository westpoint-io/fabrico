//! The native half of the wasm corpus comparison. Run from the repo root, it replays the fixtures
//! through the same library code the wasm module runs and prints a report at this revision:
//!
//! - `T <family> <fixture> <tick index> <hash>` for each tick
//! - `F <family> <fixture> <fault count>` for each fixture
//!
//! `scripts/wasm/run-corpus.mjs` compares those lines with the wasm build's.
//!
//! The tick count comes from `hash_lines` in `meta.toml`, not from `hashes.txt`, so a shortened
//! hashes file can't shorten the replay with it.
//!
//! EXIT CODES: 0 the report was printed, 1 a fixture wouldn't decode or stdout failed, 2 the walk
//! found nothing.

// This tool reads fixtures from disk. The lint's rule is about the simulation, and this file never
// runs inside one.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use fabrico_wasm_corpus::{Replay, replay_golden};

const GOLDEN_DIR: &str = "crates/fabrico-core/tests/golden";

/// A failure and the exit code it maps to.
struct Stop {
    code: u8,
    message: String,
}

fn stop(code: u8, message: String) -> Stop {
    Stop { code, message }
}

/// The directories under `root` that hold `meta.toml`, the registration guard's rule, in byte order
/// of name.
fn golden_fixtures(root: &Path) -> Result<Vec<(String, PathBuf)>, Stop> {
    let entries = fs::read_dir(root)
        .map_err(|e| stop(2, format!("can't read {}: {e}", root.display())))?;
    let mut fixtures = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| stop(2, format!("can't read {}: {e}", root.display())))?;
        let path = entry.path();
        if path.join("meta.toml").is_file() {
            fixtures.push((entry.file_name().to_string_lossy().into_owned(), path));
        }
    }
    fixtures.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(fixtures)
}

/// The `hash_lines` value from a `meta.toml`, read as a plain line.
fn hash_lines(meta: &str) -> Option<u32> {
    meta.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() == "hash_lines" {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

fn read(fixture: &str, path: &Path) -> Result<Vec<u8>, Stop> {
    fs::read(path).map_err(|e| stop(1, format!("{fixture}: can't read {}: {e}", path.display())))
}

fn replay_golden_fixture(name: &str, dir: &Path) -> Result<Replay, Stop> {
    let meta = read(name, &dir.join("meta.toml"))?;
    let meta = String::from_utf8_lossy(&meta);
    let ticks = hash_lines(&meta)
        .ok_or_else(|| stop(1, format!("{name}: meta.toml has no hash_lines value")))?;
    let genesis = read(name, &dir.join("genesis.snapshot"))?;
    let log = read(name, &dir.join("log.postcard"))?;
    let edit_log = read(name, &dir.join("edit-log.postcard"))?;
    replay_golden(&genesis, &log, &edit_log, ticks)
        .map_err(|e| stop(1, format!("{name}: won't decode: {e}")))
}

fn print_replay(out: &mut impl Write, family: &str, name: &str, replay: &Replay) -> Result<(), Stop> {
    let failed = |e: io::Error| stop(1, format!("can't write the report: {e}"));
    for (index, hash) in replay.hashes.iter().enumerate() {
        writeln!(out, "T {family} {name} {index} {hash}").map_err(failed)?;
    }
    writeln!(out, "F {family} {name} {}", replay.faults).map_err(failed)
}

fn run() -> Result<(), Stop> {
    let mut out = BufWriter::new(io::stdout().lock());

    let golden = golden_fixtures(Path::new(GOLDEN_DIR))?;
    if golden.is_empty() {
        return Err(stop(2, format!("no fixture directories under {GOLDEN_DIR}")));
    }
    for (name, dir) in &golden {
        let replay = replay_golden_fixture(name, dir)?;
        print_replay(&mut out, "golden", name, &replay)?;
    }

    out.flush().map_err(|e| stop(1, format!("can't write the report: {e}")))
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(Stop { code, message }) => {
            eprintln!("corpus_native: {message}");
            ExitCode::from(code)
        }
    }
}

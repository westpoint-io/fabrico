//! The native half of the wasm corpus comparison. Run from the repo root, it replays the fixtures
//! through the same library code the wasm module runs and prints a report at this revision:
//!
//! - `T <family> <fixture> <tick index> <hash>` for each tick
//! - `F <family> <fixture> <fault count>` for each fixture
//!
//! `scripts/wasm/run-corpus.mjs` compares those lines with the wasm build's.
//!
//! With `--fence --pins <path>` it prints the native half of the fence report in place of the
//! corpus report, one `FENCE` line per fact, from the same shape programs the wasm build runs.
//! `scripts/wasm/fence-report.mjs` describes the lines and the rules.
//!
//! The tick count comes from `hash_lines` in `meta.toml`, not from `hashes.txt`, so a shortened
//! hashes file can't shorten the replay with it.
//!
//! EXIT CODES: 0 the report was printed, 1 a fixture wouldn't decode or stdout failed, 2 the walk
//! found nothing, or the fence arguments or the pins file couldn't be read.

// This tool reads fixtures from disk. The lint's rule is about the simulation, and this file never
// runs inside one.
#![allow(clippy::disallowed_methods)]

use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use fabrico_core::factory::{DEFAULT_GAS_BUDGET, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT};
use fabrico_wasm_corpus::{FENCE_RAN, Replay, UNSPENDABLE_GAS, fence, replay_golden, replay_scenario, shape};

const GOLDEN_DIR: &str = "crates/fabrico-core/tests/golden";
const SCENARIO_DIR: &str = "crates/fabrico-scenario/fixtures";

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

/// The `.postcard` files under `root`, in byte order of name, each with its file stem.
fn scenario_fixtures(root: &Path) -> Result<Vec<(String, PathBuf)>, Stop> {
    let entries = fs::read_dir(root)
        .map_err(|e| stop(2, format!("can't read {}: {e}", root.display())))?;
    let mut fixtures = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| stop(2, format!("can't read {}: {e}", root.display())))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".postcard") {
            fixtures.push((stem.to_owned(), entry.path()));
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

    let scenarios = scenario_fixtures(Path::new(SCENARIO_DIR))?;
    if scenarios.is_empty() {
        return Err(stop(2, format!("no .postcard files under {SCENARIO_DIR}")));
    }
    for (name, path) in &scenarios {
        let bytes = read(name, path)?;
        let replay = replay_scenario(&bytes)
            .map_err(|e| stop(1, format!("{name}: won't decode: {e}")))?;
        print_replay(&mut out, "scenario", name, &replay)?;
    }

    out.flush().map_err(|e| stop(1, format!("can't write the report: {e}")))
}

/// The memory shapes in report order, with each one's shape number and search ceiling, the same
/// ceilings the native pins search to.
const MEMORY_SHAPES: [(&str, u32, u64); 4] = [
    ("arrays", shape::ARRAYS, 20_000),
    ("strings", shape::STRINGS, 50_000),
    ("objects", shape::OBJECTS, 2_000_000),
    ("cyclic", shape::CYCLIC, 2_000_000),
];

/// How far the gas loop and the recursion searches go.
const GAS_CEILING: u64 = 100_000_000;
const RECURSION_CEILING: u64 = 100_000;

/// What this tool takes from a pins file.
struct Pins {
    /// The `native <shape> <count>` lines.
    native: Vec<(String, u64)>,
    /// The `gas <count>` line, where the gas search starts.
    gas: Option<u64>,
}

/// The native counts and the gas hint from a pins file: `<target> <shape> <count>` and
/// `gas <count>` lines, with `#` comments and blank lines skipped.
fn read_pins(path: &Path) -> Result<Pins, Stop> {
    let text = fs::read_to_string(path)
        .map_err(|e| stop(2, format!("can't read the pins file {}: {e}", path.display())))?;
    let mut native = Vec::new();
    let mut gas = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        let bad = || stop(2, format!("the pins file has a line this tool can't read: {line}"));
        match fields.as_slice() {
            ["gas", count] => gas = Some(count.parse().map_err(|_| bad())?),
            [target, name, count] => {
                let count: u64 = count.parse().map_err(|_| bad())?;
                if *target == "native" {
                    native.push(((*name).to_owned(), count));
                }
            }
            _ => return Err(bad()),
        }
    }
    Ok(Pins { native, gas })
}

/// The first count that doesn't run, using `hint` when `hint - 1` runs and `hint` doesn't, and
/// searching `1..=ceiling` otherwise. A count that still runs at the ceiling reports the ceiling
/// plus 1, which no pin equals.
fn first_fault(hint: Option<u64>, ceiling: u64, faults: impl Fn(u64) -> bool) -> u64 {
    if let Some(hint) = hint.filter(|hint| *hint > 1)
        && !faults(hint - 1)
        && faults(hint)
    {
        return hint;
    }
    if !faults(ceiling) {
        return ceiling + 1;
    }
    let (mut low, mut high) = (1, ceiling);
    while low < high {
        let middle = low + (high - low) / 2;
        if faults(middle) {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    low
}

fn faults_at(shape: u32, gas: u64) -> impl Fn(u64) -> bool {
    move |n| fence(shape, n, gas, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT).0 != FENCE_RAN
}

fn run_fence(pins: &Path) -> Result<(), Stop> {
    let Pins { native, gas: gas_hint } = read_pins(pins)?;
    let mut out = BufWriter::new(io::stdout().lock());
    let failed = |e: io::Error| stop(1, format!("can't write the report: {e}"));

    let gas = first_fault(gas_hint, GAS_CEILING, faults_at(shape::GAS_LOOP, DEFAULT_GAS_BUDGET));
    writeln!(out, "FENCE gas native {gas}").map_err(failed)?;
    for (name, number, ceiling) in MEMORY_SHAPES {
        let hint = native.iter().find(|(pinned, _)| pinned == name).map(|(_, count)| *count);
        let count = first_fault(hint, ceiling, faults_at(number, UNSPENDABLE_GAS));
        writeln!(out, "FENCE memory native {name} {count}").map_err(failed)?;
    }
    let plain = first_fault(None, RECURSION_CEILING, faults_at(shape::RECURSION, UNSPENDABLE_GAS));
    let map = first_fault(None, RECURSION_CEILING, faults_at(shape::MAP_RECURSION, UNSPENDABLE_GAS));
    writeln!(out, "FENCE stack native first_fault={plain} map_first_fault={map} limit={DEFAULT_STACK_LIMIT}")
        .map_err(failed)?;
    writeln!(out, "FENCE limits native mem={DEFAULT_MEM_LIMIT} gas={DEFAULT_GAS_BUDGET}").map_err(failed)?;
    out.flush().map_err(|e| stop(1, format!("can't write the report: {e}")))
}

/// `Some(path)` for `--fence --pins <path>`, `None` for no arguments.
fn fence_args() -> Result<Option<PathBuf>, Stop> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => Ok(None),
        [fence, pins, path] if fence == "--fence" && pins == "--pins" => Ok(Some(PathBuf::from(path))),
        _ => Err(stop(2, format!("unknown arguments {args:?}; use none, or --fence --pins <path>"))),
    }
}

fn main() -> ExitCode {
    let result = match fence_args() {
        Ok(Some(pins)) => run_fence(&pins),
        Ok(None) => run(),
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(Stop { code, message }) => {
            eprintln!("corpus_native: {message}");
            ExitCode::from(code)
        }
    }
}

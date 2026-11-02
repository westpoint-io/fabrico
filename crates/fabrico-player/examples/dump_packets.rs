//! Writes what a native `Player` emits for each board, so a check can compare the wasm build with
//! it byte for byte.
//!
//! Run it from the repo root with an output directory. It walks `examples/boards/` at any depth,
//! as the board manifest's test does, and steps each board one tick at a time. Each board gets
//! three files, named after its path with `/` turned into `_`. Record N in each file belongs to the
//! same moment, and record 0 is the board just after boot:
//!
//! - `<name>.packets`: each packet prefixed with its length as a little-endian `u32`.
//! - `<name>.effects`: the same framing, holding that tick's `take_effects` bytes. A tick with no
//!   effects holds the encoding of an empty list.
//! - `<name>.hashes`: one `<tick> <hash>` line per record.
//!
//! Exits 1 naming any board that won't run, and 2 if the walk or a write fails.

// This tool reads boards and writes dump files, so the file lints for the simulation don't apply.
#![allow(clippy::disallowed_methods)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::{env, fs, io};

use fabrico_player::Player;

const BOARDS_DIR: &str = "examples/boards";

/// Every `*.board.ron` under `dir`, at any depth, as (repo-relative path, path on disk).
fn board_files(dir: &Path, relative: &str, found: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return Err(io::Error::other(format!("{} isn't UTF-8", path.display())));
        };
        let child = format!("{relative}/{name}");
        if path.is_dir() {
            board_files(&path, &child, found)?;
        } else if name.ends_with(".board.ron") {
            found.push((child, path));
        }
    }
    Ok(())
}

fn push_record(file: &mut Vec<u8>, record: &[u8]) -> Result<(), String> {
    let len = u32::try_from(record.len()).map_err(|_| format!("a record of {} bytes", record.len()))?;
    file.extend_from_slice(&len.to_le_bytes());
    file.extend_from_slice(record);
    Ok(())
}

/// The three files of one board.
struct Dump {
    packets: Vec<u8>,
    effects: Vec<u8>,
    hashes: String,
}

impl Dump {
    /// Add one record to each file. A tick has to have queued exactly one packet.
    fn record(&mut self, player: &mut Player) -> Result<(), String> {
        let tick = player.tick();
        let packet = player.take_packet().ok_or_else(|| format!("tick {tick} queued no packet"))?;
        if player.take_packet().is_some() {
            return Err(format!("tick {tick} queued more than one packet"));
        }
        push_record(&mut self.packets, &packet)?;
        let effects = player.take_effects().map_err(|error| format!("tick {tick}: {error}"))?;
        push_record(&mut self.effects, &effects)?;
        writeln!(self.hashes, "{tick} {}", player.tick_hash()).map_err(|error| error.to_string())
    }
}

fn run_board(text: &str) -> Result<Dump, String> {
    let mut player = Player::new(text).map_err(|error| error.to_string())?;
    let mut dump = Dump { packets: Vec::new(), effects: Vec::new(), hashes: String::new() };
    dump.record(&mut player)?;
    while player.tick() < player.end_tick() {
        player.step(1).map_err(|error| format!("tick {}: {error}", player.tick()))?;
        dump.record(&mut player)?;
    }
    Ok(dump)
}

fn write_dump(out: &Path, name: &str, dump: &Dump) -> io::Result<()> {
    fs::write(out.join(format!("{name}.packets")), &dump.packets)?;
    fs::write(out.join(format!("{name}.effects")), &dump.effects)?;
    fs::write(out.join(format!("{name}.hashes")), &dump.hashes)
}

fn main() -> ExitCode {
    let Some(out) = env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("dump_packets: give an output directory");
        return ExitCode::from(2);
    };
    let mut files = Vec::new();
    if let Err(error) = board_files(Path::new(BOARDS_DIR), BOARDS_DIR, &mut files) {
        eprintln!("dump_packets: can't walk {BOARDS_DIR} from this directory: {error}");
        return ExitCode::from(2);
    }
    files.sort();
    if files.is_empty() {
        eprintln!("dump_packets: the walk found no boards under {BOARDS_DIR}");
        return ExitCode::from(2);
    }
    if let Err(error) = fs::create_dir_all(&out) {
        eprintln!("dump_packets: can't create {}: {error}", out.display());
        return ExitCode::from(2);
    }

    let mut failed = false;
    for (path, on_disk) in &files {
        let dumped = fs::read_to_string(on_disk).map_err(|error| error.to_string()).and_then(|text| run_board(&text));
        match dumped {
            Ok(dump) => {
                let name = path.replace('/', "_");
                if let Err(error) = write_dump(&out, &name, &dump) {
                    eprintln!("dump_packets: can't write {name} under {}: {error}", out.display());
                    return ExitCode::from(2);
                }
                println!("DUMP {path}");
            }
            Err(error) => {
                eprintln!("dump_packets: {path} won't run: {error}");
                failed = true;
            }
        }
    }
    if failed { ExitCode::from(1) } else { ExitCode::SUCCESS }
}

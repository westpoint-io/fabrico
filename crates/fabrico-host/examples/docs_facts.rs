//! `docs_facts` - print the Rust half of the docs site's generated facts as JSON.
//!
//! Run it with:
//! ```text
//! cargo run -q --locked -p fabrico-host --example docs_facts
//! ```
//! Normally `npm run facts` in `site/` runs it, merges its output with the TypeScript half
//! (`frontend/scripts/export-docs-facts.ts`) and writes `site/src/generated/facts.json`.
//!
//! # Why this exists
//! The docs pages quote numbers and names that live in the code: limits, tick rates, fault
//! reasons, config fields, machine ports. A number typed into a page by hand goes stale the day
//! the code changes and nothing notices. This example reads each value from the real constant,
//! enum or table, so a renamed constant is a compile error here, and CI regenerates the JSON and
//! fails when the committed copy differs.
//!
//! # Output
//! One JSON object on stdout: `{ "facts": { "<id>": { ... } } }`. Every map is a `BTreeMap`, so
//! the bytes are the same on every run at one revision. Source paths are repo-relative and carry
//! no line numbers, so an unrelated edit to a source file doesn't change the output.
//!
//! On failure it prints one line to stderr and exits 1; it never panics.

use std::collections::BTreeMap;
use std::process::ExitCode;

use fabrico_host::sim_loop::TICK_PAUSE;
use serde_json::{Value, json};

const SIM_LOOP: &str = "crates/fabrico-host/src/sim_loop.rs";

/// The facts, by id.
type Facts = BTreeMap<String, Value>;

/// A number with its unit. `also` holds other spellings of the unit a page might type.
fn quantity(value: u64, unit: &str, also: &[&str], source: &str, symbol: &str) -> Value {
    json!({
        "kind": "quantity",
        "value": value,
        "unit": unit,
        "also": also,
        "source": source,
        "symbol": symbol,
    })
}

fn collect() -> Result<Facts, String> {
    let mut facts = Facts::new();
    let pause_ms = u64::try_from(TICK_PAUSE.as_millis())
        .map_err(|_| "TICK_PAUSE in milliseconds doesn't fit in 64 bits".to_string())?;
    facts.insert(
        "app.tick_pause_ms".to_string(),
        quantity(pause_ms, "ms", &["milliseconds"], SIM_LOOP, "TICK_PAUSE"),
    );
    Ok(facts)
}

fn main() -> ExitCode {
    match collect() {
        Ok(facts) => {
            let mut out = BTreeMap::new();
            out.insert("facts", Value::Object(facts.into_iter().collect()));
            match serde_json::to_string_pretty(&out) {
                Ok(text) => {
                    println!("{text}");
                    ExitCode::SUCCESS
                }
                Err(err) => {
                    eprintln!("docs_facts: could not write the facts as JSON: {err}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(message) => {
            eprintln!("docs_facts: {message}");
            ExitCode::FAILURE
        }
    }
}

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
//! # What breaks it on purpose
//! - A renamed or removed constant: the `use` lines stop compiling.
//! - A new `FaultReason`, `MachineConfig` or `SourceTrigger` variant: the `match`es below have no
//!   `_` arm, so they stop compiling until the variant is exported.
//! - A new field on a `MachineConfig` variant: the samples are struct literals and the `match`
//!   names every field with no `..`, so both stop compiling.
//! - A new machine kind with a port catalog arm: [`MACHINES`] must list it. The run walks every
//!   `u8` and exits 1 naming any kind that has a catalog arm and no row, instead of exporting
//!   fewer machines.
//!
//! # Output
//! One JSON object on stdout: `{ "facts": { "<id>": { ... } }, "machines": [ ... ] }`. Every map
//! is a `BTreeMap`, so the bytes are the same on every run at one revision. Source paths are
//! repo-relative and carry no line numbers, so an unrelated edit to a source file doesn't change
//! the output.
//!
//! On failure it prints one line to stderr and exits 1; it never panics.
//!
//! # Not exported
//! The Factory stack limit in the browser player (`DEFAULT_STACK_LIMIT` built for `wasm32`) is a
//! different constant from the desktop one, and a native build only sees the desktop value. It is
//! exported as `limit.factory_stack_desktop` only.

use std::collections::BTreeMap;
use std::process::ExitCode;

use fabrico_command::{
    LABEL_MAX_H, LABEL_MAX_W, ROUTER_OUT_ARITY, kind_has_catalog_arm, port_catalog,
};
use fabrico_core::admit::{FAULT_QUEUE_CAP, MECHANICAL_INBOX_CAP, SOURCE_PENDING_CAP};
use fabrico_core::belt_slots::{DEFAULT_TICKS_PER_SLOT, SLOTS_PER_TILE};
use fabrico_core::edit::{
    MAX_BELT_TILES, MAX_CONFIG_BYTES, MAX_ENDPOINT_PATH_BYTES, MAX_LABEL_BYTES,
    MAX_ROUTE_EXPECT_BYTES, MAX_ROUTES, MachineConfig, SourceTrigger,
};
use fabrico_core::factory::{
    DEFAULT_GAS_BUDGET, DEFAULT_MEM_LIMIT, DEFAULT_STACK_LIMIT, FACTORY_EMITS_PER_PORT,
};
use fabrico_core::fault::FaultReason;
use fabrico_core::state::{GRID_MAX, GRID_MIN, LabelColour, MAX_FOOTPRINT_DIM, SinkTemplate};
use fabrico_core::wire::{DEFAULT_WIRE_BUDGET, WIRE_INFLIGHT_CAP};
use fabrico_engine::envelope::DEFAULT_ENDPOINT_DEADLINE_TICKS;
use fabrico_host::ingress::endpoint::ENDPOINT_INGRESS_CAPACITY;
use fabrico_host::sim_loop::TICK_PAUSE;
use fabrico_protocol::machine_kind;
use serde_json::{Value, json};

const COMMAND: &str = "crates/fabrico-command/src/command.rs";
const ADMIT: &str = "crates/fabrico-core/src/admit.rs";
const BELT_SLOTS: &str = "crates/fabrico-core/src/belt_slots.rs";
const EDIT: &str = "crates/fabrico-core/src/edit.rs";
const FACTORY: &str = "crates/fabrico-core/src/factory.rs";
const FAULT: &str = "crates/fabrico-core/src/fault.rs";
const STATE: &str = "crates/fabrico-core/src/state.rs";
const WIRE: &str = "crates/fabrico-core/src/wire.rs";
const ENVELOPE: &str = "crates/fabrico-engine/src/envelope.rs";
const ENDPOINT_INGRESS: &str = "crates/fabrico-host/src/ingress/endpoint.rs";
const SIM_LOOP: &str = "crates/fabrico-host/src/sim_loop.rs";
const PROTOCOL: &str = "crates/fabrico-protocol/src/lib.rs";

/// Every machine kind, by the name pages use and its kind number. A kind with a port catalog arm
/// that isn't here makes the run exit 1, so a new kind can't be silently left out.
const MACHINES: [(&str, u8); 12] = [
    ("Source", machine_kind::SOURCE),
    ("Belt", machine_kind::BELT),
    ("Factory", machine_kind::FACTORY),
    ("Tee", machine_kind::TEE),
    ("Balancer", machine_kind::BALANCER),
    ("Router", machine_kind::ROUTER),
    ("Merge", machine_kind::MERGE),
    ("Sink", machine_kind::SINK),
    ("Wire", machine_kind::WIRE),
    ("Endpoint", machine_kind::ENDPOINT),
    ("Handler", machine_kind::HANDLER),
    ("Label", machine_kind::LABEL),
];

/// The facts, by id.
type Facts = BTreeMap<String, Value>;

/// A number with its unit. `also` holds other spellings a page might type: another unit spelling
/// that follows the number, or a whole phrase when it starts with a digit (such as `8 MiB`).
fn quantity(value: i64, unit: &str, also: &[&str], source: &str, symbol: &str) -> Value {
    json!({
        "kind": "quantity",
        "value": value,
        "unit": unit,
        "also": also,
        "source": source,
        "symbol": symbol,
    })
}

/// A name from the code: a fault reason, a config field, a kind number.
fn code(value: &str, source: &str, symbol: &str) -> Value {
    json!({ "kind": "code", "value": value, "source": source, "symbol": symbol })
}

fn put(facts: &mut Facts, id: impl Into<String>, fact: Value) -> Result<(), String> {
    let id = id.into();
    if facts.insert(id.clone(), fact).is_some() {
        return Err(format!("the fact id \"{id}\" is written twice"));
    }
    Ok(())
}

/// A constant as a signed 64-bit number, or an error naming it.
fn num<T: TryInto<i64>>(value: T, symbol: &str) -> Result<i64, String> {
    value
        .try_into()
        .map_err(|_| format!("{symbol} doesn't fit in a signed 64-bit number"))
}

/// A byte count as a whole number of `unit`s (1024 for KiB, 1024 * 1024 for MiB), or an error
/// naming the constant when it isn't one.
fn whole(bytes: i64, per: i64, unit: &str, symbol: &str) -> Result<i64, String> {
    if bytes % per != 0 {
        return Err(format!(
            "{symbol} is {bytes} bytes, which isn't a whole number of {unit}"
        ));
    }
    Ok(bytes / per)
}

const KIB: i64 = 1024;
const MIB: i64 = 1024 * 1024;

/// One limit: its id after `limit.`, value, unit, other spellings, source file and constant.
type LimitRow<'a> = (&'a str, i64, &'a str, &'a [&'a str], &'a str, &'a str);

/// The limits. Each unit is specific enough that a plain count in a tutorial (`2 ticks`,
/// `16 items`) doesn't read as the fact to the literal lint.
fn limits(facts: &mut Facts) -> Result<(), String> {
    let rows: Vec<LimitRow> = vec![
        (
            "max_belt_tiles",
            num(MAX_BELT_TILES, "MAX_BELT_TILES")?,
            "tiles",
            &["tiles a belt", "tiles per belt", "belt tiles"],
            EDIT,
            "MAX_BELT_TILES",
        ),
        (
            "max_config_bytes",
            whole(
                num(MAX_CONFIG_BYTES, "MAX_CONFIG_BYTES")?,
                MIB,
                "MiB",
                "MAX_CONFIG_BYTES",
            )?,
            "MiB",
            &["MiB a config", "MiB per config"],
            EDIT,
            "MAX_CONFIG_BYTES",
        ),
        (
            "max_routes",
            num(MAX_ROUTES, "MAX_ROUTES")?,
            "routes",
            &["routes a Router", "routes per Router"],
            EDIT,
            "MAX_ROUTES",
        ),
        (
            "max_route_expect_bytes",
            num(MAX_ROUTE_EXPECT_BYTES, "MAX_ROUTE_EXPECT_BYTES")?,
            "bytes a route match",
            &["bytes per route match"],
            EDIT,
            "MAX_ROUTE_EXPECT_BYTES",
        ),
        (
            "max_endpoint_path_bytes",
            num(MAX_ENDPOINT_PATH_BYTES, "MAX_ENDPOINT_PATH_BYTES")?,
            "bytes a path",
            &["bytes per path"],
            EDIT,
            "MAX_ENDPOINT_PATH_BYTES",
        ),
        (
            "max_label_bytes",
            num(MAX_LABEL_BYTES, "MAX_LABEL_BYTES")?,
            "bytes a label",
            &["bytes per label"],
            EDIT,
            "MAX_LABEL_BYTES",
        ),
        (
            "mechanical_inbox_cap",
            num(MECHANICAL_INBOX_CAP, "MECHANICAL_INBOX_CAP")?,
            "items an inbox",
            &["items per inbox"],
            ADMIT,
            "MECHANICAL_INBOX_CAP",
        ),
        (
            "source_pending_cap",
            num(SOURCE_PENDING_CAP, "SOURCE_PENDING_CAP")?,
            "pending items a Source",
            &["pending items per Source"],
            ADMIT,
            "SOURCE_PENDING_CAP",
        ),
        (
            "fault_queue_cap",
            num(FAULT_QUEUE_CAP, "FAULT_QUEUE_CAP")?,
            "faults a machine",
            &["faults per machine"],
            ADMIT,
            "FAULT_QUEUE_CAP",
        ),
        (
            "factory_gas_budget",
            num(DEFAULT_GAS_BUDGET, "DEFAULT_GAS_BUDGET")?,
            "gas units a tick",
            &["gas units per tick"],
            FACTORY,
            "DEFAULT_GAS_BUDGET",
        ),
        (
            "factory_memory",
            whole(
                num(DEFAULT_MEM_LIMIT, "DEFAULT_MEM_LIMIT")?,
                MIB,
                "MiB",
                "DEFAULT_MEM_LIMIT",
            )?,
            "MiB",
            &["MiB of memory"],
            FACTORY,
            "DEFAULT_MEM_LIMIT",
        ),
        (
            "factory_stack_desktop",
            whole(
                num(DEFAULT_STACK_LIMIT, "DEFAULT_STACK_LIMIT")?,
                KIB,
                "KiB",
                "DEFAULT_STACK_LIMIT",
            )?,
            "KiB",
            &["KiB of stack"],
            FACTORY,
            "DEFAULT_STACK_LIMIT",
        ),
        (
            "factory_emits_per_port",
            num(FACTORY_EMITS_PER_PORT, "FACTORY_EMITS_PER_PORT")?,
            "emits a port",
            &["emits per port"],
            FACTORY,
            "FACTORY_EMITS_PER_PORT",
        ),
        (
            "wire_inflight_cap",
            num(WIRE_INFLIGHT_CAP, "WIRE_INFLIGHT_CAP")?,
            "requests in flight",
            &["wire requests in flight"],
            WIRE,
            "WIRE_INFLIGHT_CAP",
        ),
        (
            "wire_budget",
            num(DEFAULT_WIRE_BUDGET, "DEFAULT_WIRE_BUDGET")?,
            "forwards",
            &["wire forwards"],
            WIRE,
            "DEFAULT_WIRE_BUDGET",
        ),
        (
            "slots_per_tile",
            num(SLOTS_PER_TILE, "SLOTS_PER_TILE")?,
            "slots a tile",
            &["slots per tile"],
            BELT_SLOTS,
            "SLOTS_PER_TILE",
        ),
        (
            "default_ticks_per_slot",
            num(DEFAULT_TICKS_PER_SLOT.get(), "DEFAULT_TICKS_PER_SLOT")?,
            "ticks a slot",
            &["ticks per slot"],
            BELT_SLOTS,
            "DEFAULT_TICKS_PER_SLOT",
        ),
        (
            "grid_min",
            num(GRID_MIN, "GRID_MIN")?,
            "on each axis",
            &[],
            STATE,
            "GRID_MIN",
        ),
        (
            "grid_max",
            num(GRID_MAX, "GRID_MAX")?,
            "on each axis",
            &[],
            STATE,
            "GRID_MAX",
        ),
        (
            "max_footprint_dim",
            num(MAX_FOOTPRINT_DIM, "MAX_FOOTPRINT_DIM")?,
            "cells a side",
            &["cells per side"],
            STATE,
            "MAX_FOOTPRINT_DIM",
        ),
        (
            "router_out_arity",
            num(ROUTER_OUT_ARITY, "ROUTER_OUT_ARITY")?,
            "outputs a Router",
            &["Router outputs"],
            COMMAND,
            "ROUTER_OUT_ARITY",
        ),
        (
            "label_max_w",
            num(LABEL_MAX_W, "LABEL_MAX_W")?,
            "cells wide",
            &[],
            COMMAND,
            "LABEL_MAX_W",
        ),
        (
            "label_max_h",
            num(LABEL_MAX_H, "LABEL_MAX_H")?,
            "cells deep",
            &["cells tall"],
            COMMAND,
            "LABEL_MAX_H",
        ),
        (
            "endpoint_deadline_ticks",
            num(
                DEFAULT_ENDPOINT_DEADLINE_TICKS,
                "DEFAULT_ENDPOINT_DEADLINE_TICKS",
            )?,
            "ticks to reply",
            &["ticks for a reply"],
            ENVELOPE,
            "DEFAULT_ENDPOINT_DEADLINE_TICKS",
        ),
        (
            "endpoint_ingress_capacity",
            num(ENDPOINT_INGRESS_CAPACITY, "ENDPOINT_INGRESS_CAPACITY")?,
            "waiting requests",
            &["queued requests"],
            ENDPOINT_INGRESS,
            "ENDPOINT_INGRESS_CAPACITY",
        ),
    ];
    for (name, value, unit, also, source, symbol) in rows {
        put(
            facts,
            format!("limit.{name}"),
            quantity(value, unit, also, source, symbol),
        )?;
    }
    Ok(())
}

/// The fault reason's name as pages and the inspector write it. No `_` arm: a new variant is a
/// compile error here.
fn fault_name(reason: &FaultReason) -> &'static str {
    match reason {
        FaultReason::NoMatch => "NoMatch",
        FaultReason::FactoryError => "FactoryError",
        FaultReason::FactoryTimeout => "FactoryTimeout",
        FaultReason::CommandTimeout => "CommandTimeout",
        FaultReason::CommandFailure => "CommandFailure",
        FaultReason::WireOverflow => "WireOverflow",
        FaultReason::OutputRefused => "OutputRefused",
        FaultReason::NoEntryWire => "NoEntryWire",
        FaultReason::BranchBusy { branch: _ } => "BranchBusy",
    }
}

/// One of each fault reason. A new variant fails [`fault_name`]'s compile; add it here too.
fn fault_samples() -> Vec<FaultReason> {
    vec![
        FaultReason::NoMatch,
        FaultReason::FactoryError,
        FaultReason::FactoryTimeout,
        FaultReason::CommandTimeout,
        FaultReason::CommandFailure,
        FaultReason::WireOverflow,
        FaultReason::OutputRefused,
        FaultReason::NoEntryWire,
        FaultReason::BranchBusy {
            branch: Default::default(),
        },
    ]
}

/// A config variant's name and its field names. Every field is named with no `..`, so a new field
/// is a compile error here, and there is no `_` arm, so a new variant is too.
fn config_fields(config: &MachineConfig) -> (&'static str, Vec<&'static str>) {
    match config {
        MachineConfig::Factory { source: _ } => ("Factory", vec!["source"]),
        MachineConfig::Source { trigger: _ } => ("Source", vec!["trigger"]),
        MachineConfig::Sink { target: _ } => ("Sink", vec!["target"]),
        MachineConfig::Belt { ticks_per_slot: _ } => ("Belt", vec!["ticks_per_slot"]),
        MachineConfig::Router {
            routes: _,
            default: _,
        } => ("Router", vec!["routes", "default"]),
        MachineConfig::Endpoint { path: _ } => ("Endpoint", vec!["path"]),
        MachineConfig::Label {
            text: _,
            colour: _,
            w: _,
            h: _,
        } => ("Label", vec!["text", "colour", "w", "h"]),
    }
}

/// One of each config variant, built as struct literals so a new field is a compile error.
fn config_samples() -> Vec<MachineConfig> {
    vec![
        MachineConfig::Factory {
            source: String::new(),
        },
        MachineConfig::Source {
            trigger: SourceTrigger::Webhook,
        },
        MachineConfig::Sink {
            target: SinkTemplate::Debug,
        },
        MachineConfig::Belt {
            ticks_per_slot: DEFAULT_TICKS_PER_SLOT,
        },
        MachineConfig::Router {
            routes: Vec::new(),
            default: None,
        },
        MachineConfig::Endpoint {
            path: String::new(),
        },
        MachineConfig::Label {
            text: String::new(),
            colour: LabelColour::Sand,
            w: 1,
            h: 1,
        },
    ]
}

/// A Source trigger's name and its field names, with the same compile-time guards.
fn trigger_fields(trigger: &SourceTrigger) -> (&'static str, Vec<&'static str>) {
    match trigger {
        SourceTrigger::Webhook => ("Webhook", vec![]),
        SourceTrigger::Timer { interval_ticks: _ } => ("Timer", vec!["interval_ticks"]),
    }
}

fn trigger_samples() -> Vec<SourceTrigger> {
    vec![
        SourceTrigger::Webhook,
        SourceTrigger::Timer { interval_ticks: 1 },
    ]
}

/// Which config variant a machine kind carries, by name, or none. The names must be ones
/// [`config_fields`] returns; the run checks that. A Handler is placed as a Factory node, so it
/// carries the Factory config.
fn config_of(name: &str) -> Option<&'static str> {
    match name {
        "Source" => Some("Source"),
        "Belt" => Some("Belt"),
        "Factory" | "Handler" => Some("Factory"),
        "Router" => Some("Router"),
        "Sink" => Some("Sink"),
        "Endpoint" => Some("Endpoint"),
        "Label" => Some("Label"),
        _ => None,
    }
}

fn collect() -> Result<(Facts, Vec<Value>), String> {
    let mut facts = Facts::new();

    let pause_ms = u64::try_from(TICK_PAUSE.as_millis())
        .map_err(|_| "TICK_PAUSE in milliseconds doesn't fit in 64 bits".to_string())?;
    put(
        &mut facts,
        "app.tick_pause_ms",
        quantity(
            num(pause_ms, "TICK_PAUSE")?,
            "ms",
            &["milliseconds"],
            SIM_LOOP,
            "TICK_PAUSE",
        ),
    )?;

    limits(&mut facts)?;

    let faults = fault_samples();
    for reason in &faults {
        let name = fault_name(reason);
        put(
            &mut facts,
            format!("fault.{name}"),
            code(name, FAULT, "FaultReason"),
        )?;
    }

    let mut configs: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for sample in &config_samples() {
        let (variant, fields) = config_fields(sample);
        put(
            &mut facts,
            format!("config.{variant}"),
            code(variant, EDIT, "MachineConfig"),
        )?;
        for field in &fields {
            put(
                &mut facts,
                format!("config.{variant}.{field}"),
                code(field, EDIT, "MachineConfig"),
            )?;
        }
        if configs.insert(variant, fields).is_some() {
            return Err(format!(
                "config_samples lists MachineConfig::{variant} twice"
            ));
        }
    }
    for sample in &trigger_samples() {
        let (variant, fields) = trigger_fields(sample);
        put(
            &mut facts,
            format!("trigger.{variant}"),
            code(variant, EDIT, "SourceTrigger"),
        )?;
        for field in &fields {
            put(
                &mut facts,
                format!("trigger.{variant}.{field}"),
                code(field, EDIT, "SourceTrigger"),
            )?;
        }
    }

    // Every kind with a catalog arm must have a row, so a new kind can't drop out silently.
    for k in 0..=u8::MAX {
        if kind_has_catalog_arm(k) && !MACHINES.iter().any(|&(_, kind)| kind == k) {
            return Err(format!(
                "machine kind {k} has a port catalog arm and no row in MACHINES; add it to examples/docs_facts.rs"
            ));
        }
    }

    let mut machines = Vec::new();
    for &(name, kind) in &MACHINES {
        put(
            &mut facts,
            format!("machine.{name}.kind"),
            code(&kind.to_string(), PROTOCOL, "machine_kind"),
        )?;
        let (footprint, ports) = if kind_has_catalog_arm(kind) {
            let (footprint, ports) = port_catalog(kind);
            let ports = serde_json::to_value(&ports)
                .map_err(|err| format!("the ports of {name} didn't serialize: {err}"))?;
            (json!({ "w": footprint.w, "h": footprint.h }), ports)
        } else {
            (Value::Null, json!([]))
        };
        let config = config_of(name);
        let fields = match config {
            Some(variant) => configs
                .get(variant)
                .ok_or_else(|| {
                    format!("{name} names config {variant}, which config_samples doesn't list")
                })?
                .clone(),
            None => Vec::new(),
        };
        machines.push(json!({
            "kind": kind,
            "name": name,
            "catalog": kind_has_catalog_arm(kind),
            "footprint": footprint,
            "ports": ports,
            "config": config,
            "configFields": fields,
        }));
    }

    Ok((facts, machines))
}

fn main() -> ExitCode {
    match collect() {
        Ok((facts, machines)) => {
            let mut out = BTreeMap::new();
            out.insert("facts", Value::Object(facts.into_iter().collect()));
            out.insert("machines", Value::Array(machines));
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

//! `fabrico-command` — the headless semantic COMMAND LAYER (CMD-01).
//!
//! This crate is the public command surface a Rust program (and, in later phases,
//! the live UI and the Playwright/Rust test harness) uses to build a grid: place
//! machines, wire belts, delete elements — entirely by issuing `GridCommand`s.
//! There is **no renderer here, no host, and nothing about the mouse, pixels, or
//! screen-space**. The UI and the test harness are PEER PRODUCERS of the same
//! `GridCommand` schema ("one schema, two producers", CMD-01/CMD-04).
//!
//! # Validate → produce → fold (never optimistic-write — CMD-02/CMD-05)
//! `validate_normalize` is a PURE function over a read-only `GridLookup` view:
//! it checks bounds + occupancy (Place), handle-resolution + port-compatibility
//! (Wire/Delete) and, on accept, produces the RESOLVED, normalized `EditRecord`
//! (decision Q2) — it NEVER mutates topology and NEVER folds. On reject it returns
//! a typed [`CommandError`] having produced NOTHING, so the grid stays byte-
//! identical (SC#2). `GridSession` ties the pieces together: it validates against
//! its `GridView`, appends the resolved record to its edit-log, and folds it via
//! `Core::advance_edits` — the ONE mutator (CMD-05). The grid therefore changes
//! ONLY through the logged record; nothing here writes `core.state` speculatively.
//!
//! # Replay applies frozen records (ELOG-02)
//! The RESOLVED records the session logs replay to a byte-identical `Core` with NO
//! re-validation and NO re-normalization — `validate_normalize` is never called
//! from the fold. The edit-log is the deterministic source of truth for topology.

#![forbid(unsafe_code)]

pub mod error;
pub mod grid_view;
pub mod command;
pub mod route;
pub mod wire_route;

pub use command::{
    GridSession, LABEL_MAX_H, LABEL_MAX_W, ROUTER_OUT_ARITY, catalog_entry, kind_has_catalog_arm,
    port_catalog, validate_normalize,
};
pub use error::CommandError;
pub use grid_view::{GridLookup, GridView, GridViewLookup, is_handler_shape, is_route_shape};
pub use route::{RouteError, route};
pub use wire_route::{
    AroundWindow, CAND_AROUND_CROWDED, CAND_AROUND_MACHINES, CAND_CLEAR_OF_BODIES, CAND_FACE_ALIGNED, CAND_GO_AROUND,
    CAND_MANHATTAN, CAND_NONE, CAND_PERIMETER, MAX_AROUND_NODES, MAX_CROWDED_CELLS, WIRE_LINE_GUARD, SearchEnd, WireAnchor,
    WireBody, WireDock, WireGeometry, WireRouteError, around_machines_lines,
    around_machines_window, clear_of_bodies_search, go_around_search, is_wire_obstacle,
    search_between_ends, wire_route, wire_route_avoiding, wire_route_avoiding_traced,
    wire_route_traced,
};

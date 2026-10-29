//! The edit-log record — the unit the SEPARATE topology edit-log stores.
//!
//! Fabrico runs two ordered logs (Phase 8). The runtime [event log](crate::event)
//! is the source of truth for non-pure inputs (clock, randomness, external
//! results, item flow); this **edit-log** is the SEPARATE, equally-deterministic
//! source of truth for *topology edits* (place / wire / delete). Keeping them
//! distinct lets the per-tick merge apply edits-first ("build, then run") and lets
//! Phase-12 undo append a compensating record without touching the runtime log.
//!
//! Each [`EditRecord`] carries a logical [`PartitionKey`] (CORE-08, ignored in
//! single-partition mode but reserved for the forward-compatible sharded design),
//! a monotonic `sequence` (the ROUTE-06-style deterministic tie-break id), the
//! `tick` it applies at (the two-log MERGE KEY), an `action` coalescing-group id
//! (UNDO-02 — "one logical action = one undo step"; reserved for Phase-12
//! inverse-append, NOT consumed here), and a
//! [`schema_version`](EditRecord::schema_version) (CORE-10) keyed for
//! upcast-on-read.
//!
//! The stored `op` is the RESOLVED / normalized operation (decision Q2): replay
//! applies frozen records with NO re-validation and NO re-normalization. A
//! normalizer/router change bumps [`EDIT_SCHEMA_VERSION`] rather than silently
//! re-typing old logs — preserving cross-version replay determinism.
//!
//! # Trust boundary (mirror [`crate::event`])
//! Bytes decoded from disk / a future save file / a second log are untrusted.
//! [`check_version`] is the ONE version predicate at that boundary: it **refuses any
//! record whose `schema_version` is not EXACTLY the running
//! [`EDIT_SCHEMA_VERSION`], forward OR backward** with a typed
//! [`DecodeError::UnknownVersion`](crate::event::DecodeError::UnknownVersion)
//! (never a panic). [`upcast`] calls it and then decodes behind a `Result`, so
//! malformed bytes yield
//! [`DecodeError::Malformed`](crate::event::DecodeError::Malformed) rather than an
//! `unwrap` panic.
//!
//! [`upcast`] is NOT the only site that decides this. The two boundaries a real
//! caller reaches are `fabrico_host::driver::Host::logged_edits` (the redb edit-log
//! store) and `fabrico_host::project::load_project` (a `.fab` file on disk); both
//! call [`check_version`] too. Until Phase 63 each of the three carried its own copy
//! of the comparison, and only the two host copies were ever reached.
//!
//! All types are plain ordered serde data (CORE-09): no floats, no HashMaps, no
//! pointers. The crate-scoped clippy determinism gate enforces it.

use std::num::NonZeroU32;

use crate::event::DecodeError;
use crate::ids::{NodeId, PartitionKey, PortId};
use crate::state::{
    BeltTile, GRID_MAX, GRID_MIN, LabelColour, MAX_FOOTPRINT_DIM, Port, RouteKey, SinkTemplate,
};

/// The cap on a [`EditOp::DrawBelt`] tile count at the untrusted-decode boundary
/// (Phase 11, RESEARCH Pitfall 3) — the belt analog of
/// [`MAX_FOOTPRINT_DIM`](crate::state::MAX_FOOTPRINT_DIM). A forged `DrawBelt`
/// carrying millions of tiles would be applied VERBATIM by `fold_draw_belt` on
/// replay (decision Q2 — no fold-time re-validation), minting
/// `SLOTS_PER_TILE * tiles` slots + claiming every tile cell with no cap — an
/// allocation bomb. `upcast` refuses any tile list longer than this as
/// [`DecodeError::Malformed`], and the snapshot trust gate mirrors it with
/// [`StateInvariant::BeltTilesTooMany`](crate::event::StateInvariant::BeltTilesTooMany).
///
/// # Overflow safety
/// `1024` is far below `u32::MAX`, so `MAX_BELT_TILES * SLOTS_PER_TILE` (the slot
/// count, `1024 * 4 = 4096` at the value locked by `60-CONTEXT.md` on 2026-08-09,
/// up from `3072`) stays well inside `usize` on every supported platform. The
/// headroom argument shrinks by a third and still holds by an enormous margin; the
/// cap itself does not move, and `slot_count` uses `saturating_mul` so the
/// arithmetic is total regardless. Each tile
/// `cell` is independently bounded to `[GRID_MIN, GRID_MAX]` at decode — so no
/// `tiles`-derived arithmetic can overflow. A real drawn belt is a hand-dragged
/// path; 1024 tiles is a generous ceiling far beyond any plausible factory belt.
///
/// Phase 62 (SLOT-03, `62-CONTEXT.md` D-01) gives every belt its own advance
/// interval, and the answer to the obvious question is NO: this cap does not move
/// and neither does the headroom argument above. `Belt.ticks_per_slot` is ONE field
/// per BELT, not one per slot or per tile, so it adds a single varint to a stored
/// belt and enters no `tiles`-derived arithmetic at all. The allocation bomb this
/// cap defends against is still exactly `SLOTS_PER_TILE * tiles`. Recorded here
/// because a reader who has just seen a new belt field arrive is entitled to be
/// suspicious of a bound stated in terms of the belt model.
pub const MAX_BELT_TILES: u32 = 1024;

/// The cap on an [`EditOp::Configure`] Factory JS `String` byte-length at the
/// untrusted-decode boundary (Phase 35, RESEARCH §Q5). The Factory JS source is the
/// ONLY new unbounded-allocation surface the v6.0 `Configure` op adds: a forged
/// edit-log record could encode a multi-GiB `MachineConfig::Factory { source }` that
/// [`upcast`] would otherwise allocate wholesale before any fold — an allocation bomb
/// (threat T-35-04-CONFIGBOMB). [`upcast`] refuses any `Configure` whose Factory
/// `source` exceeds this length as [`DecodeError::Malformed`], pre-fold, no allocation
/// past the bound — the belt/footprint-cap analog ([`MAX_BELT_TILES`]) for the config
/// surface. `4 MiB` is a generous ceiling for authored machine JS (real handlers are
/// KiB-scale) far below any plausible legitimate source, and bounded well inside
/// `usize` on every supported platform.
pub const MAX_CONFIG_BYTES: usize = 4 * 1024 * 1024;

/// The cap on a [`MachineConfig::Router`] route-table LENGTH at the untrusted-decode
/// boundary (Phase 63, threat T-63-01) — the routing-table analog of
/// [`MAX_BELT_TILES`] and [`MAX_CONFIG_BYTES`]. `routes: Vec<(RouteKey, PortId)>` is
/// the SECOND unbounded-allocation surface in the serialized model after the Factory
/// JS source, and `fold_configure` writes it VERBATIM — no sort, no dedup, no
/// re-validation (decision Q2) — so a forged `Configure` carrying millions of routes
/// becomes a live [`Router`](crate::state::Router) that the per-item first-match walk
/// then traverses on every item. [`upcast`] refuses an over-cap table as
/// [`DecodeError::Malformed`], and `fabrico_host`'s `load_project` refuses the same
/// table with its own typed error, reading THIS constant rather than redeclaring it.
///
/// # The bomb, sized, and why 1024
/// Each route is a `RouteKey { offset: u16, expect: Vec<u8> }` plus a `PortId`, and the
/// pattern is independently bounded by [`MAX_ROUTE_EXPECT_BYTES`], so the worst case
/// this pair admits is `MAX_ROUTES * MAX_ROUTE_EXPECT_BYTES` = `1024 * 1024` = **1 MiB**
/// of pattern bytes — a QUARTER of the existing [`MAX_CONFIG_BYTES`] Factory-source
/// ceiling, and bounded far inside `usize` on every supported platform. The headroom
/// argument in the other direction: a routing table is authored by hand, one rule per
/// message class, so a real one is single digits and a big one is dozens. `1024` is two
/// orders of magnitude above any legitimate table while keeping the per-item walk
/// bounded work.
pub const MAX_ROUTES: usize = 1024;

/// The cap on a single [`RouteKey::expect`](crate::state::RouteKey::expect) pattern's
/// byte length at the untrusted-decode boundary (Phase 63, threat T-63-01) — the second
/// dimension of the [`MAX_ROUTES`] bomb, bounded independently because ONE route
/// carrying a multi-gigabyte pattern is the same denial of service as a million tiny
/// ones. `routes` is a Vec of Vecs; capping only the outer length would leave the inner
/// one unbounded.
///
/// # Why 1024 bytes
/// `expect` is compared against a byte slice of the inbound item at a `u16` offset, so a
/// pattern longer than the items in flight can never match — it is dead weight by
/// construction. Real patterns are a message type, a header value or a short prefix:
/// tens of bytes. `1024` is a generous ceiling above every legitimate use and, paired
/// with [`MAX_ROUTES`], caps the whole table at 1 MiB.
pub const MAX_ROUTE_EXPECT_BYTES: usize = 1024;

/// The cap on a [`MachineConfig::Endpoint`] `path` byte-length (Phase 72, SERVE-08,
/// threat T-72-07-01) — the FOURTH Configure-payload bound, beside [`MAX_BELT_TILES`],
/// [`MAX_CONFIG_BYTES`], [`MAX_ROUTES`] and [`MAX_ROUTE_EXPECT_BYTES`].
///
/// A `String` on a serialized node is a NEW attacker-controlled LENGTH. Before this
/// constant existed the only unbounded surfaces in the model were the Factory JS source
/// and the router table; [`crate::state::Endpoint::path`] joins them, and a forged
/// `.fab` carrying a multi-gigabyte path would allocate without limit on LOAD, before
/// any fold ran.
///
/// # Why 1024, and why it is TAKEN rather than derived
/// It is [`MAX_ROUTE_EXPECT_BYTES`]'s number, and that is the argument: 1024 is this
/// project's SHIPPED magnitude for a user-typed string riding a `Configure`, so a fifth
/// independently-reasoned ceiling would be a fifth number to defend. A real URL path is
/// tens of bytes; browsers and proxies stop well below a kilobyte. 1024 is two orders of
/// magnitude above any legitimate path while keeping every walk over it bounded work.
///
/// # ONE number, TWO gates, and that is load-bearing rather than tidy
/// `fabrico-command`'s `Configure` validate arm and
/// [`crate::snapshot::restore`]'s trust gate both read THIS constant, never a literal of
/// their own. Phase 71's ruling (`snapshot.rs:443-453`) is why: the restore bound must
/// ACCEPT WHAT THE LIVE PATH CAN PRODUCE, so a restore bound one byte tighter than the
/// write bound turns a board the command layer accepted into a save the user cannot
/// open. Two literals is the drift `68-UI-SPEC` FINDING 1 is the worked example of.
pub const MAX_ENDPOINT_PATH_BYTES: usize = 1024;

/// The cap on a [`MachineConfig::Label`] `text` byte-length (Phase 76, plan 76-02,
/// SHAPE-13, D-06) - the FIFTH Configure-payload bound, beside [`MAX_BELT_TILES`],
/// [`MAX_CONFIG_BYTES`], [`MAX_ROUTES`] / [`MAX_ROUTE_EXPECT_BYTES`] and
/// [`MAX_ENDPOINT_PATH_BYTES`].
///
/// A label's words are a `String` on a serialized node, so they are a NEW
/// attacker-controlled LENGTH: a forged `.fab` carrying a multi-gigabyte text would
/// allocate without limit on load before any fold ran, and the words are also drawn on
/// the board every frame.
///
/// # Why 512, in BYTES
/// The full text has to fit the largest label a user can size. The label panel caps a
/// label at 16 cells wide by 8 deep (`fabrico_command::LABEL_MAX_W` / `LABEL_MAX_H`); at
/// the board's 12 px words on 16 px lines a label `w` cells wide holds about `4w - 2`
/// characters per line and `2h - 1` lines, so 16 by 8 holds 62 by 15, about 930
/// characters of plain ASCII. 512 bytes is the power of two under that, so a label sized
/// to the cap shows every byte it can hold and no text the write gate accepts is ever
/// cut by the box it is drawn in. It is a BYTE bound because the edit log stores bytes:
/// a text of two-byte characters reaches it at 256 characters.
///
/// # ONE number, every gate
/// `fabrico-command`'s `Configure` validate arm reads THIS constant (refusing 513 bytes
/// and accepting exactly 512), and so does the one TypeScript mirror
/// (`frontend/src/chrome/LabelConfigBody.tsx`, locked by
/// `crates/fabrico-command/tests/ts_label_mirror.rs`). The decode, restore and load gates
/// read it too (plan 76-04), never a literal of their own, for the reason
/// [`MAX_ENDPOINT_PATH_BYTES`] states: the restore bound must ACCEPT WHAT THE LIVE PATH
/// CAN PRODUCE.
pub const MAX_LABEL_BYTES: usize = 512;

/// The bytes a Route path may contain, beyond the structural rules: ASCII letters,
/// digits, and `- . _ ~ /` (R-18's unreserved URL-path set, plus the separator).
///
/// Spelled as a predicate over one byte rather than as a table so the rule reads the way
/// it is stated. `std` only: no regex crate and no URL parser, because
/// the declared-moves gate asserts `Cargo.lock` byte-identity and a dependency
/// change in this milestone is a reviewed gate amendment rather than a task.
const fn is_unreserved_path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/')
}

/// Is `path` a legal Route address? The ONE place R-47's rules 1 to 3 are written.
///
/// 1. it starts with EXACTLY ONE `/`, and is non-empty after it;
/// 2. it is at most [`MAX_ENDPOINT_PATH_BYTES`] bytes;
/// 3. every byte is unreserved (see [`is_unreserved_path_byte`]).
///
/// # RULE 1 SAYS *EXACTLY ONE*, AND THAT WORD IS A FIX, NOT A FLOURISH (CR-01)
/// `/` is an unreserved path byte, so `//orders` used to satisfy every rule here.
/// R-47's fourth rule compares RAW strings (`grid_view::endpoint_path_owner`), so
/// `//orders` was not a duplicate of `/orders` either, and both were committable. But
/// the host publishes each Route's key through
/// `fabrico_host::sim_loop::endpoint_route_key`, which is
/// `format!("/{}", path.trim_start_matches('/'))`, and `trim_start_matches` strips ALL
/// leading slashes rather than one. Both paths keyed as `/orders`, `project_routes`
/// collected them into one `BTreeMap`, and the higher `NodeId` silently won. The
/// shadowed Route's own config card showed a POST URL that ran the OTHER Route's
/// Handler: no 404, no fault, no refusal, no log line.
///
/// Refusing byte 1 closes it AT THE AUTHORITY, and it closes it by making the two
/// functions agree BY CONSTRUCTION: `endpoint_route_key` is now the IDENTITY on every
/// path this gate admits, so no two accepted paths can share a key and the trim is
/// defensive-only against a forged `.fab`. That agreement is asserted in `fabrico-host`
/// (`sim_loop`'s `every_path_the_write_gate_accepts_keys_as_itself_and_owns_its_own_route`),
/// which is the one crate that can see both functions.
///
/// INTERIOR slashes stay legal, and that is walk item J-5's ruling rather than an
/// oversight: multi-segment addresses like `/orders/new/id` must work. Only the LEADING
/// slashes are normalized away, so leading is the WHOLE collision surface: `/a//b` keys
/// as `/a//b` and collides with nothing. A rule spelled `!path.contains("//")` would
/// have closed CR-01 and broken J-5 in the same line.
///
/// R-47's FOURTH rule — that the path is not already another Route's committed path — is
/// deliberately NOT here. It is the only rule that needs the whole board to answer, and
/// it is the only one with its own typed refusal (`DuplicatePath`) because it is the
/// only one that can name a specific other object. Rules 1 to 3 resolve to `Malformed`,
/// whose sentence names no cause by design.
///
/// # One predicate, three callers, on purpose
/// The `Configure` validate arm (`fabrico-command`), the frontend's own gate (plan
/// 72-10, which mirrors the bound across the language boundary) and any future core
/// caller all ask THE SAME QUESTION OF THE SAME STRING. The frontend gate is a courtesy
/// and this is the authority: the wire is reachable without the panel, so the core
/// refuses independently and a test drives a bad path through the command seam with no
/// frontend in the loop.
///
/// # Percent-encoding is NOT decoded here, and that is the point
/// A `%2e%2e` sequence is simply not in the unreserved set, so it is REFUSED rather than
/// decoded and then judged. Refusing an alphabet is a total rule a reader can check;
/// decoding first and judging after is where traversal bugs live.
#[must_use]
pub fn endpoint_path_is_valid(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2
        && bytes.len() <= MAX_ENDPOINT_PATH_BYTES
        && bytes[0] == b'/'
        // EXACTLY ONE leading slash (CR-01). Indexing byte 1 is in bounds because the
        // length rule above short-circuits first. Spelled on byte 1 alone, never as a
        // `contains("//")`, so J-5's multi-segment paths stay legal.
        && bytes[1] != b'/'
        && bytes.iter().copied().all(is_unreserved_path_byte)
}

/// The key a Route answers at: exactly one leading `/`, then the rest of `path` verbatim.
///
/// THE ONE NORMALIZER (phase 91 review WR-A-04). The host's route map keys every Route by
/// this (`fabrico_host::sim_loop::endpoint_route_key` is this function), and the two
/// questions that must agree with the map ask it too: the default-path mint
/// (`GridState::add_endpoint`, so a minted `/route-N` never shares a key with a Route
/// already on the board) and both producers' duplicate-path reads
/// (`GridLookup::endpoint_path_owner`, so a typed path is refused against any Route that
/// answers at the same key). Before WR-A-04 those two compared raw strings while the map
/// compared keys, so a hand-edited `.fab` holding the slashless `route-1` (which
/// `fold_configure` applies as written, and which keys as `/route-1`) got a second Route
/// minted or typed onto `/route-1`, and the map kept one of the two with no word.
///
/// Leading slashes only, `trim_start_matches` not `strip_prefix`, for the reason
/// [`endpoint_path_is_valid`] gives: leading is the whole collision surface, and interior
/// slashes are legal (J-5). A path this gate accepts keys as itself.
#[must_use]
pub fn endpoint_route_key(path: &str) -> String {
    format!("/{}", route_key_rest(path))
}

/// True when `a` and `b` answer at the same Route key ([`endpoint_route_key`]), compared
/// without allocating, through the same normalization.
#[must_use]
pub fn same_route_key(a: &str, b: &str) -> bool {
    route_key_rest(a) == route_key_rest(b)
}

/// The normalization itself: `path` with every leading `/` removed, which a Route key
/// follows with exactly one. The one place the rule is spelled.
fn route_key_rest(path: &str) -> &str {
    path.trim_start_matches('/')
}

/// The schema version the running code writes and can decode for the edit-log.
/// [`upcast`] refuses records stamped with a version greater than this
/// (forward-version refusal). A normalizer/router change bumps this constant
/// (decision Q2) rather than silently re-typing old logs.
///
/// # v2 (Phase 10, 10-02): the multi-cell-footprint generalization
/// Bumped `1 → 2` because [`EditOp::Place`] gained the resolved footprint fields
/// `w`, `h`, `ports` (appended AFTER `cell_y` — a breaking positional postcard
/// change to the variant payload, even though `Place` keeps discriminant 0). This
/// is the isolated, separately-reviewed schema bump that lands ALONGSIDE the
/// [`SNAPSHOT_SCHEMA_VERSION`](crate::snapshot::SNAPSHOT_SCHEMA_VERSION) `4 → 5`
/// bump and the full corpus regen — the change "only generalizes": an all-1×1
/// edit-log gains only the defaulted `w=1, h=1, ports=[]` trailer per `Place`, the
/// fold behaviour is unchanged. Pre-v1 CLEAN BREAK: [`upcast`] refuses a forward
/// (`> 2`) record with [`DecodeError::UnknownVersion`], and a stale v1 `Place`
/// record fails positional decode under v2 as [`DecodeError::Malformed`] — never a
/// silent mis-decode, never a panic, no migration shim.
///
/// # v3 (Phase 11, 11-02): the per-tile slot-belt clean break
/// Bumped `2 → 3` for the new APPEND-ONLY [`EditOp::DrawBelt`] variant (discriminant
/// 4, carrying the RESOLVED `tiles: Vec<BeltTile>`). The variant set changed, and
/// the `Belt` struct change forces the golden corpus to re-bless regardless, so the
/// edit-log version bumps ALONGSIDE the
/// [`SNAPSHOT_SCHEMA_VERSION`](crate::snapshot::SNAPSHOT_SCHEMA_VERSION) `5 → 6`
/// bump (the isolated, separately-reviewed Phase-9 SC#3/Q4 discipline). Pre-v1 CLEAN
/// BREAK: [`upcast`] refuses a forward (`> 3`) record with
/// [`DecodeError::UnknownVersion`]; no migration shim. (Discriminants `Place=0`,
/// `Wire=1`, `Delete=2`, `Rotate=3` are unchanged — the append is non-breaking for
/// those — but the version bumps anyway because the corpus re-bless is mandatory.)
///
/// # v4 (Phase 12, 12-02): the undo/redo vocabulary + Delete-capture clean break
/// Bumped `3 → 4` for the Phase-12 undo/redo migration, landed as ONE atomic step
/// (the clean-break discipline every prior EDIT bump followed). Two coordinated
/// shape changes ride this bump: (1) the APPEND-ONLY [`EditOp::Unlink`] (disc 6) +
/// fold-NOOP [`EditOp::Undo`]/[`EditOp::Redo`] markers (disc 7/8) that landed in
/// 12-01, and (2) THIS plan's extension of [`EditOp::Delete`] (disc 2 unchanged)
/// with a captured [`DeletedSubgraph`] field appended AFTER `cell_y` — a positional
/// postcard change to the `Delete` body (the same kind of append-within-variant the
/// v2 `Place` footprint bump made). Behaviour is UNCHANGED: the markers fold to
/// no-ops and `fold_delete` NEVER consumes `captured`, so the corpus re-bless is
/// version-tag-only and every per-tick hash stays byte-identical (12-RESEARCH
/// Pitfall 4 / A4). The bump rides ALONGSIDE the golden-corpus 0001-0013 re-bless in
/// this single plan/commit so no wave boundary ever observes a transiently-refused
/// (old-version) corpus. Pre-v1 CLEAN BREAK: [`upcast`] refuses a forward (`> 4`)
/// record with [`DecodeError::UnknownVersion`], a stale v3 `Delete` record fails
/// positional decode under v4 as [`DecodeError::Malformed`], and the new
/// `Delete.captured` Vec surface is bounded to [`MAX_BELT_TILES`] / `[GRID_MIN,
/// GRID_MAX]` at decode — never a silent mis-decode, never a panic, no migration shim.
///
/// # v5 (Phase 17, 17-02): node→node Wire removal — BYTE-FORCED discriminant renumber
/// Bumped `4 → 5` because removing the mid-enum [`EditOp`] `Wire` variant (was disc 1)
/// shifts every later discriminant DOWN: `Delete 2→1, Rotate 3→2, DrawBelt 4→3,
/// Dock 5→4, Unlink 6→5, Undo 7→6, Redo 8→7`. Unlike the v2/v3/v4 append-only bumps,
/// this is a POSITIONAL renumber of the postcard variant tag, so a v4 record whose op
/// carried the old `Wire` disc 1 now positionally mis-aligns against the v5 layout —
/// [`upcast`] refuses it as [`DecodeError::Malformed`] (proven by a FROZEN v4-Wire
/// byte-literal negative test), and a forward (`> 5`) record is refused as
/// [`DecodeError::UnknownVersion`]. Pre-v1 CLEAN BREAK: belts now come ONLY from
/// `DrawBelt` + `Dock`; no migration shim. This bump is byte-forced HERE but the
/// single coordinated golden re-bless is quarantined to 17-06.
///
/// # v6 (Phase 35, 35-03): the v6.0 coordinated re-bless - BYTE-FORCED by `Port.medium`
/// Bumped `5 -> 6` for "The One Re-bless": the new [`Port.medium`](crate::state::Port)
/// field grows every serialized `Port` by one varint, and edit records carry ports
/// ([`EditOp::Place.ports`] and [`DeletedSubgraph`]`.ports` inside `Delete.captured`), so
/// the edit-log body moves too. It lands in LOCKSTEP with the byte-forced
/// [`SNAPSHOT_SCHEMA_VERSION`](crate::snapshot::SNAPSHOT_SCHEMA_VERSION) `7 -> 8`,
/// `PROJECT_FILE_VERSION` `5 -> 6`, event [`SCHEMA_VERSION`](crate::event::SCHEMA_VERSION)
/// `1 -> 2`, and cmd-wire [`EVENT_VERSION`](crate::command::EVENT_VERSION) `2 -> 3` - the
/// single coordinated act that spends the corpus blast radius EXACTLY ONCE for all of v6.0.
/// The v6.0 additive appends ([`EditOp::DrawWire`]/[`Configure`](EditOp::Configure)/
/// [`AddPort`](EditOp::AddPort)/[`RemovePort`](EditOp::RemovePort),
/// [`MachineConfig`]/[`SourceTrigger`], [`HttpMethod`](crate::state::HttpMethod)) land as
/// SHAPE ONLY at v6: the bytes are frozen here and each op's fold arrives in a later
/// phase (`AddPort`/`RemovePort` at Phase 36, `Configure` at Phase 39, `DrawWire` at
/// Phase 63). Pre-v1 CLEAN
/// BREAK: [`upcast`] refuses a forward (`> 6`) record with [`DecodeError::UnknownVersion`];
/// no migration shim. The single coordinated golden re-bless is quarantined to its own commit.
///
/// # NOT moved at Phase 60 (`60-02`) or Phase 62 (`62-06`), and that is the decision
/// Two clean breaks have landed since v6 and this constant deliberately sat out both.
/// Each moved exactly TWO of the five serialized-shape versions in lockstep
/// ([`SNAPSHOT_SCHEMA_VERSION`](crate::snapshot::SNAPSHOT_SCHEMA_VERSION) with
/// `PROJECT_FILE_VERSION`, `8 -> 9` then `9 -> 10`), because in each case only the
/// SNAPSHOT shape was byte-forced: a belt's slot vector growing from three entries per
/// tile to four, then `Belt.ticks_per_slot` being appended. No [`EditRecord`] body
/// changed in either, so bumping this would have been cargo-culting the v6.0 re-bless
/// (which moved all five only because a new `Port` field genuinely byte-forced all five)
/// rather than following it.
///
/// This paragraph is not decoration: "the bump was SCOPED" is a claim, and the three
/// unmoved constants are the positive evidence for it. It is machine-checked rather than
/// asserted, by `core_version_consts_are_frozen` in `fabrico-host/tests/endpoint.rs`,
/// which pins all five as hand-written literals. Recorded here so a reader who arrives at
/// this constant after a clean break can tell "deliberately unmoved" from "forgotten".
///
/// # NOT moved by the `DrawWire` fold (v8.0, Phase 63 plans `63-02`/`63-03`)
/// v8.0 gave [`EditOp::DrawWire`] the fold its v6 shape had been waiting for, and gave a
/// drawn wire an undo inverse in `fabrico-command`. Neither touched a serialized byte:
/// the record still carries the same four `NodeId`/`PortId` scalars, so every committed
/// edit-log record decodes identically and this constant stays exactly where the
/// Phase-60/62 paragraph above left it. What moved is the v6 paragraph's "shape only"
/// clause - `DrawWire` no longer has a fold owed to it by a later phase.
///
/// The v8.0 `6 -> 7` bump (the CLEAN BREAK: an exact-match version refusal in
/// [`check_version`] plus the coordinated 27-fixture corpus re-bless) is a SEPARATE,
/// quarantined act owned by plan `63-11`, and its entry APPENDS directly below this one.
/// Keeping the two apart is what lets a reader see that the fold was byte-neutral and the
/// bump was deliberate.
///
/// # v7 (Phase 63, `63-11`): the EXACT-MATCH clean break
/// Bumped `6 -> 7`. Unlike every bump above it, this one is NOT byte-forced: no
/// [`EditRecord`] field moved and no discriminant shifted in plans `63-01` through
/// `63-10`. It is a deliberate refusal of every edit log written before this milestone,
/// authorised on 2026-08-18 on the grounds that the system is not in production use, so no
/// migration shim is owed and none is written.
///
/// What changed with it is the SHAPE of the predicate, not just its value.
/// [`check_version`] refuses any version that is not EXACTLY this constant, forward AND
/// backward, replacing the shipped forward-only `version > EDIT_SCHEMA_VERSION` test. A
/// version-6 log is therefore [`DecodeError::UnknownVersion`](crate::event::DecodeError::UnknownVersion)
/// rather than a positional decode that happens to succeed.
///
/// The predicate ALSO moved from three places to one. Before this plan, `upcast`,
/// `fabrico_host::driver::Host::logged_edits` and `fabrico_host::project::load_project`
/// each carried an independent copy, and `upcast` - the one documented as the decode
/// boundary - had ZERO production callers. Flipping `upcast` alone would have left a
/// version-6 `.fab` file loading cleanly while every test passed. All three now call
/// [`check_version`], so the next bump cannot land in two places out of three.
///
/// The coordinated 27-fixture golden re-bless and the three `fabrico-scenario` fixtures
/// are quarantined to plan `63-12`, which is the single reviewable re-bless commit. This
/// plan leaves both corpora deliberately stale.
///
/// # v8 (Phase 73, `73-03`): BYTE-FORCED by two fields on two EXISTING variants
/// Bumped `7 -> 8`. Unlike v7 above it, this one IS byte-forced, and by exactly two
/// fields:
///
/// 1. [`EditOp::AddPort`]`.index` - the list position the port was added at. Without it
///    the inverse of a `RemovePort` can only re-APPEND, so a removed output comes back at
///    the end of the list and every belt key stays shifted. UNDO-05's one-press re-dock is
///    unreachable without it.
/// 2. [`DeletedSubgraph`]`.self_record` - the deleted node's OWN record when the delete's
///    target is itself a bare belt or a bare wire. Without it the endpoints of a deleted
///    cable are nowhere in the log, so `compute_inverse` has nothing to rebuild it from
///    and a wire delete is permanent.
///
/// # A field on an EXISTING variant is byte-forcing; an APPENDED VARIANT is not
/// That distinction is the whole reason this bump is owed and the `Undo`/`Redo`/`AddPort`/
/// `RemovePort` variant appends above were not. postcard writes a variant's fields
/// POSITIONALLY with no names and no lengths, so a field added to a live variant shifts
/// every byte after it in every record carrying that variant. A variant appended at a NEW
/// discriminant shifts nothing: no existing record carries the new tag, so every prior
/// record decodes unchanged. Both changes here are of the first kind.
///
/// # The re-bless is in THIS commit, not quarantined to a later one
/// v6 and v7 each quarantined their corpus re-bless to a separate plan. This one does the
/// opposite deliberately. Both byte-forcing fields are forced by the SAME constant, so
/// landing them apart would mean two re-blesses of 33 golden directories and 8
/// `fabrico-scenario` fixtures, and an intermediate commit in which a `.fab` written at
/// version 8 does not decode at version 8. One bump, one re-bless, one reviewable commit.
///
/// # What is spent, stated plainly
/// [`check_version`] is exact-match in both directions with no shim, so every `.fab` file
/// written by any earlier build stops opening from this commit on, permanently. That is a
/// one-way spend and it was taken as such: decisions D-01 and D-02 of phase 73, approved
/// by the maintainer on 2026-09-05. Note the ORDER within the phase: the surface that tells a user
/// WHY such a file will not open lands one wave LATER, in plan 73-04, so at this commit
/// the refusal is real and still silent.
///
/// Phases 74 and 76 INHERIT this value and re-declare nothing (D-06). Their existing
/// "scenario fixtures NOT MOVING (all 8)" declarations stay correct, because those eight
/// files move HERE. `fabrico-host/tests/endpoint.rs::core_version_consts_are_frozen`
/// remains the live authority on all five constants.
///
/// # v9 (Phase 74.1, `74.1-12`): a DECISION-forced clean break, like `6 -> 7`
/// Bumped `8 -> 9`. Like v7 and unlike v8, NO stored byte of an [`EditOp`] shape moved:
/// every record decodes positionally exactly as it did at 8. What moved is what an
/// UNCHANGED log FOLDS TO, twice, and nothing in the log carries either verdict:
///
/// 1. Plan `74.1-03` narrowed `dock_still_reaches`' facing clause (D-02), so a quarter
///    turn of a `w x (2w+1)` machine docked at its middle port now KEEPS a belt the old
///    fold released. It was declared as a moved golden path without a bump;
///    review finding WR-01 named that as a contradiction of this repository's own
///    precedent, and this bump closes it.
/// 2. Plan `74.1-12` made `fold_remove_port` and `fold_add_port` ask IDENTITY, THEN
///    FACING: a belt dock whose re-seated port no longer faces its belt end is RELEASED
///    with one `UnlinkedDock`, where the identity-only fold kept it linked to a nub it no
///    longer touched.
///
/// A version-8 log replayed under either rule folds to a DIFFERENT board, silently, and
/// its undo path diverges too (`reconstruct_projection` re-folds the log under the new
/// rule while the restored snapshot holds the old one, review WR-01's load failure). So
/// every older log is REFUSED rather than mis-folded, by the existing exact-match
/// [`check_version`] as `UnknownVersion(8)`, and a project file bundling one is refused
/// at load by the same per-record check. That is the trade `snapshot.rs` calls strictly
/// better than a silent mis-decode, and it follows the project's standing pre-v1 rule: take the
/// bump, refuse the old version as a typed error, write no shim and no migration.
///
/// The other four constants do not move: `SNAPSHOT_SCHEMA_VERSION` 12 (no snapshot byte
/// shape moved, and a snapshot holds the folded result, not the verdict),
/// `SCHEMA_VERSION` 2, `EVENT_VERSION` 4 and `PROJECT_FILE_VERSION` 11.
///
/// # v10 (Phase 74.1, `74.1-14`): DECISION-forced again, by the layout ruling
/// Bumped `9 -> 10`. Like v7 and v9, NO stored byte of an [`EditOp`] shape moved. What
/// moved is, once more, what an UNCHANGED log folds to, by the design ruling of 2026-10-04
/// ("Edits keep middle layout"):
///
/// 1. `reseat_ports` seats each role CENTRE-OUT from the machine's catalog box
///    ([`role_slot`](crate::state::role_slot)) instead of by index, so any `AddPort` or
///    `RemovePort` on a machine whose catalog side is 3 long (a Factory, Handler or
///    Router) re-seats its ports to different cells, and the 74.1-12 facing verdict then
///    keeps or releases different docks.
/// 2. `port_catalog(ROUTER)` (in `fabrico-command`) takes the rule's output, In (0,1) and
///    Outs on rows 1, 2, 0, so a `Place{ROUTER}` record freezes different offsets. Its own
///    docblock names a catalog edit that changes new placements as an
///    `EDIT_SCHEMA_VERSION`-bumping act.
///
/// Version 9 never shipped in a release, but it IS in committed history (74.1-12's gated
/// revision, in the pre-release history), and any build from it writes version-9 edit logs and `.fab`
/// records. Reusing 9 because it never shipped would let such a log fold to a different
/// board without a word, which is the trick the project's no-silent-migration rule forbids. So every version-9 record
/// is refused as `UnknownVersion(9)` and a `.fab` bundling one as
/// `UnreadableEditRecord(9)`, by the existing exact-match [`check_version`]; no shim, no
/// migration. The other four constants do not move: no stored byte shape changed, and a
/// snapshot restores its stored port cells exactly as before, so `SNAPSHOT_SCHEMA_VERSION`
/// stays 12, `SCHEMA_VERSION` 2, `EVENT_VERSION` 4 and `PROJECT_FILE_VERSION` 11.
///
/// # v11 (Phase 74.1, `74.1-16`): BYTE-forced AND DECISION-forced, by design ruling N5
/// Bumped `10 -> 11`. Like v8, a stored byte shape moved, by two trailing fields on two
/// LIVE variants: [`EditOp::AddPort`]`.seat` ([`PortSeat`]) and
/// [`EditOp::RemovePort`]`.restore` (`Option<`[`BoxRestore`]`>`). postcard writes fields
/// positionally, so every port-edit record changes length (an `AddPort` gains one byte for
/// its seat, a `RemovePort` one byte for a `None` restore and more for a `Some`) and every
/// byte after it moves. And like v9 and v10, what an UNCHANGED log folds to moved too:
///
/// 1. It was decided (2026-10-04) that removing an output moves no other port and that
///    existing ports are not auto-arranged. So `fold_remove_port` no longer re-seats the survivors or shrinks the
///    box, and only the removed port's own docks are released, reversing plan 74.1-12's
///    re-seat release.
/// 2. Review WR-01: a growing `AddPort` on a machine turned 90 or 180 degrees moved its
///    input and every output one cell, because the box grew with its anchor fixed. Now a
///    new port takes the first free slot of its role and the box grows on its far edges
///    with the anchor shifted by the growth, so no In or Out moves at any rotation.
///
/// The two fields exist because a slot is no longer a function of list position: the
/// inverse of a removal must name the slot it puts the port back on (`seat: Captured`),
/// and the inverse of a growing add must name the box and anchor it shrinks back to
/// (`restore: Some`). Every forward record carries `Auto` / `None`.
///
/// Version 10 never shipped in a release, but it IS in committed history (74.1-14's and
/// 74.1-15's gated revisions), and any build from it writes version-10 edit logs and `.fab`
/// records. So every version-10 record is refused as `UnknownVersion(10)` and a `.fab`
/// bundling one as `UnreadableEditRecord(10)`, by the existing exact-match
/// [`check_version`]; no shim, no migration (the project's pre-v1 clean-break rule).
/// The other four constants do not move: no snapshot or cmd-wire
/// byte shape changed, and a snapshot restores its stored port cells unchanged (the trust
/// gate only requires a port inside its box, which a kept slot always is), so
/// `SNAPSHOT_SCHEMA_VERSION` stays 12, `SCHEMA_VERSION` 2, `EVENT_VERSION` 4 and
/// `PROJECT_FILE_VERSION` 11.
///
/// # v12 (Phase 85, `85-05`): BYTE-forced, by the Email removal (D-08, CHROME-04)
/// Bumped `11 -> 12`. [`EditOp::Configure`] carries a
/// [`MachineConfig::Sink`]`.target`, a [`SinkTemplate`](crate::state::SinkTemplate), and
/// that enum lost its Email variant with no placeholder, so `Http` moved from
/// discriminant 2 to 1. A v11 record configuring an Email sink would otherwise decode
/// positionally as an HTTP sink (MEASURED on the frozen witness: the address becomes
/// the URL, the subject's length byte becomes the method), and a v11 record
/// configuring an HTTP sink would decode as nothing valid. So every version-11 record
/// is refused as `UnknownVersion(11)` by the existing exact-match [`check_version`], and
/// a `.fab` bundling one is refused at load by the same per-record check; no shim, no
/// migration. Frozen witness: `frozen_v11_email_configure_is_refused_under_v12`.
///
/// In lockstep with `SNAPSHOT_SCHEMA_VERSION` `12 -> 13` and cmd-wire `EVENT_VERSION`
/// `4 -> 5`. Event `SCHEMA_VERSION` stays 2, and `PROJECT_FILE_VERSION` stays 11 until its
/// final v12 shape lands in plan 85-09 (D-07).
///
/// The same v12 shape also carries [`EditOp::SealHistory`] (D-10), appended after
/// `RemovePort` at discriminant 12. An append at the last position moves no stored byte,
/// but riding this bump means no log written between the two plans carries a shape its
/// version does not name.
///
/// # v13 (Phase 86, 86-02): BYTE-forced, by the turn a Delete undo must bring back (D-03)
/// Bumped `12 -> 13`. Three fields are appended LAST, each to its own type: `rot: u8` on
/// [`EditOp::Place`], `rot: u8` on [`DeletedSubgraph`], and `ticks_per_slot: NonZeroU32`
/// on [`DeletedBelt`]. postcard writes fields positionally, so every `Place` record grows
/// by one byte, every `Delete` record by one byte plus one varint per captured belt
/// (cascade and self record alike), and every byte after them moves.
///
/// The two rotations exist because a turned machine that was deleted came back from
/// Ctrl+Z unturned: the capture named no rotation and the `Place` it replays could not
/// express one, so the rot-0 box landed over a neighbour placed beside the turned body
/// and the saved board would not open. Now the capture records the rotation and the
/// inverse re-Places the turned box in one claim. Every forward placement still writes
/// rot 0. The belt pace rides the same bump so plan 86-03's cascade re-Configure has a
/// pace to apply without a second version: one bump carries all three, because a shape
/// change after a committed version-13 build would need version 14.
///
/// Every version-12 record is refused as `UnknownVersion(12)` by the exact-match
/// [`check_version`], and a `.fab` bundling one as `UnreadableEditRecord(12)` by the
/// same per-record check; no shim, no migration ("no tricks, take the schema bump").
/// Frozen witness: `frozen_v12_delete_is_refused_under_v13`. The other four constants do
/// not move: no snapshot shape changed (a turned footprint was already a `footprints`
/// entry carrying its `rot`), no cmd-wire byte moved (`GridCommand::Place` is untouched),
/// and the project envelope is unchanged, so `SNAPSHOT_SCHEMA_VERSION` stays 13,
/// `PROJECT_FILE_VERSION` 12, event `SCHEMA_VERSION` 2 and `EVENT_VERSION` 5.
pub const EDIT_SCHEMA_VERSION: u16 = 13;

/// A logged topology edit — the atomic unit of the edit-log and the two-log
/// per-tick merge. Plain serializable data (CORE-09).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EditRecord {
    /// Schema version for upcast-on-read (CORE-10).
    pub schema_version: u16,
    /// Logical partition key (CORE-08, ignored in single-partition mode).
    pub partition: PartitionKey,
    /// Monotonic sequence within the partition; the ROUTE-06-style tie-break id.
    pub sequence: u64,
    /// The tick this edit applies at — the two-log MERGE KEY.
    pub tick: u64,
    /// The UNDO-02 coalescing-group id ("one logical action = one undo step").
    /// Present for Phase-12 inverse-append; NOT consumed in Phase 8.
    pub action: u64,
    /// The RESOLVED / normalized operation (decision Q2).
    pub op: EditOp,
}

/// Which END of a belt an [`EditOp::Dock`] attaches to — the core mirror of
/// `fabrico_protocol::BeltEnd`, kept in LOCKSTEP (like the duplicated `machine_kind`
/// convention; `fabrico-core` and `fabrico-protocol` are independent crates, so the
/// type is re-declared here rather than shared). Belt flow runs from the **TAIL**
/// (admit / entry, the first drawn tile, belt slot `M-1`) toward the **HEAD**
/// (deliver / exit, the last drawn tile, belt slot 0). The dock DIRECTION is implied:
/// [`Head`](BeltEnd::Head) => the belt delivers into a machine `In` (LOAD),
/// [`Tail`](BeltEnd::Tail) => a machine `Out` feeds the belt (OFFLOAD).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum BeltEnd {
    /// The deliver / exit end (belt slot 0). Docks to a machine `In` (LOAD).
    #[default]
    Head,
    /// The admit / entry end (belt slot `M-1`). Docks to a machine `Out` (OFFLOAD).
    Tail,
}

/// One cascade-removed belt captured at delete time (Phase 12, 12-02) so a Phase-12
/// undo can reconstruct the exact topology a delete tore down. Plain ordered serde
/// data (CORE-09): no floats, no HashMaps, no pointers. Carries the belt's resolved
/// `kind` (`machine_kind` u8), its drawn `geometry` tiles, and the directed `links`
/// (each `(from_node, from_port, to_node, to_port)`) it was incident to. NOT consumed
/// at fold time — purely the inverse-append payload, populated at delete-action time
/// in plan 12-05. Its `geometry`/`links` Vec surfaces are bounded to [`MAX_BELT_TILES`]
/// and its cells to `[GRID_MIN, GRID_MAX]` at the [`upcast`] decode boundary.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeletedBelt {
    /// The resolved belt `machine_kind` u8 captured at delete time.
    pub kind: u8,
    /// The drawn belt geometry (per-tile cells/shapes). Bounded to [`MAX_BELT_TILES`];
    /// each `cell` to `[GRID_MIN, GRID_MAX]` at decode.
    pub geometry: Vec<BeltTile>,
    /// The directed dock links this belt was incident to, each
    /// `(from_node, from_port, to_node, to_port)`. Bounded to [`MAX_BELT_TILES`] at decode.
    pub links: Vec<(NodeId, PortId, NodeId, PortId)>,
    /// The belt's pace at the Delete, in ticks per slot (EDIT 13, plan 86-02), read off the
    /// belt node by `capture_deleted_subgraph`. **Appended LAST** (postcard is positional),
    /// so every `DeletedBelt` grows by its varint. Plan 86-03's cascade re-Configure applies
    /// it after the re-draw, so a slowed belt comes back at its own pace. A pace of 0 is
    /// refused at decode by the type; any non-zero pace loads, because the pace range is a
    /// write-side rule (D-68-17), not a decode bound.
    pub ticks_per_slot: NonZeroU32,
}

/// An empty capture at the shipped default pace. Written by hand because `NonZeroU32` has
/// no `Default`; the default pace is the one a freshly drawn belt takes.
impl Default for DeletedBelt {
    fn default() -> Self {
        DeletedBelt {
            kind: 0,
            geometry: Vec::new(),
            links: Vec::new(),
            ticks_per_slot: crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
        }
    }
}

/// One cascade-removed WIRE captured at delete time (63-06), the wire sibling of
/// [`DeletedBelt`]. Plain ordered serde data (CORE-09): no floats, no HashMaps, no
/// pointers. Carries the wire's resolved `kind` (`machine_kind` u8, always `WIRE` = 8,
/// the same lockstep mirror convention `DeletedBelt` uses), its logical `from`/`to`
/// endpoints, and every directed link it was incident to.
///
/// # What restores a wire, and what this `links` list is for
/// A wire's NODE needs only its two endpoints to come back: `fold_draw_wire` re-mints it
/// AND re-writes the single `(wire, 0) -> to` link from those endpoints. Its LINKS need
/// this list. Since plan 73-05 (UNDO-03) the undo leg in `fabrico_command`'s
/// `compute_inverse` replays one `EditOp::DrawWire` and then one `EditOp::Dock` for EVERY
/// captured link that is not the canonical `(wire, 0) -> to` one the `DrawWire` already
/// wrote, in this list's own order and using the same direction rule the belt leg uses
/// (the wire as link SOURCE is `Head`, the wire as link TARGET is `Tail`). `links` is
/// therefore an INPUT THE RESTORE CONSUMES, not an audit record.
///
/// It became one because it had to. A `Dock` aimed at the wire writes
/// `link((node, port), (wire, 0))`, which is exactly the shape `fold_draw_wire` never
/// writes, so a restore that replayed only the `DrawWire` handed back a graph missing
/// that edge and returned `Ok` while doing it. Nothing told the user, which is what made
/// it the worst shape in the UNDO cluster and why it is closed here rather than recorded
/// as a boundary.
///
/// A capture holding links but NO canonical one is refused with a typed error rather than
/// silently restored short: the wire's own id is derived from that link (a cascade record
/// carries no id field), so without it the replay cannot name the node the other links
/// attach to.
///
/// Its `links` Vec surface is bounded to [`MAX_BELT_TILES`] at the [`upcast`] decode
/// boundary, and the enclosing `wires` list is bounded to the same ceiling.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeletedWire {
    /// The resolved wire `machine_kind` u8 captured at delete time (always `WIRE`).
    pub kind: u8,
    /// The wire's logical source endpoint `(node, port)`.
    pub from: (NodeId, PortId),
    /// The wire's logical target endpoint `(node, port)`.
    pub to: (NodeId, PortId),
    /// The directed links this wire was incident to, each
    /// `(from_node, from_port, to_node, to_port)`. Bounded to [`MAX_BELT_TILES`] at decode.
    pub links: Vec<(NodeId, PortId, NodeId, PortId)>,
}

/// The DELETED NODE'S OWN record, for a delete whose target is itself a bare belt or a
/// bare wire rather than a machine (Phase 73, plan 73-03).
///
/// # Why this exists at all
/// [`DeletedSubgraph`] was shaped for a MACHINE delete: `w`/`h`/`ports` describe the
/// deleted machine, and `belts`/`wires` describe what the CASCADE tore down around it.
/// Deleting a BARE wire fits nothing in that shape. `capture_deleted_subgraph` reads the
/// deleted node's footprint (a faithful 1x1), its ports (none), its docked belts (none)
/// and its docked wires (none), so the capture comes out
/// `{w: 1, h: 1, ports: [], belts: [], wires: []}`. That capture is REAL - `is_empty()`
/// reports `false`, because the predicate keys on `w` alone - so the kind-catalog
/// fallback never fires, and `compute_inverse` walked on into a `Place { kind: WIRE }`
/// that `fold_place` deliberately never mints. The user pressed Ctrl+Z, was told the
/// host could not read the gesture, and lost the cable for good.
///
/// # Why a TAGGED enum, and not two fields or a position in an existing list
/// Pushing the node's own record into `belts` / `wires` would leave it distinguishable
/// from a CASCADE record only BY POSITION, a convention a later reader has to infer. It
/// would also break [`identify_belt`](../../fabrico_command/index.html), which infers a
/// belt's id from its incident links and, for a link-less bare belt, falls through to the
/// deleted machine's own id. Two `Option` fields (`self_belt`, `self_wire`) would make a
/// both-set state expressible that means nothing. One tagged field says which of the two
/// it is and cannot say both.
///
/// # It needs no id field
/// `EditOp::Delete { node, .. }` already carries the deleted node's own id, so the
/// inverse maps `node` straight onto the re-minted id and never consults `identify_belt`.
/// That is the whole reason two variants are enough.
///
/// # It adds NO new decode surface to bound
/// Both variants wrap types whose `Vec` surfaces are ALREADY bounded to
/// [`MAX_BELT_TILES`] at the [`upcast`] decode boundary. The `Option` inherits nothing
/// automatically, so [`upcast`] reaches INTO this field explicitly rather than assuming
/// the outer bound covers it (threat T-73-03-02). No new unbounded `Vec` is introduced.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum DeletedSelf {
    /// The deleted node was itself a bare BELT: its own kind, geometry and incident links.
    Belt(DeletedBelt),
    /// The deleted node was itself a bare WIRE: its own kind, endpoints and incident links.
    Wire(DeletedWire),
}

/// The inverse subgraph captured when an [`EditOp::Delete`] removes a machine
/// (Phase 12, 12-02): the deleted machine's resolved footprint (`w`, `h`, `ports`)
/// plus every cascade-removed belt (`belts`) and, since 63-06, every cascade-removed
/// wire (`wires`). This is the append-only undo payload:
/// `fold_delete` NEVER consumes it (so the re-bless stays per-tick-hash-identical,
/// 12-RESEARCH Pitfall 4); real population happens at delete-action time in plan
/// 12-05, where THIS plan only makes the field EXIST and default-empty so behaviour
/// is byte-identical. Plain ordered serde data (CORE-09): no floats, no HashMaps, no
/// pointers. Its `ports`/`belts`/`wires` Vec surfaces are bounded to [`MAX_BELT_TILES`]
/// and its cells to `[GRID_MIN, GRID_MAX]` at the [`upcast`] decode boundary.
///
/// # `wires` is APPENDED LAST, and it moves bytes (63-06, quarantine 1b)
/// postcard is positional and not self-describing, so LAST is the only byte-predictable
/// position for a new field. Unlike every other append this phase makes, this one is
/// NOT byte-neutral: an empty `Vec` still encodes as one zero length varint, so EVERY
/// `Delete` record in the frozen corpus grows by exactly one byte. That movement is
/// deliberate, is measured on its own in the `Quarantine 1b` section of
/// `63-CORPUS-MEASUREMENT.md`, and is re-blessed once in plan 63-12.
///
/// # `self_record` is APPENDED LAST after that, and it moves bytes too (73-03)
/// The same positional rule applies for the same reason: postcard is not
/// self-describing, so LAST is the only byte-predictable position for a new field, and
/// `self_record` therefore sits after `wires`. Like that append this one is NOT
/// byte-neutral - a `None` still encodes as one zero discriminant byte - so every
/// `Delete` record in both frozen corpora grows by exactly one more byte. It is one of
/// the TWO fields forcing `EDIT_SCHEMA_VERSION` to 8 (the other is `EditOp::AddPort`'s
/// `index`), and the coordinated re-bless of both corpora rides the SAME commit as the
/// constant rather than being quarantined to a later one.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeletedSubgraph {
    /// The deleted machine's resolved footprint width in the rot-0 frame.
    pub w: u16,
    /// The deleted machine's resolved footprint height in the rot-0 frame.
    pub h: u16,
    /// The deleted machine's resolved rot-0 ports. Bounded to [`MAX_BELT_TILES`];
    /// each `local_offset` to `[GRID_MIN, GRID_MAX]` at decode.
    pub ports: Vec<Port>,
    /// Every belt removed by the delete cascade, with its geometry + incident links.
    /// Bounded to [`MAX_BELT_TILES`] at decode.
    pub belts: Vec<DeletedBelt>,
    /// Every WIRE removed by the delete cascade, with its endpoints + incident links,
    /// in the ascending-`NodeId` order `GridState::docked_wires` collects and
    /// `remove_node` removes them (63-06). **Appended LAST** - see the type doc.
    /// Bounded to [`MAX_BELT_TILES`] at decode.
    pub wires: Vec<DeletedWire>,
    /// The DELETED NODE'S OWN record when the delete's target is itself a bare belt or a
    /// bare wire rather than a machine (73-03); `None` for a machine, which is what every
    /// record written before this field existed decodes as. **Appended LAST** - see the
    /// type doc. Its inner `Vec` surfaces are bounded to [`MAX_BELT_TILES`] at decode,
    /// reached explicitly by [`upcast`] rather than inherited by assumption.
    pub self_record: Option<DeletedSelf>,
    /// The rotation the deleted machine held, `0..=3` quarter-turns clockwise, read off its
    /// footprint (absent footprint is rot 0). **Appended LAST** (EDIT 13, plan 86-02), so
    /// every `Delete` record grows by one byte. The Delete inverse re-Places the machine at
    /// this rotation in ONE claim. It does not re-Place at rot 0 and then Rotate: the rot-0
    /// claim writes every body cell into the occupancy index, a neighbour's included, and
    /// the Rotate then frees every old body cell the index gives this id, so the neighbour
    /// ends up on cells no one owns (the turned-Delete todo, probes `probe_p4`, `probe_p4l`).
    /// A value above 3 is refused at decode by [`upcast`] and at load by `load_project`.
    pub rot: u8,
}

impl DeletedSubgraph {
    /// `true` when this is the empty/default capture — no machine footprint was
    /// recorded. A REAL capture always has `w >= 1`: `capture_deleted_subgraph`
    /// resolves the footprint via `footprint_of(id).map_or((1, 1), ..)`, so the
    /// minimum is a 1×1. That invariant makes `w == 0` a unique, unambiguous sentinel
    /// for "no capture — fall back to the kind catalog", relied on by
    /// `compute_inverse`'s Delete-leg restore (WR-02). Carried as a named predicate so
    /// the use site reads its intent instead of a bare magic `w == 0`.
    ///
    /// **The 63-06 `wires` append does NOT disturb this sentinel**, and a reader who has
    /// just watched a field arrive is entitled to check rather than be told: the
    /// predicate keys on `w` alone, and a real capture still resolves `w >= 1` from the
    /// footprint before any wire is looked at. A machine with wires but no belts, and a
    /// machine with neither, both still report `is_empty() == false`.
    ///
    /// **Nor does the 73-03 `self_record` append**, and the same entitlement to check
    /// rather than be told applies: the predicate still keys on `w` alone, and a BARE
    /// wire or BARE belt capture also resolves `w >= 1`, because `capture_deleted_subgraph`
    /// runs the identical `footprint_of(id).map_or((1, 1), ..)` on it. That identity is
    /// precisely WHY a bare-node capture was indistinguishable from a machine capture
    /// before this field existed, and it is why the answer is a tagged field rather than
    /// a new sentinel value: widening `is_empty()` to mean "no capture OR a bare node"
    /// would silently change what the WR-02 catalog fallback fires on, for every kind.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.w == 0
    }
}

/// Where an [`EditOp::AddPort`] seats its port (plan 74.1-16). Plain serde data.
///
/// The forward gesture ("add an output") always writes [`Auto`](PortSeat::Auto); only the
/// inverse of a `RemovePort` writes [`Captured`](PortSeat::Captured).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PortSeat {
    /// The first free slot of the port's role, walked in the centre-out `role_slot` order
    /// from the catalog box ([`first_free_slot`](crate::state::first_free_slot)).
    #[default]
    Auto,
    /// The port's OWN slot, read off its captured `local_offset` (the row for an In or an
    /// Out, the column for a Fault): the slot it was removed from.
    Captured,
}

/// The box and anchor an [`EditOp::RemovePort`] puts back (plan 74.1-16): the rot-0
/// `w x h` an `AddPort` grew from and the anchor it had then. Plain serde data, written
/// only by the inverse of an `AddPort`; every forward removal carries `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BoxRestore {
    /// The rot-0 width to restore.
    pub w: u16,
    /// The rot-0 height to restore.
    pub h: u16,
    /// The anchor x to restore.
    pub anchor_x: i32,
    /// The anchor y to restore.
    pub anchor_y: i32,
}

/// The resolved topology operations an [`EditRecord`] can carry. After the 17-02
/// node→node Wire removal the variant order is `Place=0, Delete=1, Rotate=2,
/// DrawBelt=3, Dock=4, Unlink=5, Undo=6, Redo=7` — the removal renumbered every
/// discriminant after the old `Wire` (disc 1) DOWN, the byte-forced
/// [`EDIT_SCHEMA_VERSION`] `4 → 5` bump (the `schema_version` guards old logs whose
/// bytes no longer align against this layout).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EditOp {
    /// Place a machine of `kind` at a logical grid cell (resolved placement).
    ///
    /// `kind` follows the shared `machine_kind` u8 convention (0=Source, 1=Belt,
    /// 2=Factory, 3=Tee, 4=Balancer, 5=Router, 6=Merge, 7=Sink) — the single
    /// source of truth in `fabrico-protocol::machine_kind`. `cell_x`/`cell_y`
    /// ride here even though the core `GridState` stays cell-free until Phase 9
    /// (SPAT-01, Assumption A4); they live in the host-side layout projection.
    ///
    /// Phase 10 (10-02) **appends** the resolved footprint fields `w`, `h`, `ports`
    /// AFTER `cell_y` — append-only within the variant, so the wire change is the
    /// [`EDIT_SCHEMA_VERSION`] `1 → 2` bump, not a discriminant shift. A 1×1
    /// point-machine carries `w=1, h=1, ports=[]` (the faithful default); the
    /// multi-cell catalog that resolves real dims/ports lands in 10-04. The fold
    /// applies these faithfully — a 1×1 still claims exactly its single cell and
    /// writes NO `footprints`/`ports` map entry (absent ⇒ 1×1 rot0).
    Place {
        /// Machine class to mint (the `machine_kind` u8 convention).
        kind: u8,
        /// Target grid cell X (the placement anchor / min-corner).
        cell_x: i32,
        /// Target grid cell Y (the placement anchor / min-corner).
        cell_y: i32,
        /// Resolved footprint width in the rot-0 frame (`1` for a 1×1 point machine).
        w: u16,
        /// Resolved footprint height in the rot-0 frame (`1` for a 1×1 point machine).
        h: u16,
        /// Resolved ports in the rot-0 frame (empty for a port-less 1×1; the catalog
        /// that populates this lands in 10-04).
        ports: Vec<Port>,
        /// The rotation the rot-0 box above is claimed at, `0..=3` quarter-turns clockwise
        /// (EDIT 13, plan 86-02). **Appended LAST**, so every `Place` record grows by one
        /// byte. Every forward placement writes 0; only the inverse of a `Delete` writes
        /// another, the rotation its capture recorded, so a turned machine comes back
        /// turned in one step. A value above 3 is refused at decode and at load, and
        /// `fold_place` mints nothing for one.
        rot: u8,
    },
    /// Delete a node or belt. Carries the resolved `kind` + cell captured at
    /// delete time so the log is head/append-aware for Phase-12 inverse-append
    /// (decision FORK 1). Phase 12 (12-02) **appends** a `captured`
    /// [`DeletedSubgraph`] AFTER `cell_y` — the full inverse payload (footprint +
    /// cascade-removed belts) a Phase-12 undo replays to rebuild the torn-down
    /// topology. This is an append-WITHIN-variant positional change (disc was 2 at
    /// the `3 → 4` bump; the 17-02 Wire removal shifted it to disc 1). CRITICAL: `fold_delete`
    /// does NOT consume `captured` — it still only `remove_node(node)`s — so the
    /// re-bless of the golden corpus is per-tick-hash-IDENTICAL (12-RESEARCH Pitfall
    /// 4). Real population of `captured` lands at delete-action time in plan 12-05;
    /// THIS plan only makes the field exist, default-empty. A delete of an absent
    /// node is a no-op at fold time (never panics).
    Delete {
        /// The node to remove.
        node: NodeId,
        /// The resolved machine kind captured at delete time (`machine_kind` u8).
        kind: u8,
        /// The resolved grid cell X captured at delete time.
        cell_x: i32,
        /// The resolved grid cell Y captured at delete time.
        cell_y: i32,
        /// The captured inverse subgraph (Phase 12, 12-02): the deleted machine's
        /// footprint + every cascade-removed belt, so a Phase-12 undo can rebuild the
        /// torn-down topology by inverse-append. NOT consumed by `fold_delete` (the
        /// re-bless stays per-tick-hash-identical); empty until plan 12-05 populates it.
        captured: DeletedSubgraph,
    },
    /// Rotate a placed machine in 90° steps (FOOT-02). The anchor (min-corner) is
    /// FIXED — an anchor-preserving pivot, never a relocation. Carries the resolved
    /// **absolute** `new_rot` (the orientation to apply) AND the `old_rot` it
    /// replaced: capturing BOTH (mirroring [`Delete`](EditOp::Delete) capturing its
    /// resolved fields at validate time) makes Phase-12 undo a pure inverse-append —
    /// the compensating record just swaps `new_rot`/`old_rot` (CONTEXT). The relative
    /// quarter-turn the UI issues (`GridCommand::Rotate { ccw }`) is resolved to this
    /// absolute pair by `fabrico-command`'s `validate_normalize`; the fold applies
    /// `new_rot` VERBATIM (no catalog lookup, no re-collision-check — legality was
    /// decided at validate time, Q2). Discriminant 2 after the 17-02 Wire removal
    /// (`Place`/`Delete` at 0/1); it was appended at disc 3 in Phase 10 (non-breaking
    /// then), and the removal's byte-forced renumber is re-frozen in 17-06.
    Rotate {
        /// The node to rotate (its footprint pivots about its fixed anchor).
        node: NodeId,
        /// The resolved ABSOLUTE new orientation (90° CW quarter-turns, `0..=3`).
        new_rot: u8,
        /// The orientation this rotation replaced (captured for Phase-12
        /// inverse-append; NOT consumed at fold time).
        old_rot: u8,
    },
    /// Draw a per-tile belt (BELT-01..06). Carries the RESOLVED, normalized
    /// `tiles` — the typed/oriented straight+corner geometry the (11-05) `route()`
    /// normalizer produced; replay applies them VERBATIM and NEVER re-routes
    /// (BELT-04, mirrors `Place`/`Rotate` freezing resolved fields). The dock
    /// endpoints are a SEPARATE explicit command (11-06), so `DrawBelt` carries
    /// geometry ONLY. Discriminant 3 after the 17-02 Wire removal
    /// (`Place`/`Delete`/`Rotate` at 0/1/2); the tile count is bounded to
    /// [`MAX_BELT_TILES`] and each `cell` to `[GRID_MIN, GRID_MAX]` at the
    /// [`upcast`] decode boundary.
    DrawBelt {
        /// The RESOLVED, normalized belt tiles (BELT-04: replay never re-routes).
        /// Bounded to [`MAX_BELT_TILES`]; each `cell` to `[GRID_MIN, GRID_MAX]`.
        tiles: Vec<BeltTile>,
    },
    /// Dock a belt endpoint to a machine port (BELT-05/06) — the SEPARATE explicit
    /// dock command (11-06), NOT carried on `DrawBelt` (which is geometry-only). The
    /// endpoints are RESOLVED [`NodeId`]s — replay re-mints identical slotmap ids in
    /// fold order. `fold_dock` applies it VERBATIM by `link`-ing the directed pair
    /// (NO re-validation — legality was decided at validate time, Q2): a
    /// [`Head`](BeltEnd::Head) LOAD dock links `(belt, 0) -> (node, port)`; a
    /// [`Tail`](BeltEnd::Tail) OFFLOAD dock links `(node, port) -> (belt, 0)` (the
    /// belt's single port 0 is BOTH its head output and tail input). A dock of an
    /// absent belt/node is a panic-free fold no-op. Discriminant 4 after the 17-02
    /// Wire removal (`Place`/`Delete`/`Rotate`/`DrawBelt` at 0/1/2/3); it was appended
    /// at disc 5 in Phase 11, and the removal's byte-forced renumber is re-frozen in 17-06.
    Dock {
        /// The belt being docked (a resolved [`NodeId`]).
        belt: NodeId,
        /// Which belt end docks (implies the `link` direction).
        endpoint: BeltEnd,
        /// The machine node (a resolved [`NodeId`]).
        node: NodeId,
        /// The machine port to dock to.
        port: PortId,
    },
    /// Remove a single directed dock link — the exact directional INVERSE of
    /// [`Dock`](EditOp::Dock) (Phase 12, 12-01). Carries the SAME shape as `Dock`
    /// (`belt`, `endpoint`, `node`, `port`) so the directed key `fold_dock` linked
    /// is recomputable and `fold_unlink` can remove exactly that one entry: a
    /// [`Head`](BeltEnd::Head) unlink removes `(belt, 0) -> …`; a
    /// [`Tail`](BeltEnd::Tail) unlink removes `(node, port) -> …`. Applied VERBATIM
    /// (NO re-validation — it is a frozen inverse record, the undo driver appends
    /// it). Unlinking an absent key is a panic-free fold no-op (strictly safer than
    /// `fold_dock`'s missing-node guard). Discriminant 5 after the 17-02 Wire removal
    /// (`Place`/`Delete`/`Rotate`/`DrawBelt`/`Dock` at 0/1/2/3/4); it was appended at
    /// disc 6 in Phase 12. Carries only fixed-size scalars → no new `upcast`
    /// allocation surface, so it rides the existing version-refusal arm only.
    Unlink {
        /// The belt whose dock link is being removed (a resolved [`NodeId`]).
        belt: NodeId,
        /// Which belt end the original dock linked (implies the directed key to remove).
        endpoint: BeltEnd,
        /// The machine node the original dock referenced (a resolved [`NodeId`]).
        node: NodeId,
        /// The machine port the original dock referenced.
        port: PortId,
    },
    /// A fold-NOOP lineage marker recording that an undo of `target_action`
    /// happened (Phase 12, 12-01; 12-RESEARCH Pattern 1, recommended option ii —
    /// two flat variants over a nested direction enum, per Open Question 1). It
    /// carries ONLY the target action id and has NO topology effect: `apply_edit`
    /// dispatches it to an explicit fold-NOOP arm, so folding it changes ZERO
    /// `GridState` bytes. The actual inverse records ride alongside it in the same
    /// shared-action group; this marker is the append-only audit trail the undo/redo
    /// driver reads to walk lineage. Discriminant 6 after the 17-02 Wire removal
    /// (was disc 7 in Phase 12), carries only a fixed-size `u64` → no new `upcast`
    /// allocation surface.
    Undo {
        /// The action id this undo compensates (the lineage link; not consumed at fold).
        target_action: u64,
    },
    /// A fold-NOOP lineage marker recording that a redo of `target_action`
    /// happened (Phase 12, 12-01; the mirror of [`Undo`](EditOp::Undo), linear
    /// history per Q1.1). Like `Undo` it carries ONLY the target action id, folds to
    /// an explicit NOOP (zero `GridState` bytes changed), and exists purely as the
    /// append-only lineage trail. Discriminant 7 after the 17-02 Wire removal
    /// (was disc 8 in Phase 12), carries only a fixed-size `u64` → no new `upcast`
    /// allocation surface.
    Redo {
        /// The action id this redo re-applies (the lineage link; not consumed at fold).
        target_action: u64,
    },
    /// Draw a request/response WIRE between two machine ports (WR-01, Phase 37) —
    /// the logical `(node, port) -> (node, port)` connection a `Node::Wire` transports
    /// over. A FRESH append at discriminant 8 (byte-additive: `Place=0 … Redo=7` are
    /// unchanged, so every frozen edit-log record decodes byte-identically and the
    /// golden corpus stays GREEN — zero corpus instances land here). This is NOT a
    /// revival of the Phase-17-removed node→node `Wire` op (that was disc 1, removed
    /// entirely): a wire is now an explicit request/response transport machine, and
    /// this op only records the topology edit that draws one. Carries ONLY fixed-size
    /// scalars (`NodeId`/`PortId`) → NO new `upcast` allocation surface, so it rides the
    /// existing version-refusal arm only.
    ///
    /// # What it does
    /// It names two `(node, port)` endpoints and folds through `fold_draw_wire`
    /// (module-private, in `tick.rs`), which mints one [`Node::Wire`](crate::state::Node) carrying those
    /// endpoints and records the ONE forward `links` entry out of the wire's own output
    /// port — the same shape a forward wire minted by `add_wire` plus one `link` has, so
    /// a drawn wire and a seeded forward wire are byte-indistinguishable. Endpoint legality (role,
    /// medium, occupancy, self-loop) is decided ONCE at command-validate time by
    /// `fabrico_command::validate_normalize`; this record is applied VERBATIM and the
    /// fold never re-validates. A forged record naming a node that is not live writes
    /// ZERO `GridState` bytes and never panics.
    DrawWire {
        /// The output side the wire originates from (a resolved [`NodeId`]).
        from_node: NodeId,
        /// The output port on `from_node`.
        from_port: PortId,
        /// The input side the wire terminates at (a resolved [`NodeId`]).
        to_node: NodeId,
        /// The input port on `to_node`.
        to_port: PortId,
    },
    /// Configure a placed machine (CFG-01/CFG-02, Phase 39) — the edit-log record that
    /// carries a machine's authored configuration. Appended at discriminant 9
    /// (byte-additive; zero corpus instances this phase, so the golden corpus stays
    /// GREEN). APPLIED by `fold_configure` since Phase 39: a Factory config writes the
    /// node's source and evicts its compiled engine, a Sink config writes its template,
    /// a Belt config writes its advance interval, a Router config writes its table and
    /// default port, and a Source config is a core no-op because the trigger is
    /// host-side.
    ///
    /// # The COMPLETE CFG-01 surface is frozen NOW (the second-bump firewall)
    /// The `config: MachineConfig` payload is shaped for the ENTIRE CFG-01 authoring
    /// surface (Factory JS source, Source webhook/timer trigger, Sink target) in THIS
    /// re-bless — a struct/enum-field append under postcard is a clean-break version
    /// bump, so any CFG-01 field missing here would force a FORBIDDEN second serialized
    /// bump in Phase 39 (RESEARCH §Q5 / Pitfall 5, the standing single-re-bless
    /// constraint). Declare it complete once, populate/apply in Phase 39.
    ///
    /// # `code_hash` is opaque host-computed bytes the core NEVER computes (CFG-02)
    /// `code_hash` is the blake3 digest of the EXACT Factory JS bytes the sandbox runs,
    /// computed and verified ONLY in `fabrico-host` (blake3 is a DEV-ONLY dep in
    /// `fabrico-core` and MUST NOT enter the core runtime). The core STORES and
    /// round-trips these 32 opaque bytes but never computes or interprets them; a
    /// `[0u8; 32]` fill is the N/A value (e.g. a Source/Sink config with no JS). The
    /// Factory JS `String` is the ONLY new unbounded-allocation surface this plan adds;
    /// it is bounded reject-only by [`MAX_CONFIG_BYTES`] at the [`upcast`] decode boundary.
    Configure {
        /// The machine node this configuration targets (a resolved [`NodeId`]).
        node: NodeId,
        /// The complete CFG-01 machine configuration (Factory/Source/Sink).
        config: MachineConfig,
        /// The opaque, host-computed blake3 of the exact Factory JS bytes (CFG-02).
        /// STORED and round-tripped by the core, NEVER computed by it; `[0u8; 32]` = N/A.
        code_hash: [u8; 32],
    },
    /// Add a port to a placed machine (Phase 36). Appended at discriminant 10
    /// (byte-additive; zero corpus instances this phase). [`Port`] is fixed-size — it
    /// gains its `medium` field in the 35-03 byte-forcer and that field flows in here
    /// automatically (no shape change needed at this site). Carries no new unbounded
    /// surface. APPLIED by `fold_add_port` since Phase 36: the port is appended to the
    /// machine's rot-0 list and the footprint is resized to fit, floored to the per-kind
    /// base.
    AddPort {
        /// The machine node the port is added to (a resolved [`NodeId`]).
        node: NodeId,
        /// The resolved port to add (gains its `medium` field in 35-03).
        port: Port,
        /// The list position the port is inserted at (Phase 73, 73-03). A FIELD ON AN
        /// EXISTING VARIANT, so it is byte-forcing and one of the two halves of the
        /// `EDIT_SCHEMA_VERSION` `7 -> 8` bump.
        ///
        /// # The forward behaviour does not move, and that is load-bearing
        /// A forward `GridCommand::AddPort` is the user gesture "add an output", which
        /// always appends: `validate_normalize` resolves `index = ports.len()`, so
        /// `fold_add_port` inserts at the end exactly as its `push` did, and every
        /// existing fixture's per-tick `hashes.txt` is unchanged. Only
        /// `edit-log.postcard` grows. The wire `GridCommand::AddPort` therefore does NOT
        /// gain this field and the cmd-wire `EVENT_VERSION` does not move.
        ///
        /// # What it is FOR
        /// The inverse of a `RemovePort`. Before this field, that inverse could only
        /// emit an `AddPort` that re-appended, so undoing the removal of a middle output
        /// put it back LAST and silently renumbered every port after it - which is why
        /// UNDO-05's one-press re-dock was unreachable. Now the inverse names the index
        /// the port came out of.
        ///
        /// A forged out-of-range value is a panic-free no-op at `fold_add_port`, guarded
        /// in the shape of `fold_remove_port`'s own `idx >= ports.len()` check
        /// (T-73-03-01); it carries no allocation surface.
        index: PortId,
        /// WHERE the port is seated (plan 74.1-16). A FIELD ON AN EXISTING VARIANT, so it
        /// is byte-forcing and one of the two fields of the `EDIT_SCHEMA_VERSION`
        /// `10 -> 11` bump, the 73-03 `index` precedent for an inverse-only field.
        ///
        /// Every FORWARD gesture writes [`PortSeat::Auto`]: the port takes the first free
        /// slot of its role. What the field is FOR is the inverse of a `RemovePort`, which
        /// writes [`PortSeat::Captured`] so the removed port comes back on its OWN slot
        /// (read off the captured `port.local_offset`) rather than the first free one.
        /// Without it, undoing two removals in turn would put the second-removed output
        /// back on the first one's row. One byte on the wire, no allocation surface.
        seat: PortSeat,
    },
    /// Remove a port from a placed machine by index (Phase 36). Appended at discriminant
    /// 11 (byte-additive; zero corpus instances this phase). Carries only fixed-size
    /// scalars → NO new `upcast` allocation surface. APPLIED by `fold_remove_port`: since
    /// plan 74.1-16 the port at `index` is removed and NOTHING ELSE MOVES (every other
    /// port keeps its slot and the footprint and anchor stay), unless the record carries
    /// a `restore`.
    RemovePort {
        /// The machine node the port is removed from (a resolved [`NodeId`]).
        node: NodeId,
        /// The index of the port to remove.
        index: PortId,
        /// The box and anchor to put back (plan 74.1-16). A FIELD ON AN EXISTING
        /// VARIANT, so it is byte-forcing and the second field of the
        /// `EDIT_SCHEMA_VERSION` `10 -> 11` bump.
        ///
        /// Every FORWARD removal writes `None`: a removal never shrinks the machine. What
        /// the field is FOR is the inverse of an `AddPort` that grew the box, which writes
        /// `Some` carrying the pre-add box and anchor, so one Ctrl+Z shrinks the box and,
        /// on a turned machine, moves the anchor back. A forged box is bounded at decode
        /// (`upcast` refuses a dimension outside `[1, MAX_FOOTPRINT_DIM]` or an anchor
        /// outside the grid extent) and clamped again by `remove_port_geometry`.
        restore: Option<BoxRestore>,
    },
    /// The history seal (Phase 85, plan 85-05, D-10, DEMO-05). Fieldless, appended after
    /// `RemovePort` at discriminant 12, inside the EDIT 12 shape the Email removal bumped
    /// to, so no log written between the two carries an undeclared shape.
    ///
    /// Written ONCE by the host after a scene is seeded. It FOLDS TO NOTHING in the core:
    /// the snapshot before and after folding it is byte-identical. Its only reader is the
    /// command layer's history projection, which takes it as the floor below which Undo
    /// does not reach (plan 85-06 sets that floor), so a freshly loaded demo or example
    /// opens with nothing to undo. It is never itself an undoable action, and it carries
    /// nothing a forged log could use: no field, no allocation, bounded by the existing
    /// edit-log size and record limits (threat T-85-12, accepted).
    SealHistory,
}

/// The COMPLETE CFG-01 machine-configuration surface an [`EditOp::Configure`] carries
/// (Phase 39) — **plain ordered serde data** (CORE-09). APPLIED by `fold_configure`
/// since Phase 39. Shaped for the ENTIRE CFG-01 authoring surface in the 35-02 re-bless
/// so Phase 39 needed NO second serialized shape (RESEARCH §Q5 / Pitfall 5): a
/// variant/field append under postcard is a clean-break bump, which is also why the two
/// Phase-63 appends below sit at the END and move no stored byte.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// postcard encodes an enum by its variant **discriminant** (declaration index). New
/// variants are **appended after** the existing ones so prior discriminants never
/// shift. Zero corpus instances exist this phase (no `Configure` record is stored yet),
/// so this whole shape is additive.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum MachineConfig {
    /// A Factory machine's authored JS (CFG-02) — the EXACT user source bytes the
    /// sandbox runs, stored verbatim with NO reformatting/normalization. Discriminant
    /// 0. This `String` is the ONLY new unbounded-allocation surface this plan adds; it
    /// is bounded reject-only by [`MAX_CONFIG_BYTES`] at the [`upcast`] decode boundary.
    Factory {
        /// The EXACT authored JS source bytes (CFG-02 — no reformatting).
        source: String,
    },
    /// A Source machine's trigger configuration (CFG-01 webhook/timer). Discriminant 1.
    Source {
        /// How the source fires (webhook or timer).
        trigger: SourceTrigger,
    },
    /// A Sink machine's effect target (CFG-01). Discriminant 2. Reuses the runtime
    /// [`SinkTemplate`](crate::state::SinkTemplate) so the sink config surface is the
    /// single source of truth. NOTE: `SinkTemplate`'s HTTP `method` field is threaded in
    /// plan 35-03 (the byte-forcing re-bless), so the COMPLETE CFG-01 "HTTP + method"
    /// Sink surface is only final after 35-03 — this variant flows that field in
    /// automatically once it lands (no shape change needed at this site).
    Sink {
        /// The effect target this sink stamps onto each item (reuses `SinkTemplate`).
        target: SinkTemplate,
    },
    /// A belt's own advance interval in sim TICKS per slot (BELT-02, Phase 68's
    /// per-belt speed control). **Discriminant 3** — appended AFTER `Sink`, which is
    /// what makes it byte-safe: postcard encodes an enum by declaration index, so an
    /// append at the end leaves `Factory = 0` / `Source = 1` / `Sink = 2` and every
    /// byte already stored under them exactly where they were.
    ///
    /// Mirrors the field [`Belt::ticks_per_slot`](crate::state::Belt::ticks_per_slot)
    /// the belt already carries, so applying it is a one-field write and NO new state
    /// shape appears.
    ///
    /// # Allocation surface: none
    /// Stated in the affirmative, the way [`SourceTrigger::Webhook`] states it is
    /// fieldless: this variant carries a single `NonZeroU32` and adds NO new unbounded
    /// surface at the [`upcast`] decode boundary. There is nothing here for a cap to
    /// bound.
    ///
    /// The BELT-04 speed RANGE is deliberately NOT encoded in this shape — it is a
    /// `fabrico-command` validation, so a later phase can move the bound without
    /// touching this frozen crate. `NonZeroU32` carries the only invariant that belongs
    /// in the type: it keeps the modulo in `Belt::step` structurally panic-free, and a
    /// wire-side zero is a typed `fabrico-command` refusal rather than an invented
    /// speed.
    ///
    /// Nothing in Phase 63 emits this variant. It lands here because `fabrico-core`
    /// closes at that phase's exit and BELT-02 requires belt-speed edits to be certified
    /// `Configure` records — so an unused variant found in Phase 64 is NOT dead code to
    /// delete.
    Belt {
        /// Sim ticks between one slot advance for the target belt (larger is slower).
        ticks_per_slot: NonZeroU32,
    },
    /// A router's ordered routing table and its default ("else") output port (ROUTE-03,
    /// Phase 65's routing-rule editor). **Discriminant 4** — appended after `Belt`, and
    /// byte-safe for the same reason stated there.
    ///
    /// Reuses the runtime [`RouteKey`] and [`PortId`] rather than mirroring them, both
    /// imported straight from the runtime modules. That is the precedent
    /// [`MachineConfig::Sink`] set by reusing [`SinkTemplate`]: the config surface and
    /// the runtime shape are ONE source of truth, so they cannot drift apart.
    ///
    /// # Allocation surface: the SECOND unbounded one in this enum
    /// after the Factory JS source. `routes` is a `Vec` whose every element holds a
    /// `RouteKey.expect: Vec<u8>` — a Vec of Vecs, so a forged record can carry millions
    /// of routes OR one multi-gigabyte pattern. Both dimensions are bounded reject-only
    /// by [`MAX_ROUTES`] and [`MAX_ROUTE_EXPECT_BYTES`] at the [`upcast`] decode
    /// boundary, and by those SAME two constants at the reachable
    /// `fabrico_host::project::load_project` boundary — exactly as `Factory`'s `source`
    /// points at [`MAX_CONFIG_BYTES`].
    ///
    /// [`Router::faults`](crate::state::Router::faults) is deliberately ABSENT here: it
    /// is a snapshot-captured debug counter, not configuration. `fold_configure` writes
    /// these two fields INDIVIDUALLY so that reconfiguring a router never zeroes its
    /// counter.
    ///
    /// Nothing in Phase 63 emits this variant either; it lands here for ROUTE-03 under
    /// the same frozen-crate deadline as `Belt`.
    Router {
        /// The ordered match table; the FIRST matching route wins. Applied VERBATIM —
        /// no sort, no dedup — so the order the user authored is the order the router
        /// applies. An EMPTY table with `default: None` is legal and means every item
        /// goes to the reserved fault port, which is the existing
        /// [`Router`](crate::state::Router) no-match semantics rather than a new
        /// behaviour.
        routes: Vec<(RouteKey, PortId)>,
        /// The default ("else") output port; `None` routes a no-match to the reserved
        /// fault port.
        default: Option<PortId>,
    },
    /// A Route's URL path (SERVE-08, Phase 72's addressable endpoint). **Discriminant
    /// 5** — appended AFTER `Router` (4), STRICTLY LAST.
    ///
    /// # The position is the whole byte argument, so check it rather than trust it
    /// The rule is stated verbatim at `Belt`'s discriminant note above and it applies
    /// unchanged: postcard encodes an enum by DECLARATION INDEX, so an append at the end
    /// leaves `Factory = 0` / `Source = 1` / `Sink = 2` / `Belt = 3` / `Router = 4` and
    /// every byte already stored under them exactly where it was, while an INSERTION
    /// anywhere before this point moves every byte after it. `EDIT_SCHEMA_VERSION`
    /// staying at 7 (D-21) is correct ONLY because this is strictly last.
    ///
    /// That is not left as prose. `crates/fabrico-core/tests/route_path.rs`'s
    /// `the_config_variant_appends_strictly_last` pins a `Router` value's encoding
    /// against the literal bytes measured before this variant existed, and
    /// `crates/fabrico-command/tests/machine_config_parity.rs` holds this enum and its
    /// `fabrico_protocol` wire mirror at the same discriminant.
    ///
    /// Mirrors the field [`Endpoint::path`](crate::state::Endpoint::path) the Route
    /// already carries as of this same commit, so applying it is a one-field write and
    /// NO new state shape appears at the fold.
    ///
    /// # Allocation surface: the THIRD unbounded one in this enum
    /// after the Factory JS source and the router table. It is bounded reject-only by
    /// [`MAX_ENDPOINT_PATH_BYTES`] at the `fabrico-command` `Configure` validate gate
    /// AND, because the field is SERIALIZED ON THE NODE, at
    /// [`crate::snapshot::restore`]'s trust gate. Both read that ONE constant.
    ///
    /// # The variant is named `Endpoint`, not `Route`
    /// D-09 scopes the Phase-72 rename to the USER-FACING surface and records that the
    /// kind byte and the serialized shape do not change with the rename itself. The
    /// node variant is [`crate::state::Node::Endpoint`], so this name matches the shape
    /// it configures. `72-RESEARCH.md` section 3.2 writes `MachineConfig::Route` and
    /// that is a slip, recorded here so it is not inherited.
    Endpoint {
        /// The URL path this Route answers at, INCLUDING its leading `/`. Validated at
        /// the command layer by [`endpoint_path_is_valid`] plus the board-wide
        /// duplicate check; applied VERBATIM by the fold, which never re-validates.
        path: String,
    },
    /// A label's words, colour and size (Phase 76, plan 76-02, SHAPE-10, D-02, D-04).
    /// **Discriminant 6** - appended AFTER `Endpoint` (5), STRICTLY LAST.
    ///
    /// # The position is the whole byte argument, so check it rather than trust it
    /// postcard encodes an enum by DECLARATION INDEX, so an append at the end leaves
    /// `Factory = 0` through `Endpoint = 5` and every byte already stored under them
    /// exactly where it was, while an INSERTION anywhere before this point moves every
    /// byte after it. `EDIT_SCHEMA_VERSION` staying at 11 is correct ONLY because this is
    /// strictly last and no field of an existing variant grows (the `Endpoint` append
    /// precedent). Pinned, not left as prose: `crates/fabrico-core/tests/route_path.rs`'s
    /// `the_label_config_appends_after_endpoint` pins `Endpoint`'s bytes and this
    /// variant's leading byte, and `crates/fabrico-command/tests/machine_config_parity.rs`
    /// holds this enum and its `fabrico_protocol` wire mirror at the same discriminant.
    ///
    /// # One Configure carries all four, so one Apply is one undo step (D-04)
    /// Text, colour, width and depth travel together. The SIZE rides here and lands in
    /// the existing `footprints` map through the shipped port-geometry writer (anchor
    /// unchanged, rot 0, no ports), NEVER in a new field: a new `GridState` field would
    /// byte-force the snapshot schema and move every golden. The words and the colour
    /// land on [`Node::Label`](crate::state::Node::Label)'s existing fields, so applying
    /// this is a plain-data write and no new state shape appears at the fold.
    ///
    /// # Bounds: what is checked where
    /// `text` is bounded by [`MAX_LABEL_BYTES`] at the `fabrico-command` `Configure`
    /// write gate (and at the load gates from plan 76-04). `w` and `h` are bounded at the
    /// write gate by the label panel's caps, a WRITE-side UI policy (the `PaceOutOfRange`
    /// lesson), and the FOLD clamps them to `1..=MAX_FOOTPRINT_DIM` whatever a record
    /// carries, so a forged record is never an occupancy bomb. `colour` is the closed
    /// [`LabelColour`] set: a byte past the last colour fails to decode.
    Label {
        /// The words on the label, verbatim (no trimming, no normalization).
        text: String,
        /// The box tint, one of the closed six.
        colour: LabelColour,
        /// Width in cells, rot-0 frame (the label grows right from its anchor).
        w: u16,
        /// Depth in cells, rot-0 frame (the label grows down from its anchor).
        h: u16,
    },
}

/// How a Source machine fires (CFG-01) — **plain ordered serde data** (CORE-09).
/// Carried by [`MachineConfig::Source`]. The CORE never acts on it and that is not a
/// pending phase: a Source's trigger is host-side by the Phase-39 decision, so
/// `fold_configure`'s `Source` arm writes zero GridState bytes on purpose.
///
/// # Wire-format discipline (variant ordering is LOAD-BEARING)
/// New variants are **appended after** the existing ones so prior discriminants never
/// shift. Zero corpus instances this phase.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SourceTrigger {
    /// Fire on an inbound webhook (CFG-01). Discriminant 0, fieldless.
    Webhook,
    /// Fire every `interval_ticks` on a deterministic logical timer (CFG-01).
    /// Discriminant 1.
    Timer {
        /// The fixed logical-tick interval between fires.
        interval_ticks: u64,
    },
}

/// The ONE edit-log version predicate: `Ok(())` for exactly [`EDIT_SCHEMA_VERSION`],
/// [`DecodeError::UnknownVersion`](crate::event::DecodeError::UnknownVersion) for every
/// other value, forward AND backward.
///
/// # The clean break, and who authorised it
/// This was authorised on 2026-08-18 because the system is not in production use, so no
/// migration shim is owed, and this replaces the forward-only refusal (`version >
/// EDIT_SCHEMA_VERSION`) that shipped from v1 through v6. Every edit log written before
/// milestone v8.0 is now refused with a typed error rather than decoded positionally
/// against a layout it was not written for.
///
/// The deliberate consequence, stated rather than discovered later: a `.fab` project file
/// saved before this milestone no longer loads. That is the trade the project took.
///
/// # Why this is a function and not a fourth inline comparison
/// Three copies of this comparison existed, and only TWO of them were ever reached by a
/// real caller. [`upcast`] is documented as the decode boundary and carries every
/// allocation-bomb guard, but a grep for its call sites across `crates/` returns nothing
/// outside its own `#[cfg(test)]` module. The reachable boundaries are
/// `fabrico_host::driver::Host::logged_edits` (the redb edit-log store) and
/// `fabrico_host::project::load_project` (a `.fab` file on disk), each of which
/// re-implemented the predicate independently.
///
/// So a bump applied to [`upcast`] alone would have been invisible to every user-reachable
/// path while reading like the boundary had been closed. One exported function is what
/// makes a future bump land in one place instead of two out of three. The three callers
/// keep their own typed error families - a `StoreError`, a `ProjectError` and a
/// `DecodeError` say different things to different callers - and map this one answer into
/// them.
pub fn check_version(version: u16) -> Result<(), DecodeError> {
    if version != EDIT_SCHEMA_VERSION {
        return Err(DecodeError::UnknownVersion(version));
    }
    Ok(())
}

/// Whether a record's PORT EDIT lies inside the envelope a command can write (plan
/// 74.1-23, review WR-02 of round 3). `true` for every other op.
///
/// - An `AddPort` with [`PortSeat::Captured`] is seated VERBATIM on the slot read off its
///   own `local_offset` ([`port_slot`](crate::state::port_slot)) by `fold_add_port`
///   (decision Q2). Only the inverse of a removal writes one, carrying a slot the machine
///   really held, so the slot must lie in `[0, MAX_FOOTPRINT_DIM)`. A slot outside it is
///   a port no box the snapshot gate accepts can hold. An [`PortSeat::Auto`] seat ignores
///   the offset (the fold picks the first free slot), so it has nothing to bound.
/// - A `RemovePort.restore` box (T-74.1-61, plan 74.1-16; moved here from `upcast` by
///   74.1-23): `remove_port_geometry` clamps its dimensions to `[1, MAX_FOOTPRINT_DIM]`, so
///   it is no allocation bomb, but a dimension outside that envelope or an anchor outside
///   `[GRID_MIN, GRID_MAX]` is a record no command writes and a state the snapshot gate
///   would refuse.
///
/// # ONE predicate, THREE callers
/// [`upcast`] (as `Malformed`), `fabrico_host::driver::Host::logged_edits` (the redb
/// store, as a `StoreError::Backend` naming the record) and
/// `fabrico_host::project::load_project` (a `.fab` file, as a typed `ProjectError`). The
/// 74.1-16 restore guard lived in `upcast` alone, and `upcast` has no production caller,
/// so it guarded nothing a user could reach; one function is what makes the two real
/// boundaries refuse what the reference one refuses.
///
/// # What this predicate cannot see
/// A `restore: Some` box INSIDE the envelope can still be too small for the ports that
/// SURVIVE the removal (every survivor keeps its slot on the restored box's edge, so a
/// one-row box leaves a row-2 Out outside it). Judging that needs the node's port list,
/// which a decode boundary does not have. It is refused at REPLAY instead: the replayed
/// core must pass the snapshot trust gate before any session is installed
/// (`fabrico_host::driver::Host::recover`, pinned by `class_edit_replay_state_invalid` in
/// `crates/fabrico-host/tests/fuzz_two_log.rs`).
#[must_use]
pub fn port_edit_in_envelope(op: &EditOp) -> bool {
    match op {
        EditOp::AddPort { port, seat: PortSeat::Captured, .. } => {
            (0..i32::from(MAX_FOOTPRINT_DIM)).contains(&crate::state::port_slot(port))
        }
        EditOp::RemovePort { restore: Some(r), .. } => {
            (1..=MAX_FOOTPRINT_DIM).contains(&r.w)
                && (1..=MAX_FOOTPRINT_DIM).contains(&r.h)
                && (GRID_MIN..=GRID_MAX).contains(&r.anchor_x)
                && (GRID_MIN..=GRID_MAX).contains(&r.anchor_y)
        }
        _ => true,
    }
}

/// Decode an [`EditRecord`] from untrusted bytes, keyed off its declared
/// `version`.
///
/// Mirrors [`crate::event::upcast`]: refuses any `version` that is not exactly
/// [`EDIT_SCHEMA_VERSION`] via [`check_version`], with
/// [`DecodeError::UnknownVersion`](crate::event::DecodeError::UnknownVersion)
/// *before* touching the bytes, and returns
/// [`DecodeError::Malformed`](crate::event::DecodeError::Malformed) (never
/// panics) if the bytes fail to decode.
///
/// NOTE for anyone auditing the trust boundary: this function has no production
/// callers. It is the reference implementation of the decode guards and is exercised
/// only by its own tests. The reachable edit-log boundaries are
/// `fabrico_host::driver::Host::logged_edits` and
/// `fabrico_host::project::load_project`, which share this version predicate but
/// re-implement the allocation-bomb guards below in their own typed error families.
///
/// Reuses the runtime log's [`DecodeError`] — the edit-log shares the exact same
/// untrusted-bytes failure taxonomy (RESEARCH "Don't Hand-Roll").
pub fn upcast(bytes: &[u8], version: u16) -> Result<EditRecord, DecodeError> {
    check_version(version)?;
    let record = postcard::from_bytes::<EditRecord>(bytes).map_err(|_| DecodeError::Malformed)?;
    // CR-01: a forged `Place` with out-of-envelope footprint dims would be applied
    // VERBATIM by `fold_place`/`claim_footprint` on replay (decision Q2 — no fold-time
    // re-validation), expanding `w*h` cells into `occupancy` with no cap. A
    // `w = h = u16::MAX` record is a ~4.3-billion-cell allocation bomb. Refuse it at
    // this untrusted-bytes decode boundary as `Malformed`, mirroring the snapshot
    // gate's `FootprintTooLarge`. `1 <= w,h <= MAX_FOOTPRINT_DIM` is the documented
    // overflow-safety envelope; a 1×1 point machine (`w = h = 1`) always passes.
    if let EditOp::Place {
        cell_x,
        cell_y,
        w,
        h,
        ports,
        rot,
        ..
    } = &record.op
    {
        // (a-CR-01) dim envelope — the allocation-bomb guard.
        if *w == 0 || *h == 0 || *w > MAX_FOOTPRINT_DIM || *h > MAX_FOOTPRINT_DIM {
            return Err(DecodeError::Malformed);
        }
        // (d, plan 86-02) the rotation is a quarter-turn count, `0..=3`. A larger value
        //   names no orientation, and a footprint holding one is a state the snapshot gate
        //   refuses as `FootprintBadRot`; refuse it here rather than fold it.
        if *rot > 3 {
            return Err(DecodeError::Malformed);
        }
        // (b-WR-01) anchor extent — mirror the snapshot gate's `[GRID_MIN, GRID_MAX]`
        //   bound so this untrusted edit-log decode point cannot mint an out-of-extent
        //   (non-round-tripping) record the snapshot gate would later reject as
        //   `CellOutOfBounds`. Symmetric with `load_project`'s per-record loop.
        if !(GRID_MIN..=GRID_MAX).contains(cell_x) || !(GRID_MIN..=GRID_MAX).contains(cell_y) {
            return Err(DecodeError::Malformed);
        }
        // (c-WR-02) port-in-footprint — mirror the snapshot gate's `PortOutOfFootprint`:
        //   every rot-0 `local_offset` must lie in `[0,w)×[0,h)`, else a verbatim
        //   `fold_place`→`set_ports` would install a port the gate rejects on restore.
        let (wi, hi) = (i32::from(*w), i32::from(*h));
        if ports
            .iter()
            .any(|p| p.local_offset.0 < 0 || p.local_offset.1 < 0 || p.local_offset.0 >= wi || p.local_offset.1 >= hi)
        {
            return Err(DecodeError::Malformed);
        }
    }
    // T-11-DRAWBELT-BOMB / T-11-TILE-EXTENT (Phase 11, RESEARCH Pitfall 3): a forged
    // `DrawBelt` is applied VERBATIM by `fold_draw_belt` on replay (no fold-time
    // re-validation, Q2), minting `SLOTS_PER_TILE * tiles` slots (at most
    // `1024 * 4 = 4096` under the cap, per the `MAX_BELT_TILES` overflow-safety note
    // above) + claiming every tile cell.
    // Refuse an empty or over-cap tile list (the allocation bomb, mirror
    // the footprint dim guard) and any tile cell outside `[GRID_MIN, GRID_MAX]` (the
    // non-round-tripping extent guard, mirror the anchor bound above) as `Malformed`.
    if let EditOp::DrawBelt { tiles } = &record.op {
        if tiles.is_empty() || tiles.len() > MAX_BELT_TILES as usize {
            return Err(DecodeError::Malformed);
        }
        if tiles.iter().any(|t| {
            !(GRID_MIN..=GRID_MAX).contains(&t.cell.0) || !(GRID_MIN..=GRID_MAX).contains(&t.cell.1)
        }) {
            return Err(DecodeError::Malformed);
        }
    }
    // T-74.1-61 / plan 74.1-23: the port-edit envelope (a captured seat's slot, a
    // restore box), ONE predicate shared with the two boundaries a real caller reaches.
    if !port_edit_in_envelope(&record.op) {
        return Err(DecodeError::Malformed);
    }
    // T-12-03 (Phase 12, 12-02; extended by 63-06 to the captured WIRE list): the
    // extended `EditOp::Delete.captured` is the only
    // NEW unbounded allocation surface this bump adds. A forged delete carrying
    // millions of captured ports / cascade belts / belt-geometry tiles / links / cascade
    // wires / per-wire incident links would
    // be decoded into a foldable record — and even though `fold_delete` IGNORES
    // `captured`, the decode itself allocates those Vecs (the allocation bomb). Bound
    // every captured Vec to `MAX_BELT_TILES` and every captured cell (belt-geometry
    // tile cells AND port `local_offset`s) to `[GRID_MIN, GRID_MAX]` — mirror the
    // `DrawBelt` tile cap + the `Place` anchor/extent guard — returning `Malformed`,
    // never a panic/OOM. (`fold_delete` not consuming `captured` is also exactly why
    // the re-bless stays hash-identical, 12-RESEARCH Pitfall 4.)
    if let EditOp::Delete { captured, .. } = &record.op {
        let cap = MAX_BELT_TILES as usize;
        // (plan 86-02) the captured rotation is replayed by the Delete inverse's re-Place,
        // so it carries the same `0..=3` bound the `Place` arm above refuses on.
        if captured.rot > 3 {
            return Err(DecodeError::Malformed);
        }
        // (a) the captured footprint-port list, the cascade belt list and (63-06) the
        //     cascade WIRE list - the top-level Vec surfaces - are each bounded to
        //     MAX_BELT_TILES.
        if captured.ports.len() > cap || captured.belts.len() > cap || captured.wires.len() > cap {
            return Err(DecodeError::Malformed);
        }
        // (b) each cascade belt's own geometry + incident-link Vecs, and (63-06) each
        //     cascade wire's own incident-link Vec, are independently bounded (a single
        //     forged belt or wire could carry a huge list under a short outer list).
        if captured
            .belts
            .iter()
            .any(|b| b.geometry.len() > cap || b.links.len() > cap)
        {
            return Err(DecodeError::Malformed);
        }
        if captured.wires.iter().any(|w| w.links.len() > cap) {
            return Err(DecodeError::Malformed);
        }
        // (c) every captured cell — each port `local_offset` AND each belt-geometry
        //     tile cell — must lie in `[GRID_MIN, GRID_MAX]` (the non-round-tripping
        //     extent guard, mirror the DrawBelt per-tile / Place anchor bound).
        let in_extent = |c: i32| (GRID_MIN..=GRID_MAX).contains(&c);
        if captured
            .ports
            .iter()
            .any(|p| !in_extent(p.local_offset.0) || !in_extent(p.local_offset.1))
        {
            return Err(DecodeError::Malformed);
        }
        if captured
            .belts
            .iter()
            .any(|b| b.geometry.iter().any(|t| !in_extent(t.cell.0) || !in_extent(t.cell.1)))
        {
            return Err(DecodeError::Malformed);
        }
        // T-73-03-02 (Phase 73, 73-03): `captured.self_record` is an `Option` over the
        // SAME two already-bounded types, but an `Option` inherits nothing on its own -
        // the checks above walk `captured.belts` and `captured.wires` and never look
        // inside this field. A forged `Delete` carrying a `self_record` with millions of
        // geometry tiles or incident links would decode unbounded through a gap the outer
        // guards LOOK like they cover. Reach into it explicitly, with the identical
        // `MAX_BELT_TILES` cap and the identical `[GRID_MIN, GRID_MAX]` extent bound, so
        // the bare-node capture surface is bounded by construction and not by adjacency.
        match &captured.self_record {
            Some(DeletedSelf::Belt(b)) => {
                if b.geometry.len() > cap || b.links.len() > cap {
                    return Err(DecodeError::Malformed);
                }
                if b
                    .geometry
                    .iter()
                    .any(|t| !in_extent(t.cell.0) || !in_extent(t.cell.1))
                {
                    return Err(DecodeError::Malformed);
                }
            }
            Some(DeletedSelf::Wire(w)) if w.links.len() > cap => {
                return Err(DecodeError::Malformed);
            }
            Some(DeletedSelf::Wire(_)) => {}
            None => {}
        }
    }
    // T-35-04-CONFIGBOMB (Phase 35, RESEARCH §Q5): the `EditOp::Configure` Factory JS
    // `String` is the ONLY new unbounded-allocation surface the v6.0 additive appends
    // introduce. A forged `Configure` carrying a multi-GiB `source` would be decoded
    // into a foldable record (even though `apply_edit` folds `Configure` to a NOOP this
    // phase, the decode itself allocates the whole `String` — the allocation bomb).
    // Refuse an over-cap Factory source as `Malformed`, pre-fold, mirroring the
    // `DrawBelt`/`Delete.captured` `MAX_*` caps above. Precisely: this guard runs
    // POST-decode - `postcard::from_bytes` above has already materialized the `String`,
    // so the cap rejects an over-policy record that is already resident, it does NOT
    // prevent the allocation. That is bounded and safe because postcard only reads bytes
    // actually present in the input slice (a short blob with a huge length prefix errors
    // as `Malformed` WITHOUT allocating), and every real caller bounds the input slice up
    // front (`persist` MAX_RECORD_BYTES, `load_project` MAX_PROJECT_BYTES). Only the
    // `Factory` variant carries an unbounded surface; `Source`/`Sink` are bounded shapes.
    if let EditOp::Configure {
        config: MachineConfig::Factory { source },
        ..
    } = &record.op
        && source.len() > MAX_CONFIG_BYTES
    {
        return Err(DecodeError::Malformed);
    }
    // T-63-01 (Phase 63): `MachineConfig::Router`'s route table is the SECOND unbounded
    // allocation surface in this enum, after the Factory JS source guarded just above.
    // `fold_configure` writes `routes` VERBATIM — no sort, no dedup, no re-validation
    // (Q2) — so a forged `Configure` carrying millions of routes, or one route whose
    // `expect` pattern is multi-gigabyte, becomes a live `Router` that the per-item
    // first-match walk then traverses. Refuse an over-cap table LENGTH or an over-cap
    // single PATTERN as `Malformed`; the two dimensions are bounded independently
    // because either one alone is the same denial of service.
    // Precisely, and for the same reason the Factory guard above states: this runs
    // POST-decode — `postcard::from_bytes` has ALREADY materialized both Vecs, so the
    // cap rejects an over-policy record that is already resident and does NOT prevent
    // the allocation. That is bounded and safe because postcard only reads bytes
    // actually present in the input slice (a short blob with a huge length prefix errors
    // as `Malformed` WITHOUT allocating), and every real caller bounds the input slice
    // up front (`persist` MAX_RECORD_BYTES, `load_project` MAX_PROJECT_BYTES).
    // `fabrico_host`'s `load_project` applies the SAME two constants with its own typed
    // `ProjectError`: the bound has ONE home even though the refusal has two shapes.
    if let EditOp::Configure {
        config: MachineConfig::Router { routes, .. },
        ..
    } = &record.op
    {
        if routes.len() > MAX_ROUTES {
            return Err(DecodeError::Malformed);
        }
        if routes
            .iter()
            .any(|(key, _)| key.expect.len() > MAX_ROUTE_EXPECT_BYTES)
        {
            return Err(DecodeError::Malformed);
        }
    }
    // T-72-07-01 (Phase 72, SERVE-08): `MachineConfig::Endpoint`'s `path` is the THIRD
    // unbounded allocation surface in this enum, and it is the first that lands on a
    // SERIALIZED NODE FIELD - so unlike the two above, an over-cap value that got past
    // here would be carried in every later snapshot of that board. `fold_configure`
    // writes it VERBATIM (Q2, no fold-time re-validation), so this is the decode-side
    // half of the same bound `fabrico-command`'s validate arm applies on the write side
    // and `snapshot::restore` applies on the load side. All three read
    // MAX_ENDPOINT_PATH_BYTES; none of them restates the number.
    //
    // LENGTH ONLY here, deliberately. The character rule (`endpoint_path_is_valid`) is a
    // WRITE-side policy: applying it at this decode boundary would let a later widening
    // of the allowed alphabet make an already-saved board unloadable, which is the
    // load-side-policy trap `PaceOutOfRange`'s docblock spells out for belt pace. A
    // LENGTH bound is different in kind: it is the allocation guard, and it is the one
    // rule a forged record can weaponize.
    if let EditOp::Configure {
        config: MachineConfig::Endpoint { path },
        ..
    } = &record.op
        && path.len() > MAX_ENDPOINT_PATH_BYTES
    {
        return Err(DecodeError::Malformed);
    }
    // Phase 76 (plan 76-04, SHAPE-13, D-06, threats T-76-12 and T-76-13):
    // `MachineConfig::Label` carries the FOURTH user-authored length in this enum (its
    // `text`) and a size. Refused here: a text longer than MAX_LABEL_BYTES, and a width
    // or depth outside 1 to MAX_FOOTPRINT_DIM, each as `Malformed`, pre-fold.
    //
    // LENGTH AND ENVELOPE ONLY. No content policy runs at decode, and the label panel's
    // 16 by 8 caps (`fabrico_command::LABEL_MAX_W` / `LABEL_MAX_H`) are a WRITE-side
    // policy: enforcing them here would let a later cap change make a saved board
    // unloadable (the `PaceOutOfRange` lesson). The envelope is the allocation guard the
    // fold's clamp already implies, refused rather than clamped so a forged record is
    // named.
    //
    // `upcast` is NOT on the production load path (`fabrico-host`'s `project.rs` and
    // `driver.rs` say so); `load_project`'s per-record loop is the reachable gate and
    // carries the same two checks as typed `ProjectError`s, reading the same constants.
    if let EditOp::Configure {
        config: MachineConfig::Label { text, w, h, .. },
        ..
    } = &record.op
        && (text.len() > MAX_LABEL_BYTES
            || !(1..=MAX_FOOTPRINT_DIM).contains(w)
            || !(1..=MAX_FOOTPRINT_DIM).contains(h))
    {
        return Err(DecodeError::Malformed);
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use slotmap::SlotMap;

    fn sample_record() -> EditRecord {
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            // Non-trivial scalars so the round-trip exercises every field.
            partition: 5,
            sequence: 42,
            tick: 7,
            action: 3,
            // Place a Source (machine_kind 0) at cell (3, -4), 1×1, no ports.
            op: EditOp::Place {
                kind: 0,
                cell_x: 3,
                cell_y: -4,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            },
        }
    }

    #[test]
    fn editrecord_round_trips_byte_identical() {
        let rec = sample_record();
        let bytes = postcard::to_allocvec(&rec).expect("serialize edit record");
        let restored: EditRecord = postcard::from_bytes(&bytes).expect("deserialize edit record");
        assert_eq!(rec, restored);
        // Re-encode is byte-identical.
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize edit record");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn editrecord_upcast_accepts_current_version() {
        let rec = sample_record();
        let bytes = postcard::to_allocvec(&rec).expect("serialize edit record");
        let decoded = upcast(&bytes, EDIT_SCHEMA_VERSION).expect("current version decodes");
        assert_eq!(decoded, rec);
    }

    #[test]
    fn editrecord_upcast_refuses_forward_version_without_panic() {
        let rec = sample_record();
        let bytes = postcard::to_allocvec(&rec).expect("serialize edit record");
        // A version newer than the running code is refused with a typed error.
        let result = upcast(&bytes, EDIT_SCHEMA_VERSION + 1);
        assert_eq!(
            result,
            Err(DecodeError::UnknownVersion(EDIT_SCHEMA_VERSION + 1))
        );
    }

    #[test]
    fn editrecord_upcast_refuses_backward_version_without_panic() {
        // v8.0 CLEAN BREAK (Phase 63, plan 63-11). Before this phase the predicate was
        // `version > EDIT_SCHEMA_VERSION`, so a record declaring an OLDER version was
        // waved through and decoded positionally against today's layout. The
        // exact-match refusal was authorised on 2026-08-18 on the grounds that the
        // system is not in production use, so no migration shim is owed.
        //
        // The bytes here are a CURRENT, well-formed record. That is the point: the
        // refusal must come from the declared version alone, BEFORE the bytes are
        // touched, so it cannot be confused with a positional decode failure.
        let rec = sample_record();
        let bytes = postcard::to_allocvec(&rec).expect("serialize edit record");
        let stale = EDIT_SCHEMA_VERSION - 1;
        let result = upcast(&bytes, stale);
        assert_eq!(
            result,
            Err(DecodeError::UnknownVersion(stale)),
            "a record declaring an older schema version must be refused as \
             UnknownVersion, never decoded"
        );
    }

    #[test]
    fn check_version_accepts_only_the_running_version() {
        // The ONE version predicate, asserted directly rather than through the three
        // callers. `upcast`, `Host::logged_edits` and `load_project` all delegate here,
        // so this is where "exact match, both directions" is decided.
        assert_eq!(check_version(EDIT_SCHEMA_VERSION), Ok(()));
        assert_eq!(
            check_version(EDIT_SCHEMA_VERSION + 1),
            Err(DecodeError::UnknownVersion(EDIT_SCHEMA_VERSION + 1))
        );
        assert_eq!(
            check_version(EDIT_SCHEMA_VERSION - 1),
            Err(DecodeError::UnknownVersion(EDIT_SCHEMA_VERSION - 1))
        );
        assert_eq!(check_version(0), Err(DecodeError::UnknownVersion(0)));
        assert_eq!(
            check_version(u16::MAX),
            Err(DecodeError::UnknownVersion(u16::MAX))
        );
    }

    #[test]
    fn frozen_v4_wire_editrecord_is_refused_under_v5() {
        // DET-03 / clean break (17-02): a REAL, frozen v4-era `EditRecord` whose op
        // carried the OLD `Wire` discriminant (index 1) must be REFUSED as a typed
        // DecodeError under the v5 schema — never silently mis-decoded into the shifted
        // `Delete` variant that now occupies disc 1, never a panic.
        //
        // The literal below was captured ONCE from a pre-removal encode of:
        //   EditRecord { schema_version: 4, partition: 0, sequence: 1, tick: 2,
        //                action: 3, op: EditOp::Wire { from, from_port: 0, to,
        //                to_port: 0 } }  (two distinct slotmap NodeIds).
        // It is HARD-CODED (not `EDIT_SCHEMA_VERSION - 1` arithmetic) so it will NOT
        // drift on the next schema bump — it is a genuine stale-bytes witness.
        const FROZEN_V4_WIRE: &[u8] =
            &[0x04, 0x00, 0x01, 0x02, 0x03, 0x01, 0x01, 0x01, 0x00, 0x02, 0x01, 0x00];

        // Decoding the stale record under the running v5 schema is a typed refusal:
        // the old Wire payload positionally mis-aligns against the shifted `Delete`
        // layout, so postcard fails and `upcast` returns `Malformed` (never a panic,
        // never a shifted-variant mis-decode).
        let result = upcast(FROZEN_V4_WIRE, EDIT_SCHEMA_VERSION);
        assert!(
            matches!(
                result,
                Err(DecodeError::Malformed) | Err(DecodeError::UnknownVersion(_))
            ),
            "a frozen v4 Wire-bearing EditRecord must be refused as a typed error under \
             v5, got {result:?}"
        );

        // And it must NEVER round-trip into a live `Wire`-shaped record: whatever the
        // bytes decode to (if anything), it can never reconstruct the removed op.
        if let Ok(rec) = &result {
            assert!(
                !matches!(rec.op, EditOp::Delete { .. }) || rec.schema_version != 4,
                "a stale v4 Wire record must not silently masquerade as a valid v5 op"
            );
        }
    }

    #[test]
    fn frozen_v6_wire_editrecord_is_refused_under_v7() {
        // v8.0 CLEAN BREAK (Phase 63, plan 63-11): a REAL, frozen v6-era `EditRecord`
        // is refused as `UnknownVersion` under v7. Unlike the v4 witness above, the
        // BODY of this record is byte-identical to a v7 one - no field moved between 6
        // and 7. That is precisely why the version predicate has to do the work: there
        // is no positional mis-alignment to catch the stale record for it.
        //
        // The literal was captured ONCE from an encode of:
        //   EditRecord { schema_version: 6, partition: 5, sequence: 42, tick: 7,
        //                action: 3, op: EditOp::Place { kind: 0, cell_x: 3,
        //                cell_y: -4, w: 1, h: 1, ports: vec![] } }
        // It is HARD-CODED (not `EDIT_SCHEMA_VERSION - 1` arithmetic) so it will NOT
        // drift on the next schema bump - it is a genuine stale-bytes witness, the same
        // rule `frozen_v4_wire_editrecord_is_refused_under_v5` states about its own.
        const FROZEN_V6: &[u8] = &[
            0x06, 0x05, 0x2A, 0x07, 0x03, 0x00, 0x00, 0x06, 0x07, 0x01, 0x01, 0x00,
        ];
        assert_eq!(
            FROZEN_V6[0], 0x06,
            "the witness must actually declare version 6 in its first varint"
        );

        // Refused BEFORE the bytes are touched. Asserted as UnknownVersion EXACTLY,
        // not `Malformed | UnknownVersion`: under exact match there is no ambiguity
        // about which arm fires, because the version is decided before the decode.
        let result = upcast(FROZEN_V6, 6);
        assert_eq!(
            result,
            Err(DecodeError::UnknownVersion(6)),
            "a frozen v6 EditRecord must be refused as UnknownVersion under v7"
        );

        // THE LIMITATION OF THIS BOUNDARY, asserted rather than left to be discovered.
        // `upcast` keys off the version its CALLER passes, not the version the record
        // carries in its own first field. Handed the running version, it decodes these
        // stale bytes happily - the body did not move - and returns a record whose
        // `schema_version` field still says 6.
        //
        // This is why SCHEMA-01's criterion could not be met by editing `upcast`: the
        // reachable boundaries (`Host::new`, `Host::logged_edits`, `load_project`) all
        // read `er.schema_version` off the record itself, which is the field an
        // attacker or a stale file actually controls. `upcast` has no production
        // callers, so nothing depends on this arm; it is pinned here so a later reader
        // does not mistake it for the trust gate.
        //
        // Since EDIT 13 (plan 86-02) a `Place` ends in a `rot` byte the v6 body lacks, so
        // the bare v6 bytes no longer decode at the running version at all. The limitation
        // is pinned on the same bytes with that one byte appended (rot 0): the body then
        // matches the running shape, and the decode still keeps the declared version 6.
        assert_eq!(
            upcast(FROZEN_V6, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed),
            "under EDIT 13 the v6 Place body is one byte short of the running shape"
        );
        let mut running_shape = FROZEN_V6.to_vec();
        running_shape.push(0x00);
        let decoded = upcast(&running_shape, EDIT_SCHEMA_VERSION)
            .expect("the v6 body plus a rot byte matches the running shape, so it decodes");
        assert_eq!(
            decoded.schema_version, 6,
            "the record's own declared version survives the decode - it is the field \
             the reachable boundaries check, and it is NOT what upcast keys off"
        );
    }

    #[test]
    fn seal_history_is_discriminant_12_and_round_trips() {
        // 85-05 (D-10): the history seal is appended AFTER `RemovePort` (11), so it takes
        // discriminant 12 and no earlier op's byte moves. Fieldless: the whole op is the
        // one discriminant byte.
        assert_eq!(
            postcard::to_allocvec(&EditOp::SealHistory).expect("serialize the seal"),
            vec![12u8],
            "SealHistory encodes as the single discriminant byte 12"
        );
        let mut rec = sample_record();
        rec.op = EditOp::SealHistory;
        let bytes = postcard::to_allocvec(&rec).expect("serialize a seal record");
        let restored = upcast(&bytes, EDIT_SCHEMA_VERSION).expect("a seal record decodes");
        assert_eq!(restored, rec, "a seal record round-trips through the decode boundary");
        assert_eq!(
            postcard::to_allocvec(&restored).expect("re-serialize"),
            bytes,
            "and re-encodes byte-identically"
        );
    }

    #[test]
    fn frozen_v11_email_configure_is_refused_under_v12() {
        // PHASE 85'S OWN RED (85-CONTEXT.md D-08, CHROME-04). A v11 `EditRecord` that
        // configures a Sink to the removed Email target must be refused by its version,
        // never decoded as an Http sink. FALSE until `EDIT_SCHEMA_VERSION` reads 12.
        // Still refused under 13 (plan 86-02): the exact-match gate refuses every version
        // but the running one, so the assertions below hold unchanged.
        //
        // PROVENANCE. Captured ONCE at a pre-release commit (plan 85-05's start revision,
        // EDIT 11) from a postcard encode of:
        //   EditRecord { schema_version: 11, partition: 0, sequence: 1, tick: 2, action: 3,
        //                op: EditOp::Configure { node: <a slotmap NodeId>,
        //                config: MachineConfig::Sink { target: SinkTemplate::Email {
        //                to: "a@b.c", subject: "x" } }, code_hash: [0; 32] } }
        // Byte 8 is `MachineConfig::Sink` (2) and byte 9 the v11 SinkTemplate
        // discriminant, 1 (Email). Hard-coded, never regenerated.
        //
        // WHY THE VERSION IS THE ONLY THING THAT CAN REFUSE IT. Read positionally against
        // the v12 enum, byte 9 names `Http`, the string "a@b.c" becomes its url, the
        // length byte of "x" (1) becomes `HttpMethod::Post`, and the rest fills
        // `code_hash` with one byte to spare, which postcard ignores. The body decodes.
        // So the refusal is asserted where every reachable boundary
        // (`Host::logged_edits`, `load_project`) takes it: on the record's OWN declared
        // version, through `check_version`. `upcast` keys off its caller's version
        // argument, a limitation `frozen_v6_wire_editrecord_is_refused_under_v7` pins.
        const FROZEN_V11_EMAIL_CONFIGURE: &[u8] = &[
            0x0B, 0x00, 0x01, 0x02, 0x03, 0x09, 0x01, 0x01, 0x02, 0x01, 0x05, 0x61, 0x40, 0x62,
            0x2E, 0x63, 0x01, 0x78, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        let (declared, _) = postcard::take_from_bytes::<u16>(FROZEN_V11_EMAIL_CONFIGURE)
            .expect("the witness opens with its declared version");
        assert_eq!(declared, 11, "the witness declares version 11 in its first varint");
        assert_eq!(
            FROZEN_V11_EMAIL_CONFIGURE[9], 0x01,
            "byte 9 is the v11 SinkTemplate discriminant of the mail target; under v12 it names Http"
        );

        // The refusal: the declared version is not the running one.
        assert_eq!(
            check_version(declared),
            Err(DecodeError::UnknownVersion(11)),
            "a v11 EditRecord must be refused as UnknownVersion(11) under v12"
        );
        assert!(
            matches!(
                upcast(FROZEN_V11_EMAIL_CONFIGURE, declared),
                Err(DecodeError::UnknownVersion(11))
            ),
            "decoded at its own declared version, the v11 record is refused before its bytes \
             are touched"
        );

        // Separately: no decode that passes the version gate yields an Http sink. The
        // positional decode at the running version, if it succeeds, still carries the
        // record's own `schema_version` 11, and that is what the gate refuses.
        if let Ok(rec) = upcast(FROZEN_V11_EMAIL_CONFIGURE, EDIT_SCHEMA_VERSION) {
            assert_eq!(
                rec.schema_version, 11,
                "a positional decode keeps the record's own declared version"
            );
            assert_eq!(
                check_version(rec.schema_version),
                Err(DecodeError::UnknownVersion(11)),
                "an old mail-target record that decodes positionally as an Http sink must never \
                 pass the version gate"
            );
        }
    }

    #[test]
    fn frozen_v12_delete_is_refused_under_v13() {
        // PHASE 86'S OWN RED (86-CONTEXT.md D-03, WORK-02). A v12 `EditRecord` that deletes
        // a machine with a non-empty capture must be refused by its version, never decoded
        // against the v13 shape. FALSE until `EDIT_SCHEMA_VERSION` reads 13.
        //
        // PROVENANCE. Captured ONCE at a pre-release commit (plan 86-02's start revision,
        // EDIT 12) from a postcard encode of:
        //   EditRecord { schema_version: 12, partition: 0, sequence: 1, tick: 2, action: 3,
        //                op: EditOp::Delete { node: NodeId(1v1), kind: 5 (Router),
        //                cell_x: 20, cell_y: 28, captured: DeletedSubgraph { w: 2, h: 3,
        //                ports: <the Router's five catalog ports>, belts: [DeletedBelt {
        //                kind: 1, geometry: [(18, 29), (19, 29)], links: [(NodeId(2v1), 0,
        //                NodeId(1v1), 0)] }], wires: [], self_record: None } } }
        // Byte 5 is the `Delete` discriminant (1). Hard-coded, never regenerated.
        //
        // WHY THE VERSION IS THE ONLY THING THAT CAN REFUSE IT. v13 appends `ticks_per_slot`
        // to every `DeletedBelt` and `rot` to every `DeletedSubgraph`, and postcard reads
        // fields positionally, so read against the v13 shape the byte after each belt's
        // links is taken as its pace and the byte after `self_record` as the rotation. A
        // record whose next bytes happen to be in range decodes into a capture that says
        // something the v12 writer never said. So the refusal is asserted where every
        // reachable boundary (`Host::logged_edits`, `load_project`) takes it: on the
        // record's OWN declared version, through `check_version`.
        const FROZEN_V12_DELETE: &[u8] = &[
            0x0C, 0x00, 0x01, 0x02, 0x03, 0x01, 0x01, 0x01, 0x05, 0x28, 0x38, 0x02, 0x03, 0x05,
            0x00, 0x02, 0x03, 0x00, 0x00, 0x02, 0x02, 0x01, 0x01, 0x00, 0x02, 0x04, 0x01, 0x01,
            0x00, 0x02, 0x00, 0x01, 0x01, 0x00, 0x00, 0x04, 0x02, 0x02, 0x00, 0x01, 0x01, 0x02,
            0x24, 0x3A, 0x00, 0x00, 0x26, 0x3A, 0x00, 0x00, 0x01, 0x02, 0x01, 0x00, 0x01, 0x01,
            0x00, 0x00, 0x00,
        ];
        let (declared, _) = postcard::take_from_bytes::<u16>(FROZEN_V12_DELETE)
            .expect("the witness opens with its declared version");
        assert_eq!(declared, 12, "the witness declares version 12 in its first varint");
        assert_eq!(FROZEN_V12_DELETE[5], 0x01, "byte 5 is the Delete discriminant");

        // The refusal: the declared version is not the running one.
        assert_eq!(
            check_version(declared),
            Err(DecodeError::UnknownVersion(12)),
            "a v12 EditRecord must be refused as UnknownVersion(12) under v13"
        );
        assert!(
            matches!(upcast(FROZEN_V12_DELETE, declared), Err(DecodeError::UnknownVersion(12))),
            "decoded at its own declared version, the v12 record is refused before its bytes \
             are touched"
        );

        // THE BYTES CARRY WEIGHT (phase 86 review, IN-01). The two asserts above refuse on
        // the declared version alone, before any byte past the first is read, so any byte
        // string opening with 12 would pass them. Read positionally against the v13 shape,
        // these bytes are not a v13 record at all: the appended v13 fields (each belt's
        // `ticks_per_slot`, the capture's `rot`) shift every later read off its v12 field.
        // MEASURED: `postcard::from_bytes::<EditRecord>` fails on the witness. A
        // witness whose bytes happened to be a valid v13 record would fail this line, so a
        // replaced or truncated witness cannot keep passing by its first byte alone.
        assert!(
            postcard::from_bytes::<EditRecord>(FROZEN_V12_DELETE).is_err(),
            "the v12 witness does not decode positionally as a v13 record: the appended fields \
             misread its tail"
        );
        // And at the decode boundary with the version gate bypassed by the caller, the same
        // bytes are still refused rather than turned into a capture.
        assert!(
            upcast(FROZEN_V12_DELETE, EDIT_SCHEMA_VERSION).is_err(),
            "decoded as if it were v13, the v12 witness yields no record"
        );
    }

    /// Plan 86-02 (EDIT 13): a `Place` carrying a turn round-trips through the decode
    /// boundary with the turn intact, and a rotation above 3 on a `Place` or on a `Delete`
    /// capture is refused as `Malformed` (threat T-86-05). Each appended field is LAST in
    /// its type, asserted on the bytes: the Place's final byte is its rotation.
    #[test]
    fn a_turned_place_round_trips_and_a_turn_past_3_is_malformed() {
        let mut turned = sample_record();
        turned.op = EditOp::Place { kind: 5, cell_x: 20, cell_y: 28, w: 2, h: 3, ports: vec![], rot: 2 };
        let bytes = postcard::to_allocvec(&turned).expect("serialize a turned Place");
        assert_eq!(bytes.last(), Some(&2u8), "rot is the Place's last field, so its last byte");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Ok(turned.clone()),
            "a turned Place decodes with its turn"
        );

        for rot in [4u8, 7, u8::MAX] {
            let mut bad = turned.clone();
            if let EditOp::Place { rot: r, .. } = &mut bad.op {
                *r = rot;
            }
            let bytes = postcard::to_allocvec(&bad).expect("serialize a forged turn");
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION),
                Err(DecodeError::Malformed),
                "a Place turned {rot} quarter-turns is refused at decode"
            );
            let mut bad_delete = sample_record();
            bad_delete.op = EditOp::Delete {
                node: SlotMap::<NodeId, ()>::with_key().insert(()),
                kind: 5,
                cell_x: 20,
                cell_y: 28,
                captured: DeletedSubgraph { w: 2, h: 3, rot, ..DeletedSubgraph::default() },
            };
            let bytes = postcard::to_allocvec(&bad_delete).expect("serialize a forged capture");
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION),
                Err(DecodeError::Malformed),
                "a Delete capture turned {rot} quarter-turns is refused at decode"
            );
        }
        // A captured belt pace of zero has no encoding the type accepts: it is refused by
        // the decode itself, never folded.
        let mut paced = sample_record();
        paced.op = EditOp::Delete {
            node: SlotMap::<NodeId, ()>::with_key().insert(()),
            kind: 5,
            cell_x: 20,
            cell_y: 28,
            captured: DeletedSubgraph {
                w: 2,
                h: 3,
                belts: vec![DeletedBelt::default()],
                ..DeletedSubgraph::default()
            },
        };
        let mut bytes = postcard::to_allocvec(&paced).expect("serialize a paced capture");
        assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Ok(paced.clone()), "a default pace decodes");
        // Layout of the tail: [.. belt.links len 0, belt.ticks_per_slot 2, wires len 0,
        // self_record None 0, rot 0]. Zero the pace byte.
        let n = bytes.len();
        assert_eq!(&bytes[n - 5..], &[0, 2, 0, 0, 0], "the pace sits after the belt's links");
        bytes[n - 4] = 0;
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed),
            "a captured belt pace of zero is refused at decode"
        );
    }

    #[test]
    fn editrecord_upcast_malformed_bytes_return_typed_error() {
        // Garbage bytes at the current version yield Malformed, never a panic.
        let garbage = [0xFFu8; 4];
        let result = upcast(&garbage, EDIT_SCHEMA_VERSION);
        assert!(matches!(result, Err(DecodeError::Malformed)));
    }

    #[test]
    fn editrecord_upcast_refuses_oversized_place_footprint() {
        // CR-01: a forged `Place` with out-of-envelope footprint dims would be applied
        // VERBATIM by `fold_place`/`claim_footprint` on replay (no fold-time
        // re-validation, decision Q2), expanding `w*h` occupancy cells with no cap. A
        // `w = h = u16::MAX` record is a ~4.3-billion-cell allocation bomb; the decode
        // boundary refuses it as `Malformed`, never decoding it into a foldable record.
        let mut oversized = sample_record();
        oversized.op = EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: u16::MAX,
            h: u16::MAX,
            ports: vec![],
            rot: 0,
        };
        let bytes = postcard::to_allocvec(&oversized).expect("serialize oversized place");
        assert!(matches!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed)
        ));

        // No false trip: a Place at exactly MAX_FOOTPRINT_DIM decodes cleanly.
        let mut maxed = sample_record();
        maxed.op = EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: MAX_FOOTPRINT_DIM,
            h: MAX_FOOTPRINT_DIM,
            ports: vec![],
            rot: 0,
        };
        let bytes = postcard::to_allocvec(&maxed).expect("serialize max place");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("a max-dim place decodes"),
            maxed
        );
    }

    #[test]
    fn editrecord_upcast_refuses_out_of_extent_anchor() {
        // WR-01: the edit-log decode boundary mirrors the snapshot gate's
        // `[GRID_MIN, GRID_MAX]` anchor bound, so a forged `Place` whose anchor lies
        // outside the grid extent is refused as `Malformed` rather than decoded into a
        // record that would build a non-round-tripping `Core` (`CellOutOfBounds`).
        use crate::state::{GRID_MAX, GRID_MIN};
        let mut bad = sample_record();
        bad.op = EditOp::Place {
            kind: 0,
            cell_x: GRID_MAX + 1,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: vec![],
            rot: 0,
        };
        let bytes = postcard::to_allocvec(&bad).expect("serialize out-of-extent place");
        assert!(matches!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed)
        ));

        // No false trip: anchors exactly at the inclusive extents decode cleanly.
        for (cell_x, cell_y) in [(GRID_MIN, GRID_MIN), (GRID_MAX, GRID_MAX)] {
            let mut edge = sample_record();
            edge.op = EditOp::Place {
                kind: 0,
                cell_x,
                cell_y,
                w: 1,
                h: 1,
                ports: vec![],
                rot: 0,
            };
            let bytes = postcard::to_allocvec(&edge).expect("serialize edge place");
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an at-extent anchor decodes"),
                edge
            );
        }
    }

    #[test]
    fn editrecord_upcast_refuses_port_outside_footprint() {
        // WR-02: a forged `Place` whose port `local_offset` lies outside its `[0,w)×[0,h)`
        // rot-0 box is refused as `Malformed`, matching the snapshot gate's
        // `PortOutOfFootprint`, so a verbatim `fold_place`→`set_ports` cannot install a
        // port the gate would reject on the next restore.
        use crate::state::{Medium, Port, Role, Side};
        let mut bad = sample_record();
        bad.op = EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: 2,
            h: 2,
            // (2, 0) is outside [0,2)×[0,2) on the x axis (x must be < w == 2).
            ports: vec![Port {
                local_offset: (2, 0),
                side: Side::E,
                role: Role::Out, medium: Medium::Mechanical,
            }],
            rot: 0,
        };
        let bytes = postcard::to_allocvec(&bad).expect("serialize out-of-footprint port");
        assert!(matches!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed)
        ));

        // No false trip: an in-box port (the far corner (1,1) of a 2×2) decodes cleanly.
        let mut good = sample_record();
        good.op = EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: 2,
            h: 2,
            ports: vec![Port {
                local_offset: (1, 1),
                side: Side::S,
                role: Role::In, medium: Medium::Mechanical,
            }],
            rot: 0,
        };
        let bytes = postcard::to_allocvec(&good).expect("serialize in-box port");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an in-footprint port decodes"),
            good
        );
    }

    #[test]
    fn editop_discriminants_are_pinned() {
        // postcard encodes the leading enum discriminant as a varint. After the 17-02
        // node→node Wire removal the layout is Place=0, Delete=1, Rotate=2, DrawBelt=3,
        // Dock=4, Unlink=5, Undo=6, Redo=7 — every variant after the old `Wire` (disc 1)
        // shifted DOWN by one, the byte-forced EDIT_SCHEMA_VERSION 4->5 renumber this
        // source assertion proves (the frozen-byte corpus re-bless is quarantined to 17-06).
        let place = EditOp::Place {
            kind: 0,
            cell_x: 0,
            cell_y: 0,
            w: 1,
            h: 1,
            ports: vec![],
            rot: 0,
        };
        assert_eq!(
            postcard::to_allocvec(&place).expect("encode Place").first(),
            Some(&0u8),
            "Place is the 1st EditOp variant (discriminant 0)"
        );

        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());

        let delete = EditOp::Delete {
            node: n,
            kind: 1,
            cell_x: 0,
            cell_y: 0,
            captured: DeletedSubgraph::default(),
        };
        assert_eq!(
            postcard::to_allocvec(&delete).expect("encode Delete").first(),
            Some(&1u8),
            "Delete discriminant is 1 (shifted down from 2 by the 17-02 Wire removal)"
        );

        let rotate = EditOp::Rotate {
            node: n,
            new_rot: 1,
            old_rot: 0,
        };
        assert_eq!(
            postcard::to_allocvec(&rotate).expect("encode Rotate").first(),
            Some(&2u8),
            "Rotate discriminant is 2 (shifted down from 3)"
        );

        let draw = EditOp::DrawBelt {
            tiles: vec![crate::state::BeltTile::default()],
        };
        assert_eq!(
            postcard::to_allocvec(&draw).expect("encode DrawBelt").first(),
            Some(&3u8),
            "DrawBelt discriminant is 3 (shifted down from 4)"
        );

        let dock = EditOp::Dock {
            belt: n,
            endpoint: BeltEnd::Head,
            node: n,
            port: 0,
        };
        assert_eq!(
            postcard::to_allocvec(&dock).expect("encode Dock").first(),
            Some(&4u8),
            "Dock discriminant is 4 (shifted down from 5)"
        );

        let unlink = EditOp::Unlink {
            belt: n,
            endpoint: BeltEnd::Head,
            node: n,
            port: 0,
        };
        assert_eq!(
            postcard::to_allocvec(&unlink).expect("encode Unlink").first(),
            Some(&5u8),
            "Unlink discriminant is 5 (shifted down from 6)"
        );

        let undo = EditOp::Undo { target_action: 42 };
        assert_eq!(
            postcard::to_allocvec(&undo).expect("encode Undo").first(),
            Some(&6u8),
            "Undo discriminant is 6 (shifted down from 7)"
        );
        let redo = EditOp::Redo { target_action: 42 };
        assert_eq!(
            postcard::to_allocvec(&redo).expect("encode Redo").first(),
            Some(&7u8),
            "Redo discriminant is 7 (shifted down from 8)"
        );

        // Each new variant serde-round-trips (encode -> decode == identity).
        for op in [unlink, undo, redo] {
            let bytes = postcard::to_allocvec(&op).expect("encode new variant");
            let decoded: EditOp = postcard::from_bytes(&bytes).expect("decode new variant");
            assert_eq!(decoded, op, "new EditOp variant serde-round-trips");
        }
    }

    #[test]
    fn editrecord_upcast_refuses_oversized_or_out_of_extent_draw_belt() {
        use crate::state::{Axis, BeltTile, GRID_MAX, TileKind};
        // T-11-DRAWBELT-BOMB: an empty tile list and an over-cap tile list are both
        // refused as `Malformed` (the allocation-bomb guard), never decoded into a
        // foldable record.
        let straight = BeltTile::new((0, 0), TileKind::Straight { axis: Axis::X });
        for bad_tiles in [
            Vec::<BeltTile>::new(),
            vec![straight; MAX_BELT_TILES as usize + 1],
        ] {
            let mut rec = sample_record();
            rec.op = EditOp::DrawBelt { tiles: bad_tiles };
            let bytes = postcard::to_allocvec(&rec).expect("serialize draw belt");
            assert!(matches!(
                upcast(&bytes, EDIT_SCHEMA_VERSION),
                Err(DecodeError::Malformed)
            ));
        }

        // T-11-TILE-EXTENT: a tile cell outside [GRID_MIN, GRID_MAX] is refused.
        let mut out_of_extent = sample_record();
        out_of_extent.op = EditOp::DrawBelt {
            tiles: vec![BeltTile::new((GRID_MAX + 1, 0), TileKind::Straight { axis: Axis::X })],
        };
        let bytes = postcard::to_allocvec(&out_of_extent).expect("serialize out-of-extent tile");
        assert!(matches!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed)
        ));

        // No false trip: a small in-extent belt at exactly MAX_BELT_TILES decodes.
        let mut maxed = sample_record();
        maxed.op = EditOp::DrawBelt { tiles: vec![straight; MAX_BELT_TILES as usize] };
        let bytes = postcard::to_allocvec(&maxed).expect("serialize max belt");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("a max-tile belt decodes"),
            maxed
        );
    }

    #[test]
    fn rotate_record_round_trips_byte_identical() {
        // The 10-06 Rotate op round-trips byte-identically (mirrors
        // wire_and_delete_records_round_trip), capturing BOTH new_rot and old_rot.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        let rec = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 2,
            sequence: 9,
            tick: 11,
            action: 4,
            op: EditOp::Rotate {
                node: n,
                new_rot: 3,
                old_rot: 1,
            },
        };
        let bytes = postcard::to_allocvec(&rec).expect("serialize rotate record");
        let restored: EditRecord = postcard::from_bytes(&bytes).expect("deserialize rotate record");
        assert_eq!(rec, restored);
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize rotate record");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn delete_record_round_trips() {
        // The resolved Delete op round-trips byte-identically (17-02 removed the
        // node→node Wire op this test previously also covered).
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let a = alloc.insert(());
        let _b = alloc.insert(());
        let op = EditOp::Delete {
            node: a,
            kind: 2,
            cell_x: -1,
            cell_y: 9,
            captured: DeletedSubgraph::default(),
        };
        let rec = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 1,
            sequence: 2,
            tick: 4,
            action: 1,
            op,
        };
        let bytes = postcard::to_allocvec(&rec).expect("serialize edit record");
        let restored: EditRecord = postcard::from_bytes(&bytes).expect("deserialize edit record");
        assert_eq!(rec, restored);
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize edit record");
        assert_eq!(bytes, bytes2);
    }

    #[test]
    fn edit_schema_version_is_thirteen_after_the_turned_delete() {
        // The public constant is the contract every later plan folds, validates, and
        // persists against. Bumped 7 -> 8 by Phase 73, plan 73-03 (byte-forced by
        // `EditOp::AddPort.index` and `DeletedSubgraph.self_record`), then 8 -> 9 by
        // Phase 74.1, plan 74.1-12 (two fold verdicts: the 74.1-03 rotate facing
        // narrowing and the 74.1-12 port-edit release), then 9 -> 10 by plan 74.1-14
        // (design ruling 2026-10-04, "Edits keep middle layout"), then 10 -> 11 by plan
        // 74.1-16 (design ruling N5 of 2026-10-04 and review WR-01: no port edit moves an
        // existing port; byte-forced by `AddPort.seat` and `RemovePort.restore`).
        // `check_version` refuses every older log, forward AND backward, rather than
        // mis-folding it. Then 11 -> 12 by Phase 85, plan 85-05 (D-08, CHROME-04),
        // byte-forced by the Email sink target's deletion (a `Configure` record's
        // `SinkTemplate::Http` moves from discriminant 2 to 1). Then 12 -> 13 by Phase 86,
        // plan 86-02 (D-03, WORK-02), byte-forced by `Place.rot`, `DeletedSubgraph.rot` and
        // `DeletedBelt.ticks_per_slot`. (Renamed from
        // `edit_schema_version_is_twelve_after_the_email_removal`, itself renamed from
        // `edit_schema_version_is_eleven_after_ports_stay_put`.)
        //
        // HAND-WRITTEN literal. Deriving it from the constant it checks would make this
        // assertion agree with any value, which is the same rule
        // `core_version_consts_are_frozen` states about its own five literals.
        assert_eq!(
            EDIT_SCHEMA_VERSION, 13,
            "the edit-log schema version is 13 after the turned-Delete record shape"
        );
    }

    #[test]
    fn a_version_8_record_is_refused_after_the_reseat_release() {
        // The stale-version arm, pinned at the version this bump retires and not by
        // `EDIT_SCHEMA_VERSION - 1` arithmetic, so the next bump cannot silently move it.
        // A version-8 log would replay under the 74.1-03 and 74.1-12 fold verdicts to a
        // different board; it is refused as a typed error instead, before a byte is read.
        assert_eq!(check_version(8), Err(DecodeError::UnknownVersion(8)));
        let bytes = postcard::to_allocvec(&sample_record()).expect("serialize edit record");
        assert_eq!(
            upcast(&bytes, 8),
            Err(DecodeError::UnknownVersion(8)),
            "a record declaring version 8 is refused as UnknownVersion(8), never decoded"
        );
    }

    #[test]
    fn a_version_9_record_is_refused_after_the_catalog_layout_rule() {
        // The stale-version arm for the 74.1-14 bump, pinned at the version it retires
        // (a HAND-WRITTEN 9, never `EDIT_SCHEMA_VERSION - 1`). Version 9 never shipped in
        // a release, but it is in committed history (74.1-12's gated revision), and a
        // version-9 log would replay under the centre-out reseat rule to different port
        // cells and different kept docks. It is refused as a typed error instead, before
        // a byte is read.
        assert_eq!(check_version(9), Err(DecodeError::UnknownVersion(9)));
        let bytes = postcard::to_allocvec(&sample_record()).expect("serialize edit record");
        assert_eq!(
            upcast(&bytes, 9),
            Err(DecodeError::UnknownVersion(9)),
            "a record declaring version 9 is refused as UnknownVersion(9), never decoded"
        );
    }

    #[test]
    fn a_version_10_record_is_refused_after_ports_stay_put() {
        // The stale-version arm for the 74.1-16 bump, pinned at the version it retires
        // (a HAND-WRITTEN 10, never `EDIT_SCHEMA_VERSION - 1`). Version 10 never shipped
        // in a release, but it is in committed history (74.1-14's and 74.1-15's gated
        // revisions): its port-edit records lack the `seat` / `restore` fields, and it
        // would replay under the no-move rule to different port cells. It is refused as a
        // typed error instead, before a byte is read.
        assert_eq!(check_version(10), Err(DecodeError::UnknownVersion(10)));
        let bytes = postcard::to_allocvec(&sample_record()).expect("serialize edit record");
        assert_eq!(
            upcast(&bytes, 10),
            Err(DecodeError::UnknownVersion(10)),
            "a record declaring version 10 is refused as UnknownVersion(10), never decoded"
        );
    }

    #[test]
    fn port_edit_records_round_trip_their_seat_and_restore() {
        // 74.1-16: the two inverse-only fields survive the wire, and a `Some` restore is
        // longer than a `None` one (the byte-forcing the bump paragraph states).
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        let port = Port {
            local_offset: (2, 1),
            side: crate::state::Side::E,
            role: crate::state::Role::Out,
            medium: crate::state::Medium::Mechanical,
        };
        let rec = |op: EditOp| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 1,
            action: 1,
            op,
        };
        for op in [
            EditOp::AddPort { node: n, port, index: 1, seat: PortSeat::Auto },
            EditOp::AddPort { node: n, port, index: 1, seat: PortSeat::Captured },
            EditOp::RemovePort { node: n, index: 3, restore: None },
            EditOp::RemovePort {
                node: n,
                index: 3,
                restore: Some(BoxRestore { w: 3, h: 3, anchor_x: -4, anchor_y: 7 }),
            },
        ] {
            let r = rec(op);
            let bytes = postcard::to_allocvec(&r).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Ok(r));
        }
        let none = postcard::to_allocvec(&rec(EditOp::RemovePort { node: n, index: 3, restore: None }))
            .expect("serialize");
        let some = postcard::to_allocvec(&rec(EditOp::RemovePort {
            node: n,
            index: 3,
            restore: Some(BoxRestore { w: 3, h: 3, anchor_x: 0, anchor_y: 0 }),
        }))
        .expect("serialize");
        assert!(some.len() > none.len(), "a Some restore carries its box");
    }

    #[test]
    fn a_forged_restore_box_is_refused_at_decode() {
        // T-74.1-61: a restore box outside `[1, MAX_FOOTPRINT_DIM]`, or an anchor outside
        // the grid extent, is a record no command writes; `upcast` refuses it as
        // `Malformed`, in the `Place` guard's shape, never a panic.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        for r in [
            BoxRestore { w: 0, h: 3, anchor_x: 0, anchor_y: 0 },
            BoxRestore { w: 3, h: MAX_FOOTPRINT_DIM + 1, anchor_x: 0, anchor_y: 0 },
            BoxRestore { w: 3, h: 3, anchor_x: GRID_MAX + 1, anchor_y: 0 },
            BoxRestore { w: 3, h: 3, anchor_x: 0, anchor_y: GRID_MIN - 1 },
        ] {
            let rec = EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 1,
                tick: 1,
                action: 1,
                op: EditOp::RemovePort { node: n, index: 0, restore: Some(r) },
            };
            let bytes = postcard::to_allocvec(&rec).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Err(DecodeError::Malformed), "{r:?}");
        }
    }

    #[test]
    fn a_forged_captured_seat_is_refused_at_decode() {
        // Plan 74.1-23 (review WR-02, round 3): an `AddPort { seat: Captured }` seats its
        // port on the slot read off its own `local_offset`, verbatim (Q2). A slot outside
        // `[0, MAX_FOOTPRINT_DIM)` is a record no command writes (the inverse of a removal
        // carries a slot the machine really held) and a port outside any box the gate
        // accepts, so `upcast` refuses it as `Malformed`. Slot 0 and `MAX - 1` decode,
        // and an `Auto` seat ignores the offset, so any value decodes there.
        use crate::state::{Medium, Role, Side};
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        let rec = |slot: i32, seat: PortSeat| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 1,
            action: 1,
            op: EditOp::AddPort {
                node: n,
                port: Port { local_offset: (0, slot), side: Side::E, role: Role::Out, medium: Medium::Mechanical },
                index: 0,
                seat,
            },
        };
        let max = i32::from(MAX_FOOTPRINT_DIM);
        for slot in [-1, max, i32::MIN, i32::MAX] {
            let bytes = postcard::to_allocvec(&rec(slot, PortSeat::Captured)).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Err(DecodeError::Malformed), "slot {slot}");
        }
        for slot in [0, max - 1] {
            let r = rec(slot, PortSeat::Captured);
            let bytes = postcard::to_allocvec(&r).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Ok(r), "slot {slot}");
        }
        let auto = rec(-1, PortSeat::Auto);
        let bytes = postcard::to_allocvec(&auto).expect("serialize");
        assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Ok(auto), "an Auto seat ignores the offset");

        // THE FAULT ARM (plan 74.1-32, review round 4 IN-02). `port_slot` reads a Fault's
        // slot off `local_offset.0` (its edge is the bottom row), not `.1`, so the rows above,
        // all Outs, pinned only the In/Out arm: a predicate rewritten to read `.1` for every
        // role stayed green. A Fault at `(slot, 0)` is bounded by `slot`, and a Fault whose
        // `.1` is out of range but whose slot is valid decodes, because the edge coordinate
        // is not its slot.
        let fault = |offset: (i32, i32)| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 1,
            action: 1,
            op: EditOp::AddPort {
                node: n,
                port: Port { local_offset: offset, side: Side::S, role: Role::Fault, medium: Medium::Mechanical },
                index: 0,
                seat: PortSeat::Captured,
            },
        };
        for slot in [-1, max, i32::MIN, i32::MAX] {
            let bytes = postcard::to_allocvec(&fault((slot, 0))).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Err(DecodeError::Malformed), "Fault slot {slot}");
        }
        for slot in [0, max - 1] {
            let r = fault((slot, 0));
            let bytes = postcard::to_allocvec(&r).expect("serialize");
            assert_eq!(upcast(&bytes, EDIT_SCHEMA_VERSION), Ok(r), "Fault slot {slot}");
        }
        let edge_out_of_range = fault((1, i32::MAX));
        let bytes = postcard::to_allocvec(&edge_out_of_range).expect("serialize");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Ok(edge_out_of_range),
            "a Fault's slot is local_offset.0: an out-of-range .1 with a valid slot decodes"
        );
    }

    #[test]
    fn delete_capture_round_trips_byte_identical() {
        // 12-02: a Delete carrying a NON-empty captured DeletedSubgraph (footprint +
        // one cascade belt with geometry and an incident link) serde-round-trips
        // byte-identically — proving the appended `captured` field encodes/decodes.
        use crate::state::{Axis, BeltTile, Medium, Role, Side, TileKind};
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        let captured = DeletedSubgraph {
            self_record: None,
            w: 2,
            h: 1,
            ports: vec![Port {
                local_offset: (1, 0),
                side: Side::E,
                role: Role::Out, medium: Medium::Mechanical,
            }],
            belts: vec![DeletedBelt {
                kind: 1,
                geometry: vec![BeltTile::new((3, -4), TileKind::Straight { axis: Axis::X })],
                links: vec![(n, 0, n, 0)],
                // 86-02: a non-default pace, so the round-trip covers the appended field.
                ticks_per_slot: NonZeroU32::new(5).expect("5 is non-zero"),
            }],
            // 63-06: and one cascade WIRE with endpoints + an incident link, so the
            // round-trip covers the appended field rather than only the fields that
            // predate it.
            wires: vec![DeletedWire {
                kind: 8,
                from: (n, 1),
                to: (n, 2),
                links: vec![(n, 0, n, 2)],
            }],
            // 86-02: a turned machine, so the round-trip covers the appended rotation.
            rot: 1,
        };
        let rec = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 1,
            sequence: 2,
            tick: 4,
            action: 1,
            op: EditOp::Delete {
                node: n,
                kind: 5,
                cell_x: 3,
                cell_y: -4,
                captured: captured.clone(),
            },
        };
        let bytes = postcard::to_allocvec(&rec).expect("serialize delete-capture record");
        let restored: EditRecord =
            postcard::from_bytes(&bytes).expect("deserialize delete-capture record");
        assert_eq!(rec, restored);
        let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize delete-capture record");
        assert_eq!(bytes, bytes2);
        // A populated capture also decodes cleanly through the trust gate.
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an in-bounds capture decodes"),
            rec
        );
        // And a default (empty) capture decodes cleanly too — the byte-identical
        // re-bless path (every fixture's Delete carries an empty capture in 12-02).
        let empty = EditRecord {
            op: EditOp::Delete {
                node: n,
                kind: 5,
                cell_x: 0,
                cell_y: 0,
                captured: DeletedSubgraph::default(),
            },
            ..rec.clone()
        };
        let bytes = postcard::to_allocvec(&empty).expect("serialize empty-capture record");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an empty capture decodes"),
            empty
        );
    }

    #[test]
    fn editrecord_upcast_refuses_oversized_or_out_of_extent_delete_capture() {
        // T-12-03: the extended Delete.captured Vec surface is bounded at decode. A
        // forged over-cap captured ports / belts / belt-geometry list and an
        // out-of-extent captured cell are each refused as `Malformed`, never decoded
        // into a foldable record (and never a panic/OOM). Mirrors the DrawBelt guard.
        use crate::state::{Axis, BeltTile, Medium, Role, Side, TileKind};
        let cap = MAX_BELT_TILES as usize;
        let port = Port {
            local_offset: (0, 0),
            side: Side::N,
            role: Role::In, medium: Medium::Mechanical,
        };
        let tile = BeltTile::new((0, 0), TileKind::Straight { axis: Axis::X });

        // (a) over-cap captured ports.
        let too_many_ports = DeletedSubgraph {
            ports: vec![port; cap + 1],
            ..DeletedSubgraph::default()
        };
        // (b) over-cap cascade belt list.
        let too_many_belts = DeletedSubgraph {
            belts: vec![DeletedBelt::default(); cap + 1],
            ..DeletedSubgraph::default()
        };
        // (c) over-cap belt geometry.
        let too_much_geometry = DeletedSubgraph {
            belts: vec![DeletedBelt {
                kind: 1,
                geometry: vec![tile; cap + 1],
                links: vec![],
                ticks_per_slot: crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
            }],
            ..DeletedSubgraph::default()
        };
        // (d) out-of-extent captured belt-geometry cell.
        let out_of_extent_cell = DeletedSubgraph {
            belts: vec![DeletedBelt {
                kind: 1,
                geometry: vec![BeltTile::new(
                    (GRID_MAX + 1, 0),
                    TileKind::Straight { axis: Axis::X },
                )],
                links: vec![],
                ticks_per_slot: crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
            }],
            ..DeletedSubgraph::default()
        };
        // (e) out-of-extent captured port offset.
        let out_of_extent_port = DeletedSubgraph {
            ports: vec![Port {
                local_offset: (GRID_MIN - 1, 0),
                side: Side::N,
                role: Role::In, medium: Medium::Mechanical,
            }],
            ..DeletedSubgraph::default()
        };
        for bad in [
            too_many_ports,
            too_many_belts,
            too_much_geometry,
            out_of_extent_cell,
            out_of_extent_port,
        ] {
            let rec = EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 0,
                tick: 0,
                action: 0,
                op: EditOp::Delete {
                    node: SlotMap::<NodeId, ()>::with_key().insert(()),
                    kind: 0,
                    cell_x: 0,
                    cell_y: 0,
                    captured: bad,
                },
            };
            let bytes = postcard::to_allocvec(&rec).expect("serialize forged delete capture");
            assert!(matches!(
                upcast(&bytes, EDIT_SCHEMA_VERSION),
                Err(DecodeError::Malformed)
            ));
        }

        // No false trip: a capture at exactly MAX_BELT_TILES geometry decodes cleanly.
        let maxed = DeletedSubgraph {
            belts: vec![DeletedBelt {
                kind: 1,
                geometry: vec![tile; cap],
                links: vec![],
                ticks_per_slot: crate::belt_slots::DEFAULT_TICKS_PER_SLOT,
            }],
            ..DeletedSubgraph::default()
        };
        let rec = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Delete {
                node: SlotMap::<NodeId, ()>::with_key().insert(()),
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                captured: maxed,
            },
        };
        let bytes = postcard::to_allocvec(&rec).expect("serialize max-capture delete");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("a max-geometry capture decodes"),
            rec
        );
    }

    #[test]
    fn editrecord_upcast_bounds_the_captured_wire_surface() {
        // T-63-04 (63-06): the `Delete.captured.wires` append adds TWO new unbounded
        // allocation surfaces - the wire list itself, and each captured wire's incident
        // link list. Both join the existing T-12-03 guard at the same MAX_BELT_TILES
        // ceiling, refused as `Malformed`, never a panic/OOM. Each dimension gets an
        // OVER-the-cap refuse case and an AT-the-cap accept case, so the guard is shown
        // to bite at the right place rather than merely to bite.
        let cap = MAX_BELT_TILES as usize;
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n = alloc.insert(());
        let link = (n, 0u16, n, 0u16);
        let wire = |links: Vec<(NodeId, PortId, NodeId, PortId)>| DeletedWire {
            kind: 8,
            from: (n, 0),
            to: (n, 1),
            links,
        };
        let record = |captured: DeletedSubgraph| EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Delete {
                node: n,
                kind: 0,
                cell_x: 0,
                cell_y: 0,
                captured,
            },
        };

        // (a) over-cap cascade WIRE list, and (b) over-cap per-wire incident links.
        let too_many_wires = DeletedSubgraph {
            wires: vec![wire(vec![]); cap + 1],
            ..DeletedSubgraph::default()
        };
        let too_many_wire_links = DeletedSubgraph {
            wires: vec![wire(vec![link; cap + 1])],
            ..DeletedSubgraph::default()
        };
        for bad in [too_many_wires, too_many_wire_links] {
            let bytes =
                postcard::to_allocvec(&record(bad)).expect("serialize forged wire capture");
            assert!(matches!(
                upcast(&bytes, EDIT_SCHEMA_VERSION),
                Err(DecodeError::Malformed)
            ));
        }

        // No false trip on EITHER dimension: exactly at the cap decodes cleanly.
        let maxed_wires = record(DeletedSubgraph {
            wires: vec![wire(vec![]); cap],
            ..DeletedSubgraph::default()
        });
        let maxed_wire_links = record(DeletedSubgraph {
            wires: vec![wire(vec![link; cap])],
            ..DeletedSubgraph::default()
        });
        for good in [maxed_wires, maxed_wire_links] {
            let bytes = postcard::to_allocvec(&good).expect("serialize max wire capture");
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an at-the-cap wire capture decodes"),
                good
            );
        }
    }

    #[test]
    fn an_empty_capture_costs_exactly_one_byte_per_append_and_leaves_the_sentinel_alone() {
        // The SCHEMA-01 empty probe, and the mechanism behind each append's predicted
        // corpus movement, asserted rather than reasoned about. An empty `wires` Vec
        // encodes as a SINGLE zero varint (63-06) and a `None` `self_record` encodes as a
        // SINGLE zero discriminant byte (73-03), so each append grows every `Delete`
        // record in the frozen corpus by exactly ONE byte and not by more.
        //
        // The count is what makes this a measurement rather than a restatement: a field
        // whose empty encoding cost two bytes, or none, would change the whole predicted
        // delta of the re-bless this commit performs.
        let empty = DeletedSubgraph::default();
        let bytes = postcard::to_allocvec(&empty).expect("serialize the empty capture");
        assert_eq!(
            bytes,
            vec![0u8; 7],
            "w, h, ports-len, belts-len, wires-len, self_record-None, rot - seven zero \
             bytes, the sixth new in 73-03 and the seventh new in 86-02 (EDIT 13)"
        );
        assert!(
            empty.is_empty(),
            "the w == 0 sentinel is undisturbed by either append"
        );
    }

    #[test]
    fn configure_record_round_trips_byte_identical() {
        // 35-02 (SCHEMA-02): a Configure op carrying the FULL CFG-01 surface —
        // MachineConfig::Factory { source } plus the opaque [u8;32] code_hash — serde
        // round-trips byte-identically (shape-only proof; the apply/verify wiring is
        // Phase 39). Also round-trips Source (webhook + timer) and Sink configs so the
        // whole frozen MachineConfig surface is exercised.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        // A non-trivial opaque hash: the core stores/round-trips it but never computes it.
        let mut code_hash = [0u8; 32];
        for (i, b) in code_hash.iter_mut().enumerate() {
            *b = i as u8;
        }
        let configs = [
            MachineConfig::Factory {
                source: "export default function (input, ctx) { ctx.emit(0, input); }".to_owned(),
            },
            MachineConfig::Source {
                trigger: SourceTrigger::Webhook,
            },
            MachineConfig::Source {
                trigger: SourceTrigger::Timer { interval_ticks: 60 },
            },
            MachineConfig::Sink {
                target: SinkTemplate::Http {
                    url: "https://example.invalid/hook".to_owned(),
                    method: crate::state::HttpMethod::Post,
                },
            },
        ];
        for config in configs {
            let rec = EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 1,
                sequence: 2,
                tick: 3,
                action: 4,
                op: EditOp::Configure {
                    node,
                    config,
                    code_hash,
                },
            };
            let bytes = postcard::to_allocvec(&rec).expect("serialize configure record");
            let restored: EditRecord =
                postcard::from_bytes(&bytes).expect("deserialize configure record");
            assert_eq!(rec, restored);
            let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize configure record");
            assert_eq!(bytes, bytes2, "Configure round-trips byte-identically");
            // A normal (in-bound) Configure also decodes cleanly through the trust gate.
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an in-bound configure decodes"),
                rec
            );
        }
    }

    #[test]
    fn editrecord_upcast_refuses_oversized_configure_js() {
        // T-35-04-CONFIGBOMB (SCHEMA-03): a forged Configure whose Factory JS `source`
        // exceeds MAX_CONFIG_BYTES is refused at the untrusted-decode boundary as a
        // typed DecodeError::Malformed — never a panic/OOM, never decoded into a
        // foldable record. `upcast` returns Err (we assert the call is Err, we never
        // unwrap it).
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        // One byte past the cap — a single ASCII char per byte keeps len == byte len.
        let oversized_source = "a".repeat(MAX_CONFIG_BYTES + 1);
        let rec = EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 0,
            tick: 0,
            action: 0,
            op: EditOp::Configure {
                node,
                config: MachineConfig::Factory {
                    source: oversized_source,
                },
                code_hash: [0u8; 32],
            },
        };
        let bytes = postcard::to_allocvec(&rec).expect("serialize oversized configure");
        let result = upcast(&bytes, EDIT_SCHEMA_VERSION);
        assert!(
            matches!(result, Err(DecodeError::Malformed)),
            "an oversized Configure JS source must be a typed Malformed reject, got {result:?}"
        );

        // No false trip: a Configure whose source is exactly MAX_CONFIG_BYTES decodes.
        let at_cap = EditRecord {
            op: EditOp::Configure {
                node,
                config: MachineConfig::Factory {
                    source: "a".repeat(MAX_CONFIG_BYTES),
                },
                code_hash: [0u8; 32],
            },
            ..rec.clone()
        };
        let bytes = postcard::to_allocvec(&at_cap).expect("serialize at-cap configure");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an at-cap configure decodes"),
            at_cap
        );
    }

    // ── the Belt / Router config variants (Phase 63, SCHEMA-01) ────────────────

    /// Encode a bare `MachineConfig` (not wrapped in a record) so the leading byte IS
    /// the variant discriminant postcard derived from the declaration index.
    fn config_bytes(config: &MachineConfig) -> Vec<u8> {
        postcard::to_allocvec(config).expect("serialize a MachineConfig")
    }

    #[test]
    fn machine_config_discriminants_are_zero_through_four() {
        use std::num::NonZeroU32;
        use crate::state::RouteKey;
        // The byte is the contract; the variant NAME is not. Assert on the ENCODED
        // leading byte for all five variants, so an insert anywhere but the end (which
        // would shift every later discriminant and move every stored byte) is a failing
        // test rather than a reading of the source.
        assert_eq!(
            config_bytes(&MachineConfig::Factory { source: "x".to_owned() })[0],
            0,
            "Factory is discriminant 0"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Source { trigger: SourceTrigger::Webhook })[0],
            1,
            "Source is discriminant 1"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Sink { target: SinkTemplate::Debug })[0],
            2,
            "Sink is discriminant 2"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Belt {
                ticks_per_slot: NonZeroU32::new(4).expect("4 is non-zero"),
            })[0],
            3,
            "Belt is discriminant 3 (appended after Sink)"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Router {
                routes: vec![(RouteKey::new(1, vec![7]), 2)],
                default: Some(3),
            })[0],
            4,
            "Router is discriminant 4 (appended after Belt)"
        );
    }

    #[test]
    fn the_three_pre_existing_config_variants_encode_byte_identically_to_before_the_append() {
        // The append's whole justification is that it moves NO stored byte. These four
        // literals were captured from an encode taken on the tree IMMEDIATELY BEFORE
        // `Belt` and `Router` were added, and they are HARD-CODED (never derived from
        // the live types) so they will not drift with the enum — a genuine frozen-bytes
        // witness in the `frozen_v4_wire_editrecord_is_refused_under_v5` style.
        assert_eq!(
            config_bytes(&MachineConfig::Factory { source: "x".to_owned() }),
            vec![0x00, 0x01, b'x'],
            "Factory{{source:\"x\"}} bytes are unmoved by the append"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Source { trigger: SourceTrigger::Webhook }),
            vec![0x01, 0x00],
            "Source{{Webhook}} bytes are unmoved by the append"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Source {
                trigger: SourceTrigger::Timer { interval_ticks: 60 },
            }),
            vec![0x01, 0x01, 0x3C],
            "Source{{Timer{{60}}}} bytes are unmoved by the append"
        );
        assert_eq!(
            config_bytes(&MachineConfig::Sink { target: SinkTemplate::Debug }),
            vec![0x02, 0x00],
            "Sink{{Debug}} bytes are unmoved by the append"
        );
    }

    #[test]
    fn belt_and_router_configs_round_trip_byte_identically() {
        use std::num::NonZeroU32;
        use crate::state::RouteKey;
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        let configs = [
            MachineConfig::Belt {
                ticks_per_slot: NonZeroU32::new(12).expect("12 is non-zero"),
            },
            MachineConfig::Router {
                routes: vec![
                    (RouteKey::new(0, b"alpha".to_vec()), 1),
                    (RouteKey::new(3, b"beta".to_vec()), 2),
                ],
                default: Some(7),
            },
            // The empty table with no default: legal, and it means every item routes to
            // the fault port (the existing `Router` no-match semantics, not a new one).
            MachineConfig::Router {
                routes: vec![],
                default: None,
            },
        ];
        for config in configs {
            let rec = EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 1,
                sequence: 2,
                tick: 3,
                action: 4,
                op: EditOp::Configure { node, config, code_hash: [9u8; 32] },
            };
            let bytes = postcard::to_allocvec(&rec).expect("serialize configure record");
            let restored: EditRecord =
                postcard::from_bytes(&bytes).expect("deserialize configure record");
            assert_eq!(rec, restored);
            let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize");
            assert_eq!(bytes, bytes2, "the new config variants round-trip byte-identically");
            // And the same record survives the decode boundary unchanged.
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an in-policy config decodes"),
                rec
            );
        }
    }

    /// One `Configure{Router{routes, default: None}}` record, ready to encode.
    fn router_config_record(routes: Vec<(crate::state::RouteKey, PortId)>) -> EditRecord {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 0,
            op: EditOp::Configure {
                node,
                config: MachineConfig::Router { routes, default: None },
                code_hash: [0u8; 32],
            },
        }
    }

    #[test]
    fn editrecord_upcast_refuses_an_over_cap_router_route_table() {
        use crate::state::RouteKey;
        // T-63-01: `fold_configure` writes `routes` VERBATIM (no re-validation, Q2), so a
        // forged table of millions of routes becomes a live `Router` the per-item
        // first-match walk then traverses. The decode boundary refuses it as `Malformed`.
        let over = router_config_record(
            (0..=MAX_ROUTES).map(|i| (RouteKey::new(0, vec![i as u8]), 0)).collect(),
        );
        let bytes = postcard::to_allocvec(&over).expect("serialize an over-cap router");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed),
            "a route table longer than MAX_ROUTES is a typed Malformed reject"
        );

        // No false trip: EXACTLY at the cap decodes. The bound is inclusive and this
        // pins the boundary, so a later off-by-one is a failing test not a reading.
        let at_cap = router_config_record(
            (0..MAX_ROUTES).map(|i| (RouteKey::new(0, vec![i as u8]), 0)).collect(),
        );
        let bytes = postcard::to_allocvec(&at_cap).expect("serialize an at-cap router");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an at-cap route table decodes"),
            at_cap
        );
    }

    #[test]
    fn editrecord_upcast_refuses_an_over_cap_router_expect_pattern() {
        use crate::state::RouteKey;
        // The second dimension of the same bomb: ONE route whose `expect` pattern is
        // unbounded. Bounded independently of the table length.
        let over = router_config_record(vec![(
            RouteKey::new(0, vec![0u8; MAX_ROUTE_EXPECT_BYTES + 1]),
            0,
        )]);
        let bytes = postcard::to_allocvec(&over).expect("serialize an over-cap pattern");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION),
            Err(DecodeError::Malformed),
            "an expect pattern longer than MAX_ROUTE_EXPECT_BYTES is a typed Malformed reject"
        );

        // No false trip: exactly at the cap decodes.
        let at_cap = router_config_record(vec![(
            RouteKey::new(0, vec![0u8; MAX_ROUTE_EXPECT_BYTES]),
            0,
        )]);
        let bytes = postcard::to_allocvec(&at_cap).expect("serialize an at-cap pattern");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an at-cap expect pattern decodes"),
            at_cap
        );
    }

    #[test]
    fn editrecord_upcast_accepts_an_empty_router_table() {
        // An empty `routes` with `default: None` is LEGAL: it means every item goes to
        // the fault port, which is the existing `Router` no-match behaviour and not a
        // new one. The caps must not refuse it.
        let empty = router_config_record(vec![]);
        let bytes = postcard::to_allocvec(&empty).expect("serialize an empty router table");
        assert_eq!(
            upcast(&bytes, EDIT_SCHEMA_VERSION).expect("an empty route table decodes"),
            empty
        );
    }

    #[test]
    fn a_belt_config_adds_no_unbounded_surface_at_the_decode_boundary() {
        use std::num::NonZeroU32;
        // `Belt` carries a single `NonZeroU32`, so there is nothing for a cap to bound —
        // stated as an executable claim: every representable interval decodes, including
        // the extremes.
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        for n in [1u32, 60, u32::MAX] {
            let rec = EditRecord {
                schema_version: EDIT_SCHEMA_VERSION,
                partition: 0,
                sequence: 1,
                tick: 0,
                action: 0,
                op: EditOp::Configure {
                    node,
                    config: MachineConfig::Belt {
                        ticks_per_slot: NonZeroU32::new(n).expect("n is non-zero"),
                    },
                    code_hash: [0u8; 32],
                },
            };
            let bytes = postcard::to_allocvec(&rec).expect("serialize a belt config");
            assert_eq!(
                upcast(&bytes, EDIT_SCHEMA_VERSION).expect("every belt interval decodes"),
                rec
            );
        }
    }

    // ── the label decode bound (Phase 76, plan 76-04, SHAPE-13, D-06) ──────────────
    //
    // A forged `Configure{Label}` is refused at `upcast` when its text exceeds
    // `MAX_LABEL_BYTES` or its width or depth is outside 1 to `MAX_FOOTPRINT_DIM`, and one
    // exactly at each limit decodes. The 16 by 8 caps are write-side only and are NOT
    // enforced here (64 by 64 decodes). Each test reads the constant plus or minus one,
    // never a literal.
    //
    // MEASURED BEFORE THE GUARD (start revision of task 2, recorded in 76-04-SUMMARY.md):
    // every record below decoded `Ok`; the two `refuses` tests reddened on their first
    // assertion and the two `accepts` tests passed.

    /// One `Configure{Label}` record on a fresh node, `text`, Lilac, `w` by `h`.
    fn label_record(text: String, w: u16, h: u16) -> EditRecord {
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let node = alloc.insert(());
        EditRecord {
            schema_version: EDIT_SCHEMA_VERSION,
            partition: 0,
            sequence: 1,
            tick: 0,
            action: 0,
            op: EditOp::Configure {
                node,
                config: MachineConfig::Label { text, colour: LabelColour::Lilac, w, h },
                code_hash: [0u8; 32],
            },
        }
    }

    /// `upcast` of the record's own bytes.
    fn upcast_of(rec: &EditRecord) -> Result<EditRecord, DecodeError> {
        let bytes = postcard::to_allocvec(rec).expect("serialize a label configure");
        upcast(&bytes, EDIT_SCHEMA_VERSION)
    }

    #[test]
    fn upcast_refuses_a_label_text_one_byte_over_the_cap() {
        // ASCII, so bytes equal characters, and a multibyte text whose BYTE length is one
        // past the cap while its character count is far under it: the bound is in bytes.
        let ascii = "a".repeat(MAX_LABEL_BYTES + 1);
        let multibyte = format!("{}a", "\u{e9}".repeat(MAX_LABEL_BYTES / 2));
        assert_eq!(multibyte.len(), MAX_LABEL_BYTES + 1, "two bytes per e-acute, plus one");
        for text in [ascii, multibyte] {
            let result = upcast_of(&label_record(text, 4, 1));
            assert!(
                matches!(result, Err(DecodeError::Malformed)),
                "a label text one byte over MAX_LABEL_BYTES must be a typed Malformed \
                 reject at the decode boundary, got {result:?}"
            );
        }
    }

    #[test]
    fn upcast_accepts_a_label_text_exactly_at_the_cap() {
        let rec = label_record("a".repeat(MAX_LABEL_BYTES), 4, 1);
        assert_eq!(upcast_of(&rec).expect("an at-cap label text decodes"), rec);
        let multibyte = label_record("\u{e9}".repeat(MAX_LABEL_BYTES / 2), 4, 1);
        assert_eq!(
            upcast_of(&multibyte).expect("an at-cap multibyte label text decodes"),
            multibyte
        );
    }

    #[test]
    fn upcast_refuses_a_label_size_outside_the_envelope() {
        for (w, h) in [
            (0, 1),
            (1, 0),
            (MAX_FOOTPRINT_DIM + 1, 1),
            (1, MAX_FOOTPRINT_DIM + 1),
            (u16::MAX, u16::MAX),
        ] {
            let result = upcast_of(&label_record(String::new(), w, h));
            assert!(
                matches!(result, Err(DecodeError::Malformed)),
                "a label size {w} by {h} is outside 1 to MAX_FOOTPRINT_DIM and must be a \
                 typed Malformed reject at the decode boundary, got {result:?}"
            );
        }
    }

    #[test]
    fn upcast_accepts_a_label_size_at_the_envelope() {
        // The envelope's corners, and a size past the 16 by 8 panel caps: those are a
        // WRITE-side policy, so a later cap change cannot make a saved board unloadable.
        for (w, h) in [(1, 1), (MAX_FOOTPRINT_DIM, MAX_FOOTPRINT_DIM), (17, 9)] {
            let rec = label_record("Order intake".to_owned(), w, h);
            assert_eq!(
                upcast_of(&rec).expect("a label size inside the envelope decodes"),
                rec,
                "{w} by {h} decodes"
            );
        }
    }
}

//! The headless command-rejection taxonomy.
//!
//! [`CommandError`] mirrors the host's `input_apply::Reject` (the gesture-rejection
//! enum) as the richer headless SUPERSET: every `Reject` variant plus
//! [`CommandError::UnknownKind`], the Place kind-validation outcome the host's
//! `Reject` lacks (the host trusts the palette to emit only valid kind bytes; the
//! headless command layer is the authoritative validator and checks the byte).
//!
//! A rejection is a typed, **non-panicking** outcome the caller maps to invalid-
//! feedback: the command changed NOTHING - no record produced, no fold, no state
//! mutation (SC#2). Like `Reject` it is a `Copy`, derive-only enum (no allocation,
//! no payload) so it is cheap to return and compare.

use std::error::Error;
use std::fmt;

/// Why a [`GridCommand`](fabrico_protocol::GridCommand) was rejected - a typed,
/// non-panicking outcome. The command produced NO [`EditRecord`](fabrico_core::edit::EditRecord),
/// folded nothing, and left state byte-identical (SC#2).
///
/// Mirrors `fabrico_host::input_apply::Reject` and ADDS [`UnknownKind`](Self::UnknownKind):
/// the headless command layer validates the Place `kind` byte (the host omits this,
/// trusting its palette), so the taxonomy here is the authoritative superset.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandError {
    /// A `Place` or `DrawBelt` whose resolved footprint overlaps a live node on ANY of its
    /// cells (FOOT-01). Since plan 88-02 a `Rotate` or `AddPort` blocked by a machine is
    /// [`RotateBlocked`](Self::RotateBlocked) or [`GrowBlocked`](Self::GrowBlocked), because
    /// this tag's sentence offers "try elsewhere", a choice only a placement has. The whole
    /// placement is rejected ATOMICALLY - never partial - the instant the first occupied cell
    /// is found, so a reject produces nothing and
    /// leaves state byte-identical (SC#2). A 1×1 machine is just a single-cell
    /// footprint, so a same-cell collision surfaces here too (the v1.0 `Occupied`
    /// generalized into the multi-cell loop).
    FootprintCollision,
    /// A footprint cell outside the inclusive grid bound on either axis: the `Place`,
    /// `Rotate`, `DrawBelt`, `AddPort` and label-resize arms of `validate_normalize`, each
    /// checking EVERY cell, not just the anchor (Pitfall 5). Since plan 88-02 a machine that
    /// would grow past the size limit is [`MachineTooBig`](Self::MachineTooBig), not this.
    OutOfBounds,
    /// A gesture referencing a render handle that resolves to no live node (a stale or
    /// forged handle): a machine, a label or a belt. The user reads `REFUSAL_COPY.UnknownNode`,
    /// "That is no longer on the board.", which names no kind (plan 88-02, D-03).
    UnknownNode,
    /// A `DrawWire` whose endpoints do not form a legal wire (WIRE-01, the
    /// `validate_normalize` `DrawWire` arm). FOUR arms, and the self-loop is only one
    /// of them - the other three fire between DISTINCT machines:
    /// - `from == to` (a self-loop; legal at the fold, so it is stopped here or
    ///   nowhere);
    /// - either endpoint's port INDEX names no declared port (including a port-less
    ///   node), which would otherwise mint a wire nothing reads;
    /// - the source port's role is not `Role::Out` (`Role::Fault` is deliberately not
    ///   accepted there, T-63-17);
    /// - the target port's role is not `Role::In`.
    ///
    /// THIS DOCBLOCK IS USER-FACING BY PROXY. It read "currently: a self-loop
    /// (`from == to`)" from before Phase 63 widened the arm until 2026-08-22, and phase
    /// 64's copywriter took it at its word and shipped "A wire cannot connect a machine
    /// to itself." to users for three refusals where it is false. Widen the arm, widen
    /// this list, and re-check `REFUSAL_COPY.IncompatiblePorts` - `refusal_copy_truth.rs`
    /// (fabrico-host) is the test that fails if the sentence narrows back to the
    /// self-loop. All four arms are pinned by `fabrico-command/tests/draw_wire.rs`.
    IncompatiblePorts,
    /// A `Wire` whose `(from, from_port)` output port is already connected (WR-04).
    /// Re-wiring it would silently overwrite the existing link and orphan the belt
    /// that link feeds, so the re-wire is rejected rather than leaking topology.
    ///
    /// SINCE PLAN 74.1-32 the `Dock` arm returns it for a MACHINE source only: an Out or
    /// Fault that already feeds something (the spatial port or the `FAULT_PORT` sentinel),
    /// and every wire carrier. Where the occupied source is a drawn BELT's end the arm
    /// returns [`BeltEndTaken`](Self::BeltEndTaken) instead. `DrawWire` and `RemovePort`
    /// keep this tag.
    PortOccupied,
    /// A `Place` whose `kind` byte is outside the known `machine_kind` range
    /// (the superset variant the host's `Reject` lacks).
    UnknownKind,
    /// A `Place` whose `kind` byte is `machine_kind::BELT` (17-02, CAT-04). Belts are
    /// NEVER placed - they come only from `DrawBelt` + `Dock` after the node→node Wire
    /// removal. Rejected BEFORE catalog resolution (the `fold_place` BELT mint arm is
    /// gone), so a belt can never be minted via `Place`; produces NOTHING (SC#2).
    BeltNotPlaceable,
    /// A belt end and a port that do not form a valid dock. Two arms return it
    /// (the legacy `Wire` command this used to describe is gone):
    ///
    /// - `Dock`: the roles are not `Out → In` (a Head names an In; a Tail names an Out
    ///   or a Fault port); the carrier is a belt with no drawn tiles, or a wire named by
    ///   its Tail; the port index names no declared port, or a belt target names its
    ///   Fault arm or is a single tile with no direction; the carrier's end is not on
    ///   the tile the port faces (its doorstep); or the carrier would run back into its
    ///   own port (outward side equal to the port's side), a shape reachable only from
    ///   a forged board. Since phase 74.1 (D-02) there is NO facing-opposite rule: a
    ///   belt that leaves the doorstep straight or turns at it is accepted. The reserved
    ///   `FAULT_PORT` (`u16::MAX`) skips the spatial checks but still refuses a Head.
    /// - `Unlink`: the named end's role does not match the port (the same `Out → In`
    ///   rule), the index names no declared port, or a Head names the non-spatial
    ///   `FAULT_PORT`.
    ///
    /// The user reads `REFUSAL_COPY.InvalidDock` (`A belt runs from an output to an
    /// input, right next to it.`), which `fabrico-host/tests/refusal_copy_truth.rs`
    /// holds true against this arm.
    ///
    /// SINCE PLAN 74.1-18 a refusal of a BELT-TO-BELT join is NOT this tag: it is
    /// [`InvalidBeltJoin`](Self::InvalidBeltJoin), whose sentence states the belt rule. The
    /// role, step, inner-tile, single-tile and facing clauses above therefore reach a user
    /// as this tag only for a MACHINE target (or a wire carrier); the sentence above names
    /// output, input and next-to, which is true of a machine port and of nothing else.
    InvalidDock,
    /// A gesture frame the host could not READ (narrowed by plan 88-02, FAIL-09, D-11).
    /// Nothing about the board is involved.
    ///
    /// # Which arms return it
    /// - `fabrico_host::transport_ws::decode_gesture`: a frame over `MAX_GESTURE_FRAME`, an
    ///   empty frame, a run-pace frame declaring more than `MAX_RUN_PACE_BELTS` belts, or
    ///   bytes that do not `postcard`-decode as a `GridCommand` or a run-pace body.
    /// - `fabrico_host::input_apply::apply_run_pace` and the headless
    ///   `GridSession::set_belt_run_pace`: a run-pace list with no belts in it (or, on the
    ///   host, one longer than the cap), a frame that carries nothing to apply.
    /// - `validate_normalize` handed an Undo or Redo, which `GridSession::apply` routes away
    ///   before that function is reached; only a standalone caller can see it.
    ///
    /// # What it no longer covers
    /// Until plan 88-02 this one variant also carried every gesture the host read perfectly
    /// and could not carry out, so its sentence had to name no cause at all ("The host could
    /// not carry out that gesture."). Those causes have their own variants now:
    /// [`NoSuchPort`](Self::NoSuchPort), [`UnknownOption`](Self::UnknownOption),
    /// [`OverLimit`](Self::OverLimit), [`InvalidPath`](Self::InvalidPath),
    /// [`WrongKind`](Self::WrongKind) and [`UndoDoesNotFit`](Self::UndoDoesNotFit), and the
    /// user reads `REFUSAL_COPY.Malformed`, "The host could not read that gesture.", which is
    /// true of every arm above. `fabrico-host/tests/refusal_copy_truth.rs` drives each.
    Malformed,
    /// A `DrawBelt` whose drawn path failed the pure [`route`](crate::route::route)
    /// normalizer (BELT-03): empty / non-adjacent / self-crossing. Wraps the typed
    /// [`RouteError`](crate::route::RouteError) so a malformed drawn path surfaces a
    /// typed reject (never a panic, never a guess). The whole path is rejected
    /// atomically - no record is produced (state byte-identical, SC#2).
    Route(crate::route::RouteError),
    /// A `DrawBelt` whose resolved tile count exceeds
    /// [`fabrico_core::edit::MAX_BELT_TILES`] (1024). The command layer's acceptance
    /// envelope MUST match the snapshot/edit-log round-trip envelope: the snapshot
    /// trust gate (`BeltTilesTooMany`) and the `edit::upcast` decode bound both reject
    /// an over-long belt, so accepting one here would yield a live `Core` that fails
    /// its OWN snapshot restore (save/load data loss). Rejected atomically - no record
    /// produced (state byte-identical, SC#2).
    BeltTooLong,
    /// A `GridCommand::Undo` issued with an empty undo stack (cursor == 0) - a typed
    /// reject that produces NOTHING (Q3.3): no [`EditRecord`](fabrico_core::edit::EditRecord),
    /// no fold, state byte-identical (SC#2). The undo/redo driver that consumes this
    /// lands in a later 12-xx wave; the variant exists now as the shared taxonomy
    /// those waves depend on.
    NothingToUndo,
    /// A `GridCommand::Redo` issued with an empty redo stack (cursor == undoable.len()),
    /// a typed reject that produces NOTHING (Q3.3): no record, no fold, state
    /// byte-identical (SC#2). Mirror of [`NothingToUndo`](Self::NothingToUndo).
    NothingToRedo,
    /// A `Dock` (PORT-08) whose carrier medium is incompatible with the target port's
    /// medium - e.g. a belt (always a `Medium::Mechanical` carrier) docked onto an
    /// `Medium::Electrical` (wire) port, or the reverse. A `Copy`, payload-free,
    /// RETURNED-ONLY reject: it is NEVER serialized (not in the edit-log/snapshot), so
    /// appending it LAST here adds ZERO serialized shape and needs no version bump. The
    /// medium check runs at Dock validation, right after the role check, and rejects
    /// BEFORE freezing the dock - nothing is produced, state is byte-identical (SC#2),
    /// never a silent hang. Decided by the shared `mediums_compatible` predicate, which
    /// `validate_normalize`'s `DrawWire` arm calls for the wire->port direction on BOTH
    /// of a drawn wire's endpoints (63-02, WIRE-01) - one rule, both ways, one
    /// definition. So this variant is returned by the Dock path AND the wire path.
    MediumMismatch,
    /// A `Configure{Belt{ticks_per_slot: 0}}` (BELT-02, 63-04). The core holds a belt's
    /// advance interval as `NonZeroU32` precisely so that zero is UNREPRESENTABLE - it
    /// is what keeps the modulo in `Belt::step` structurally panic-free - while the wire
    /// grammar carries a plain `u32`. The conversion at that seam is therefore fallible,
    /// and a zero is REFUSED here rather than defaulted: `unwrap_or(DEFAULT_TICKS_PER_SLOT)`
    /// would silently hand the user a working belt running at a speed they did not
    /// choose (threat T-63-24). Produces NOTHING - no record, no fold, state
    /// byte-identical (SC#2).
    ZeroBeltInterval,
    /// A `Configure{Belt{ticks_per_slot}}` outside the inclusive `2..=20` range the
    /// shipped Belt pace control offers (BELT-04, 68-04). The fast end is a MEASURED
    /// aliasing wall and the slow end is a CHOSEN floor - both stated in full at the
    /// check itself in `command.rs`'s `Configure` arm, which is the one place that
    /// derives them. Produces NOTHING - no record, no fold, state byte-identical
    /// (SC#2).
    ///
    /// # It is a WRITE-side policy and NOT a data invariant (D-68-17)
    /// Zero is refused because the core's `NonZeroU32` makes it UNREPRESENTABLE; this
    /// bound refuses nothing the core cannot hold. It is applied at
    /// `validate_normalize` ONLY, so an edit-log or a save carrying a `ticks_per_slot`
    /// outside `2..=20` still LOADS and still REPLAYS. Applying it on the load path
    /// would make a UI range choice a save-breaking change and could reject a frozen
    /// scenario fixture; `crates/fabrico-host/tests/belt_run_pace.rs` pins the
    /// write-only property against the replayed STATE.
    ///
    /// # Why it earned its own tag rather than joining one
    /// `ZeroBeltInterval` says "above zero", which is FALSE for a user who typed a
    /// large pace; `Malformed` names no cause by design and its own docblock records
    /// that the real fix is to SPLIT it rather than join a fifth unrelated cause. Per
    /// the mechanism stated above, adding a variant widens the wire union `64-UI-SPEC`
    /// locks, so it is a SPEC change - `68-UI-SPEC.md` section 5.4 is that spec change
    /// and it takes the union from 17 tags to 18.
    PaceOutOfRange,
    /// A `Configure{Endpoint{path}}` naming a path ANOTHER live Route has already
    /// committed (SERVE-08, D-13, threat T-72-07-04). Produces NOTHING - no record, no
    /// fold, state byte-identical (SC#2).
    ///
    /// # Why it earned its own tag when the other three path rules did not
    /// R-47 gives a Route path four rules. The leading slash, the length bound and the
    /// unreserved-byte alphabet all resolve to [`Malformed`](Self::Malformed), whose
    /// sentence names no cause by design. THIS one is different in kind: it is the only
    /// rule that can NAME A SPECIFIC OTHER OBJECT, and the answer a user needs is "the
    /// Route at (4, 7) already answers there", which no sentence about malformed input
    /// can carry. The tag carries the AUTHORITY and the panel carries the NAME.
    ///
    /// # It is a WRITE-side policy, and the comparison is against COMMITTED paths
    /// Applied at `validate_normalize` ONLY. The fold never re-validates (Q2), so a save
    /// or a log that already carries two Routes on one path still LOADS and still
    /// REPLAYS - refusing it on the load path would make a UI rule a save-breaking
    /// change, the line `PaceOutOfRange` above draws for belt pace. A Route re-applying
    /// its OWN committed path is NOT a duplicate; without that clause the rule would
    /// refuse a user who opens the panel and presses Apply twice.
    ///
    /// # What it does NOT cover, said plainly
    /// It compares against other ROUTES only. A path is prevented from shadowing a
    /// Source's `/hook/` route STRUCTURALLY rather than by this rule: the two live in
    /// disjoint key namespaces in the published route map and under different fixed URL
    /// prefixes. A blacklist would be the fragile way to get the same property.
    ///
    /// Node-RED permits duplicate paths and its own community documents the result as
    /// unpredictable, with no error and no warning. That is the outcome this refuses.
    DuplicatePath,
    /// A `Rotate` whose turned box would cover a BELT (plan 74.1-18, review WR-03).
    /// Produces NOTHING - no record, no fold, state byte-identical (SC#2); no belt is
    /// released or deleted.
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `Rotate` arm walks the turned box in `cells_of_footprint`
    /// order (row-major from the anchor) and stops at the FIRST cell another node owns.
    /// When that owner's kind is `machine_kind::BELT` the refusal is this tag; when it is
    /// a machine it stays [`FootprintCollision`](Self::FootprintCollision). The walk order
    /// is unchanged, so which cell is first is unchanged, and only the TAG of an
    /// already-refused Rotate moved: no Rotate is newly accepted or newly refused.
    ///
    /// # Design decision
    /// Plan 74.1-14 moved the Router's first Out to the middle row of its 2x3 box, so a
    /// Rotate (which keeps the anchor) covers the first tile of any belt docked there,
    /// including the demo Router's. Offered "refuse" or "release the belt and re-dock it
    /// on undo", the chosen behavior is "Refuse, say why". The user reads
    /// `REFUSAL_COPY.RotateCoversBelt` (`Turning would cover a belt. Move that belt
    /// first.`), which `fabrico-host/tests/refusal_copy_truth.rs` holds true against this
    /// arm. Pinned by `fabrico-command/tests/router_rotate_refusal.rs` (catalog port 1,
    /// both directions, a port-2 control) and `fabrico-host/tests/demo_router_rotate.rs`.
    ///
    /// A `Copy`, payload-free, RETURNED-ONLY reject, never serialized into an edit log or
    /// a snapshot, so appending it adds no serialized shape and needs no schema bump. It
    /// widens the wire union `CommandErrorView` carries, which is a SPEC change (the
    /// mechanism `PaceOutOfRange` records above).
    RotateCoversBelt,
    /// An `AddPort` whose grown box would cover a BELT (plan 74.1-18, the J10 note's case).
    /// Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `AddPort` arm walks the PROSPECTIVE box (plan 74.1-16's
    /// shared `add_port_geometry`, the box the fold would write) in `cells_of_footprint`
    /// order and stops at the FIRST cell another node owns. A belt tile there is this tag;
    /// a machine there stays [`FootprintCollision`](Self::FootprintCollision). The
    /// reachable case is a Factory with a belt on its Fault whose fourth output grows the
    /// box over that belt's first tile (the demo Factory's third `+ Add output` press).
    /// Only the TAG of an already-refused add moved: no add is newly accepted or refused.
    ///
    /// The user reads `REFUSAL_COPY.GrowCoversBelt` (`Growing would cover a belt. Move that
    /// belt first.`), which `fabrico-host/tests/refusal_copy_truth.rs` holds true against
    /// this arm at rot 0 and rot 1. A `Copy`, payload-free, returned-only reject: no
    /// serialized shape moves; the wire union widens.
    GrowCoversBelt,
    /// A belt-to-belt `Dock` that breaks the BELT rule (plan 74.1-18, gap N4c) on a clause
    /// that has no tag of its own. Produces NOTHING - no record, no fold, state
    /// byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `Dock` arm, once the carrier is a drawn belt and the target
    /// is a drawn belt (a belt-to-belt join), for three refusals: the ROLE rule (a Head
    /// joins a Tail, a Tail joins a Head), a SINGLE-TILE target with no direction, and the
    /// carrier end on the target's own INNER tile (a self-dock). The target's shape is read
    /// BEFORE the role check so the role refusal of a join is this tag too; which docks are
    /// accepted did not change.
    ///
    /// SINCE PLAN 74.1-24 (gap J11) two clauses carry their own cause instead: ends that
    /// are not one orthogonal step apart are [`BeltEndsApart`](Self::BeltEndsApart), and the
    /// U-turn facing term is [`BeltJoinTurnsBack`](Self::BeltJoinTurnsBack).
    ///
    /// What keeps its own tag: a MACHINE target keeps [`InvalidDock`](Self::InvalidDock)
    /// and its sentence; an occupied belt end is [`BeltEndTaken`](Self::BeltEndTaken) (since
    /// plan 74.1-32, [`PortOccupied`](Self::PortOccupied) before it); a port index naming no
    /// declared port, a wire carrier or a wire target, and a medium clash keep theirs.
    ///
    /// # Why it earned its own tag
    /// In usability testing, the join refusal read the machine sentence, "A belt runs
    /// from an output to an input, right next to it.", which names ports a belt end does
    /// not have and explains nothing about the rule the user broke. The user reads
    /// `REFUSAL_COPY.InvalidBeltJoin` (`Join a belt's end to the start of another belt.`,
    /// reworded by plan 74.1-24 after the walk failed J11 and again by plan 74.1-32 after the
    /// third re-walk's J11-THIRD, so it says what to do). `fabrico-host/tests/refusal_copy_truth.rs`
    /// grades it against the ROLE arm, the only one a hand reaches, and the single-tile and
    /// inner-tile arms on their tag alone.
    InvalidBeltJoin,
    /// A belt-to-belt `Dock` that would turn BACK the way it came: the U-turn (plan
    /// 74.1-24, gap J11). Produces NOTHING - no record, no fold, state byte-identical
    /// (SC#2).
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `Dock` arm's narrowed D-02 FACING TERM, when the carrier is
    /// a drawn belt and the target is a drawn belt: the carrier's outward side equals the
    /// target end's side, which on a command-built board is exactly two side-by-side belts
    /// running opposite ways with one's end beside the other's start. Both drag directions
    /// reach it (the re-walk's N4D board). The U-turn stays REFUSED (the N4D ruling, kept);
    /// only its tag moved, from [`InvalidBeltJoin`](Self::InvalidBeltJoin). A MACHINE
    /// target that fails the same term keeps [`InvalidDock`](Self::InvalidDock).
    ///
    /// # Why it earned its own tag
    /// The walk failed J11: the one rule sentence plan 74.1-18 shipped for every belt-join
    /// refusal read as APPROVING the U-turn, because its "side by side" is exactly what two
    /// U-turned belts are. The host knows which clause refused the join, so it says it:
    /// `REFUSAL_COPY.BeltJoinTurnsBack` (`A join cannot turn back the way it came.`), held
    /// true against this arm by `fabrico-host/tests/refusal_copy_truth.rs`. A `Copy`,
    /// payload-free, returned-only reject: no serialized shape moves; the wire union widens.
    BeltJoinTurnsBack,
    /// A belt-to-belt `Dock` whose two ends do not touch (plan 74.1-24, gap J11): the
    /// carrier end is not one orthogonal step from the target end, whether two or more
    /// cells away or a diagonal neighbour. Produces NOTHING - no record, no fold, state
    /// byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `Dock` arm's one-step check on a BELT target, the first half
    /// of the condition that until plan 74.1-24 returned
    /// [`InvalidBeltJoin`](Self::InvalidBeltJoin) for both halves; the other half (the
    /// target's own inner tile) keeps that tag. A MACHINE target judged by the doorstep rule
    /// keeps [`InvalidDock`](Self::InvalidDock). Only the tag moved: no dock is newly
    /// accepted or refused.
    ///
    /// # Why it earned its own tag
    /// The walk failed J11 on the re-walk's N4E board (an end two tiles from another belt's
    /// first tile): the one rule sentence's vaguest clause was the one actually broken. The
    /// user reads `REFUSAL_COPY.BeltEndsApart` (`These ends do not touch.`), held true
    /// against this arm by `fabrico-host/tests/refusal_copy_truth.rs`. A `Copy`,
    /// payload-free, returned-only reject: no serialized shape moves; the wire union widens.
    BeltEndsApart,
    /// A `Dock` whose occupied source is a drawn BELT'S END (plan 74.1-32, the third
    /// re-walk's FINDING HEAD-WORDS). Produces NOTHING - no record, no fold, state
    /// byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// The `validate_normalize` `Dock` arm's occupancy check, last of its checks, in two
    /// arms:
    /// - a HEAD dock whose carrier is a drawn belt: the carrier's own Head already feeds
    ///   something, whatever the target;
    /// - a TAIL dock whose target is a drawn belt: that belt's Head already feeds something.
    ///
    /// A machine Out or Fault that already feeds something (the spatial port or the
    /// `FAULT_PORT` sentinel) and every wire carrier keep
    /// [`PortOccupied`](Self::PortOccupied), whose sentence names the output the user really
    /// dropped on; so do `DrawWire` and `RemovePort`. Only the tag moved: which docks are
    /// accepted did not change.
    ///
    /// # Why it earned its own tag
    /// The walk dragged a joined belt end onto a free belt start and read "That output is
    /// already connected. Disconnect it first.": the user handled a belt, not an output.
    /// The user now reads `REFUSAL_COPY.BeltEndTaken` (`That belt end is already joined. Use
    /// a free end.`), held true against both arms by
    /// `fabrico-host/tests/refusal_copy_truth.rs`. A `Copy`, payload-free, returned-only
    /// reject, appended LAST: no serialized shape moves; the wire union widens to 25 tags.
    BeltEndTaken,
    /// A size change whose new box would cover a cell another node holds (phase 76, plan
    /// 76-02, D-04). Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// The `validate_normalize` `Configure` arm, on a `MachineConfig::Label` whose new
    /// width or depth reaches a cell held by a machine, a belt or another label. The walk
    /// excludes the label's OWN cells, so re-applying the committed size is never a
    /// collision with itself; a new cell past the grid edge keeps
    /// [`OutOfBounds`](Self::OutOfBounds), whose sentence is true there.
    ///
    /// # Why the name and the sentence are GENERAL on purpose
    /// Nothing in the name or in the user's sentence (`REFUSAL_COPY.ResizeCovers`, `That
    /// size would cover something. Go smaller.`) says "label": the covered thing may be a
    /// machine, a belt or a label, and the machine resize in SEED-261004-vfw is to reuse
    /// this tag rather than mint a second one for the same refusal. "Go smaller." stays
    /// true for every producer, because the committed size fits by definition.
    ///
    /// A `Copy`, payload-free, returned-only reject, appended LAST: no serialized shape
    /// moves; the wire union widens to 26 tags.
    ResizeCovers,
    /// A command tried to join a label to the flow (phase 76, plan 76-04, SHAPE-14, D-07).
    /// Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// The `validate_normalize` `Dock` arm when either the carrier or the target names a
    /// label (spatial or `FAULT_PORT`), the `DrawWire` arm when either end does, and the
    /// `AddPort` arm when the node does. It is the FIRST check after the handles resolve
    /// in all three, before any port, role, geometry or occupancy check: the non-spatial
    /// `FAULT_PORT` branch of `Dock` checks no geometry at all (WINDOWS 68), so until this
    /// variant a belt anywhere on the board was linked to a label, and `AddPort` grew one a
    /// port.
    ///
    /// # Why a NEW tag and not an existing one (decided in writing, as SHAPE-14 requires)
    /// Every existing sentence is false of a label. `InvalidDock` ("A belt runs from an
    /// output to an input, right next to it.") and `IncompatiblePorts` ("A wire connects
    /// two machines, output to input.") describe ports a label does not have and imply a
    /// right way to aim at one; `PortOccupied` and `MediumMismatch` name a port that does
    /// not exist; `Malformed` ("The host could not carry out that gesture.") says the host
    /// failed at something it understood perfectly and refuses by design. The user reads
    /// `REFUSAL_COPY.LabelDoesNotConnect`, `Labels are notes. They do not connect.`, held
    /// true against all five shapes by `fabrico-host/tests/refusal_copy_truth.rs`.
    ///
    /// No gesture reaches it: a label has no nub for the Wire or Belt tool to start from,
    /// and its panel has no Ports section. It is the host's answer to forged input.
    ///
    /// A `Copy`, payload-free, returned-only reject, appended LAST: no serialized shape
    /// moves; the wire union widens to 27 tags.
    LabelDoesNotConnect,
    /// An Undo whose restore would land on cells another node now holds (phase 86, plan
    /// 86-06, WORK-02, D-04). Produces NOTHING - no record, no fold, state byte-identical
    /// (SC#2) - and the step stays on top of the undo stack.
    ///
    /// # The step stays refused, and so does everything behind it
    /// Staying on top of the stack does NOT mean the Undo works once the space is clear
    /// (phase 86 review, WR-01). Under linear undo, whatever clears the space (a Delete or a
    /// move of the blocker) is a new step on top of the refused one: the next Ctrl+Z takes
    /// that step back and puts the blocker back, and the one after is refused again. So the
    /// refused step and every earlier step stay out of reach, and nothing on the board
    /// changes. Only a forged or hand-edited file reaches this refusal (see below).
    ///
    /// # Which arm returns it
    /// The `Delete` arm of `GridSession::compute_inverse` (Direction::Undo) checks the
    /// deleted machine's re-`Place` box and each re-drawn belt's tiles (the bare belt's own
    /// record and every cascade belt) before each claim folds: any cell already owned on the
    /// prediction board is recorded, and the refusal is returned once the whole walk has
    /// finished with no structural `Malformed`, which always wins (phase 86 review, WR-02).
    /// The prediction board is the board as the group's EARLIER records leave it, never
    /// the live core, so the undo of a move (whose `Place` inverse frees the moved machine
    /// first) is never refused against its own cells. `resolve_undo` is `&self`, so the refusal reaches the host's
    /// `apply_gesture` before anything is enqueued.
    ///
    /// # Why a NEW tag and not an existing one
    /// `FootprintCollision` ("That space is taken. Clear it or try elsewhere.") is false
    /// of an Undo: the user placed nothing and cannot choose where a restore lands, so
    /// "try elsewhere" names a choice they do not have. `Malformed` ("The host could not
    /// carry out that gesture.") says the host failed at something it refuses by design.
    /// The user reads `REFUSAL_COPY.UndoSpaceTaken`, `That space is taken now. Nothing was
    /// undone.`, held true against the real arm by `fabrico-host/tests/refusal_copy_truth.rs`.
    ///
    /// No ordinary gesture reaches it: with linear undo anything placed after a Delete is
    /// undone before the Delete is, and plan 86-02 restores a turned machine on exactly the
    /// cells it held. It is the guard that keeps every board loadable against a forged or
    /// corrupted history (`fabrico-host/tests/forged_files.rs`).
    ///
    /// A `Copy`, payload-free, returned-only reject, appended LAST: no serialized shape
    /// moves; the wire union widens to 28 tags.
    UndoSpaceTaken,
    /// A gesture naming a port the machine does not have (plan 88-02, FAIL-09, WINDOWS 81,
    /// D-11). Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// - `validate_normalize`'s `RemovePort` arm: the index is past the node's port list.
    /// - its `Configure` arm on a Router: a routing rule, or the default, names an output
    ///   index past the node's live `Role::Out` ports.
    ///
    /// Both frames are read perfectly; the port they name is not there. The user reads
    /// `REFUSAL_COPY.NoSuchPort`, "That port is not on the machine.", held true of both arms
    /// by `fabrico-host/tests/refusal_copy_truth.rs`. Until plan 88-02 both were
    /// [`Malformed`](Self::Malformed). A `Copy`, payload-free, returned-only reject: no
    /// serialized shape moves; the wire union widens.
    NoSuchPort,
    /// A gesture whose option byte names no option the app has (plan 88-02, FAIL-09,
    /// WINDOWS 81). Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// - `validate_normalize`'s `AddPort` arm: the role byte or the medium byte names no
    ///   `Role` or `Medium`.
    /// - `wire_config_to_core` (the `Configure` arm's conversion): a label colour byte that
    ///   names no `LabelColour`.
    ///
    /// The user reads `REFUSAL_COPY.UnknownOption`, "That choice is not one the app
    /// offers.", held true of all three by `fabrico-host/tests/refusal_copy_truth.rs`. Until
    /// plan 88-02 they were [`Malformed`](Self::Malformed).
    UnknownOption,
    /// A setting past a bound the app sets (plan 88-02, FAIL-09, WINDOWS 81). Produces
    /// NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// - `validate_normalize`'s `Configure` arm on a Router: more than `MAX_ROUTES` rules, or
    ///   a rule whose `expect` pattern is over `MAX_ROUTE_EXPECT_BYTES`.
    /// - the same arm on a label: text over `MAX_LABEL_BYTES`, or a width or depth outside
    ///   `1..=MAX_FOOTPRINT_DIM` or, when it changes, past `LABEL_MAX_W` / `LABEL_MAX_H`.
    ///
    /// The user reads `REFUSAL_COPY.OverLimit`, "That is outside the limits the app
    /// allows.", held true of every arm by `fabrico-host/tests/refusal_copy_truth.rs`. Until
    /// plan 88-02 they were [`Malformed`](Self::Malformed).
    OverLimit,
    /// A Route path that is not a legal address (plan 88-02, FAIL-09, WINDOWS 81): R-47's
    /// rules 1 to 3, a leading slash with something after it, the length bound, and the
    /// unreserved URL-path bytes (`fabrico_core::edit::endpoint_path_is_valid`). Produces
    /// NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// `validate_normalize`'s `Configure` arm on `MachineConfig::Endpoint`, before the
    /// uniqueness rule, which keeps [`DuplicatePath`](Self::DuplicatePath). The user reads
    /// `REFUSAL_COPY.InvalidPath`, "That is not a web path the app can serve.", held true
    /// by `fabrico-host/tests/refusal_copy_truth.rs`. Until plan 88-02 it was
    /// [`Malformed`](Self::Malformed).
    InvalidPath,
    /// An edit aimed at a node of the wrong kind for it (plan 88-02, FAIL-09, WINDOWS 81).
    /// Produces NOTHING - no record, no fold, state byte-identical (SC#2).
    ///
    /// # Which arms return it
    /// - `validate_normalize`'s `Rotate` arm on a label (a label never turns, phase 76 D-04).
    /// - its `Configure` arm: a `MachineConfig::Label` aimed at a node that is not a label.
    ///
    /// No shipped control sends either: the frame is forged or names a node that changed
    /// kind. The user reads `REFUSAL_COPY.WrongKind`, "That edit does not apply to what you
    /// picked.", held true of both by `fabrico-host/tests/refusal_copy_truth.rs`. Until plan
    /// 88-02 both were [`Malformed`](Self::Malformed).
    WrongKind,
    /// An Undo or Redo whose recorded inverse no longer fits the board (plan 88-02, FAIL-09,
    /// WINDOWS 81). Produces NOTHING - no record, no fold, state byte-identical (SC#2) - and
    /// the step stays where it was on the stack.
    ///
    /// # Which arms return it
    /// Every structural refusal of `GridSession::compute_inverse` (both directions): an
    /// inverse target that is not the node the record names, a re-mint that minted nothing,
    /// a captured belt with no tiles or with links that name no belt, a kind with no catalog,
    /// a port record with no captured box, a severed dock that will not fold back, a config
    /// whose kind no longer matches, and `non_canonical_wire_links`'s wire capture with no
    /// canonical link. Each is a history (forged, damaged or from an older build) that the
    /// board in front of the user can no longer take back. A restore over cells another node
    /// holds keeps [`UndoSpaceTaken`](Self::UndoSpaceTaken).
    ///
    /// The user reads `REFUSAL_COPY.UndoDoesNotFit`, "That step no longer fits the board.",
    /// held true by `fabrico-host/tests/refusal_copy_truth.rs` and seen on the real board by
    /// `frontend/e2e-live/88-refusal-sentences.live.spec.ts` (a forged `.fab`). Until plan
    /// 88-02 it was [`Malformed`](Self::Malformed), whose sentence named no cause.
    UndoDoesNotFit,
    /// An `AddPort` whose grown box would pass the size limit, `MAX_FOOTPRINT_DIM` on either
    /// side (plan 88-02, FAIL-09, WINDOWS 83). Produces NOTHING - no record, no fold, state
    /// byte-identical (SC#2).
    ///
    /// # Which arm returns it
    /// `validate_normalize`'s `AddPort` arm, reading the UNCLAMPED size off the shared
    /// `add_port_geometry` before any cell is walked. Until plan 88-02 it was
    /// [`OutOfBounds`](Self::OutOfBounds), whose sentence ("That cell is past the edge of the
    /// grid.") is false of a machine in the middle of the grid. The user reads
    /// `REFUSAL_COPY.MachineTooBig`, "That machine would grow past the size limit.", held
    /// true by `fabrico-host/tests/refusal_copy_truth.rs`.
    MachineTooBig,
    /// A `Rotate` whose turned box would cover another MACHINE or a label (plan 88-02,
    /// FAIL-09, WINDOWS 84). Produces NOTHING - no record, no fold, state byte-identical
    /// (SC#2).
    ///
    /// # Which arm returns it
    /// `validate_normalize`'s `Rotate` arm, when the FIRST foreign cell of the turned box's
    /// walk is not a belt (a belt keeps [`RotateCoversBelt`](Self::RotateCoversBelt)). Until
    /// plan 88-02 it was [`FootprintCollision`](Self::FootprintCollision), whose "place
    /// elsewhere" names a choice a turn does not have. The user reads
    /// `REFUSAL_COPY.RotateBlocked`, "No room to turn. Clear the space first.".
    RotateBlocked,
    /// An `AddPort` whose grown box would cover another MACHINE or a label (plan 88-02,
    /// FAIL-09, WINDOWS 84). Produces NOTHING - no record, no fold, state byte-identical
    /// (SC#2).
    ///
    /// # Which arm returns it
    /// `validate_normalize`'s `AddPort` arm, when the FIRST foreign cell of the grown box's
    /// walk is not a belt (a belt keeps [`GrowCoversBelt`](Self::GrowCoversBelt)). Until plan
    /// 88-02 it was [`FootprintCollision`](Self::FootprintCollision). The user reads
    /// `REFUSAL_COPY.GrowBlocked`, "No room to grow. Clear the space first.".
    GrowBlocked,
    /// An edit made against a board that changed before it landed (plan 88-02 adds the tag,
    /// D-03; plan 88-04's generation resolver produces it). Produces NOTHING.
    ///
    /// # Which arm returns it
    /// None yet in this crate: the host resolves a gesture's handle against the board
    /// generation the client saw, and refuses with this tag when that node is gone or the
    /// generation has fallen out of the kept history, rather than applying the edit to a
    /// different node. It lands here with the other plan 88-02 tags so the wire union moves
    /// once. The user reads `REFUSAL_COPY.BoardChanged`, "The board changed first. That edit
    /// was not made.".
    BoardChanged,
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            CommandError::FootprintCollision => "footprint overlaps a live node (placement rejected)",
            CommandError::OutOfBounds => "target cell is outside the grid bound",
            CommandError::UnknownNode => "handle resolves to no live node",
            CommandError::IncompatiblePorts => "endpoints/ports are incompatible (self-loop)",
            CommandError::PortOccupied => "output port is already wired (re-wire rejected)",
            CommandError::UnknownKind => "unknown machine kind byte",
            CommandError::BeltNotPlaceable => "belts are not placeable (use DrawBelt + Dock)",
            CommandError::InvalidDock => "ports do not form a valid dock (role/adjacency)",
            CommandError::Malformed => "the gesture frame could not be read",
            CommandError::Route(e) => return write!(f, "drawn belt path rejected: {e}"),
            CommandError::BeltTooLong => "drawn belt exceeds the maximum tile count",
            CommandError::NothingToUndo => "nothing to undo (undo stack empty)",
            CommandError::NothingToRedo => "nothing to redo (redo stack empty)",
            CommandError::MediumMismatch => "belt and port media are incompatible (dock rejected)",
            CommandError::ZeroBeltInterval => {
                "belt advance interval must be at least 1 tick per slot (zero rejected)"
            }
            CommandError::PaceOutOfRange => {
                "belt pace is outside the offered range (2..=20 ticks per slot)"
            }
            CommandError::DuplicatePath => {
                "another Route already answers at that path (duplicate rejected)"
            }
            CommandError::RotateCoversBelt => "the turned footprint would cover a belt (rotate rejected)",
            CommandError::GrowCoversBelt => "the grown footprint would cover a belt (add rejected)",
            CommandError::InvalidBeltJoin => {
                "the belt ends do not form a valid belt-to-belt join (role/single tile/inner tile)"
            }
            CommandError::BeltJoinTurnsBack => {
                "the belt-to-belt join would turn back the way it came (U-turn rejected)"
            }
            CommandError::BeltEndsApart => {
                "the belt ends are not one orthogonal step apart (join rejected)"
            }
            CommandError::BeltEndTaken => {
                "that belt end is already joined to something (dock rejected)"
            }
            CommandError::ResizeCovers => {
                "the resized box would cover a cell another node holds (resize rejected)"
            }
            CommandError::LabelDoesNotConnect => {
                "a label has no ports and joins no flow (dock, wire or port add rejected)"
            }
            CommandError::UndoSpaceTaken => {
                "the restore would land on cells another node holds (undo rejected)"
            }
            CommandError::NoSuchPort => "the named port index is not on the node (rejected)",
            CommandError::UnknownOption => "an option byte names no known role, medium or colour",
            CommandError::OverLimit => "a setting is past its bound (routes, pattern, label text or size)",
            CommandError::InvalidPath => "the Route path is not a legal address",
            CommandError::WrongKind => "the edit does not apply to the node's kind",
            CommandError::UndoDoesNotFit => "the recorded inverse no longer fits the board (undo/redo rejected)",
            CommandError::MachineTooBig => "the grown box would pass the size limit (add rejected)",
            CommandError::RotateBlocked => "the turned footprint would cover another node (rotate rejected)",
            CommandError::GrowBlocked => "the grown footprint would cover another node (add rejected)",
            CommandError::BoardChanged => "the board changed before the edit landed (rejected)",
        };
        f.write_str(msg)
    }
}

impl Error for CommandError {}

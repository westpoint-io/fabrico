//! The gesture REFUSAL wire view (ERR-02) - the ONE typed reject shape both host
//! transports converge on.
//!
//! Modelled on [`config_view`](crate::config_view): a host-side serde view that exists
//! so the headless enum never has to grow a wire shape.
//!
//! # Why the headless enum stays derive-only
//! [`fabrico_command::CommandError`] is the authoritative taxonomy and is deliberately
//! `Clone, Copy, Debug, PartialEq, Eq` and nothing more. Adding a serde derive there
//! would pin the headless taxonomy to a wire spelling and make every later variant
//! rename a frontend break. This view owns the spelling instead, host-side, where the
//! frontend contract already lives.
//!
//! # Why `Route` FLATTENS
//! `CommandError::Route(RouteError)` is the only data-carrying variant. Serialized as a
//! nested tag it would hand the frontend a two-level union for one message; flattened it
//! gives three peer tags the copy table keys on directly. The frontend never
//! reconstructs the nesting.

use fabrico_command::CommandError;
use fabrico_command::route::RouteError;

/// The gesture-refusal wire tag: `CommandError`'s 35 payload-free variants plus
/// `Route(RouteError)` flattened into its three, 38 tags. Serializes as a bare JSON string
/// (serde's default for a fieldless enum), e.g. `"FootprintCollision"`.
///
/// EXHAUSTIVE with no default arm, deliberately. A generic fallback tag is the
/// invented-generic-string ERR-02 exists to forbid, and it would let a future
/// `CommandError` variant reach the user as an unnamed refusal instead of a compile
/// error here.
///
/// The derive list is `Serialize` only, never the inbound half: nothing decodes this
/// type in Rust, and an unused inbound surface is one a later refactor mistakes for a
/// supported shape.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandErrorView {
    FootprintCollision,
    OutOfBounds,
    UnknownNode,
    IncompatiblePorts,
    PortOccupied,
    UnknownKind,
    BeltNotPlaceable,
    InvalidDock,
    Malformed,
    BeltTooLong,
    NothingToUndo,
    NothingToRedo,
    MediumMismatch,
    ZeroBeltInterval,
    PaceOutOfRange,
    /// SERVE-08 (72-07): another Route already answers at the requested path.
    /// Appended after `PaceOutOfRange`, which takes the wire union from 18 tags to 19.
    /// The REFUSAL_COPY row the frontend narrows on lands in plan 72-10, together with
    /// its `refusal_copy_truth.rs` case; the tag has to exist first, because this `From`
    /// is exhaustive and a missing arm is a compile error rather than a shipped silence.
    DuplicatePath,
    RouteEmpty,
    RouteNonAdjacent,
    RouteSelfCrossing,
    /// WR-03 (plan 74.1-18): a Rotate whose turned box would cover a belt. Appended LAST,
    /// which takes the wire union from 19 tags to 20; the `REFUSAL_COPY` row and its
    /// `refusal_copy_truth.rs` case land in the same commit.
    RotateCoversBelt,
    /// Plan 74.1-18: an output add whose grown box would cover a belt (21 tags).
    GrowCoversBelt,
    /// Plan 74.1-18, gap N4c: a belt-to-belt join that breaks the belt rule (22 tags).
    InvalidBeltJoin,
    /// Plan 74.1-24, gap J11: a belt-to-belt join that would turn back the way it came,
    /// the U-turn (23 tags).
    BeltJoinTurnsBack,
    /// Plan 74.1-24, gap J11: a belt-to-belt join whose ends do not touch (24 tags).
    BeltEndsApart,
    /// Plan 74.1-32, the third re-walk's HEAD-WORDS: a dock whose taken source is a drawn
    /// belt's end, which until then read the machine-output sentence (25 tags).
    BeltEndTaken,
    /// Plan 76-02 (phase 76, D-04): a size change whose new box would cover a cell another
    /// node holds, first produced by a label growing over a neighbour (26 tags). The name
    /// is general on purpose: the machine resize in SEED-261004-vfw reuses it.
    ResizeCovers,
    /// Plan 76-04 (phase 76, SHAPE-14, D-07): a Dock, DrawWire or AddPort naming a label,
    /// refused before any port or geometry check (27 tags). Reachable only from forged
    /// input: a label has no nub.
    LabelDoesNotConnect,
    /// Plan 86-06 (phase 86, WORK-02, D-04): an Undo whose restore would land on cells
    /// another node now holds, refused before anything is enqueued (28 tags). Reachable
    /// only from a forged or corrupted history: with linear undo, anything placed after a
    /// Delete is undone first.
    UndoSpaceTaken,
    /// Plan 88-02 (phase 88, FAIL-09, D-11): the ten tags that split `Malformed`,
    /// `OutOfBounds` and `FootprintCollision` so each sentence names one cause, plus the
    /// D-03 tag plan 88-04's resolver produces, appended together so the union moves once,
    /// from 28 tags to 38. A port the machine does not have (WINDOWS 81).
    NoSuchPort,
    /// An option byte naming no role, medium or colour (WINDOWS 81).
    UnknownOption,
    /// A setting past a bound the app sets: routes, a pattern, label text or size (WINDOWS 81).
    OverLimit,
    /// A Route path that is not a legal address (WINDOWS 81).
    InvalidPath,
    /// An edit aimed at a node of the wrong kind for it (WINDOWS 81).
    WrongKind,
    /// An Undo or Redo whose recorded inverse no longer fits the board (WINDOWS 81).
    UndoDoesNotFit,
    /// A machine that would grow past the size limit (WINDOWS 83).
    MachineTooBig,
    /// A turn blocked by another machine or a label (WINDOWS 84).
    RotateBlocked,
    /// An output add blocked by another machine or a label (WINDOWS 84).
    GrowBlocked,
    /// An edit made against a board that changed before it landed (D-03, 38 tags).
    BoardChanged,
}

impl CommandErrorView {
    /// The bare wire tag for this variant, IDENTICAL to the string serde produces for
    /// it, as a `&'static str` that needs no serializer to obtain.
    ///
    /// # Why this exists rather than a `serde_json` call at the use site
    /// The Tauri command's rejected arm is a `String` (its return type is fixed), and
    /// `fabrico-app` carries no JSON stack in its SHIPPED dependencies - only a
    /// test-only one. Reaching for `format!("{self:?}")` there would work today and
    /// drift silently the day a `#[serde(rename)]` or a variant rename lands, handing
    /// the frontend's tag narrowing a guaranteed miss and the user silence. This
    /// match is exhaustive, so a new variant is a compile error here, and
    /// `wire_tag_matches_the_serde_spelling_for_every_variant` pins every arm against
    /// the same `WIRE_TAGS` table the serde spelling itself is pinned against - so the
    /// two spellings are one contract, asserted, not two that happen to agree.
    #[must_use]
    pub fn wire_tag(self) -> &'static str {
        match self {
            Self::FootprintCollision => "FootprintCollision",
            Self::OutOfBounds => "OutOfBounds",
            Self::UnknownNode => "UnknownNode",
            Self::IncompatiblePorts => "IncompatiblePorts",
            Self::PortOccupied => "PortOccupied",
            Self::UnknownKind => "UnknownKind",
            Self::BeltNotPlaceable => "BeltNotPlaceable",
            Self::InvalidDock => "InvalidDock",
            Self::Malformed => "Malformed",
            Self::BeltTooLong => "BeltTooLong",
            Self::NothingToUndo => "NothingToUndo",
            Self::NothingToRedo => "NothingToRedo",
            Self::MediumMismatch => "MediumMismatch",
            Self::ZeroBeltInterval => "ZeroBeltInterval",
            Self::PaceOutOfRange => "PaceOutOfRange",
            Self::DuplicatePath => "DuplicatePath",
            Self::RouteEmpty => "RouteEmpty",
            Self::RouteNonAdjacent => "RouteNonAdjacent",
            Self::RouteSelfCrossing => "RouteSelfCrossing",
            Self::RotateCoversBelt => "RotateCoversBelt",
            Self::GrowCoversBelt => "GrowCoversBelt",
            Self::InvalidBeltJoin => "InvalidBeltJoin",
            Self::BeltJoinTurnsBack => "BeltJoinTurnsBack",
            Self::BeltEndsApart => "BeltEndsApart",
            Self::BeltEndTaken => "BeltEndTaken",
            Self::ResizeCovers => "ResizeCovers",
            Self::LabelDoesNotConnect => "LabelDoesNotConnect",
            Self::UndoSpaceTaken => "UndoSpaceTaken",
            Self::NoSuchPort => "NoSuchPort",
            Self::UnknownOption => "UnknownOption",
            Self::OverLimit => "OverLimit",
            Self::InvalidPath => "InvalidPath",
            Self::WrongKind => "WrongKind",
            Self::UndoDoesNotFit => "UndoDoesNotFit",
            Self::MachineTooBig => "MachineTooBig",
            Self::RotateBlocked => "RotateBlocked",
            Self::GrowBlocked => "GrowBlocked",
            Self::BoardChanged => "BoardChanged",
        }
    }
}

impl From<CommandError> for CommandErrorView {
    fn from(e: CommandError) -> Self {
        match e {
            CommandError::FootprintCollision => Self::FootprintCollision,
            CommandError::OutOfBounds => Self::OutOfBounds,
            CommandError::UnknownNode => Self::UnknownNode,
            CommandError::IncompatiblePorts => Self::IncompatiblePorts,
            CommandError::PortOccupied => Self::PortOccupied,
            CommandError::UnknownKind => Self::UnknownKind,
            CommandError::BeltNotPlaceable => Self::BeltNotPlaceable,
            CommandError::InvalidDock => Self::InvalidDock,
            CommandError::Malformed => Self::Malformed,
            CommandError::BeltTooLong => Self::BeltTooLong,
            CommandError::NothingToUndo => Self::NothingToUndo,
            CommandError::NothingToRedo => Self::NothingToRedo,
            CommandError::MediumMismatch => Self::MediumMismatch,
            CommandError::ZeroBeltInterval => Self::ZeroBeltInterval,
            CommandError::PaceOutOfRange => Self::PaceOutOfRange,
            CommandError::DuplicatePath => Self::DuplicatePath,
            CommandError::RotateCoversBelt => Self::RotateCoversBelt,
            CommandError::GrowCoversBelt => Self::GrowCoversBelt,
            CommandError::InvalidBeltJoin => Self::InvalidBeltJoin,
            CommandError::BeltJoinTurnsBack => Self::BeltJoinTurnsBack,
            CommandError::BeltEndsApart => Self::BeltEndsApart,
            CommandError::BeltEndTaken => Self::BeltEndTaken,
            CommandError::ResizeCovers => Self::ResizeCovers,
            CommandError::LabelDoesNotConnect => Self::LabelDoesNotConnect,
            CommandError::UndoSpaceTaken => Self::UndoSpaceTaken,
            CommandError::NoSuchPort => Self::NoSuchPort,
            CommandError::UnknownOption => Self::UnknownOption,
            CommandError::OverLimit => Self::OverLimit,
            CommandError::InvalidPath => Self::InvalidPath,
            CommandError::WrongKind => Self::WrongKind,
            CommandError::UndoDoesNotFit => Self::UndoDoesNotFit,
            CommandError::MachineTooBig => Self::MachineTooBig,
            CommandError::RotateBlocked => Self::RotateBlocked,
            CommandError::GrowBlocked => Self::GrowBlocked,
            CommandError::BoardChanged => Self::BoardChanged,
            // The three flattened `Route(..)` arms, spelled out individually. Prefixed
            // so a reader of the wire can see which host check produced them without
            // consulting the Rust.
            CommandError::Route(RouteError::Empty) => Self::RouteEmpty,
            CommandError::Route(RouteError::NonAdjacent) => Self::RouteNonAdjacent,
            CommandError::Route(RouteError::SelfCrossing) => Self::RouteSelfCrossing,
            // NO catch-all arm here, deliberately - the same note `config_view.rs`
            // carries on its own `From`. A `_ =>` would turn the next appended taxonomy
            // variant into an unnamed refusal shown to a user instead of a compile error
            // in this file, which is the generic-string failure ERR-02 exists to forbid,
            // reintroduced at the one place nobody would look.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `CommandError` paired with the exact wire tag it must serialize to. The
    /// table is the SPEC, and BOTH halves of the contract are needed: the exhaustive
    /// `From` match catches a MISSING arm at compile time, this table catches a WRONG
    /// tag at test time. Neither alone is enough.
    const WIRE_TAGS: [(CommandError, &str); 38] = [
        (CommandError::FootprintCollision, "FootprintCollision"),
        (CommandError::OutOfBounds, "OutOfBounds"),
        (CommandError::UnknownNode, "UnknownNode"),
        (CommandError::IncompatiblePorts, "IncompatiblePorts"),
        (CommandError::PortOccupied, "PortOccupied"),
        (CommandError::UnknownKind, "UnknownKind"),
        (CommandError::BeltNotPlaceable, "BeltNotPlaceable"),
        (CommandError::InvalidDock, "InvalidDock"),
        (CommandError::Malformed, "Malformed"),
        (CommandError::BeltTooLong, "BeltTooLong"),
        (CommandError::NothingToUndo, "NothingToUndo"),
        (CommandError::NothingToRedo, "NothingToRedo"),
        (CommandError::MediumMismatch, "MediumMismatch"),
        (CommandError::ZeroBeltInterval, "ZeroBeltInterval"),
        (CommandError::PaceOutOfRange, "PaceOutOfRange"),
        (CommandError::DuplicatePath, "DuplicatePath"),
        (CommandError::RotateCoversBelt, "RotateCoversBelt"),
        (CommandError::GrowCoversBelt, "GrowCoversBelt"),
        (CommandError::InvalidBeltJoin, "InvalidBeltJoin"),
        (CommandError::BeltJoinTurnsBack, "BeltJoinTurnsBack"),
        (CommandError::BeltEndsApart, "BeltEndsApart"),
        (CommandError::BeltEndTaken, "BeltEndTaken"),
        (CommandError::ResizeCovers, "ResizeCovers"),
        (CommandError::LabelDoesNotConnect, "LabelDoesNotConnect"),
        (CommandError::UndoSpaceTaken, "UndoSpaceTaken"),
        (CommandError::NoSuchPort, "NoSuchPort"),
        (CommandError::UnknownOption, "UnknownOption"),
        (CommandError::OverLimit, "OverLimit"),
        (CommandError::InvalidPath, "InvalidPath"),
        (CommandError::WrongKind, "WrongKind"),
        (CommandError::UndoDoesNotFit, "UndoDoesNotFit"),
        (CommandError::MachineTooBig, "MachineTooBig"),
        (CommandError::RotateBlocked, "RotateBlocked"),
        (CommandError::GrowBlocked, "GrowBlocked"),
        (CommandError::BoardChanged, "BoardChanged"),
        (CommandError::Route(RouteError::Empty), "RouteEmpty"),
        (
            CommandError::Route(RouteError::NonAdjacent),
            "RouteNonAdjacent",
        ),
        (
            CommandError::Route(RouteError::SelfCrossing),
            "RouteSelfCrossing",
        ),
    ];

    #[test]
    fn a_refusal_serializes_as_a_bare_json_string_not_an_object() {
        // No serde container attribute is applied, so serde's default for a fieldless
        // enum is a bare string. That is exactly what a copy table keyed on the tag
        // consumes; a `{"kind":...}` wrapper would buy nothing and cost a decode step.
        let value =
            serde_json::to_value(CommandErrorView::from(CommandError::FootprintCollision)).unwrap();
        assert_eq!(value, serde_json::json!("FootprintCollision"));
        assert!(
            value.is_string(),
            "a refusal tag must be a bare JSON string, got {value:?}"
        );
    }

    #[test]
    fn every_command_error_maps_to_its_own_wire_tag() {
        for (err, tag) in WIRE_TAGS {
            let value = serde_json::to_value(CommandErrorView::from(err)).unwrap();
            assert_eq!(
                value,
                serde_json::json!(tag),
                "{err:?} must serialize as {tag:?}"
            );
        }
    }

    #[test]
    fn a_specific_variant_survives_the_crossing_intact() {
        // ROADMAP criterion 2 in one line: MediumMismatch is not "an error", it is THIS
        // error, and it is still THIS error on the far side of the boundary.
        assert_eq!(
            CommandErrorView::from(CommandError::MediumMismatch),
            CommandErrorView::MediumMismatch
        );
    }

    #[test]
    fn the_three_route_arms_flatten_into_peer_tags() {
        assert_eq!(
            CommandErrorView::from(CommandError::Route(RouteError::Empty)),
            CommandErrorView::RouteEmpty
        );
        assert_eq!(
            CommandErrorView::from(CommandError::Route(RouteError::NonAdjacent)),
            CommandErrorView::RouteNonAdjacent
        );
        assert_eq!(
            CommandErrorView::from(CommandError::Route(RouteError::SelfCrossing)),
            CommandErrorView::RouteSelfCrossing
        );
    }

    #[test]
    fn wire_tag_matches_the_serde_spelling_for_every_variant() {
        // The serializer-free spelling and the serde one are ONE contract, and this is
        // where that is asserted. `fabrico-app` rejects its Tauri Promise with
        // `wire_tag()`; the dev WebSocket frames the serde string. If the two ever
        // diverged, one transport's users would get a sentence and the other's would
        // get silence, from the same refusal - the exact split-brain a single wire
        // union exists to prevent.
        for (err, tag) in WIRE_TAGS {
            let view = CommandErrorView::from(err);
            assert_eq!(view.wire_tag(), tag, "{err:?} wire_tag must be {tag:?}");
            assert_eq!(
                serde_json::to_value(view).unwrap(),
                serde_json::json!(view.wire_tag()),
                "{err:?}: wire_tag and the serde spelling must not drift",
            );
        }
    }

    /// The TypeScript source of the frontend's transport contract, embedded at COMPILE
    /// time. `include_str!` rather than a runtime read on purpose: a moved or renamed
    /// file is then a compile error in this crate instead of a test that quietly stops
    /// finding anything to check.
    const TRANSPORT_TS: &str = include_str!("../../../frontend/src/transport/transport.ts");

    /// The TypeScript declaration this test parses. Kept as a named constant so the
    /// failure message can quote the exact anchor that went missing.
    const REFUSAL_TAGS_ANCHOR: &str = "const REFUSAL_TAGS: Record<RefusalTag, true> = {";

    /// Parse the keys of the frontend's `REFUSAL_TAGS` object out of `TRANSPORT_TS`.
    ///
    /// It PANICS on a missing anchor, a missing terminator, or a body line it does not
    /// recognise, by design: a parser that quietly returned an empty list would make
    /// the set comparison below pass vacuously, which is the exact failure this whole
    /// test exists to end.
    fn frontend_refusal_tags() -> Vec<String> {
        let start = TRANSPORT_TS.find(REFUSAL_TAGS_ANCHOR).unwrap_or_else(|| {
            panic!(
                "frontend/src/transport/transport.ts no longer declares {REFUSAL_TAGS_ANCHOR:?} - \
                 the cross-language tag lock cannot see the frontend's tag set and must not \
                 pass silently"
            )
        });
        let body = &TRANSPORT_TS[start + REFUSAL_TAGS_ANCHOR.len()..];
        let end = body.find("\n};").unwrap_or_else(|| {
            panic!("the REFUSAL_TAGS object in transport.ts is not terminated by a line `}};`")
        });
        let mut out = Vec::new();
        for line in body[..end].lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }
            // Every body line must be exactly `Tag: true,`. Anything else - a spread, a
            // computed key, a commented-out entry - is a shape this parser cannot
            // certify, so it fails loudly rather than skipping the line.
            let key = line.strip_suffix(": true,").unwrap_or_else(|| {
                panic!("unrecognised REFUSAL_TAGS entry in transport.ts: {line:?}")
            });
            out.push(key.to_string());
        }
        out
    }

    /// THE CROSS-LANGUAGE TAG LOCK. A rename on the RUST side reddens HERE, which is
    /// the claim `frontend/src/transport/transport.ts` makes about this crate.
    ///
    /// # Why the Rust-only tests are not enough, and why this one is not redundant
    /// `wire_tag_matches_the_serde_spelling_for_every_variant` pins Rust against Rust:
    /// rename `MediumMismatch` on BOTH Rust sides - the variant and its `WIRE_TAGS`
    /// row - and every Rust test stays green while the frontend's `isRefusalTag`
    /// narrows the new tag to NOTHING and the refusal renders as silence. That is the
    /// shipped-silence defect this phase exists to end, reached by a refactor nobody
    /// would think to re-verify. This test is the only thing in the repo that fails on
    /// that edit.
    ///
    /// # Why `REFUSAL_TAGS` and not the `RefusalTag` union
    /// The union is what the copy table is keyed on, but `REFUSAL_TAGS` is what
    /// `isRefusalTag` narrows AGAINST at runtime - and the two are already welded on
    /// the TypeScript side by its `Record<RefusalTag, true>` type, which makes a
    /// missing key and an extra key alike a compile error there. Pinning the runtime
    /// set therefore pins both, and pins the half that can actually swallow a refusal.
    #[test]
    fn the_frontend_refusal_tag_set_matches_this_crates_wire_tags() {
        let mut rust: Vec<String> = WIRE_TAGS.iter().map(|(_, tag)| (*tag).to_string()).collect();
        let mut ts = frontend_refusal_tags();
        // Anti-vacuity: the parser found a real set, not an empty one.
        assert_eq!(
            ts.len(),
            38,
            "parser control: transport.ts must declare exactly 38 refusal tags (28 until plan \
             88-02 split Malformed, OutOfBounds and FootprintCollision into nine and added \
             BoardChanged), parsed {ts:?}",
        );
        rust.sort();
        ts.sort();
        assert_eq!(
            rust, ts,
            "the Rust wire tags and the frontend's REFUSAL_TAGS have drifted. A tag this \
             crate emits that the frontend does not know narrows to nothing and reaches \
             the user as SILENCE; a tag the frontend knows that this crate never emits is \
             dead copy. Rename on both sides or not at all.",
        );
    }

    /// The frontend's exported `LOAD_REFUSAL_KIND` literal, parsed out of `TRANSPORT_TS`.
    ///
    /// PANICS on a missing anchor or an unparseable line, by design and for the same
    /// reason `frontend_refusal_tags` does: a parser that quietly returned an empty
    /// string would make the comparison below pass vacuously, which is the exact failure
    /// this test exists to end.
    fn frontend_load_refusal_kind() -> String {
        const ANCHOR: &str = "export const LOAD_REFUSAL_KIND = ";
        let start = TRANSPORT_TS.find(ANCHOR).unwrap_or_else(|| {
            panic!("`{ANCHOR}` is gone from transport.ts - this check has nothing to compare")
        });
        let rest = &TRANSPORT_TS[start + ANCHOR.len()..];
        let open = rest
            .find('\'')
            .unwrap_or_else(|| panic!("the LOAD_REFUSAL_KIND literal must be single-quoted"));
        let close = rest[open + 1..]
            .find('\'')
            .unwrap_or_else(|| panic!("the LOAD_REFUSAL_KIND literal must be closed"))
            + open
            + 1;
        rest[open + 1..close].to_owned()
    }

    /// UNDO-09's half of "the two must not drift", and the ONLY thing that makes that
    /// sentence a check rather than a comment.
    ///
    /// The failure it exists for is measured and recorded at `transport_ws.rs`: the
    /// frontend's TEXT-frame resolver returns `false` for an unrecognised frame with NO
    /// console warning and no else branch. Rename the literal on one side alone and the
    /// load refusal is swallowed in complete silence, with every other test in the
    /// workspace green - which is the exact defect UNDO-09 exists to end, reached by a
    /// rename nobody would think to re-verify.
    #[test]
    fn the_frontend_load_refusal_kind_matches_this_crates_wire_kind() {
        let ts = frontend_load_refusal_kind();
        // Anti-vacuity: the parser found a real literal, not an empty string.
        assert!(
            !ts.is_empty(),
            "parser control: transport.ts must declare a non-empty LOAD_REFUSAL_KIND",
        );
        assert_eq!(
            ts,
            crate::transport_ws::LOAD_REFUSAL_KIND,
            "the Rust LOAD_REFUSAL_KIND and the frontend's have drifted. A `kind` this \
             crate emits that the frontend does not recognise is swallowed by the \
             reject-only resolver with no console warning, so a refused load goes back to \
             being SILENT. Rename on both sides or not at all.",
        );
        // And it is not accidentally the GESTURE discriminator: two frames sharing one
        // `kind` would route a load refusal into the payload-free banner, which is the
        // one surface `RefusalMessage.tsx`'s contract forbids it from reaching.
        assert_ne!(
            crate::transport_ws::LOAD_REFUSAL_KIND,
            crate::transport_ws::GESTURE_REFUSAL_KIND,
            "the two frame kinds must be distinct or one grammar swallows the other",
        );
    }

    /// The frontend's `SAVE_FAILURE_KIND` literal, read out of `transport.ts` (phase 90 review
    /// WR-A-03), the `frontend_load_refusal_kind` shape.
    fn frontend_save_failure_kind() -> String {
        const ANCHOR: &str = "export const SAVE_FAILURE_KIND = ";
        let start = TRANSPORT_TS.find(ANCHOR).unwrap_or_else(|| {
            panic!("`{ANCHOR}` is gone from transport.ts - this check has nothing to compare")
        });
        let rest = &TRANSPORT_TS[start + ANCHOR.len()..];
        let open = rest
            .find('\'')
            .unwrap_or_else(|| panic!("the SAVE_FAILURE_KIND literal must be single-quoted"));
        let close = rest[open + 1..]
            .find('\'')
            .unwrap_or_else(|| panic!("the SAVE_FAILURE_KIND literal must be closed"))
            + open
            + 1;
        rest[open + 1..close].to_owned()
    }

    /// Phase 90 review WR-A-03: the save-failure `kind` is the same literal on both sides, and
    /// distinct from the load refusal it shares a fan-out with.
    #[test]
    fn the_frontend_save_failure_kind_matches_this_crates_wire_kind() {
        let ts = frontend_save_failure_kind();
        assert!(!ts.is_empty(), "parser control: transport.ts must declare a non-empty SAVE_FAILURE_KIND");
        assert_eq!(
            ts,
            crate::transport_ws::SAVE_FAILURE_KIND,
            "the Rust SAVE_FAILURE_KIND and the frontend's have drifted: a failed Save would go \
             back to reading saved on the page. Rename on both sides or not at all.",
        );
        assert_ne!(
            crate::transport_ws::SAVE_FAILURE_KIND,
            crate::transport_ws::LOAD_REFUSAL_KIND,
            "the save failure shares the load refusal's fan-out, so the kinds must differ",
        );
        let frame: serde_json::Value =
            serde_json::from_str(&crate::transport_ws::save_failed_frame("x.")).expect("the frame is JSON");
        assert_eq!(frame, serde_json::json!({ "kind": ts, "reason": "x." }), "the frame's shape");
    }

    /// The frontend's `SIM_FATAL_KIND` literal, read out of `transport.ts` (phase 90, FAIL-01),
    /// the `frontend_load_refusal_kind` parser over its own anchor.
    fn frontend_sim_fatal_kind() -> String {
        const ANCHOR: &str = "export const SIM_FATAL_KIND = ";
        let start = TRANSPORT_TS.find(ANCHOR).unwrap_or_else(|| {
            panic!("`{ANCHOR}` is gone from transport.ts - this check has nothing to compare")
        });
        let rest = &TRANSPORT_TS[start + ANCHOR.len()..];
        let open = rest
            .find('\'')
            .unwrap_or_else(|| panic!("the SIM_FATAL_KIND literal must be single-quoted"));
        let close = rest[open + 1..]
            .find('\'')
            .unwrap_or_else(|| panic!("the SIM_FATAL_KIND literal must be closed"))
            + open
            + 1;
        rest[open + 1..close].to_owned()
    }

    /// FAIL-01's half of "the two must not drift" (phase 90, D-11). The frontend's TEXT-frame
    /// ladder drops an unrecognised frame in silence, so a rename on one side alone would put a
    /// stopped simulation back to a frozen board with no message, every other test green.
    #[test]
    fn the_frontend_sim_fatal_kind_matches_this_crates_wire_kind() {
        let ts = frontend_sim_fatal_kind();
        // Anti-vacuity: the parser found a real literal, not an empty string.
        assert!(
            !ts.is_empty(),
            "parser control: transport.ts must declare a non-empty SIM_FATAL_KIND",
        );
        assert_eq!(
            ts,
            crate::transport_ws::SIM_FATAL_KIND,
            "the Rust SIM_FATAL_KIND and the frontend's have drifted. A `kind` this crate \
             emits that the frontend does not recognise is dropped by the reject-only ladder, \
             so a stopped simulation goes back to being SILENT. Rename on both sides or not \
             at all.",
        );
        // And it is no other frame's discriminator, or one grammar would swallow the other.
        for other in [
            crate::transport_ws::LOAD_REFUSAL_KIND,
            crate::transport_ws::GESTURE_REFUSAL_KIND,
            crate::transport_ws::GESTURE_ACCEPT_KIND,
            crate::transport_ws::GESTURE_DISCARD_KIND,
        ] {
            assert_ne!(crate::transport_ws::SIM_FATAL_KIND, other, "the frame kinds must be distinct");
        }
    }

    /// The frontend's exported `const <name> = '<literal>'` literal, parsed out of
    /// `TRANSPORT_TS` (phase 88). PANICS on a missing anchor or an unparseable line, for the
    /// reason `frontend_load_refusal_kind` does: a parser that quietly returned an empty
    /// string would make the comparison vacuous.
    fn frontend_kind(name: &str) -> String {
        let anchor = format!("export const {name} = ");
        let start = TRANSPORT_TS.find(&anchor).unwrap_or_else(|| {
            panic!("`{anchor}` is gone from transport.ts - this check has nothing to compare")
        });
        let rest = &TRANSPORT_TS[start + anchor.len()..];
        let open = rest
            .find('\'')
            .unwrap_or_else(|| panic!("the {name} literal must be single-quoted"));
        let close = rest[open + 1..]
            .find('\'')
            .unwrap_or_else(|| panic!("the {name} literal must be closed"))
            + open
            + 1;
        rest[open + 1..close].to_owned()
    }

    /// The four verdict-channel kinds are pairwise distinct, so no reject-only grammar on
    /// the page can swallow another's frame.
    fn assert_four_kinds_distinct() {
        let kinds = [
            crate::transport_ws::GESTURE_REFUSAL_KIND,
            crate::transport_ws::GESTURE_ACCEPT_KIND,
            crate::transport_ws::GESTURE_DISCARD_KIND,
            crate::transport_ws::LOAD_REFUSAL_KIND,
        ];
        for (i, a) in kinds.iter().enumerate() {
            for b in &kinds[i + 1..] {
                assert_ne!(a, b, "two frame kinds share a literal, so one grammar swallows the other");
            }
        }
    }

    /// Phase 88 (D-06): the ACCEPT verdict's `kind`, on both sides of the language
    /// boundary. Rename it on one side alone and the page's parser drops every accept, so
    /// every follow-up waiting on one stalls, with every other test green.
    #[test]
    fn the_frontend_gesture_accept_kind_matches_this_crates_wire_kind() {
        let ts = frontend_kind("GESTURE_ACCEPT_KIND");
        assert!(!ts.is_empty(), "parser control: transport.ts must declare a non-empty GESTURE_ACCEPT_KIND");
        assert_eq!(
            ts,
            crate::transport_ws::GESTURE_ACCEPT_KIND,
            "the Rust GESTURE_ACCEPT_KIND and the frontend's have drifted. Rename on both sides or not at all.",
        );
        assert_four_kinds_distinct();
    }

    /// Phase 88 (D-05, D-06): the DISCARD verdict's `kind`, on both sides of the language
    /// boundary.
    #[test]
    fn the_frontend_gesture_discard_kind_matches_this_crates_wire_kind() {
        let ts = frontend_kind("GESTURE_DISCARD_KIND");
        assert!(!ts.is_empty(), "parser control: transport.ts must declare a non-empty GESTURE_DISCARD_KIND");
        assert_eq!(
            ts,
            crate::transport_ws::GESTURE_DISCARD_KIND,
            "the Rust GESTURE_DISCARD_KIND and the frontend's have drifted. Rename on both sides or not at all.",
        );
        assert_four_kinds_distinct();
    }

    #[test]
    fn no_two_command_errors_share_a_wire_tag() {
        // A duplicated tag would silently collapse two distinct refusals into one
        // message, which is the generic-refusal failure ERR-02 exists to end, reached
        // by a copy-paste slip instead of a catch-all arm.
        let mut seen: Vec<&str> = WIRE_TAGS.iter().map(|(_, tag)| *tag).collect();
        seen.sort_unstable();
        let count = seen.len();
        seen.dedup();
        assert_eq!(count, seen.len(), "two refusals share a wire tag: {seen:?}");
        assert_eq!(count, 38, "the wire union is exactly 38 tags: 35 payload-free CommandError \
            variants plus the three Route peers (28 until plan 88-02 added nine split tags and \
            BoardChanged)");
    }
}

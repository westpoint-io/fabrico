//! The `0008` cross-language golden render-packet — the contract anchor between
//! the Rust postcard encoder and the hand-rolled TypeScript decoder (16-03). The
//! successor to the (deleted) `0007` golden: it pins the new ports-on-the-wire
//! shape — `NodeView.ports[]` (`PortView`) and `BeltView.docks[]` (`BeltDockView`).
//!
//! Two parts, mirroring `fabrico-core/tests/regen.rs` freezer discipline:
//!   - [`freeze_0008`] (`#[ignore]`d) is the ONLY writer: it postcard-encodes the
//!     known [`fixture_packet`] to `tests/fixtures/0008-render-packet.bin` and the
//!     same packet as pretty JSON to `tests/fixtures/0008-render-packet.expected.json`.
//!     `cargo test` NEVER runs it, so the fixture is never silently regenerated;
//!     re-freezing is an explicit, reviewed act:
//!     `cargo test -p fabrico-protocol freeze_0008 -- --ignored`
//!   - [`golden_0008_matches_frozen`] (always runs) re-encodes the same literal and
//!     asserts it equals the committed `.bin` bytes — so any schema drift FAILS CI
//!     instead of silently re-blessing.
//!
//! Cross-language consumer: `frontend/src/protocol/decode.test.ts` (16-03) reads
//! `crates/fabrico-protocol/tests/fixtures/0008-render-packet.bin` via a relative
//! path, decodes it with the hand-rolled varint decoder, and asserts the decoded
//! object deep-equals `0008-render-packet.expected.json`. The `.bin` is the byte
//! truth; the `.json` is the human/TS-readable expected object.
//!
//! `fabrico-protocol` has no determinism clippy gate of its own, but the workspace
//! `clippy.toml` bans `std::fs::*`; this freezer legitimately needs it, so it
//! carries the same file-scoped escape `regen.rs` uses — SCOPED to this one file.
#![allow(clippy::disallowed_methods)] // golden freezer: needs std::fs (write/read); freeze step is #[ignore]d.

use fabrico_protocol::{
    BeltDockView, BeltEnd, BeltView, ItemView, LabelView, NodeView, PortView, RenderPacket,
    TileKindView, TileView, WireDockView, WirePulseView, WireView, machine_kind, port_medium,
    port_role, state_tag,
};

/// Absolute path to the frozen postcard bytes (resolved at compile time so the
/// test is CWD-independent).
const BIN_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/0008-render-packet.bin");
/// Absolute path to the human/TS-readable expected JSON sibling.
const JSON_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/0008-render-packet.expected.json"
);

/// The known, fully-populated `0008` packet — a deterministic literal:
/// tick 8, three NodeViews at distinct cells/kinds/states, one BeltView with
/// `latency > 0` carrying two ItemViews at distinct arrival ticks.
///
/// PORTS-ON-THE-WIRE re-bless: node 100 is a multi-cell rotated machine
/// (`w:2, h:3, rot:1`) carrying THREE `PortView`s at distinct world cells/sides —
/// one `In`, one `Out`, and one `Fault` (`port_role::FAULT`, a hand-written literal:
/// no core node sources a fault port yet — Phase 17 — so the golden pins the
/// reserved Fault wire byte, PORT-02). Node 101 stays the degenerate `1×1 rot0`
/// case with an EMPTY `ports` vec (pins the port-less path). The BeltView carries a
/// `Straight` AND a `Corner` `TileView` (unchanged tile coverage) PLUS a `docks` vec
/// with one `Head` and (since Phase 74) TWO `Tail` `BeltDockView`s (PORT-03/05).
///
/// PHASE 62 RE-BLESS (SLOT-03): the `BeltView` now also pins `ticks_per_slot`, the
/// belt's own advance interval, appended LAST after `docks`. It is HAND-TYPED at a
/// non-default value so the fixture proves the field is genuinely CARRIED rather than
/// proving that a construction default survived a round trip - see the literal's own
/// comment. This is the only fixture in the repo that re-freezes for the wire append:
/// `fabrico-protocol` is ephemeral sim-to-render IPC, so it drives no snapshot, edit,
/// event or command version bump.
///
/// PHASE 71 RE-BLESS (PILE-08): `NodeView` gains `load`, the inbox gauge LEVEL,
/// appended LAST after `ports`, and `state_tag` gains a fourth value BACKED_UP = 3.
/// A THIRD node (102) carries that state byte with `load: 4`, and the two existing
/// nodes carry DISTINCT loads (2 and 0) so the field is pinned at more than one
/// value rather than at a single constant.
///
/// PHASE 76 RE-BLESS (plan 76-02, D-02): `NodeView` gains `label`, appended LAST after
/// `load`. A FOURTH node (103, a LABEL) carries `Some` with multibyte text and sits
/// between 101 and 102; every other node carries `None`. See the literal's own comment.
///
/// PHASE 88 RE-BLESS (plan 88-03, D-02, D-05): `RenderPacket` gains `generation`, the
/// board generation of the handle table the packet's handles belong to, appended LAST after
/// `resync`. It is pinned at a NONZERO value (7) so a reader that skips it is caught.
///
/// PHASE 88 SECURITY RE-BLESS (T-88-11): `RenderPacket` gains `swap_floor`, the generation
/// the last board swap installed, appended LAST after `generation` and pinned at 5.
///
/// THE NODE ORDERING IS LOAD-BEARING AND NOT INCIDENTAL. Node 100 carries a
/// non-empty `ports` vec AND is followed by two further nodes. `decode.ts` reads
/// this struct POSITIONALLY, so a `load` byte written by Rust with no matching
/// `r.u8()` in the TypeScript reader is not a missing gauge: node 100's stray
/// trailing byte is fed into node 101's `id` varint and the parse visibly diverges.
/// A one-node fixture would leave that byte merely trailing, which a non-consuming
/// decoder ignores. The cross-language assertions in
/// `frontend/src/protocol/decode.test.ts` are what read this ordering.
fn fixture_packet() -> RenderPacket {
    RenderPacket {
        tick: 8,
        full: true,
        placed: vec![
            NodeView {
                id: 100,
                kind: machine_kind::ROUTER,
                cell_x: 0,
                cell_y: 0,
                state: state_tag::WORKING,
                // A multi-cell rotated machine (e.g. a 2x3 ROUTER, rot 1).
                w: 2,
                h: 3,
                rot: 1,
                // Three host-resolved WORLD ports at distinct cells/sides exercising
                // In, Out AND the reserved Fault wire byte (Fault has no core source
                // yet — this literal pins the byte ahead of Phase 17, PORT-02).
                ports: vec![
                    PortView {
                        index: 0,
                        cell_x: 0,
                        cell_y: 0,
                        side: 3, // W
                        role: port_role::IN,
                        medium: port_medium::MECHANICAL,
                    },
                    PortView {
                        index: 1,
                        cell_x: 1,
                        cell_y: 2,
                        side: 1, // E
                        role: port_role::OUT,
                        medium: port_medium::MECHANICAL,
                    },
                    PortView {
                        index: 2,
                        cell_x: 0,
                        cell_y: 2,
                        side: 2, // S
                        role: port_role::FAULT,
                        medium: port_medium::MECHANICAL,
                    },
                ],
                // A MID-BAND gauge (6..=10 items against the cap of 16). A distinct
                // non-zero, non-full value, so the byte is pinned at three different
                // readings across the three nodes rather than at one constant.
                load: 2,
                // Not a label (phase 76): the option is `None`, one zero byte.
                label: None,
            },
            NodeView {
                id: 101,
                kind: machine_kind::SINK,
                cell_x: 5,
                cell_y: 2,
                state: state_tag::IDLE,
                // The degenerate 1x1 rot0 case (a footprint-less node).
                w: 1,
                h: 1,
                rot: 0,
                // Pin the empty-ports (port-less node) case.
                ports: vec![],
                // An EMPTY inbox: the gauge draws nothing at all.
                load: 0,
                label: None,
            },
            // PHASE 76 RE-BLESS (plan 76-02, D-02): `NodeView` gains `label`, appended LAST
            // after `load`, `Some(LabelView)` for a label and `None` for every other node.
            // This LABEL node (kind 11, the placed 4x1 box, no ports) carries `Some` with
            // MULTIBYTE UTF-8 text (12 bytes in 8 characters) and colour 3, Lilac, so the
            // TypeScript reader's option tag, its byte-length string read and the colour
            // byte are all pinned. It sits BETWEEN two other nodes on purpose: a reader
            // that skipped the option, or sized the string in characters, would feed a
            // stray byte into node 102's `id` and the parse would visibly diverge.
            NodeView {
                id: 103,
                kind: machine_kind::LABEL,
                cell_x: 2,
                cell_y: 6,
                state: state_tag::IDLE,
                w: 4,
                h: 1,
                rot: 0,
                ports: vec![],
                load: 0,
                label: Some(LabelView {
                    text: "Caf\u{e9} \u{6ce8}\u{6587}".to_owned(),
                    colour: 3,
                }),
            },
            // The PILE-08 node: at the mechanical admission cap, so it is refusing
            // further belt deliveries. `state` is the fourth byte and `load` is the
            // top level, and the pair is exactly the cross-invariant the host
            // asserts (BACKED_UP implies a full gauge, and a full gauge on a machine
            // that is not FAULTED implies BACKED_UP). Placed LAST so a missed
            // positional read upstream lands inside this node rather than merely
            // trailing the packet.
            NodeView {
                id: 102,
                kind: machine_kind::SINK,
                cell_x: 9,
                cell_y: 7,
                state: state_tag::BACKED_UP,
                w: 1,
                h: 1,
                rot: 0,
                // One mechanical In nub, the port a jammed belt is docked to.
                ports: vec![PortView {
                    index: 0,
                    cell_x: 9,
                    cell_y: 7,
                    side: 3, // W
                    role: port_role::IN,
                    medium: port_medium::MECHANICAL,
                }],
                load: 4,
                label: None,
            },
        ],
        removed: vec![],
        belts: vec![BeltView {
            id: 200,
            latency: 8,
            fill: 1024,
            items: vec![
                ItemView {
                    arrival_tick: 15,
                    tag: 1,
                },
                ItemView {
                    arrival_tick: 18,
                    tag: 3,
                },
            ],
            // Exercise BOTH tile shapes: a Straight (axis X=0) then a Corner
            // (from E=1, to S=2), integer-only Axis/Dir bytes.
            tiles: vec![
                TileView {
                    cell_x: 0,
                    cell_y: 0,
                    kind: TileKindView::Straight { axis: 0 },
                },
                TileView {
                    cell_x: 1,
                    cell_y: 0,
                    kind: TileKindView::Corner { from: 1, to: 2 },
                },
            ],
            // Per-end dock metadata (PORT-03), deterministic Head-before-Tail:
            // the Head docks the belt's deliver end to node 101's In port; the Tail
            // docks its admit end to node 100's Out port (index 1).
            //
            // PHASE 74 RE-BLESS (LINK-13): a SECOND Tail entry, node 100's FAULT port
            // (index 2). Until this phase a belt could carry only one Tail entry no
            // matter how many links targeted it, because `belt_docks` bound a single
            // upstream with a find-first lookup over the core link graph; it now emits
            // one entry per upstream. This literal is the cross-language pin of that
            // shape, and there was no fixture in the repository carrying it.
            //
            // THE SECOND UPSTREAM IS A REAL BOARD, NOT A SHAPE INVENTED FOR THE WIRE.
            // Two links whose TARGET is `(belt, 0)` and whose FROM keys differ are both
            // accepted: `(100, 1) -> (200, 0)` is the router's Out port offloading, and
            // `(100, 2) -> (200, 0)` is its Fault port offloading onto the same belt,
            // which is the shipped fault-drain topology. LINK-06's occupancy guard keys
            // on the FROM pair, so it refuses neither.
            //
            // THE ORDER IS THE PRODUCER'S, not a choice made here: `links_iter` is a
            // BTreeMap walk in ascending `(node, port)` key order, so `(100, 1)`
            // precedes `(100, 2)`. Head still comes before every Tail.
            //
            // `BeltView` GAINS NO FIELD. D-05 keeps `ports` off the wire and the
            // frontend derives belt end positions from `BeltView.tiles`, so these bytes
            // move for the second-upstream reason and for nothing else.
            docks: vec![
                BeltDockView {
                    end: BeltEnd::Head,
                    node: 101,
                    port: 0,
                },
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: 100,
                    port: 1,
                },
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: 100,
                    port: 2,
                },
            ],
            // SLOT-03 (Phase 62): the belt's own advance interval, appended LAST on
            // the wire after `docks`.
            //
            // HAND-TYPED, AND DELIBERATELY NOT THE CRATE DEFAULT. Reading
            // `DEFAULT_TICKS_PER_SLOT` into this fixture would make the expectation
            // agree with the thing it checks at every value (the trap
            // `belt_slots.rs`'s own pin docblock and `project.rs`'s hand-typed
            // refusal literals both name), so the golden would prove only that a
            // default survived, not that the field is carried at all. A hand-typed
            // literal also means this fixture never needs re-freezing again when the
            // default moves in plan 62-09.
            //
            // 7 is a FIXTURE literal and NOT a proposed pace: the shipped interval is
            // a maintainer's choice, made during the pace review. It is deliberately a number no candidate could be - D-06 puts
            // a hard Nyquist floor under the slowdown that keeps any real candidate
            // far below this - so nobody can later mistake this byte for a decision.
            ticks_per_slot: 7,
        }],
        // UNDO-06 availability bools (render-only, appended after belts). Distinct
        // values (true/false) pin BOTH trailing wire positions in the cross-language
        // golden so the TS decoder's conditional trailing read (19-05) is exercised.
        can_undo: true,
        can_redo: false,
        // WUI-01 electrical-wire projections, appended LAST (after can_redo). One
        // WireView pins the whole append-LAST tail for the cross-language decoder:
        // two endpoint docks ((node,port) handles), a route()-normalized path with a
        // Straight AND a Corner TileView (mirrors the belt tile coverage), and one
        // in-flight pulse carrying entry_tick/hop_ticks and the host-derived REPLY
        // direction byte (1) so the reply-home read is exercised in the golden.
        wires: vec![WireView {
            id: 300,
            from: WireDockView { node: 100, port: 1 },
            to: WireDockView { node: 101, port: 0 },
            path: vec![
                TileView {
                    cell_x: 0,
                    cell_y: 0,
                    kind: TileKindView::Straight { axis: 0 },
                },
                TileView {
                    cell_x: 1,
                    cell_y: 0,
                    kind: TileKindView::Corner { from: 1, to: 2 },
                },
            ],
            pulses: vec![WirePulseView {
                entry_tick: 6,
                hop_ticks: 1,
                direction: 1, // WIRE_REPLY — the reply-home read
            }],
        }],
        // 73-12 (WR-01): appended LAST, after `wires`. FALSE on every packet a
        // producer builds; only a transport's lag-resync arm sets it.
        resync: false,
        // PHASE 88 RE-BLESS (D-02, D-05): appended LAST, after `resync`. NONZERO on
        // purpose: a decoder that never reads the field and defaults it to 0 would pass a
        // fixture frozen at 0, so 7 is what makes the cross-language deep-equal in
        // `decode.test.ts` see a missing read.
        generation: 7,
        // PHASE 88 SECURITY RE-BLESS (T-88-11): appended LAST, after `generation`. NONZERO
        // and different from the generation, so a reader that skips it or reads the
        // generation twice is caught by the cross-language deep-equal.
        swap_floor: 5,
    }
}

/// FREEZER — `#[ignore]`d so `cargo test` never runs it. Run explicitly to
/// (re)bless the fixture, then COMMIT the produced `.bin` + `.expected.json`:
///   `cargo test -p fabrico-protocol freeze_0008 -- --ignored`
#[test]
#[ignore = "explicit golden freezer; writes the committed 0008 fixture"]
fn freeze_0008() {
    let pkt = fixture_packet();

    let bytes = postcard::to_allocvec(&pkt).expect("encode 0008 packet");
    let json = serde_json::to_string_pretty(&pkt).expect("pretty-json 0008 packet");

    let dir = std::path::Path::new(BIN_PATH)
        .parent()
        .expect("fixture path has a parent dir");
    std::fs::create_dir_all(dir).expect("create fixtures dir");
    std::fs::write(BIN_PATH, &bytes).expect("write 0008 .bin");
    std::fs::write(JSON_PATH, format!("{json}\n")).expect("write 0008 .expected.json");
}

/// GUARD — always runs. Re-encodes the literal and asserts byte-equality with the
/// committed fixture; schema drift fails here rather than silently regenerating.
#[test]
fn golden_0008_matches_frozen() {
    let bytes = postcard::to_allocvec(&fixture_packet()).expect("encode 0008 packet");
    let frozen = std::fs::read(BIN_PATH)
        .expect("0008 fixture committed; run `freeze_0008 -- --ignored` to bless it");
    assert_eq!(
        bytes, frozen,
        "0008 render-packet drifted from the frozen bytes — re-bless deliberately, never silently",
    );
}

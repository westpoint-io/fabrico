//! Postcard round-trip discipline for every wire DTO.
//!
//! Mirrors `fabrico-core::event::tests::event_round_trips_byte_identical`: each
//! representative value must `encode -> decode` back equal AND re-encode
//! byte-identically. Byte-identical re-encode is the contract that lets the host
//! (07-04) and the TS decoder (07-05) agree on a single canonical byte stream
//! (threat T-07-WIRE-FLOAT / T-07-WIRE-DRIFT).

use fabrico_protocol::{
    BeltDockView, BeltEnd, BeltView, GridCommand, HttpMethod, ItemView, LabelView, MachineConfig,
    NodeView, PortView, RenderPacket, SinkTemplate, SourceTrigger, TileKindView, TileView, WireDockView,
    WirePulseView, WireView, machine_kind, port_medium, port_role, state_tag,
};

/// A fully-populated packet exercising every nested DTO (>=1 NodeView with a
/// non-trivial footprint, >=1 BeltView carrying >=1 ItemView AND >=1 of each
/// TileView shape).
fn sample_packet() -> RenderPacket {
    RenderPacket {
        tick: 42,
        full: true,
        placed: vec![
            NodeView {
                id: 1,
                kind: machine_kind::SOURCE,
                cell_x: -3,
                cell_y: 7,
                state: state_tag::WORKING,
                w: 1,
                h: 1,
                rot: 0,
                // Two ports at distinct cells/sides exercising IN and OUT.
                ports: vec![
                    PortView {
                        index: 0,
                        cell_x: -3,
                        cell_y: 7,
                        side: 0,
                        role: port_role::IN,
                        medium: port_medium::MECHANICAL,
                    },
                    PortView {
                        index: 1,
                        cell_x: -2,
                        cell_y: 7,
                        side: 1,
                        role: port_role::OUT,
                        medium: port_medium::MECHANICAL,
                    },
                ],
                // The PILE-08 gauge level, appended LAST after `ports`.
                load: 3,
                // Not a label: the phase-76 option is `None`.
                label: None,
            },
            NodeView {
                id: 2,
                kind: machine_kind::SINK,
                cell_x: 9,
                cell_y: -1,
                state: state_tag::IDLE,
                w: 2,
                h: 3,
                rot: 3,
                // Pin the empty-ports case.
                ports: vec![],
                // An empty inbox reads level 0.
                load: 0,
                label: None,
            },
            // Phase 76 (plan 76-02): a LABEL carrying `Some(LabelView)` with multibyte
            // UTF-8 text, so the option tag, the byte-length-prefixed string and the
            // colour byte all round-trip.
            NodeView {
                id: 3,
                kind: machine_kind::LABEL,
                cell_x: 4,
                cell_y: 4,
                state: state_tag::IDLE,
                w: 6,
                h: 2,
                rot: 0,
                ports: vec![],
                load: 0,
                label: Some(LabelView {
                    text: "Caf\u{e9} \u{6ce8}\u{6587}".to_string(),
                    colour: 3,
                }),
            },
        ],
        removed: vec![3, 4],
        belts: vec![BeltView {
            id: 10,
            latency: 12,
            fill: 600,
            items: vec![
                ItemView {
                    arrival_tick: 54,
                    tag: 1,
                },
                ItemView {
                    arrival_tick: 60,
                    tag: 2,
                },
            ],
            tiles: vec![
                TileView {
                    cell_x: -3,
                    cell_y: 7,
                    kind: TileKindView::Straight { axis: 1 },
                },
                TileView {
                    cell_x: -3,
                    cell_y: 8,
                    kind: TileKindView::Corner { from: 2, to: 1 },
                },
            ],
            // One Head dock and one Tail dock (PORT-03).
            docks: vec![
                BeltDockView {
                    end: BeltEnd::Head,
                    node: 2,
                    port: 0,
                },
                BeltDockView {
                    end: BeltEnd::Tail,
                    node: 1,
                    port: 1,
                },
            ],
            // SLOT-03: the belt's own advance interval, appended LAST after `docks`.
            // HAND-TYPED and deliberately NOT the crate default: a literal read from
            // `DEFAULT_TICKS_PER_SLOT` would agree with that constant at every value,
            // so it would prove the field round-trips only when it happens to be the
            // default. 7 is a fixture literal and NOT a proposed belt speed - the
            // shipped interval is a deliberate design choice.
            ticks_per_slot: 7,
        }],
        // UNDO-06 availability bools (render-only, appended after belts).
        can_undo: true,
        can_redo: false,
        // WUI-01 electrical-wire projection, appended LAST (after can_redo): two
        // endpoint docks, a route()-normalized path (Straight + Corner), and one
        // directed in-flight pulse (direction 1 = REPLY).
        wires: vec![WireView {
            id: 20,
            from: WireDockView { node: 1, port: 1 },
            to: WireDockView { node: 2, port: 0 },
            path: vec![
                TileView {
                    cell_x: -3,
                    cell_y: 7,
                    kind: TileKindView::Straight { axis: 0 },
                },
                TileView {
                    cell_x: -2,
                    cell_y: 7,
                    kind: TileKindView::Corner { from: 1, to: 2 },
                },
            ],
            pulses: vec![WirePulseView {
                entry_tick: 40,
                hop_ticks: 1,
                direction: 1,
            }],
        }],
        // 73-12 (WR-01): appended LAST, after `wires`. FALSE on every packet a
        // producer builds; only a transport's lag-resync arm sets it.
        resync: false,
        // Phase 88 (D-02): appended LAST, after `resync`. Nonzero and past one varint
        // byte, so the round trip carries a multi-byte value.
        generation: 300,
        // Phase 88 security (T-88-11): appended LAST, after `generation`. Nonzero, below the
        // generation as on the wire, and past one varint byte.
        swap_floor: 200,
    }
}

fn assert_round_trips<T>(value: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let bytes = postcard::to_allocvec(value).expect("serialize");
    let restored: T = postcard::from_bytes(&bytes).expect("deserialize");
    assert_eq!(value, &restored, "decode must equal the original");
    let bytes2 = postcard::to_allocvec(&restored).expect("re-serialize");
    assert_eq!(bytes, bytes2, "re-encode must be byte-identical");
}

#[test]
fn render_packet_round_trips_byte_identical() {
    assert_round_trips(&sample_packet());
}

#[test]
fn node_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().placed[0]);
}

#[test]
fn belt_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().belts[0]);
}

#[test]
fn item_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().belts[0].items[0]);
}

#[test]
fn port_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().placed[0].ports[0]);
}

#[test]
fn belt_dock_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().belts[0].docks[0]);
}

#[test]
fn wire_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().wires[0]);
}

#[test]
fn wire_pulse_view_round_trips_byte_identical() {
    assert_round_trips(&sample_packet().wires[0].pulses[0]);
}

#[test]
fn grid_command_place_round_trips_byte_identical() {
    assert_round_trips(&GridCommand::Place {
        kind: machine_kind::FACTORY,
        cell_x: -5,
        cell_y: 8,
    });
}

#[test]
fn grid_command_delete_round_trips_byte_identical() {
    assert_round_trips(&GridCommand::Delete { node: 7 });
}

#[test]
fn grid_command_configure_round_trips_byte_identical() {
    // The representative Configure the cross-language fixture also freezes: a Factory
    // config carrying a short JS string (disc 9, no code_hash on the wire).
    assert_round_trips(&GridCommand::Configure {
        node: 42,
        config: MachineConfig::Factory {
            source: "export default (x) => x + 1".to_string(),
        },
    });
}

#[test]
fn grid_command_configure_label_round_trips_byte_identical() {
    // Phase 76 (plan 76-02): the seventh config variant, text, colour byte and size.
    assert_round_trips(&GridCommand::Configure {
        node: 11,
        config: MachineConfig::Label {
            text: "Order intake".to_string(),
            colour: 5,
            w: 16,
            h: 8,
        },
    });
}

#[test]
fn grid_command_configure_source_timer_round_trips_byte_identical() {
    assert_round_trips(&GridCommand::Configure {
        node: 7,
        config: MachineConfig::Source {
            trigger: SourceTrigger::Timer { interval_ticks: 60 },
        },
    });
}

#[test]
fn grid_command_configure_sink_http_round_trips_byte_identical() {
    // Pins the deepest nested wire path: Sink -> Http -> a non-default HttpMethod.
    assert_round_trips(&GridCommand::Configure {
        node: 3,
        config: MachineConfig::Sink {
            target: SinkTemplate::Http {
                url: "http://127.0.0.1/hook".to_string(),
                method: HttpMethod::Patch,
            },
        },
    });
}

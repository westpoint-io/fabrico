//! The cross-crate `MachineConfig` discriminant guard (63-04, threat T-63-25).
//!
//! `fabrico_core::edit::MachineConfig` and `fabrico_protocol::MachineConfig` are ONE
//! contract written twice: the core enum is the byte truth the edit-log stores, the
//! protocol enum is the `TS`-derived wire mirror the frontend encodes against (the A3
//! wire-DTO-owner discipline keeps the core off ts-rs). Their variant ORDER is
//! load-bearing, because postcard encodes an enum by declaration index, and both crates
//! state that order as hand-maintained PROSE — in the core enum's header, in the protocol
//! enum's header, and again inside `GridCommand::Configure`'s doc.
//!
//! Until this file existed NOTHING checked that claim. Not for the two variants Phase 63
//! appended, and not for the three that shipped in Phase 39 either: the frozen
//! `configure-gridcommand.bin` fixture pins the WIRE bytes against themselves, never the
//! wire against the core. This file is the machine that holds the two enums together. It
//! builds an equivalent value on each side of all seven variants, postcard-encodes both,
//! and asserts the byte vectors are equal — plus the leading discriminant byte on its
//! own, so a failure names WHICH variant drifted instead of only reporting that some
//! bytes differ.
//!
//! It lives in `fabrico-command` rather than in `fabrico-protocol/tests/` on purpose.
//! `fabrico-protocol` has no dependency on `fabrico-core`, dev or otherwise, and that is
//! deliberate — the protocol crate defines wire shapes and depends on nothing of the sim.
//! Adding a dev-dependency to write this test would give it one and would move
//! `Cargo.lock`, which check 4 of the core-freeze gate refused. `fabrico-command`
//! already depends on both crates and already owns the conversion between them.

use std::num::NonZeroU32;

use fabrico_core::edit::{MachineConfig as Core, SourceTrigger as CoreTrigger};
use fabrico_core::state::{
    HttpMethod as CoreMethod, LabelColour, RouteKey as CoreRouteKey, SinkTemplate as CoreSink,
};
use fabrico_protocol::{
    HttpMethod as WireMethod, MachineConfig as Wire, RouteKey as WireRouteKey,
    SinkTemplate as WireSink, SourceTrigger as WireTrigger,
};

/// Encode both sides, then assert (a) the leading discriminant byte is `expected` on each
/// and (b) the whole encodings are byte-equal. `name` appears in every failure message.
fn assert_parity(name: &str, expected: u8, core: &Core, wire: &Wire) {
    let core_bytes = postcard::to_allocvec(core).expect("the core config encodes");
    let wire_bytes = postcard::to_allocvec(wire).expect("the wire config encodes");

    assert_eq!(
        core_bytes[0], expected,
        "{name}: the CORE variant must sit at discriminant {expected}, found {}",
        core_bytes[0]
    );
    assert_eq!(
        wire_bytes[0], expected,
        "{name}: the WIRE variant must sit at discriminant {expected}, found {}",
        wire_bytes[0]
    );
    assert_eq!(
        core_bytes, wire_bytes,
        "{name}: the core and wire encodings have drifted apart"
    );
}

#[test]
fn factory_config_is_discriminant_zero_on_both_sides() {
    const JS: &str = "export default function (input, ctx) { ctx.emit(0, input); }";
    assert_parity(
        "Factory",
        0,
        &Core::Factory { source: JS.to_owned() },
        &Wire::Factory { source: JS.to_owned() },
    );
}

#[test]
fn source_config_is_discriminant_one_on_both_sides() {
    assert_parity(
        "Source{Webhook}",
        1,
        &Core::Source { trigger: CoreTrigger::Webhook },
        &Wire::Source { trigger: WireTrigger::Webhook },
    );
    // The nested trigger enum carries its own load-bearing order (Webhook=0, Timer=1),
    // so exercise both arms rather than only the fieldless one.
    assert_parity(
        "Source{Timer}",
        1,
        &Core::Source {
            trigger: CoreTrigger::Timer { interval_ticks: 60 },
        },
        &Wire::Source {
            trigger: WireTrigger::Timer { interval_ticks: 60 },
        },
    );
}

#[test]
fn sink_config_is_discriminant_two_on_both_sides() {
    assert_parity(
        "Sink{Debug}",
        2,
        &Core::Sink { target: CoreSink::Debug },
        &Wire::Sink { target: WireSink::Debug },
    );
    // The nested `SinkTemplate` and `HttpMethod` orders are load-bearing too.
    assert_parity(
        "Sink{Http}",
        2,
        &Core::Sink {
            target: CoreSink::Http {
                url: "https://example.invalid/hook".to_owned(),
                method: CoreMethod::Patch,
            },
        },
        &Wire::Sink {
            target: WireSink::Http {
                url: "https://example.invalid/hook".to_owned(),
                method: WireMethod::Patch,
            },
        },
    );
}

#[test]
fn belt_config_is_discriminant_three_on_both_sides() {
    // The one variant whose two sides carry DIFFERENT Rust types: the core holds
    // `NonZeroU32` (the invariant lives in the type) and the wire holds a plain `u32`
    // (this crate's wire grammar permits plain integers only, the `BeltView` precedent).
    // The parity assertion is what makes that asymmetry safe rather than merely intended.
    assert_parity(
        "Belt",
        3,
        &Core::Belt {
            ticks_per_slot: NonZeroU32::new(12).expect("12 is non-zero"),
        },
        &Wire::Belt { ticks_per_slot: 12 },
    );
}

#[test]
fn router_config_is_discriminant_four_on_both_sides() {
    let routes_core = vec![
        (CoreRouteKey::new(0, b"alpha".to_vec()), 1u16),
        (CoreRouteKey::new(3, b"beta".to_vec()), 2u16),
    ];
    let routes_wire = vec![
        (
            WireRouteKey {
                offset: 0,
                expect: b"alpha".to_vec(),
            },
            1u16,
        ),
        (
            WireRouteKey {
                offset: 3,
                expect: b"beta".to_vec(),
            },
            2u16,
        ),
    ];
    assert_parity(
        "Router",
        4,
        &Core::Router {
            routes: routes_core,
            default: Some(7),
        },
        &Wire::Router {
            routes: routes_wire,
            default: Some(7),
        },
    );

    // The empty table with no default is a legal, meaningful value (everything routes to
    // the fault port), and its encoding is where a stray length or Option byte would show.
    assert_parity(
        "Router{empty}",
        4,
        &Core::Router {
            routes: vec![],
            default: None,
        },
        &Wire::Router {
            routes: vec![],
            default: None,
        },
    );
}

#[test]
fn endpoint_config_is_discriminant_five_on_both_sides() {
    // SERVE-08 (72-07): the SIXTH variant, appended STRICTLY LAST on both sides. The
    // discriminant assertion inside `assert_parity` is the load-bearing half here: it is
    // what turns "we appended it last" from a claim in two docblocks into a measurement.
    assert_parity(
        "Endpoint",
        5,
        &Core::Endpoint {
            path: "/orders".to_owned(),
        },
        &Wire::Endpoint {
            path: "/orders".to_owned(),
        },
    );
    // A multi-segment path, because that is the shape D-15 and the approved hint copy
    // use and the one a slash-handling difference between the two sides would show up in.
    assert_parity(
        "Endpoint{multi-segment}",
        5,
        &Core::Endpoint {
            path: "/users/42".to_owned(),
        },
        &Wire::Endpoint {
            path: "/users/42".to_owned(),
        },
    );
}

#[test]
fn appending_endpoint_moved_no_earlier_variant_byte() {
    // The append argument, stated as an assertion rather than left to the five
    // discriminant cases above to imply. Each earlier variant's LEADING byte is pinned
    // against the literal it carried before `Endpoint` existed; postcard encodes by
    // declaration index, so an insertion anywhere would move one of these.
    for (name, expected, core) in [
        (
            "Factory",
            0u8,
            Core::Factory {
                source: String::new(),
            },
        ),
        (
            "Source",
            1,
            Core::Source {
                trigger: CoreTrigger::Webhook,
            },
        ),
        ("Sink", 2, Core::Sink { target: CoreSink::Debug }),
        (
            "Belt",
            3,
            Core::Belt {
                ticks_per_slot: NonZeroU32::new(2).expect("2 is non-zero"),
            },
        ),
        (
            "Router",
            4,
            Core::Router {
                routes: vec![],
                default: None,
            },
        ),
    ] {
        assert_eq!(
            postcard::to_allocvec(&core).expect("a config encodes")[0],
            expected,
            "{name}'s discriminant byte moved: MachineConfig::Endpoint was INSERTED \
             rather than appended, and EDIT_SCHEMA_VERSION would have to bump (D-21)"
        );
    }
}

#[test]
fn postcard_encodes_nonzerou32_exactly_as_u32() {
    // RESEARCH assumption A3, promoted from "standard serde behaviour" to a measurement.
    // It is a claim about the SERIALIZATION LIBRARY rather than about our enums, so it
    // gets its own case and fails on its own terms if it is ever false — which would
    // silently desynchronise the core and wire `Belt` variants above.
    for n in [1u32, 12, 127, 128, 300, u32::MAX] {
        let non_zero = NonZeroU32::new(n).expect("n is non-zero");
        assert_eq!(
            postcard::to_allocvec(&non_zero).expect("NonZeroU32 encodes"),
            postcard::to_allocvec(&n).expect("u32 encodes"),
            "postcard must encode NonZeroU32({n}) exactly as u32({n})"
        );
    }
}

#[test]
fn label_config_is_discriminant_six_on_both_sides() {
    // Phase 76 (plan 76-02, D-02): the SEVENTH variant, appended STRICTLY LAST on both
    // sides, after `Endpoint` (5). Like `Belt`, its two sides carry DIFFERENT Rust types for
    // one field: the core holds the closed `LabelColour` enum (a byte past `Clay` fails to
    // decode) and the wire holds a plain `u8` (this crate's wire grammar permits plain
    // integers only), with `wire_config_to_core` refusing a byte above 5 as `Malformed`.
    // postcard encodes a fieldless enum by its declaration index, which is why the two
    // agree byte for byte for colours 0 to 5, and every one of the six is checked here.
    //
    // The text is multibyte UTF-8 on purpose: a string length written in characters
    // rather than bytes on either side would show here.
    let colours = [
        LabelColour::Sand,
        LabelColour::Stone,
        LabelColour::Moss,
        LabelColour::Lilac,
        LabelColour::Rose,
        LabelColour::Clay,
    ];
    for (byte, colour) in colours.into_iter().enumerate() {
        let byte = u8::try_from(byte).expect("six colours fit a byte");
        assert_parity(
            &format!("Label{{colour {byte}}}"),
            6,
            &Core::Label {
                text: "Caf\u{e9} \u{6ce8}\u{6587}".to_owned(),
                colour,
                w: 6,
                h: 2,
            },
            &Wire::Label {
                text: "Caf\u{e9} \u{6ce8}\u{6587}".to_owned(),
                colour: byte,
                w: 6,
                h: 2,
            },
        );
    }
    // The empty text a placed label starts with, at the 16 by 8 cap, where a varint
    // width difference between the two sides would show.
    assert_parity(
        "Label{empty, at the caps}",
        6,
        &Core::Label { text: String::new(), colour: LabelColour::Sand, w: 16, h: 8 },
        &Wire::Label { text: String::new(), colour: 0, w: 16, h: 8 },
    );
}

#[test]
fn appending_label_moved_no_earlier_variant_byte() {
    // The Endpoint test above pins the first five; this one adds Endpoint itself, so the
    // `Label` append is shown to move none of the six bytes before it.
    let endpoint = Core::Endpoint { path: "/a".to_owned() };
    assert_eq!(
        postcard::to_allocvec(&endpoint).expect("a config encodes"),
        vec![0x05u8, 0x02, b'/', b'a'],
        "Endpoint's bytes moved: MachineConfig::Label was INSERTED rather than appended, and \
         EDIT_SCHEMA_VERSION would have to bump"
    );
}

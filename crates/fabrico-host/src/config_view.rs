//! The shared, `kind`-tagged config REPLY view — the ONE `machine_config` read-reply
//! DTO both host transports converge on.
//!
//! # Why this type exists (the two-transport unification)
//! The frozen core enum [`MachineConfig`](fabrico_core::edit::MachineConfig) is a plain
//! serde enum with NO `#[serde(tag = "kind")]`, so `serde_json` serializes it
//! EXTERNALLY-tagged (`{"Factory":{...}}`). The frontend contract
//! (`frontend/src/protocol/decode.ts`), however, is INTERNALLY-tagged
//! (`{"kind":"Factory",...}`). These views mirror the core enums with the `{kind}` tag
//! so the read reply matches the frontend's `MachineConfig` decoder EXACTLY.
//!
//! Both the production Tauri `machine_config` command (`fabrico-app`) and the dev-WS
//! transport ([`config_value`](crate::transport_ws)) map core -> this shared DTO, so the
//! two paths CANNOT diverge again (the exact bug Phase 50 fixes; threat T-50-03).
//!
//! # Core stays byte-frozen
//! Adding `#[serde(tag)]` to the core enums would change the postcard/snapshot byte
//! layout and break corpus byte-identity — FORBIDDEN. This DTO lives entirely host-side
//! and is a pure serialization view; it never touches a persisted wire.

use fabrico_core::edit::{MachineConfig, SourceTrigger};
use fabrico_core::state::{HttpMethod, SinkTemplate};

/// The ephemeral, `kind`-tagged config REPLY view (host → webview IPC). This is NOT a
/// serialized snapshot/edit/command shape — it exists solely to hand the frontend the
/// SAME `{kind, ...}` JSON its postcard `MachineConfig` decoder
/// (`frontend/src/protocol/decode.ts`) already produces, on BOTH the Tauri `invoke`
/// path and the dev-WS read path. Nothing here touches a frozen wire.
#[derive(serde::Serialize)]
#[serde(tag = "kind")]
pub enum ConfigView {
    Factory { source: String },
    Source { trigger: TriggerView },
    Sink { target: SinkView },
    /// A belt's advance interval (BELT-02). Carries the PLAIN `u32` the frontend
    /// decoder expects — `.get()` on the core's `NonZeroU32`, the `BeltView` precedent
    /// this crate already follows for the same field on the render packet.
    Belt { ticks_per_slot: u32 },
    /// A router's ordered table and default port (ROUTE-03), in DECLARATION ORDER. The
    /// order is the behaviour: the first matching rule wins, so a reply that re-ordered
    /// the table would show the user a router that is not the one running.
    Router {
        routes: Vec<(RouteKeyView, u16)>,
        default: Option<u16>,
    },
    /// A Route's URL path (SERVE-08, 72-07), INCLUDING its leading `/`. The config
    /// panel reads it back to fill the path field, so a Route whose address the user
    /// typed shows that address rather than the id-derived default it started with.
    Endpoint { path: String },
    /// A label's words, colour byte and size (phase 76, plan 76-02). `colour` is the plain
    /// `LabelColour` byte the frontend's `MachineConfig` union carries (the `Belt` `.get()`
    /// precedent: the closed core type is flattened ONCE, here), and `w` and `h` are the
    /// label's box, read off `footprints` (absent means 1x1). The panel fills its Text
    /// field from this and the apply-confirmation compares it byte for byte.
    Label { text: String, colour: u8, w: u16, h: u16 },
}

/// One routing rule's KEY in the reply view: the exact mirror of the TS `RouteKey`
/// interface (`frontend/src/protocol/decode.ts`). `expect` is the raw pattern bytes;
/// the frontend renders them, it does not match on them.
///
/// # Why a key-only struct paired with its port, and not one flat `{offset, expect, port}`
/// 65-02 (UI-SPEC FINDING 1). This USED to be a flat struct carrying all three fields,
/// which disagreed with BOTH TypeScript halves: the read type is
/// `routes: [RouteKey, number][]` and the shipped postcard encoder destructures
/// `const [key, port] of config.routes`. A flat reply therefore yielded
/// `key === undefined` / `port === undefined` and `PostcardWriter.varintU(undefined)`
/// wrote garbage bytes into a certified, replayable `EditOp::Configure`.
///
/// The PAIR shape is the frozen core enum's own shape (`MachineConfig::Router.routes`
/// is a `Vec<(RouteKey, PortId)>`), and serde serializes a Rust tuple as a JSON array,
/// which is exactly what the TypeScript side reads. Reshaping the TypeScript side
/// instead would fork the type between the read path and the write path and leave the
/// encoder unable to consume its own decoder's output; the host is not frozen and the
/// core is, so the host is the half that moves.
#[derive(serde::Serialize)]
pub struct RouteKeyView {
    pub offset: u16,
    pub expect: Vec<u8>,
}

/// The `kind`-tagged Source-trigger view (mirrors the TS `SourceTrigger`).
#[derive(serde::Serialize)]
#[serde(tag = "kind")]
pub enum TriggerView {
    Webhook,
    Timer { interval_ticks: u64 },
}

/// The `kind`-tagged Sink-target view (mirrors the TS `SinkTemplate`; `method` is
/// the numeric [`HttpMethod`] discriminant the TS decoder expects, not a string).
#[derive(serde::Serialize)]
#[serde(tag = "kind")]
pub enum SinkView {
    Debug,
    Http { url: String, method: u8 },
}

/// The declaration-index of an [`HttpMethod`] (Get=0..Delete=4) — the numeric byte
/// the TS `SinkTemplate::Http.method` field carries (`decode.ts`).
fn http_method_index(method: HttpMethod) -> u8 {
    match method {
        HttpMethod::Get => 0,
        HttpMethod::Post => 1,
        HttpMethod::Put => 2,
        HttpMethod::Patch => 3,
        HttpMethod::Delete => 4,
    }
}

impl From<SourceTrigger> for TriggerView {
    fn from(t: SourceTrigger) -> Self {
        match t {
            SourceTrigger::Webhook => TriggerView::Webhook,
            SourceTrigger::Timer { interval_ticks } => TriggerView::Timer { interval_ticks },
        }
    }
}

impl From<SinkTemplate> for SinkView {
    fn from(t: SinkTemplate) -> Self {
        match t {
            SinkTemplate::Debug => SinkView::Debug,
            SinkTemplate::Http { url, method } => SinkView::Http {
                url,
                method: http_method_index(method),
            },
        }
    }
}

impl From<MachineConfig> for ConfigView {
    fn from(c: MachineConfig) -> Self {
        match c {
            MachineConfig::Factory { source } => ConfigView::Factory { source },
            MachineConfig::Source { trigger } => ConfigView::Source {
                trigger: trigger.into(),
            },
            MachineConfig::Sink { target } => ConfigView::Sink {
                target: target.into(),
            },
            // 63-04. NO catch-all arm here, deliberately: this `From` is one of the
            // exhaustive matches over `MachineConfig`, and a `_ =>` would turn the next
            // appended variant into a config panel that silently reads back the wrong
            // machine instead of a compile error. That property is what named this file
            // for 72-07 without anybody having to go looking for it.
            MachineConfig::Belt { ticks_per_slot } => ConfigView::Belt {
                ticks_per_slot: ticks_per_slot.get(),
            },
            // A near-identity map: the frozen `MachineConfig::Router.routes` is ALREADY a
            // vector of `(key, port)` pairs, so this only re-wraps the key in its view
            // type and leaves the pairing exactly where the core put it.
            MachineConfig::Router { routes, default } => ConfigView::Router {
                routes: routes
                    .into_iter()
                    .map(|(key, port)| {
                        (
                            RouteKeyView {
                                offset: key.offset,
                                expect: key.expect,
                            },
                            port,
                        )
                    })
                    .collect(),
                default,
            },
            // 72-07 (SERVE-08): a plain field carry, the `Factory { source }` arm's
            // shape. The leading slash is part of the stored value and is NOT stripped
            // here: the panel shows the user the path they typed.
            MachineConfig::Endpoint { path } => ConfigView::Endpoint { path },
            // 76-02: the colour flattens to its byte here and nowhere else.
            MachineConfig::Label { text, colour, w, h } => ConfigView::Label {
                text,
                colour: colour.to_byte(),
                w,
                h,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_view_serializes_kind_tagged_for_the_frontend() {
        // The reply mirrors the TS `MachineConfig` decode shape ({kind, ...}), NOT
        // serde's default external tag ({Factory:{...}}), so BOTH transports are
        // drop-in with the postcard decoder the frontend already ships.
        let factory =
            serde_json::to_value(ConfigView::from(MachineConfig::Factory { source: "x".into() }))
                .unwrap();
        assert_eq!(factory, serde_json::json!({"kind":"Factory","source":"x"}));

        let webhook = serde_json::to_value(ConfigView::from(MachineConfig::Source {
            trigger: SourceTrigger::Webhook,
        }))
        .unwrap();
        assert_eq!(
            webhook,
            serde_json::json!({"kind":"Source","trigger":{"kind":"Webhook"}})
        );

        let timer = serde_json::to_value(ConfigView::from(MachineConfig::Source {
            trigger: SourceTrigger::Timer { interval_ticks: 9 },
        }))
        .unwrap();
        assert_eq!(
            timer,
            serde_json::json!({"kind":"Source","trigger":{"kind":"Timer","interval_ticks":9}})
        );

        // Sink Http: `method` is the numeric HttpMethod discriminant (Post=1).
        let http = serde_json::to_value(ConfigView::from(MachineConfig::Sink {
            target: SinkTemplate::Http {
                url: "u".into(),
                method: HttpMethod::Post,
            },
        }))
        .unwrap();
        assert_eq!(
            http,
            serde_json::json!({"kind":"Sink","target":{"kind":"Http","url":"u","method":1}})
        );
    }

    #[test]
    fn config_view_renders_belt_and_router_configs() {
        use fabrico_core::state::RouteKey;
        use std::num::NonZeroU32;
        // 63-04: a read-back of either new config variant must not fall off the end of the
        // conversion. Belt carries the PLAIN u32 (`.get()`, the BeltView precedent) and
        // Router carries its table in DECLARATION ORDER, because the first matching rule
        // wins and a re-ordered reply would describe a router that is not the one running.
        let belt = serde_json::to_value(ConfigView::from(MachineConfig::Belt {
            ticks_per_slot: NonZeroU32::new(12).expect("12 is non-zero"),
        }))
        .unwrap();
        assert_eq!(belt, serde_json::json!({"kind":"Belt","ticks_per_slot":12}));
        assert!(
            belt["ticks_per_slot"].is_number(),
            "ticks_per_slot must serialize as a number, got {:?}",
            belt["ticks_per_slot"]
        );

        let router = serde_json::to_value(ConfigView::from(MachineConfig::Router {
            routes: vec![
                (RouteKey::new(0, b"ab".to_vec()), 1),
                (RouteKey::new(2, b"cd".to_vec()), 2),
            ],
            default: Some(7),
        }))
        .unwrap();
        // 65-02 (UI-SPEC FINDING 1): the routes value is a list of PAIRS, not a list of
        // flat `{offset, expect, port}` objects. This assertion USED to pin the flat
        // shape, and that was a shipped expectation encoding a defect: the TS type
        // (`decode.ts`) and the shipped postcard encoder both destructure
        // `const [key, port]`, so a flat reply fed `undefined` into `varintU` and wrote
        // garbage bytes into a certified `Configure`. Correcting it here is a
        // correction, not a re-bless.
        assert_eq!(
            router,
            serde_json::json!({
                "kind": "Router",
                "routes": [
                    [{"offset": 0, "expect": [97, 98]}, 1],
                    [{"offset": 2, "expect": [99, 100]}, 2]
                ],
                "default": 7
            })
        );

        // The empty table with no default is legal and renders as such, not as null noise.
        let empty = serde_json::to_value(ConfigView::from(MachineConfig::Router {
            routes: vec![],
            default: None,
        }))
        .unwrap();
        assert_eq!(
            empty,
            serde_json::json!({"kind":"Router","routes":[],"default":null})
        );
    }

    #[test]
    fn sink_view_serializes_debug_and_u8_methods() {
        // The complementary read-contract lock the Chromium mock structurally cannot
        // produce (it fabricates the shape): Sink Debug nests {kind}, and Http's
        // `method` is a JSON NUMBER equal to http_method_index for ALL five variants.

        // Debug: bare {kind:"Debug"} target.
        let debug =
            serde_json::to_value(ConfigView::from(MachineConfig::Sink { target: SinkTemplate::Debug }))
                .unwrap();
        assert_eq!(debug["target"], serde_json::json!({"kind":"Debug"}));

        // Http: `method` is a JSON NUMBER equal to the http_method_index for each
        // variant (Get=0, Post=1, Put=2, Patch=3, Delete=4) — never the serde-default
        // string variant name.
        for (method, expected) in [
            (HttpMethod::Get, 0u64),
            (HttpMethod::Post, 1),
            (HttpMethod::Put, 2),
            (HttpMethod::Patch, 3),
            (HttpMethod::Delete, 4),
        ] {
            let http = serde_json::to_value(ConfigView::from(MachineConfig::Sink {
                target: SinkTemplate::Http {
                    url: "u".into(),
                    method,
                },
            }))
            .unwrap();
            let target = &http["target"];
            assert_eq!(target["kind"], "Http");
            assert_eq!(target["url"], "u");
            // Assert it is a JSON number equal to the index — NOT a string.
            assert!(
                target["method"].is_number(),
                "method must serialize as a number, got {:?}",
                target["method"]
            );
            assert_eq!(target["method"].as_u64(), Some(expected));
        }
    }
}

//! The three wire-delivery discriminator guards: SERVE-01 (the confused deputy),
//! SERVE-02 (the port medium decides servicing) and SERVE-09 (undecodable bytes on an
//! electrical port never reach user JS).
//!
//! WRITTEN RED, ON PURPOSE, BEFORE THE DISCRIMINATOR MOVES. Every test in this file
//! FAILS at the commit that introduces it, and each one names the file and line that
//! makes it fail in its own `RED ON HEAD BECAUSE:` comment. Plan 72-03 lands the
//! discriminator and turns them green. A test that is green on arrival has not been
//! shown capable of failing, and the pending todo this phase folds states the ordering
//! requirement in as many words: the confused-deputy guard is written BEFORE the change.
//!
//! EVERY BOARD IS DRIVEN THROUGH `Core::advance`, AND THAT IS LOAD-BEARING RATHER THAN
//! STYLISTIC. Do not "simplify" any of these into a call to `factory::step_factory` or
//! to the `common::step_factory` isolated driver. The whole subject of this phase is a
//! parameter that function does not take today (the delivering port's declared medium):
//! a direct call lets the test author hand it in, which proves something about the test
//! and nothing about the fold. Going through `advance` means the ports have to reach the
//! discriminator by the same route a real board's ports reach it, so a signature change
//! cannot make these pass by construction.
//!
//! HOW THE CONFUSED-DEPUTY ITEM IS BUILT, and why it is a measurement rather than a
//! guess. SERVE-01 needs an ORDINARY BELT ITEM whose bytes HAPPEN to be a canonical
//! `WireEnvelope` encoding: not a real envelope pushed by hand, which proves nothing
//! about confusion, but a plausible payload a factory would be handed on a belt. The
//! bytes below are exactly that, and they were constructed by working backwards through
//! postcard's positional layout (correlation varint, NodeId idx varint, NodeId version
//! varint, PortId varint, budget varint, payload length varint, payload bytes) choosing
//! field VALUES whose varint bytes are ASCII digits:
//!
//!   b"123456" ++ b"0." ++ b"1" * 52
//!
//!   correlation = 49 (b'1'), return_addr = (NodeId idx 50 version 51, port 52),
//!   budget = 53, payload length = 54, payload = b"0.111...1" (54 bytes).
//!
//! Two properties make it the right item, and both are ASSERTED below rather than
//! assumed, so a later change to the wire schema reddens here instead of quietly
//! turning these tests into something else:
//!
//!   1. It DECODES as a `WireEnvelope` and `env.encode() == item`, so it satisfies the
//!      canonical round-trip sniff at `factory.rs:873-875` exactly as a real envelope
//!      would. This is what makes it a confused deputy at all.
//!   2. BOTH readings are valid JSON, and they are DIFFERENT JSON. The whole item reads
//!      as the number 1234560.111..., the payload alone reads as 0.111... . The factory
//!      sandbox parses its input with `JSON.parse` (`factory.rs:194`), so this is the
//!      only construction in which the sandbox can RUN on either reading and report
//!      which one it was handed. A binary envelope would fail the UTF-8 gate at
//!      `factory.rs:523-531` before the engine was entered, and the test could then not
//!      tell "the whole bytes were handed over" apart from "nothing was handed over".
//!
//! The JS below discriminates on `input < 1`, so it reports `WHOLE_ITEM` for the first
//! reading and `PAYLOAD_ONLY` for the second, and never depends on how a double is
//! formatted.

mod common;

use common::{collector_items, fault_port_reasons, header};
use fabrico_core::command::Effect;
use fabrico_core::core::Core;
use fabrico_core::event::{Event, EventPayload, SCHEMA_VERSION};
use fabrico_core::factory::DEFAULT_GAS_BUDGET;
use fabrico_core::fault::{FAULT_PORT, FaultReason};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::state::{Medium, Node, Port, Role, Side};
use fabrico_core::wire::WireEnvelope;

/// The handler under test. It reports WHICH READING of its input it was handed, and it
/// calls `ctx.command`, so the `Effect` the fold stamps on that intent is observable.
/// `input < 1` is the discriminator: the whole-item reading parses to 1234560.111... and
/// the payload-only reading to 0.111..., so the branch never depends on float formatting.
const REPORTING_HANDLER_JS: &str = r#"export default function (input, ctx) {
  ctx.emit(0, input < 1 ? "PAYLOAD_ONLY" : "WHOLE_ITEM");
  ctx.command({ ok: true }, 0);
}"#;

/// What the handler emits when the sandbox was handed the WHOLE item bytes.
const WHOLE_ITEM: &[u8] = b"\"WHOLE_ITEM\"";
/// What the handler emits when the sandbox was handed only `env.payload`.
const PAYLOAD_ONLY: &[u8] = b"\"PAYLOAD_ONLY\"";

/// The correlation the confused-deputy bytes decode to (ASCII `'1'` = 49). Named so the
/// SERVE-02 electrical arm can assert the reply is bound to THIS envelope rather than to
/// any reply at all.
const COLLIDING_CORRELATION: u64 = 49;

/// The ordinary belt item whose bytes happen to be a canonical `WireEnvelope` encoding.
/// See the module header for the derivation.
fn colliding_item() -> Item {
    let mut bytes = b"123456".to_vec();
    bytes.extend_from_slice(b"0.");
    bytes.extend(std::iter::repeat_n(b'1', 52));
    Item(bytes)
}

/// The `env.payload` half of [`colliding_item`], as its own JSON reading.
fn colliding_payload() -> Item {
    let mut bytes = b"0.".to_vec();
    bytes.extend(std::iter::repeat_n(b'1', 52));
    Item(bytes)
}

/// One declared input port at index 0 with the given medium. Index 0 is the whole
/// subject: the sandbox drains inbox port 0 only (`factory.rs:842-845`), so port 0 is
/// the port whose medium a delivery discriminator has to read.
fn in_port_at_zero(medium: Medium) -> Vec<Port> {
    vec![Port { local_offset: (0, 1), side: Side::W, role: Role::In, medium }]
}

/// A logged `Input` event delivering `item` into `target`'s inbox port 0. This is the
/// admitted-event route into a Factory's inbox: `ManualInject` targets a `Source` only
/// (`manual_inject.rs:96-98`), so `Input` is the payload that reaches a Factory through
/// `Core::advance` without any test-only back door into the fold.
fn deliver(target: NodeId, item: Item) -> Event {
    Event {
        schema_version: SCHEMA_VERSION,
        partition: 0,
        sequence: 0,
        tick: 0,
        payload: EventPayload::Input { target, port: 0, item },
    }
}

/// The `Effect` a command carried, flattened so an assertion reads as a value rather
/// than as a match.
#[derive(Debug, PartialEq, Eq)]
enum EffectTag {
    Noop,
    Reply(u64),
    Other,
}

/// Everything one advance of one board makes observable.
#[derive(Debug)]
struct Observed {
    /// What the handler emitted on port 0, as it reached the collector. Empty means the
    /// sandbox was never entered (or was entered and faulted before emitting).
    emitted: Vec<Item>,
    /// The `Effect` on every command intent the fold stamped this tick.
    effects: Vec<EffectTag>,
    /// Faults RESTING on the factory's own `FAULT_PORT` inbox.
    resting_faults: Vec<FaultReason>,
    /// The factory's snapshot-captured undocked-fault counter (`state.rs:1955`). With no
    /// belt docked at `FAULT_PORT`, EVERY fault the factory emits lands here, so `0` is
    /// the total statement "this factory emitted no fault at all this tick".
    dropped_faults: u64,
}

/// Build `factory -> collector`, optionally DECLARE the factory's ports, deliver `item`
/// into inbox port 0 as a logged event, and advance the full fold by exactly one tick.
///
/// `FAULT_PORT` is deliberately left UNDOCKED, which is what makes
/// [`Observed::dropped_faults`] a total fault observation rather than a partial one.
fn advance_one(ports: Option<Vec<Port>>, item: Item) -> Observed {
    let mut core = Core::genesis(header(7));
    let factory = core.state.add_factory(REPORTING_HANDLER_JS.to_owned(), DEFAULT_GAS_BUDGET, 7);
    let collector = core.state.add_source();
    core.state.link((factory, 0), (collector, 0));
    if let Some(ports) = ports {
        core.state.set_ports(factory, ports);
    }

    let commands = core.advance(&[deliver(factory, item)]);

    let effects = commands
        .iter()
        .map(|c| match &c.effect {
            Effect::Noop => EffectTag::Noop,
            Effect::Reply { correlation, .. } => EffectTag::Reply(*correlation),
            _ => EffectTag::Other,
        })
        .collect();
    let dropped_faults = match core.state.node(factory) {
        Some(Node::Factory(f)) => f.faults,
        _ => panic!("the factory node is live"),
    };
    assert_eq!(
        core.state.inbox_of(factory).map(|i| i.len_on(FAULT_PORT)).unwrap_or(0),
        fault_port_reasons(&core, factory).len(),
        "every item resting on FAULT_PORT decodes as a Fault, so the reason list is a \
         complete reading of that queue rather than a filtered one",
    );

    Observed {
        emitted: collector_items(&core, collector),
        effects,
        resting_faults: fault_port_reasons(&core, factory),
        dropped_faults,
    }
}

/// The confused-deputy item really is one. Asserted rather than assumed, because both
/// guards below are worthless if these bytes stop satisfying the canonical round-trip
/// the sniff at `factory.rs:873-875` applies: they would then be an ordinary item that
/// HEAD also declines to reclassify, and every assertion would pass for the wrong reason.
#[test]
fn the_colliding_item_is_a_canonical_envelope_and_both_readings_are_distinct() {
    let item = colliding_item();
    let env = WireEnvelope::decode(&item).expect(
        "the colliding bytes decode as a WireEnvelope; if this fails the postcard layout \
         of WireEnvelope moved and the derivation in this file's header must be redone",
    );
    assert_eq!(
        env.encode(),
        item,
        "the colliding bytes are CANONICAL: env.encode() == item is the exact sniff at \
         factory.rs:873-875, and without it these bytes are not a confused deputy",
    );
    assert_eq!(env.correlation, COLLIDING_CORRELATION);
    assert_eq!(env.payload, colliding_payload());
    assert_ne!(
        item.0, env.payload.0,
        "the two readings must DIFFER, or no assertion below can tell them apart",
    );
}

/// SERVE-01. An ordinary belt item that merely happens to postcard-decode as a canonical
/// `WireEnvelope` is NOT transport when it arrives on a MECHANICAL port. The sandbox sees
/// the whole item, and the command intent stays the muted `Effect::Noop`.
///
/// RED ON HEAD BECAUSE: `factory.rs:873-875` accepts on `env.encode() == item` ALONE,
/// with no reference to any port, and `step_factory`'s signature (`factory.rs:824-833`)
/// takes eight parameters and NO port list, so no medium can be read at all. For these
/// canonically-encoded bytes the round-trip holds, so today the payload IS stripped
/// (`factory.rs:877-879` takes the `Some(env)` arm) and the effect IS `Effect::Reply`
/// (`factory.rs:904-907`). MEASURED at a pre-release commit: this board emits `"PAYLOAD_ONLY"`
/// and stamps `Reply{49}`. Both halves of this test are red.
#[test]
fn mechanical_port_zero_never_reclassifies_a_canonical_envelope() {
    let observed = advance_one(Some(in_port_at_zero(Medium::Mechanical)), colliding_item());

    assert_eq!(
        observed.emitted,
        vec![Item(WHOLE_ITEM.to_vec())],
        "(a) the sandbox saw the WHOLE item bytes, not env.payload: a mechanical port 0 \
         is not a wire delivery, so nothing may be unwrapped. Got {:?}",
        observed.emitted,
    );
    assert_eq!(
        observed.effects,
        vec![EffectTag::Noop],
        "(b) the command intent stays the muted Effect::Noop. An Effect::Reply here is \
         the confused deputy itself: an ordinary belt item reclassified as transport, \
         with a reply reverse-routed to a return address the item never asked for",
    );
    assert_eq!(
        observed.dropped_faults, 0,
        "and the item was PROCESSED rather than faulted: a fault here would mean the \
         guard passed by refusing the item instead of by handling it as an ordinary one",
    );
    assert!(observed.resting_faults.is_empty());
}

/// SERVE-02. Three boards, identical but for the Factory's port declaration, must behave
/// in three ways. The declared medium of port 0 is what decides servicing, and an
/// UNDECLARED port reads Mechanical (`admit::inbox_class` clause 3, `admit.rs:213-231`,
/// which is the shipped predicate this discriminator must agree with).
///
/// RED ON HEAD BECAUSE: `step_factory` never receives the node's ports
/// (`factory.rs:824-833`) and the wire fold deliberately never re-validates medium at
/// delivery ("decided ONCE at command-validate time", `fold_draw_wire`'s docblock at
/// `tick.rs:625-628`). MEASURED at a pre-release commit: all three boards behave IDENTICALLY,
/// emitting `"PAYLOAD_ONLY"` and stamping `Reply{49}`. Arm (a) is the positive control
/// and passes today; arms (b) and (c) are red.
#[test]
fn port_zero_medium_decides_servicing() {
    // (a) ELECTRICAL In at index 0: the request IS serviced. The sandbox is handed
    //     env.payload and the intent carries Effect::Reply bound to THIS envelope's
    //     correlation. This arm is the positive control: it holds on HEAD and must keep
    //     holding, so a discriminator that refused everything could not pass this test.
    let electrical = advance_one(Some(in_port_at_zero(Medium::Electrical)), colliding_item());
    assert_eq!(
        electrical.emitted,
        vec![Item(PAYLOAD_ONLY.to_vec())],
        "(a) an electrical port 0 IS a wire delivery: the sandbox sees env.payload",
    );
    assert_eq!(
        electrical.effects,
        vec![EffectTag::Reply(COLLIDING_CORRELATION)],
        "(a) the reply is bound to the delivered envelope's own correlation, not merely \
         to some reply",
    );

    // (b) MECHANICAL In at index 0: not a wire delivery.
    let mechanical = advance_one(Some(in_port_at_zero(Medium::Mechanical)), colliding_item());
    assert_eq!(
        mechanical.emitted,
        vec![Item(WHOLE_ITEM.to_vec())],
        "(b) a mechanical port 0 hands the whole item to the sandbox",
    );
    assert_eq!(
        mechanical.effects,
        vec![EffectTag::Noop],
        "(b) a mechanical port 0 emits the muted Effect::Noop",
    );

    // (c) NO declared ports at all. This is not a corner case: it is the shape of most
    //     of the golden corpus. `common::source_factory_collector` builds exactly this
    //     factory (`add_factory` inserts an inbox and NO ports, `state.rs:1308-1320`),
    //     and goldens 0005 and 0027 rest on it, so the rule "a port-less factory is
    //     never serviced" is what holds those two fixtures still.
    let portless = advance_one(None, colliding_item());
    assert_eq!(
        portless.emitted,
        vec![Item(WHOLE_ITEM.to_vec())],
        "(c) an UNDECLARED port reads Mechanical, exactly as admit::inbox_class clause 3 \
         reads it, so a port-less factory is never serviced",
    );
    assert_eq!(
        portless.effects,
        vec![EffectTag::Noop],
        "(c) a port-less factory emits the muted Effect::Noop",
    );

    // The three boards must be genuinely DIFFERENT, stated as its own assertion so a
    // future discriminator that collapses them again cannot pass by making all three
    // agree on whichever value the arms happen to name.
    assert_ne!(electrical.emitted, mechanical.emitted);
    assert_ne!(electrical.effects, mechanical.effects);
    assert_eq!(mechanical.emitted, portless.emitted);
    assert_eq!(mechanical.effects, portless.effects);
}

/// SERVE-09. Bytes that are NOT a canonical request never reach user JS just because
/// they arrived on an ELECTRICAL port. Replacing the byte sniff with a port-medium rule
/// must NARROW what reaches the sandbox, not widen it.
///
/// SCOPE, STATED HONESTLY: this is DEFENCE IN DEPTH, not a live path. `step_wire` always
/// pushes a canonical envelope (`tick.rs:1362`, `msg.to_envelope().encode()`) and the
/// wire's own ingest already drops a malformed one (`tick.rs:1300`), so the only
/// producers of non-canonical bytes at a Factory's electrical port 0 are a direct
/// core-level push, a mechanical belt link into that port, or a forged snapshot.
///
/// WHY GENUINE GARBAGE AND NOT A TRAILING BYTE. Measured during requirements work and
/// re-stated here because it shaped the input: an encoded envelope plus one trailing
/// `0xAA` DECODES fine, because postcard tolerates trailing bytes there, and fails only
/// the round-trip filter. A trailing-byte input would therefore be testing the filter
/// this phase DELETES rather than the port rule it installs.
///
/// FAULTED OR DROPPED is settled by D-17: DROPPED, with no fault, matching the
/// repository's own precedent that a malformed envelope is dropped rather than faulted
/// (`tick.rs:5178`). Both halves are asserted, so a future fault arm reddens here rather
/// than passing silently.
///
/// RED ON HEAD BECAUSE: on HEAD an undecodable input makes `serviced` None at
/// `factory.rs:873-875` and `js_input` falls through to `&item.0` at `factory.rs:879`,
/// so the raw transport bytes go straight into `runtime.run`. MEASURED at commit
/// a pre-release revision, and the two rows are red for two DIFFERENT reasons, which is why both are
/// here: the `0xFF 0xFF 0xFF` row emits nothing (the bytes fail the UTF-8 gate at
/// `factory.rs:523-531` before the engine is entered) but leaves `dropped_faults == 1`
/// from the resulting `FactoryError`, so it is red on the no-fault half; the `b"42"` row
/// raises no fault but the sandbox IS entered and emits `"WHOLE_ITEM"`, so it is red on
/// the no-entry half. Either row alone would leave one of the two assertions unable to
/// fail on HEAD.
#[test]
fn undecodable_bytes_on_an_electrical_port_never_reach_user_js() {
    // (bytes, what they are, why they are here)
    let rows: [(Vec<u8>, &str); 2] = [
        (
            vec![0xFF, 0xFF, 0xFF],
            "genuine binary garbage, the shape tick.rs already uses for a forged item",
        ),
        (
            b"42".to_vec(),
            "valid UTF-8 AND valid JSON, but truncated as a WireEnvelope: the reading \
             that proves the sandbox is not entered, because on HEAD this one RUNS",
        ),
    ];

    for (bytes, what) in rows {
        assert!(
            WireEnvelope::decode(&Item(bytes.clone())).is_err(),
            "precondition for {what}: these bytes must not decode as a WireEnvelope, or \
             the row is testing the serviced path instead of the undecodable one",
        );

        let observed = advance_one(Some(in_port_at_zero(Medium::Electrical)), Item(bytes));

        assert!(
            observed.emitted.is_empty(),
            "the sandbox was never entered with {what}: raw transport bytes are not user \
             input. Got {:?}",
            observed.emitted,
        );
        assert!(
            observed.effects.is_empty(),
            "and no command intent was produced from {what}",
        );
        assert_eq!(
            observed.dropped_faults, 0,
            "D-17: the delivery is DROPPED with no fault for {what}. FAULT_PORT is \
             undocked on this board, so this counter is the TOTAL count of faults the \
             factory emitted, and a non-zero reading means a fault was raised somewhere",
        );
        assert!(
            observed.resting_faults.is_empty(),
            "and nothing rests on FAULT_PORT for {what}: {:?}",
            observed.resting_faults,
        );
    }
}

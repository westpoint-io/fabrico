//! SERVE-06, host half: on a REAL render packet, callerB's own return cable carries a
//! REPLY pulse.
//!
//! # Why this is not a fourth copy of an assertion that already passes
//! `render_packet.rs` already asserts
//! `assert_eq!(derive_wire_direction(&ret, &inflight((caller, 0))), WIRE_REPLY)` and has
//! passed since Phase 42. It cannot fail here and it could not have failed then: the
//! classifier is a pure function of a HAND-SUPPLIED `(link, message)` pair, so it reports
//! whatever the test author handed it and is structurally blind to a wrong cable being
//! chosen upstream. The same file also builds a packet over a cable whose `in_flight` was
//! pushed by hand, which has the same blindness one layer up.
//!
//! The only version of this assertion that can fail is one that reads a byte the PACKET
//! BUILDER wrote, over a cable the SIM chose, on a board the sim actually ran. That is
//! what this file does: a real `Host`, real ticks, a real `build_keyframe`, and an
//! assertion on the emitted `WirePulseView.direction`. `derive_wire_direction` is never
//! called here, and a grep proving that is one of this plan's verification arms.
//!
//! # The board is UNREACHABLE BY GESTURE, on purpose
//! Two callers sharing one handler needs two wires out of one handler Out port, and
//! `fabrico-command`'s `DrawWire` refuses the second with `PortOccupied` under D-01 plus
//! D-02. So this board is built through the core `add_wire` seam, exactly as the core half
//! (`fabrico-core/tests/reply_address.rs`) explains at more length. A later reader should
//! NOT try to add a live e2e for it and conclude the app is broken when the second return
//! drag is refused: the refusal is the design.

use fabrico_core::command::{Command, ResultEvent};
use fabrico_core::core::Core;
use fabrico_core::event::{EventPayload, LogHeader, SCHEMA_VERSION};
use fabrico_core::ids::{Item, NodeId};
use fabrico_core::persist::RedbStore;
use fabrico_core::state::{Medium, Port, Role, Side};
use fabrico_host::driver::Host;
use fabrico_host::ledger::DispatchLedger;
use fabrico_host::render_packet::{RenderPacketBuilder, WIRE_REPLY};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// The shared handler: one `ctx.command` per serviced request, which the 37-03 reply seam
/// maps to an `Effect::Reply`.
const SHARED_HANDLER_JS: &str = "export default function (input, ctx) { ctx.command({ok:1}, 0); }";

const CORRELATION_A: u64 = 0xAAAA_0001;
const CORRELATION_B: u64 = 0xBBBB_0002;
const BUDGET: u64 = 8;

/// A real `Host` over tempfile redb stores, holding the two-caller board.
struct Rig {
    _dir: tempfile::TempDir,
    host: Host,
    ingress_tx: UnboundedSender<EventPayload>,
    ingress_rx: UnboundedReceiver<EventPayload>,
    cmd_tx: UnboundedSender<Command>,
    results_rx: UnboundedReceiver<ResultEvent>,
    /// The far ends of the command / result channels, HELD for the life of the rig so
    /// neither closes under the driver mid-run.
    _cmd_rx: UnboundedReceiver<Command>,
    _res_tx: UnboundedSender<ResultEvent>,
    caller_a: NodeId,
    caller_b: NodeId,
    /// The cable handler -> callerB: the HIGHER `NodeId` of the handler's two outgoing
    /// cables, so a lowest-ascending-id scan out of the handler could never choose it.
    return_b: NodeId,
    return_a: NodeId,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut core = Core::genesis(LogHeader {
        schema_version: SCHEMA_VERSION,
        seed: 7,
    });

    let caller_a = core.state.add_source();
    let caller_b = core.state.add_source();
    let handler = core.state.add_factory(SHARED_HANDLER_JS.to_owned(), 256, 7);
    // The electrical In at port 0 is what makes this node a handler at all (D-16).
    core.state.set_ports(
        handler,
        vec![Port {
            local_offset: (0, 1),
            side: Side::W,
            role: Role::In,
            medium: Medium::Electrical,
        }],
    );
    // Distinct cells so every cable auto-routes a real, non-degenerate path and the packet
    // carries a drawable `WireView` rather than a degenerate one.
    core.state.set_cell(caller_a, (2, 2));
    core.state.set_cell(caller_b, (2, 8));
    core.state.set_cell(handler, (8, 5));

    let forward_a = core.state.add_wire((caller_a, 0), (handler, 0));
    core.state.link((forward_a, 0), (handler, 0));
    let forward_b = core.state.add_wire((caller_b, 0), (handler, 0));
    core.state.link((forward_b, 0), (handler, 0));
    let return_a = core.state.add_wire((handler, 0), (caller_a, 0));
    core.state.link((return_a, 0), (caller_a, 0));
    let return_b = core.state.add_wire((handler, 0), (caller_b, 0));
    core.state.link((return_b, 0), (caller_b, 0));

    let store = RedbStore::open(dir.path().join("log.redb")).expect("open log");
    let ledger = DispatchLedger::open(dir.path().join("ledger.redb")).expect("open ledger");
    let host = Host::new(core, store, ledger, None).expect("open host");

    let (ingress_tx, ingress_rx) = unbounded_channel::<EventPayload>();
    let (cmd_tx, cmd_rx) = unbounded_channel::<Command>();
    let (res_tx, results_rx) = unbounded_channel::<ResultEvent>();

    Rig {
        _dir: dir,
        host,
        ingress_tx,
        ingress_rx,
        cmd_tx,
        results_rx,
        _cmd_rx: cmd_rx,
        _res_tx: res_tx,
        caller_a,
        caller_b,
        return_a,
        return_b,
    }
}

impl Rig {
    fn tick(&mut self) {
        self.host
            .tick_once(&mut self.ingress_rx, &mut self.results_rx, &self.cmd_tx)
            .expect("a tick folds");
    }

    /// Queue one webhook-shaped request from `caller` on the ingress channel the driver
    /// drains. The driver stamps and LOGS it exactly as a real endpoint hit would.
    fn post(&self, caller: NodeId, correlation: u64) {
        self.ingress_tx
            .send(EventPayload::WireRequest {
                correlation,
                deadline_tick: 500,
                budget: BUDGET,
                return_addr: (caller, 0),
                payload: Item(b"{\"n\":1}".to_vec()),
            })
            .expect("ingress channel open");
    }
}

/// callerB's OWN return cable carries a REPLY pulse in a real render packet.
///
/// RED ON HEAD BECAUSE: `tick.rs`'s `route_replies` chose the return cable with
/// `GridState::wire_from_node(handler)` (`state.rs`), the first ascending `NodeId` out of
/// the handler, which on this board is ALWAYS callerA's cable. callerB's reply was admitted
/// to callerA's cable, so `return_b`'s `in_flight` stayed EMPTY for the whole run and the
/// packet builder emitted a `WireView` for it with ZERO pulses. The assertion below found
/// no pulse to read a direction byte off at all.
///
/// The direction byte asserted here is one the PACKET FOLD produced
/// (`RenderPacketBuilder::build_keyframe` maps each live `in_flight` message to a
/// `WirePulseView`), not one obtained by calling the classifier. Calling
/// `derive_wire_direction` directly would be the already-green Phase-42 assertion wearing a
/// new name: it takes the link as an argument, so it cannot see a wrong link being chosen.
#[test]
fn caller_b_return_wire_carries_a_reply_pulse_in_a_real_packet() {
    let mut rig = rig();

    // NON-VACUITY: callerB's cable is the higher-id one, so a lowest-id scan out of the
    // handler could never pick it. Without this the test could pass on a board where the
    // old mechanism happened to be right.
    assert!(
        rig.return_a < rig.return_b,
        "callerB's return cable holds the HIGHER NodeId, which is what makes this board able \
         to show a wrong selection at all"
    );

    let mut builder = RenderPacketBuilder::new();

    // STAGGERED, so both replies are emitted on ticks where the deleted per-tick scratch
    // map was working exactly as designed. This test is about which CABLE was chosen, and
    // staggering keeps the same-tick loss (asserted in the core half) out of the reason
    // this assertion is red.
    rig.post(rig.caller_a, CORRELATION_A);

    let mut b_reply_pulse_directions: Vec<u8> = Vec::new();
    let mut a_reply_pulse_directions: Vec<u8> = Vec::new();
    let mut pulses_on_wrong_cable: Vec<(u64, u64)> = Vec::new();

    for tick in 0..16 {
        if tick == 6 {
            rig.post(rig.caller_b, CORRELATION_B);
        }
        rig.tick();

        let pkt = builder.build_keyframe(&rig.host);
        let handle_a = builder
            .handle_for_node(rig.return_a)
            .expect("callerA's return cable has a render handle once it is emitted");
        let handle_b = builder
            .handle_for_node(rig.return_b)
            .expect("callerB's return cable has a render handle once it is emitted");
        for wv in &pkt.wires {
            for pulse in &wv.pulses {
                if wv.id == handle_b {
                    b_reply_pulse_directions.push(pulse.direction);
                } else if wv.id == handle_a {
                    a_reply_pulse_directions.push(pulse.direction);
                } else {
                    pulses_on_wrong_cable.push((wv.id, u64::from(pulse.direction)));
                }
            }
        }
    }

    // Non-vacuity: callerA's cable did carry its own reply, so the run really did produce
    // replies and an empty callerB list cannot be blamed on a board that never ran.
    assert!(
        a_reply_pulse_directions.contains(&WIRE_REPLY),
        "callerA's return cable carried a REPLY pulse, so the board genuinely served \
         requests (callerA saw: {a_reply_pulse_directions:?})"
    );

    // THE ASSERTION: a byte the packet fold produced, on callerB's own cable.
    assert!(
        b_reply_pulse_directions.contains(&WIRE_REPLY),
        "callerB's OWN return cable emitted a WirePulse with direction WIRE_REPLY in a real \
         render packet. On HEAD this cable emitted NO PULSE AT ALL, because callerB's reply \
         was admitted to callerA's cable instead (saw: {b_reply_pulse_directions:?}, \
         pulses on neither return cable: {pulses_on_wrong_cable:?})"
    );

    // Every pulse that appeared on either return cable was a REPLY. A FORWARD byte on a
    // return cable would mean a reply was routed home carrying somebody else's address.
    for dir in a_reply_pulse_directions.iter().chain(&b_reply_pulse_directions) {
        assert_eq!(
            *dir, WIRE_REPLY,
            "every pulse on a return cable is a REPLY (the packet fold derives the byte from \
             the message's return_addr against the cable's own endpoints)"
        );
    }
}

//! WR-03 on the SHIPPED demo board: pressing R on the demo Router is refused in belt words,
//! and the board does not change.
//!
//! # The rule
//! From review WR-03: "Refuse, say why". The demo Router (2x3 at (14,0))
//! docks all three of its outputs since plan 85-08 (D-15); the small lane leaves its top
//! output, catalog port 3 (emit 2) at (15,0) facing E, whose first tile is the doorstep
//! (16,0). Turned either way the box is x 14..16, y 0..1, and walked row-major the first
//! cell another node owns is (16,0), that lane's first tile (until plan 85-08 it was (16,1),
//! the first output's belt, because the top output was free). So the Rotate is refused as
//! `RotateCoversBelt`, the user reads `Turning would cover a belt. Move that belt first.`,
//! and nothing is deleted. `router_rotate_refusal.rs` pins the same
//! rule on a hand-built board with a port-2 control.
//!
//! # How the board is built
//! As applier B in `demo_regenerability.rs` and as `demo_first_port_edit.rs` builds it: a
//! `GridSession` from `DEMO_GENESIS_SEED` folding `demo_commands()` one `apply` at a time.
//! The demo Router is found BY KIND, not by handle, so a re-ordered demo cannot point this
//! pin at another machine.
//!
//! The refusal is compared by variant NAME so the file compiles at the start revision and
//! its red there is an assertion naming the old tag.
//!
//! Run target: `cargo test -p fabrico-host --test demo_router_rotate`.

use fabrico_command::GridSession;
use fabrico_core::ids::NodeId;
use fabrico_core::state::Node;
use fabrico_host::demo_scene::{DEMO_GENESIS_SEED, demo_commands};
use fabrico_protocol::GridCommand;

/// The demo board, folded headlessly.
fn demo() -> GridSession {
    let mut session = GridSession::new(DEMO_GENESIS_SEED);
    for cmd in demo_commands() {
        session.apply(cmd).expect("the session accepts every demo command");
    }
    session
}

/// The one Router on the demo board, found by kind.
fn demo_router(s: &GridSession) -> NodeId {
    let routers: Vec<NodeId> = s
        .core()
        .state
        .node_ids()
        .filter(|&id| matches!(s.core().state.node(id), Some(Node::Router(_))))
        .collect();
    assert_eq!(routers.len(), 1, "the demo board carries exactly one Router");
    routers[0]
}

#[test]
fn r_on_the_demo_router_is_refused_and_the_board_does_not_change() {
    for ccw in [false, true] {
        let mut s = demo();
        let router = demo_router(&s);
        let handle = s.view().handle_of(router).expect("the Router has a handle");
        // MEASURED: the Router's anchor and box, and the belt on its first Out.
        assert_eq!(s.core().state.cell_of(router), Some((14, 0)), "the demo Router is anchored at (14,0)");
        let fp = s.core().state.footprint_of(router).expect("the Router has a footprint");
        assert_eq!((fp.w, fp.h, fp.rot), (2, 3, 0), "the demo Router is a 2x3 at rot 0");
        let top_out_belt = s
            .core()
            .state
            .links_iter()
            .find(|((from, key), _)| *from == router && *key == 2)
            .map(|(_, (belt, _))| belt)
            .expect("a belt leaves the demo Router's top output (routing key 2, the small lane)");
        assert_eq!(
            s.core().state.occupied((16, 0)),
            Some(top_out_belt),
            "that belt's first tile is the top Out's doorstep (16,0)"
        );
        for c in [(14, 0), (15, 0)] {
            assert!(
                s.core().state.occupied(c).is_none_or(|o| o == router),
                "{c:?} is the Router's own, so (16,0) is the first foreign cell of the turn"
            );
        }

        let state = postcard::to_allocvec(&s.core().state).expect("GridState serializes");
        let log = postcard::to_allocvec(s.edit_log()).expect("the edit log serializes");
        let err = s
            .apply(GridCommand::Rotate { node: handle, ccw })
            .err()
            .unwrap_or_else(|| panic!("ccw={ccw}: R on the demo Router was ACCEPTED"));
        assert_eq!(
            format!("{err:?}"),
            "RotateCoversBelt",
            "ccw={ccw}: the turn would cover the small lane, and the refusal says a belt is in the way"
        );
        assert_eq!(
            postcard::to_allocvec(&s.core().state).expect("GridState serializes"),
            state,
            "ccw={ccw}: the board is byte-identical, nothing deleted"
        );
        assert_eq!(
            postcard::to_allocvec(s.edit_log()).expect("the edit log serializes"),
            log,
            "ccw={ccw}: nothing appended to the edit log"
        );
    }
}

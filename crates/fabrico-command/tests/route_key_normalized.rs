//! Phase 91 review WR-A-04: the duplicate-path rule compares Route paths by the key the host
//! routes on, so a typed `/route-1` is refused against a forged slashless `route-1`.
//!
//! The host keys a Route through `endpoint_route_key` (exactly one leading `/`), and a
//! hand-edited `.fab` can carry a slashless path because `fold_configure` applies records as
//! written. Both key as `/route-1`, so accepting the typed one would put two Routes on one
//! key and the host's route map would keep one of them with no word.
//!
//! Run target: `cargo test -p fabrico-command --test route_key_normalized`

use fabrico_command::{CommandError, GridSession};
use fabrico_core::edit::{EditOp, MachineConfig as CoreConfig};
use fabrico_core::ids::NodeId;
use fabrico_core::state::Node;
use fabrico_protocol::{GridCommand, MachineConfig, machine_kind};

const SEED: u64 = 0x0091_0404;

fn path_of(session: &GridSession, id: NodeId) -> String {
    match session.core().state.node(id) {
        Some(Node::Endpoint(ep)) => ep.path.clone(),
        other => panic!("expected a live Route at {id:?}, found {other:?}"),
    }
}

fn place_route(session: &mut GridSession, x: i32) -> NodeId {
    session
        .apply(GridCommand::Place { kind: machine_kind::ENDPOINT, cell_x: x, cell_y: 3 })
        .expect("a Place{ENDPOINT} is accepted");
    session.core().last_tick.placed[0]
}

fn set_path(session: &mut GridSession, id: NodeId, path: &str) -> Result<(), CommandError> {
    let node = session.view().handle_of(id).expect("a live Route has a handle");
    session
        .apply(GridCommand::Configure { node, config: MachineConfig::Endpoint { path: path.to_owned() } })
        .map(|_| ())
}

/// Route A is given `/a`, and that record is forged to the slashless `route-1` and replayed
/// (a hand-edited save). Route B is placed and moved to `/b`, so it holds no number. Then B is
/// configured to `/route-1`: refused `DuplicatePath`, A named as the owner key's holder.
///
/// RED BEFORE THE FIX: the owner lookup compared raw strings, `route-1` against `/route-1`,
/// found no owner and accepted the Configure.
#[test]
fn a_typed_path_is_refused_against_a_forged_slashless_twin() {
    let mut session = GridSession::new(SEED);
    let a = place_route(&mut session, 0);
    set_path(&mut session, a, "/a").expect("the first Route may take /a");
    let mut records = session.edit_log().to_vec();
    let last = records.last_mut().expect("the board has an edit log");
    match &mut last.op {
        EditOp::Configure { config: CoreConfig::Endpoint { path }, .. } => "route-1".clone_into(path),
        other => panic!("measured: the last record is the Route's Configure, found {other:?}"),
    }
    let mut session = GridSession::replay(SEED, &records);
    assert_eq!(path_of(&session, a), "route-1", "precondition: the forged path landed as written");

    let b = place_route(&mut session, 4);
    set_path(&mut session, b, "/b").expect("the second Route may take /b");

    let facts = vec![
        ("verdict", format!("{:?}", set_path(&mut session, b, "/route-1"))),
        ("b_after", path_of(&session, b)),
    ];
    assert_eq!(
        facts,
        vec![("verdict", "Err(DuplicatePath)".to_owned()), ("b_after", "/b".to_owned())],
        "/route-1 is the key a forged route-1 answers at"
    );
}

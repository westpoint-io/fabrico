# Fabrico

Belts move left to right across a dark grid. A machine three tiles wide takes an item off the belt,
holds it for one tick, and pushes two items out of two different mouths. One goes up a corridor to a
machine that works out the order total. The other jogs down around a corner and ends at a box on the
right edge that swallows it whole.

The item that went into that box was a customer order. It arrived a second ago as a POST to a URL on
your own machine. The machine that split it in two ran your JavaScript, in a sandbox with no clock in
it. The box on the right edge is an HTTP sink, and it has already made the fulfilment call, stamped
with an idempotency key so it cannot make it twice.

**Fabrico is an open-source desktop application: a factory-building game whose factory runs your real
work.** You place machines on a grid and connect them with conveyor belts. Events arrive from outside
(a webhook fires, a timer expires), ride the belts as items, get transformed by machines, and end at a
machine that does something real.

There is less sleight of hand here than you would expect, so the rest of this page builds that board
from an empty grid.

---

## Two gestures

Click Source, click a cell. You have placed a one-tile machine that came with a URL of its own,
`http://127.0.0.1:41653/hook/src-4294967297`, on a fresh loopback port every launch. POST anything to
it. Your bytes become exactly one logged event, verbatim, an item appears on the machine's output
face, and then it is dropped, because you have not given it anywhere to go.

So give it somewhere to go. Arm the belt tool and drag four tiles east. Press play and the tread
starts marching. POST again, and this time your bytes step onto the belt and travel: four slots to a
tile, two ticks a slot, at about sixty-two ticks a second. You are watching a webhook cross a room.

Nothing was deployed between those two gestures and that moving item. There is no build step here and
no file they compiled into.

## Building the order line

The board from the top of this page ships under Examples as "Load order processing". Six machines,
five belts, twenty-eight commands. Building it by hand goes like this.

**Place the Source at (1,6)** and draw a belt through (2,6), (3,6), (3,5), (4,5). There is no
auto-routing: the cells you draw are the cells you get, and an illegal path rejects the whole belt
rather than half of it. The path you drew is the path items take, because the belt *is* the queue and
distance is delay.

POST a real order at that URL:

```json
{"id":"ord-1","items":[{"sku":"widget","qty":2,"price":5}]}
```

Those exact bytes ride the belt.

**Drop a Factory at (5,5),** three cells by three. Select it and a JavaScript editor opens, pre-filled
with `export default function (input, ctx) { ctx.emit(0, input); }`. Replace it with the thing you
actually want:

```js
export default function (input, ctx) {
  if (!input || !input.id || !Array.isArray(input.items)) { throw new Error("not an order"); }
  ctx.emit(0, { kind: "invoice",     order: input.id, items: input.items });
  ctx.emit(1, { kind: "fulfillment", order: input.id, items: input.items });
}
```

Apply compiles that inside the real sandbox before it is allowed into the edit log, so JavaScript that
does not compile cannot become part of a factory's history. One Apply is one undo step.

**That `emit(1)` needs a second exit.** In the Ports section, click "+ Add output". Adding it re-seats
the machine's whole port list, which the panel warns you about, because docked belts will need
redrawing. The four ports land at In (5,5) west, the first Out (7,5) east, the second Out (7,6) east,
and the fault port (5,7) south. Emit 0 leaves the upper mouth, emit 1 the lower.

**Run the two corridors.** A belt from (8,5) up to row 3 and east into a Factory at (13,2) that works
out the invoice total. A belt from (8,6) down to row 10 and east into a Factory at (13,9) that emits a
shipping job.

**Cap each corridor with a Sink.** (21,10) set to HTTP, with a target URL you type into the panel.
(21,3) set to Debug, which makes no outbound call and shows each invoice arriving.

Press play, POST the order again, and one webhook becomes two items travelling in opposite directions
and one outbound POST carrying `Idempotency-Key: fabrico-cmd-<tick>-<node>-<seq>`. All three fields
come from the logged command id, minted with no clock and no randomness, so the same command produces
a byte-identical key on every replay and on any machine.

Six placements, one added port, five belts, ten docks, six configurations. None of it is a narrated
demo either: a live end-to-end test rebuilds this exact board from empty using nothing but palette
clicks, belt drags and panel edits, then proves it equivalent to the shipped scene both statically and
dynamically. If a step were impossible by hand, that test would fail.

## Now break it, flood it, and answer somebody

**You have already built the ordinary automation.** Webhook in, JavaScript in the middle, a real HTTP
call out, with an append-only log underneath it. That is the everyday job most of this software
category exists to do, and here it was six machines and five belts. A Source can also be a Timer,
firing on `tick % interval == 0`, which is a pure function of simulation time and so reproduces on
replay without a clock ever being read.

**Break it.** POST `{"id":"ord-2"}` with no items array. The splitter throws. That tick produces
nothing on its normal outputs, no side-effect commands leave it, `ctx.state` rolls back to its previous
value, and the machine draws a red ring. A fault record goes out the fault port carrying the reason,
the machine that produced it, an attempt count and the JavaScript error message. That port is the
third nub on the Factory's south face and you dock a belt to it like any other. In the shipped example
nobody wired it, so the fault is dropped and the board tells you nothing. Draw a belt off it to a Sink
and you have a dead-letter queue you can see from across the room. Error handling in most workflow
tools is a checkbox on a node. Here the failure path has a location, which is what makes you notice
you have not built one.

**Flood it.** A Factory takes exactly one item per tick no matter how hard you push, and re-wakes
itself while a backlog remains. Send a hundred orders at once and they do not vanish into a queue you
cannot inspect: a belt refuses to advance into an occupied slot and refuses to admit onto a full tail,
so a belt feeding a full belt keeps its head item and the items bunch, four to a tile, drawn at their
true slot positions while the far end of that belt runs empty. Full in front, empty behind, is a
bottleneck, and you find it by looking. Nobody implements flow control to get that: there is simply
nowhere for the next item to stand. Put a Balancer in front of two copies of a machine and the
round-robin split is two visible streams rather than a config field called concurrency. Broadcast with
a Tee, switch on content with a Router, funnel back together with a Merge.

**Answer somebody.** Some work cannot be fire-and-forget, because a caller is holding the line. Load
the demo scene and there is a second kind of connection on the board: a thin cable, not a belt. A
one-tile HTTP Endpoint at (10,6) holds a caller's socket open, joined to a one-tile handler Factory at
(14,6) by two wires, a forward one carrying the request and a return one carrying the reply home. One
tick later the handler has the request body as its `input` and answers with
`ctx.command({ status: 200, headers: { "x-fab": "home" }, body: "home" }, 0)`. The correlation id and
the return address ride on the message itself, so nothing in the middle has to remember anything, and
the parked socket is written from off the simulation thread. Belts carry work that can wait; the wire
carries a caller who cannot. Every failure is a status rather than a hang: 404 for an unknown door,
503 when the caller cannot be parked, 502 for a malformed reply, 413 for an oversized body, and a
host-synthesised 504 when the 300-tick deadline, about five seconds, passes with no answer. You can
rewrite that handler in the panel while the app is running.

**And all of it went into the log.** Two ordered, append-only, independently versioned logs, actually:
one for runtime events and one for the build gestures that made the board. Both go into a save file,
and both are folded forward on replay, edits first at each tick. Undo does not rewind either of them.
It computes the inverse of your last action, appends it behind a lineage marker, and folds it in one
tick, so the history only ever grows. Replay reads it all forward and rebuilds the identical grid with
the outbound executor muted, so no POST fires a second time. Most systems that call themselves
event-sourced treat the log as a record of what happened. Here the grid is a projection you could
throw away and recompute. Which is why you can take yesterday's real traffic, run it against the
factory you rewired this morning, and diff the outcome: the same events through the same engine, and
nobody's inbox finds out.

---

## Why Factorio

Factorio is a game about building factories, and it is also, by accident, one of the best interfaces
anyone has ever built for designing concurrent systems. Millions of people who would never call
themselves programmers have built genuinely sophisticated distributed systems in it: pipelined,
load-balanced, back-pressured, fault-tolerant, running at scale, debugged by eye. That is not a
coincidence, and it is worth being precise about why.

| What Factorio does | What it gives you |
|---|---|
| **The program has a location.** Every piece of logic occupies space on a map. | You navigate your system by moving through it. Spatial memory replaces remembering what a node was called. |
| **Throughput is visible.** A bottleneck shows up as a full belt in front of a machine and an empty one behind it. | You diagnose by looking, not by reading a dashboard. |
| **Backpressure is the model, not a feature.** A full belt stops the thing feeding it. | Nobody has to design flow control. It falls out of the geometry. |
| **Composition is physical.** Two subsystems connect because a belt touches a belt. | No registry, no name binding, no interface declaration. |
| **Blueprints.** Copy a working chunk of factory and stamp it somewhere else. | Reuse without abstraction. You never have to parameterise a thing to use it twice. |
| **The build loop and the run loop are the same loop.** You extend a live factory one belt at a time and it keeps running. | There is no deploy step, and no state where the system is half-built and broken. |

And underneath all of it, Factorio's simulation is deterministic lockstep. That is how its multiplayer
and its replays work: same seed, same ordered inputs, same factory. Factorio is already an
event-sourced system with a beautiful front end bolted to it.

Fabrico is an attempt to keep those properties and point the belts at real work. Most of them are in
the app today. Blueprints are not, and a machine that cannot keep up queues internally rather than
refusing at its mouth, so the backpressure you can watch is belt to belt rather than into a machine.

## Where it sits

Fabrico occupies an intersection that is normally empty. Three families of tool each hold one third of
it:

|  | Zapier, Make | n8n, Node-RED | Temporal, Restate | Factorio | **Fabrico** |
|---|---|---|---|---|---|
| Visual model | linear step list | node graph | none, code only | spatial grid | **spatial grid** |
| Runs on your machine | no | yes | yes | yes | **yes** |
| Deterministic replay | no | no | yes, by discipline | yes | **yes, by construction** |
| You can watch it work | no | after the fact, in a log | no | yes | **yes, live** |
| Backpressure | hidden | absent | hand-rolled | inherent | **inherent, belt to belt** |
| Does real work | yes | yes | yes | no | **yes** |

### Against n8n and Node-RED

These are node graphs, and in a node graph the geometry is decoration. Shuffle every node on the canvas
and the workflow is byte-identical, because position carries no meaning. In Fabrico the position *is*
the wiring: a belt has a length, a capacity and a transport latency, and distance is delay. A run in
n8n is something you inspect afterwards from an execution log. A factory in Fabrico is something you
watch while it happens. And their replay story is nothing: run the same input twice and you may get two
different results, because `Date.now()` and `Math.random()` and arrival order are all right there in
your function nodes.

### Against Temporal and Restate

These are the honest technical peers, and they are excellent. Durable execution engines rebuild
workflow state by replaying an event history, which is exactly Fabrico's core idea. The difference is
who holds the promise. Temporal asks *you* to write code that is deterministic and fails your workflow
on replay when you break the rule. Fabrico's sandbox never hands your code a clock or a random source
in the first place, so the promise is not yours to break. The second difference is that a durable
workflow has no shape. You cannot see it, and you cannot see where it is clogged.

### Against Factorio and the programming games

Shenzhen I/O, TIS-100 and Factorio all simulate a fictional machine very convincingly. Fabrico's
machine is the one running your work.

## What makes it technically unusual

Determinism here is not a feature bolted on for replay. It is the constraint the whole engine was built
around, and most of the design falls out of it.

- **Integer time, integer space.** A fixed-tick single-threaded simulation at about sixty-two ticks a
  second. All simulation maths is fixed-point (`I32F32`), never `f32`/`f64`, because float results
  differ across CPUs and compilers and that alone would break replay. Ordered iteration only:
  `BTreeMap` and id-ordered slotmaps, never a `HashMap` walk.
- **The log is the source of truth and grid state is a projection of it.** One rule, enforced by
  compile-time lints that deny the whole category: the clock, randomness, external results and user
  input can only enter the simulation as logged events. Randomness is a seeded `ChaCha8` stream whose
  seed and position live in the log.
- **Nondeterminism removed, not policed.** `Date`, `fetch`, `setTimeout` and `require` do not exist in
  the sandbox at all: the context is built from a curated intrinsic set and nothing else is installed.
  `Math` goes further, and is replaced every tick by a curated copy carrying only the bit-exact members,
  so `Math.random` and every transcendental are simply gone. Randomness comes from `ctx.random()`, drawn
  from that machine's own seeded, snapshotted stream.
- **Runaway code is stopped by an instruction counter,** not a wall-clock timeout, because a wall-clock
  timeout is itself a nondeterministic result. Memory and stack fences sit alongside it.
- **Side effects leave through one door and cannot fire twice.** A machine emits a logged command with a
  tick deadline; an executor off the simulation thread performs the effect and feeds the result back as
  a stamped event at a later tick, so the grid never blocks. A write-ahead ledger gives at-most-once
  recovery across a crash, and the executor is muted entirely during replay.
- **Idle is free.** An active-set scheduler means an idle tick steps zero machines. Cost tracks the work
  in flight, not the size of the grid.
- **The proof is a standing gate, not a claim.** A frozen in-repo corpus of 40 scenarios replays to
  frozen per-tick `blake3` hash manifests, asserted byte for byte. Snapshot at any tick, restore, and
  continue is bit-identical to replaying from genesis. Permuting the arrival order of same-tick events
  from different sources changes nothing.

## Architecture

A Rust workspace with a headless simulation core that knows nothing about Tauri, pixels or the network,
and a TypeScript renderer that is only ever a renderer.

| Crate | Role |
|---|---|
| `fabrico-core` | The deterministic simulation. No I/O, no clock, no floats. |
| `fabrico-command` | The edit layer: placement and wiring as undoable commands. |
| `fabrico-protocol` | Shared event and render-packet types. |
| `fabrico-host` | Everything impure: webhook listener, outbound HTTP, persistence. |
| `fabrico-scenario` | The determinism test harness and golden corpus driver. |
| `fabrico-app` | The Tauri 2 desktop shell. |
| `frontend/` | PixiJS v8 canvas plus a React UI, fed binary render packets over a Tauri channel. |

A machine's entire authority is a small capability object handed to its step call: the tick, its own
ports, a command sink, a self-targeting wake, and its seeded RNG. There is no route from inside a
machine to a clock, a file, the network, or unseeded randomness. Machines reach each other only over
belts and wires, both addressed as `(node-id, port)` rather than by pointer. All simulation state is
plain serialisable data captured whole at a tick boundary, with nothing the simulation needs to resume
living outside the snapshot. Every event carries a 64-bit partition key that is hard-coded to zero and
that no behaviour depends on.

None of that is a distributed system, and building one is explicitly out of scope. It is the price of
keeping one from becoming impossible later.

## Where this goes

There is no public roadmap, so nothing here is a schedule. What exists is a set of
decisions already paid for in shipped code and a list of deferrals with triggers instead of dates.

The most valuable one is **scenario tests as a user-facing feature.** Record a session, pump events,
assert grid state, re-run it as a regression guard. The log fixtures, deterministic replay and state
hashing already exist, because they are the harness that certifies the engine. Turned outward, they
would let you regression-test a live automation against byte-identical replay of its own real traffic,
which is not something a non-deterministic workflow tool can offer at any price.

**Blueprints** are next-cheapest for a structural reason: a blueprint is a serialised sub-log of build
commands, so capture, stamp and share ride the substrate that already exists rather than needing
machinery of their own. Shareable blueprint strings and blueprint books are the larger version of the
same idea.

**The waiting room** (call-and-wait, scatter-gather, aggregate) is one shape: a machine holding a small
table across ticks. The port model was deliberately designed so it snaps in without a second corpus
rebuild.

**A factory embedded in a web page** as a live, read-only widget is the reason the renderer is kept
extractable from the desktop shell. The deterministic core is an unusually good fit for WebAssembly: no
threads, no I/O, no floats. That is a door held open, not a plan.

And **multi-node** is the one thing the architecture keeps possible and the project forbids building.
Share-nothing machines, logical addressing, fully serialisable state, tick-boundary capture and that
unused partition key are shipped requirements whose only purpose is to stop a sharded Fabrico from
being impossible later.

## Building it

```bash
cd frontend && npm install && npm run build   # the renderer, embedded into the binary
cargo build -p fabrico-app --features tauri/custom-protocol   # the desktop app
cargo test                                    # includes the determinism corpus
```

## Status

Pre-v1, under active development, no public release yet. The engine is real and certified, the
application is buildable by hand, and there are gaps worth knowing about before you judge it.
[STATUS.md](STATUS.md) is the honest inventory: what works in the shipped app, what works only in the
test suite, and what is missing.

Comments in the code cite internal design records by id: file names such as `62-CONTEXT.md`,
decision ids such as D-01, plan numbers such as 77-09, WINDOWS rows, and an earlier byte-freeze
gate that was retired before publication. Those notes are not published. The ids stay in place as
history; the code and tests are self-contained.

Changes to the deterministic core, the protocol, the scenario corpus or `Cargo.lock` are checked
by `scripts/check-core-declared.sh` against the tag `public-base`, the first commit of this
repository: a covered file may change, and the change must be declared in
[docs/DECLARED-MOVES.txt](docs/DECLARED-MOVES.txt). Run it from a clone with tags
(`git fetch --tags`).

## Licence

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or
  <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.

The two bundled fonts, Martian Mono and Sono, are licensed separately under the SIL Open Font
License 1.1. Their licence texts and provenance are in
[frontend/src/assets/fonts/](frontend/src/assets/fonts/NOTICE.md).

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.

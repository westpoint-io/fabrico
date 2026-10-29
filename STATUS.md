# Status

Pre-v1. This file is the inventory the [README](README.md) does not carry: what works in the shipped
desktop application, what works only in the test suite, and what is missing. Every entry below was
checked against the source rather than against a changelog.

Last audited: 2026-10-27. Each claim below was re-checked against the source on that date.

## Works in the shipped app

- Place Source, Sink, Factory, Tee, Balancer, Router, Merge, HTTP Endpoint and Handler machines, and
  free-text Labels. Draw belts and dock them. Draw request/response wires between electrical ports.
  Rotate. Delete. Undo and redo, including re-docking a belt that a rotation severed. Play, Pause and
  Step.
- A placed Source gets its own loopback webhook URL on an ephemeral port. One accepted POST becomes
  exactly one logged event carrying the body verbatim, bounded at 64 MiB (`MAX_RECORD_BYTES`). A repeat
  `x-delivery-id` is deduplicated against a durable on-disk seen-set, so an at-least-once provider
  cannot double-fire a Source. A POST arriving while the simulation is paused, draining, or 256 requests
  behind is refused 503 and logs nothing, so nothing is ever accepted and then lost.
- Timer Sources fire on `tick % interval == 0`, reading no clock.
- Write JavaScript in a Factory's config panel. Apply compiles it inside the real sandbox on the sim
  thread before it can enter the edit log. Add and remove output ports by hand.
- Configure a Router's ordered rule table (match text, byte offset, target output) and its default in
  the Router panel. A catalog Router has three outputs and a fault output.
- Set a belt run's pace (`ticks_per_slot`) in the Belt panel.
- Items pile up against a machine that cannot keep up: a machine's belt input holds at most 16 items
  (`MECHANICAL_INBOX_CAP`), and past that the belt bunches backwards from its head.
- HTTP Sinks call out through `reqwest` to a URL you type in, carrying
  `Idempotency-Key: fabrico-cmd-<tick>-<node>-<seq>` derived only from logged data.
- Save, Save As, Load and a truly blank New, through the native file dialog, to a portable `.fab`
  bundle carrying a tick-boundary snapshot plus both append-only logs. Boards saved by older builds
  are refused by version rather than loaded wrong.
- Three Examples scenes: the demo scene, the order-processing board the README walks through, and an
  advanced order-fulfilment pipeline.

## Works only in the test suite

- Nothing at present. The shipped app has no way to configure SMTP, so there is no Email sink: the
  Sink panel offers Debug and HTTP only.

## Missing

- **No public release.** No installer, no binary, no packaged build. Everything above assumes you built
  it yourself.
- **No connector catalogue.** Integration means writing JavaScript or calling HTTP. There is no library
  of pre-built app connectors.
- **No multi-node operation,** and building it is explicitly out of scope. The architecture keeps it
  possible; nothing implements it.
- **Only some machines have a fault output.** Faults are a reserved output port
  (`FAULT_PORT = u16::MAX`) that the tick fold routes like any other, but only Factory, Router, Sink
  and Handler carry a fault port on their bodies. Tee, Balancer, Merge and Source faults cannot be
  wired by hand.
- **No bounded retry.** You can draw a belt from a Factory's fault port back to its own input and get
  the delay from belt length, but what travels the belt is a fault record rather than the original item,
  so the Factory rejects it and faults again. The `attempt` counter is set to 1 and nothing increments
  it, so a loop cannot bound itself. Bounded retry needs fault-payload re-entry and attempt counting;
  neither has shipped.
- **No event-log scrub bar.** Both logs are recorded and replayable, but there is no time-travel UI.
- **The Debug sink is a drain.** It is the default target for every Sink you place. It performs no
  I/O and always reports success. It exists to exercise the dispatch path.

## Open defects

- **The Apply gate is a compile check, not a correctness check.** Apply only compiles the module and
  never evaluates it, so JavaScript that compiles but throws at run time is accepted into the log and
  faults per item instead.

## Evidence integrity

CI runs on every push to `master` and on pull requests (`.github/workflows/ci.yml`). Pull requests run
the Linux determinism leg only; pushes to `master` run the determinism gate on Linux, macOS and
Windows.

**Cross-platform determinism is MEASURED, not designed.** The core's whole promise is that the same
starting state plus the same ordered events yields an identical result on every replay. The Windows
and macOS legs run the same golden scenario corpus and its per-tick `blake3` manifests as Linux. The
Windows leg failed first, on a line-ending difference in an embedded scene file: the comparison was
not vacuous, it caught a real cross-platform divergence, and it passes because that divergence was
fixed rather than because nothing was being compared.

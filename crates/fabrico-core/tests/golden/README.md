# Golden corpus: frozen determinism fixtures (criterion 4 / REPLAY-03)

This directory is the **forever-growing cross-platform regression corpus**. Each
sub-directory is one self-contained, frozen scenario that the runner
(`tests/cert_cross_platform.rs`) replays from its genesis and asserts against its
frozen per-tick hash manifest. Because fixed-point math + deterministic postcard
serialization make the per-tick `blake3` state hash platform-independent **by
design**, the same fixtures re-prove on every OS in the CI matrix.

## On-disk format

```
tests/golden/<id>/
├── genesis.snapshot   # the genesis `Core` snapshot blob (topology built, tick 0),
│                      #   captured BEFORE any fold, as `snapshot::snapshot(&core)` bytes.
├── log.postcard       # the frozen ordered event log, `postcard::to_allocvec(&Vec<Event>)`.
├── edit-log.postcard  # the frozen ordered topology edit-log, `postcard::to_allocvec(&Vec<EditRecord>)`
│                      #   (added by the Phase-8 two-log split). EMPTY for pure event-flow
│                      #   fixtures that build all topology in the genesis snapshot.
├── hashes.txt         # N lines, one lowercase-hex `blake3` per tick boundary
│                      #   (the assertion target, asserted FOREVER).
└── meta.toml          # human/script-readable provenance: scenario id, builder, seed,
                       #   params, tick_count, schema_version, snapshot_schema_version.
                       #   NOT read by the runner.
```

The runner embeds the four DATA files (`genesis.snapshot`, `log.postcard`,
`edit-log.postcard`, `hashes.txt`) at **compile time** via `include_bytes!` /
`include_str!`: it never touches the filesystem (so it stays inside the determinism
clippy gate and is robust to cwd/OS). It folds BOTH logs (`fold_two_logs_collecting_hashes`,
edits-first per tick). `meta.toml` is for humans and the regen script only.

## Current schema + model (keep this current on every clean-break bump)

- **`SNAPSHOT_SCHEMA_VERSION = 14`**, **`EDIT_SCHEMA_VERSION = 13`** (the snapshot as of
  Phase 87, plan `87-03`, re-blessed in `87-08`; the edit version as of Phase 86, plan `86-02`,
  re-blessed in `86-03`). The genesis `Core` snapshot is prefixed by the snapshot version tag,
  so a version bump moves **every** per-tick hash even when sim behavior is unchanged.
  (Both numbers were stale here once: this block read `6` and `3` "as of Phase 11" long after
  a later bump moved them to `8` and `6`. The heading above instructs the reader to keep this
  current, so a stale block under that instruction is worse than either state alone. Corrected
  in one pass by Phase 60, which took the snapshot version from 8 to 9; Phase 62 takes it from
  9 to 10, byte-forced by `Belt.ticks_per_slot`. `EDIT_SCHEMA_VERSION` moved in neither phase;
  only this transcription of it did. The rot is now machine-gated:
  `fabrico-host/tests/golden_readme_currency.rs` reddens if this line stops naming the live
  values, which is why the number above is edited in the SAME commit as the constant.)
  Phase 63 (`63-11`) takes `EDIT_SCHEMA_VERSION` 6 to 7 and moves NOTHING else. It is the
  first bump in this block that is not byte-forced: no `EditRecord` field changed in
  milestone v8.0, so a pre-v8.0 edit log would decode perfectly well. That is exactly why
  the version refuses it. `edit::check_version` accepts ONLY the running version, forward
  and backward, replacing the forward-only test that shipped from v1 through v6, on the maintainer's
  2026-08-18 authorisation that the system is not in production use. The consequence for
  this corpus is a version-tag-only re-bless: `schema_version` is the first field of every
  record and encodes as a one-byte varint, so the fixtures with a non-empty
  `edit-log.postcard` change `0x06` to `0x07` once per record with NO length change, and
  `genesis.snapshot`, `log.postcard`, `hashes.txt` and `meta.toml` do not move at all. That
  re-bless is quarantined to plan `63-12`.
  Phase 72 (`72-12`) takes `SNAPSHOT_SCHEMA_VERSION` 10 to 11 and moves `EDIT_SCHEMA_VERSION`
  NOT AT ALL, which is the opposite pairing to Phase 63's above. It is byte-forced:
  `Node::Endpoint` was a zero-field marker from Phase 38 and now carries its Route path
  `String` (SERVE-08, plan 72-07), so any board holding a Route serializes differently. The
  consequence for this corpus is the WIDEST one in the block, and it is the shape a reader
  should expect from a SNAPSHOT bump rather than an EDIT one: the version tag is the first
  two bytes of `genesis.snapshot` AND `tick_hash` is `blake3` over those same bytes, so
  **all 30 fixtures move three files each** - `genesis.snapshot`, every line of `hashes.txt`,
  and `meta.toml`, which transcribes `snapshot_schema_version` as a literal line. Measured,
  not predicted: `log.postcard` and `edit-log.postcard` do NOT move for the bump (event logs
  carry `EventPayload`, not commands, and no `EditRecord` field moved), and the only
  exceptions are `0023` and `0024`, whose GENERATOR boards changed in the same commit so
  their handlers declare the electrical In that D-16 now requires. In lockstep with
  `PROJECT_FILE_VERSION` 8 to 9 and cmd-wire `EVENT_VERSION` 3 to 4; three of the five
  version constants moved and the other two are pinned unmoved by
  `fabrico-host/tests/endpoint.rs::core_version_consts_are_frozen`. That re-bless is
  quarantined to plan `72-12` and every moved path is declared in
  the declared-moves list.
  Phase 73 (`73-03`) takes `EDIT_SCHEMA_VERSION` 7 to 8 and moves NOTHING else, and unlike
  Phase 63's bump above this one IS byte-forced. Two fields on two EXISTING variants force
  it: `EditOp::AddPort` gains an `index` (UNDO-05's re-dock is unreachable while the
  inverse of a `RemovePort` can only re-append) and `DeletedSubgraph` gains a
  `self_record` (UNDO-01's deleted cable has no endpoints in the log without it). A field
  on an existing variant shifts every byte after it under postcard, which is what makes
  this different from the Phase 36 `AddPort`/`RemovePort` VARIANT appends that forced no
  bump at all.
  The consequence for this corpus is NARROWER than a reader might expect from a
  byte-forcing bump, and it was MEASURED rather than predicted (plan 73-01, recorded in
  `73-DECLARED-DELTA.txt`): only `edit-log.postcard` moves. `genesis.snapshot`,
  `log.postcard`, `hashes.txt` and `meta.toml` do NOT move in any fixture, because
  `tick_hash` is taken over Core STATE and both new fields live in the LOG, and because
  `fold_delete` still never consumes `captured` while a forward `AddPort` still resolves
  its index to the append position. Fixtures whose `edit-log.postcard` is the 1-byte empty
  log hold no `EditRecord` at all and so do not move either.
  Unlike `63-11` and `72-12`, this re-bless is NOT quarantined to a later plan: both
  forcing fields are forced by the same constant, so it lands in the same commit,
  with every moved path declared in the declared-moves list.
  Phase 74 (`74-02`) takes `SNAPSHOT_SCHEMA_VERSION` 11 to 12 and moves `EDIT_SCHEMA_VERSION`
  NOT AT ALL, the same pairing as `72-12` and the opposite of `73-03` immediately above. It
  is NOT byte-forced, and in that it resembles `63-11` rather than `72-12`: `ports` is a map
  that already existed, so a v11 body re-tagged forward DECODES and comes back with
  un-ported belts, which is a silent mis-decode rather than a `Malformed`. The refusal is
  deliberate, for that reason. What changed is that a `Belt` declared NO ports from Phase 11
  until now and declares TWO from here - a Tail `Role::In` and a Head `Role::Out`, both at `local_offset (0,0)`, both
  `Medium::Mechanical` - written into the same `GridState.ports` map machine ports have
  always lived in (LINK-08, `74-CONTEXT.md` D-04/D-06). That is what lets two belt runs be
  joined by the same link model that joins a belt to a machine.
  The consequence for this corpus is the WIDE shape again, and TWO causes stack rather than
  one. The version tag moves `genesis.snapshot`, every line of `hashes.txt` and `meta.toml`
  in **all 33 fixtures** - note 33, not the 30 the `72-12` paragraph above records, because
  the corpus grew in phases 70 and 71 and that older figure is history rather than a count
  to reuse. On top of the tag, 11 of those fixtures hold 13 belts at genesis and their
  belts' new port records grow `genesis.snapshot` a second time. MEASURED, not predicted
  (plan 74-01, recorded in `74-DECLARED-DELTA.txt`).
  ONE fixture moves a FOURTH file and it is not a red flag:
  `0032-undo-delete-of-a-bare-belt/edit-log.postcard` grows 79 bytes to 89, because its
  `DeletedSubgraph` capture records the deleted belt's port declarations and a belt now has
  two. The schema did not move; the content the schema carries grew. `log.postcard` moves
  in no fixture at all.
  In lockstep with `PROJECT_FILE_VERSION` 10 to 11 and with NOTHING else; two of the five
  version constants moved and the other three are pinned unmoved by
  `fabrico-host/tests/endpoint.rs::core_version_consts_are_frozen`. Like `73-03` and unlike
  `63-11`/`72-12`, the re-bless is NOT quarantined to a later plan: it lands in the same
  commit as the constant, with every moved path declared in the declared-moves list.
  Phase 74 (`74-08`) then GROWS the corpus by one, to **34 fixtures**, with
  `0034-belt-to-belt-junction-replay`, and `scripts/measure-golden-corpus.sh` moves its
  `EXPECTED_GOLDEN_FIXTURES` 33 to 34 in the same commit. The **33 the paragraph above
  records is not restated as 34**, and the distinction matters: 33 is the MEASURED width of
  the `74-02` re-bless, taken on a tree where 0034 did not exist, and rewriting it would
  turn a measurement into a claim about fixtures that were never re-blessed. 34 is the size
  of the corpus from `74-08` onward. The new fixture joins two abutting drawn belt runs with
  the belt-to-belt `Dock` this phase shipped, drives items across the junction until they
  bunch backwards over it into the slower downstream, and then `Unlink`s the same link in
  the same log so the disconnect is certified too. Every record is authored by the certified
  command path; the join is the one command that returned `Err(InvalidDock)` on every tree
  before this phase.
  Phase 74.1 (`74.1-12`) takes `EDIT_SCHEMA_VERSION` 8 to 9 and moves NOTHING else. Like
  `63-11` it is decision-forced, not byte-forced: no `EditRecord` field moved. Two fold
  verdicts changed what an unchanged log folds to (`74.1-03` narrowed the rotate facing
  clause; `74.1-12` made both port-edit folds release a belt dock whose re-seated port no
  longer faces its belt), so a version-8 log is refused rather than mis-folded. MEASURED
  consequence for this corpus: 22 of the 34 fixtures move, and 21 of them move ONE file,
  `edit-log.postcard`, by the version tag alone (0x08 to 0x09 once per record, no length
  change). The 12 whose `edit-log.postcard` is the 1-byte empty log hold no record and do
  not move. ONE fixture also moves by behaviour: `0033-remove-out-port-repoints` is the
  catalog-layout Router whose Undo re-seats the docked port one row off its belt, which
  since `74.1-12` releases that belt, so its `hashes.txt` moves from the undo tick on and its
  `meta.toml` moves by its re-authored `params` text. All 8 scenario postcards move by the
  version tag alone; no `.snap`, `genesis.snapshot`, `log.postcard` or protocol fixture
  moves. The re-bless lands in the same commit as the constant, every moved path declared
  in the declared-moves list.
  Phase 74.1 (`74.1-14`) takes `EDIT_SCHEMA_VERSION` 9 to 10 and moves NOTHING else.
  Decision-forced again, by the 2026-10-04 layout ruling ("Edits keep middle layout"):
  `reseat_ports` seats each role centre-out from the CATALOG box (`role_slot`: on a
  3-long side the middle, then below, then above, then grown rows), and
  `port_catalog(ROUTER)` took the rule's output (In (0,1), Outs on rows 1, 2, 0). Version 9
  is refused rather than reused although it never shipped, because it is in committed
  history. MEASURED consequence: the same 22 fixtures move. 15 move `edit-log.postcard` by
  the version tag alone (0x09 to 0x0a once per record, no length change). 0019, 0020, 0021
  and 0031 place a palette Router preset, so their `edit-log.postcard` also carries the new
  `Place{ROUTER}` offsets (and 0021 one undo `AddPort` record carrying a re-seated cell),
  and their `hashes.txt` moves because the preset seeding re-seats to the new cells. 0014,
  0015 and 0033 are RE-AUTHORED boards: their offload belt docks the catalog Router's
  middle-row first Out (0014, 0015) or third Out on its new doorstep (0033), so the belt
  cells, the `Place` offsets, `hashes.txt` and (0014, 0033) `meta.toml` move; 0033's undo
  now RE-DOCKS the belt the removal released, which adds one compensating `Dock` record.
  Scenario: 02, 03, 06, 08 move their postcard by tag only; 04 and 07 by tag only, but
  their `.snap` hash line moves because a Factory `AddPort` re-seats differently on replay;
  01 and 05 are re-authored (the belt into the Router's In now ends on (4,1)), so the
  postcard and the `.snap` move. Every moved path is declared in
  the declared-moves list in the same commit as the constant.
  Phase 74.1 (`74.1-16`) takes `EDIT_SCHEMA_VERSION` 10 to 11 and moves NOTHING else.
  BYTE-forced like `73-03` (two trailing fields on live variants: `EditOp::AddPort.seat` and
  `EditOp::RemovePort.restore`) AND decision-forced like `74.1-14`, by the design ruling of
  2026-10-04: no port edit moves an existing port. A removal keeps
  the box, the anchor and every survivor's slot and releases only the removed port's own
  belt; an add takes the first free slot of its role and grows the box only on its far
  edges, shifting the anchor on a turned machine (review WR-01). Version 10 is refused
  rather than reused although it never shipped, because it is in committed history.
  MEASURED consequence: the same 22 fixtures move. 15 move `edit-log.postcard` by the
  version tag alone (0x0a to 0x0b once per record, no length change). 0021 and 0031 move
  `edit-log.postcard` by the tag plus one byte per port-edit record (a `seat`, a `None`
  restore) and five more for 0021's one `Some` restore (the undo of its add), and their
  `hashes.txt` does NOT move: their boards fold to the same cells. 0019 and 0020 move their
  `edit-log.postcard` the same way and also move `hashes.txt` and `meta.toml`, because their removals no longer floor the grown Router back
  to 2x3 (it stays 2x5 and 2x7); that is BEHAVIOUR, and their params text says so. 0033 is a
  RE-AUTHORED board: a second belt on the removed Out, so the removal releases exactly that
  belt while the belt on the third Out is kept and re-keyed (the forward "re-keyed and kept"
  clause is reachable again), and one Undo re-docks only the released one; its
  `edit-log.postcard`, `hashes.txt` and `meta.toml` move. Scenario: 01, 02, 03, 05, 06, 08
  move their postcard by tag only; 04 and 07 by tag plus one byte per port-edit record (+1
  and +5), and no `.snap` moves. Every moved path is declared in
  the declared-moves list in the same commit as the constant.
  Phase 76 (`76-05`) GROWS the corpus by one, to **35 fixtures**, with
  `0035-label-inert-replay`, and moves NOTHING else: no version constant, no older fixture.
  Phase 76 made a label a sim object (`Node::Label { text, colour }` appended to the snapshot
  by `76-01`, `MachineConfig::Label` to the edit record by `76-02`, each a new last variant
  that moved no existing byte). The fixture is a Source, a belt and a Sink carrying items
  while a label beside the belt is configured `Order intake`, Lilac, 6 by 2 through the
  shipped `Configure{Label}`, deleted and undone; the undo's re-`Place` and
  re-`Configure{Label}` are frozen in its edit log. It certifies that a label's own bytes
  replay identically from genesis. It CANNOT see a regression in the Delete inverse that
  produced those records: the runner links no `fabrico-command`, so that guard is
  `crates/fabrico-command/tests/label.rs`. `scripts/measure-golden-corpus.sh` moves its
  `EXPECTED_GOLDEN_FIXTURES` 34 to 35 in the same commit, and the directory is declared in
  the declared-moves list.
  Phase 85 (`85-05`) takes `SNAPSHOT_SCHEMA_VERSION` 12 to 13 AND `EDIT_SCHEMA_VERSION` 11 to
  12, in lockstep with cmd-wire `EVENT_VERSION` 4 to 5, all BYTE-forced by one deletion: the
  Email sink target left the core with no placeholder (CHROME-04, D-08), so
  `SinkTemplate::Http` moved from discriminant 2 to 1 and `Effect::Http` from 3 to 2. The same
  EDIT 12 shape appends `EditOp::SealHistory` at discriminant 12 (D-10), which moves no stored
  byte, and the same commit series gives the palette Router preset a Mechanical Fault port
  after its Outs (D-22). MEASURED consequence (`measure-golden-corpus.sh` before the re-bless:
  `0 IDENTICAL / 35 MOVED of 35`): all 35 fixtures move `genesis.snapshot`, every line of
  `hashes.txt` and `meta.toml` on the snapshot tag. The 23 whose `edit-log.postcard` holds
  records move it on the edit tag (0x0b to 0x0c once per record). On top of the tags:
  `0006-executor-loop`'s HTTP sink moves its template byte 2 to 1 (same length); 0019, 0020
  and 0021 seed one more `AddPort` (the Fault, 15 bytes, one more tick) and 0031 two (30
  bytes, two preset Routers, two more ticks), so their `hashes.txt` grows and their `meta.toml`
  builder text names the Fault; 0021's generator now removes the last Out by role, since the
  Fault sits last. Scenario: all 8 postcards move by the edit tag alone (same lengths) and
  all 8 `.snap` hash lines move. `log.postcard` moves in no fixture. Every moved path is
  declared in the declared-moves list; phase 86 amends the 0031 and 0032 lines in place.
  Phase 86 (`86-02`) takes `EDIT_SCHEMA_VERSION` 12 to 13 and moves NOTHING else. BYTE-forced:
  three fields appended last (`EditOp::Place.rot`, `DeletedSubgraph.rot`,
  `DeletedBelt.ticks_per_slot`), so a deleted turned machine comes back turned in one step
  (WORK-02, D-03). Plan `86-03` then makes every Delete undo re-apply the deleted node's config
  ALWAYS, and each cascade belt's pace after its re-draw (WORK-01, D-01, D-02), which grows the
  undo groups the generators write. The corpus is re-blessed ONCE, in `86-03`, after both.
  MEASURED consequence (`measure-golden-corpus.sh` before the re-bless: `12 IDENTICAL / 23 MOVED
  of 35`, each MOVED row `edit-log.postcard` alone): the 23 with records move it on the edit
  tag (0x0c to 0x0d once per record) plus one rot byte per `Place` and per Delete capture and
  one pace byte per captured belt. On top of that, `0014-undo-delete-with-docked-belt`'s undo
  group gains a `Configure{Router}` and the docked belt's `Configure{Belt}`, and
  `0032-undo-delete-of-a-bare-belt`'s a `Configure{Belt}`; 0031 (a wire has no config) and
  0035 (a label's re-Configure is 76-05's) gain no record. No `hashes.txt`, `genesis.snapshot`,
  `log.postcard` or `meta.toml` moves: a re-applied config equal to the live value leaves the
  board as it was. Scenario: all 8 postcards move (the edit tag and the rot and pace bytes;
  `01-exit-gate`'s move undo also gains the Sink's `Configure{Sink}` and its docked belt's
  `Configure{Belt}`), and no `.snap` moves. The 0031 and 0032 lines and every other moved path
  are amended in place in the declared-moves list.
  Phase 87 (`87-03`) takes `SNAPSHOT_SCHEMA_VERSION` 13 to 14 and moves `EDIT_SCHEMA_VERSION`
  not at all. BYTE-forced by four fields, each appended last in its struct: `Balancer.next_in`
  (JAM-01), `Tee.faults` (JAM-02), `Factory.pending_emits` (JAM-05) and `Scheduler.blocked`
  (JAM-04, the sleep set). Plans `87-04` to `87-07` then change behaviour on boards that hit a
  jam, and the corpus is re-blessed ONCE, in `87-08`, after all of them. MEASURED consequence
  (`measure-golden-corpus.sh` before the re-bless: `0 IDENTICAL / 35 MOVED of 35`): all 35
  fixtures move `genesis.snapshot`, every line of `hashes.txt` and `meta.toml` on the snapshot
  tag. On top of the tag, three fixtures hold a board the phase's mechanisms reach, as
  87-RESEARCH's instrumented replay predicted: `0030-inbox-saturation-replay` (a Source gated
  behind its full output sleeps, JAM-04) and `0012-draw-belt-flow`, `0030` and
  `0034-belt-to-belt-junction-replay` (a settled belt sleeps, plan `87-07`); a sleeping node joins
  `Scheduler.blocked`, which every tick hash covers. No `edit-log.postcard` or `log.postcard`
  moves. Scenario: all 8 `.snap` hash lines move on the tag, and `01`, `05`, `06` and `08` hold
  settled belts as well; no postcard moves. The per-tick item census taken in `87-08` (each
  node's inbox total and each belt's occupied slots, replayed at the phase's start and after the
  re-bless) is the check that the tag-forced re-bless hid no item-flow change; its readings are
  in the phase 87 evidence. Every moved path is amended in place in
  the declared-moves list. The same plan adds five fixtures, one per core jam the phase
  fixed, each built through the core seam as 0030 is and minted at SNAPSHOT 14:
  `0036-balancer-both-inputs` (JAM-01), `0037-tee-slow-branch` (JAM-02),
  `0038-refused-fault-bounded` (JAM-03), `0039-jammed-solid-goes-idle` (JAM-04, a jam that
  sleeps for 200 ticks and one `Dock` edit that releases it) and `0040-factory-two-emits`
  (JAM-05). `scripts/measure-golden-corpus.sh` moves `EXPECTED_GOLDEN_FIXTURES` 35 to 40 in the
  same commit, and each directory is declared in the declared-moves list.
- **Belts are the per-tile slot model** `Belt { tiles, slots, geometry }` (Phase 11 clean-break
  cutover), NOT the retired v1.0 `Belt { latency, in_flight }` delay-line. A `Wire`-minted
  belt is now a short slot belt; `EditOp::DrawBelt` (discriminant 4) carries a resolved tile
  path. `SLOTS_PER_TILE = 4` (moved from three by Phase 60, `60-CONTEXT.md` 2026-08-09, so the
  slot pitch divides the 32 px render tile at exactly 8 px). Belt length couples capacity AND
  latency, and since Phase 62 a belt ALSO carries its own advance interval
  (`Belt.ticks_per_slot`, SLOT-03), so **traverse-time is `(4 * tiles - 1) * ticks_per_slot`
  advance ticks, plus an admission-alignment offset of at most `ticks_per_slot - 1` ticks**
  (head delivery is ungated, so there is no further whole interval on top). This block read
  `4 * tiles - 1` with no interval term until Phase 62; that form is the `ticks_per_slot == 1`
  case of the formula above and is corrected in place. That contract is stated
  in exactly three places and all three must agree: here, `src/belt_slots.rs` and `src/belt.rs`.
  The one-knob doctrine that said length was the only knob is SUPERSEDED by name in
  `src/belt_slots.rs`'s `SLOTS_PER_TILE` docblock (`62-CONTEXT.md` D-02).
- The earlier **"a length-1 belt is byte-identical to the v1.0 depth-1 belt" anchor is RETIRED**
  (Decision 2026-06-29): single-lane per-tile belts have different, deliberate timing. The
  certification anchor is now **determinism + item-conservation** (`delivered + resident ==
  admitted`, retain-not-drop under backpressure), proven by a proptest + the belt golden fixtures.
- Re-bless reading guide: on a clean-break bump, **belt-less** fixtures' hashes move ONLY by the
  version tag (genesis bytes otherwise identical); **belt-bearing** fixtures also move by the
  belt representation + slot timing. A belt-less fixture changing for any other reason is a RED FLAG.

Freezing both the **genesis snapshot + log bytes** AND the **per-tick hashes**
makes a fixture fully self-contained and builder-independent: the runner restores
the frozen `Core` and folds the frozen log, so an input-decoding drift (schema
change) and a state-evolution drift (behavior change) surface distinctly.

## Adding a new scenario

1. Write a new `#[ignore]`d generator `gen_<id>` in `tests/regen.rs` (build the
   topology, capture `snapshot::snapshot(&core)` BEFORE folding, script a static
   `Vec<Event>` (runtime events) AND a static `Vec<EditRecord>` (topology edits;
   leave empty for a pure event-flow scenario), call `freeze(...)`).
2. Freeze it: `scripts/regen-golden.sh new <id>`. This runs the matching
   `gen_<id>` and writes the data files (`genesis.snapshot`, `log.postcard`,
   `edit-log.postcard`, `hashes.txt`, `meta.toml`) into `tests/golden/<id>/`.
3. **Register it in the runner**: add one record to the `CORPUS` array in
   `tests/cert_cross_platform.rs` (four `include_bytes!`/`include_str!` lines:
   `genesis`, `log`, `edit_log`, `hashes`). This deliberate code edit is the
   reviewed act that grows the corpus.
4. **Register it in the registration guard too**: add one name to `REGISTERED` in
   `tests/corpus_registration.rs`. That list is a deliberate SECOND copy of the
   registry (integration tests are separate crates and cannot read each other's
   private `const CORPUS`), and the guard counts the runner's `Fixture {` record
   openers and requires the two counts to agree, so a fixture registered in only
   one of the two files is RED. Step 3 alone is not enough and this step was
   missing from these instructions until plan `74-08` followed them and found out.
5. **Move the corpus-size constant**: `EXPECTED_GOLDEN_FIXTURES` in
   `scripts/measure-golden-corpus.sh` is read as an EQUALITY twice, against the
   directory count and against the number of generators that ran, so it moves in
   the SAME commit as the fixture. Either half alone exits 2.
6. `cargo test -p fabrico-core --test cert_cross_platform --test corpus_registration`
   must pass, and `bash scripts/measure-golden-corpus.sh` must exit 0.
7. Commit all FIVE data files (`genesis.snapshot`, `log.postcard`,
   `edit-log.postcard`, `hashes.txt` and `meta.toml`; this line said "four" until
   `74-08`, because `meta.toml` is written by the same `freeze()` call and is as
   much a part of the fixture as the rest) plus the runner, guard, generator and
   constant edits.

## BLESS policy (non-negotiable, threat T-3-BLESS)

A changed golden `hashes.txt` is a **deliberate, reviewed behavior change**, never
an auto-overwrite on test failure:

- The runner NEVER re-writes a fixture; a hash mismatch is a hard test FAILURE.
- Re-freezing an existing fixture requires the explicit
  `scripts/regen-golden.sh bless <id>` subcommand.
- `bless` prints a reminder to **review the `git diff` of `hashes.txt`** before
  committing: the corpus is asserted forever, so a hash change must be understood
  and justified in review (it means the simulation's deterministic output moved).

The corpus grows monotonically: every fixed bug or new scenario adds a frozen log
asserted forever.

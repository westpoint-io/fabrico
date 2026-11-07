//! THAW-02 / THAW-10: the wiring of the declared-moves gate, its non-vacuity prover, the
//! other gate provers and the toolchain pin check into `.github/workflows/ci.yml` is
//! asserted BY A TEST, not by a human reading the workflow.
//!
//! # Why a test at all, when there is a CI badge
//!
//! A badge only says the last run was green. When this test was written the workflow had
//! not executed for a long stretch, and an earlier audit had recorded the consequence: a
//! job carried a STALE base ref for two whole phases and would have exited 1 on every
//! commit, and nobody found out, because nothing ran it. A gate nobody runs is a gate
//! that rots silently.
//!
//! So "the step is wired in" cannot be evidenced by a green run. It has to be an exit
//! code from something that DOES run, and `cargo test` is the only such thing. This file
//! is that exit code.
//!
//! # What this test can and cannot prove, stated so it is not assumed
//!
//! It proves a STEP EXISTS, in the right place, invoking the right script, with the right
//! base ref in its environment. It proves NOTHING about whether that step PASSES on a
//! runner - no assertion here executes a workflow. Whether CI passes on a runner is the
//! second thing and stays an open question; this file does not claim it.
//!
//! # Why a compile-time embed and never a runtime read
//!
//! The workflow is pulled in at COMPILE TIME. Nothing here touches the filesystem at run
//! time, which is the discipline `golden_readme_currency.rs` follows for the same reason:
//! it keeps the test a pure READ, robust to the caller's working directory and to which
//! OS the suite is running on, and it means a moved or deleted workflow is a BUILD
//! failure rather than a silent skip.
//!
//! # Why the assertions are scoped to `run:` lines
//!
//! Because `run:` in this workflow is not always a step. `ci.yml` has a `run:` under a
//! `defaults:` block (it sets `shell: bash` for the determinism matrix), and two `run: |`
//! multi-line blocks whose body lines do not begin with `run:` at all. Ruling R-9 (phase
//! 70) settles the consequence in the workflow rather than here: every gate step is a
//! SINGLE-LINE `run:` invocation, never a `run: |` block, which is what makes the counting
//! below exact.
//!
//! It also means these assertions are deliberately NOT a whole-file ban on script names.
//! `ci.yml` keeps prose recording why gates were added and replaced; that record is worth
//! more than the tidiness of a file-wide grep, and R-9 scopes the assertions to `run:`
//! lines precisely so it can survive.
//!
//! # CI spend controls (2026-09-30)
//!
//! `ci_spend_controls_are_wired_fail_safe` pins the four controls that cut CI spend: the
//! concurrency group that cancels superseded pull request runs and never a master run,
//! the determinism matrix that runs macOS and Windows only off pull requests, the
//! `workflow_dispatch` trigger, and the docs-only skip. For the skip it asserts that
//! every job is classified as heavy (gated) or always-on, that every heavy job carries
//! the exact fail-safe gate and no always-on job does, that no other polarity of the gate
//! exists, that the classifier's prover runs immediately before the classifier, that
//! the neutrality gate (a markdown scan) runs once, in its own always-on job, and that the
//! private-residue gate and its prover run once each, in the always-on `private-residue`
//! job.

/// The annotated tag every declared move is resolved against. It sits on the commit its own
/// message names.
const DECLARED_MOVES_BASE_TAG: &str = "public-base";

/// The env key that carries it. Asserted as a LINE PREFIX, never as a substring of the
/// whole file: the workflow's prose names the tag several times, and a whole-file
/// `contains` would stay green with both env lines deleted.
const DECLARED_MOVES_BASE_KEY: &str = "DECLARED_MOVES_BASE:";

/// How many jobs resolve that base: `core-freeze` runs the gate, `freeze-gate-bites` runs
/// its prover, and each needs its own `env:`.
const DECLARED_MOVES_BASE_SITES: usize = 2;

/// `.github/workflows/ci.yml`, embedded at compile time. The path is relative to THIS
/// source file: `crates/fabrico-host/tests/` -> `../../../` is the repository root.
const CI_YML: &str = include_str!("../../../.github/workflows/ci.yml");

/// Scripts this workflow invokes that run `cargo clippy` THEMSELVES.
///
/// THAW-10's requirement is that the pin check runs immediately before EVERY clippy
/// invocation, and a grep over `run:` lines is structurally unable to see one that lives
/// inside a script - which is how the earlier form of the ordering test below asserted
/// "every" while covering one of two (WR-02 of the phase-70 review).
///
/// # What this still does NOT cover, stated so it is not assumed
///
/// This is a hand-maintained list, and it is checked for non-vacuity (each entry really
/// does invoke clippy, asserted below off a compile-time embed) but NOT for completeness.
/// A NEW script that runs clippy and is invoked by this workflow would not be discovered
/// here. Completeness would need a filesystem walk of `scripts/` at run time, which this
/// file deliberately does not do - see the module docblock on why the workflow is a
/// compile-time embed. Adding a clippy call to a script means adding it here.
const SCRIPTS_THAT_RUN_CLIPPY: [&str; 1] = ["scripts/determinism-gate-negative-test.sh"];

/// `scripts/determinism-gate-negative-test.sh`, embedded so `SCRIPTS_THAT_RUN_CLIPPY`
/// cannot go vacuous: the list is only worth something if its entries really do take a
/// clippy verdict, and a rename or deletion of the script is a BUILD failure here rather
/// than a silently shorter list.
const DETERMINISM_NEGATIVE_TEST: &str =
    include_str!("../../../scripts/determinism-gate-negative-test.sh");

/// The direct clippy invocation, as it appears on a `run:` line.
const CLIPPY_INVOCATION: &str = "cargo clippy";

/// The pin check that must precede every clippy verdict.
const PIN_CHECK: &str = "scripts/check-toolchain-pin.sh";

/// Every `run:` line in the workflow, trimmed, in file order.
///
/// Order is load-bearing:
/// `the_toolchain_pin_check_runs_immediately_before_every_clippy_invocation` reads
/// positions out of this list, not just membership.
fn run_lines() -> Vec<&'static str> {
    CI_YML
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("run:"))
        .collect()
}

/// How many `run:` lines invoke `needle`.
fn count_invoking(needle: &str) -> usize {
    run_lines()
        .iter()
        .filter(|line| line.contains(needle))
        .count()
}

/// Every index at which a `run:` line invokes `needle`, in file order.
///
/// Deliberately a list rather than the single index this file used to take. THAW-10's
/// requirement is per-invocation, and both of the things it is read for below now occur
/// more than once: the pin check runs twice, and so does clippy.
fn indices_of_invocation(needle: &str) -> Vec<usize> {
    run_lines()
        .iter()
        .enumerate()
        .filter(|(_, line)| line.contains(needle))
        .map(|(index, _)| index)
        .collect()
}

/// One counting CHECK. Returns the failure message, or `None` when the count is right.
///
/// # Why this returns instead of asserting
///
/// Because `assert!` panics on the FIRST wrong fact, and the callers below check several.
/// A revert of a wiring change can make several wrong at once, and a run that named only
/// the first would send the reader to fix one line, re-run, find the next, and
/// repeat - while the report said a single thing was broken. Every gate script in
/// `scripts/` defers its exit for exactly this reason ("one run names everything that is
/// wrong rather than the first thing"), and a test asserting the wiring those gates are
/// wired by should not be the one place that does not.
///
/// It is also what makes this test's own redness legible: the plan that commissioned it
/// requires that reverting the workflow edit produce at least four DISTINCT named failing
/// assertions, and a first-panic test cannot show four of anything.
fn check_run_invocations(needle: &str, expected: usize, why: &str) -> Option<String> {
    let found = count_invoking(needle);
    if found == expected {
        return None;
    }
    Some(format!(
        ".github/workflows/ci.yml has {found} `run:` line(s) invoking `{needle}`, expected {expected}.\n\
         {why}"
    ))
}

/// CI runs the declared-moves gate against `public-base`, its non-vacuity prover, and the
/// provers that keep two more of its gates honest.
///
/// All the facts are checked in one test because they are one obligation - every covered
/// move is caught, and every gate that claims an absence is proved able to fail - and one
/// place to fix. Each has its own message so a run names the offender rather than
/// reporting that "the wiring" is wrong.
#[test]
fn ci_runs_the_declared_moves_gate_and_the_gate_provers() {
    let mut wrong: Vec<String> = Vec::new();

    wrong.extend(check_run_invocations(
        "scripts/check-core-declared.sh",
        1,
        "The declared-moves gate passes a DECLARED move of a covered path and fails an \
         undeclared one. Zero means CI has no assertion over the deterministic core at all. \
         More than one means a duplicate invocation, which makes this count red for a \
         reason unrelated to the wiring.",
    ));
    wrong.extend(check_run_invocations(
        "scripts/prove-declared-gate-non-vacuous.sh",
        1,
        "The gate above cannot see an edit to its own covered-path list, so a change that \
         deleted a crate from that list would go green and nothing would fire. This prover \
         is what says otherwise, and it has to run on every commit rather than once at \
         authoring time.",
    ));

    wrong.extend(check_run_invocations(
        "scripts/prove-toolchain-pin-bites.sh",
        1,
        "The toolchain pin check is a version COMPARISON, the easiest shape in this \
         repository to make vacuous without anyone noticing: two values nobody read compare \
         equal forever. This prover is what says the gate still bites, and until the \
         phase-70 review fix it was invoked by NOTHING - proved once by hand at authoring \
         time, which is the posture the `dev-pace-switch-absent` job rejects in its own \
         words. It runs on the determinism job's Linux leg.",
    ));
    wrong.extend(check_run_invocations(
        "scripts/prove-corpus-registration-bites.sh",
        1,
        "Same obligation, different gate: the corpus registration guard is an ABSENCE claim \
         (no golden fixture directory the registration table does not name), and an absence \
         claim is worth exactly the proof that it can still fail. This prover was also \
         invoked by nothing before the phase-70 review fix. It runs in the `golden-corpus` \
         job, which already has the cargo toolchain it needs.",
    ));
    let base_env_lines: Vec<&str> = CI_YML
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with(DECLARED_MOVES_BASE_KEY))
        .collect();
    if base_env_lines.len() != DECLARED_MOVES_BASE_SITES {
        wrong.push(format!(
            ".github/workflows/ci.yml has {} line(s) beginning `{DECLARED_MOVES_BASE_KEY}`, \
             expected {DECLARED_MOVES_BASE_SITES} - one per job that resolves the base \
             (`core-freeze` for the gate, `freeze-gate-bites` for its prover).\n\
             Fewer means a job now resolves the base by falling back to the gate's own \
             `DEFAULT_BASE`, or that the prover has no base and exits 2. More means a third \
             site this test does not know about; add it here in the same commit rather than \
             relaxing the count.",
            base_env_lines.len()
        ));
    }
    let not_the_tag: Vec<&str> = base_env_lines
        .iter()
        .copied()
        .filter(|line| !line.ends_with(DECLARED_MOVES_BASE_TAG))
        .collect();
    if !not_the_tag.is_empty() {
        wrong.push(format!(
            "{} `{DECLARED_MOVES_BASE_KEY}` line(s) in .github/workflows/ci.yml do not name \
             `{DECLARED_MOVES_BASE_TAG}`: {not_the_tag:?}\n\
             The declared-moves gate resolves every declared move against that annotated \
             tag. A line naming a different base silently re-points the whole core \
             assertion; moving the base is a reviewed change that moves the tag, this \
             constant, the gate's `DEFAULT_BASE` and both env lines in one commit.",
            not_the_tag.len()
        ));
    }

    assert!(
        wrong.is_empty(),
        "{} fact(s) about CI's gate wiring are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions are the only running evidence that these \
         steps exist, because the workflow itself has never executed.",
        wrong.len(),
        wrong
            .iter()
            .enumerate()
            .map(|(n, message)| format!("  {}. {message}", n + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    );
}

/// The toolchain pin check is the step IMMEDIATELY BEFORE EVERY clippy verdict this job
/// takes - including the one that is taken inside a script.
///
/// # Why this is not just `index_of("cargo clippy")`
///
/// Because that was wrong, and quietly. This job takes TWO clippy verdicts: the workflow's
/// own `cargo clippy` line, and the one `scripts/determinism-gate-negative-test.sh` runs
/// itself out of its `CLIPPY` array, minutes later, on a mutated tree. The earlier form of
/// this test took the single index of `cargo clippy` among `run:` lines - which SUCCEEDED,
/// because a grep over `run:` lines cannot see a clippy invocation that lives inside a
/// script - and its docblock claimed on that basis to cover "every clippy invocation".
/// WR-02 of the phase-70 review. The requirement is now met rather than restated: the
/// workflow carries a second pin-check step immediately before the negative test, and this
/// test asserts adjacency at BOTH sites.
///
/// # What is still not covered
///
/// Completeness of `SCRIPTS_THAT_RUN_CLIPPY` - see that constant. Every entry in it is
/// checked to really run clippy, so the list cannot go vacuous; nothing here discovers a
/// NEW script that starts running clippy.
#[test]
fn the_toolchain_pin_check_runs_immediately_before_every_clippy_invocation() {
    // NON-VACUITY OF THE LIST FIRST. An entry that no longer runs clippy would make the
    // corresponding adjacency assertion below pass while measuring nothing, and this test
    // would then claim coverage of a site that does not exist.
    for script in SCRIPTS_THAT_RUN_CLIPPY {
        let source = match script {
            "scripts/determinism-gate-negative-test.sh" => DETERMINISM_NEGATIVE_TEST,
            other => panic!(
                "`{other}` is listed in SCRIPTS_THAT_RUN_CLIPPY but this test embeds no \
                 source for it, so the claim that it runs clippy is unchecked. Add an \
                 `include_str!` for it in the same commit that adds it to the list."
            ),
        };
        assert!(
            source.contains(CLIPPY_INVOCATION),
            "`{script}` is listed in SCRIPTS_THAT_RUN_CLIPPY, but its source contains no \
             `{CLIPPY_INVOCATION}`.\n\
             \n\
             The list exists so the pin check can be asserted adjacent to clippy verdicts \
             that a grep over `run:` lines cannot see. An entry that has stopped taking one \
             makes that assertion pass over nothing. Either the script's clippy call moved \
             (fix the list) or this constant is stale (remove the entry)."
        );
    }

    let lines = run_lines();
    let pin_checks = indices_of_invocation(PIN_CHECK);

    // Every position in the job at which a clippy verdict is taken, with a description of
    // HOW, so a failure names the site rather than an index.
    let mut clippy_sites: Vec<(usize, String)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if line.contains(CLIPPY_INVOCATION) {
            clippy_sites.push((index, format!("a direct `{CLIPPY_INVOCATION}` run: line")));
        }
        for script in SCRIPTS_THAT_RUN_CLIPPY {
            if line.contains(script) {
                clippy_sites.push((index, format!("`{script}`, which runs clippy itself")));
            }
        }
    }
    clippy_sites.sort_by_key(|(index, _)| *index);

    assert!(
        !clippy_sites.is_empty(),
        ".github/workflows/ci.yml takes no clippy verdict at all - neither a direct \
         `{CLIPPY_INVOCATION}` run: line nor an invocation of {SCRIPTS_THAT_RUN_CLIPPY:?}.\n\
         \n\
         That is not a pass. This test would otherwise assert adjacency over an empty set \
         and report green, which is the vacuous shape every gate in `scripts/` refuses. The \
         determinism gate is the milestone's load-bearing assertion; if it really has been \
         removed, that is a decision to record deliberately, not one to discover from a \
         green test."
    );

    let mut wrong: Vec<String> = Vec::new();
    for (index, what) in &clippy_sites {
        let preceded = index
            .checked_sub(1)
            .is_some_and(|before| pin_checks.contains(&before));
        if !preceded {
            wrong.push(format!(
                "`run:` line index {index} is {what}, but index {} is not the pin check \
                 `{PIN_CHECK}` (pin checks are at {pin_checks:?}).",
                index.checked_sub(1).map_or_else(
                    || "(nothing - it is the first run: line)".to_string(),
                    |b| b.to_string()
                )
            ));
        }
    }
    if pin_checks.len() != clippy_sites.len() {
        wrong.push(format!(
            "there are {} pin-check `run:` line(s) for {} clippy verdict(s). One each, \
             immediately before: a spare pin check is a step whose position asserts nothing, \
             and the next reader has to work out which verdict it was meant to qualify.",
            pin_checks.len(),
            clippy_sites.len()
        ));
    }

    assert!(
        wrong.is_empty(),
        "the toolchain pin check does not immediately precede every clippy verdict:\n\n{}\n\n\
         THIS IS AN ORDERING ASSERTION ON PURPOSE. THAW-10 requires the pin check to run \
         immediately before EVERY clippy invocation, and a presence-only assertion would \
         pass with the pin step sitting at the bottom of the job, after the verdict it is \
         supposed to qualify had already been taken and reported. A clippy verdict from an \
         unpinned compiler is not the verdict the determinism gate claims: a different \
         release has a different lint set and a different idea of what `-D warnings` \
         denies.\n\
         \n\
         Move the STEP in the workflow. Do not re-point this test.",
        wrong
            .iter()
            .enumerate()
            .map(|(n, message)| format!("  {}. {message}", n + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    );
}

/// NON-VACUITY: the embed must be the real workflow, not an empty, moved or stub file.
///
/// Without this, a `ci.yml` that had been emptied would make every counting assertion
/// that expects ZERO pass vacuously, and "this step is no longer wired in" would then be
/// true of nothing at all.
///
/// The anchor is `name: determinism gate`, chosen because no wiring change these
/// assertions confirm edits it, so it does not move together with the thing it is meant
/// to survive.
#[test]
fn the_embedded_workflow_is_the_real_ci_file_and_not_an_empty_or_moved_one() {
    assert!(
        !CI_YML.is_empty(),
        "the embedded `.github/workflows/ci.yml` is empty - every assertion above would be \
         testing nothing, and any that expect a count of ZERO would pass vacuously."
    );
    assert!(
        CI_YML.contains("name: determinism gate"),
        ".github/workflows/ci.yml no longer contains `name: determinism gate`.\n\
         \n\
         That is this file's non-vacuity anchor: a string no wiring change touches, \
         so it stays true across exactly the change the assertions above confirm. If the \
         job was deliberately renamed, re-point this assertion in the SAME commit - never \
         delete it, and never replace it with a string one of those assertions also \
         edits."
    );
}

/// The workflow-level concurrency group. PR runs share `refs/pull/N/merge`; every other
/// run is alone in a group keyed on its own run id.
const CONCURRENCY_GROUP: &str = "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}";

/// Cancel only on pull_request.
const CANCEL_RULE: &str = "cancel-in-progress: ${{ github.event_name == 'pull_request' }}";

/// The fail-safe gate on every heavy job: skip only on the exact string `true`.
const HEAVY_GATE: &str = "if: ${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}";

/// The heavy jobs' dependency on the classifier.
const HEAVY_NEEDS: &str = "needs: changes";

/// The `embed` job's dependency: the classifier, and the job whose module it takes.
const EMBED_NEEDS: &str = "needs: [changes, wasm-player]";

/// The heavy jobs whose `needs:` line is not `HEAVY_NEEDS`, each with the one line it must carry.
/// Each of these jobs reads what an earlier job made, so it needs that job as well as the
/// classifier. Every other heavy job carries `HEAVY_NEEDS` and nothing else.
const JOB_NEEDS: [(&str, &str); 2] = [
    (EMBED_JOB, EMBED_NEEDS),
    (LIVE_VERDICT_JOB, LIVE_VERDICT_NEEDS),
];

/// The `needs:` line heavy job `id` must carry.
fn needs_of(id: &str) -> &'static str {
    JOB_NEEDS
        .iter()
        .find(|(job, _)| *job == id)
        .map_or(HEAVY_NEEDS, |(_, needs)| needs)
}

/// Linux only on pull_request, all three legs on every other event. The Linux leg is
/// pinned to `ubuntu-24.04` (2026-10-12, plan 84-01): `ubuntu-latest` moves to Ubuntu 26
/// from 2026-10-19 and the apt package names were checked for 24.04 only.
const DETERMINISM_MATRIX: &str = r#"os: ${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-24.04"]' || '["ubuntu-24.04","macos-latest","windows-latest"]') }}"#;

/// Jobs skipped on a docs-only change. None of them read a markdown file at the
/// repository root when measured on 2026-09-30. The `unit` job's
/// `frontend/src/gates/oneBoardAllFive.source.test.ts` reads a markdown fixture under
/// `frontend/`, which the classifier never counts as docs, so editing it runs the job.
const HEAVY_JOBS: [&str; 10] = [
    "determinism",
    "headless-build",
    "wasm-player",
    "embed",
    "golden-corpus",
    "e2e",
    "e2e-live",
    "e2e-live-verdict",
    "e2e-walk",
    "unit",
];

/// Jobs that run on every push: each reads files a docs-only change can edit, or costs
/// about a minute.
///
/// `prover-isolation` (plan 84-07, GATE-03) is in the second group: two bash scripts, no
/// toolchain, about a minute. A docs-only push cannot add a prover, so gating it would
/// save almost nothing and leave the rule unchecked on exactly the pushes nobody watches.
///
/// `core-freeze` and `freeze-gate-bites` are git-level checks of about a minute, and are
/// the only place a covered move is caught before merge. `private-residue` is in the first
/// group: a docs-only change edits a root markdown file, which is the likeliest place for
/// residue to come back.
const ALWAYS_ON_JOBS: [&str; 10] = [
    "changes",
    "core-freeze",
    "freeze-gate-bites",
    "wire-op-truth",
    "belt-end-resolver",
    "belt-ports-truth",
    "dev-pace-switch-absent",
    "prover-isolation",
    "private-residue",
    "neutrality",
];

const CLASSIFIER_PROVER: &str = "scripts/prove-ci-classify-change.sh";
const CLASSIFIER: &str = "scripts/ci-classify-change.sh";
const NEUTRALITY: &str = "scripts/check-neutrality.sh";
/// The lint that every prover in `scripts/` is isolated from the shared tree, and its proof.
const PROVER_ISOLATION_LINT: &str = "scripts/check-provers-isolated.sh";
const PROVER_ISOLATION_BITES: &str = "scripts/prove-provers-isolated-bites.sh";
/// The gate that no tracked file carries private residue, and its proof.
const PRIVATE_RESIDUE_GATE: &str = "scripts/check-no-private-residue.sh";
const PRIVATE_RESIDUE_BITES: &str = "scripts/prove-no-private-residue-bites.sh";

/// Trimmed, non-comment lines of the workflow, in file order.
fn code_lines() -> Vec<&'static str> {
    CI_YML
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect()
}

/// A job header under `jobs:`: exactly two spaces, an id of lowercase letters, digits and
/// hyphens, and a colon, nothing else.
fn job_id(raw_line: &str) -> Option<&str> {
    let rest = raw_line.strip_prefix("  ")?;
    let id = rest.strip_suffix(':')?;
    if !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        Some(id)
    } else {
        None
    }
}

/// Every job block after the top-level `jobs:` line, as (id, trimmed non-comment lines).
fn job_blocks() -> Vec<(&'static str, Vec<&'static str>)> {
    job_blocks_in(CI_YML)
}

/// `job_blocks` over any workflow text, so a test can read a copy with a break planted in it.
fn job_blocks_in(yml: &str) -> Vec<(&str, Vec<&str>)> {
    let mut blocks: Vec<(&str, Vec<&str>)> = Vec::new();
    let mut in_jobs = false;
    for raw in yml.lines() {
        if !in_jobs {
            if raw == "jobs:" {
                in_jobs = true;
            }
            continue;
        }
        if let Some(id) = job_id(raw) {
            blocks.push((id, Vec::new()));
            continue;
        }
        let trimmed = raw.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some((_, lines)) = blocks.last_mut() {
            lines.push(trimmed);
        }
    }
    blocks
}

/// Everything wrong with how `yml` classes its jobs: every job is heavy or always-on, each heavy
/// job carries its `needs:` line and the exact docs-only gate, and no always-on job carries either.
/// A heavy job's `needs:` line is the one `JOB_NEEDS` gives it, or `HEAVY_NEEDS`. Empty means right.
fn job_classes_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let mut found_ids: Vec<&str> = blocks.iter().map(|(id, _)| *id).collect();
    found_ids.sort_unstable();
    let mut expected_ids: Vec<&str> = HEAVY_JOBS
        .iter()
        .chain(ALWAYS_ON_JOBS.iter())
        .copied()
        .collect();
    expected_ids.sort_unstable();
    if found_ids != expected_ids {
        wrong.push(format!(
            "the job ids under `jobs:` are {found_ids:?}, expected exactly {expected_ids:?}.\n\
             Every job must be classified. A job that reads a markdown file at the \
             repository root is ALWAYS-ON (add it to ALWAYS_ON_JOBS, \
             no `needs: changes`, no gate). Otherwise it is HEAVY (add it to HEAVY_JOBS and \
             give it `{HEAVY_NEEDS}` and `{HEAVY_GATE}`)."
        ));
    }
    for (id, lines) in &blocks {
        let needs = needs_of(id);
        let has_needs = lines.contains(&needs);
        let has_gate = lines.contains(&HEAVY_GATE);
        if HEAVY_JOBS.contains(id) && !(has_needs && has_gate) {
            wrong.push(format!(
                "heavy job `{id}` is missing `{needs}` (present: {has_needs}) or the \
                 exact gate `{HEAVY_GATE}` (present: {has_gate}). Without both, it either \
                 never skips or skips on the wrong verdict."
            ));
        }
        let has_any_needs = lines.contains(&HEAVY_NEEDS)
            || JOB_NEEDS.iter().any(|(_, needs)| lines.contains(needs));
        if ALWAYS_ON_JOBS.contains(id) && (has_any_needs || has_gate) {
            wrong.push(format!(
                "always-on job `{id}` carries a `needs:` line on the classifier or the docs-only \
                 gate. It reads files a docs-only change can edit, so it must run on every push."
            ));
        }
    }
    wrong
}

/// The job that compiles the engine and the core with `redb` off, and the exact lines that do it.
const HEADLESS_JOB: &str = "headless-build";
const HEADLESS_RUN_LINES: [&str; 4] = [
    "run: cargo check -p fabrico-engine --locked",
    "run: cargo check -p fabrico-core --no-default-features --locked",
    "run: cargo clippy -p fabrico-engine --locked -- -D warnings",
    "run: cargo clippy -p fabrico-core --no-default-features --locked -- -D warnings",
];

/// Every other cargo line in the workflow turns `redb` on, so these four are the only ones that
/// can see the headless build break. The lines are matched whole because adding `--all-features`
/// or `--workspace` to one turns `redb` back on while the job stays green.
#[test]
fn the_headless_build_is_compiled_with_redb_off_in_its_own_job() {
    let blocks = job_blocks();
    let job = blocks
        .iter()
        .find(|(id, _)| *id == HEADLESS_JOB)
        .map(|(_, lines)| lines.as_slice())
        .unwrap_or_default();
    let mut wrong: Vec<String> = Vec::new();
    for line in HEADLESS_RUN_LINES {
        let in_job = job.iter().filter(|l| **l == line).count();
        let in_file = code_lines().iter().filter(|l| **l == line).count();
        if in_job != 1 || in_file != 1 {
            wrong.push(format!(
                "`{line}` appears {in_job} time(s) in job `{HEADLESS_JOB}` and {in_file} time(s) \
                 in the workflow, expected 1 and 1."
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "the headless build is not wired as review 93 WR-05 requires:\n{}\n\
         Without these lines `use fabrico_core::persist::RedbStore` in the engine, or a dropped \
         `#[cfg(feature = \"redb\")]` in persist.rs, leaves CI green with that build broken. \
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// The job that builds the WebAssembly player, and the exact lines that build and check it.
const WASM_JOB: &str = "wasm-player";
/// The clippy line is here as well as under the pin-check test. That test checks each clippy step
/// has a pin check directly before it, and it would stay green if both steps were deleted together.
const WASM_RUN_LINES: [&str; 10] = [
    "run: bash scripts/build-wasm.sh",
    "run: bash scripts/check-wasm-player.sh",
    "run: bash scripts/check-player-browser.sh",
    "run: bash scripts/check-player-size.sh",
    "run: bash scripts/prove-player-size-bites.sh",
    "run: bash scripts/check-wasm-corpus.sh",
    "run: bash scripts/prove-wasm-corpus-bites.sh",
    "run: bash scripts/check-fence-report.sh",
    "run: bash scripts/prove-fence-report-bites.sh",
    "run: cargo clippy -p fabrico-player -p fabrico-wasm-corpus --target wasm32-unknown-unknown \
     --locked -- -D warnings",
];

/// No other job compiles for wasm, so a step dropped from this one leaves CI green with that check
/// gone. The lines are matched whole, because a trailing `|| true` on one would keep the job green
/// whatever the check found.
#[test]
fn the_wasm_player_job_builds_and_checks_the_player() {
    let blocks = job_blocks();
    let job = blocks
        .iter()
        .find(|(id, _)| *id == WASM_JOB)
        .map(|(_, lines)| lines.as_slice())
        .unwrap_or_default();
    let mut wrong: Vec<String> = Vec::new();
    for line in WASM_RUN_LINES {
        let in_job = job.iter().filter(|l| **l == line).count();
        let in_file = code_lines().iter().filter(|l| **l == line).count();
        if in_job != 1 || in_file != 1 {
            wrong.push(format!(
                "`{line}` appears {in_job} time(s) in job `{WASM_JOB}` and {in_file} time(s) in \
                 the workflow, expected 1 and 1."
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "the wasm player job isn't wired as it has to be:\n{}\n\
         Each of these lines is the only place CI runs that check. Update the WORKFLOW to match \
         this test.",
        wrong.join("\n")
    );
}

/// The job that runs the read-only board embed from disk, on the module `wasm-player` built.
const EMBED_JOB: &str = "embed";
/// The exact lines that build the embed's pages and the offline file, check the pages, and open
/// the offline file in three browsers. No other job runs any of these scripts.
const EMBED_RUN_LINES: [&str; 3] = [
    "run: bash scripts/build-embed.sh",
    "run: bash scripts/check-embed.sh",
    "run: bash scripts/check-offline-browsers.sh",
];
/// The artifact that carries the module from `wasm-player` to `EMBED_JOB`, as its `name:` line.
const PLAYER_ARTIFACT: &str = "name: fabrico-player-wasm";
/// Where the artifact is taken from and put back, as the step's `path:` line.
const PLAYER_ARTIFACT_PATH: &str = "path: target/wasm-out";

/// Everything wrong with how `yml` wires the embed job and the module it takes. Empty means right.
fn embed_job_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let code: Vec<&str> = yml
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect();
    let job_lines = |job: &str| -> Vec<&str> {
        blocks
            .iter()
            .find(|(id, _)| *id == job)
            .map(|(_, lines)| lines.clone())
            .unwrap_or_default()
    };
    let wasm = job_lines(WASM_JOB);
    let embed = job_lines(EMBED_JOB);

    for line in EMBED_RUN_LINES {
        let in_job = embed.iter().filter(|l| **l == line).count();
        let in_file = code.iter().filter(|l| **l == line).count();
        if in_job != 1 || in_file != 1 {
            wrong.push(format!(
                "`{line}` appears {in_job} time(s) in job `{EMBED_JOB}` and {in_file} time(s) in \
                 the workflow, expected 1 and 1."
            ));
        }
    }

    // The artifact: uploaded once by wasm-player after the build, taken once by embed before the
    // build, from and to the same folder.
    for (job, lines, uses, before, after) in [
        (
            WASM_JOB,
            &wasm,
            "uses: actions/upload-artifact@v4",
            Some(WASM_RUN_LINES[0]),
            None,
        ),
        (
            EMBED_JOB,
            &embed,
            "uses: actions/download-artifact@v4",
            None,
            Some(EMBED_RUN_LINES[0]),
        ),
    ] {
        let at: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter(|(_, l)| **l == PLAYER_ARTIFACT)
            .map(|(i, _)| i)
            .collect();
        let [at] = at.as_slice() else {
            wrong.push(format!(
                "`{PLAYER_ARTIFACT}` appears {} time(s) in job `{job}`, expected 1. Without it \
                 the embed job has no module, or not the one CI built.",
                at.len()
            ));
            continue;
        };
        let step = step_around(lines, *at);
        let mut expected = vec![uses, PLAYER_ARTIFACT_PATH];
        if job == WASM_JOB {
            expected.extend(["retention-days: 1", "if-no-files-found: error"]);
        }
        for key in expected {
            if !step.contains(&key) {
                wrong.push(format!(
                    "the step carrying `{PLAYER_ARTIFACT}` in job `{job}` has no `{key}` line."
                ));
            }
        }
        let position = |needle: &str| lines.iter().position(|l| *l == needle);
        if let Some(build) = before.and_then(position)
            && build > *at
        {
            wrong.push(format!(
                "job `{job}` uploads the artifact before `{}` builds the module.",
                WASM_RUN_LINES[0]
            ));
        }
        if let Some(build) = after.and_then(position)
            && build < *at
        {
            wrong.push(format!(
                "job `{job}` runs `{}` before it takes the artifact.",
                EMBED_RUN_LINES[0]
            ));
        }
    }
    let in_file = code.iter().filter(|l| **l == PLAYER_ARTIFACT).count();
    if in_file != 2 {
        wrong.push(format!(
            "`{PLAYER_ARTIFACT}` appears {in_file} time(s) in the workflow, expected 2: the upload \
             in `{WASM_JOB}` and the download in `{EMBED_JOB}`."
        ));
    }

    // The pages and the offline file are checked after they are built.
    let build = embed.iter().position(|l| *l == EMBED_RUN_LINES[0]);
    for check_line in &EMBED_RUN_LINES[1..] {
        let check = embed.iter().position(|l| l == check_line);
        if let (Some(b), Some(c)) = (build, check)
            && b > c
        {
            wrong.push(format!(
                "job `{EMBED_JOB}` runs `{check_line}` before it builds what that checks."
            ));
        }
    }
    wrong
}

/// The embed job builds its pages from the module CI built in `wasm-player`, and checks them.
///
/// The embed ships the CI-built module, so the module has to arrive from the job that built and
/// checked it, and the two run lines are matched whole, because a trailing `|| true` on either would
/// keep the job green whatever the pages did.
#[test]
fn the_embed_job_builds_and_checks_the_embed() {
    let wrong = embed_job_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "the embed job isn't wired as it has to be:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// Every `continue-on-error` line in `job`, and every `if:` line inside a step of `job` that runs
/// one of `needles`, each named. Either one can leave the job green with that check switched off:
/// a condition skips the step, and `continue-on-error` swallows its failure. Empty means right.
fn step_guards_wrong(yml: &str, job: &str, needles: &[&str]) -> Vec<String> {
    let blocks = job_blocks_in(yml);
    let Some((_, lines)) = blocks.iter().find(|(id, _)| *id == job) else {
        return vec![format!("there is no job `{job}` under `jobs:`.")];
    };
    let mut wrong: Vec<String> = Vec::new();
    for line in lines
        .iter()
        .filter(|line| step_key(line).starts_with("continue-on-error"))
    {
        wrong.push(format!(
            "job `{job}` carries `{}`, so a failed check there would leave the job green.",
            step_key(line)
        ));
    }
    for needle in needles {
        for line in step_of(lines, needle)
            .iter()
            .filter(|line| step_key(line).starts_with("if:"))
        {
            wrong.push(format!(
                "the step that runs `{needle}` in job `{job}` carries `{}`. A condition can skip \
                 it while the job stays green.",
                step_key(line)
            ));
        }
    }
    wrong
}

/// Neither wasm job can be switched off one step at a time. The run-line pins above match each
/// line whole, and an `if: false` on the step, or `continue-on-error` on the job or the step, would
/// pass them while the check never ran or never counted.
#[test]
fn the_wasm_jobs_cannot_be_switched_off_a_step_at_a_time() {
    let mut wrong = step_guards_wrong(CI_YML, WASM_JOB, &WASM_RUN_LINES);
    wrong.extend(step_guards_wrong(CI_YML, EMBED_JOB, &EMBED_RUN_LINES));
    assert!(
        wrong.is_empty(),
        "a wasm job carries a step condition or continue-on-error:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// A copy of `yml` with the step whose first line is `header` taken out, up to the next step, the
/// next blank line or the end of the job.
fn without_step(yml: &str, header: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in yml.split_inclusive('\n') {
        if line == header {
            skipping = true;
            continue;
        }
        if skipping {
            let indent = line.len() - line.trim_start().len();
            if line.trim().is_empty() || line.starts_with("      - ") || indent < 8 {
                skipping = false;
            } else {
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

/// `step_guards_wrong`, `embed_job_wrong` and `job_classes_wrong` can fail: each break below is
/// planted in a copy of the real workflow, and the check has to name it.
#[test]
fn the_wasm_job_checks_name_each_way_of_switching_them_off() {
    const WASM_HEADER: &str =
        "    name: the wasm player builds on the pinned compiler and passes its checks\n";
    const EMBED_HEADER: &str = "    name: the read-only board embed runs from disk in a browser\n";
    const WASM_BUILD_STEP: &str = "      - name: Build the player\n";
    const EMBED_BUILD_STEP: &str = "      - name: Build the embed bundle and its test pages\n";
    const UPLOAD_STEP: &str = "      - name: Keep the player module for the embed job\n";
    const DOWNLOAD_STEP: &str = "      - name: Take the player module wasm-player built\n";

    let guards = |yml: &str| {
        let mut wrong = step_guards_wrong(yml, WASM_JOB, &WASM_RUN_LINES);
        wrong.extend(step_guards_wrong(yml, EMBED_JOB, &EMBED_RUN_LINES));
        wrong.join("\n")
    };
    let mut missed: Vec<String> = Vec::new();
    let mut check = |what: String, yml: String, named: String, must_name: &str| {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        if !named.contains(must_name) {
            missed.push(format!(
                "{what}: expected `{must_name}` named, got: {named:?}"
            ));
        }
    };

    // A condition on the step that runs each pinned line, in both jobs.
    for (job, lines) in [
        (WASM_JOB, WASM_RUN_LINES.as_slice()),
        (EMBED_JOB, EMBED_RUN_LINES.as_slice()),
    ] {
        for line in lines {
            let yml = CI_YML.replace(
                &format!("        {line}\n"),
                &format!("        if: false\n        {line}\n"),
            );
            let named = guards(&yml);
            check(
                format!("`if: false` on the step running `{line}` in `{job}`"),
                yml,
                named,
                &format!("the step that runs `{line}` in job `{job}` carries `if: false`"),
            );
        }
    }

    // continue-on-error on either job, and as a step's first key in either job.
    for (job, from, to) in [
        (
            WASM_JOB,
            WASM_HEADER.to_string(),
            format!("{WASM_HEADER}    continue-on-error: true\n"),
        ),
        (
            EMBED_JOB,
            EMBED_HEADER.to_string(),
            format!("{EMBED_HEADER}    continue-on-error: true\n"),
        ),
        (
            WASM_JOB,
            WASM_BUILD_STEP.to_string(),
            "      - continue-on-error: true\n        name: Build the player\n".to_string(),
        ),
        (
            EMBED_JOB,
            EMBED_BUILD_STEP.to_string(),
            "      - continue-on-error: true\n        name: Build the embed bundle and its test pages\n"
                .to_string(),
        ),
    ] {
        let yml = CI_YML.replace(&from, &to);
        let named = guards(&yml);
        check(
            format!("continue-on-error planted at `{}` in `{job}`", from.trim()),
            yml,
            named,
            &format!("job `{job}` carries `continue-on-error: true`"),
        );
    }

    // The embed job's needs line changed either way.
    for to in [
        "    needs: changes\n",
        "    needs: [changes, wasm-player, e2e]\n",
    ] {
        let yml = CI_YML.replace(&format!("    {EMBED_NEEDS}\n"), to);
        let named = job_classes_wrong(&yml).join("\n");
        check(
            format!("the embed job's needs line set to `{}`", to.trim()),
            yml,
            named,
            &format!("heavy job `{EMBED_JOB}` is missing `{EMBED_NEEDS}`"),
        );
    }

    // The upload step taken out of wasm-player, and the download step taken out of embed.
    for (what, header, job) in [
        ("the upload step deleted", UPLOAD_STEP, WASM_JOB),
        ("the download step deleted", DOWNLOAD_STEP, EMBED_JOB),
    ] {
        let yml = without_step(CI_YML, header);
        let named = embed_job_wrong(&yml).join("\n");
        check(
            what.to_string(),
            yml,
            named,
            &format!("`{PLAYER_ARTIFACT}` appears 0 time(s) in job `{job}`"),
        );
    }

    // An embed run line swallowed.
    for line in EMBED_RUN_LINES {
        let yml = CI_YML.replace(
            &format!("        {line}\n"),
            &format!("        {line} || true\n"),
        );
        let named = embed_job_wrong(&yml).join("\n");
        check(
            format!("`{line}` with `|| true`"),
            yml,
            named,
            &format!("`{line}` appears 0 time(s) in job `{EMBED_JOB}`"),
        );
    }

    assert!(
        missed.is_empty(),
        "{} planted break(s) went unnamed:\n{}",
        missed.len(),
        missed.join("\n")
    );
}

/// The CI spend controls are wired, and wired in the fail-safe direction.
///
/// Every fact is collected before the single assert, so one run names everything wrong.
#[test]
fn ci_spend_controls_are_wired_fail_safe() {
    let mut wrong: Vec<String> = Vec::new();
    let code = code_lines();
    let count_eq = |needle: &str| code.iter().filter(|line| **line == needle).count();

    // (a) - (d): exact whole-line controls, each exactly once.
    for (needle, why) in [
        (
            CONCURRENCY_GROUP,
            "the concurrency group. Without the run_id fallback, non-PR runs share a group \
             and GitHub replaces a PENDING master run with a newer one, dropping that \
             commit's verdict.",
        ),
        (
            CANCEL_RULE,
            "the cancel rule. It must cancel only pull_request runs; `true` or an ungated \
             form could cancel a master run.",
        ),
        (
            DETERMINISM_MATRIX,
            "the determinism matrix. Pull requests run ubuntu only; every other event must \
             still run ubuntu, macOS and Windows, or a platform-only break is never found.",
        ),
        (
            "workflow_dispatch:",
            "the manual trigger, the only way to force a full run on demand.",
        ),
    ] {
        let found = count_eq(needle);
        if found != 1 {
            wrong.push(format!(
                ".github/workflows/ci.yml has {found} non-comment line(s) equal to `{needle}`, \
                 expected exactly 1. This is {why}"
            ));
        }
    }

    // (e): every job classified; heavy jobs gated, always-on jobs not.
    let blocks = job_blocks();
    wrong.extend(job_classes_wrong(CI_YML));

    // (f): no other polarity of the gate anywhere.
    for line in code
        .iter()
        .filter(|line| line.contains("needs.changes.outputs"))
    {
        if *line != HEAVY_GATE {
            wrong.push(format!(
                "non-comment line `{line}` reads the classifier's output but is not the exact \
                 gate `{HEAVY_GATE}`. Only skip-on-exactly-true under `!cancelled()` is fail-safe: \
                 a failed classifier leaves the output empty, and that must run everything."
            ));
        }
    }

    // (g): each script invoked exactly once.
    wrong.extend(check_run_invocations(
        CLASSIFIER_PROVER,
        1,
        "The classifier's prover must run on every push, in the `changes` job, so a \
         classifier whose proof is broken never gets to skip anything.",
    ));
    wrong.extend(check_run_invocations(
        CLASSIFIER,
        1,
        "The classifier decides whether the heavy jobs run; it must run exactly once.",
    ));
    wrong.extend(check_run_invocations(
        NEUTRALITY,
        1,
        "The neutrality gate is a markdown scan; it must run exactly once, in the \
         always-on `neutrality` job.",
    ));
    wrong.extend(check_run_invocations(
        PROVER_ISOLATION_LINT,
        1,
        "The prover-isolation lint is what stops a new or edited prover from restoring a \
         tracked file in the shared tree, or replacing the helper's exit check (GATE-03). It \
         must run exactly once, in the always-on `prover-isolation` job.",
    ));
    wrong.extend(check_run_invocations(
        PROVER_ISOLATION_BITES,
        1,
        "The lint is a text scan, and a scan whose patterns have drifted prints the same \
         green as one that found nothing. Its bite proof must run exactly once, beside it.",
    ));
    wrong.extend(check_run_invocations(
        PRIVATE_RESIDUE_GATE,
        1,
        "The private-residue gate keeps the maintainer's personal details and pointers into \
         the private planning checkout out of every tracked file. It must run exactly once, \
         in the always-on `private-residue` job.",
    ));
    wrong.extend(check_run_invocations(
        PRIVATE_RESIDUE_BITES,
        1,
        "The private-residue gate asserts an absence, and a pattern that has rotted prints \
         the same green as a clean tree. Its bite proof must run exactly once, beside it.",
    ));

    // (h): prover immediately before the classifier.
    let runs = run_lines();
    let prover_at = indices_of_invocation(CLASSIFIER_PROVER);
    let classifier_at = indices_of_invocation(CLASSIFIER);
    if let ([p], [c]) = (prover_at.as_slice(), classifier_at.as_slice())
        && p + 1 != *c
    {
        wrong.push(format!(
            "the classifier's prover is `run:` line {p} and the classifier is {c} (of {}); \
             the prover must be the run: line IMMEDIATELY before the classifier, so a \
             failed proof stops the job before any verdict is written.",
            runs.len()
        ));
    }

    // (i): the neutrality invocation sits inside the `neutrality` job.
    let neutrality_home: Vec<&str> = blocks
        .iter()
        .filter(|(_, lines)| {
            lines
                .iter()
                .any(|line| line.starts_with("run:") && line.contains(NEUTRALITY))
        })
        .map(|(id, _)| *id)
        .collect();
    if neutrality_home != ["neutrality"] {
        wrong.push(format!(
            "`{NEUTRALITY}` is invoked from job(s) {neutrality_home:?}, expected only \
             [\"neutrality\"]. It is a cheap markdown scan kept in its own always-on job; \
             `unit` is skipped on docs-only changes."
        ));
    }

    // (j): the private-residue gate and its prover sit inside the `private-residue` job.
    for script in [PRIVATE_RESIDUE_GATE, PRIVATE_RESIDUE_BITES] {
        let home: Vec<&str> = blocks
            .iter()
            .filter(|(_, lines)| {
                lines
                    .iter()
                    .any(|line| line.starts_with("run:") && line.contains(script))
            })
            .map(|(id, _)| *id)
            .collect();
        if home != ["private-residue"] {
            wrong.push(format!(
                "`{script}` is invoked from job(s) {home:?}, expected only \
                 [\"private-residue\"]. A docs-only change edits a root markdown file, the \
                 likeliest place for residue to come back, and `unit` is skipped on exactly \
                 those changes."
            ));
        }
    }

    assert!(
        wrong.is_empty(),
        "{} fact(s) about CI's spend controls are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions keep the spend controls fail-safe.",
        wrong.len(),
        wrong
            .iter()
            .enumerate()
            .map(|(n, message)| format!("  {}. {message}", n + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    );
}

/// The developer's live command. Each leg of the live job runs it with its own `--shard`.
const LIVE_SUITE: &str = "npm run e2e:live";
/// The live suite's verdict: its failed set is exactly the declared CUTs.
const LIVE_RED_SET_CHECKER: &str = "scripts/check-live-red-set.sh";
/// The checker's bite proof over hand-made reports.
const LIVE_RED_SET_BITES: &str = "scripts/prove-live-red-set-bites.sh";
/// The job that runs the live suite, one leg per shard.
const LIVE_JOB: &str = "e2e-live";
/// The job that grades every shard's report together.
const LIVE_VERDICT_JOB: &str = "e2e-live-verdict";
/// The verdict job's dependency: the classifier, and every leg of the live job.
const LIVE_VERDICT_NEEDS: &str = "needs: [changes, e2e-live]";
/// How many shards the live suite runs as. The matrix and every pinned run line are built from it.
const LIVE_SHARDS: usize = 4;
/// The artifact each leg uploads its raw report as, by its `name:` line.
const LIVE_REPORT_ARTIFACT: &str = "name: live-report-${{ matrix.shard }}";
/// Where the leg's report is, by the upload step's `path:` line.
const LIVE_REPORT_PATH: &str = "path: frontend/test-results/live-report.json";
/// The verdict job takes every leg's artifact by this pattern, into this folder.
const LIVE_REPORT_PATTERN: &str = "pattern: live-report-*";
const LIVE_REPORTS_DIR: &str = "path: live-reports";

/// The four pinned run lines of the live gate, whole, built from `LIVE_SHARDS`.
struct LiveRunLines {
    /// The bite proof, in `LIVE_JOB`, before the suite.
    bites: String,
    /// This leg's shard of the suite, its exit code swallowed because the CUT makes it 1.
    suite: String,
    /// This leg's verdict, the run line straight after the suite.
    checker: String,
    /// The merged verdict in `LIVE_VERDICT_JOB`, over every shard's report in shard order.
    merge: String,
}

fn live_run_lines() -> LiveRunLines {
    let n = LIVE_SHARDS;
    let shard = "${{ matrix.shard }}";
    let reports = (1..=n)
        .map(|i| format!("live-reports/live-report-{i}/live-report.json"))
        .collect::<Vec<_>>()
        .join(" ");
    LiveRunLines {
        bites: format!("run: bash {LIVE_RED_SET_BITES}"),
        suite: format!(
            "run: {LIVE_SUITE} -- --shard={shard}/{n} || echo \"live shard exited $?; the red-set \
             check below decides\""
        ),
        checker: format!(
            "run: bash ../{LIVE_RED_SET_CHECKER} --shard {shard}/{n} test-results/live-report.json"
        ),
        merge: format!("run: bash {LIVE_RED_SET_CHECKER} --merge {n} {reports}"),
    }
}

/// Everything wrong with how `yml` wires the live gate's verdict. Empty means right.
fn live_gate_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let lines = live_run_lines();
    let job_lines = |job: &str| -> Option<Vec<&str>> {
        blocks
            .iter()
            .find(|(id, _)| *id == job)
            .map(|(_, lines)| lines.clone())
    };
    let pinned: [(&str, &str, &str); 4] = [
        ("the bite proof", &lines.bites, LIVE_JOB),
        ("the suite", &lines.suite, LIVE_JOB),
        ("the shard checker", &lines.checker, LIVE_JOB),
        ("the merge", &lines.merge, LIVE_VERDICT_JOB),
    ];

    // Each pinned line once in the workflow, in its own job, as the whole of its line. A whole-line
    // match is what refuses `|| true`, a dropped report path or a lowered floor.
    for (what, line, job) in pinned {
        let homes: Vec<&str> = blocks
            .iter()
            .flat_map(|(id, lines)| {
                lines
                    .iter()
                    .filter(move |l| step_key(l) == line)
                    .map(move |_| *id)
            })
            .collect();
        if homes != [job] {
            wrong.push(format!(
                "{what}'s run line `{line}` is in job(s) {homes:?}, expected exactly once, in \
                 [\"{job}\"]. Without it, or with it anywhere else, the live gate can go green \
                 without its verdict."
            ));
        }
    }

    // Every run line that names the suite, the checker or its proof is one of the four.
    for (id, job) in &blocks {
        for line in job
            .iter()
            .map(|l| step_key(l))
            .filter(|l| l.starts_with("run:"))
        {
            let names_live = [LIVE_SUITE, LIVE_RED_SET_CHECKER, LIVE_RED_SET_BITES]
                .iter()
                .any(|needle| line.contains(needle));
            if names_live && !pinned.iter().any(|(_, p, _)| *p == line) {
                wrong.push(format!(
                    "job `{id}` runs `{line}`, which is none of the four pinned live run lines. A \
                     second suite run, a checker with another argument or a swallowed exit code \
                     would let a red shard pass."
                ));
            }
        }
    }

    // No checker line lowers the floor. --min-tests also switches off the terminal checks.
    for (id, job) in &blocks {
        for line in job.iter().map(|l| step_key(l)).filter(|l| {
            l.starts_with("run:") && l.contains(LIVE_RED_SET_CHECKER) && l.contains("--min-tests")
        }) {
            wrong.push(format!(
                "job `{id}` runs the checker as `{line}`. `--min-tests` lowers the 290-test floor \
                 and switches off the terminal checks, so a filtered or partial run could pass as \
                 the gate."
            ));
        }
    }

    match job_lines(LIVE_JOB) {
        None => wrong.push(format!("there is no job `{LIVE_JOB}` under `jobs:`.")),
        Some(job) => {
            // The proof before the suite, and the shard checker the run line straight after it.
            let runs: Vec<&str> = job
                .iter()
                .map(|l| step_key(l))
                .filter(|l| l.starts_with("run:"))
                .collect();
            let at = |expected: &str| runs.iter().position(|l| *l == expected);
            if let (Some(b), Some(s), Some(c)) =
                (at(&lines.bites), at(&lines.suite), at(&lines.checker))
                && !(b < s && s + 1 == c)
            {
                wrong.push(format!(
                    "the bite proof, the suite and the shard checker are `run:` lines {b}, {s} and \
                     {c} of job `{LIVE_JOB}`. The proof must come before the suite, and the \
                     checker must be the run: line straight after it, because the suite's exit \
                     code is swallowed and nothing else decides the leg."
                ));
            }

            // One leg per shard, and a red leg cancels none of the others.
            let shard_list = format!(
                "shard: [{}]",
                (1..=LIVE_SHARDS)
                    .map(|i| i.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            for key in ["fail-fast: false", shard_list.as_str()] {
                let found = job.iter().filter(|l| **l == key).count();
                if found != 1 {
                    wrong.push(format!(
                        "job `{LIVE_JOB}` carries `{key}` {found} time(s), expected 1. The suite \
                         is split into {LIVE_SHARDS} shards, every pinned run line names that \
                         count, and a leg cancelled by another's failure leaves no report."
                    ));
                }
            }

            // Each leg uploads its raw report, red or not, and fails when there is none.
            let uploads: Vec<usize> = job
                .iter()
                .enumerate()
                .filter(|(_, l)| step_key(l) == LIVE_REPORT_ARTIFACT)
                .map(|(i, _)| i)
                .collect();
            match uploads.as_slice() {
                [at] => {
                    let step = step_around(&job, *at);
                    for key in [
                        "uses: actions/upload-artifact@v4",
                        "if: ${{ !cancelled() }}",
                        LIVE_REPORT_PATH,
                        "if-no-files-found: error",
                    ] {
                        if !step.iter().any(|l| step_key(l) == key) {
                            wrong.push(format!(
                                "the step carrying `{LIVE_REPORT_ARTIFACT}` in job `{LIVE_JOB}` \
                                 has no `{key}` line. Without it a red shard's report never \
                                 reaches the verdict job, or a missing report goes unnoticed."
                            ));
                        }
                    }
                    let suite = job.iter().position(|l| step_key(l) == lines.suite);
                    if let Some(s) = suite
                        && s > *at
                    {
                        wrong.push(format!(
                            "job `{LIVE_JOB}` uploads `{LIVE_REPORT_ARTIFACT}` before the suite \
                             writes the report."
                        ));
                    }
                }
                found => wrong.push(format!(
                    "`{LIVE_REPORT_ARTIFACT}` appears {} time(s) in job `{LIVE_JOB}`, expected 1.",
                    found.len()
                )),
            }
        }
    }

    match job_lines(LIVE_VERDICT_JOB) {
        None => wrong.push(format!("there is no job `{LIVE_VERDICT_JOB}` under `jobs:`.")),
        Some(job) => {
            // The reports are downloaded, into the folder the merge reads, before the merge.
            let downloads: Vec<usize> = job
                .iter()
                .enumerate()
                .filter(|(_, l)| step_key(l) == LIVE_REPORT_PATTERN)
                .map(|(i, _)| i)
                .collect();
            match downloads.as_slice() {
                [at] => {
                    let step = step_around(&job, *at);
                    for key in ["uses: actions/download-artifact@v4", LIVE_REPORTS_DIR] {
                        if !step.iter().any(|l| step_key(l) == key) {
                            wrong.push(format!(
                                "the step carrying `{LIVE_REPORT_PATTERN}` in job \
                                 `{LIVE_VERDICT_JOB}` has no `{key}` line, so the merge would \
                                 read no report."
                            ));
                        }
                    }
                    let merge = job.iter().position(|l| step_key(l) == lines.merge);
                    if let Some(m) = merge
                        && m < *at
                    {
                        wrong.push(format!(
                            "job `{LIVE_VERDICT_JOB}` runs the merge before it takes the reports."
                        ));
                    }
                }
                found => wrong.push(format!(
                    "`{LIVE_REPORT_PATTERN}` appears {} time(s) in job `{LIVE_VERDICT_JOB}`, \
                     expected 1.",
                    found.len()
                )),
            }
        }
    }

    // Neither job swallows a failure, and no verdict step or proof can be skipped.
    wrong.extend(step_guards_wrong(
        yml,
        LIVE_JOB,
        &[lines.bites.as_str(), lines.checker.as_str()],
    ));
    wrong.extend(step_guards_wrong(
        yml,
        LIVE_VERDICT_JOB,
        &[lines.merge.as_str()],
    ));
    wrong
}

/// The live suite's verdict is the red-set check, not the suite's exit code, and nothing can switch
/// it off.
///
/// # Why
///
/// The live suite carries a CUT that throws on every run, so `npm run e2e:live` exits 1 and the job
/// swallows that exit code. Once it is swallowed, the ONLY thing between a broken live suite and a
/// green run is the checker. Dropping it, moving it, putting a step between the suite and it, or
/// marking a job `continue-on-error` would each turn the live gate off without a red line anywhere,
/// so the wiring is pinned here, where `cargo test` runs it.
///
/// # Why the rule pins two jobs
///
/// The suite runs as `LIVE_SHARDS` shards on separate runners, one leg of `LIVE_JOB` each, because
/// one worker against one host made it the slowest job in the workflow. So its verdict has two
/// halves. Each leg grades its own shard with `--shard i/n` on the run line straight after the
/// suite, and uploads its raw report. `LIVE_VERDICT_JOB` needs every leg, takes the reports and
/// grades them together with `--merge n`. This rule used to allow exactly one checker line, in one
/// job; it now pins all four run lines whole, the order inside the leg, the matrix, the upload and
/// download between the two jobs, and the guards on both. The verdict job's `needs:` line and its
/// docs-only gate are pinned by `job_classes_wrong`.
///
/// Every wrong fact is collected before the single assert, so one run names them all.
#[test]
fn the_live_gate_verdict_is_the_red_set_check() {
    let wrong = live_gate_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the live gate's verdict are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions are what keep the live gate on.",
        wrong.len(),
        wrong
            .iter()
            .enumerate()
            .map(|(n, message)| format!("  {}. {message}", n + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    );
}

/// `live_gate_wrong` and `job_classes_wrong` can fail: each break below is planted in a copy of the
/// real workflow, and the check has to name it.
#[test]
fn the_live_gate_check_names_each_way_of_switching_it_off() {
    const CHECKER_STEP: &str = "      - name: This shard's red set is exactly its declared CUTs\n";
    const MERGE_STEP: &str =
        "      - name: The live red set over all shards is exactly the declared CUTs\n";
    const UPLOAD_STEP: &str = "      - name: Keep this shard's report for the verdict job\n";
    const VERDICT_HEADER: &str = "    name: live e2e verdict (all shards)\n";
    const MATRIX: &str = "      fail-fast: false\n      matrix:\n        shard: [1, 2, 3, 4]\n";
    let lines = live_run_lines();
    let checker_line = format!("        {}\n", lines.checker);
    let merge_line = format!("        {}\n", lines.merge);
    let last_report = format!(" live-reports/live-report-{LIVE_SHARDS}/live-report.json");

    // (what, the planted copy, which check reads it, what it must name)
    type WorkflowCheck = fn(&str) -> Vec<String>;
    let plants: Vec<(&str, String, WorkflowCheck, String)> = vec![
        (
            "the shard-checker step deleted",
            without_step(CI_YML, CHECKER_STEP),
            live_gate_wrong,
            format!("the shard checker's run line `{}` is in job(s) []", lines.checker),
        ),
        (
            "the shard checker given `|| true`",
            CI_YML.replace(&checker_line, &checker_line.replace(".json\n", ".json || true\n")),
            live_gate_wrong,
            "is none of the four pinned live run lines".to_string(),
        ),
        (
            "a step between the suite and the shard checker",
            CI_YML.replace(CHECKER_STEP, &format!("      - run: echo between\n{CHECKER_STEP}")),
            live_gate_wrong,
            "must be the run: line straight after it".to_string(),
        ),
        (
            "`--min-tests 1` on the shard checker",
            CI_YML.replace(&checker_line, &checker_line.replace("--shard", "--min-tests 1 --shard")),
            live_gate_wrong,
            "`--min-tests` lowers the 290-test floor".to_string(),
        ),
        (
            "the merge step deleted",
            without_step(CI_YML, MERGE_STEP),
            live_gate_wrong,
            format!("the merge's run line `{}` is in job(s) []", lines.merge),
        ),
        (
            "the merge given three paths",
            CI_YML.replace(&merge_line, &merge_line.replace(&last_report, "")),
            live_gate_wrong,
            "is none of the four pinned live run lines".to_string(),
        ),
        (
            "continue-on-error on the verdict job",
            CI_YML.replace(
                VERDICT_HEADER,
                &format!("{VERDICT_HEADER}    continue-on-error: true\n"),
            ),
            live_gate_wrong,
            format!("job `{LIVE_VERDICT_JOB}` carries `continue-on-error: true`"),
        ),
        (
            "`if: false` on the merge step",
            CI_YML.replace(MERGE_STEP, &format!("{MERGE_STEP}        if: false\n")),
            live_gate_wrong,
            format!("in job `{LIVE_VERDICT_JOB}` carries `if: false`"),
        ),
        (
            "the matrix grown to five shards",
            CI_YML.replace(MATRIX, &MATRIX.replace("[1, 2, 3, 4]", "[1, 2, 3, 4, 5]")),
            live_gate_wrong,
            format!("job `{LIVE_JOB}` carries `shard: [1, 2, 3, 4]` 0 time(s)"),
        ),
        (
            "`fail-fast: true` on the live matrix",
            CI_YML.replace(MATRIX, &MATRIX.replace("fail-fast: false", "fail-fast: true")),
            live_gate_wrong,
            format!("job `{LIVE_JOB}` carries `fail-fast: false` 0 time(s)"),
        ),
        (
            "the report upload's `if: ${{ !cancelled() }}` removed",
            CI_YML.replace(
                &format!("{UPLOAD_STEP}        if: ${{{{ !cancelled() }}}}\n"),
                UPLOAD_STEP,
            ),
            live_gate_wrong,
            "has no `if: ${{ !cancelled() }}` line".to_string(),
        ),
        (
            "the verdict job's needs line set to `needs: changes`",
            CI_YML.replace(
                &format!("    {LIVE_VERDICT_NEEDS}\n"),
                &format!("    {HEAVY_NEEDS}\n"),
            ),
            job_classes_wrong,
            format!("heavy job `{LIVE_VERDICT_JOB}` is missing `{LIVE_VERDICT_NEEDS}`"),
        ),
    ];
    assert_eq!(plants.len(), 12, "twelve ways of switching the live verdict off");

    let mut missed: Vec<String> = Vec::new();
    for (what, yml, check, must_name) in &plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = check(yml).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the live gate went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The job that runs the lesson walk.
const WALK_JOB: &str = "e2e-walk";
/// The developer's walk command, as the whole of its `run:` line.
const WALK_SUITE_RUN: &str = "run: npm run e2e:walk";
/// The walk's report check, as the whole of its `run:` line.
const WALK_CHECKER_RUN: &str =
    "run: bash ../scripts/check-walk-report.sh test-results/walk-report.json";
/// The report check's bite proof, as the whole of its `run:` line.
const WALK_BITES_RUN: &str = "run: bash scripts/prove-walk-report-bites.sh";
/// `frontend/package.json`, because `e2e:walk` can swallow an exit code there just as well.
const FRONTEND_PACKAGE_JSON: &str = include_str!("../../../frontend/package.json");

/// A workflow line with a step's leading `- ` taken off, so `- run: x` reads the same as `run: x`.
fn step_key(line: &str) -> &str {
    line.strip_prefix("- ").unwrap_or(line)
}

/// Everything wrong with how `yml` and `package_json` wire the walk's verdict. Empty means right.
fn walk_gate_wrong(yml: &str, package_json: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let runs = [
        (WALK_BITES_RUN, "scripts/prove-walk-report-bites.sh"),
        (WALK_SUITE_RUN, "npm run e2e:walk"),
        (WALK_CHECKER_RUN, "scripts/check-walk-report.sh"),
    ];

    // Each one exactly once, in the walk's job, as the whole of its line. A whole-line match is what
    // refuses `|| true`, `; true` and a pipe, each of which turns the step's failure into a pass.
    for (expected, needle) in runs {
        let found: Vec<(&str, &str)> = blocks
            .iter()
            .flat_map(|(id, lines)| lines.iter().map(move |line| (*id, step_key(line))))
            .filter(|(_, line)| line.starts_with("run:") && line.contains(needle))
            .collect();
        if found != [(WALK_JOB, expected)] {
            wrong.push(format!(
                "the `run:` lines invoking `{needle}` are {found:?}, expected exactly \
                 [(\"{WALK_JOB}\", \"{expected}\")]. With anything else on that line, or the step \
                 moved or gone, the walk's job can go green without the walk's verdict."
            ));
        }
    }

    match blocks.iter().find(|(id, _)| *id == WALK_JOB) {
        None => wrong.push(format!("there is no job `{WALK_JOB}` under `jobs:`.")),
        Some((_, lines)) => {
            let walk_runs: Vec<&str> = lines
                .iter()
                .map(|line| step_key(line))
                .filter(|line| line.starts_with("run:"))
                .collect();
            let at = |expected: &str| walk_runs.iter().position(|line| *line == expected);
            if let (Some(b), Some(s), Some(c)) =
                (at(WALK_BITES_RUN), at(WALK_SUITE_RUN), at(WALK_CHECKER_RUN))
                && !(b < s && s + 1 == c)
            {
                wrong.push(format!(
                    "the bite proof, the walk and the report check are `run:` lines {b}, {s} and \
                     {c} of job `{WALK_JOB}`. The proof must come before the walk, and the check \
                     must be the line straight after it."
                ));
            }
            for line in lines
                .iter()
                .filter(|line| step_key(line).starts_with("continue-on-error"))
            {
                wrong.push(format!(
                    "job `{WALK_JOB}` carries `{line}`, so a failed walk or a failed report check \
                     would leave the job green."
                ));
            }
            for (_, needle) in runs {
                for line in step_of(lines, needle)
                    .iter()
                    .filter(|line| step_key(line).starts_with("if:"))
                {
                    wrong.push(format!(
                        "the step that runs `{needle}` in job `{WALK_JOB}` carries `{line}`. A \
                         condition can skip it while the job stays green."
                    ));
                }
            }
        }
    }

    // The npm script deletes the old report first, so a failed build leaves nothing to read, ends in
    // the unfiltered walk, and can't swallow an exit code on the way.
    let script = package_json
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("\"e2e:walk\": \""))
        .and_then(|rest| rest.trim_end_matches(',').strip_suffix('"'));
    match script {
        None => wrong.push("frontend/package.json has no `e2e:walk` script.".to_string()),
        Some(script) => {
            if !script.starts_with("rm -f test-results/walk-report.json && ")
                || !script.ends_with("&& playwright test --config=playwright.walk.config.ts")
                || script.contains("||")
                || script.contains(';')
            {
                wrong.push(format!(
                    "the `e2e:walk` script is `{script}`. It must delete the old report first, end \
                     in the unfiltered `playwright test --config=playwright.walk.config.ts`, and \
                     hold no `||` or `;`, or the report check can read a stale or partial run."
                ));
            }
        }
    }
    wrong
}

/// The walk's verdict is its exit code and its report, and nothing can switch either off.
///
/// `ci.yml` says so in a comment, and a comment can't fail. Changing the run line to
/// `npm run e2e:walk || true`, adding `continue-on-error: true` or deleting a step would each leave
/// the job green forever, so those facts are pinned here, where `cargo test` runs them.
#[test]
fn the_walk_gate_verdict_cannot_be_switched_off() {
    let wrong = walk_gate_wrong(CI_YML, FRONTEND_PACKAGE_JSON);
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the walk's verdict are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions are what keep the walk gate on.",
        wrong.len(),
        wrong.join("\n\n")
    );
}

/// `walk_gate_wrong` can fail: each of these breaks is planted in a copy of the real files.
#[test]
fn the_walk_gate_check_names_each_way_of_switching_it_off() {
    const SUITE_STEP: &str = "      - name: Run the lesson walk\n";
    const CHECKER_STEP: &str = "      - name: Every walk test ran and passed\n";
    let job_header = "    name: lesson walk (real headless host)\n";
    let suite_line = format!("        {WALK_SUITE_RUN}\n");
    let checker_line = format!("        {WALK_CHECKER_RUN}\n");
    let bites_line = format!("        {WALK_BITES_RUN}\n");

    let planted: Vec<(&str, String, &str)> = vec![
        (
            "the walk's exit code swallowed",
            suite_line.replace("e2e:walk", "e2e:walk || true"),
            "npm run e2e:walk",
        ),
        ("the walk step deleted", String::new(), "npm run e2e:walk"),
        (
            "the walk as a block",
            "        run: |\n          npm run e2e:walk\n".to_string(),
            "npm run e2e:walk",
        ),
    ];
    for (what, replacement, must_name) in planted {
        let yml = CI_YML.replace(&suite_line, &replacement);
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let wrong = walk_gate_wrong(&yml, FRONTEND_PACKAGE_JSON).join("\n");
        assert!(
            wrong.contains(must_name),
            "{what}: named `{must_name}` in: {wrong}"
        );
    }

    let by_replacing: Vec<(&str, String, String, &str)> = vec![
        (
            "the report check's exit code swallowed",
            checker_line.clone(),
            checker_line.replace(".json", ".json || true"),
            "scripts/check-walk-report.sh",
        ),
        (
            "the report check deleted",
            checker_line.clone(),
            String::new(),
            "scripts/check-walk-report.sh",
        ),
        (
            "the bite proof deleted",
            bites_line.clone(),
            String::new(),
            "scripts/prove-walk-report-bites.sh",
        ),
        (
            "continue-on-error on the job",
            job_header.to_string(),
            format!("{job_header}    continue-on-error: true\n"),
            "continue-on-error",
        ),
        (
            "continue-on-error as a step's first key",
            SUITE_STEP.to_string(),
            "      - continue-on-error: true\n        name: Run the lesson walk\n".to_string(),
            "continue-on-error",
        ),
        (
            "a condition on the report check",
            CHECKER_STEP.to_string(),
            format!("{CHECKER_STEP}        if: false\n"),
            "carries `if: false`",
        ),
        (
            "a step between the walk and the report check",
            CHECKER_STEP.to_string(),
            format!("      - run: echo between\n{CHECKER_STEP}"),
            "the line straight after it",
        ),
    ];
    for (what, from, to, must_name) in by_replacing {
        let yml = CI_YML.replace(&from, &to);
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let wrong = walk_gate_wrong(&yml, FRONTEND_PACKAGE_JSON).join("\n");
        assert!(
            wrong.contains(must_name),
            "{what}: named `{must_name}` in: {wrong}"
        );
    }

    for (what, from, to) in [
        (
            "the script's exit code swallowed",
            "walk.config.ts\"",
            "walk.config.ts || true\"",
        ),
        (
            "a filtered walk",
            "walk.config.ts\"",
            "walk.config.ts --grep lesson\"",
        ),
        (
            "the old report kept",
            "rm -f test-results/walk-report.json && cargo build -p fabrico-host --example dev_render_server --example replay_hash",
            "cargo build -p fabrico-host --example dev_render_server --example replay_hash",
        ),
    ] {
        let package_json = FRONTEND_PACKAGE_JSON.replace(from, to);
        assert_ne!(
            package_json, FRONTEND_PACKAGE_JSON,
            "{what}: the plant landed"
        );
        let wrong = walk_gate_wrong(CI_YML, &package_json).join("\n");
        assert!(
            wrong.contains("the `e2e:walk` script is"),
            "{what}: named the script in: {wrong}"
        );
    }
}

/// The trimmed lines of the step in `job_lines` whose `run:` line invokes `needle`: from the
/// step's own `- ` line to the line before the next step's. Empty when no step runs it.
fn step_of<'a>(job_lines: &[&'a str], needle: &str) -> Vec<&'a str> {
    let Some(run_at) = job_lines
        .iter()
        .position(|l| (l.starts_with("run:") || l.starts_with("- run:")) && l.contains(needle))
    else {
        return Vec::new();
    };
    step_around(job_lines, run_at)
}

/// The trimmed lines of the step in `job_lines` that holds line `at`: from the step's own `- `
/// line to the line before the next step's.
fn step_around<'a>(job_lines: &[&'a str], at: usize) -> Vec<&'a str> {
    let start = job_lines[..=at]
        .iter()
        .rposition(|l| l.starts_with("- "))
        .unwrap_or(at);
    let end = job_lines[at + 1..]
        .iter()
        .position(|l| l.starts_with("- "))
        .map_or(job_lines.len(), |k| at + 1 + k);
    job_lines[start..end].to_vec()
}

/// The jobs under `jobs:` in `yml` that do not carry exactly one job-level `timeout-minutes:`
/// line (four spaces of indent, so a step-level limit does not count), each named. Returns the
/// job count too, so an empty or moved `jobs:` block cannot pass as "no job is missing one".
fn jobs_without_one_time_limit(yml: &str) -> (usize, Vec<String>) {
    let mut jobs: Vec<(String, usize)> = Vec::new();
    let mut in_jobs = false;
    for raw in yml.lines() {
        if !in_jobs {
            in_jobs = raw == "jobs:";
            continue;
        }
        if let Some(id) = job_id(raw) {
            jobs.push((id.to_string(), 0));
            continue;
        }
        if let Some(value) = raw.strip_prefix("    timeout-minutes:")
            && !value.trim().is_empty()
            && let Some((_, n)) = jobs.last_mut()
        {
            *n += 1;
        }
    }
    let wrong = jobs
        .iter()
        .filter(|(_, n)| *n != 1)
        .map(|(id, n)| {
            format!("job `{id}` has {n} job-level `timeout-minutes:` line(s), expected 1")
        })
        .collect();
    (jobs.len(), wrong)
}

/// Every job has its own time limit (review 84 WR-06), so a wedged run cannot burn GitHub's
/// default of 360 minutes a job without failing by name; a wedged macOS leg costs ten times
/// that. The limits
/// themselves are derived in the workflow's `jobs:` comment; this pins that none is dropped.
#[test]
fn every_job_has_a_time_limit() {
    let (jobs, wrong) = jobs_without_one_time_limit(CI_YML);
    assert!(
        jobs >= 15,
        "found {jobs} jobs under `jobs:` in .github/workflows/ci.yml, expected at least 15; \
         the job scan is not reading the workflow"
    );
    assert!(
        wrong.is_empty(),
        "every CI job must carry its own `timeout-minutes:` (review 84 WR-06):\n{}",
        wrong.join("\n")
    );

    // The scan can fail: a job without a limit, and a limit only at step level, are both named.
    let planted = "on: push\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 10\n  b:\n    runs-on: x\n    steps:\n      - run: y\n        timeout-minutes: 5\n";
    let (planted_jobs, planted_wrong) = jobs_without_one_time_limit(planted);
    assert_eq!(planted_jobs, 2, "the planted workflow has two jobs");
    assert_eq!(
        planted_wrong,
        vec!["job `b` has 0 job-level `timeout-minutes:` line(s), expected 1".to_string()],
        "the scan must name job `b`, whose only limit is on a step"
    );
}

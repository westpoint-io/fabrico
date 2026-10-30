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

/// Linux only on pull_request, all three legs on every other event. The Linux leg is
/// pinned to `ubuntu-24.04` (2026-10-12, plan 84-01): `ubuntu-latest` moves to Ubuntu 26
/// from 2026-10-19 and the apt package names were checked for 24.04 only.
const DETERMINISM_MATRIX: &str = r#"os: ${{ fromJSON(github.event_name == 'pull_request' && '["ubuntu-24.04"]' || '["ubuntu-24.04","macos-latest","windows-latest"]') }}"#;

/// Jobs skipped on a docs-only change. None of them read a markdown file at the
/// repository root when measured on 2026-09-30. The `unit` job's
/// `frontend/src/gates/oneBoardAllFive.source.test.ts` reads a markdown fixture under
/// `frontend/`, which the classifier never counts as docs, so editing it runs the job.
const HEAVY_JOBS: [&str; 5] = ["determinism", "golden-corpus", "e2e", "e2e-live", "unit"];

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
    let mut blocks: Vec<(&'static str, Vec<&'static str>)> = Vec::new();
    let mut in_jobs = false;
    for raw in CI_YML.lines() {
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
        let has_needs = lines.contains(&HEAVY_NEEDS);
        let has_gate = lines.contains(&HEAVY_GATE);
        if HEAVY_JOBS.contains(id) && !(has_needs && has_gate) {
            wrong.push(format!(
                "heavy job `{id}` is missing `{HEAVY_NEEDS}` (present: {has_needs}) or the \
                 exact gate `{HEAVY_GATE}` (present: {has_gate}). Without both, it either \
                 never skips or skips on the wrong verdict."
            ));
        }
        if ALWAYS_ON_JOBS.contains(id) && (has_needs || has_gate) {
            wrong.push(format!(
                "always-on job `{id}` carries `{HEAVY_NEEDS}` or the docs-only gate. It reads \
                 files a docs-only change can edit, so it must run on every push."
            ));
        }
    }

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

/// The developer's live command, byte-identical in CI.
const LIVE_SUITE: &str = "npm run e2e:live";
/// The live suite's verdict: its failed set is exactly the declared CUTs.
const LIVE_RED_SET_CHECKER: &str = "scripts/check-live-red-set.sh";
/// The checker's bite proof over hand-made reports.
const LIVE_RED_SET_BITES: &str = "scripts/prove-live-red-set-bites.sh";

/// The live job's verdict is the red-set check, not the suite's exit code (plan 84-02,
/// GATE-01, GATE-07).
///
/// # Why
///
/// The live suite carries a CUT that throws forever (77 D-15, D-20), so `npm run e2e:live`
/// exits 1 on every run, and the job swallows that exit code. Once it is swallowed, the
/// ONLY thing standing between a broken live suite and a green job is the checker step
/// after it. Dropping that step, moving it to another job, putting a step between the two,
/// or marking the job `continue-on-error` would each turn the live gate off without a
/// single red line anywhere. So the adjacency is pinned here, where `cargo test` runs it.
///
/// Every wrong fact is collected before the single assert, so one run names them all.
#[test]
fn the_live_gate_verdict_is_the_red_set_check() {
    let mut wrong: Vec<String> = Vec::new();

    // (a) - (c): each invoked exactly once.
    wrong.extend(check_run_invocations(
        LIVE_SUITE,
        1,
        "The live job runs the byte-identical developer command exactly once; its exit code \
         is no longer the verdict, the red-set check on the next `run:` line is.",
    ));
    wrong.extend(check_run_invocations(
        LIVE_RED_SET_CHECKER,
        1,
        "The red-set check is the live job's only verdict. Without it, a job that swallows \
         the suite's exit code is green whatever the suite did.",
    ));
    wrong.extend(check_run_invocations(
        LIVE_RED_SET_BITES,
        1,
        "The checker's bite proof runs once, before the suite, so a checker drifted towards \
         OK fails the job before it can pass a broken suite.",
    ));

    // (b): the checker is the run: line IMMEDIATELY after the suite.
    let runs = run_lines();
    let suite_at = indices_of_invocation(LIVE_SUITE);
    let checker_at = indices_of_invocation(LIVE_RED_SET_CHECKER);
    if let ([s], [c]) = (suite_at.as_slice(), checker_at.as_slice())
        && s + 1 != *c
    {
        wrong.push(format!(
            "`{LIVE_SUITE}` is `run:` line {s} and `{LIVE_RED_SET_CHECKER}` is {c} (of {}); \
             the checker must be the run: line IMMEDIATELY after the suite, because the \
             suite's exit code is swallowed and nothing else decides the job.",
            runs.len()
        ));
    }

    // (d): all three live in job `e2e-live`; (e): no continue-on-error there.
    let blocks = job_blocks();
    for needle in [LIVE_SUITE, LIVE_RED_SET_CHECKER, LIVE_RED_SET_BITES] {
        let homes: Vec<&str> = blocks
            .iter()
            .filter(|(_, lines)| {
                lines
                    .iter()
                    .any(|line| line.starts_with("run:") && line.contains(needle))
            })
            .map(|(id, _)| *id)
            .collect();
        if homes != ["e2e-live"] {
            wrong.push(format!(
                "`{needle}` is invoked from job(s) {homes:?}, expected only [\"e2e-live\"]. \
                 The suite, its verdict and the verdict's proof are one gate and must share \
                 one job."
            ));
        }
    }
    match blocks.iter().find(|(id, _)| *id == "e2e-live") {
        None => wrong.push("there is no job `e2e-live` under `jobs:`.".to_string()),
        Some((_, lines)) => {
            for line in lines.iter().filter(|l| l.starts_with("continue-on-error")) {
                wrong.push(format!(
                    "job `e2e-live` carries `{line}`. The suite's exit code is already \
                     swallowed; continue-on-error would swallow the red-set check too, and the \
                     live gate would be green whatever happened."
                ));
            }
            // (f): no step-level `if:` on the checker's step or the bite proof's step (review
            // 84 WR-07). `if: false`, or any condition that is false on a push, skips the only
            // verdict while the suite's exit code is swallowed, and the job is green.
            for needle in [LIVE_RED_SET_CHECKER, LIVE_RED_SET_BITES] {
                for line in step_of(lines, needle)
                    .iter()
                    .filter(|l| l.starts_with("if:"))
                {
                    wrong.push(format!(
                        "the step that runs `{needle}` in job `e2e-live` carries `{line}`. A \
                         condition on it can skip the live verdict or its proof while the job \
                         stays green; it must run whenever the job does."
                    ));
                }
            }
            // (g): the checker keeps its own floor of tests (review 84 WR-07).
            for line in lines.iter().filter(|l| {
                l.starts_with("run:")
                    && l.contains(LIVE_RED_SET_CHECKER)
                    && l.contains("--min-tests")
            }) {
                wrong.push(format!(
                    "job `e2e-live` runs the checker as `{line}`. `--min-tests` lowers the \
                     170-test floor, so a filtered or partial run could pass as the gate."
                ));
            }
        }
    }

    // (h): the bite proof runs before the suite, as its message in (a) - (c) says.
    let bites_at = indices_of_invocation(LIVE_RED_SET_BITES);
    if let ([b], [s]) = (bites_at.as_slice(), suite_at.as_slice())
        && b >= s
    {
        wrong.push(format!(
            "`{LIVE_RED_SET_BITES}` is `run:` line {b} and `{LIVE_SUITE}` is {s}; the bite \
             proof must run BEFORE the suite, so a checker drifted towards OK fails the job \
             before the suite's 70 minutes are spent and before it can pass a broken suite."
        ));
    }

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

/// The trimmed lines of the step in `job_lines` whose `run:` line invokes `needle`: from the
/// step's own `- ` line to the line before the next step's. Empty when no step runs it.
fn step_of<'a>(job_lines: &[&'a str], needle: &str) -> Vec<&'a str> {
    let Some(run_at) = job_lines
        .iter()
        .position(|l| (l.starts_with("run:") || l.starts_with("- run:")) && l.contains(needle))
    else {
        return Vec::new();
    };
    let start = job_lines[..=run_at]
        .iter()
        .rposition(|l| l.starts_with("- "))
        .unwrap_or(run_at);
    let end = job_lines[run_at + 1..]
        .iter()
        .position(|l| l.starts_with("- "))
        .map_or(job_lines.len(), |k| run_at + 1 + k);
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

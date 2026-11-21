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

/// `.github/workflows/release.yml`, embedded the same way. It attaches the offline file to a draft
/// release; `release_wiring_wrong` pins its least-privilege split.
const RELEASE_YML: &str = include_str!("../../../.github/workflows/release.yml");

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

/// The docs job's gate: skip only on the exact string `false`, which the classifier writes only
/// for a change made entirely of root markdown other than README.md (the docs suite checks the
/// README, so a change to it runs the job). A failed classifier leaves the output empty, and empty
/// runs the job.
const DOCS_GATE: &str = "if: ${{ !cancelled() && needs.changes.outputs.docs_suite != 'false' }}";

/// The job that builds the docs site and runs its suite.
const DOCS_JOB: &str = "docs";

/// Jobs gated on the classifier's second output, `docs_suite`. Each carries `HEAVY_NEEDS` and
/// `DOCS_GATE` and nothing else that reads the classifier.
const DOCS_JOBS: [&str; 1] = [DOCS_JOB];

/// The job that deploys the checked docs site to GitHub Pages.
const PAGES_JOB: &str = "pages";
/// The job that smoke-tests the live site after the deploy.
const PAGES_SMOKE_JOB: &str = "pages-smoke";
/// Jobs that publish the site the docs job checked, and check what was published. They read no
/// classifier output: each runs only on a push to main, after the job before it.
const DEPLOY_JOBS: [&str; 2] = [PAGES_JOB, PAGES_SMOKE_JOB];
/// The condition every deploy job carries, and the docs job's Pages upload step: a push to main.
/// Pull requests, other branches and `workflow_dispatch` never deploy.
const MAIN_PUSH_IF: &str = "if: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
/// Each deploy job's exact `needs:` line: the deploy waits for the docs suite, the smoke for the deploy.
const DEPLOY_NEEDS: [(&str, &str); 2] = [(PAGES_JOB, "needs: docs"), (PAGES_SMOKE_JOB, "needs: pages")];
/// The two scopes deploy-pages needs. Only `PAGES_JOB` may carry them: it runs one first-party
/// action and no package code, and every other job runs `npm ci` or `cargo`.
const PAGES_SCOPES: [&str; 2] = ["pages: write", "id-token: write"];
/// The docs job's step that hands the checked site to the deploy, and the folder it hands on.
const PAGES_UPLOAD: &str = "uses: actions/upload-pages-artifact@v5";
const PAGES_UPLOAD_PATH: &str = "path: site/dist";
/// The deploy step in `PAGES_JOB`.
const PAGES_DEPLOY: &str = "uses: actions/deploy-pages@v5";
/// The lines of `PAGES_JOB` that queue deploys without cancelling one in progress, and name the
/// Pages environment deploy-pages publishes to.
const PAGES_JOB_LINES: [&str; 3] = ["group: pages", "cancel-in-progress: false", "name: github-pages"];
/// The smoke's run line in `PAGES_SMOKE_JOB`, and the two env lines its step must carry.
const PAGES_SMOKE_RUN: &str = "run: bash scripts/check-pages-smoke.sh";
const PAGES_SMOKE_ENV: [&str; 2] = [
    "FABRICO_DOCS_URL: https://westpoint-io.github.io/fabrico/",
    "FABRICO_SMOKE_SHA: ${{ github.sha }}",
];
/// What a deploy job must never run: it deploys and checks the site the docs job built and checked,
/// never one it built itself.
const DEPLOY_FORBIDDEN: [&str; 2] = ["scripts/build-site.sh", "scripts/check-docs.sh"];

/// The `embed` job's dependency: the classifier, and the job whose module it takes.
const EMBED_NEEDS: &str = "needs: [changes, wasm-player]";

/// The heavy jobs whose `needs:` line is not `HEAVY_NEEDS`, each with the one line it must carry.
/// Each of these jobs reads what an earlier job made, so it needs that job as well as the
/// classifier. Every other heavy job carries `HEAVY_NEEDS` and nothing else.
const JOB_NEEDS: [(&str, &str); 3] = [
    (EMBED_JOB, EMBED_NEEDS),
    (LIVE_VERDICT_JOB, LIVE_VERDICT_NEEDS),
    (WALK_VERDICT_JOB, WALK_VERDICT_NEEDS),
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
/// repository root when measured on 2026-09-30, and none reads a file under `site/` when
/// measured on 2026-11-10: outside the docs suite (`frontend/e2e-docs/`), the site's asset and
/// facts scripts and the docs job's own scripts, nothing under `crates/`, `frontend/` or
/// `scripts/` reads there except the always-on residue gate. The `unit` job's
/// `frontend/src/gates/oneBoardAllFive.source.test.ts` reads a markdown fixture under
/// `frontend/`, which the classifier never counts as docs, so editing it runs the job.
/// `e2e-capture` (the board capture set) reads `frontend/` and `crates/` and never a markdown file
/// at the repository root, so it skips on a docs-only change like `e2e-walk`.
const HEAVY_JOBS: [&str; 12] = [
    "determinism",
    "headless-build",
    "wasm-player",
    "embed",
    "golden-corpus",
    "e2e",
    "e2e-live",
    "e2e-live-verdict",
    "e2e-walk",
    "e2e-walk-verdict",
    "e2e-capture",
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

/// Everything wrong with how `yml` classes its jobs: every job is heavy, docs or always-on, each
/// heavy job carries its `needs:` line and the exact docs-only gate, each docs job carries
/// `HEAVY_NEEDS` and the exact docs gate and no other line that reads the classifier, no heavy job
/// carries the docs gate, and no always-on job carries a `needs:` line on the classifier or either
/// gate. A heavy job's `needs:` line is the one `JOB_NEEDS` gives it, or `HEAVY_NEEDS`. Empty means
/// right.
fn job_classes_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let mut found_ids: Vec<&str> = blocks.iter().map(|(id, _)| *id).collect();
    found_ids.sort_unstable();
    let mut expected_ids: Vec<&str> = HEAVY_JOBS
        .iter()
        .chain(DOCS_JOBS.iter())
        .chain(DEPLOY_JOBS.iter())
        .chain(ALWAYS_ON_JOBS.iter())
        .copied()
        .collect();
    expected_ids.sort_unstable();
    if found_ids != expected_ids {
        wrong.push(format!(
            "the job ids under `jobs:` are {found_ids:?}, expected exactly {expected_ids:?}.\n\
             Every job must be classified. A job that reads a markdown file at the \
             repository root is ALWAYS-ON (add it to ALWAYS_ON_JOBS, \
             no `needs: changes`, no gate). A job that checks the docs site is DOCS (add it to \
             DOCS_JOBS and give it `{HEAVY_NEEDS}` and `{DOCS_GATE}`). A job that publishes the \
             checked site or checks what was published is DEPLOY (add it to DEPLOY_JOBS and \
             DEPLOY_NEEDS and give it its `needs:` line and `{MAIN_PUSH_IF}`). Otherwise it is \
             HEAVY (add it to HEAVY_JOBS and give it `{HEAVY_NEEDS}` and `{HEAVY_GATE}`)."
        ));
    }
    for (id, lines) in &blocks {
        let needs = needs_of(id);
        let has_needs = lines.contains(&needs);
        let has_gate = lines.contains(&HEAVY_GATE);
        let has_docs_gate = lines.contains(&DOCS_GATE);
        if HEAVY_JOBS.contains(id) && !(has_needs && has_gate) {
            wrong.push(format!(
                "heavy job `{id}` is missing `{needs}` (present: {has_needs}) or the \
                 exact gate `{HEAVY_GATE}` (present: {has_gate}). Without both, it either \
                 never skips or skips on the wrong verdict."
            ));
        }
        if HEAVY_JOBS.contains(id) && has_docs_gate {
            wrong.push(format!(
                "heavy job `{id}` carries the docs gate `{DOCS_GATE}`. It would run on a change \
                 made of root markdown and site/ only, and skip on its own verdict's opposite."
            ));
        }
        if DOCS_JOBS.contains(id) {
            let has_docs_needs = lines.contains(&HEAVY_NEEDS);
            if !(has_docs_needs && has_docs_gate) {
                wrong.push(format!(
                    "docs job `{id}` is missing `{HEAVY_NEEDS}` (present: {has_docs_needs}) or the \
                     exact gate `{DOCS_GATE}` (present: {has_docs_gate}). Without both, it either \
                     never runs on a site change or runs on the wrong verdict."
                ));
            }
            for line in lines
                .iter()
                .filter(|line| line.contains("needs.changes.outputs") && **line != DOCS_GATE)
            {
                wrong.push(format!(
                    "docs job `{id}` carries `{line}`, which reads the classifier but is not the \
                     exact gate `{DOCS_GATE}`."
                ));
            }
        }
        if let Some((_, deploy_needs)) = DEPLOY_NEEDS.iter().find(|(job, _)| job == id) {
            let needs_lines: Vec<&str> = lines
                .iter()
                .copied()
                .filter(|line| line.starts_with("needs:"))
                .collect();
            let if_lines: Vec<&str> = lines
                .iter()
                .copied()
                .filter(|line| line.starts_with("if:"))
                .collect();
            if needs_lines != [*deploy_needs] {
                wrong.push(format!(
                    "deploy job `{id}` has the needs line(s) {needs_lines:?}, expected exactly                      [\"{deploy_needs}\"]. The deploy must wait for the docs suite and the smoke \
                     for the deploy."
                ));
            }
            if !if_lines.contains(&MAIN_PUSH_IF) || has_gate || has_docs_gate {
                wrong.push(format!(
                    "deploy job `{id}` has the condition line(s) {if_lines:?}, which must include \
                     `{MAIN_PUSH_IF}` and no classifier gate. Without it a pull request or another \
                     branch would deploy or smoke-test the site."
                ));
            }
        }
        let has_any_needs = lines.contains(&HEAVY_NEEDS)
            || JOB_NEEDS.iter().any(|(_, needs)| lines.contains(needs));
        if ALWAYS_ON_JOBS.contains(id) && (has_any_needs || has_gate || has_docs_gate) {
            wrong.push(format!(
                "always-on job `{id}` carries a `needs:` line on the classifier or a gate on its \
                 output. It reads files a docs-only change can edit, so it must run on every push."
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

/// The exact lines the docs job runs: install the site's packages with no install script, regenerate
/// the facts and fail when the committed file differs, both lints, the site's unit tests, the build
/// and the docs suite. No other job runs any of them.
const DOCS_RUN_LINES: [&str; 8] = [
    "run: npm ci --ignore-scripts",
    "run: npm run facts",
    "run: git diff --exit-code -- site/src/generated/facts.json",
    "run: npm run lint:prose",
    "run: npm run lint:facts",
    "run: npm run test:unit",
    "run: bash scripts/build-site.sh",
    "run: bash scripts/check-docs.sh",
];
/// The docs job's Node line. astro 7.4.4 refuses Node 22 below 22.23.4.
const DOCS_NODE: &str = "node-version: 24";
/// The classifier's second output, exported by the `changes` job.
const DOCS_SUITE_OUTPUT: &str = "docs_suite: ${{ steps.classify.outputs.docs_suite }}";

/// Everything wrong with how `yml` wires the docs job and the output its gate reads. Empty means
/// right.
fn docs_job_wrong(yml: &str) -> Vec<String> {
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
    let docs = job_lines(DOCS_JOB);
    let changes = job_lines("changes");

    for line in DOCS_RUN_LINES {
        let in_job = docs.iter().filter(|l| step_key(l) == line).count();
        let in_file = code.iter().filter(|l| step_key(l) == line).count();
        if in_job != 1 || in_file != 1 {
            wrong.push(format!(
                "`{line}` appears {in_job} time(s) in job `{DOCS_JOB}` and {in_file} time(s) in \
                 the workflow, expected 1 and 1."
            ));
        }
    }

    // The freshness diff is the very next command after the facts are regenerated, so nothing in
    // between can rewrite or restore the file it compares.
    let runs: Vec<&str> = docs
        .iter()
        .map(|l| step_key(l))
        .filter(|l| l.starts_with("run:"))
        .collect();
    let facts_at = runs.iter().position(|l| *l == DOCS_RUN_LINES[1]);
    let diff_at = runs.iter().position(|l| *l == DOCS_RUN_LINES[2]);
    if let (Some(f), Some(d)) = (facts_at, diff_at)
        && d != f + 1
    {
        wrong.push(format!(
            "job `{DOCS_JOB}` runs `{}` as run line {d} and `{}` as run line {f}; the freshness \
             diff must be the run line straight after the facts are regenerated.",
            DOCS_RUN_LINES[2], DOCS_RUN_LINES[1]
        ));
    }

    let node = docs.iter().filter(|l| **l == DOCS_NODE).count();
    if node != 1 {
        wrong.push(format!(
            "`{DOCS_NODE}` appears {node} time(s) in job `{DOCS_JOB}`, expected 1. The site's \
             astro refuses an older Node, so the job would fail on setup or test a Node nobody \
             builds with."
        ));
    }

    let in_changes = changes.iter().filter(|l| **l == DOCS_SUITE_OUTPUT).count();
    let in_file = code.iter().filter(|l| **l == DOCS_SUITE_OUTPUT).count();
    if in_changes != 1 || in_file != 1 {
        wrong.push(format!(
            "`{DOCS_SUITE_OUTPUT}` appears {in_changes} time(s) in job `changes` and {in_file} \
             time(s) in the workflow, expected 1 and 1. Without it the docs gate reads an empty \
             output on every push."
        ));
    }
    wrong
}

/// The docs job regenerates the facts and fails on a difference, runs both lints and the site's
/// unit tests, builds the site and runs the docs suite, on Node 24, reading the classifier's
/// second output. Each run line is matched whole, so a trailing `|| true` drops it from the count.
#[test]
fn the_docs_job_builds_the_site_and_runs_every_check() {
    let wrong = docs_job_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "the docs job isn't wired as it has to be:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// The docs job can't be switched off one step at a time: no `continue-on-error` anywhere in it,
/// and no condition on a step that runs one of its checks.
#[test]
fn the_docs_job_cannot_be_switched_off_a_step_at_a_time() {
    let wrong = step_guards_wrong(CI_YML, DOCS_JOB, &DOCS_RUN_LINES);
    assert!(
        wrong.is_empty(),
        "the docs job carries a step condition or continue-on-error:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// `job_classes_wrong`, `gate_lines_wrong`, `docs_job_wrong` and `step_guards_wrong` can fail on the
/// docs job: each break below is planted in a copy of the real workflow, and a check has to name it.
#[test]
fn the_docs_job_checks_name_each_way_of_switching_it_off() {
    const DOCS_HEADER: &str = "    name: the docs site builds and passes its checks\n";
    const FRESHNESS_STEP: &str = "      - name: Fail when the committed facts differ from the code\n";

    let all = |yml: &str| {
        let mut wrong = job_classes_wrong(yml);
        wrong.extend(gate_lines_wrong(yml));
        wrong.extend(docs_job_wrong(yml));
        wrong.extend(step_guards_wrong(yml, DOCS_JOB, &DOCS_RUN_LINES));
        wrong.join("\n")
    };
    let mut missed: Vec<String> = Vec::new();
    let mut check = |what: &str, yml: String, must_name: &str| {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = all(&yml);
        if !named.contains(must_name) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    };

    // 1. The docs gate turned round to skip on `true`, which is the heavy gate's polarity.
    check(
        "the docs gate rewritten to != 'true'",
        CI_YML.replace(
            &format!("    {DOCS_GATE}\n"),
            "    if: ${{ !cancelled() && needs.changes.outputs.docs_suite != 'true' }}\n",
        ),
        &format!("docs job `{DOCS_JOB}` is missing `{HEAVY_NEEDS}` (present: true) or the exact gate"),
    );

    // 2. A condition on the step that runs the docs suite.
    check(
        "`if: false` on the check-docs.sh step",
        CI_YML.replace(
            "        run: bash scripts/check-docs.sh\n",
            "        if: false\n        run: bash scripts/check-docs.sh\n",
        ),
        &format!(
            "the step that runs `run: bash scripts/check-docs.sh` in job `{DOCS_JOB}` carries `if: false`"
        ),
    );

    // 3. continue-on-error on the whole job.
    check(
        "continue-on-error on the docs job",
        CI_YML.replace(
            DOCS_HEADER,
            &format!("{DOCS_HEADER}    continue-on-error: true\n"),
        ),
        &format!("job `{DOCS_JOB}` carries `continue-on-error: true`"),
    );

    // 4. The freshness diff step taken out.
    check(
        "the freshness diff step deleted",
        without_step(CI_YML, FRESHNESS_STEP),
        &format!("`{}` appears 0 time(s) in job `{DOCS_JOB}`", DOCS_RUN_LINES[2]),
    );

    // 5. The docs job on Node 22.
    check(
        "node-version 24 changed to 22 in the docs job",
        CI_YML.replace(&format!("          {DOCS_NODE}\n"), "          node-version: 22\n"),
        &format!("`{DOCS_NODE}` appears 0 time(s) in job `{DOCS_JOB}`"),
    );

    // 6. The changes job stops exporting docs_suite.
    check(
        "the docs_suite output removed from the changes job",
        CI_YML.replace(&format!("      {DOCS_SUITE_OUTPUT}\n"), ""),
        &format!("`{DOCS_SUITE_OUTPUT}` appears 0 time(s) in job `changes`"),
    );

    // 7. The docs job's needs line taken out.
    check(
        "the docs job's needs: changes removed",
        CI_YML.replace(
            &format!("{DOCS_HEADER}    {HEAVY_NEEDS}\n"),
            DOCS_HEADER,
        ),
        &format!("docs job `{DOCS_JOB}` is missing `{HEAVY_NEEDS}` (present: false)"),
    );

    assert!(
        missed.is_empty(),
        "{} planted break(s) went unnamed:\n{}",
        missed.len(),
        missed.join("\n")
    );
}

/// The docs job's lines for the README's hero: the apt line that installs img2webp (Ubuntu's `webp`
/// package) beside clang and llvm, and the three lines of the step that keeps `site/dist/hero/` as
/// the `fabrico-hero` artifact. `scripts/build-site.sh` captures the hero, so `DOCS_RUN_LINES`
/// already pins the run line; these pin the encoder it needs on the runner, which has no
/// ImageMagick, and the upload a reviewer downloads the hero from.
const DOCS_HERO_LINES: [&str; 4] = [
    "sudo apt-get install -y --no-install-recommends clang llvm webp",
    "uses: actions/upload-artifact@v4",
    "name: fabrico-hero",
    "path: site/dist/hero/",
];
/// The hero upload's condition: every run that isn't cancelled, a failed docs suite included.
const DOCS_HERO_IF: &str = "if: ${{ !cancelled() }}";

/// Everything wrong with how `yml` installs the hero's encoder and keeps the hero in the docs job.
/// Empty means right.
fn docs_hero_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let Some((_, docs)) = blocks.iter().find(|(id, _)| *id == DOCS_JOB) else {
        return vec![format!("there is no job `{DOCS_JOB}` under `jobs:`.")];
    };
    let [apt, _, name, _] = DOCS_HERO_LINES;

    let found = docs.iter().filter(|l| step_key(l) == apt).count();
    if found != 1 {
        wrong.push(format!(
            "`{apt}` appears {found} time(s) in job `{DOCS_JOB}`, expected 1. Without the `webp` \
             package the runner has no hero encoder, and the site build stops at the hero."
        ));
    }

    match one_step_with(docs, name, DOCS_JOB) {
        Err(message) => wrong.push(format!(
            "{message} The docs job keeps the hero it made as the `fabrico-hero` artifact."
        )),
        Ok((at, step)) => {
            for key in DOCS_HERO_LINES[1..]
                .iter()
                .copied()
                .chain([DOCS_HERO_IF, "if-no-files-found: error"])
            {
                if !step.iter().any(|l| step_key(l) == key) {
                    wrong.push(format!(
                        "the step carrying `{name}` in job `{DOCS_JOB}` has no `{key}` line. \
                         Without it a run keeps no hero, keeps the wrong folder, or keeps none \
                         when the docs suite fails."
                    ));
                }
            }
            let suite = docs.iter().position(|l| step_key(l) == DOCS_RUN_LINES[7]);
            if let Some(s) = suite
                && s > at
            {
                wrong.push(format!(
                    "job `{DOCS_JOB}` keeps the hero before it runs `{}`.",
                    DOCS_RUN_LINES[7]
                ));
            }
        }
    }
    wrong
}

/// The docs job installs img2webp beside clang and llvm, and keeps the hero its site build made as
/// the `fabrico-hero` artifact on every run that isn't cancelled.
#[test]
fn the_docs_job_installs_the_hero_encoder_and_keeps_the_hero() {
    let wrong = docs_hero_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "the docs job doesn't make and keep the README's hero as it has to:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// `docs_hero_wrong` names the docs job's apt line when `webp` is taken off it.
#[test]
fn the_docs_hero_check_names_an_apt_line_without_webp() {
    let yml = CI_YML.replace(
        "--no-install-recommends clang llvm webp\n",
        "--no-install-recommends clang llvm\n",
    );
    assert_ne!(yml, CI_YML, "the plant landed");
    let named = docs_hero_wrong(&yml).join("\n");
    let must_name = format!(
        "`{}` appears 0 time(s) in job `{DOCS_JOB}`, expected 1.",
        DOCS_HERO_LINES[0]
    );
    assert!(
        named.contains(&must_name),
        "expected `{must_name}` named, got: {named:?}"
    );
}

/// `docs_hero_wrong` names the hero upload when its step is taken out of the docs job.
#[test]
fn the_docs_hero_check_names_a_missing_hero_upload() {
    let yml = without_step(CI_YML, "      - name: Keep the hero this run made\n");
    assert_ne!(yml, CI_YML, "the plant landed");
    let named = docs_hero_wrong(&yml).join("\n");
    let must_name = format!(
        "`{}` appears 0 time(s) in job `{DOCS_JOB}`, expected 1.",
        DOCS_HERO_LINES[2]
    );
    assert!(
        named.contains(&must_name),
        "expected `{must_name}` named, got: {named:?}"
    );
}

/// The untrimmed lines of job `id` in `yml`, comments included, from the line after its header to
/// the next job header. Used where indent matters: a job-level key has four spaces.
fn raw_job_lines<'a>(yml: &'a str, id: &str) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    let mut in_jobs = false;
    let mut inside = false;
    for raw in yml.lines() {
        if !in_jobs {
            in_jobs = raw == "jobs:";
            continue;
        }
        if let Some(found) = job_id(raw) {
            inside = found == id;
            continue;
        }
        if inside {
            out.push(raw);
        }
    }
    out
}

/// One `permissions:` key in a workflow: the job it sits in (None above `jobs:`), its 1-based line,
/// its indent, the value on its own line (empty for a block) and the trimmed entries of its block.
struct PermissionsKey<'a> {
    job: Option<&'a str>,
    line: usize,
    indent: usize,
    inline: &'a str,
    entries: Vec<&'a str>,
}

/// Every `permissions:` key in `yml`, at any indent, comments and blank lines skipped.
fn permission_keys(yml: &str) -> Vec<PermissionsKey<'_>> {
    let lines: Vec<&str> = yml.lines().collect();
    let mut out: Vec<PermissionsKey<'_>> = Vec::new();
    let mut in_jobs = false;
    let mut job: Option<&str> = None;
    for (n, raw) in lines.iter().enumerate() {
        if *raw == "jobs:" {
            in_jobs = true;
            continue;
        }
        if in_jobs && let Some(id) = job_id(raw) {
            job = Some(id);
            continue;
        }
        let trimmed = raw.trim_start();
        let Some(rest) = trimmed.strip_prefix("permissions:") else {
            continue;
        };
        let indent = raw.len() - trimmed.len();
        let inline = rest.split(" #").next().unwrap_or("").trim();
        let mut entries: Vec<&str> = Vec::new();
        for next in &lines[n + 1..] {
            let t = next.trim();
            if t.is_empty() || t.starts_with('#') {
                continue;
            }
            if next.len() - next.trim_start().len() <= indent {
                break;
            }
            entries.push(t.split(" #").next().unwrap_or("").trim());
        }
        out.push(PermissionsKey {
            job: if in_jobs { job } else { None },
            line: n + 1,
            indent,
            inline,
            entries,
        });
    }
    out
}

/// Everything wrong with the token scopes in `yml` (review 101 WR-03): the workflow level must be
/// one block holding only `contents: read`; a job may set `permissions:` only as a block at four
/// spaces (or the inline `{}` or `read-all`), never `write-all`; and a `<scope>: write` entry may
/// sit only in the job `allowed_writes` pairs it with. Any entry that isn't read, write or none is
/// named too. Empty means right.
fn permissions_wrong(yml: &str, file: &str, allowed_writes: &[(&str, &str)]) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let keys = permission_keys(yml);
    let workflow: Vec<&PermissionsKey<'_>> = keys.iter().filter(|k| k.job.is_none()).collect();
    let floor_right = workflow.len() == 1
        && workflow[0].indent == 0
        && workflow[0].inline.is_empty()
        && workflow[0].entries == ["contents: read"];
    if !floor_right {
        let found: Vec<String> = workflow
            .iter()
            .map(|k| format!("line {}: `permissions: {}` {:?}", k.line, k.inline, k.entries))
            .collect();
        wrong.push(format!(
            "{file}'s workflow-level permissions are {found:?}, expected one block holding only \
             `contents: read`. Every job inherits the floor, and the jobs run package code."
        ));
    }
    for key in keys.iter().filter(|k| k.job.is_some()) {
        let job = key.job.unwrap_or_default();
        if key.indent != 4 {
            wrong.push(format!(
                "{file} line {}: job `{job}` has a `permissions:` key at indent {}, expected the \
                 job level (4 spaces).",
                key.line, key.indent
            ));
        }
        if !key.inline.is_empty() && key.inline != "{}" && key.inline != "read-all" {
            wrong.push(format!(
                "{file} line {}: job `{job}` sets `permissions: {}`. Name each scope in a block. \
                 `write-all` gives every write scope to a job that may run package code.",
                key.line, key.inline
            ));
        }
        for entry in &key.entries {
            let (scope, level) = entry
                .split_once(':')
                .map_or((*entry, ""), |(s, l)| (s.trim(), l.trim()));
            match level {
                "read" | "none" => {}
                "write" => {
                    let normal = format!("{scope}: write");
                    if !allowed_writes.contains(&(job, normal.as_str())) {
                        wrong.push(format!(
                            "{file} line {}: job `{job}` holds `{normal}`. The only write scopes \
                             allowed are {allowed_writes:?}, each in its own job.",
                            key.line
                        ));
                    }
                }
                _ => wrong.push(format!(
                    "{file} line {}: job `{job}` has the permissions entry `{entry}`, which isn't \
                     `<scope>: read`, `write` or `none`.",
                    key.line
                )),
            }
        }
    }
    wrong
}

/// The write scopes ci.yml may hold, each paired with its one job.
const CI_ALLOWED_WRITES: [(&str, &str); 2] = [(PAGES_JOB, PAGES_SCOPES[0]), (PAGES_JOB, PAGES_SCOPES[1])];

/// Everything wrong with how `yml` deploys the docs site and smoke-tests it: the docs job hands
/// `site/dist` to Pages only on a push to main and only after the docs suite; `PAGES_JOB` holds the
/// two Pages scopes, queues without cancelling and deploys with deploy-pages; no other job holds
/// either scope; `PAGES_SMOKE_JOB` runs the smoke against the live address at this run's commit;
/// each deploy job's main-push condition is job-level; and no deploy job builds or checks a site of
/// its own. Empty means right.
fn deploy_jobs_wrong(yml: &str) -> Vec<String> {
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

    // The two scopes: each once in the whole file, and that once in the pages job.
    for scope in PAGES_SCOPES {
        let homes: Vec<&str> = blocks
            .iter()
            .filter(|(_, lines)| lines.contains(&scope))
            .map(|(id, _)| *id)
            .collect();
        let in_file = code.iter().filter(|l| **l == scope).count();
        if in_file != 1 || homes != [PAGES_JOB] {
            wrong.push(format!(
                "`{scope}` appears {in_file} time(s) in the workflow, in job(s) {homes:?}, expected \
                 once, in job `{PAGES_JOB}` only. Any other job runs package code that would \
                 inherit the scope."
            ));
        }
    }

    // Each deploy job's condition is the job's own, at four spaces, not a step's.
    for job in DEPLOY_JOBS {
        let job_level = raw_job_lines(yml, job)
            .iter()
            .filter(|l| **l == format!("    {MAIN_PUSH_IF}"))
            .count();
        if job_level != 1 {
            wrong.push(format!(
                "job `{job}` carries `{MAIN_PUSH_IF}` at job level {job_level} time(s), expected 1."
            ));
        }
        for line in job_lines(job) {
            if let Some(script) = DEPLOY_FORBIDDEN.iter().find(|s| line.contains(**s)) {
                wrong.push(format!(
                    "deploy job `{job}` carries `{line}`. A deploy job must not run `{script}`: it \
                     deploys and checks the site the docs job built and checked."
                ));
            }
        }
    }

    // The docs job's upload: once in the file, in the docs job, after the docs suite, main pushes
    // only, of site/dist.
    let docs = job_lines(DOCS_JOB);
    let uploads_in_file = code.iter().filter(|l| step_key(l) == PAGES_UPLOAD).count();
    match one_step_with(&docs, PAGES_UPLOAD, DOCS_JOB) {
        Err(message) => wrong.push(format!(
            "{message} The docs job hands the site it checked to the pages job."
        )),
        Ok((at, step)) => {
            for key in [MAIN_PUSH_IF, PAGES_UPLOAD_PATH] {
                if !step.iter().any(|l| step_key(l) == key) {
                    wrong.push(format!(
                        "the step carrying `{PAGES_UPLOAD}` in job `{DOCS_JOB}` has no `{key}` line. \
                         Without it the docs job uploads the wrong folder or uploads on runs that \
                         must not deploy."
                    ));
                }
            }
            let suite = docs.iter().position(|l| step_key(l) == DOCS_RUN_LINES[7]);
            if suite.is_none_or(|s| s > at) {
                wrong.push(format!(
                    "job `{DOCS_JOB}` uploads the site for Pages before it runs `{}`.",
                    DOCS_RUN_LINES[7]
                ));
            }
        }
    }
    if uploads_in_file != 1 {
        wrong.push(format!(
            "`{PAGES_UPLOAD}` appears {uploads_in_file} time(s) in the workflow, expected 1, in job \
             `{DOCS_JOB}`."
        ));
    }

    // The pages job: the deploy step, the queue and the environment.
    let pages = job_lines(PAGES_JOB);
    let deploys_in_file = code.iter().filter(|l| step_key(l) == PAGES_DEPLOY).count();
    let deploys_in_job = pages.iter().filter(|l| step_key(l) == PAGES_DEPLOY).count();
    if deploys_in_file != 1 || deploys_in_job != 1 {
        wrong.push(format!(
            "`{PAGES_DEPLOY}` appears {deploys_in_job} time(s) in job `{PAGES_JOB}` and \
             {deploys_in_file} time(s) in the workflow, expected 1 and 1."
        ));
    }
    for line in PAGES_JOB_LINES {
        if !pages.contains(&line) {
            wrong.push(format!(
                "job `{PAGES_JOB}` has no `{line}` line. It queues deploys in the `pages` group \
                 without cancelling one in progress, in the `github-pages` environment."
            ));
        }
    }

    // The smoke: once in the file, in the smoke job, with the live address and this commit.
    let smoke = job_lines(PAGES_SMOKE_JOB);
    let smoke_in_file = code.iter().filter(|l| step_key(l) == PAGES_SMOKE_RUN).count();
    match one_step_with(&smoke, PAGES_SMOKE_RUN, PAGES_SMOKE_JOB) {
        Err(message) => wrong.push(message),
        Ok((_, step)) => {
            for key in PAGES_SMOKE_ENV {
                if !step.contains(&key) {
                    wrong.push(format!(
                        "the step running `{PAGES_SMOKE_RUN}` in job `{PAGES_SMOKE_JOB}` has no \
                         `{key}` line, so the smoke would check another address or another commit."
                    ));
                }
            }
        }
    }
    if smoke_in_file != 1 {
        wrong.push(format!(
            "`{PAGES_SMOKE_RUN}` appears {smoke_in_file} time(s) in the workflow, expected 1, in job \
             `{PAGES_SMOKE_JOB}`."
        ));
    }
    wrong.extend(step_guards_wrong(yml, PAGES_JOB, &[]));
    wrong.extend(step_guards_wrong(yml, PAGES_SMOKE_JOB, &[PAGES_SMOKE_RUN]));
    wrong.extend(permissions_wrong(yml, "ci.yml", &CI_ALLOWED_WRITES));
    wrong
}

/// A push to main deploys exactly the site the docs suite passed, and then checks the live address
/// serves it. Only the deploy job holds the Pages scopes.
#[test]
fn the_checked_site_deploys_to_pages_and_the_live_site_is_smoke_tested() {
    let mut wrong = deploy_jobs_wrong(CI_YML);
    wrong.extend(job_classes_wrong(CI_YML));
    assert!(
        wrong.is_empty(),
        "the Pages deploy isn't wired as it has to be:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// Assert that `checker` names `must_name` on `yml`, a copy of the real workflow with one break
/// planted in it, and print what it named so a run's log shows the message.
fn assert_plant_named(what: &str, yml: &str, checker: fn(&str) -> Vec<String>, must_name: &str) {
    assert_ne!(yml, CI_YML, "{what}: the plant landed");
    let named = checker(yml).join("\n");
    println!("{what}: {named}");
    assert!(
        named.contains(must_name),
        "{what}: expected `{must_name}` named, got: {named:?}"
    );
}

/// `deploy_jobs_wrong` names the pages job's missing OIDC scope.
#[test]
fn the_deploy_check_names_pages_without_id_token_write() {
    assert_plant_named(
        "`pages` without `id-token: write`",
        &CI_YML.replace("      pages: write\n      id-token: write\n", "      pages: write\n"),
        deploy_jobs_wrong,
        &format!(
            "`{}` appears 0 time(s) in the workflow, in job(s) [], expected once, in job `{PAGES_JOB}` only.",
            PAGES_SCOPES[1]
        ),
    );
}

/// `job_classes_wrong` names the pages job without its main-push condition.
#[test]
fn the_deploy_check_names_pages_without_its_condition() {
    assert_plant_named(
        "`pages` without its `if:`",
        &CI_YML.replace(&format!("    needs: docs\n    {MAIN_PUSH_IF}\n"), "    needs: docs\n"),
        job_classes_wrong,
        &format!("deploy job `{PAGES_JOB}` has the condition line(s) [], which must include `{MAIN_PUSH_IF}`"),
    );
}

/// `job_classes_wrong` names a job that is in no class.
#[test]
fn the_deploy_check_names_a_job_in_no_class() {
    assert_plant_named(
        "an extra job in no class",
        &CI_YML.replace(
            "  pages-smoke:\n",
            "  pages-extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n    steps:\n      - run: echo hi\n\n  pages-smoke:\n",
        ),
        job_classes_wrong,
        "Every job must be classified.",
    );
}

/// `deploy_jobs_wrong` names the smoke job running the docs suite.
#[test]
fn the_deploy_check_names_pages_smoke_running_check_docs() {
    let smoke_run = format!("        {PAGES_SMOKE_RUN}\n");
    assert_plant_named(
        "`pages-smoke` running `check-docs.sh`",
        &CI_YML.replace(&smoke_run, &format!("{smoke_run}\n      - run: bash scripts/check-docs.sh\n")),
        deploy_jobs_wrong,
        &format!(
            "deploy job `{PAGES_SMOKE_JOB}` carries `- run: bash scripts/check-docs.sh`. A deploy job must not run `scripts/check-docs.sh`"
        ),
    );
}

/// `deploy_jobs_wrong` names the OIDC scope given to the docs job, which runs package code.
#[test]
fn the_deploy_check_names_id_token_write_in_the_docs_job() {
    let docs_header = "    name: the docs site builds and passes its checks\n";
    assert_plant_named(
        "`id-token: write` in the docs job",
        &CI_YML.replace(
            docs_header,
            &format!("{docs_header}    permissions:\n      contents: read\n      id-token: write\n"),
        ),
        deploy_jobs_wrong,
        &format!(
            "`{}` appears 2 time(s) in the workflow, in job(s) [\"{DOCS_JOB}\", \"{PAGES_JOB}\"], expected once",
            PAGES_SCOPES[1]
        ),
    );
}

/// `permissions: write-all` on the docs job, which runs npm ci and cargo, is named (review 101
/// WR-03).
#[test]
fn the_deploy_check_names_write_all_in_the_docs_job() {
    let docs_header = "    name: the docs site builds and passes its checks\n";
    assert_plant_named(
        "`permissions: write-all` in the docs job",
        &CI_YML.replace(docs_header, &format!("{docs_header}    permissions: write-all\n")),
        deploy_jobs_wrong,
        &format!("job `{DOCS_JOB}` sets `permissions: write-all`."),
    );
}

/// An unexpected write scope in the pages job, beside its two allowed ones, is named (review 101
/// WR-03).
#[test]
fn the_deploy_check_names_an_extra_write_scope_in_the_pages_job() {
    assert_plant_named(
        "`actions: write` in the pages job",
        &CI_YML.replace("      pages: write\n      id-token: write\n", "      pages: write\n      id-token: write\n      actions: write\n"),
        deploy_jobs_wrong,
        &format!("job `{PAGES_JOB}` holds `actions: write`"),
    );
}

/// A write scope added to ci.yml's workflow-level floor is named (review 101 WR-03).
#[test]
fn the_deploy_check_names_a_write_scope_in_the_workflow_floor() {
    assert_plant_named(
        "`permissions: write-all` at workflow level",
        &CI_YML.replacen("permissions:\n  contents: read\n", "permissions: write-all\n", 1),
        deploy_jobs_wrong,
        "ci.yml's workflow-level permissions are",
    );
}

/// Rule (f) of `ci_spend_controls_are_wired_fail_safe` over any workflow text: every non-comment
/// line that reads the classifier's output is `HEAVY_GATE`, or is `DOCS_GATE` inside `DOCS_JOB`,
/// and `DOCS_GATE` appears exactly once in the file. Empty means right.
fn gate_lines_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let code: Vec<&str> = yml
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect();
    for line in code
        .iter()
        .filter(|line| line.contains("needs.changes.outputs"))
    {
        if *line != HEAVY_GATE && *line != DOCS_GATE {
            wrong.push(format!(
                "non-comment line `{line}` reads the classifier's output but is neither the exact \
                 gate `{HEAVY_GATE}` nor `{DOCS_GATE}`. Only skip-on-exactly-true for the heavy \
                 jobs and skip-on-exactly-false for the docs job, under `!cancelled()`, are \
                 fail-safe: a failed classifier leaves the output empty, and that must run \
                 everything."
            ));
        }
    }
    let docs_gate_homes: Vec<&str> = job_blocks_in(yml)
        .iter()
        .filter(|(_, lines)| lines.contains(&DOCS_GATE))
        .map(|(id, _)| *id)
        .collect();
    let in_file = code.iter().filter(|line| **line == DOCS_GATE).count();
    if in_file != 1 || docs_gate_homes != [DOCS_JOB] {
        wrong.push(format!(
            "`{DOCS_GATE}` appears {in_file} time(s) in the workflow, in job(s) \
             {docs_gate_homes:?}, expected once, in job `{DOCS_JOB}` only. On any other job it \
             would run that job on the opposite verdict."
        ));
    }
    wrong
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

    // (f): no other polarity of either gate anywhere, and the docs gate only in the docs job.
    wrong.extend(gate_lines_wrong(CI_YML));

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

/// The docs tour's capture script (`frontend/scripts/capture-tour.ts`) as its whole `run:` line.
/// One leg of the live job runs it, so CI takes the tour pictures again on every run that touches
/// the app.
const TOUR_CAPTURE: &str = "run: npm run capture:tour";
/// The capture step's folder, where the npm script lives.
const TOUR_CAPTURE_DIR: &str = "working-directory: frontend";
/// The capture step's whole condition line: run on one leg only (`matrix.shard == 1`), and run even
/// when that leg's checker went red (`!cancelled()`), since the capture's check doesn't depend on
/// the suite's. Matched exactly, because a condition that holds both parts and adds a clause, such
/// as `&& false`, or names another leg, such as `matrix.shard == 10`, skips the capture everywhere.
const TOUR_CAPTURE_IF: &str = "if: ${{ !cancelled() && matrix.shard == 1 }}";

/// Everything wrong with how `yml` runs the tour capture. Empty means right.
fn tour_capture_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let homes: Vec<&str> = blocks
        .iter()
        .flat_map(|(id, lines)| {
            lines
                .iter()
                .filter(move |l| step_key(l) == TOUR_CAPTURE)
                .map(move |_| *id)
        })
        .collect();
    if homes != [LIVE_JOB] {
        wrong.push(format!(
            "the tour capture's run line `{TOUR_CAPTURE}` is in job(s) {homes:?}, expected exactly \
             once, in [\"{LIVE_JOB}\"]. Without it CI never takes the tour pictures again, so a \
             blank or wrong-size picture would go unseen."
        ));
    }
    let Some((_, job)) = blocks.iter().find(|(id, _)| *id == LIVE_JOB) else {
        wrong.push(format!("there is no job `{LIVE_JOB}` under `jobs:`."));
        return wrong;
    };
    let Some(at) = job.iter().position(|l| step_key(l) == TOUR_CAPTURE) else {
        return wrong;
    };
    let step = step_around(job, at);
    if !step.iter().any(|l| step_key(l) == TOUR_CAPTURE_DIR) {
        wrong.push(format!(
            "the tour capture's step in job `{LIVE_JOB}` has no `{TOUR_CAPTURE_DIR}` line, so npm \
             would look for the script outside frontend/."
        ));
    }
    let conditions: Vec<&str> = step
        .iter()
        .map(|l| step_key(l))
        .filter(|l| l.starts_with("if:"))
        .collect();
    if conditions != [TOUR_CAPTURE_IF] {
        wrong.push(format!(
            "the tour capture's step in job `{LIVE_JOB}` has the condition(s) {conditions:?}. It \
             needs exactly one line, `{TOUR_CAPTURE_IF}`: `matrix.shard == 1` so it runs once per \
             CI run rather than on every leg, and `!cancelled()` so a red checker before it \
             doesn't skip it, with nothing added."
        ));
    }
    let checker = live_run_lines().checker;
    if let Some(c) = job.iter().position(|l| step_key(l) == checker)
        && c > at
    {
        wrong.push(format!(
            "the tour capture runs before the shard checker in job `{LIVE_JOB}`. It starts its own \
             host and Vite on 8787 and 5173, which the suite holds until it ends, and the checker \
             must stay the run: line straight after the suite."
        ));
    }
    wrong
}

/// One leg of the live job takes the docs tour's pictures again, after the suite.
///
/// # Why
///
/// The tour page's pictures are committed, and the capture script fails when one comes out blank,
/// the wrong size, or with a page error or a stopped render loop. That check only means something
/// if CI keeps running it, and a step that was deleted, moved, or given a condition that skips it
/// would leave every run green with no red line anywhere. So the step is pinned here.
#[test]
fn the_live_job_retakes_the_tour_pictures_once_per_run() {
    let wrong = tour_capture_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "the tour capture isn't wired as it has to be:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// `tour_capture_wrong` can fail: each break below is planted in a copy of the real workflow, and
/// the check has to name it.
#[test]
fn the_tour_capture_check_names_each_way_of_switching_it_off() {
    const CAPTURE_STEP: &str =
        "      - name: Retake the app tour pictures and check their size and blankness\n";
    const CAPTURE_IF: &str = "        if: ${{ !cancelled() && matrix.shard == 1 }}\n";
    const CAPTURE_DIR: &str = "        working-directory: frontend\n        run: npm run capture:tour\n";
    const SUITE_STEP: &str = "      - name: Run this live shard (the JSON report is the input; the next step is the verdict)\n";
    const MERGE_STEP: &str =
        "      - name: The live red set over all shards is exactly the declared CUTs\n";

    // The capture step's own text, header to its last line, so a plant can move it whole.
    let step_text: String = {
        let start = CI_YML.find(CAPTURE_STEP).expect("the capture step is in ci.yml");
        let mut text = String::new();
        for (n, line) in CI_YML[start..].split_inclusive('\n').enumerate() {
            let indent = line.len() - line.trim_start().len();
            if n > 0 && (line.trim().is_empty() || line.starts_with("      - ") || indent < 8) {
                break;
            }
            text.push_str(line);
        }
        text
    };
    let without = without_step(CI_YML, CAPTURE_STEP);

    type WorkflowCheck = fn(&str) -> Vec<String>;
    let plants: Vec<(&str, String, WorkflowCheck, String)> = vec![
        (
            "the capture step deleted",
            without.clone(),
            tour_capture_wrong,
            format!("the tour capture's run line `{TOUR_CAPTURE}` is in job(s) []"),
        ),
        (
            "the capture step moved to the verdict job",
            without.replace(MERGE_STEP, &format!("{step_text}{MERGE_STEP}")),
            tour_capture_wrong,
            format!("is in job(s) [\"{LIVE_VERDICT_JOB}\"]"),
        ),
        (
            "the capture step put before the suite and its checker",
            without.replace(SUITE_STEP, &format!("{step_text}{SUITE_STEP}")),
            tour_capture_wrong,
            "the tour capture runs before the shard checker".to_string(),
        ),
        (
            "the capture step's condition removed",
            CI_YML.replace(&format!("{CAPTURE_STEP}{CAPTURE_IF}"), CAPTURE_STEP),
            tour_capture_wrong,
            "has the condition(s) []".to_string(),
        ),
        (
            "the condition without the shard",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}        if: ${{{{ !cancelled() }}}}\n"),
            ),
            tour_capture_wrong,
            "has the condition(s) [\"if: ${{ !cancelled() }}\"]".to_string(),
        ),
        (
            "the condition without !cancelled()",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}        if: ${{{{ matrix.shard == 1 }}}}\n"),
            ),
            tour_capture_wrong,
            "has the condition(s) [\"if: ${{ matrix.shard == 1 }}\"]".to_string(),
        ),
        (
            "the condition with `&& false` appended",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}        if: ${{{{ !cancelled() && matrix.shard == 1 && false }}}}\n"),
            ),
            tour_capture_wrong,
            "has the condition(s) [\"if: ${{ !cancelled() && matrix.shard == 1 && false }}\"]".to_string(),
        ),
        (
            "the condition naming shard 10",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}        if: ${{{{ !cancelled() && matrix.shard == 10 }}}}\n"),
            ),
            tour_capture_wrong,
            "has the condition(s) [\"if: ${{ !cancelled() && matrix.shard == 10 }}\"]".to_string(),
        ),
        (
            "the condition negated around the shard",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}        if: ${{{{ !(matrix.shard == 1) || !cancelled() }}}}\n"),
            ),
            tour_capture_wrong,
            "has the condition(s) [\"if: ${{ !(matrix.shard == 1) || !cancelled() }}\"]".to_string(),
        ),
        (
            "a second condition line added",
            CI_YML.replace(
                &format!("{CAPTURE_STEP}{CAPTURE_IF}"),
                &format!("{CAPTURE_STEP}{CAPTURE_IF}        if: false\n"),
            ),
            tour_capture_wrong,
            format!("needs exactly one line, `{TOUR_CAPTURE_IF}`"),
        ),
        (
            "the working directory removed",
            CI_YML.replace(CAPTURE_DIR, "        run: npm run capture:tour\n"),
            tour_capture_wrong,
            format!("has no `{TOUR_CAPTURE_DIR}` line"),
        ),
    ];
    assert_eq!(plants.len(), 11, "eleven ways of switching the tour capture off");

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
        "a planted break in the tour capture went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The job that runs the lesson walk, one leg per shard.
const WALK_JOB: &str = "e2e-walk";
/// The job that merges the walk's shards and grades the merged report.
const WALK_VERDICT_JOB: &str = "e2e-walk-verdict";
/// The walk verdict job's dependency: the classifier, and every leg of the walk.
const WALK_VERDICT_NEEDS: &str = "needs: [changes, e2e-walk]";
/// The number of shards the walk runs as.
const WALK_SHARDS: usize = 3;
/// The developer's walk command, as the whole of its `run:` line. The shard comes from the step's
/// env, so this line is the same in every leg and on a developer's machine.
const WALK_SUITE_RUN: &str = "run: npm run e2e:walk";
/// The walk step's env line that picks this leg's shard.
const WALK_SHARD_ENV: &str = "FABRICO_WALK_SHARD: ${{ matrix.shard }}/3";
/// The merge of every leg's blob into one JSON report, as the whole of its `run:` line.
const WALK_MERGE_RUN: &str = "run: npx playwright merge-reports --config=playwright.walk.config.ts --reporter=json all-blob";
/// The merge step's env line that sends the JSON report where the checker reads it.
const WALK_MERGE_OUTPUT: &str = "PLAYWRIGHT_JSON_OUTPUT_FILE: test-results/walk-report.json";
/// The walk's report check, as the whole of its `run:` line.
const WALK_CHECKER_RUN: &str =
    "run: bash ../scripts/check-walk-report.sh test-results/walk-report.json";
/// The report check's bite proof, as the whole of its `run:` line.
const WALK_BITES_RUN: &str = "run: bash scripts/prove-walk-report-bites.sh";
/// The checker in blobs mode, which the verdict job runs before the merge.
const WALK_BLOBS_NEEDLE: &str = "check-walk-report.sh --blobs";
/// The checker in report mode, which reads the merged report.
const WALK_REPORT_NEEDLE: &str = "check-walk-report.sh test-results";

/// The blob count, as the whole of its `run:` line, built from `WALK_SHARDS`: exactly one blob per
/// shard in the folder the merge reads, or exit 2. It doesn't read the checker's MIN_TESTS, so it
/// catches a lost shard however far the walk outgrows that floor.
fn walk_blobs_run() -> String {
    format!("run: bash ../scripts/check-walk-report.sh --blobs {WALK_SHARDS} all-blob")
}
/// The artifact each walk leg uploads its blob report as.
const WALK_BLOB_ARTIFACT: &str = "name: walk-blob-${{ matrix.shard }}";
/// Where a walk leg's blob report is.
const WALK_BLOB_PATH: &str = "path: frontend/blob-report/";
/// The download of every leg's blob in the verdict job.
const WALK_BLOB_PATTERN: &str = "pattern: walk-blob-*";
/// Where the verdict job puts the blobs, which is the folder the merge reads.
const WALK_BLOBS_DIR: &str = "path: frontend/all-blob";
/// `frontend/package.json`, because `e2e:walk` can swallow an exit code there just as well.
const FRONTEND_PACKAGE_JSON: &str = include_str!("../../../frontend/package.json");

/// A workflow line with a step's leading `- ` taken off, so `- run: x` reads the same as `run: x`.
fn step_key(line: &str) -> &str {
    line.strip_prefix("- ").unwrap_or(line)
}

/// The one step in `job` holding a line equal to `key` (after `step_key`), and the line's index;
/// or a message naming how many there were.
fn one_step_with<'a>(job: &[&'a str], key: &str, job_id: &str) -> Result<(usize, Vec<&'a str>), String> {
    let found: Vec<usize> = job
        .iter()
        .enumerate()
        .filter(|(_, l)| step_key(l) == key)
        .map(|(i, _)| i)
        .collect();
    match found.as_slice() {
        [at] => Ok((*at, step_around(job, *at))),
        _ => Err(format!(
            "`{key}` appears {} time(s) in job `{job_id}`, expected 1.",
            found.len()
        )),
    }
}

/// Everything wrong with how `yml` and `package_json` wire the walk's verdict. Empty means right.
fn walk_gate_wrong(yml: &str, package_json: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let blobs_run = walk_blobs_run();
    let runs: [(&[&str], &str, &str); 4] = [
        (&[WALK_SUITE_RUN], "npm run e2e:walk", WALK_JOB),
        (&[WALK_BITES_RUN], "scripts/prove-walk-report-bites.sh", WALK_VERDICT_JOB),
        (&[WALK_MERGE_RUN], "merge-reports", WALK_VERDICT_JOB),
        (
            &[blobs_run.as_str(), WALK_CHECKER_RUN],
            "scripts/check-walk-report.sh",
            WALK_VERDICT_JOB,
        ),
    ];

    // Each one exactly once, in its own job, as the whole of its line; the checker twice, the blob
    // count first. A whole-line match is what refuses `|| true`, `; true` and a pipe, each of which
    // turns the step's failure into a pass.
    for (expected, needle, job) in runs {
        let found: Vec<(&str, &str)> = blocks
            .iter()
            .flat_map(|(id, lines)| lines.iter().map(move |line| (*id, step_key(line))))
            .filter(|(_, line)| line.starts_with("run:") && line.contains(needle))
            .collect();
        let want: Vec<(&str, &str)> = expected.iter().map(|line| (job, *line)).collect();
        if found != want {
            wrong.push(format!(
                "the `run:` lines invoking `{needle}` are {found:?}, expected exactly {want:?}. \
                 With anything else on that line, or the step moved or gone, the walk can go \
                 green without its verdict."
            ));
        }
    }

    let job_lines = |job: &str| -> Option<Vec<&str>> {
        blocks
            .iter()
            .find(|(id, _)| *id == job)
            .map(|(_, lines)| lines.clone())
    };

    match job_lines(WALK_JOB) {
        None => wrong.push(format!("there is no job `{WALK_JOB}` under `jobs:`.")),
        Some(job) => {
            // One leg per shard, and a red leg cancels none of the others.
            let shard_list = format!(
                "shard: [{}]",
                (1..=WALK_SHARDS)
                    .map(|i| i.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            for key in ["fail-fast: false", shard_list.as_str()] {
                let found = job.iter().filter(|l| **l == key).count();
                if found != 1 {
                    wrong.push(format!(
                        "job `{WALK_JOB}` carries `{key}` {found} time(s), expected 1. The walk \
                         is split into {WALK_SHARDS} shards, its env line names that count, and a \
                         leg cancelled by another's failure leaves no blob."
                    ));
                }
            }

            // The walk step picks its shard from the matrix. Without the env line every leg runs
            // the whole walk and writes no blob.
            let suite_step = step_of(&job, "npm run e2e:walk");
            if !suite_step.is_empty() && !suite_step.contains(&WALK_SHARD_ENV) {
                wrong.push(format!(
                    "the walk step in job `{WALK_JOB}` has no `{WALK_SHARD_ENV}` line, so each \
                     leg would run the whole walk and leave no blob for the verdict job."
                ));
            }

            // Each leg uploads its blob, red or not, and fails when there is none.
            match one_step_with(&job, WALK_BLOB_ARTIFACT, WALK_JOB) {
                Err(message) => wrong.push(message),
                Ok((at, step)) => {
                    for key in [
                        "uses: actions/upload-artifact@v4",
                        "if: ${{ !cancelled() }}",
                        WALK_BLOB_PATH,
                        "if-no-files-found: error",
                    ] {
                        if !step.iter().any(|l| step_key(l) == key) {
                            wrong.push(format!(
                                "the step carrying `{WALK_BLOB_ARTIFACT}` in job `{WALK_JOB}` has \
                                 no `{key}` line. Without it a red shard's blob never reaches the \
                                 verdict job, or a missing blob goes unnoticed."
                            ));
                        }
                    }
                    if let Some(s) = job.iter().position(|l| step_key(l) == WALK_SUITE_RUN)
                        && s > at
                    {
                        wrong.push(format!(
                            "job `{WALK_JOB}` uploads `{WALK_BLOB_ARTIFACT}` before the walk \
                             writes it."
                        ));
                    }
                }
            }
        }
    }

    match job_lines(WALK_VERDICT_JOB) {
        None => wrong.push(format!("there is no job `{WALK_VERDICT_JOB}` under `jobs:`.")),
        Some(job) => {
            // The proof before the merge, and the check the run line straight after the merge.
            let verdict_runs: Vec<&str> = job
                .iter()
                .map(|line| step_key(line))
                .filter(|line| line.starts_with("run:"))
                .collect();
            let at = |expected: &str| verdict_runs.iter().position(|line| *line == expected);
            if let (Some(b), Some(k), Some(m), Some(c)) = (
                at(WALK_BITES_RUN),
                at(&blobs_run),
                at(WALK_MERGE_RUN),
                at(WALK_CHECKER_RUN),
            ) && !(b < k && k < m && m + 1 == c)
            {
                wrong.push(format!(
                    "the bite proof, the blob count, the merge and the report check are `run:` \
                     lines {b}, {k}, {m} and {c} of job `{WALK_VERDICT_JOB}`. The proof and the \
                     blob count must come before the merge, in that order, and the check must be \
                     the line straight after it."
                ));
            }

            // Every leg's blob is downloaded, side by side into the folder the merge reads,
            // before the merge.
            match one_step_with(&job, WALK_BLOB_PATTERN, WALK_VERDICT_JOB) {
                Err(message) => wrong.push(message),
                Ok((at, step)) => {
                    for key in [
                        "uses: actions/download-artifact@v4",
                        "merge-multiple: true",
                        WALK_BLOBS_DIR,
                    ] {
                        if !step.iter().any(|l| step_key(l) == key) {
                            wrong.push(format!(
                                "the step carrying `{WALK_BLOB_PATTERN}` in job \
                                 `{WALK_VERDICT_JOB}` has no `{key}` line, so the merge would \
                                 not find the blobs."
                            ));
                        }
                    }
                    if let Some(m) = job.iter().position(|l| step_key(l) == WALK_MERGE_RUN)
                        && m < at
                    {
                        wrong.push(format!(
                            "job `{WALK_VERDICT_JOB}` runs the merge before it takes the blobs."
                        ));
                    }
                    if let Some(k) = job.iter().position(|l| step_key(l) == blobs_run)
                        && k < at
                    {
                        wrong.push(format!(
                            "job `{WALK_VERDICT_JOB}` counts the blobs before it takes them, so \
                             the count reads an empty folder."
                        ));
                    }
                }
            }

            // The merge writes the JSON report where the checker reads it.
            let merge_step = step_of(&job, "merge-reports");
            if !merge_step.is_empty() && !merge_step.contains(&WALK_MERGE_OUTPUT) {
                wrong.push(format!(
                    "the merge step in job `{WALK_VERDICT_JOB}` has no `{WALK_MERGE_OUTPUT}` \
                     line, so the checker would read no merged report."
                ));
            }
        }
    }

    // Neither job swallows a failure, and no walk, proof, merge or check can be skipped.
    wrong.extend(step_guards_wrong(yml, WALK_JOB, &["npm run e2e:walk"]));
    wrong.extend(step_guards_wrong(
        yml,
        WALK_VERDICT_JOB,
        &[
            "scripts/prove-walk-report-bites.sh",
            WALK_BLOBS_NEEDLE,
            "merge-reports",
            WALK_REPORT_NEEDLE,
        ],
    ));

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

/// The walk's verdict is its exit code and its merged report, and nothing can switch either off.
///
/// # Why
///
/// `ci.yml` says so in a comment, and a comment can't fail. Changing the run line to
/// `npm run e2e:walk || true`, adding `continue-on-error: true` or deleting a step would each leave
/// the walk green forever, so those facts are pinned here, where `cargo test` runs them.
///
/// # Why the rule pins two jobs
///
/// The walk runs as `WALK_SHARDS` shards on separate runners, one leg of `WALK_JOB` each, because
/// one worker against one host made it take up to 43 minutes. One leg's report holds a third of
/// the walk and falls under the checker's floor, so the legs upload blob reports and
/// `WALK_VERDICT_JOB` merges them and grades the result. This rule used to pin the proof, the walk
/// and the checker in one job; it now pins the walk and its shard env line in `WALK_JOB`, the blob
/// upload between the jobs, and the proof, the download, the blob count, the merge and the checker
/// in `WALK_VERDICT_JOB`, with the guards on both. The blob count is the check that catches a lost
/// shard without relying on the checker's MIN_TESTS keeping pace with the walk. The verdict job's `needs:` line and its docs-only
/// gate are pinned by `job_classes_wrong`.
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

/// `walk_gate_wrong` and `job_classes_wrong` can fail: each of these breaks is planted in a copy of
/// the real files, and the check has to name it.
#[test]
fn the_walk_gate_check_names_each_way_of_switching_it_off() {
    const SUITE_STEP: &str = "      - name: Run the lesson walk\n";
    const CHECKER_STEP: &str = "      - name: Every walk test ran and passed\n";
    const MERGE_STEP: &str = "      - name: Merge the walk shards\n";
    const UPLOAD_STEP: &str = "      - name: Keep this shard's blob report for the verdict job\n";
    const BLOBS_STEP: &str = "      - name: Every walk shard's blob arrived\n";
    const DOWNLOAD_STEP: &str = "      - name: Take every shard's blob report\n";
    const WALK_HEADER: &str = "    name: lesson walk (real headless host)\n";
    const VERDICT_HEADER: &str = "    name: lesson walk verdict (all shards)\n";
    const MATRIX: &str = "      fail-fast: false\n      matrix:\n        shard: [1, 2, 3]\n";
    let suite_line = format!("        {WALK_SUITE_RUN}\n");
    let checker_line = format!("        {WALK_CHECKER_RUN}\n");
    let bites_line = format!("        {WALK_BITES_RUN}\n");
    let shard_env_line = format!("          {WALK_SHARD_ENV}\n");
    let blobs_line = format!("        {}\n", walk_blobs_run());
    let blobs_step = format!("{BLOBS_STEP}        working-directory: frontend\n{blobs_line}");

    // (what, the planted copy, which check reads it, what it must name)
    type WorkflowCheck = fn(&str) -> Vec<String>;
    let walk: WorkflowCheck = |yml| walk_gate_wrong(yml, FRONTEND_PACKAGE_JSON);
    let plants: Vec<(&str, String, WorkflowCheck, String)> = vec![
        (
            "the walk's exit code swallowed",
            CI_YML.replace(&suite_line, &suite_line.replace("e2e:walk", "e2e:walk || true")),
            walk,
            "npm run e2e:walk".to_string(),
        ),
        (
            "the walk step deleted",
            CI_YML.replace(&suite_line, ""),
            walk,
            "npm run e2e:walk".to_string(),
        ),
        (
            "the walk as a block",
            CI_YML.replace(&suite_line, "        run: |\n          npm run e2e:walk\n"),
            walk,
            "npm run e2e:walk".to_string(),
        ),
        (
            "the report check's exit code swallowed",
            CI_YML.replace(&checker_line, &checker_line.replace(".json", ".json || true")),
            walk,
            "scripts/check-walk-report.sh".to_string(),
        ),
        (
            "the report check deleted",
            CI_YML.replace(&checker_line, ""),
            walk,
            "scripts/check-walk-report.sh".to_string(),
        ),
        (
            "the bite proof deleted",
            CI_YML.replace(&bites_line, ""),
            walk,
            "scripts/prove-walk-report-bites.sh".to_string(),
        ),
        (
            "continue-on-error on the walk job",
            CI_YML.replace(WALK_HEADER, &format!("{WALK_HEADER}    continue-on-error: true\n")),
            walk,
            format!("job `{WALK_JOB}` carries `continue-on-error: true`"),
        ),
        (
            "continue-on-error on the verdict job",
            CI_YML.replace(
                VERDICT_HEADER,
                &format!("{VERDICT_HEADER}    continue-on-error: true\n"),
            ),
            walk,
            format!("job `{WALK_VERDICT_JOB}` carries `continue-on-error: true`"),
        ),
        (
            "continue-on-error as a step's first key",
            CI_YML.replace(
                SUITE_STEP,
                "      - continue-on-error: true\n        name: Run the lesson walk\n",
            ),
            walk,
            format!("job `{WALK_JOB}` carries `continue-on-error: true`"),
        ),
        (
            "a condition on the report check",
            CI_YML.replace(CHECKER_STEP, &format!("{CHECKER_STEP}        if: false\n")),
            walk,
            format!("in job `{WALK_VERDICT_JOB}` carries `if: false`"),
        ),
        (
            "a step between the merge and the report check",
            CI_YML.replace(CHECKER_STEP, &format!("      - run: echo between\n{CHECKER_STEP}")),
            walk,
            "the line straight after it".to_string(),
        ),
        (
            "the shard env line removed",
            CI_YML.replace(&shard_env_line, ""),
            walk,
            format!("has no `{WALK_SHARD_ENV}` line"),
        ),
        (
            "the blob upload's `if: ${{ !cancelled() }}` removed",
            CI_YML.replace(
                &format!("{UPLOAD_STEP}        if: ${{{{ !cancelled() }}}}\n"),
                UPLOAD_STEP,
            ),
            walk,
            "has no `if: ${{ !cancelled() }}` line".to_string(),
        ),
        (
            "the walk matrix grown to four shards",
            CI_YML.replace(MATRIX, &MATRIX.replace("[1, 2, 3]", "[1, 2, 3, 4]")),
            walk,
            format!("job `{WALK_JOB}` carries `shard: [1, 2, 3]` 0 time(s)"),
        ),
        (
            "the merge step deleted",
            without_step(CI_YML, MERGE_STEP),
            walk,
            "the `run:` lines invoking `merge-reports` are []".to_string(),
        ),
        (
            "the verdict job's needs line set to `needs: changes`",
            CI_YML.replace(
                &format!("    {WALK_VERDICT_NEEDS}\n"),
                &format!("    {HEAVY_NEEDS}\n"),
            ),
            job_classes_wrong,
            format!("heavy job `{WALK_VERDICT_JOB}` is missing `{WALK_VERDICT_NEEDS}`"),
        ),
        (
            "the blob count deleted",
            without_step(CI_YML, BLOBS_STEP),
            walk,
            "the `run:` lines invoking `scripts/check-walk-report.sh` are".to_string(),
        ),
        (
            "the blob count lowered to two shards",
            CI_YML.replace(&blobs_line, &blobs_line.replace("--blobs 3", "--blobs 2")),
            walk,
            "the `run:` lines invoking `scripts/check-walk-report.sh` are".to_string(),
        ),
        (
            "the blob count's exit code swallowed",
            CI_YML.replace(&blobs_line, &blobs_line.replace("all-blob", "all-blob || true")),
            walk,
            "the `run:` lines invoking `scripts/check-walk-report.sh` are".to_string(),
        ),
        (
            "a condition on the blob count",
            CI_YML.replace(BLOBS_STEP, &format!("{BLOBS_STEP}        if: false\n")),
            walk,
            format!("the step that runs `{WALK_BLOBS_NEEDLE}` in job `{WALK_VERDICT_JOB}`"),
        ),
        (
            "the blob count moved before the download",
            CI_YML
                .replace(&format!("{blobs_step}\n"), "")
                .replace(DOWNLOAD_STEP, &format!("{blobs_step}\n{DOWNLOAD_STEP}")),
            walk,
            "counts the blobs before it takes them".to_string(),
        ),
    ];
    assert_eq!(plants.len(), 21, "twenty-one ways of switching the walk verdict off in ci.yml");

    let mut missed: Vec<String> = Vec::new();
    for (what, yml, check, must_name) in &plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = check(yml).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
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
        let named = walk_gate_wrong(CI_YML, &package_json).join("\n");
        if !named.contains("the `e2e:walk` script is") {
            missed.push(format!("{what}: expected the script named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the walk gate went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The board capture set's job.
const CAPTURE_JOB: &str = "e2e-capture";
/// The capture set, as the whole of its `run:` line.
const CAPTURE_SUITE_RUN: &str = "run: npm run e2e:capture";
/// The capture report check's bite proof, as the whole of its `run:` line.
const CAPTURE_BITES_RUN: &str = "run: bash scripts/prove-capture-report-bites.sh";
/// The capture report check, as the whole of its `run:` line.
const CAPTURE_CHECKER_RUN: &str =
    "run: bash scripts/check-capture-report.sh frontend/test-results/capture-report.json";
/// The one condition the proof and the check may carry: run after a red suite too, so its report is
/// still read. Any other condition could skip them while the job stays green.
const CAPTURE_AFTER_SUITE_IF: &str = "if: ${{ !cancelled() }}";

/// Everything wrong with how `yml` and `package_json` wire the board capture set's verdict. Empty
/// means right.
fn capture_gate_wrong(yml: &str, package_json: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);

    // Each one exactly once in the file, in the capture job, as the whole of its line. A whole-line
    // match is what refuses `|| true`, `; true` and a pipe, each of which turns a red step green.
    for (expected, needle) in [
        (CAPTURE_SUITE_RUN, "npm run e2e:capture"),
        (CAPTURE_BITES_RUN, "scripts/prove-capture-report-bites.sh"),
        (CAPTURE_CHECKER_RUN, "scripts/check-capture-report.sh"),
    ] {
        let found: Vec<(&str, &str)> = blocks
            .iter()
            .flat_map(|(id, lines)| lines.iter().map(move |line| (*id, step_key(line))))
            .filter(|(_, line)| line.starts_with("run:") && line.contains(needle))
            .collect();
        let want = vec![(CAPTURE_JOB, expected)];
        if found != want {
            wrong.push(format!(
                "the `run:` lines invoking `{needle}` are {found:?}, expected exactly {want:?}. \
                 With anything else on that line, or the step moved or gone, the capture set can \
                 go green without its verdict."
            ));
        }
    }

    match blocks.iter().find(|(id, _)| *id == CAPTURE_JOB) {
        None => wrong.push(format!("there is no job `{CAPTURE_JOB}` under `jobs:`.")),
        Some((_, job)) => {
            // The suite, then the proof, then the check: the checker is seen to bite before it
            // reads the report, and the report exists before it is read.
            let runs: Vec<&str> = job
                .iter()
                .map(|line| step_key(line))
                .filter(|line| line.starts_with("run:"))
                .collect();
            let at = |expected: &str| runs.iter().position(|line| *line == expected);
            if let (Some(s), Some(b), Some(c)) = (
                at(CAPTURE_SUITE_RUN),
                at(CAPTURE_BITES_RUN),
                at(CAPTURE_CHECKER_RUN),
            ) && !(s < b && b < c)
            {
                wrong.push(format!(
                    "the capture set, the bite proof and the report check are `run:` lines {s}, \
                     {b} and {c} of job `{CAPTURE_JOB}`. The bite proof must come after the suite \
                     and before the check."
                ));
            }

            // The proof and the check may carry only the after-the-suite condition.
            for needle in [
                "scripts/prove-capture-report-bites.sh",
                "scripts/check-capture-report.sh",
            ] {
                for line in step_of(job, needle)
                    .iter()
                    .map(|line| step_key(line))
                    .filter(|line| line.starts_with("if:") && *line != CAPTURE_AFTER_SUITE_IF)
                {
                    wrong.push(format!(
                        "the step that runs `{needle}` in job `{CAPTURE_JOB}` carries `{line}`. \
                         Its only allowed condition is `{CAPTURE_AFTER_SUITE_IF}`; any other can \
                         skip it while the job stays green."
                    ));
                }
            }
        }
    }

    // No `continue-on-error` anywhere in the job, and no condition on the suite step.
    wrong.extend(step_guards_wrong(
        yml,
        CAPTURE_JOB,
        &["npm run e2e:capture"],
    ));

    // The npm script deletes the old report first, so a failed build leaves nothing to read, ends in
    // the unfiltered capture set, and can't swallow an exit code on the way.
    let script = package_json
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("\"e2e:capture\": \""))
        .and_then(|rest| rest.trim_end_matches(',').strip_suffix('"'));
    match script {
        None => wrong.push("frontend/package.json has no `e2e:capture` script.".to_string()),
        Some(script) => {
            if !script.starts_with("rm -f test-results/capture-report.json && ")
                || !script.ends_with("&& playwright test --config=playwright.capture.config.ts")
                || script.contains("||")
                || script.contains(';')
            {
                wrong.push(format!(
                    "the `e2e:capture` script is `{script}`. It must delete the old report first, \
                     end in the unfiltered `playwright test --config=playwright.capture.config.ts`, \
                     and hold no `||` or `;`, or the report check can read a stale or partial run."
                ));
            }
        }
    }
    wrong
}

/// The board capture set's verdict is its report, read by a checker that is seen to bite first, and
/// nothing can switch either off.
///
/// # Why
///
/// Playwright exits 0 on a skipped test and on a `test.fail()` that failed, so `ci.yml` runs
/// `scripts/check-capture-report.sh` on the JSON report after the suite, with its bite proof before
/// it. A comment can't fail, and `|| true` on a run line, a reordered proof or a step condition would
/// each leave the job green without that verdict, so those facts are pinned here. The job's `needs:`
/// line and docs-only gate are pinned by `job_classes_wrong`.
#[test]
fn the_capture_gate_verdict_cannot_be_switched_off() {
    let wrong = capture_gate_wrong(CI_YML, FRONTEND_PACKAGE_JSON);
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the capture set's verdict are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions are what keep the capture gate on.",
        wrong.len(),
        wrong.join("\n\n")
    );
}

/// `capture_gate_wrong` can fail: each of these breaks is planted in a copy of the real files, and
/// the check has to name it.
#[test]
fn the_capture_gate_check_names_each_way_of_switching_it_off() {
    const BITES_STEP: &str = "      - name: Capture report checker bites\n";
    const CHECKER_STEP: &str = "      - name: Every capture test ran and passed or is declared\n";
    const CAPTURE_HEADER: &str = "    name: board capture set (real headless host)\n";
    let suite_line = format!("        {CAPTURE_SUITE_RUN}\n");
    let bites_line = format!("        {CAPTURE_BITES_RUN}\n");
    let checker_line = format!("        {CAPTURE_CHECKER_RUN}\n");
    let after_suite = format!("        {CAPTURE_AFTER_SUITE_IF}\n");
    let bites_step = format!("{BITES_STEP}{after_suite}{bites_line}");
    let checker_step = format!("{CHECKER_STEP}{after_suite}{checker_line}");
    assert_eq!(
        CI_YML.matches(&bites_step).count(),
        1,
        "the bite proof step reads as planted"
    );
    assert_eq!(
        CI_YML.matches(&checker_step).count(),
        1,
        "the check step reads as planted"
    );

    let plants: Vec<(&str, String, String)> = vec![
        (
            "the suite's exit code swallowed",
            CI_YML.replace(
                &suite_line,
                &suite_line.replace("e2e:capture", "e2e:capture || true"),
            ),
            "npm run e2e:capture".to_string(),
        ),
        (
            "the bite proof's exit code swallowed",
            CI_YML.replace(&bites_line, &bites_line.replace(".sh", ".sh || true")),
            "scripts/prove-capture-report-bites.sh".to_string(),
        ),
        (
            "the report check's exit code swallowed",
            CI_YML.replace(
                &checker_line,
                &checker_line.replace(".json", ".json || true"),
            ),
            "scripts/check-capture-report.sh".to_string(),
        ),
        (
            "the report check deleted",
            without_step(CI_YML, CHECKER_STEP),
            "scripts/check-capture-report.sh".to_string(),
        ),
        (
            "the bite proof and the report check swapped",
            CI_YML.replace(
                &format!("{bites_step}\n{checker_step}"),
                &format!("{checker_step}\n{bites_step}"),
            ),
            "The bite proof must come after the suite and before the check".to_string(),
        ),
        (
            "a condition on the report check",
            CI_YML.replace(
                &checker_step,
                &checker_step.replace("!cancelled()", "false"),
            ),
            format!("in job `{CAPTURE_JOB}` carries `if: ${{{{ false }}}}`"),
        ),
        (
            "continue-on-error on the capture job",
            CI_YML.replace(
                CAPTURE_HEADER,
                &format!("{CAPTURE_HEADER}    continue-on-error: true\n"),
            ),
            format!("job `{CAPTURE_JOB}` carries `continue-on-error: true`"),
        ),
    ];
    assert_eq!(
        plants.len(),
        7,
        "seven ways of switching the capture verdict off in ci.yml"
    );

    let mut missed: Vec<String> = Vec::new();
    for (what, yml, must_name) in &plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = capture_gate_wrong(yml, FRONTEND_PACKAGE_JSON).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!(
                "{what}: expected `{must_name}` named, got: {named:?}"
            ));
        }
    }

    for (what, from, to) in [
        (
            "the script's exit code swallowed",
            "capture.config.ts\"",
            "capture.config.ts || true\"",
        ),
        (
            "a filtered capture set",
            "capture.config.ts\"",
            "capture.config.ts --project=capture\"",
        ),
        (
            "the old report kept",
            "rm -f test-results/capture-report.json && ",
            "",
        ),
    ] {
        let package_json = FRONTEND_PACKAGE_JSON.replace(from, to);
        assert_ne!(
            package_json, FRONTEND_PACKAGE_JSON,
            "{what}: the plant landed"
        );
        let named = capture_gate_wrong(CI_YML, &package_json).join("\n");
        if !named.contains("the `e2e:capture` script is") {
            missed.push(format!("{what}: expected the script named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the capture gate went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The mock e2e suite's Playwright config, the one `npm run test:e2e` runs in the `e2e` job.
const MOCK_CONFIG: &str = include_str!("../../../frontend/playwright.config.ts");
/// The warm-up the mock config runs before any test. Embedded so that moving or deleting it is a
/// build failure here.
const MOCK_WARMUP: &str = include_str!("../../../frontend/e2e/support/warmVite.ts");
/// The config line that runs the warm-up, whole.
const MOCK_GLOBAL_SETUP: &str = "globalSetup: './e2e/support/warmVite.ts',";
/// What the warm-up waits for: the palette's Source button, the element the specs' own
/// `waitForChrome` waits for, so the app has rendered and Vite has compiled it.
const MOCK_WARMUP_WAIT: &str = "await page.getByRole('button', { name: /Source/ }).waitFor(";

/// Everything wrong with how the mock suite's Playwright config is set up. Empty means right.
fn mock_config_wrong(config: &str, warmup: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let code: Vec<&str> = config
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//"))
        .collect();

    // The warm-up runs before the first test. A second `globalSetup` key would override the first,
    // so every line that sets one has to be this line, once.
    let setups: Vec<&str> = code
        .iter()
        .copied()
        .filter(|line| line.starts_with("globalSetup"))
        .collect();
    if setups != [MOCK_GLOBAL_SETUP] {
        wrong.push(format!(
            "frontend/playwright.config.ts sets globalSetup with {setups:?}, expected exactly \
             [\"{MOCK_GLOBAL_SETUP}\"]. Without the warm-up the first test on each shard pays for \
             Vite's compile inside its own budget, with no retry behind it."
        ));
    }
    if !warmup.lines().any(|line| line.trim_start().starts_with(MOCK_WARMUP_WAIT)) {
        wrong.push(format!(
            "frontend/e2e/support/warmVite.ts has no line starting `{MOCK_WARMUP_WAIT}`, so the \
             warm-up no longer waits for the app to render and Vite may still be compiling when \
             the first test starts."
        ));
    }
    wrong
}

/// The mock suite loads the app once before its first test.
///
/// # Why
///
/// The mock suite runs as 4 shards with no retry, and each shard boots its own Vite. The
/// webServer probe is answered by index.html before Vite has compiled anything, so without a
/// warm-up the first tests of each shard paid for the compile inside their own 30 s budget. On CI
/// they ran 1.2 to 2.5 times slower than the same tests later in a run, and one timed out. The
/// warm-up is one `globalSetup` line and one file, and either can go with every test still green.
#[test]
fn the_mock_suite_warms_vite_before_its_first_test() {
    let wrong = mock_config_wrong(MOCK_CONFIG, MOCK_WARMUP);
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the mock suite's config are wrong:\n\n{}\n\n\
         Update the CONFIG to match this test.",
        wrong.len(),
        wrong.join("\n\n")
    );
}

/// `mock_config_wrong` can fail: each break below is planted in a copy of the real files, and the
/// check has to name it.
#[test]
fn the_mock_config_check_names_each_way_of_dropping_the_warm_up() {
    let setup_line = format!("  {MOCK_GLOBAL_SETUP}\n");
    // (what, planted config, planted warm-up, what the check must name)
    let plants: Vec<(&str, String, String, &str)> = vec![
        (
            "the globalSetup line deleted",
            MOCK_CONFIG.replace(&setup_line, ""),
            MOCK_WARMUP.to_string(),
            "sets globalSetup with []",
        ),
        (
            "the globalSetup line commented out",
            MOCK_CONFIG.replace(&setup_line, &format!("  // {MOCK_GLOBAL_SETUP}\n")),
            MOCK_WARMUP.to_string(),
            "sets globalSetup with []",
        ),
        (
            "a second globalSetup line that overrides the first",
            MOCK_CONFIG.replace(
                &setup_line,
                &format!("{setup_line}  globalSetup: './e2e/support/other.ts',\n"),
            ),
            MOCK_WARMUP.to_string(),
            "sets globalSetup with [",
        ),
        (
            "the warm-up's wait for the app removed",
            MOCK_CONFIG.to_string(),
            MOCK_WARMUP.replace(MOCK_WARMUP_WAIT, "await page.waitForTimeout(0); ("),
            "has no line starting",
        ),
    ];
    assert_eq!(plants.len(), 4, "four ways of dropping the mock suite's warm-up");

    let mut missed: Vec<String> = Vec::new();
    for (what, config, warmup, must_name) in &plants {
        assert!(
            config != MOCK_CONFIG || warmup != MOCK_WARMUP,
            "{what}: the plant landed"
        );
        let named = mock_config_wrong(config, warmup).join("\n");
        if !named.contains(must_name) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the mock config went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The job that runs the mock e2e suite, one leg per shard.
const MOCK_JOB: &str = "e2e";
/// The number of shards the mock suite runs as.
const MOCK_SHARDS: usize = 4;
/// The mock config's retry count, whole: a test that fails once fails its leg.
const MOCK_RETRIES: &str = "retries: 0,";
/// The artifact each mock leg uploads its JSON report as, by its `name:` line.
const MOCK_REPORT_ARTIFACT: &str = "name: mock-report-${{ matrix.shard }}";
/// Where the leg's JSON report is, by the upload step's `path:` line. It is the `outputFile` of
/// the json reporter in `frontend/playwright.config.ts`, from the repository root.
const MOCK_REPORT_PATH: &str = "path: frontend/test-results/mock-report.json";

/// The mock suite's run line, whole, built from `MOCK_SHARDS`.
fn mock_run_line() -> String {
    let shard = "${{ matrix.shard }}";
    format!("run: npm run test:e2e -- --shard={shard}/{MOCK_SHARDS}")
}

/// Everything wrong with how `yml` runs the mock suite's shards. Empty means right.
fn mock_gate_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);
    let run_line = mock_run_line();

    // The suite once in the whole file, in its own job, as the whole of its line. The `/4` is all
    // that makes 4 legs cover the suite: with `/5` a fifth of it runs nowhere and every leg is green.
    let found: Vec<(&str, &str)> = blocks
        .iter()
        .flat_map(|(id, lines)| lines.iter().map(move |line| (*id, step_key(line))))
        .filter(|(_, line)| line.starts_with("run:") && line.contains("test:e2e"))
        .collect();
    if found != [(MOCK_JOB, run_line.as_str())] {
        wrong.push(format!(
            "the `run:` lines invoking `test:e2e` are {found:?}, expected exactly \
             [(\"{MOCK_JOB}\", \"{run_line}\")]. The mock job has no report checker, so its exit \
             code and this line are the whole verdict."
        ));
    }

    match blocks.iter().find(|(id, _)| *id == MOCK_JOB) {
        None => wrong.push(format!("there is no job `{MOCK_JOB}` under `jobs:`.")),
        Some((_, job)) => {
            // One leg per shard, and a red leg cancels none of the others.
            let shard_list = format!(
                "shard: [{}]",
                (1..=MOCK_SHARDS)
                    .map(|i| i.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            for key in ["fail-fast: false", shard_list.as_str()] {
                let n = job.iter().filter(|l| **l == key).count();
                if n != 1 {
                    wrong.push(format!(
                        "job `{MOCK_JOB}` carries `{key}` {n} time(s), expected 1. The suite runs \
                         as {MOCK_SHARDS} shards, its run line names that count, and a dropped \
                         leg leaves its share of the tests unrun with every other leg green."
                    ));
                }
            }
        }
    }

    wrong.extend(step_guards_wrong(yml, MOCK_JOB, &["npm run test:e2e"]));
    wrong
}

/// Everything wrong with how `yml` uploads each mock leg's JSON report. Empty means right.
///
/// In job `MOCK_JOB` the artifact line, the path line and `if-no-files-found: error` each appear
/// once, all in one step that uses `actions/upload-artifact@v4` under `if: ${{ !cancelled() }}`.
/// The guard uploads a red leg's report too, and the missing-file rule turns a leg that wrote no
/// report red, so the reports that reach the verdict cover every leg that ran.
fn mock_report_upload_wrong(yml: &str) -> Vec<String> {
    let blocks = job_blocks_in(yml);
    let Some((_, job)) = blocks.iter().find(|(id, _)| *id == MOCK_JOB) else {
        return vec![format!("there is no job `{MOCK_JOB}` under `jobs:`.")];
    };
    let mut wrong: Vec<String> = Vec::new();
    for key in [MOCK_REPORT_PATH, "if-no-files-found: error"] {
        let n = job.iter().filter(|l| step_key(l) == key).count();
        if n != 1 {
            wrong.push(format!(
                "job `{MOCK_JOB}` carries `{key}` {n} time(s), expected 1. Each leg uploads one \
                 report, from the file the json reporter writes, and fails when it is missing."
            ));
        }
    }
    match one_step_with(job, MOCK_REPORT_ARTIFACT, MOCK_JOB) {
        Err(message) => wrong.push(format!(
            "{message} Without it the leg's per-test durations never leave the runner."
        )),
        Ok((_, step)) => {
            for key in [
                "uses: actions/upload-artifact@v4",
                "if: ${{ !cancelled() }}",
                MOCK_REPORT_PATH,
                "if-no-files-found: error",
            ] {
                if !step.iter().any(|l| step_key(l) == key) {
                    wrong.push(format!(
                        "the step carrying `{MOCK_REPORT_ARTIFACT}` in job `{MOCK_JOB}` has no \
                         `{key}` line. Without it a red leg's report is never uploaded, or a leg \
                         with no report stays green."
                    ));
                }
            }
        }
    }
    wrong
}

/// Everything wrong with the mock config's retry count. Empty means right.
fn mock_retries_wrong(config: &str) -> Vec<String> {
    let retries: Vec<&str> = config
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("//") && line.starts_with("retries"))
        .collect();
    if retries == [MOCK_RETRIES] {
        Vec::new()
    } else {
        vec![format!(
            "frontend/playwright.config.ts sets retries with {retries:?}, expected exactly \
             [\"{MOCK_RETRIES}\"]. A retry passes a test that failed once as flaky, and no mock \
             gate reads the flaky line, so the leg stays green."
        )]
    }
}

/// The mock suite runs every test once, across exactly its 4 shards, with no retry.
///
/// # Why
///
/// The mock job has no report checker and no test floor, so its exit code is its whole verdict.
/// The shard list and the `/4` in its run line are all that make the 4 legs cover the suite: with
/// `shard: [1, 2, 3]` or `/5`, part of the 606 tests runs nowhere and every leg is green. And
/// `retries: 0` in `playwright.config.ts` is what makes a test that fails once fail its leg. Each
/// of these is one edit away, so they're pinned here, where `cargo test` runs them.
///
/// Each leg also uploads its JSON report as `mock-report-<i>`, red or green, and the upload fails
/// when the report is missing. The report holds each test's duration for the mock verdict; it
/// grades nothing, and the exit code stays the suite's verdict.
#[test]
fn the_mock_suite_runs_every_test_once_with_no_retry() {
    let mut wrong = mock_gate_wrong(CI_YML);
    wrong.extend(mock_report_upload_wrong(CI_YML));
    wrong.extend(mock_retries_wrong(MOCK_CONFIG));
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the mock suite are wrong:\n\n{}\n\n\
         Update the WORKFLOW or the CONFIG to match this test.",
        wrong.len(),
        wrong.join("\n\n")
    );
}

/// `mock_gate_wrong`, `mock_report_upload_wrong` and `mock_retries_wrong` can fail: each break
/// below is planted in a copy of the real files, and the check has to name it.
#[test]
fn the_mock_gate_check_names_each_way_of_losing_tests() {
    const MOCK_HEADER: &str = "    name: frontend e2e (Playwright + axe)\n";
    const MOCK_STEP: &str = "      - name: Run e2e (Playwright + axe)\n";
    const MATRIX: &str = "      fail-fast: false\n      matrix:\n        shard: [1, 2, 3, 4]\n";
    let run_line = format!("        {}\n", mock_run_line());

    // (what, the planted workflow, what the check must name)
    let yml_plants: Vec<(&str, String, String)> = vec![
        (
            "the matrix cut to three shards",
            CI_YML.replace(MATRIX, &MATRIX.replace("[1, 2, 3, 4]", "[1, 2, 3]")),
            format!("job `{MOCK_JOB}` carries `shard: [1, 2, 3, 4]` 0 time(s)"),
        ),
        (
            "the run line's denominator set to 5",
            CI_YML.replace(&run_line, &run_line.replace("}}/4", "}}/5")),
            "the `run:` lines invoking `test:e2e` are".to_string(),
        ),
        (
            "the run line's denominator set to 3",
            CI_YML.replace(&run_line, &run_line.replace("}}/4", "}}/3")),
            "the `run:` lines invoking `test:e2e` are".to_string(),
        ),
        (
            "the suite's exit code swallowed",
            CI_YML.replace(&run_line, &run_line.replace("/4\n", "/4 || true\n")),
            "the `run:` lines invoking `test:e2e` are".to_string(),
        ),
        (
            "fail-fast left on",
            CI_YML.replace(MATRIX, &MATRIX.replace("fail-fast: false", "fail-fast: true")),
            format!("job `{MOCK_JOB}` carries `fail-fast: false` 0 time(s)"),
        ),
        (
            "continue-on-error on the mock job",
            CI_YML.replace(MOCK_HEADER, &format!("{MOCK_HEADER}    continue-on-error: true\n")),
            format!("job `{MOCK_JOB}` carries `continue-on-error: true`"),
        ),
        (
            "a condition on the suite step",
            CI_YML.replace(MOCK_STEP, &format!("{MOCK_STEP}        if: false\n")),
            format!("in job `{MOCK_JOB}` carries `if: false`"),
        ),
    ];
    // (what, the planted workflow, what the report-upload check must name)
    let report_plants: Vec<(&str, String, String)> = vec![
        (
            "the report artifact renamed to mock-report",
            CI_YML.replace(
                &format!("          {MOCK_REPORT_ARTIFACT}\n"),
                "          name: mock-report\n",
            ),
            format!("`{MOCK_REPORT_ARTIFACT}` appears 0 time(s) in job `{MOCK_JOB}`"),
        ),
        (
            "the report path cut to the results folder",
            CI_YML.replace(
                &format!("          {MOCK_REPORT_PATH}\n"),
                "          path: frontend/test-results/\n",
            ),
            format!("job `{MOCK_JOB}` carries `{MOCK_REPORT_PATH}` 0 time(s)"),
        ),
        (
            "the missing-file rule removed",
            CI_YML.replace(
                &format!("          {MOCK_REPORT_PATH}\n          if-no-files-found: error\n"),
                &format!("          {MOCK_REPORT_PATH}\n"),
            ),
            format!("job `{MOCK_JOB}` carries `if-no-files-found: error` 0 time(s)"),
        ),
        (
            "the upload guard changed to failure()",
            CI_YML.replace(
                "      - name: Keep this shard's mock report\n        if: ${{ !cancelled() }}\n",
                "      - name: Keep this shard's mock report\n        if: failure()\n",
            ),
            format!(
                "the step carrying `{MOCK_REPORT_ARTIFACT}` in job `{MOCK_JOB}` has no \
                 `if: ${{{{ !cancelled() }}}}` line"
            ),
        ),
    ];
    // (what, the planted config)
    let config_plants: Vec<(&str, String)> = vec![
        (
            "retries 2",
            MOCK_CONFIG.replace(&format!("  {MOCK_RETRIES}\n"), "  retries: 2,\n"),
        ),
        (
            "the old CI retry put back",
            MOCK_CONFIG.replace(
                &format!("  {MOCK_RETRIES}\n"),
                "  retries: process.env.CI ? 1 : 0,\n",
            ),
        ),
        (
            "a second retries line that overrides the first",
            MOCK_CONFIG.replace(
                &format!("  {MOCK_RETRIES}\n"),
                &format!("  {MOCK_RETRIES}\n  retries: 2,\n"),
            ),
        ),
    ];
    assert_eq!(
        yml_plants.len() + config_plants.len(),
        10,
        "ten ways of losing mock tests or hiding a failure"
    );
    assert_eq!(report_plants.len(), 4, "four ways of losing a mock leg's report");

    let mut missed: Vec<String> = Vec::new();
    for (what, yml, must_name) in &yml_plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = mock_gate_wrong(yml).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    }
    for (what, yml, must_name) in &report_plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = mock_report_upload_wrong(yml).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    }
    for (what, config) in &config_plants {
        assert_ne!(config, MOCK_CONFIG, "{what}: the plant landed");
        let named = mock_retries_wrong(config).join("\n");
        if !named.contains("sets retries with") {
            missed.push(format!("{what}: expected the retries named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the mock gate went unnamed:\n{}",
        missed.join("\n")
    );
}

/// The job that runs both certification suites.
const DETERMINISM_JOB: &str = "determinism";
/// The shipped-default certification suite, as the whole of its `run:` line.
const CERT_DEFAULT_RUN: &str = "run: cargo test --workspace --no-fail-fast";
/// The all-features certification suite, as the whole of its `run:` line.
const CERT_ALL_RUN: &str = "run: cargo test --workspace --all-features --no-fail-fast";
/// The case count both suites run their proptests at.
const CERT_CASES: &str = "PROPTEST_CASES: 1024";
/// The shipped-default suite's condition: the `main` leg, which every operating system has.
const CERT_DEFAULT_IF: &str = "if: matrix.leg == 'main'";
/// The all-features suite's condition: its own leg on Windows, the `main` leg everywhere else,
/// and on the `main` leg even after the shipped-default suite failed. Without `!cancelled()` the
/// implicit `success()` skips it there, so a red shipped-default suite hides an all-features break.
const CERT_ALL_IF: &str =
    "if: ${{ !cancelled() && (matrix.leg == 'all-features' || runner.os != 'Windows') }}";
/// The determinism job's second matrix key.
const DETERMINISM_LEGS: &str = "leg: [main, all-features]";
/// The exclude entries that leave Ubuntu and macOS one leg each, as (os, leg).
const DETERMINISM_EXCLUDES: [(&str, &str); 2] =
    [("ubuntu-24.04", "all-features"), ("macos-latest", "all-features")];
/// The determinism job's cache step: only the `main` leg saves the shared entry.
const DETERMINISM_CACHE_STEP: &str = "uses: Swatinem/rust-cache@v2";
const DETERMINISM_CACHE_SAVE_IF: &str = "save-if: ${{ matrix.leg != 'all-features' }}";

/// The `exclude:` entries of a job's matrix, as (os, leg) pairs, read from the lines after the
/// job's `exclude:` line for as long as they are `os:` or `leg:` keys. `None` when the job has no
/// `exclude:` line.
fn matrix_excludes<'a>(job: &[&'a str]) -> Option<Vec<(&'a str, &'a str)>> {
    let at = job.iter().position(|l| *l == "exclude:")?;
    let mut entries: Vec<(&str, &str)> = Vec::new();
    for line in &job[at + 1..] {
        let (starts_entry, rest) = match line.strip_prefix("- ") {
            Some(rest) => (true, rest),
            None => (false, *line),
        };
        let Some((key, value)) = rest.split_once(": ") else {
            break;
        };
        if key != "os" && key != "leg" {
            break;
        }
        if starts_entry || entries.is_empty() {
            entries.push(("", ""));
        }
        let entry = entries.last_mut().expect("an entry was just pushed");
        if key == "os" {
            entry.0 = value;
        } else {
            entry.1 = value;
        }
    }
    Some(entries)
}

/// Everything wrong with how `yml` runs the two certification suites. Empty means right.
fn certification_suites_wrong(yml: &str) -> Vec<String> {
    let mut wrong: Vec<String> = Vec::new();
    let blocks = job_blocks_in(yml);

    // Each suite exactly once in the whole file, in the determinism job, as the whole of its line.
    for (expected, needle) in [
        (CERT_DEFAULT_RUN, "cargo test --workspace --no-fail-fast"),
        (CERT_ALL_RUN, "cargo test --workspace --all-features --no-fail-fast"),
    ] {
        let found: Vec<(&str, &str)> = blocks
            .iter()
            .flat_map(|(id, lines)| lines.iter().map(move |line| (*id, step_key(line))))
            .filter(|(_, line)| line.starts_with("run:") && line.contains(needle))
            .collect();
        if found != [(DETERMINISM_JOB, expected)] {
            wrong.push(format!(
                "the `run:` lines invoking `{needle}` are {found:?}, expected exactly \
                 [(\"{DETERMINISM_JOB}\", \"{expected}\")]. Without it a platform runs one \
                 certification suite, or none, and the job stays green."
            ));
        }
    }

    let Some((_, job)) = blocks.iter().find(|(id, _)| *id == DETERMINISM_JOB) else {
        wrong.push(format!("there is no job `{DETERMINISM_JOB}` under `jobs:`."));
        return wrong;
    };

    // Each suite's step keeps the CI case count and exactly its own leg condition.
    for (run, cond) in [(CERT_DEFAULT_RUN, CERT_DEFAULT_IF), (CERT_ALL_RUN, CERT_ALL_IF)] {
        let Ok((_, step)) = one_step_with(job, run, DETERMINISM_JOB) else {
            continue;
        };
        if !step.contains(&CERT_CASES) {
            wrong.push(format!(
                "the step running `{run}` has no `{CERT_CASES}` line, so its proptests fall back \
                 to 256 cases."
            ));
        }
        let conditions: Vec<&str> = step
            .iter()
            .map(|l| step_key(l))
            .filter(|l| l.starts_with("if:"))
            .collect();
        if conditions != [cond] {
            wrong.push(format!(
                "the step running `{run}` carries the condition(s) {conditions:?}, expected \
                 exactly [\"{cond}\"]. Any other condition can leave an operating system \
                 without this suite, or run it twice."
            ));
        }
    }

    // The matrix that makes the legs: the leg key once, and exactly the two excludes.
    for key in [DETERMINISM_LEGS, "exclude:"] {
        let found = job.iter().filter(|l| **l == key).count();
        if found != 1 {
            wrong.push(format!(
                "job `{DETERMINISM_JOB}` carries `{key}` {found} time(s), expected 1. The legs \
                 decide which operating system runs which certification suite."
            ));
        }
    }
    if let Some(excludes) = matrix_excludes(job) {
        if excludes.iter().any(|(os, _)| *os == "windows-latest") {
            wrong.push(format!(
                "job `{DETERMINISM_JOB}` excludes a `windows-latest` leg ({excludes:?}). Windows \
                 runs its two certification suites on its two legs, so dropping one drops a \
                 suite."
            ));
        }
        if excludes != DETERMINISM_EXCLUDES {
            wrong.push(format!(
                "job `{DETERMINISM_JOB}` has the exclude entries {excludes:?}, expected exactly \
                 {DETERMINISM_EXCLUDES:?}. Without them Ubuntu and macOS run the all-features \
                 suite twice, and a pull request runs two legs."
            ));
        }
    }

    // Only the `main` leg saves the cache entry the two Windows legs share.
    match one_step_with(job, DETERMINISM_CACHE_STEP, DETERMINISM_JOB) {
        Err(message) => wrong.push(message),
        Ok((_, step)) => {
            if !step.contains(&DETERMINISM_CACHE_SAVE_IF) {
                wrong.push(format!(
                    "the cache step in job `{DETERMINISM_JOB}` has no \
                     `{DETERMINISM_CACHE_SAVE_IF}` line, so both Windows legs race to save one \
                     cache entry."
                ));
            }
        }
    }

    for line in job
        .iter()
        .filter(|line| step_key(line).starts_with("continue-on-error"))
    {
        wrong.push(format!(
            "job `{DETERMINISM_JOB}` carries `{}`, so a red certification suite would leave the \
             job green.",
            step_key(line)
        ));
    }
    wrong
}

/// Every operating system runs both certification suites, at the CI case count.
///
/// # Why
///
/// Nothing pinned the two certification lines before, and splitting them across matrix legs
/// puts a condition on each. A wrong condition, a deleted step or a dropped `PROPTEST_CASES`
/// line would each lose a suite or most of its cases with every other test still green. On
/// Linux and macOS the job has one leg, `main`, which runs both suites. On Windows the `main`
/// leg runs the shipped-default suite and the `all-features` leg runs the other, in parallel,
/// because back to back they made Windows the slowest leg of the workflow. The all-features
/// condition carries `!cancelled()`, so on the `main` leg it still runs after the shipped-default
/// suite failed. This rule pins the two run lines, their case count, their conditions, the leg
/// key, the two exclude entries and the cache step's `save-if`.
#[test]
fn both_certification_suites_run_on_every_operating_system() {
    let wrong = certification_suites_wrong(CI_YML);
    assert!(
        wrong.is_empty(),
        "{} fact(s) about the certification suites are wrong:\n\n{}\n\n\
         Update the WORKFLOW to match this test. Do NOT re-point this test at whatever the \
         workflow currently says: these assertions keep both suites on every operating system.",
        wrong.len(),
        wrong.join("\n\n")
    );
}

/// `certification_suites_wrong` can fail: each break below is planted in a copy of the real
/// workflow, and the check has to name it.
#[test]
fn the_certification_split_check_names_each_way_of_dropping_a_suite() {
    const ALL_STEP: &str = "      - name: Certification suite - all features (PROPTEST_CASES=1024)\n";
    let default_cases = format!("          {CERT_CASES}\n        {CERT_DEFAULT_RUN}\n");
    let default_cond = format!(
        "        {CERT_DEFAULT_IF}\n        env:\n          {CERT_CASES}\n        {CERT_DEFAULT_RUN}\n"
    );
    let macos_exclude = "          - os: macos-latest\n            leg: all-features\n";
    let legs_line = format!("        {DETERMINISM_LEGS}\n");
    let save_if = format!("        with:\n          {DETERMINISM_CACHE_SAVE_IF}\n");

    // (what, the planted copy, what the check must name)
    let plants: Vec<(&str, String, String)> = vec![
        (
            "the all-features suite deleted",
            without_step(CI_YML, ALL_STEP),
            format!("expected exactly [(\"{DETERMINISM_JOB}\", \"{CERT_ALL_RUN}\")]"),
        ),
        (
            "PROPTEST_CASES dropped from the shipped-default suite",
            CI_YML.replace(&default_cases, &format!("        {CERT_DEFAULT_RUN}\n")),
            format!("the step running `{CERT_DEFAULT_RUN}` has no `{CERT_CASES}` line"),
        ),
        (
            "the shipped-default suite moved to the all-features leg",
            CI_YML.replace(
                &default_cond,
                &default_cond.replace(CERT_DEFAULT_IF, "if: matrix.leg == 'all-features'"),
            ),
            format!("the step running `{CERT_DEFAULT_RUN}` carries the condition(s)"),
        ),
        (
            "a Windows leg excluded",
            CI_YML.replace(
                macos_exclude,
                &format!("{macos_exclude}          - os: windows-latest\n            leg: all-features\n"),
            ),
            format!("job `{DETERMINISM_JOB}` excludes a `windows-latest` leg"),
        ),
        (
            "the leg key removed",
            CI_YML.replace(&legs_line, ""),
            format!("job `{DETERMINISM_JOB}` carries `{DETERMINISM_LEGS}` 0 time(s)"),
        ),
        (
            "the cache step's save-if removed",
            CI_YML.replace(&save_if, ""),
            format!("has no `{DETERMINISM_CACHE_SAVE_IF}` line"),
        ),
        (
            "the all-features suite skipped after a red shipped-default suite",
            CI_YML.replace(
                &format!("{ALL_STEP}        {CERT_ALL_IF}\n"),
                &format!(
                    "{ALL_STEP}        if: matrix.leg == 'all-features' || runner.os != 'Windows'\n"
                ),
            ),
            format!("the step running `{CERT_ALL_RUN}` carries the condition(s)"),
        ),
    ];
    assert_eq!(plants.len(), 7, "seven ways of dropping a certification suite in ci.yml");

    let mut missed: Vec<String> = Vec::new();
    for (what, yml, must_name) in &plants {
        assert_ne!(yml, CI_YML, "{what}: the plant landed");
        let named = certification_suites_wrong(yml).join("\n");
        if !named.contains(must_name.as_str()) {
            missed.push(format!("{what}: expected `{must_name}` named, got: {named:?}"));
        }
    }
    assert!(
        missed.is_empty(),
        "a planted break in the certification split went unnamed:\n{}",
        missed.join("\n")
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

/// Every job in release.yml has its own time limit too.
#[test]
fn every_release_job_has_a_time_limit() {
    let (jobs, wrong) = jobs_without_one_time_limit(RELEASE_YML);
    assert!(
        jobs >= 3,
        "found {jobs} jobs under `jobs:` in .github/workflows/release.yml, expected at least 3; \
         the job scan is not reading the workflow"
    );
    assert!(
        wrong.is_empty(),
        "every release job must carry its own `timeout-minutes:`:\n{}",
        wrong.join("\n")
    );
}

/// The one release job that may write to the repository.
const RELEASE_ATTACH_JOB: &str = "attach";
/// The release job that checks the attached copy.
const RELEASE_VERIFY_JOB: &str = "verify";
/// The tag filter: three-part version tags only, so `v13.0` and `public-base` never start a release.
const RELEASE_TAG_FILTER: &str = "- 'v[0-9]+.[0-9]+.[0-9]+'";
/// The concurrency group, keyed on the tag, and the rule that never cancels a run in progress.
const RELEASE_CONCURRENCY: [&str; 2] = [
    "group: release-${{ inputs.tag || github.ref_name }}",
    "cancel-in-progress: false",
];
/// The verify job's run line: the offline check on the copy downloaded from the release.
const RELEASE_VERIFY_RUN: &str = r#"run: FABRICO_OFFLINE_FILE="$PWD/offline-attached/fabrico-examples.html" bash scripts/check-offline-browsers.sh"#;
/// The attach job's tag check, which must come before its first release call.
const RELEASE_TAG_CHECK: &str = r#"if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then"#;
/// Package and build tools the attach job must never run, as whole words.
const RELEASE_ATTACH_FORBIDDEN: [&str; 3] = ["npm", "npx", "cargo"];
/// How the attach job reads the commit an existing tag names (review 101 CR-01).
const RELEASE_TAG_LOOKUP: &str = r#"gh api "repos/$GH_REPO/git/ref/tags/$TAG""#;
/// The attach job's refusal when the tag already exists at a commit other than the one this run
/// built. It must come before the first release call, because the published path exits early.
const RELEASE_TAG_COMMIT_CHECK: &str = r#"if [ "$tag_commit" != "$GITHUB_SHA" ]; then"#;
/// The attach job's refusal when no tag exists yet and the existing draft targets a commit other
/// than the one this run built. Publishing that draft would create the tag at its target, carrying
/// this run's file. It must come before the upload.
const RELEASE_DRAFT_TARGET_CHECK: &str = r#"if [ "$target" != "$GITHUB_SHA" ]; then"#;
/// The attach job's upload, which both refusals must come before.
const RELEASE_UPLOAD: &str = "gh release upload";
/// The release job that builds the offline file.
const RELEASE_BUILD_JOB: &str = "build";
/// The build job's refusal when the tag doesn't name fabrico-app's version (review 101 WR-04).
const RELEASE_VERSION_CHECK: &str = r#"if [ "$TAG" != "v$version" ]; then"#;
/// The build job's first build step, which the version check must come before.
const RELEASE_FIRST_BUILD: &str = "run: bash scripts/build-wasm.sh";

/// What is wrong with one refusal in job `job`'s trimmed lines: `check` must appear once, before
/// the first line containing `before`, with an `exit 1` between it and the `fi` that closes it.
/// Empty means right.
fn release_refusal_wrong(job: &str, attach: &[&str], check: &str, before: &str, why: &str) -> Vec<String> {
    let count = attach.iter().filter(|l| **l == check).count();
    let Some(at) = attach.iter().position(|l| *l == check) else {
        return vec![format!("job `{job}` runs `{check}` {count} time(s), expected 1. {why}")];
    };
    let mut wrong: Vec<String> = Vec::new();
    if count != 1 {
        wrong.push(format!("job `{job}` runs `{check}` {count} time(s), expected 1. {why}"));
    }
    let before_at = attach.iter().position(|l| l.contains(before));
    if before_at.is_none_or(|b| b < at) {
        wrong.push(format!(
            "job `{job}` doesn't run `{check}` before its first `{before}` line (check at {at}, \
             first `{before}` at {before_at:?}). {why}"
        ));
    }
    let closes = attach[at + 1..].iter().position(|l| *l == "fi").map(|k| at + 1 + k);
    let exits = closes.is_some_and(|fi| attach[at + 1..fi].contains(&"exit 1"));
    if !exits {
        wrong.push(format!(
            "the `{check}` block in job `{job}` has no `exit 1` before its `fi`, so a mismatch \
             would carry on. {why}"
        ));
    }
    wrong
}

/// Does `line` hold `word` as a whole word (no letter, digit, `_` or `-` on either side)?
fn has_word(line: &str, word: &str) -> bool {
    let is_part = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    line.match_indices(word).any(|(at, _)| {
        let before = line[..at].chars().next_back();
        let after = line[at + word.len()..].chars().next();
        !before.is_some_and(is_part) && !after.is_some_and(is_part)
    })
}

/// The lines of `yml` that are shell script: each `run:` line's own text after `run:`, and every
/// line of a `run: |` block (the lines indented deeper than its `run:` key), with their line numbers.
fn run_script_lines(yml: &str) -> Vec<(usize, &str)> {
    let mut out: Vec<(usize, &str)> = Vec::new();
    let mut block_indent: Option<usize> = None;
    for (n, raw) in yml.lines().enumerate() {
        let indent = raw.len() - raw.trim_start().len();
        if let Some(key) = block_indent {
            if raw.trim().is_empty() || indent > key {
                out.push((n + 1, raw));
                continue;
            }
            block_indent = None;
        }
        let trimmed = raw.trim_start();
        let (key_indent, rest) = if let Some(rest) = trimmed.strip_prefix("- run:") {
            (indent + 2, rest)
        } else if let Some(rest) = trimmed.strip_prefix("run:") {
            (indent, rest)
        } else {
            continue;
        };
        out.push((n + 1, rest));
        let rest = rest.trim();
        if rest.starts_with('|') || rest.starts_with('>') {
            block_indent = Some(key_indent);
        }
    }
    out
}

/// Everything wrong with release.yml's least-privilege split. Empty means right.
fn release_wiring_wrong(yml: &str) -> Vec<String> {
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

    // The workflow-level floor: `permissions:` at column 0, then `contents: read` under it.
    let raw: Vec<&str> = yml.lines().collect();
    let floor = raw
        .iter()
        .position(|l| *l == "permissions:")
        .is_some_and(|at| raw.get(at + 1) == Some(&"  contents: read"));
    if !floor {
        wrong.push(
            "release.yml has no workflow-level `permissions:` block opening with `contents: read`. \
             Without it every job inherits the repository's default token scope."
                .to_string(),
        );
    }

    // Every other scope: no `write-all`, no write scope outside the attach job's one, nothing but
    // `contents: read` at workflow level (review 101 WR-03).
    wrong.extend(permissions_wrong(yml, "release.yml", &[(RELEASE_ATTACH_JOB, "contents: write")]));

    // `contents: write` once, in the attach job.
    let write_homes: Vec<&str> = blocks
        .iter()
        .filter(|(_, lines)| lines.contains(&"contents: write"))
        .map(|(id, _)| *id)
        .collect();
    let writes = code.iter().filter(|l| **l == "contents: write").count();
    if writes != 1 || write_homes != [RELEASE_ATTACH_JOB] {
        wrong.push(format!(
            "`contents: write` appears {writes} time(s) in release.yml, in job(s) {write_homes:?}, \
             expected once, in job `{RELEASE_ATTACH_JOB}` only. The other jobs run package code."
        ));
    }

    // The attach job runs no package or build tool, and checks nothing out.
    let attach = job_lines(RELEASE_ATTACH_JOB);
    if attach.is_empty() {
        wrong.push(format!("release.yml has no job `{RELEASE_ATTACH_JOB}`."));
    }
    for line in &attach {
        for word in RELEASE_ATTACH_FORBIDDEN {
            if has_word(line, word) {
                wrong.push(format!(
                    "job `{RELEASE_ATTACH_JOB}` carries `{line}`, which names `{word}`. The job \
                     that holds `contents: write` must run no package or build tool."
                ));
            }
        }
        if step_key(line).starts_with("uses: actions/checkout") {
            wrong.push(format!(
                "job `{RELEASE_ATTACH_JOB}` carries `{line}`. It takes the built file as an \
                 artifact and needs no checkout."
            ));
        }
    }
    // Its tag check comes before its first release call.
    let check_at = attach.iter().position(|l| *l == RELEASE_TAG_CHECK);
    let call_at = attach.iter().position(|l| l.contains("gh release"));
    match (check_at, call_at) {
        (Some(c), Some(g)) if c < g => {}
        _ => wrong.push(format!(
            "job `{RELEASE_ATTACH_JOB}` doesn't run `{RELEASE_TAG_CHECK}` before its first `gh \
             release` call (tag check at {check_at:?}, first call at {call_at:?})."
        )),
    }
    // The asset is built at this run's commit, so the release must name that commit too (review
    // 101 CR-01): an existing tag must point at it, and with no tag yet the draft must target it.
    let lookup_at = attach.iter().position(|l| l.contains(RELEASE_TAG_LOOKUP));
    if lookup_at.is_none() || call_at.is_some_and(|g| lookup_at.is_some_and(|k| k > g)) {
        wrong.push(format!(
            "job `{RELEASE_ATTACH_JOB}` doesn't read the tag's commit with `{RELEASE_TAG_LOOKUP}` \
             before its first `gh release` call (lookup at {lookup_at:?}, first call at {call_at:?})."
        ));
    }
    wrong.extend(release_refusal_wrong(
        RELEASE_ATTACH_JOB,
        &attach,
        RELEASE_TAG_COMMIT_CHECK,
        "gh release",
        "An existing tag at another commit would carry this run's file.",
    ));
    wrong.extend(release_refusal_wrong(
        RELEASE_ATTACH_JOB,
        &attach,
        RELEASE_DRAFT_TARGET_CHECK,
        RELEASE_UPLOAD,
        "A draft targeting another commit would be published with this run's file.",
    ));

    // The build job refuses a tag that isn't fabrico-app's version before it builds anything.
    let build = job_lines(RELEASE_BUILD_JOB);
    wrong.extend(release_refusal_wrong(
        RELEASE_BUILD_JOB,
        &build,
        RELEASE_VERSION_CHECK,
        RELEASE_FIRST_BUILD,
        "A tag such as v0.1.1 against Cargo's 0.1.0 would name a release the binary disagrees with.",
    ));

    // The tag filter, exactly, once.
    let filters = code.iter().filter(|l| **l == RELEASE_TAG_FILTER).count();
    if filters != 1 {
        wrong.push(format!(
            "`{RELEASE_TAG_FILTER}` appears {filters} time(s) in release.yml, expected 1. Only a \
             three-part version tag may start a release."
        ));
    }

    // The concurrency group and its rule, each once.
    for line in RELEASE_CONCURRENCY {
        let found = code.iter().filter(|l| **l == line).count();
        if found != 1 {
            wrong.push(format!(
                "`{line}` appears {found} time(s) in release.yml, expected 1. Two runs for one tag \
                 must queue, never race or cancel each other."
            ));
        }
    }

    // The verify job checks the downloaded copy.
    let verify_runs = job_lines(RELEASE_VERIFY_JOB)
        .iter()
        .filter(|l| step_key(l) == RELEASE_VERIFY_RUN)
        .count();
    let in_file = code.iter().filter(|l| step_key(l) == RELEASE_VERIFY_RUN).count();
    if verify_runs != 1 || in_file != 1 {
        wrong.push(format!(
            "`{RELEASE_VERIFY_RUN}` appears {verify_runs} time(s) in job `{RELEASE_VERIFY_JOB}` and \
             {in_file} time(s) in release.yml, expected 1 and 1."
        ));
    }

    // No expression inside a script: values reach scripts through `env:` only.
    for (n, line) in run_script_lines(yml) {
        if line.contains("${{") {
            wrong.push(format!(
                "release.yml line {n} puts an expression inside a `run:` script: `{}`. Pass the value \
                 through `env:` instead, so a typed input can't become shell code.",
                line.trim()
            ));
        }
    }
    wrong
}

/// release.yml keeps the write token in the attach job, away from package code, takes only
/// three-part tags, queues runs for one tag, checks the downloaded copy, and puts no expression in
/// a script.
#[test]
fn the_release_workflow_keeps_the_write_token_away_from_package_code() {
    let wrong = release_wiring_wrong(RELEASE_YML);
    assert!(
        wrong.is_empty(),
        "release.yml isn't wired as it has to be:\n{}\n\
         Update the WORKFLOW to match this test.",
        wrong.join("\n")
    );
}

/// Assert that `release_wiring_wrong` (or, for a limit, the time-limit scan) names `must_name` on
/// a copy of release.yml with one break planted in it, and print what it named.
fn assert_release_plant_named(what: &str, yml: &str, must_name: &str) {
    assert_ne!(yml, RELEASE_YML, "{what}: the plant landed");
    let mut named = release_wiring_wrong(yml);
    named.extend(jobs_without_one_time_limit(yml).1);
    let named = named.join("\n");
    println!("{what}: {named}");
    assert!(
        named.contains(must_name),
        "{what}: expected `{must_name}` named, got: {named:?}"
    );
}

/// An `npm ci` step in the attach job is named.
#[test]
fn the_release_check_names_npm_ci_in_the_attach_job() {
    let step = "      - name: Hand the attached copy to the verify job\n";
    assert_release_plant_named(
        "`npm ci` in the attach job",
        &RELEASE_YML.replace(step, &format!("      - name: Install\n        run: npm ci\n\n{step}")),
        &format!("job `{RELEASE_ATTACH_JOB}` carries `run: npm ci`, which names `npm`."),
    );
}

/// release.yml with the verify job's own `timeout-minutes:` line replaced by `edit(line)`. The line
/// is found from the job's header, not by its value, so retuning the limit leaves the plants that
/// use it working (review 101 WR-06).
fn release_with_verify_limit(edit: impl Fn(&str) -> String) -> String {
    let mut out = String::new();
    let mut in_verify = false;
    let mut found = 0;
    for line in RELEASE_YML.split_inclusive('\n') {
        if let Some(id) = job_id(line.trim_end_matches('\n')) {
            in_verify = id == RELEASE_VERIFY_JOB;
        }
        if in_verify && found == 0 && line.starts_with("    timeout-minutes:") {
            out.push_str(&edit(line));
            found += 1;
            continue;
        }
        out.push_str(line);
    }
    assert_eq!(found, 1, "job `{RELEASE_VERIFY_JOB}` has a job-level `timeout-minutes:` line to plant on");
    out
}

/// A job with no time limit is named.
#[test]
fn the_release_check_names_a_job_without_a_time_limit() {
    assert_release_plant_named(
        "the verify job's limit removed",
        &release_with_verify_limit(|_| String::new()),
        &format!("job `{RELEASE_VERIFY_JOB}` has 0 job-level `timeout-minutes:` line(s), expected 1"),
    );
}

/// A two-part tag filter is named.
#[test]
fn the_release_check_names_a_two_part_tag_filter() {
    assert_release_plant_named(
        "the tag filter `v[0-9]+.[0-9]+`",
        &RELEASE_YML.replace(RELEASE_TAG_FILTER, "- 'v[0-9]+.[0-9]+'"),
        &format!("`{RELEASE_TAG_FILTER}` appears 0 time(s) in release.yml, expected 1."),
    );
}

/// `contents: write` given to the verify job is named.
#[test]
fn the_release_check_names_contents_write_in_the_verify_job() {
    assert_release_plant_named(
        "`contents: write` in the verify job",
        &release_with_verify_limit(|line| format!("{line}    permissions:\n      contents: write\n")),
        &format!(
            "`contents: write` appears 2 time(s) in release.yml, in job(s) [\"{RELEASE_ATTACH_JOB}\", \"{RELEASE_VERIFY_JOB}\"], expected once"
        ),
    );
}

/// The tag input spliced into a script is named.
#[test]
fn the_release_check_names_an_expression_inside_a_run_script() {
    let check = format!("          {RELEASE_TAG_CHECK}\n");
    assert_release_plant_named(
        "`echo ${{ inputs.tag }}` in a run line",
        &RELEASE_YML.replace(&check, &format!("          echo ${{{{ inputs.tag }}}}\n{check}")),
        "puts an expression inside a `run:` script: `echo ${{ inputs.tag }}`.",
    );
}

/// `permissions: write-all` on the release build job, which runs npm ci and cargo, is named
/// (review 101 WR-03).
#[test]
fn the_release_check_names_write_all_in_the_build_job() {
    let header = "    name: the offline examples file builds at this commit\n";
    assert_release_plant_named(
        "`permissions: write-all` in the build job",
        &RELEASE_YML.replace(header, &format!("{header}    permissions: write-all\n")),
        "job `build` sets `permissions: write-all`.",
    );
}

/// A second write scope under release.yml's workflow-level floor is named (review 101 WR-03).
#[test]
fn the_release_check_names_a_write_scope_in_the_workflow_floor() {
    assert_release_plant_named(
        "`packages: write` under the workflow-level `permissions:`",
        &RELEASE_YML.replacen("permissions:\n  contents: read\n", "permissions:\n  contents: read\n  packages: write\n", 1),
        "release.yml's workflow-level permissions are",
    );
}

/// An unexpected write scope in the attach job, beside its one allowed `contents: write`, is named
/// (review 101 WR-03).
#[test]
fn the_release_check_names_an_extra_write_scope_in_the_attach_job() {
    assert_release_plant_named(
        "`actions: write` in the attach job",
        &RELEASE_YML.replace("    permissions:\n      contents: write\n", "    permissions:\n      contents: write\n      actions: write\n"),
        &format!("job `{RELEASE_ATTACH_JOB}` holds `actions: write`"),
    );
}

/// The lines of release.yml from the one holding `check` to the `fi` that closes its block, so a
/// plant can delete the whole refusal.
fn release_refusal_block(check: &str) -> String {
    let lines: Vec<&str> = RELEASE_YML.lines().collect();
    let at = lines
        .iter()
        .position(|l| l.trim() == check)
        .unwrap_or_else(|| panic!("release.yml has no `{check}` line to plant on"));
    let fi = at
        + lines[at..]
            .iter()
            .position(|l| l.trim() == "fi")
            .expect("the refusal block closes with `fi`");
    let mut block = lines[at..=fi].join("\n");
    block.push('\n');
    block
}

/// Deleting the build job's version check is named (review 101 WR-04).
#[test]
fn the_release_check_names_a_missing_version_check() {
    assert_release_plant_named(
        "the tag-against-version check deleted",
        &RELEASE_YML.replace(&release_refusal_block(RELEASE_VERSION_CHECK), ""),
        &format!("job `{RELEASE_BUILD_JOB}` runs `{RELEASE_VERSION_CHECK}` 0 time(s), expected 1."),
    );
}

/// A version check that prints its message and carries on is named (review 101 WR-04).
#[test]
fn the_release_check_names_a_version_check_that_does_not_exit() {
    let block = release_refusal_block(RELEASE_VERSION_CHECK);
    assert_release_plant_named(
        "the version check's `exit 1` turned into `true`",
        &RELEASE_YML.replace(&block, &block.replace("exit 1", "true")),
        &format!("the `{RELEASE_VERSION_CHECK}` block in job `{RELEASE_BUILD_JOB}` has no `exit 1` before its `fi`"),
    );
}

/// Deleting the refusal for a tag at another commit is named (review 101 CR-01).
#[test]
fn the_release_check_names_a_missing_tag_commit_refusal() {
    assert_release_plant_named(
        "the tag-commit refusal deleted",
        &RELEASE_YML.replace(&release_refusal_block(RELEASE_TAG_COMMIT_CHECK), ""),
        &format!("job `{RELEASE_ATTACH_JOB}` runs `{RELEASE_TAG_COMMIT_CHECK}` 0 time(s), expected 1."),
    );
}

/// Deleting the refusal for a draft targeting another commit is named (review 101 CR-01).
#[test]
fn the_release_check_names_a_missing_draft_target_refusal() {
    assert_release_plant_named(
        "the draft-target refusal deleted",
        &RELEASE_YML.replace(&release_refusal_block(RELEASE_DRAFT_TARGET_CHECK), ""),
        &format!("job `{RELEASE_ATTACH_JOB}` runs `{RELEASE_DRAFT_TARGET_CHECK}` 0 time(s), expected 1."),
    );
}

/// A tag-commit refusal that prints its message and carries on is named (review 101 CR-01).
#[test]
fn the_release_check_names_a_tag_commit_refusal_that_does_not_exit() {
    let block = release_refusal_block(RELEASE_TAG_COMMIT_CHECK);
    assert_release_plant_named(
        "the tag-commit refusal's `exit 1` turned into `true`",
        &RELEASE_YML.replace(&block, &block.replace("exit 1", "true")),
        &format!(
            "the `{RELEASE_TAG_COMMIT_CHECK}` block in job `{RELEASE_ATTACH_JOB}` has no `exit 1` before its `fi`"
        ),
    );
}

/// The draft-target refusal moved after the upload is named (review 101 CR-01).
#[test]
fn the_release_check_names_a_draft_target_refusal_after_the_upload() {
    let block = release_refusal_block(RELEASE_DRAFT_TARGET_CHECK);
    let upload = RELEASE_YML
        .lines()
        .find(|l| l.contains(RELEASE_UPLOAD))
        .expect("release.yml uploads the file");
    let moved = RELEASE_YML
        .replace(&block, "")
        .replace(&format!("{upload}\n"), &format!("{upload}\n{block}"));
    assert_release_plant_named(
        "the draft-target refusal moved after the upload",
        &moved,
        &format!("job `{RELEASE_ATTACH_JOB}` doesn't run `{RELEASE_DRAFT_TARGET_CHECK}` before its first `{RELEASE_UPLOAD}` line"),
    );
}

/// `run_script_lines` reads both forms of `run:` and stops a block at the next key.
#[test]
fn the_run_script_reader_reads_single_lines_and_blocks() {
    let yml = "jobs:\n  a:\n    steps:\n      - run: echo one\n      - name: two\n        run: |\n          echo two\n\n          echo three\n        env:\n          X: ${{ github.sha }}\n";
    let lines: Vec<&str> = run_script_lines(yml).into_iter().map(|(_, l)| l.trim()).collect();
    assert_eq!(lines, ["echo one", "|", "echo two", "", "echo three"]);
}

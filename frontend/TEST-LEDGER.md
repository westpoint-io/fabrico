# Test ledger

This file records every browser spec that was merged into another test or deleted, and the
evidence that the defect it was written for is still caught.

## The deletion rule

A spec may go only after a patch re-creates each defect it was written for, the old spec fails on
that patch, and the test that guards the defect now fails on it too. A revert can't stand in for
the patch, because the public history starts at one squashed commit. So the patch file, kept
under `rebreak/`, is the evidence, together with the two failing outputs it produced.

## Running a proof

From the repository root:

```bash
bash scripts/rebreak.sh <id>
```

The script reads the row whose `id` cell matches, builds a throwaway git worktree, runs the old
spec and the guarding test there once without the patch (both must pass) and once with it (both
must fail), and only then writes the two outputs named in the row. Exit 0 means proven, 1 means a
patched run passed, and 2 means the proof couldn't be made. The script's header has the details.

## Columns

- `id`: lower-case letters, digits and hyphens. It names the three files under `rebreak/`.
- `state`: `kept` while the spec is still in the tree, `deleted` once it is gone. For a deleted
  spec the script runs it at the parent of the commit that deleted it.
- `spec`: the old spec, relative to `frontend/` (`e2e/...` for the mock suite, `e2e-live/...` for
  the live suite and the lesson walk).
- `defect`: what a user would see go wrong, in plain words.
- `guarding test`: the test that catches the defect now, in Playwright's `--test-list` form with a
  suite prefix: `mock:`, `live:` or `walk:`, then `[project] › file › describe › title`. The file
  is relative to that suite's test folder, and the line must name exactly one test.
- `patch`, `old output`, `new output`: always `rebreak/<id>.patch`, `rebreak/<id>.old.txt` and
  `rebreak/<id>.new.txt`, relative to `frontend/`.

## Rows

The `welcome-card-first-run` row is a demonstration of the proof. Its spec stays in the tree.

| id | state | spec | defect | guarding test | patch | old output | new output |
|----|-------|------|--------|---------------|-------|------------|------------|
| welcome-card-first-run | kept | e2e-live/12-welcome-card.spec.ts | A first-time user never sees the welcome card | mock: [chromium] › lessons.spec.ts › the welcome card opens the list › the welcome card opens the list | rebreak/welcome-card-first-run.patch | rebreak/welcome-card-first-run.old.txt | rebreak/welcome-card-first-run.new.txt |

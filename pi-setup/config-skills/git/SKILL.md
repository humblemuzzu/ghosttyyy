---
name: git
description: "git workflows for agents: ship (stage → commit → push), worktree (parallel branches), hunks (selective staging). never force push, never git add -A, conventional commits. triggers on: commit, push, stage, ship, git add, worktree, hunks, selective staging."
---
# git

## constraints

- stage files explicitly, NEVER `git add -A` (unstaged changes may not be yours)
- NEVER force push (`--force`, `-f`, `--force-with-lease`)
- if unsure which changes are yours, ask user
- commit format: `type(scope): description` (lowercase, imperative)
- types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `chore`
- prefer `gh` cli for github operations (PRs, issues, repo info) — auth is pre-configured via sops

## ship

stage YOUR changes, commit, push.

```bash
git status
git add <your-files>
git diff --staged
git commit -m "type(scope): description"
git push
```

if push fails (divergence): `git fetch origin && git rebase origin/main && git push`

## hunks

selective staging without interactive mode. `git add <file>` is all-or-nothing;
`git add -p` is interactive and an agent cannot answer its prompts. this is the
same capability, addressable by number.

**installed as a real git subcommand** — `~/.local/bin/git-hunks` is symlinked to
`scripts/git-hunks` in this skill directory, and `~/.local/bin` is on PATH. if
`git hunks` ever reports "not a git command", the symlink is missing; recreate it
with the command at the bottom of this section.

you never have to remember the syntax: **`list` prints the exact next command.**

```bash
$ git hunks list                    # or: git hunks list src/app.ts
ID   FILE          CHANGE   WHERE
1    src/app.ts    +1 -1    @@ -1,5 +1,5 @@
2    src/app.ts    +1 -1    @@ -9,5 +9,5 @@

read one first:   git hunks show 3f9a1c <id>...
then stage it:    git hunks add  3f9a1c <id>...
```

then, copying the token it printed:

```bash
git hunks show 3f9a1c 1     # READ IT FIRST — always
git hunks add  3f9a1c 1     # stage exactly that
git hunks verify            # staged vs left behind
git diff --cached           # read what you are about to commit
```

use when one file contains changes that are not all yours — the common case
being another agent session editing the same file concurrently. staging the
whole file would sweep their unfinished work into your commit.

**the token is not ceremony.** it is a fingerprint of the exact diff you were
shown, and it is what makes this safe with two agents running. measured, before
it existed: agent A ran `list mine.txt`, agent B ran `list theirs.txt`, then A
ran `add 1` — and **A silently staged B's file and exited 0**. the token turns
that into a loud refusal. if `add` rejects your token, someone else listed after
you did: re-run `list` and use the new one.

notes:
- operates on UNSTAGED changes to TRACKED files. a brand-new file has no hunks
  to choose between — `git add` it directly.
- never touches the working tree; it stages via `git apply --cached`. the test
  suite proves this by checksumming every file before and after a full run,
  failed commands included.
- **stage everything you want in ONE `add`.** `add <tok> 1` then `add <tok> 2`
  will not work: the first add removes those lines from the diff, so id 2 no
  longer means what you read. the token is spent on use and `add` says so.
  deliberate — the alternative is staging a hunk you never looked at.
- **any change in scope invalidates the ids**, including the other agent touching
  a file you listed. expected, not a malfunction: the tool cannot prove the diff
  is still what you read, so it refuses instead of guessing. narrow the window
  with `git hunks list <path>` — the filter is remembered by `show`/`add`, so
  only changes to that path can disturb you.
- it REFUSES outright during an unresolved merge (git reports conflicted files as
  a combined diff, which is not an applyable patch), and refuses any argument
  that looks like a git flag (`-R`, `--cached`, `-U0` would each make it list one
  diff and stage a different one).
- if your change and theirs land in the SAME hunk (a few lines apart), no
  hunk-level tool can split them. edit the file so they are apart, or stage the
  file whole and say so.

after changing the script, run the suite — 38 adversarial cases, every one a bug
that was actually found:

```bash
bash ~/.config/agents/skills/git/scripts/git-hunks-test
```

re-install if `git hunks` is not found:

```bash
ln -sfn ~/.config/agents/skills/git/scripts/git-hunks ~/.local/bin/git-hunks
```

## worktree

parallel branches in sibling directories.

```bash
wt <name>                               # create worktree + new branch (authoring)
wt pr <number>                          # create worktree from PR's remote branch (reviewing)
git worktree list                       # see all
git worktree remove ../<name>           # cleanup
```

`wt` checks for `./bare-repo.git` and uses it as git dir if present.

naming: `axm-{id}` / `ai-{id}` for authoring (Linear issue), `pr-{number}` for reviewing.

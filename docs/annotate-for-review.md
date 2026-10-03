← [README](../README.md)

# The annotate-for-review skill

`.claude/skills/annotate-for-review/` is a Claude Code skill that records what a
session changed as prview notes: one line per file on what it now does and
why, plus notes on the decisions worth pointing at. The reasoning behind a
change reaches the reviewer instead of dying with the session.

It is the counterpart to `--explain`, not a duplicate of it. `--explain` is a
small fast model reading a stranger's branch and inferring intent; the skill
is the model that *made* the change describing work it actually did, in the
session that did it.

## Installing it

The skill is committed with this repo, so for work **on prview itself** it is
already in place — run Claude Code from the repo root and it is picked up.

To use it on your own projects:

```sh
prview --install-skill            # ~/.claude/skills — every project, just for you
prview --install-skill local      # this repo's .claude/skills — commit it, share it with the team
```

Both are safe to re-run after an update — the destination is replaced
wholesale, so a file the skill has since dropped or renamed doesn't linger.
`local` needs to be run from inside the repo you want it committed to.

It needs `prview` on your `PATH` (`npm install -g prview`)
and nothing else — it shells out to `prview --annotate` rather than touching
`reviews.json` itself, so it cannot get the range key or patch hashes wrong.

## Using it

Ask for it in words ("write up these changes for review", "annotate what you
changed"), or invoke it directly as `/annotate-for-review`.

**Run `/reload-skills` after installing it** (or start a new session — a
session's skill list is loaded at startup, so either reloading or restarting
is what picks up a skill you just copied in). Skip this and
`/annotate-for-review` simply comes back unknown, which looks like a broken
skill rather than a stale list.

Then open the review:

```sh
prview              # if the changes are uncommitted
prview main         # if they are committed on a branch
prview --notes      # or just read them as Markdown
```

Notes it writes carry an `author` and show as `💬 [model-id] …`, so they never
pass as your own; re-running refreshes them and leaves anything you typed
alone.

**One thing to know about timing:** a range key includes the head commit, so
annotate *after* committing if you are about to commit. Notes written against
the working tree do not appear in the review of the commit that followed.

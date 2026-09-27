---
name: annotate-for-review
description: Record what you changed in this session as prview review notes, so a human can review your work in the diff viewer instead of reconstructing your reasoning from the code. Use when asked to annotate, note, or write up the changes for review, when handing work back for review, or after finishing a change the user will read. Writes via `prview --annotate`.
---

# Recording your changes for review

You made the changes, so you know things the diff does not show: which
alternative you rejected, which bug a line exists to prevent, which edit is
mechanical and which deserves a careful read. That knowledge is what makes a
review fast, and it evaporates the moment the session ends.

This skill writes it into prview's review store, anchored to the lines it is
about, so the reader meets each explanation next to the code it explains.

Notes written this way are attributed to you and stay separate from the
reader's own notes — theirs are never replaced or removed. This is distinct
from `prview --explain`, which reads *somebody else's* branch with a small
fast model; here the author is the model running this session, and it is
describing work it actually did.

## 1. Pick the range

`--annotate` writes into whichever review the reader will open, so name the
same range they will:

| Your changes are | Use | Reader opens |
|---|---|---|
| uncommitted (the usual case) | `prview --annotate` | `prview` |
| staged only | `prview --staged --annotate` | `prview --staged` |
| committed on a branch | `prview <base> --annotate` | `prview <base>` |

If you are about to commit, annotate **after** committing and use the branch
form — a range key includes the HEAD it was written against, so notes written
pre-commit will not appear in the post-commit review.

**Say which command opens what you wrote.** Uncommitted work annotates the
working-tree review, which `prview main` does not show: a reader who reaches
for the branch view finds nothing and concludes the tool is broken. Finish by
naming the exact command, not just that notes exist.

## 2. Read your own diff first

```sh
git diff                 # or: git diff --staged / git diff <base>...HEAD
```

Annotate only what is actually in that diff. If a file is not there, you did
not change it, whatever you remember doing.

Skip files the reader will not read: lockfiles, generated output, vendored
code, snapshots. "package-lock.json: dependency versions changed" costs the
reader a line and tells them nothing. A big mechanical change is worth one
summary saying it is mechanical, and no notes.

**Getting line numbers right.** A `new`-side line number is just the line
number in the file as it stands now, so read it off the file, not off the
diff's hunk headers:

```sh
cat -n src/crypto.ts             # new side — the numbers you want
git show HEAD:src/crypto.ts | cat -n   # old side, if annotating a deleted line
```

Find the line you mean in that output and use its number. Do not count
offsets from an `@@` header by hand; that is where the mistakes come from.

## 3. Write short

One **summary** per changed file: what it now does and why, in one sentence.
Add a **note** only where a specific line needs pointing at.

Good notes carry what the diff cannot:

- the trap a line prevents — *"length check first: `timingSafeEqual` throws on
  unequal lengths rather than returning false"*
- why this way — *"shared predicate: the UI and runner must agree, or the UI
  announces work the runner declines"*
- what the reader should check — *"base64url, not base64 — must match how the
  header encodes it"*
- a mechanical change, so they can skim it — *"rename only, no behaviour
  change"*

Never restate the diff (*"adds a null check"* — they can see that), never
narrate your process (*"I first tried X"*), never pad. If a file's change is
genuinely obvious, its summary can be one clause; a file needing no note gets
none. Under ~140 characters per note, no markdown, no line prefixes.

Say so plainly when something is unfinished or uncertain — *"only covers the
happy path, error branch is untested"* is exactly what a reviewer needs and
exactly what gets lost otherwise.

## 4. Write it

Pipe JSON to `prview --annotate`. Set `author` to the model id running this
session so the reader knows who wrote it.

```sh
cat <<'JSON' | prview --annotate
{
  "author": "<model id of this session>",
  "summaries": {
    "src/crypto.ts": "Real HMAC-SHA256 verification replacing the length-check stub; compares in constant time."
  },
  "notes": [
    { "path": "src/crypto.ts", "line": 9,
      "body": "Length check first: timingSafeEqual throws on unequal lengths rather than returning false." },
    { "path": "src/crypto.ts", "line": 6, "side": "new",
      "body": "base64url, not base64 — must match how the header encodes it." }
  ]
}
JSON
```

- `line` must be a line the diff touches, on the `new` side unless you pass
  `"side": "old"`. The note renders immediately **above** that line, so write
  it as something the reader meets before the code, not after. Context lines inside a hunk count, so you can annotate
  unchanged code next to your change. A line outside the diff is stored
  anyway, but warns and shows up detached from its code at the end of the
  file — treat a warning as a wrong line number and fix it.
- Re-running replaces the notes you previously wrote on the paths you write
  again, so refresh freely after further edits. Pass `"replace": false` to add
  without clearing.
- It exits non-zero with a specific message on a malformed payload. Fix and
  retry rather than falling back to editing `reviews.json` by hand.

## 5. Check it, then say where it is

```sh
prview --notes           # same range flags as step 1
```

Read the output, and check each note is on the line you meant — `--notes`
prints `L<n>`, so compare against step 2. If a summary or note reads as a
restatement of the diff, rewrite it: you are the last line of defence against
noise that costs the reader time.

Then tell the user the command that opens the review (`prview`, or the range
form you used), not just that you wrote notes.

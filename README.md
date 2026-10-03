# portfolio-sync

> **Status: v0.1, first real run pending.**

A Claude Code plugin that keeps a developer portfolio up to date. Tag a repo with the `portfolio` topic, run
`/portfolio-sync:sync`, and Claude drafts an entry in your portfolio's own format from the facts in that repo. You
tweak the draft in the conversation, it runs your build, and it opens a pull request. You review it on your host's
preview deployment and merge.

It runs on your Claude subscription: no API key, no extra cost.

## Why

I was tired of hand-editing my portfolio every time I shipped something. And an AI that writes about you unsupervised
is how invented claims end up on a resume. So portfolio-sync makes every claim cite a quote from the repo, and a
script rejects the draft if the quote isn't really there. Numbers that don't appear in the repo get flagged for
review. Nothing goes live without your merge.

## Install

You need Claude Code, the [GitHub CLI](https://cli.github.com) (logged in with `gh auth login`) and Node 22+.

```
/plugin marketplace add BenjiKataoka/portfolio-sync
/plugin install portfolio-sync@portfolio-sync
```

## Config

Add `.portfolio-sync.json` to your portfolio repo's root:

```json
{
  "file": "src/data/projects.ts",
  "marker": "// portfolio-sync:insert",
  "images": "src/assets/projects",
  "context": ["src/data/skills.ts"],
  "verify": "npm ci && npm run verify",
  "voice": "summary: the annoyance that started it, first person, one sentence. result: what it does, or the best metric in the README."
}
```

| Key | Meaning |
|---|---|
| `file` | The data file entries go into. Claude copies the format of the entries already there |
| `marker` | A line in that file. New entries are inserted above it |
| `images` | The folder the cover image is saved to |
| `context` | Other files Claude should read, such as a list of allowed tags (optional) |
| `verify` | The command that must pass before a PR is opened |
| `voice` | How entries should read (optional) |
| `topic` | The opt-in topic (optional, default `portfolio`) |

Then, from the portfolio repo, run `/portfolio-sync:sync`.

## Privacy

- **Claude reads what you opt in.** Tagged repos' README, description, topics, languages and images are read by
  Claude through your Claude Code session, the same as any file you open in Claude Code.
- **Private repos are opt-in twice.** A tagged private repo is only drafted after you say yes in the session, and
  scheduled runs skip private repos entirely. Once drafted, its name, quotes and cover image go on your portfolio,
  and the quotes also go in the PR description, which anyone can read if the portfolio repo is public.
- **Nothing leaves GitHub except image downloads.** GitHub data comes through `gh` with your login. Images hosted
  elsewhere are downloaded without credentials, from public `https` hosts only, at up to 10 MB each.
- **Facts stay in a private temp folder** (`$TMPDIR/portfolio-sync-<uid>`), readable only by you.
- **Repo content is treated as data.** The skill tells Claude never to follow instructions found inside a README or
  image.

## Limits

- Only repos owned by the same account as the portfolio repo are found (not repos in organizations).
- The data file needs a format that allows comments, so the marker line can exist: TS/JS, YAML, TOML, MDX or
  Markdown (`<!-- portfolio-sync:insert -->`). Plain JSON has no comments, so it isn't supported.
- A repo whose name appears in the data file as a quoted string, such as `'Burnrate'`, counts as already listed.

## Opting out

- Remove the topic from a repo to stop it being proposed.
- Close a PR without merging, and that repo is never proposed again.

## Run it weekly

Claude Code [routines](https://code.claude.com/docs/en/routines) can run the sync on a schedule in the cloud,
using your subscription. Setup steps will be added here once they've been tested.

## License

MIT

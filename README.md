# portfolio-sync

> **Status: in design.** Nothing to install yet. See [docs/HANDOFF.md](docs/HANDOFF.md) for the plan.

A GitHub Action that keeps a developer portfolio up to date. Tag a repo with the `portfolio` topic, and portfolio-sync reads it (README, languages, topics, homepage, screenshots), drafts a project entry with Claude in your portfolio's own format, and opens a pull request on your portfolio repo. You review the draft on your host's preview deployment, edit if needed, and merge.

Nothing publishes on its own: every entry goes through a pull request you approve.

## Why

I was tired of hand-editing my portfolio every time I shipped something, and an AI that writes about you unsupervised is how invented claims end up on a resume. portfolio-sync drafts from facts in the repo only, and leaves the final say to you.

## Planned usage

```yaml
# .github/workflows/portfolio-sync.yml in your portfolio repo
on:
  schedule: [{ cron: '0 14 * * *' }]
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: benjikataoka/portfolio-sync@v1
        with:
          topic: portfolio
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## License

MIT

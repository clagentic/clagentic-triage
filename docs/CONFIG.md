# clagentic:triage — Configuration Reference

Configuration is loaded from (in priority order):
1. Environment variables (prefix: `CLAGENTIC_TRIAGE_`)
2. `triage.config.json` in the working directory
3. `~/.config/clagentic/triage/config.json`

## Full config schema

```json
{
  "source": {
    "adapter": "github",
    "org": "your-org",
    "repos": ["*"],
    "poll_interval_seconds": 60
  },
  "intent_file": ".github/CLAGENTIC_TRIAGE_INTENT.md",
  "model": "clagentic:router",
  "model_fallback": "claude-sonnet-4-5",
  "auto_approve": [],
  "pending_queue": ".triage/pending.jsonl",
  "dispatchers": [
    {
      "name": "lore",
      "project": "my-project"
    }
  ],
  "hooks": [
    {
      "name": "clagentic-console",
      "module": "@clagentic/triage-hook-console",
      "config": {}
    }
  ],
  "webhooks": {
    "enabled": false,
    "port": 8742,
    "secret": ""
  },
  "notifications": {
    "webhooks": []
  }
}
```

## Intent file

The intent file (`intent_file`) is a Markdown file committed to each watched repo that describes:
- What kinds of issues and PRs are in scope
- What good looks like for each
- Any repo-specific triage rules

If no intent file is found, the assessor falls back to a generic intent (no spam, must include reproduction steps, etc.).

Example `.github/CLAGENTIC_TRIAGE_INTENT.md`:

```markdown
# Triage Intent

## Accepted issues
- Bug reports with reproduction steps
- Feature requests aligned with the roadmap in ROADMAP.md

## Out of scope
- Support questions (redirect to discussions)
- Vague reports without steps

## Accepted PRs
- Bug fixes with tests
- Small, focused changes
- Must reference an issue

## Out of scope PRs
- Large refactors without prior issue
- Dependency bumps without changelog context
```

## Environment variable overrides

| Variable | Config key |
|---|---|
| `CLAGENTIC_TRIAGE_ADAPTER` | `source.adapter` |
| `CLAGENTIC_TRIAGE_ORG` | `source.org` |
| `CLAGENTIC_TRIAGE_REPOS` | `source.repos` (comma-separated) |
| `CLAGENTIC_TRIAGE_MODEL` | `model` |
| `CLAGENTIC_TRIAGE_GITHUB_TOKEN` | GitHub PAT |
| `CLAGENTIC_TRIAGE_AUTO_APPROVE` | `auto_approve` (comma-separated) |
| `CLAGENTIC_TRIAGE_WEBHOOK_SECRET` | `webhooks.secret` |

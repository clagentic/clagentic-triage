# Spam and Bot Protection

This document covers two layers of noise reduction: GitHub-native settings that block spam before any token is spent, and clagentic:triage config options that filter what does reach the assessment pipeline.

Run the GitHub-native controls first. They are free, take effect immediately, and eliminate the bulk of low-effort spam before a single LLM call fires.

---

## GitHub-native settings

### Interaction limits

**Settings > Moderation > Interaction limits**

Restrict who can open issues, comment, and submit PRs for a period (24 hours to 6 months). Options:

- Limit to existing GitHub users (eliminates brand-new throwaway accounts)
- Limit to prior contributors (tightest setting; appropriate for mature projects)
- Limit to repository collaborators (lockdown mode)

Effective against coordinated spam bursts from new accounts. No code changes required.

### Issue templates

**Settings > Features > Issues > Set up templates**

Require reporters to fill in a structured template (`.github/ISSUE_TEMPLATE/`). Submissions that do not use the template UI still open as issues but the empty or off-template structure is a strong noise signal the pre-filter can catch cheaply.

Templates reduce copy-paste boilerplate reports and empty-body submissions. The ISSUE_TEMPLATE directory pattern also allows `blank_issues_enabled: false` in `config.yml` to prevent bypassing templates entirely.

### Fork-based PRs (public repos)

Public repos already require external contributors to fork before opening a PR. No configuration needed. Direct push from unknown accounts is not possible without collaborator access.

### Protected branches with required PR reviews

**Settings > Branches > Branch protection rules**

Require at least one review before merging. This blocks bot-generated PRs that would otherwise auto-merge (e.g. via naive Actions workflows). Combined with `Restrict who can dismiss pull request reviews`, it prevents review bypass.

### Org-level base permissions

**Organization Settings > Member privileges**

Set base repository permissions to `Read` rather than `Write`. Limit forking to org members only if the repo contains sensitive content. These settings reduce the surface available to compromised member accounts.

### Actions fork workflow controls

**Settings > Actions > Fork pull request workflows**

Set to "Require approval for all outside collaborators" or "Require approval for first-time contributors". This prevents bots that open a PR and immediately trigger an Actions run from gaining a free compute surface. Relevant if your workflows post comments or labels — disabling this for first-timers also prevents prompt injection via workflow-triggered LLM calls.

### Probot and complementary GitHub Apps

Two well-known apps that complement clagentic:triage:

- **Sentiment Bot** (`github.com/probot/sentiment-bot`) — closes issues that contain clearly toxic content before a human or LLM reviews them.
- **No Response** (`github.com/probot/no-response`) — closes issues that are waiting on reporter follow-up and receive no reply within a configured window. Reduces stale noise in the pending queue.

These run as GitHub Apps and do not interact with clagentic:triage directly — they reduce the volume of events that reach the webhook or polling layer.

### Recommended starting point

Enable **interaction limits** (limit to existing users) and **issue templates** first. These two controls are free, reversible, and eliminate most anonymous spam before a single token is spent. Add protected-branch reviews and fork-workflow approval controls as the second step for repos that receive PR spam.

---

## clagentic:triage config options

### `source.ignore_logins`

Array of GitHub login names that are always skipped, regardless of their author_association. Use this to block known bot accounts or persistent bad actors by name.

```json
"source": {
  "ignore_logins": ["known-spam-bot", "dependency-auto-pr-bot"]
}
```

### `source.watch_associations`

Array of GitHub `author_association` values that are triaged. Events from logins whose association is not in this list are silently dropped before enrichment.

Default: `["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"]`

`MANNEQUIN` (migrated accounts) is included in the default but is generally low-risk. Remove it if it generates noise in your environment. `OWNER`, `MEMBER`, and `COLLABORATOR` are excluded from the default — events from trusted insiders do not need automated triage.

### `source.watch_logins`

Allowlist of GitHub login names that are always triaged, regardless of their author_association. When this list is non-empty, only these logins pass the association check. All others are dropped.

Use for highly restricted triage pipelines where you want to process a fixed set of accounts only.

### `pre_filter.enabled` + `pre_filter.model`

Enable the tier-1 noise filter to run a cheap LLM pass before the main assessor. Events classified as noise above the confidence threshold are rejected immediately without spending tokens on a full assessment.

```json
"pre_filter": {
  "enabled": true,
  "runner": "claude-cli",
  "model": "claude-haiku-3-5",
  "confidence_threshold": 0.8,
  "timeout_ms": 15000
}
```

Set `pre_filter.model` to the cheapest model available on your runner. The pre-filter prompt is deliberately short (binary classification only, no chain-of-thought, no intent context) so even a small model handles it reliably.

`pre_filter.runner` and `pre_filter.model` fall back to the main `runner` and `model` if unset. Set them explicitly to route tier-1 calls to a cheaper backend.

`pre_filter.confidence_threshold` (default `0.8`) controls how certain the pre-filter must be before dropping an event. A high threshold minimizes false positives — uncertain calls pass through to the main assessor. Lower it only after reviewing pre-filter logs to confirm accuracy on your event stream.

Events that fail the pre-filter receive a `reject` verdict with `pre_filter: true` in the assessment, making them identifiable in the pending queue.

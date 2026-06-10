# Intent File Authoring Guide

The intent file is the primary control surface for clagentic:triage. It tells the
assessor what belongs in the repo, what to do with things that don't, and what
context from the repo itself is worth reading before deciding.

The file lives at `.github/triage-intent.yml` in each watched repo.

---

## How it gets used

The enricher fetches the intent file from the repo via the adapter. It then reads
each file listed in `repo_context_files` and injects their contents as context
blocks. The full assembled context — intent rules plus referenced files — is
injected verbatim into the assessor's prompt as the "repository intent" section.

The assessor prompt is approximately:

```
You are a senior GitHub triage specialist. Assess this issue/PR against the
repository's intent and produce a triage verdict.

REPOSITORY INTENT:
<your llm_context text + referenced file contents go here>

ISSUE/PR:
<title, body, author, metadata>

Think step by step... output JSON verdict.
```

This means `llm_context` is prose that the LLM reads and reasons against. Write
it the way you would brief a careful human reviewer — not as a regex ruleset.

---

## Schema reference

```yaml
# Required: at least one triage_rules entry.
# Optional: repo_context_files pulls in existing docs rather than duplicating them.

repo_context_files:
  - path: CONTRIBUTING.md         # relative to repo root
  - path: docs/ROADMAP.md
  - path: .github/CODEOWNERS

triage_rules:
  - id: default                   # short identifier, used in logs
    description: "One-line summary shown in triage output"
    llm_context: |
      Multi-line prose that tells the LLM what belongs here
      and what to do with things that don't.
```

**Allowed file extensions for `repo_context_files`:** `.md`, `.txt`, `.yml`,
`.yaml`, `.json`, `.rst`. Credential files and `.env` files are blocked
regardless of what you list.

Multiple `triage_rules` entries are supported. Each gets its own `id` and
`llm_context`. The assessor sees all of them concatenated. Use multiple rules
when different event types (issues vs. PRs, bug reports vs. feature requests)
warrant different instructions.

---

## What to write in `llm_context`

**Tell it what is in scope.** Be specific about what event types, content
categories, or contributor types belong in this repo's issue tracker.

```yaml
llm_context: |
  This repo is the clagentic:console daemon — a terminal multiplexer for
  Claude Code sessions. Accept bug reports against the daemon, CLI, or
  session management behavior. Accept feature requests that fit the
  single-user terminal use case.
```

**Tell it what is out of scope and what to do about it.** The LLM needs
explicit routing instructions, not just rejection criteria.

```yaml
llm_context: |
  Redirect support questions (how do I configure X?) to Discussions —
  do not close them, respond with a pointer to the right place.

  Close spam, off-topic solicitations, and issues that are clearly about
  a different product. No response needed for those.

  Escalate anything that looks like a security vulnerability report
  rather than assessing it as a normal issue.
```

**Tell it what quality bar to apply.** The default is to request more
information when a report is incomplete — be explicit if you want different
behavior.

```yaml
llm_context: |
  Bug reports require: steps to reproduce, actual behavior, expected
  behavior, and clagentic-console version. Request info if any of these
  are missing. Do not close — leave open pending the response.

  Feature requests do not need a specific format. Accept them if they
  are coherent and on-topic, even without detailed specs.
```

**Use `repo_context_files` rather than duplicating content.** If you already
have a CONTRIBUTING.md with reproduction step requirements, reference it
instead of copying the rules into `llm_context`.

```yaml
repo_context_files:
  - path: CONTRIBUTING.md

triage_rules:
  - id: default
    llm_context: |
      Apply the contribution guidelines in CONTRIBUTING.md when assessing
      whether a bug report or feature request is complete enough to accept.
```

---

## Verdicts and action classes

The assessor maps your intent to one of these verdicts:

| Verdict | Meaning |
|---|---|
| `accept` | The event is in scope and complete. Suggested action: `dispatch`, `approve`, or label. |
| `needs_changes` | In scope but incomplete or needs revision. Suggested action: `respond` or `request_changes`. |
| `reject` | Out of scope or should be closed. Suggested action: `close` or `respond`. |
| `escalate` | Needs human review — security issues, ambiguous cases, high-stakes decisions. |
| `defer` | Temporarily hold — waiting for more information or a future milestone. |

Your `llm_context` should give the assessor enough signal to choose the right
verdict. If you find it consistently picking the wrong verdict for a case, add
a sentence to `llm_context` that explicitly names the verdict for that case:

```yaml
llm_context: |
  Security vulnerability reports must always get verdict "escalate",
  regardless of how well-formed they are. Never close or respond to them
  automatically.
```

---

## Confidence and HITL fallback

Every assessment includes a `confidence` score (0–1). If confidence falls
below `confidence_threshold` in config (default 0.7), the event is always
routed to human review regardless of `auto_approve` settings.

A well-written intent file produces higher-confidence assessments. Vague or
contradictory rules produce low confidence. If you see many events landing in
HITL with `low_confidence`, sharpen the rules.

---

## Iterating

1. Start with `auto_approve: []` (default). All assessments go to the pending
   queue — no actions taken automatically.
2. Run `clagentic-triage queue list` to inspect verdicts.
3. Tune `llm_context` until verdicts look right for a representative sample.
4. Enable `auto_approve` incrementally — `respond` first, then `close` only
   after you trust the reject cases.

---

## Minimal example

```yaml
# .github/triage-intent.yml
repo_context_files:
  - path: CONTRIBUTING.md

triage_rules:
  - id: default
    description: "General triage for this repository"
    llm_context: |
      Accept bug reports that include reproduction steps, actual behavior,
      and expected behavior. Request info if any of these are missing.

      Accept feature requests that are coherent and on-topic. No specific
      format required.

      Close spam, solicitations, and issues clearly about other products.

      Escalate anything that resembles a security vulnerability report.

      Redirect support questions to GitHub Discussions rather than closing.
```

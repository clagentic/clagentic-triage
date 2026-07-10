# clagentic:triage — Install & Update as a systemd service

This document covers running clagentic:triage as a long-lived `watch` process
under systemd. For quick local runs or a single one-shot `run` invocation you
don't need any of this — see the [README Quickstart](../README.md#quickstart).

The install process lives in `deploy/` and is a single idempotent script:
running it the first time installs the service; running it again updates in
place, skipping work when the target source revision is already installed
and the service is healthy. There is no separate "install" vs "update"
command — `deploy/install.sh` is both.

## What's in `deploy/`

| File | Purpose |
|---|---|
| `deploy/install.sh` | The installer/updater. Idempotent — safe to run on every deploy. |
| `deploy/clagentic-triage.service.template` | systemd unit **template**. Rendered at install time with host-specific values substituted from env config — never commit a rendered copy. |
| `deploy/clagentic-triage-run.template` | Run-wrapper **template** invoked by the unit's `ExecStart`. Also rendered at install time. |
| `deploy/.env.example` | Every installer knob, documented, with generic defaults. Copy to `deploy/.env` (or export the vars) and customize per host. |

Everything under `deploy/` is generic — no hostnames, install paths, tokens,
org/repo names, or usernames are hardcoded anywhere in the repo. Templates use
`@@PLACEHOLDER@@` tokens substituted by `install.sh` from `CLAGENTIC_TRIAGE_*`
env vars (see `deploy/.env.example` for the full list and defaults).

## First install

1. Create the runtime env file referenced by `CLAGENTIC_TRIAGE_ENV_FILE`
   (default `/etc/clagentic-triage/triage.env`) containing the app's own
   config — `CLAGENTIC_TRIAGE_GITHUB_TOKEN`, `CLAGENTIC_TRIAGE_ORG`, runner
   settings, etc. See the root [`.env.example`](../.env.example) and
   [docs/CONFIG.md](CONFIG.md) for the full app config reference. This is a
   separate concern from the installer knobs below — the installer only
   wires the systemd unit to read this file, it never creates or edits it.
2. Set installer env vars as needed (see `deploy/.env.example`) — at minimum
   you'll usually override `CLAGENTIC_TRIAGE_INSTALL_DIR` and
   `CLAGENTIC_TRIAGE_GIT_REMOTE`/`CLAGENTIC_TRIAGE_GIT_REF` if not using the
   defaults.
3. Run the installer (needs root or sudo for `/etc/systemd/system`, the
   default `/opt` install dir, and to create the service user — see below):
   ```
   curl -fsSL https://raw.githubusercontent.com/clagentic/clagentic-triage/main/deploy/install.sh | sudo -E bash
   ```
   or, from a local clone:
   ```
   sudo -E bash deploy/install.sh
   ```

Every run first registers `CLAGENTIC_TRIAGE_INSTALL_DIR` as a git
`safe.directory` for the invoking user (`git config --global --add
safe.directory ...`) before touching the checkout with git. This matters
because install.sh hands ownership of the checkout to
`CLAGENTIC_TRIAGE_RUN_USER` at the end of every run, but a later run may be
invoked by a different account (root, or an automation user) — without this,
git >= 2.35.2 refuses to operate on the checkout with "detected dubious
ownership". The registration is idempotent and scoped to the invoking user's
own gitconfig; it does not relax trust for any other account on the host.

The first run clones the repo to `CLAGENTIC_TRIAGE_INSTALL_DIR`, idempotently
creates the `CLAGENTIC_TRIAGE_RUN_USER`/`CLAGENTIC_TRIAGE_RUN_GROUP` system
account if it does not already exist (`useradd --system --no-create-home
--shell /usr/sbin/nologin`), runs `npm ci --omit=dev`, hands ownership of
`CLAGENTIC_TRIAGE_INSTALL_DIR` to that account, renders the unit and
run-wrapper templates, and enables + starts the `clagentic-triage` systemd
unit (service name configurable via `CLAGENTIC_TRIAGE_SERVICE_NAME`).

### Service user provisioning

The rendered systemd unit sets `User=`/`Group=` to
`CLAGENTIC_TRIAGE_RUN_USER`/`CLAGENTIC_TRIAGE_RUN_GROUP`. A unit referencing
an account that does not exist fails every start with systemd
`status=217/USER` and auto-restarts forever — install.sh prevents this by
provisioning the account itself, before ever rendering the unit:

- If the account already exists (e.g. you provisioned it separately, or set
  `CLAGENTIC_TRIAGE_RUN_USER`/`_GROUP` to an existing service account),
  install.sh detects this and does not touch it — safe to run repeatedly.
- If it is missing and `useradd`/`groupadd` are available (the installer is
  running as root), install.sh creates it: `groupadd --system
  ${RUN_GROUP}` then `useradd --system --no-create-home --shell
  /usr/sbin/nologin --gid ${RUN_GROUP} ${RUN_USER}`.
- If it is missing and creation is not permitted (not running as root, or
  `useradd`/`groupadd` unavailable), install.sh **fails loudly** with an
  actionable message rather than rendering a unit that can never start.
- Set `CLAGENTIC_TRIAGE_SKIP_USER_PROVISION=1` to make install.sh only
  preflight-verify the account exists (same loud failure if it's missing)
  instead of creating it — use this if account provisioning is handled by a
  separate config-management tool.

After provisioning (or verifying) the account, install.sh runs `chown -R
${RUN_USER}:${RUN_GROUP}` on `CLAGENTIC_TRIAGE_INSTALL_DIR` so the service
can read its own checkout and write its own runtime state (e.g.
`.triage/*.jsonl`, written relative to the unit's `WorkingDirectory`) without
relaxing the unit's `ProtectHome`/`ProtectSystem` hardening.

## Update

Run the same script again:

```
sudo -E bash /opt/clagentic-triage/deploy/install.sh
```

(adjust the path if `CLAGENTIC_TRIAGE_INSTALL_DIR` was overridden). The
installer is self-shipping — because it syncs the git checkout before doing
anything else, `deploy/install.sh` in the checkout is itself always the
latest version from the target ref before the idempotency gate runs.

The gate compares the checkout's HEAD commit against a marker file
(`.installed-sha`) written by the previous successful install, and checks
whether the systemd unit is currently active. It skips all work (no restart)
when the source is unchanged and the unit is healthy; otherwise it
reinstalls dependencies, re-renders templates, and restarts the unit.

Set `CLAGENTIC_TRIAGE_FORCE_UPDATE=1` to bypass the gate and force a
reinstall/restart regardless of state (e.g. to pick up an env file change
that doesn't move HEAD).

## Automated deploy (NAOMI post-merge)

`.crew/naomi.yaml` invokes `deploy/install.sh` in `post_merge_steps` after
every merge to `main`. The invocation is host-agnostic — it does not SSH to
any named machine. Instead it assumes `deploy/install.sh` is being run
*on* the deploy host (e.g. by a runner/agent that already has a shell on
that host, or by a scheduled job on the host itself that periodically
re-invokes the installer). All host selection is external to this repo —
supply `CLAGENTIC_TRIAGE_INSTALL_DIR` etc. via the environment the step
runs in.

## Logs and health

- Structured log lines: every gate decision and install step is logged to
  stdout as `[clagentic-triage-install] ...` (captured by NAOMI / your CI
  logs, or visible directly when run interactively).
- Service logs: `journalctl -u clagentic-triage -f` (substitute your
  `CLAGENTIC_TRIAGE_SERVICE_NAME` if overridden).
- Service status: `systemctl status clagentic-triage`.

## Dry run / partial install

- `CLAGENTIC_TRIAGE_SKIP_NPM_CI=1` — skip `npm ci` (e.g. deps pre-vendored).
- `CLAGENTIC_TRIAGE_SKIP_SYSTEMD=1` — skip rendering/enabling/starting the
  systemd unit (and skip service-user provisioning, since no unit will
  reference it); useful to only sync source + deps, or on a host where
  systemd is managed out-of-band.
- `CLAGENTIC_TRIAGE_SKIP_USER_PROVISION=1` — skip creating the service user;
  only preflight-verify it exists (see "Service user provisioning" above).

See `deploy/.env.example` for the complete list of installer env vars.

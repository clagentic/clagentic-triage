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

1. Provision a system user for the service (the installer does not create
   one):
   ```
   useradd --system --no-create-home clagentic-triage
   ```
2. Create the runtime env file referenced by `CLAGENTIC_TRIAGE_ENV_FILE`
   (default `/etc/clagentic-triage/triage.env`) containing the app's own
   config — `CLAGENTIC_TRIAGE_GITHUB_TOKEN`, `CLAGENTIC_TRIAGE_ORG`, runner
   settings, etc. See the root [`.env.example`](../.env.example) and
   [docs/CONFIG.md](CONFIG.md) for the full app config reference. This is a
   separate concern from the installer knobs below — the installer only
   wires the systemd unit to read this file, it never creates or edits it.
3. Set installer env vars as needed (see `deploy/.env.example`) — at minimum
   you'll usually override `CLAGENTIC_TRIAGE_INSTALL_DIR` and
   `CLAGENTIC_TRIAGE_GIT_REMOTE`/`CLAGENTIC_TRIAGE_GIT_REF` if not using the
   defaults.
4. Run the installer (needs root or sudo for `/etc/systemd/system` and the
   default `/opt` install dir):
   ```
   curl -fsSL https://raw.githubusercontent.com/clagentic/clagentic-triage/main/deploy/install.sh | sudo -E bash
   ```
   or, from a local clone:
   ```
   sudo -E bash deploy/install.sh
   ```

The first run clones the repo to `CLAGENTIC_TRIAGE_INSTALL_DIR`, runs
`npm ci --omit=dev`, renders the unit and run-wrapper templates, and enables
+ starts the `clagentic-triage` systemd unit (service name configurable via
`CLAGENTIC_TRIAGE_SERVICE_NAME`).

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
  systemd unit; useful to only sync source + deps, or on a host where
  systemd is managed out-of-band.

See `deploy/.env.example` for the complete list of installer env vars.

#!/usr/bin/env bash
# install.sh — idempotent install/update funnel for clagentic-triage (lr-47370c)
#
# Single entry point for both first-time install and every subsequent
# update. Every caller (NAOMI post_merge_steps, a manual operator run, CI)
# routes through this script so the idempotency gate applies everywhere,
# not just one call site. Modeled on lore-archivist's deploy/archivist-update.sh
# + archivist-deploy.sh (see /workspace/lore/repo/deploy/ in the LORE repo),
# adapted for a bare Node systemd service instead of a Docker container.
#
# Gate logic:
#   Compare the installed checkout's HEAD commit (after git sync) against
#   the git ref requested. Equal AND the systemd unit is active -> skip
#   restart. A source delta OR an inactive/missing unit triggers a
#   (re)install: npm ci, render unit + run-wrapper templates, reload
#   systemd, (re)start.
#
# Override:
#   CLAGENTIC_TRIAGE_FORCE_UPDATE=1  — bypass the gate, always reinstall/restart.
#
# Structured log lines written to stdout on every gate decision:
#   [clagentic-triage-install] skip    — already current, reason=...
#   [clagentic-triage-install] install — reason=...
#   [clagentic-triage-install] forced  — CLAGENTIC_TRIAGE_FORCE_UPDATE=1
#
# ALL paths and identifiers below are env-driven with generic defaults — see
# deploy/.env.example. No hostnames, install paths, tokens, org/repo names,
# or usernames are hardcoded in this script; this repo is public (FSL-1.1-MIT).
#
# Location once installed: ${INSTALL_DIR}/deploy/install.sh (shipped via the
# git-sync step below, so the script self-updates on every run after the
# first invocation on a given host).

set -euo pipefail

# ---------------------------------------------------------------------------
# Config — all paths via env or well-known generic defaults; no hardcoded
# operator values (CLAUDE.md rule 11 / task lr-47370c hard constraint).
# ---------------------------------------------------------------------------
INSTALL_DIR="${CLAGENTIC_TRIAGE_INSTALL_DIR:-/opt/clagentic-triage}"
GIT_REMOTE="${CLAGENTIC_TRIAGE_GIT_REMOTE:-https://github.com/clagentic/clagentic-triage}"
GIT_REF="${CLAGENTIC_TRIAGE_GIT_REF:-main}"
SERVICE_NAME="${CLAGENTIC_TRIAGE_SERVICE_NAME:-clagentic-triage}"
RUN_USER="${CLAGENTIC_TRIAGE_RUN_USER:-clagentic-triage}"
RUN_GROUP="${CLAGENTIC_TRIAGE_RUN_GROUP:-clagentic-triage}"
SYSTEMD_UNIT_DIR="${CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
ENV_FILE="${CLAGENTIC_TRIAGE_ENV_FILE:-/etc/clagentic-triage/triage.env}"
NODE_BIN="${CLAGENTIC_TRIAGE_NODE_BIN:-/usr/bin/node}"
# GitHub App private key file path (lr-4f59b5). Rendered into the unit's
# EnvironmentFile-adjacent Environment= line so a fresh install supports
# GitHub App auth via a mounted/deployed key file without a manual ExecStart
# override. Configurable per-host; unset by default (PAT or inline-env PEM
# auth continue to work unchanged if this is not set).
GITHUB_APP_PRIVATE_KEY_FILE="${CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE:-}"
FORCE="${CLAGENTIC_TRIAGE_FORCE_UPDATE:-0}"
SKIP_NPM_CI="${CLAGENTIC_TRIAGE_SKIP_NPM_CI:-0}"
SKIP_SYSTEMD="${CLAGENTIC_TRIAGE_SKIP_SYSTEMD:-0}"
SKIP_USER_PROVISION="${CLAGENTIC_TRIAGE_SKIP_USER_PROVISION:-0}"

RUN_WRAPPER_PATH="${INSTALL_DIR}/deploy/clagentic-triage-run"
UNIT_PATH="${SYSTEMD_UNIT_DIR}/${SERVICE_NAME}.service"

_log() {
    echo "[clagentic-triage-install] $*"
}

# ---------------------------------------------------------------------------
# _provision_run_identity — idempotently ensure RUN_GROUP/RUN_USER exist
# before the rendered unit ever references them as User=/Group=. Without
# this, a fresh host renders a unit pointing at a nonexistent account and
# systemd fails every start with status=217/USER (lr-7de17d).
#
# Skips silently when SKIP_SYSTEMD=1 (no unit is rendered, so there is
# nothing to provision for) or when SKIP_USER_PROVISION=1 (operator manages
# the service account out-of-band and wants install.sh to only verify it).
# On any host where creation is not permitted (non-root, useradd/groupadd
# unavailable), fails loudly with an actionable message instead of writing
# a unit that can never start — never a silent no-op.
# ---------------------------------------------------------------------------
_provision_run_identity() {
    if [ "${SKIP_USER_PROVISION}" = "1" ]; then
        _log "skipping run-identity provisioning (CLAGENTIC_TRIAGE_SKIP_USER_PROVISION=1)"
        if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
            _log "FATAL: RUN_USER=${RUN_USER} does not exist and provisioning was skipped."
            _log "Create it before running install.sh, e.g.:"
            _log "  useradd --system --no-create-home --shell /usr/sbin/nologin ${RUN_USER}"
            _log "or set CLAGENTIC_TRIAGE_RUN_USER to an existing service account."
            exit 1
        fi
        return 0
    fi

    if ! getent group "${RUN_GROUP}" >/dev/null 2>&1; then
        if command -v groupadd >/dev/null 2>&1; then
            _log "creating group ${RUN_GROUP} (system group)"
            groupadd --system "${RUN_GROUP}"
        else
            _log "FATAL: group ${RUN_GROUP} does not exist and 'groupadd' is not available."
            _log "Create it manually, e.g.: groupadd --system ${RUN_GROUP}"
            _log "or set CLAGENTIC_TRIAGE_RUN_GROUP to an existing group."
            exit 1
        fi
    fi

    if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
        if command -v useradd >/dev/null 2>&1; then
            _log "creating system user ${RUN_USER} (group=${RUN_GROUP}, no home, nologin shell)"
            if ! useradd --system --no-create-home --shell /usr/sbin/nologin \
                --gid "${RUN_GROUP}" "${RUN_USER}"; then
                _log "FATAL: 'useradd' failed for RUN_USER=${RUN_USER}."
                _log "This usually means install.sh is not running as root/sudo."
                _log "Create the user manually, e.g.:"
                _log "  useradd --system --no-create-home --shell /usr/sbin/nologin --gid ${RUN_GROUP} ${RUN_USER}"
                _log "or set CLAGENTIC_TRIAGE_RUN_USER to an existing service account."
                exit 1
            fi
        else
            _log "FATAL: user ${RUN_USER} does not exist and 'useradd' is not available."
            _log "Create it manually or set CLAGENTIC_TRIAGE_RUN_USER=<existing-user>."
            exit 1
        fi
    fi

    _log "run identity verified: user=${RUN_USER} group=${RUN_GROUP}"
}

# ---------------------------------------------------------------------------
# Shell-level mutex — prevent concurrent install/update runs racing on the
# same host (e.g. two NAOMI post-merge invocations overlapping).
# ---------------------------------------------------------------------------
_LOCK_FILE="${TMPDIR:-/tmp}/clagentic-triage-install.lock"
exec 9>"${_LOCK_FILE}"
if ! flock -n 9; then
    _log "skip — another install/update already running (lock held by $(cat "${_LOCK_FILE}" 2>/dev/null || echo unknown))"
    exit 0
fi
echo $$ > "${_LOCK_FILE}"

# ---------------------------------------------------------------------------
# Step 1 — git sync (clone on first run, fetch+checkout thereafter). Always
# idempotent regardless of prior state.
# ---------------------------------------------------------------------------
if [ ! -d "${INSTALL_DIR}/.git" ]; then
    _log "no checkout found at ${INSTALL_DIR}; cloning ${GIT_REMOTE}"
    mkdir -p "$(dirname "${INSTALL_DIR}")"
    git clone "${GIT_REMOTE}" "${INSTALL_DIR}"
fi

_log "syncing git: ${INSTALL_DIR} (ref=${GIT_REF})"
git -C "${INSTALL_DIR}" fetch origin "${GIT_REF}"
# reset --hard tolerates a dirty working tree (e.g. files staged in for
# bootstrapping). Safe because this is a pure deploy checkout — no
# intentional local work lives here.
git -C "${INSTALL_DIR}" checkout "${GIT_REF}"
git -C "${INSTALL_DIR}" reset --hard "origin/${GIT_REF}"

REPO_SHA="$(git -C "${INSTALL_DIR}" rev-parse HEAD)"
_log "repo HEAD: ${REPO_SHA}"

# ---------------------------------------------------------------------------
# Step 2 — Force override
# ---------------------------------------------------------------------------
if [ "${FORCE}" = "1" ]; then
    _log "forced — CLAGENTIC_TRIAGE_FORCE_UPDATE=1; bypassing gate"
    _do_install=1
else
    _do_install=0

    INSTALLED_SHA=""
    _installed_sha_file="${INSTALL_DIR}/.installed-sha"
    if [ -f "${_installed_sha_file}" ]; then
        INSTALLED_SHA="$(cat "${_installed_sha_file}")"
    fi
    _log "installed source_commit: ${INSTALLED_SHA:-<none>}"

    _unit_active=0
    if [ "${SKIP_SYSTEMD}" != "1" ] && systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        _unit_active=1
    fi
    _log "unit active: ${_unit_active}"

    if [ -z "${INSTALLED_SHA}" ]; then
        _log "install — no prior install marker"
        _do_install=1
    elif [ "${INSTALLED_SHA}" != "${REPO_SHA}" ]; then
        _log "install — source delta: ${INSTALLED_SHA} -> ${REPO_SHA}"
        _do_install=1
    elif [ "${SKIP_SYSTEMD}" != "1" ] && [ "${_unit_active}" = "0" ]; then
        _log "install — source unchanged but unit not active; reinstalling"
        _do_install=1
    else
        _log "skip — source unchanged (${REPO_SHA}), unit active"
        exit 0
    fi
fi

# ---------------------------------------------------------------------------
# Step 3 — Install path: run-identity, deps, template rendering, systemd
# (re)load+restart
# ---------------------------------------------------------------------------
if [ "${SKIP_SYSTEMD}" = "1" ]; then
    _log "skipping run-identity provisioning (CLAGENTIC_TRIAGE_SKIP_SYSTEMD=1; no unit will be rendered)"
else
    _provision_run_identity
fi

if [ "${SKIP_NPM_CI}" = "1" ]; then
    _log "skipping npm ci (CLAGENTIC_TRIAGE_SKIP_NPM_CI=1)"
else
    _log "installing dependencies (npm ci --omit=dev)..."
    (cd "${INSTALL_DIR}" && npm ci --omit=dev)
fi

if [ "${SKIP_SYSTEMD}" != "1" ]; then
    # WorkingDirectory in the rendered unit is INSTALL_DIR, and the service
    # writes runtime state there (e.g. .triage/*.jsonl, cwd-relative — see
    # src/queue.js, src/task_index.js). Hand ownership to the service
    # identity (after git sync + npm ci, both done as the installer's own
    # user/root, so root-owned node_modules are re-owned too) so it can
    # read its own checkout and write its own state without relaxing
    # systemd's ProtectHome/ProtectSystem hardening.
    _log "setting ownership of ${INSTALL_DIR} to ${RUN_USER}:${RUN_GROUP}"
    chown -R "${RUN_USER}:${RUN_GROUP}" "${INSTALL_DIR}"
fi

# Rendered as a full "Environment=..." line only when
# CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE is set on the installer host;
# otherwise the placeholder line is deleted outright (not just left blank) so
# an unset value never ships a dangling Environment= line pointing at an
# empty path.
_github_app_key_file_env_line=""
if [ -n "${GITHUB_APP_PRIVATE_KEY_FILE}" ]; then
    _github_app_key_file_env_line="Environment=CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE=${GITHUB_APP_PRIVATE_KEY_FILE}"
fi

_render_template() {
    # $1 = template path, $2 = output path
    local _tmpl="$1"
    local _out="$2"
    _log "rendering $(basename "${_tmpl}") -> ${_out}"
    mkdir -p "$(dirname "${_out}")"
    # Second stage: when no key-file path is configured, delete the
    # placeholder line outright rather than substituting an empty value
    # (which would leave a dangling blank line in the unit); otherwise
    # substitute the resolved Environment= line.
    local _key_file_stage
    if [ -n "${_github_app_key_file_env_line}" ]; then
        _key_file_stage="s#@@GITHUB_APP_PRIVATE_KEY_FILE_ENV_LINE@@#${_github_app_key_file_env_line}#g"
    else
        _key_file_stage="/@@GITHUB_APP_PRIVATE_KEY_FILE_ENV_LINE@@/d"
    fi
    sed \
        -e "s#@@INSTALL_DIR@@#${INSTALL_DIR}#g" \
        -e "s#@@RUN_USER@@#${RUN_USER}#g" \
        -e "s#@@RUN_GROUP@@#${RUN_GROUP}#g" \
        -e "s#@@ENV_FILE@@#${ENV_FILE}#g" \
        -e "s#@@RUN_WRAPPER_PATH@@#${RUN_WRAPPER_PATH}#g" \
        -e "s#@@NODE_BIN@@#${NODE_BIN}#g" \
        -e "${_key_file_stage}" \
        "${_tmpl}" > "${_out}"
}

_render_template "${INSTALL_DIR}/deploy/clagentic-triage-run.template" "${RUN_WRAPPER_PATH}"
chmod +x "${RUN_WRAPPER_PATH}"
if [ "${SKIP_SYSTEMD}" != "1" ]; then
    # Rendered after the bulk chown above, so re-own this one file too —
    # otherwise it is left root-owned even though the rest of INSTALL_DIR
    # belongs to RUN_USER:RUN_GROUP.
    chown "${RUN_USER}:${RUN_GROUP}" "${RUN_WRAPPER_PATH}"
fi

if [ "${SKIP_SYSTEMD}" = "1" ]; then
    _log "skipping systemd unit install (CLAGENTIC_TRIAGE_SKIP_SYSTEMD=1)"
else
    _render_template "${INSTALL_DIR}/deploy/clagentic-triage.service.template" "${UNIT_PATH}"

    _log "reloading systemd daemon..."
    systemctl daemon-reload

    _log "enabling ${SERVICE_NAME}..."
    systemctl enable "${SERVICE_NAME}"

    _log "restarting ${SERVICE_NAME}..."
    systemctl restart "${SERVICE_NAME}"

    _log "waiting for ${SERVICE_NAME} to report active..."
    _elapsed=0
    _active=0
    while [ "${_elapsed}" -lt 30 ]; do
        if systemctl is-active --quiet "${SERVICE_NAME}"; then
            _active=1
            break
        fi
        sleep 2
        _elapsed=$(( _elapsed + 2 ))
    done

    if [ "${_active}" = "1" ]; then
        _log "active after ${_elapsed}s"
    else
        _log "WARNING: ${SERVICE_NAME} did not report active within 30s -- check: journalctl -u ${SERVICE_NAME}"
    fi
fi

echo "${REPO_SHA}" > "${INSTALL_DIR}/.installed-sha"
_log "install complete — source_commit=${REPO_SHA}"

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
FORCE="${CLAGENTIC_TRIAGE_FORCE_UPDATE:-0}"
SKIP_NPM_CI="${CLAGENTIC_TRIAGE_SKIP_NPM_CI:-0}"
SKIP_SYSTEMD="${CLAGENTIC_TRIAGE_SKIP_SYSTEMD:-0}"

RUN_WRAPPER_PATH="${INSTALL_DIR}/deploy/clagentic-triage-run"
UNIT_PATH="${SYSTEMD_UNIT_DIR}/${SERVICE_NAME}.service"

_log() {
    echo "[clagentic-triage-install] $*"
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
# Step 3 — Install path: deps, template rendering, systemd (re)load+restart
# ---------------------------------------------------------------------------
if [ "${SKIP_NPM_CI}" = "1" ]; then
    _log "skipping npm ci (CLAGENTIC_TRIAGE_SKIP_NPM_CI=1)"
else
    _log "installing dependencies (npm ci --omit=dev)..."
    (cd "${INSTALL_DIR}" && npm ci --omit=dev)
fi

_render_template() {
    # $1 = template path, $2 = output path
    local _tmpl="$1"
    local _out="$2"
    _log "rendering $(basename "${_tmpl}") -> ${_out}"
    mkdir -p "$(dirname "${_out}")"
    sed \
        -e "s#@@INSTALL_DIR@@#${INSTALL_DIR}#g" \
        -e "s#@@RUN_USER@@#${RUN_USER}#g" \
        -e "s#@@RUN_GROUP@@#${RUN_GROUP}#g" \
        -e "s#@@ENV_FILE@@#${ENV_FILE}#g" \
        -e "s#@@RUN_WRAPPER_PATH@@#${RUN_WRAPPER_PATH}#g" \
        -e "s#@@NODE_BIN@@#${NODE_BIN}#g" \
        "${_tmpl}" > "${_out}"
}

_render_template "${INSTALL_DIR}/deploy/clagentic-triage-run.template" "${RUN_WRAPPER_PATH}"
chmod +x "${RUN_WRAPPER_PATH}"

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

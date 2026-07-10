/**
 * Regression coverage for lr-7de17d: deploy/install.sh must not render a
 * systemd unit's User=/Group= pointing at an account that does not exist.
 *
 * The rendered unit crash-loops with systemd status=217/USER when
 * RUN_USER has never been created (see docs/DEPLOY.md history + the
 * lr-7de17d task description for the verified live failure). These tests
 * exercise deploy/install.sh's `_provision_run_identity` behaviour end to
 * end by running the real script against a temp INSTALL_DIR with stub
 * `useradd`/`groupadd`/`id`/`getent`/`chown`/`systemctl`/`git`/`npm`
 * binaries on PATH — no real root privileges or system mutation involved.
 *
 * Uses Node's built-in test runner. No external deps.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = join(__dirname, '..', 'deploy', 'install.sh');

/**
 * Build a fake bin/ directory containing stub implementations of every
 * external command install.sh shells out to, backed by a shared "system
 * state" JSON file so stubs can see each other's effects (e.g. `id -u`
 * succeeding once `useradd`'s stub has "created" the account).
 */
function makeFakeSystem(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ users: [], groups: [], chowned: [] }));

  const write = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(p, 0o755);
  };

  write('id', `
if [ "$1" = "-u" ]; then
  user="$2"
  if python3 -c "import json,sys; sys.exit(0 if sys.argv[1] in json.load(open('${stateFile}'))['users'] else 1)" "$user"; then
    echo 1000
    exit 0
  else
    exit 1
  fi
fi
exit 1
`);

  write('getent', `
if [ "$1" = "group" ]; then
  group="$2"
  if python3 -c "import json,sys; sys.exit(0 if sys.argv[1] in json.load(open('${stateFile}'))['groups'] else 1)" "$group"; then
    exit 0
  else
    exit 2
  fi
fi
exit 2
`);

  write('useradd', `
python3 - "$@" <<'PYEOF'
import json, sys
state = json.load(open("${stateFile}"))
user = sys.argv[-1]
state['users'].append(user)
json.dump(state, open("${stateFile}", 'w'))
PYEOF
exit 0
`);

  write('groupadd', `
python3 - "$@" <<'PYEOF'
import json, sys
state = json.load(open("${stateFile}"))
group = sys.argv[-1]
state['groups'].append(group)
json.dump(state, open("${stateFile}", 'w'))
PYEOF
exit 0
`);

  write('chown', `
python3 - "$@" <<'PYEOF'
import json, sys
state = json.load(open("${stateFile}"))
state['chowned'].append(sys.argv[1:])
json.dump(state, open("${stateFile}", 'w'))
PYEOF
exit 0
`);

  write('systemctl', `
case "$1" in
  is-active) exit 0 ;;
  daemon-reload|enable|restart) exit 0 ;;
  *) exit 0 ;;
esac
`);

  write('git', `
sub="$1"; shift
case "$sub" in
  clone)
    dest="\${@: -1}"
    mkdir -p "$dest/.git"
    mkdir -p "$dest/deploy"
    exit 0
    ;;
  -C)
    repo="$1"; shift
    action="$1"
    case "$action" in
      fetch) exit 0 ;;
      checkout) exit 0 ;;
      reset) exit 0 ;;
      rev-parse) echo "deadbeefcafef00d0000000000000000000000" ;;
    esac
    exit 0
    ;;
esac
exit 0
`);

  write('npm', `exit 0`);
  write('flock', `
# no-op mutex stub: just run the wrapped fd-based lock check as a success.
exit 0
`);

  return { binDir, stateFile };
}

function seedInstallDir(installDir) {
  mkdirSync(join(installDir, '.git'), { recursive: true });
  mkdirSync(join(installDir, 'deploy'), { recursive: true });
  writeFileSync(
    join(installDir, 'deploy', 'clagentic-triage-run.template'),
    'cd "@@INSTALL_DIR@@"\nexec "@@NODE_BIN@@" src/cli.js watch\n',
  );
  writeFileSync(
    join(installDir, 'deploy', 'clagentic-triage.service.template'),
    '[Service]\nUser=@@RUN_USER@@\nGroup=@@RUN_GROUP@@\nWorkingDirectory=@@INSTALL_DIR@@\n',
  );
}

function runInstall(env, extraPath) {
  const fullEnv = {
    ...process.env,
    ...env,
    PATH: `${extraPath}:${process.env.PATH}`,
  };
  return spawnSync('bash', [INSTALL_SH], { env: fullEnv, encoding: 'utf8' });
}

describe('deploy/install.sh — run-identity provisioning (lr-7de17d)', () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'clagentic-install-test-'));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('creates the missing service user+group before rendering the unit, and the rendered unit references a user that now exists', () => {
    const caseDir = join(workDir, 'happy-path');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir, stateFile } = makeFakeSystem(caseDir);

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.ok(state.users.includes('clagentic-triage-test'), 'useradd stub should have been invoked for the missing user');
    assert.ok(state.groups.includes('clagentic-triage-test'), 'groupadd stub should have been invoked for the missing group');

    const unitPath = join(unitDir, 'clagentic-triage.service');
    assert.ok(existsSync(unitPath), 'unit should have been rendered');
    const unitContents = readFileSync(unitPath, 'utf8');
    assert.match(unitContents, /User=clagentic-triage-test/);
    assert.match(unitContents, /Group=clagentic-triage-test/);

    // Ownership of INSTALL_DIR must be handed to the service identity so
    // the unit's WorkingDirectory is usable by RUN_USER at runtime.
    const chownCalls = state.chowned.map((args) => args.join(' '));
    assert.ok(
      chownCalls.some((c) => c.startsWith('clagentic-triage-test:clagentic-triage-test') && c.includes(installDir)),
      `expected a chown of ${installDir} to the service identity, got: ${JSON.stringify(chownCalls)}`,
    );
  });

  it('is idempotent: does not fail or re-invoke useradd/groupadd when the account already exists', () => {
    const caseDir = join(workDir, 'idempotent');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir, stateFile } = makeFakeSystem(caseDir);
    // Pre-seed the account as already existing.
    writeFileSync(stateFile, JSON.stringify({ users: ['clagentic-triage-test'], groups: ['clagentic-triage-test'], chowned: [] }));

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    // useradd/groupadd stubs append to the list every time they run — an
    // already-existing account must short-circuit the create branch.
    assert.equal(state.users.filter((u) => u === 'clagentic-triage-test').length, 1);
    assert.equal(state.groups.filter((g) => g === 'clagentic-triage-test').length, 1);
  });

  it('fails loudly with an actionable message when creation is not permitted (useradd unavailable) instead of rendering an unstartable unit', () => {
    const caseDir = join(workDir, 'no-useradd');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    // Remove the useradd stub to simulate "creation isn't permitted /
    // useradd unavailable" (e.g. non-root, minimal container).
    rmSync(join(binDir, 'useradd'));

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.notEqual(result.status, 0, 'install.sh must fail rather than render an unstartable unit');
    assert.match(result.stdout, /FATAL.*useradd/i);
    assert.match(result.stdout, /CLAGENTIC_TRIAGE_RUN_USER/);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    assert.ok(!existsSync(unitPath), 'unit must not be rendered when the run identity could not be provisioned');
  });

  it('CLAGENTIC_TRIAGE_SKIP_USER_PROVISION=1 with a pre-existing user succeeds and renders the unit, without creating anything', () => {
    const caseDir = join(workDir, 'skip-provision-present');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir, stateFile } = makeFakeSystem(caseDir);
    // Pre-seed the account as already existing — SKIP_USER_PROVISION=1's
    // preflight-verify branch should find it and return success without
    // ever invoking useradd/groupadd.
    writeFileSync(stateFile, JSON.stringify({ users: ['clagentic-triage-test'], groups: ['clagentic-triage-test'], chowned: [] }));
    // Remove the useradd/groupadd stubs entirely — if the success path
    // mistakenly tried to create the account, the run would fail loudly
    // (command not found) rather than silently passing.
    rmSync(join(binDir, 'useradd'));
    rmSync(join(binDir, 'groupadd'));

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_SKIP_USER_PROVISION: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.equal(result.status, 0, `install.sh should succeed when SKIP_USER_PROVISION=1 and the user already exists: ${result.stderr}\n${result.stdout}`);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    assert.ok(existsSync(unitPath), 'unit should have been rendered — preflight-verify found the account present');
    const unitContents = readFileSync(unitPath, 'utf8');
    assert.match(unitContents, /User=clagentic-triage-test/);
    assert.match(unitContents, /Group=clagentic-triage-test/);

    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(state.users.length, 1, 'useradd must not have been invoked');
    assert.equal(state.groups.length, 1, 'groupadd must not have been invoked');
  });

  it('CLAGENTIC_TRIAGE_SKIP_USER_PROVISION=1 with a missing user fails preflight with an actionable message', () => {
    const caseDir = join(workDir, 'skip-provision-missing');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_SKIP_USER_PROVISION: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /FATAL.*does not exist/i);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    assert.ok(!existsSync(unitPath), 'unit must not be rendered when preflight-verify finds the user missing');
  });
});

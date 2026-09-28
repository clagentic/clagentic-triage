/**
 * Regression coverage: a persistently-failing clagentic-triage.service
 * (e.g. status=217/USER because RUN_USER was removed from the host after
 * install) must not restart forever.
 *
 * Verified live: RestartSec=5 alone never trips systemd's default
 * StartLimit (5 starts / 10s default window) because every restart is
 * spaced exactly 5s apart — tens of thousands of restarts were observed
 * over a multi-day window on a real deploy host. This suite asserts the
 * rendered unit carries an explicit StartLimitIntervalSec/StartLimitBurst
 * bound in [Unit], and that the ExecStartPre identity guard fails fast
 * with an actionable message when RUN_USER does not resolve (covers drift
 * between install runs, which install.sh's own _provision_run_identity
 * preflight cannot see since it only runs at install/update time, not on
 * every service start).
 *
 * Unlike install-github-app-key-file.test.js, this suite renders the REAL
 * deploy/clagentic-triage.service.template (not a seeded stand-in) via the
 * real deploy/install.sh, so a future edit to the template's [Unit]/
 * ExecStartPre shape is caught here rather than only in a mock.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const INSTALL_SH = join(REPO_ROOT, 'deploy', 'install.sh');
const REAL_SERVICE_TEMPLATE = join(REPO_ROOT, 'deploy', 'clagentic-triage.service.template');
const REAL_RUN_TEMPLATE = join(REPO_ROOT, 'deploy', 'clagentic-triage-run.template');

function makeFakeSystem(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const write = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(p, 0o755);
  };

  // Run identity always pre-exists in these tests — this suite is about
  // the rendered unit's restart-bounding shape, not user provisioning
  // (lr-7de17d covers that end to end).
  write('id', `[ "$1" = "-u" ] && { echo 1000; exit 0; }; exit 1`);
  write('getent', `exit 0`);
  write('useradd', `exit 0`);
  write('groupadd', `exit 0`);
  write('chown', `exit 0`);
  write('systemctl', `case "$1" in is-active) exit 0 ;; *) exit 0 ;; esac`);
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
  write('flock', `exit 0`);

  return { binDir };
}

function seedInstallDir(installDir) {
  mkdirSync(join(installDir, '.git'), { recursive: true });
  mkdirSync(join(installDir, 'deploy'), { recursive: true });
  // Real templates, not stand-ins — the point of this suite is to catch
  // regressions in the actual shipped unit shape.
  cpSync(REAL_RUN_TEMPLATE, join(installDir, 'deploy', 'clagentic-triage-run.template'));
  cpSync(REAL_SERVICE_TEMPLATE, join(installDir, 'deploy', 'clagentic-triage.service.template'));
}

function runInstall(env, extraPath) {
  const fullEnv = {
    ...process.env,
    ...env,
    PATH: `${extraPath}:${process.env.PATH}`,
  };
  return spawnSync('bash', [INSTALL_SH], { env: fullEnv, encoding: 'utf8' });
}

describe('deploy/install.sh — bounded restart + identity guard on the rendered unit', () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'clagentic-install-restart-limit-test-'));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('renders a [Unit] StartLimitIntervalSec/StartLimitBurst bound so a persistent failure exhausts its restart budget', () => {
    const caseDir = join(workDir, 'start-limit');
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
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    assert.ok(existsSync(unitPath), 'unit should have been rendered');
    const unitContents = readFileSync(unitPath, 'utf8');

    // Bound must be a finite window and a finite count — not commented out,
    // not left as a placeholder. Burst=0 would disable the limit entirely
    // (systemd treats a zero burst as "no limit"), reopening the infinite
    // restart loop this suite exists to catch, so assert it's strictly
    // positive rather than just numeric.
    assert.match(unitContents, /^StartLimitIntervalSec=\d+$/m);
    const burstLineMatch = unitContents.match(/^StartLimitBurst=(\d+)$/m);
    assert.ok(burstLineMatch, 'expected a StartLimitBurst= line in the rendered unit');
    assert.ok(
      Number(burstLineMatch[1]) > 0,
      `StartLimitBurst must be > 0 (got ${burstLineMatch[1]}) — a zero burst disables the start limit entirely`,
    );

    // Directives belong in [Unit], not [Service] — systemd ignores
    // StartLimit* silently if placed in the wrong section. Extract the
    // [Unit] section strictly (between the [Unit] header and the next
    // section header) rather than "everything before [Service]", so this
    // still catches a future reorder that puts [Service] ahead of [Unit].
    const sectionMatch = unitContents.match(/^\[Unit\]\n([\s\S]*?)(?=^\[\w+\]|\Z)/m);
    assert.ok(sectionMatch, 'expected a [Unit] section in the rendered unit');
    const unitSection = sectionMatch[1];
    assert.match(unitSection, /^StartLimitIntervalSec=\d+$/m, 'StartLimitIntervalSec must be in [Unit]');
    assert.match(unitSection, /^StartLimitBurst=\d+$/m, 'StartLimitBurst must be in [Unit]');

    // RestartSec must stay well under the interval, or the burst count
    // would never be reachable within the window at all.
    const restartSecMatch = unitContents.match(/^RestartSec=(\d+)$/m);
    const intervalMatch = unitContents.match(/^StartLimitIntervalSec=(\d+)$/m);
    const burstMatch = unitContents.match(/^StartLimitBurst=(\d+)$/m);
    assert.ok(restartSecMatch && intervalMatch && burstMatch);
    const restartSec = Number(restartSecMatch[1]);
    const interval = Number(intervalMatch[1]);
    const burst = Number(burstMatch[1]);
    assert.ok(
      restartSec * burst <= interval,
      `restart budget (RestartSec=${restartSec} * StartLimitBurst=${burst} = ${restartSec * burst}) must fit within StartLimitIntervalSec=${interval}, or the burst limit can never trip`,
    );
  });

  it('renders an ExecStartPre identity guard referencing the configured RUN_USER and RUN_GROUP', () => {
    const caseDir = join(workDir, 'execstartpre');
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
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );

    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    const unitContents = readFileSync(unitPath, 'utf8');

    const execStartPreLine = unitContents.split('\n').find((l) => l.startsWith('ExecStartPre='));
    assert.ok(execStartPreLine, 'expected an ExecStartPre= line in the rendered unit');
    // '+' prefix required — the guard must run as root regardless of the
    // unit's own User=, since its job is to check whether that account
    // exists at all.
    assert.match(execStartPreLine, /^ExecStartPre=\+/);
    // Both checks must be present and independent — a group-only or
    // user-only guard would let the other identity's removal bypass it
    // entirely (missing user -> status=217/USER, missing group ->
    // status=216/GROUP).
    assert.match(
      execStartPreLine,
      /getent passwd "clagentic-triage-test"/,
      `expected a getent passwd check for RUN_USER in the identity guard, got: ${execStartPreLine}`,
    );
    assert.match(
      execStartPreLine,
      /getent group "clagentic-triage-test"/,
      `expected a getent group check for RUN_GROUP in the identity guard, got: ${execStartPreLine}`,
    );
    assert.ok(!unitContents.includes('@@RUN_USER@@'), 'placeholder token must not survive rendering');
    assert.ok(!unitContents.includes('@@RUN_GROUP@@'), 'placeholder token must not survive rendering');

    // ExecStartPre must precede ExecStart so the guard actually gates the
    // real start attempt.
    const execStartPreIdx = unitContents.indexOf('ExecStartPre=');
    const execStartIdx = unitContents.indexOf('ExecStart=');
    assert.ok(execStartPreIdx >= 0 && execStartIdx >= 0 && execStartPreIdx < execStartIdx);
  });

  it('the ExecStartPre guard script itself fails fast with an actionable message when the account is missing', () => {
    // Exercises the guard's actual shell logic (not just its presence in
    // the rendered unit) by extracting the ExecStartPre command and running
    // it directly against a `getent` stub that reports the account absent
    // — the same condition systemd would hit for a removed RUN_USER.
    const caseDir = join(workDir, 'execstartpre-runtime');
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
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );
    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    const unitContents = readFileSync(unitPath, 'utf8');
    const execStartPreLine = unitContents.split('\n').find((l) => l.startsWith('ExecStartPre='));
    // Strip the leading 'ExecStartPre=+' systemd directive syntax to get
    // the raw command line systemd would exec.
    const rawCmd = execStartPreLine.replace(/^ExecStartPre=\+?/, '');

    // Simulate the account being absent: a `getent` stub on PATH that
    // always reports "not found" (exit 2, matching real getent).
    const missingAcctBin = join(caseDir, 'missing-acct-bin');
    mkdirSync(missingAcctBin, { recursive: true });
    writeFileSync(join(missingAcctBin, 'getent'), '#!/usr/bin/env bash\nexit 2\n');
    chmodSync(join(missingAcctBin, 'getent'), 0o755);

    const guardResult = spawnSync('sh', ['-c', rawCmd], {
      env: { ...process.env, PATH: `${missingAcctBin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    assert.notEqual(guardResult.status, 0, 'guard must fail when the account does not exist');
    assert.match(guardResult.stderr, /clagentic-triage-test.*does not exist/i);
    assert.match(guardResult.stderr, /install\.sh/);
  });

  it('the ExecStartPre guard also fails fast with an actionable message when the group is missing', () => {
    // Same failure class as the missing-user case (status=217/USER) but for
    // the group: a RUN_GROUP removed from the host after install would
    // otherwise bypass a user-only guard and surface as an opaque
    // status=216/GROUP instead. The `getent` stub here reports the user
    // present but the group absent, so this only passes if the guard
    // genuinely checks the group independently of the user.
    const caseDir = join(workDir, 'execstartpre-group-runtime');
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
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      binDir,
    );
    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);

    const unitPath = join(unitDir, 'clagentic-triage.service');
    const unitContents = readFileSync(unitPath, 'utf8');
    const execStartPreLine = unitContents.split('\n').find((l) => l.startsWith('ExecStartPre='));
    const rawCmd = execStartPreLine.replace(/^ExecStartPre=\+?/, '');

    // Simulate the group being absent while the user still resolves: a
    // `getent` stub that succeeds for `passwd` lookups but reports "not
    // found" (exit 2, matching real getent) for `group` lookups.
    const missingGroupBin = join(caseDir, 'missing-group-bin');
    mkdirSync(missingGroupBin, { recursive: true });
    writeFileSync(
      join(missingGroupBin, 'getent'),
      '#!/usr/bin/env bash\ncase "$1" in\n  passwd) exit 0 ;;\n  group) exit 2 ;;\nesac\n',
    );
    chmodSync(join(missingGroupBin, 'getent'), 0o755);

    const guardResult = spawnSync('sh', ['-c', rawCmd], {
      env: { ...process.env, PATH: `${missingGroupBin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    assert.notEqual(guardResult.status, 0, 'guard must fail when the group does not exist');
    assert.match(guardResult.stderr, /clagentic-triage-test.*does not exist/i);
    assert.match(guardResult.stderr, /group/i);
    assert.match(guardResult.stderr, /install\.sh/);
  });
});

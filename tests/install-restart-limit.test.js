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
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const INSTALL_SH = join(REPO_ROOT, 'deploy', 'install.sh');
const REAL_SERVICE_TEMPLATE = join(REPO_ROOT, 'deploy', 'clagentic-triage.service.template');
const REAL_RUN_TEMPLATE = join(REPO_ROOT, 'deploy', 'clagentic-triage-run.template');

// Resolved once against the REAL (test-runner) PATH, not a test case's
// closed fake PATH. `spawnSync('bash', ...)` resolves its executable
// against the CHILD env's PATH (Node looks it up itself, it does not
// inherit the parent's resolution) — so a test that hands install.sh a
// closed PATH lacking `bash` never launches install.sh at all; it fails
// on ENOENT before install.sh's own logic runs a single line, and a bare
// `assert.notEqual(status, 0)` then passes for the wrong reason. Any test
// case that intentionally omits a tool (e.g. the getent-missing negative
// path below) must still put `bash` itself on the child's PATH via this
// absolute path, so a non-zero exit only ever means install.sh actually
// ran and failed on the condition under test.
function resolveBashBin() {
  const result = spawnSync('command', ['-v', 'bash'], {
    shell: '/bin/sh',
    encoding: 'utf8',
  });
  const resolved = (result.stdout || '').trim();
  if (result.status !== 0 || !resolved) {
    throw new Error('could not resolve an absolute path to bash via the test runner PATH');
  }
  return resolved;
}
const BASH_BIN = resolveBashBin();

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
  // Logs every invocation (verb + full argv) to systemctl-calls.log so
  // tests can assert install.sh's call sequence, e.g. that reset-failed
  // runs before enable/restart. is-active always succeeds so the post-
  // restart poll loop in install.sh doesn't block on a real service.
  // `show -p LoadState --value` defaults to "not-found" (the real
  // systemctl's own value for a unit it has never heard of), matching a
  // fresh host; individual tests override this stub when they need to
  // simulate a loaded unit (active or failed).
  write('systemctl', `
echo "$*" >> "${join(dir, 'systemctl-calls.log')}"
case "$1" in
  is-active) exit 0 ;;
  show) echo "not-found" ;;
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

// Extracts a named systemd section's body by splitting the file on section
// headers (`^[Name]`) rather than a regex lookahead to the next header or
// end-of-string. A lookahead-based `(?=^\[\w+\]|$)` approach only bounds the
// match correctly when another section follows; when the target section is
// the LAST one in the file, "end of string" has to be expressed some other
// way than `\Z`, since JS regex treats `\Z` as a literal 'Z' character, not
// an end-of-input anchor (that's Perl/Python/.NET syntax). Splitting on
// headers sidesteps the anchor question entirely and works identically
// whether the target section is first, middle, or last.
function extractUnitSectionByHeaderSplit(fileContents, sectionName) {
  const parts = fileContents.split(/^\[(\w+)\]$/m);
  // parts alternates: [preamble, header1, body1, header2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === sectionName) {
      return parts[i + 1];
    }
  }
  return null;
}

function runInstall(env, extraPath) {
  const fullEnv = {
    ...process.env,
    ...env,
    PATH: `${extraPath}:${process.env.PATH}`,
  };
  return spawnSync(BASH_BIN, [INSTALL_SH], { env: fullEnv, encoding: 'utf8' });
}

describe('extractUnitSectionByHeaderSplit — [Unit]-section extraction helper', () => {
  it('extracts the [Unit] body when another section follows it', () => {
    const contents = '[Unit]\nStartLimitBurst=6\n\n[Service]\nType=simple\n';
    const section = extractUnitSectionByHeaderSplit(contents, 'Unit');
    assert.ok(section !== null);
    assert.match(section, /^StartLimitBurst=6$/m);
    assert.ok(!section.includes('Type=simple'), '[Unit] body must not bleed into [Service]');
  });

  it('extracts the [Unit] body when [Unit] is the LAST section in the file', () => {
    // The regression case: a lookahead of `(?=^\[\w+\]|\Z)` relies on \Z as
    // an end-of-string anchor, which JS regex does not support (\Z matches
    // a literal 'Z'), so that approach silently fails to bound the match
    // when there is no following section header to anchor on.
    const contents = '[Service]\nType=simple\n\n[Unit]\nStartLimitBurst=6\nStartLimitIntervalSec=300\n';
    const section = extractUnitSectionByHeaderSplit(contents, 'Unit');
    assert.ok(section !== null, 'expected a [Unit] section even when it is last in the file');
    assert.match(section, /^StartLimitBurst=6$/m);
    assert.match(section, /^StartLimitIntervalSec=300$/m);
  });

  it('returns null when the named section is absent', () => {
    const contents = '[Service]\nType=simple\n';
    assert.equal(extractUnitSectionByHeaderSplit(contents, 'Unit'), null);
  });
});

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
    //
    // Split on section headers rather than a lookahead-to-end-of-string
    // regex: JS regex has no \Z (Perl/Python end-of-input anchor) — it
    // matches a literal capital Z character, not "end of string" — so a
    // `(?=^\[\w+\]|\Z)` lookahead only terminates the match at the next
    // section header and silently fails to bound it when [Unit] is the
    // LAST section in the file (covered below by
    // extractUnitSectionByHeaderSplit's own dedicated test case).
    const unitSection = extractUnitSectionByHeaderSplit(unitContents, 'Unit');
    assert.ok(unitSection !== null, 'expected a [Unit] section in the rendered unit');
    assert.match(unitSection, /^StartLimitIntervalSec=\d+$/m, 'StartLimitIntervalSec must be in [Unit]');
    assert.match(unitSection, /^StartLimitBurst=\d+$/m, 'StartLimitBurst must be in [Unit]');

    // RestartSec must stay strictly under the interval, or the burst count
    // would never be reachable within the window at all — an exact `==`
    // fit is only reachable if the Nth restart lands at precisely the
    // window boundary, which systemd's own counting does not guarantee
    // (the window resets relative to the first counted start, not a fixed
    // clock edge), so require real headroom rather than allowing an exact
    // equality that could pass by chance and still race the limit.
    const restartSecMatch = unitContents.match(/^RestartSec=(\d+)$/m);
    const intervalMatch = unitContents.match(/^StartLimitIntervalSec=(\d+)$/m);
    const burstMatch = unitContents.match(/^StartLimitBurst=(\d+)$/m);
    assert.ok(restartSecMatch && intervalMatch && burstMatch);
    const restartSec = Number(restartSecMatch[1]);
    const interval = Number(intervalMatch[1]);
    const burst = Number(burstMatch[1]);
    assert.ok(
      restartSec * burst < interval,
      `restart budget (RestartSec=${restartSec} * StartLimitBurst=${burst} = ${restartSec * burst}) must fit strictly within StartLimitIntervalSec=${interval}, or the burst limit can never reliably trip`,
    );
  });

  // Builds a systemctl stub reporting the given LoadState (e.g.
  // "not-found", "loaded") for `show -p LoadState --value`, optionally
  // fails reset-failed with a distinctive stderr message, and drives
  // `is-active`'s exit code from `isActive` (default true) so a
  // failed/inactive-unit case actually differs from an active one from
  // install.sh's perspective — the original stub hardcoded `is-active`
  // to always exit 0 regardless of the simulated LoadState, so the
  // "failed" and "active" test cases below were, from install.sh's point
  // of view, identical (is-active always looked active either way). Every
  // call is logged to systemctl-calls.log so tests can assert install.sh's
  // call sequence.
  function writeLoadStateSystemctlStub(binDir, caseDir, loadState, resetFailedFails, isActive = true) {
    const resetFailedCase = resetFailedFails
      ? '  reset-failed) echo "Failed to reset failed state: unit-test-simulated-dbus-error" >&2; exit 1 ;;\n'
      : '';
    const isActiveExit = isActive ? 0 : 3;
    writeFileSync(
      join(binDir, 'systemctl'),
      `#!/usr/bin/env bash\n`
        + `echo "$*" >> "${join(caseDir, 'systemctl-calls.log')}"\n`
        + `case "$1" in\n`
        + `  is-active) exit ${isActiveExit} ;;\n`
        + `  show) echo "${loadState}" ;;\n`
        + resetFailedCase
        + `  *) exit 0 ;;\n`
        + `esac\n`,
    );
    chmodSync(join(binDir, 'systemctl'), 0o755);
  }

  it('skips systemctl reset-failed on a fresh host where the unit is not loaded', () => {
    // daemon-reload does NOT eagerly load a unit, so a fresh host's unit
    // has LoadState=not-found. `systemctl reset-failed` on a not-loaded
    // unit errors against real systemctl, so install.sh must gate the call
    // on LoadState and skip it entirely here rather than running it
    // unconditionally (which would abort a fresh install under `set -e`).
    // The shared systemctl stub's `show -p LoadState` defaults to
    // "not-found", matching this case.
    const caseDir = join(workDir, 'reset-failed-skip-fresh-host');
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

    const callsLogPath = join(caseDir, 'systemctl-calls.log');
    assert.ok(existsSync(callsLogPath), 'expected the systemctl stub to have logged calls');
    const calls = readFileSync(callsLogPath, 'utf8').trim().split('\n');

    const showIdx = calls.findIndex((c) => c.startsWith('show'));
    const resetFailedIdx = calls.findIndex((c) => c.startsWith('reset-failed'));
    const enableIdx = calls.findIndex((c) => c.startsWith('enable'));
    const restartIdx = calls.findIndex((c) => c.startsWith('restart'));

    assert.ok(showIdx >= 0, `expected install.sh to check 'systemctl show -p LoadState', got calls: ${calls.join(' | ')}`);
    assert.equal(resetFailedIdx, -1, `reset-failed must not run when the unit is not loaded, got calls: ${calls.join(' | ')}`);
    assert.ok(enableIdx >= 0, `expected a 'systemctl enable' call, got calls: ${calls.join(' | ')}`);
    assert.ok(restartIdx >= 0, `expected a 'systemctl restart' call, got calls: ${calls.join(' | ')}`);
  });

  it('clears a tripped start-limit via systemctl reset-failed before enable/restart when the unit is loaded and failed', () => {
    // Once StartLimitBurst (asserted above) trips on a persistent failure,
    // the unit lands in `failed` (LoadState stays "loaded") and the trip is
    // sticky: a later `systemctl restart`, even after the host is
    // repaired, is refused with "start request repeated too quickly" until
    // something clears it. install.sh must run `systemctl reset-failed`
    // itself so a post-merge install recovers a previously-tripped unit
    // without a manual operator step.
    const caseDir = join(workDir, 'reset-failed');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeLoadStateSystemctlStub(binDir, caseDir, 'loaded', false);

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

    const callsLogPath = join(caseDir, 'systemctl-calls.log');
    assert.ok(existsSync(callsLogPath), 'expected the systemctl stub to have logged calls');
    const calls = readFileSync(callsLogPath, 'utf8').trim().split('\n');

    const resetFailedIdx = calls.findIndex((c) => c.startsWith('reset-failed'));
    const enableIdx = calls.findIndex((c) => c.startsWith('enable'));
    const restartIdx = calls.findIndex((c) => c.startsWith('restart'));

    assert.ok(resetFailedIdx >= 0, `expected a 'systemctl reset-failed' call, got calls: ${calls.join(' | ')}`);
    assert.ok(enableIdx >= 0, `expected a 'systemctl enable' call, got calls: ${calls.join(' | ')}`);
    assert.ok(restartIdx >= 0, `expected a 'systemctl restart' call, got calls: ${calls.join(' | ')}`);
    assert.ok(
      resetFailedIdx < enableIdx && resetFailedIdx < restartIdx,
      `reset-failed must run before enable/restart, got order: ${calls.join(' | ')}`,
    );
  });

  it('clears the start-rate counter via systemctl reset-failed when the unit is loaded and still active', () => {
    // Gating on `systemctl is-failed` alone misses this case: systemd's
    // start-rate counter (what StartLimitBurst tracks) is attached to a
    // unit for as long as it stays LOADED, not only once it has landed in
    // `failed`. A unit that is loaded and currently active/auto-restarting
    // when this install runs can still be carrying counted starts from a
    // recent restart burst, and this install's own restart could push it
    // over StartLimitBurst with nothing here to clear it first. Gating on
    // LoadState=loaded (regardless of ActiveState) covers this window;
    // gating on is-failed alone would not.
    const caseDir = join(workDir, 'reset-failed-loaded-active');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeLoadStateSystemctlStub(binDir, caseDir, 'loaded', false);

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

    const callsLogPath = join(caseDir, 'systemctl-calls.log');
    const calls = readFileSync(callsLogPath, 'utf8').trim().split('\n');
    const resetFailedIdx = calls.findIndex((c) => c.startsWith('reset-failed'));
    const enableIdx = calls.findIndex((c) => c.startsWith('enable'));
    const restartIdx = calls.findIndex((c) => c.startsWith('restart'));

    assert.ok(resetFailedIdx >= 0, `expected a 'systemctl reset-failed' call for a loaded-but-active unit, got calls: ${calls.join(' | ')}`);
    assert.ok(
      resetFailedIdx < enableIdx && resetFailedIdx < restartIdx,
      `reset-failed must run before enable/restart, got order: ${calls.join(' | ')}`,
    );
  });

  it('fails loudly when systemctl reset-failed fails on a unit that IS loaded', () => {
    // When the unit is loaded, reset-failed always has a real target — a
    // non-zero exit here means something genuinely wrong (e.g. systemd/
    // dbus unreachable), not "nothing to reset". install.sh runs under
    // `set -e` with no `|| true` on this call, so a failing reset-failed
    // must abort the install with its stderr visible rather than being
    // swallowed.
    const caseDir = join(workDir, 'reset-failed-fails-loud');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeLoadStateSystemctlStub(binDir, caseDir, 'loaded', true);

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

    assert.notEqual(result.status, 0, 'install.sh must fail when reset-failed fails');
    assert.match(result.stderr, /unit-test-simulated-dbus-error/, 'the real stderr must surface, not be swallowed');

    const callsLogPath = join(caseDir, 'systemctl-calls.log');
    const calls = readFileSync(callsLogPath, 'utf8').trim().split('\n');
    const enableIdx = calls.findIndex((c) => c.startsWith('enable'));
    const restartIdx = calls.findIndex((c) => c.startsWith('restart'));
    assert.equal(enableIdx, -1, 'enable must not run after a failing reset-failed aborts the install');
    assert.equal(restartIdx, -1, 'restart must not run after a failing reset-failed aborts the install');
  });

  it('renders direct ExecStartPre getent guards for the configured RUN_USER and RUN_GROUP, no shell wrapper', () => {
    const caseDir = join(workDir, 'execstartpre');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    const expectedGetentBin = join(binDir, 'getent');

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

    const execStartPreLines = unitContents.split('\n').filter((l) => l.startsWith('ExecStartPre='));
    // Two independent lines, not one '/bin/sh -c' wrapper — a shell
    // wrapper would interpolate RUN_USER/RUN_GROUP into a root shell
    // command line; direct exec lines remove that interpolation surface
    // entirely (no '/bin/sh -c' anywhere in either line).
    assert.equal(execStartPreLines.length, 2, `expected exactly 2 ExecStartPre= lines, got: ${execStartPreLines.join(' | ')}`);
    for (const line of execStartPreLines) {
      assert.doesNotMatch(line, /\/bin\/sh/, `ExecStartPre must not shell out: ${line}`);
      // '!' prefix required — the guard must resolve the account
      // regardless of the unit's own User=/Group=, while still running
      // under the unit's sandbox directives (unlike '+', which would also
      // bypass those).
      assert.match(line, /^ExecStartPre=!/);
    }
    // Both checks must be present and independent — a group-only or
    // user-only guard would let the other identity's removal bypass it
    // entirely (missing user -> status=217/USER, missing group ->
    // status=216/GROUP).
    const passwdLine = execStartPreLines.find((l) => l.includes('getent') && l.includes('passwd'));
    const groupLine = execStartPreLines.find((l) => l.includes('getent') && l.includes('group'));
    assert.ok(passwdLine, `expected a getent passwd ExecStartPre line, got: ${execStartPreLines.join(' | ')}`);
    assert.ok(groupLine, `expected a getent group ExecStartPre line, got: ${execStartPreLines.join(' | ')}`);
    // GETENT_BIN is resolved by install.sh at render time via `command -v
    // getent` against the fake PATH set up by makeFakeSystem, so the
    // rendered path must equal that stub's path — not a hardcoded
    // /usr/bin/getent.
    assert.equal(passwdLine, `ExecStartPre=!${expectedGetentBin} passwd clagentic-triage-test`);
    assert.equal(groupLine, `ExecStartPre=!${expectedGetentBin} group clagentic-triage-test`);
    assert.ok(!unitContents.includes('@@RUN_USER@@'), 'placeholder token must not survive rendering');
    assert.ok(!unitContents.includes('@@RUN_GROUP@@'), 'placeholder token must not survive rendering');
    assert.ok(!unitContents.includes('@@GETENT_BIN@@'), 'placeholder token must not survive rendering');

    // Both ExecStartPre lines must precede ExecStart so the guard
    // actually gates the real start attempt.
    const execStartPreIdx = unitContents.indexOf('ExecStartPre=');
    const execStartIdx = unitContents.indexOf('ExecStart=');
    assert.ok(execStartPreIdx >= 0 && execStartIdx >= 0 && execStartPreIdx < execStartIdx);
  });

  it('resolves GETENT_BIN via command -v at render time and fails loudly when getent is unavailable', () => {
    // install.sh must not hardcode getent's path — its absolute location
    // is not guaranteed to be /usr/bin on every distro. This asserts the
    // positive resolution path (the rendered path equals what `command -v
    // getent` finds on PATH) and the negative path (no getent on PATH at
    // all fails the install loudly, rather than rendering an ExecStartPre
    // line that can never succeed).
    const caseDir = join(workDir, 'getent-bin-resolution');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);

    // Negative path first: a PATH with every fake tool except getent, and
    // NOT the real system PATH appended (runInstall's helper always
    // appends process.env.PATH, which would find the real system getent
    // and defeat this case) — spawnSync is called directly here with an
    // exact, closed PATH instead.
    const noGetentDir = join(caseDir, 'no-getent-bin');
    mkdirSync(noGetentDir, { recursive: true });
    for (const name of ['id', 'useradd', 'groupadd', 'chown', 'systemctl', 'git', 'npm', 'flock']) {
      cpSync(join(binDir, name), join(noGetentDir, name));
      chmodSync(join(noGetentDir, name), 0o755);
    }
    // The stub scripts under noGetentDir (id/useradd/groupadd/etc.) are
    // themselves `#!/usr/bin/env bash` scripts — `env` resolves `bash`
    // against THIS test's PATH too, independent of how install.sh itself
    // is launched below. GETENT_BIN resolution now runs inside Step 3,
    // after _provision_run_identity calls id/useradd/groupadd (see
    // install.sh), so those stub scripts must actually be able to launch,
    // or the run fails on "env: 'bash': No such file or directory" before
    // install.sh's own getent-missing FATAL is ever reached — appending
    // dirname(BASH_BIN) (e.g. /usr/bin) to PATH would fix that, but would
    // also re-expose the real system `getent` living in that same
    // directory, defeating this test entirely. Instead, symlink just
    // `bash` itself (not the whole directory) into noGetentDir, so `env`
    // finds bash without any other real system binary — including
    // getent — becoming reachable.
    symlinkSync(BASH_BIN, join(noGetentDir, 'bash'));
    // spawnSync('bash', ...) resolves its OWN executable against this call's
    // env.PATH, not the parent process's — a closed PATH lacking bash would
    // fail on ENOENT before install.sh ever runs a line, and the assertions
    // below would then pass for the wrong reason (see BASH_BIN's comment
    // above). Invoke bash by its resolved absolute path directly so only
    // `getent` is missing from the child's PATH, not bash itself.
    const negativeResult = spawnSync(BASH_BIN, [INSTALL_SH], {
      env: {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
        HOME: caseDir,
        PATH: noGetentDir,
      },
      encoding: 'utf8',
    });
    assert.notEqual(negativeResult.status, 0, 'install.sh must fail when getent is not on PATH');
    // Assert install.sh actually ran and failed specifically on the
    // getent-missing condition, not merely that some process somewhere
    // exited non-zero (e.g. bash itself failing to spawn would also be
    // non-zero and would defeat this test silently).
    assert.match(
      negativeResult.stderr,
      /'getent' is not available on PATH/,
      `expected install.sh's own getent-missing FATAL message, got stderr: ${negativeResult.stderr}`,
    );
    assert.ok(!existsSync(join(unitDir, 'clagentic-triage.service')), 'no unit should be rendered without getent');

    // Positive path: getent present (via makeFakeSystem's stub).
    const positiveResult = runInstall(
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
    assert.equal(positiveResult.status, 0, `install.sh failed: ${positiveResult.stderr}\n${positiveResult.stdout}`);
    const unitContents = readFileSync(join(unitDir, 'clagentic-triage.service'), 'utf8');
    assert.ok(
      unitContents.includes(`ExecStartPre=!${join(binDir, 'getent')} passwd`),
      'rendered ExecStartPre must use the getent path resolved from PATH',
    );
  });

  it('fails loudly when the resolved GETENT_BIN is not an absolute path', () => {
    // ExecStartPre= in the unit template requires an absolute path — it
    // does not consult PATH at all. `command -v` only ever returns an
    // absolute path for a normal PATH-resolved binary, but a PATH entry
    // that is itself relative (e.g. a bare "." ahead of the real getent
    // directory) can make it resolve to a relative one instead. Simulate
    // that by putting a same-named `getent` at the case dir's own root and
    // pointing PATH at "." (relative), so `command -v getent` resolves to
    // the relative string "./getent" rather than an absolute path.
    const caseDir = join(workDir, 'getent-bin-non-absolute');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeFileSync(join(caseDir, 'getent'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(caseDir, 'getent'), 0o755);
    // The stub scripts under binDir (id/useradd/groupadd/etc., and this
    // case's own relative `getent`) are `#!/usr/bin/env bash` scripts —
    // `env` resolves `bash` against this test's PATH too. Symlink just
    // `bash` itself into binDir (not the whole real /usr/bin, which would
    // also re-expose the real system `getent` and risk masking which
    // getent this test's assertions are actually exercising).
    symlinkSync(BASH_BIN, join(binDir, 'bash'));

    const result = spawnSync(BASH_BIN, [INSTALL_SH], {
      cwd: caseDir,
      env: {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
        HOME: caseDir,
        // "." resolves getent to the relative "./getent"; binDir supplies
        // every other required tool via its absolute path (including the
        // bash symlink added just above).
        PATH: `.:${binDir}`,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'install.sh must fail when GETENT_BIN does not resolve to an absolute path');
    assert.match(
      result.stderr,
      /resolved getent path .* is not absolute/,
      `expected install.sh's own non-absolute-path FATAL message, got stderr: ${result.stderr}`,
    );
    assert.ok(!existsSync(join(unitDir, 'clagentic-triage.service')), 'no unit should be rendered with a non-absolute GETENT_BIN');
  });

  it('the ExecStartPre getent-passwd guard fails when RUN_USER does not resolve', () => {
    // Exercises the guard's actual command (not just its presence in the
    // rendered unit) by running the exact ExecStartPre argv systemd would
    // exec, against a `getent` stub that reports the account absent — the
    // same condition systemd would hit for a removed RUN_USER. No shell
    // wrapper to strip: the rendered line is a direct getent invocation,
    // so the '+'-prefixed argv is run as-is (minus the '+' itself, which
    // is systemd's own directive syntax, not part of the command).
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
    // Match on the resolved getent path PREFIX plus the trailing argv
    // token, not a raw substring search — the resolved getent path lives
    // under this test's own caseDir, so a plain l.includes('passwd')/
    // l.includes('group') is vulnerable to a caseDir name that happens to
    // contain that word (see the group-guard test below, whose caseDir
    // name 'execstartpre-group-runtime' hit exactly this).
    const resolvedGetentBin = join(binDir, 'getent');
    const execStartPreLines = unitContents.split('\n').filter((l) => l.startsWith(`ExecStartPre=!${resolvedGetentBin} `));
    const passwdLine = execStartPreLines.find((l) => l.slice(`ExecStartPre=!${resolvedGetentBin} `.length).split(' ')[0] === 'passwd');
    assert.ok(passwdLine, `expected a getent passwd ExecStartPre line, got: ${execStartPreLines.join(' | ')}`);
    // Strip 'ExecStartPre=!' (systemd directive syntax) and the leading
    // resolved getent path to get just the trailing argv ('passwd',
    // RUN_USER) — the guard's own binary path is asserted separately
    // above; here a stubbed 'getent' on PATH stands in for it so the test
    // exercises the guard's actual passwd/RUN_USER argument pairing
    // against a stub that reports the account absent. GETENT_BIN is
    // resolved at render time (not hardcoded), so strip it dynamically
    // rather than assuming a fixed path.
    const argv = passwdLine.slice(`ExecStartPre=!${resolvedGetentBin} `.length).split(' ');
    assert.deepEqual(argv, ['passwd', 'clagentic-triage-test']);

    // Simulate the account being absent: a `getent` stub on PATH that
    // always reports "not found" (exit 2, matching real getent).
    const missingAcctBin = join(caseDir, 'missing-acct-bin');
    mkdirSync(missingAcctBin, { recursive: true });
    writeFileSync(join(missingAcctBin, 'getent'), '#!/usr/bin/env bash\nexit 2\n');
    chmodSync(join(missingAcctBin, 'getent'), 0o755);

    const guardResult = spawnSync('getent', argv, {
      env: { ...process.env, PATH: `${missingAcctBin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    assert.notEqual(guardResult.status, 0, 'guard must fail when the account does not exist');
  });

  it('the ExecStartPre getent-group guard fails when RUN_GROUP does not resolve', () => {
    // Same failure class as the missing-user case (status=217/USER) but for
    // the group: a RUN_GROUP removed from the host after install would
    // otherwise bypass a user-only guard and surface as an opaque
    // status=216/GROUP instead. Runs the getent-group ExecStartPre line's
    // own argv directly, independent of the getent-passwd line, so this
    // only passes if the two checks are genuinely independent lines.
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
    // Match on the resolved getent path PREFIX plus the trailing argv
    // token ('group' or 'passwd'), not a raw substring search — the
    // resolved getent path lives under this test's own caseDir
    // ('execstartpre-group-runtime'), which itself contains the substring
    // "group", so a plain l.includes('group') would false-match the
    // passwd line too.
    const resolvedGetentBin = join(binDir, 'getent');
    const execStartPreLines = unitContents.split('\n').filter((l) => l.startsWith(`ExecStartPre=!${resolvedGetentBin} `));
    const groupLine = execStartPreLines.find((l) => l.slice(`ExecStartPre=!${resolvedGetentBin} `.length).split(' ')[0] === 'group');
    assert.ok(groupLine, `expected a getent group ExecStartPre line, got: ${execStartPreLines.join(' | ')}`);
    // Strip 'ExecStartPre=!' and the leading resolved getent path to get
    // just the trailing argv ('group', RUN_GROUP) — see the passwd-guard
    // test above for why the binary path itself isn't re-asserted here, and
    // why it's stripped dynamically rather than assuming a fixed path.
    const argv = groupLine.slice(`ExecStartPre=!${resolvedGetentBin} `.length).split(' ');
    assert.deepEqual(argv, ['group', 'clagentic-triage-test']);

    // Simulate the group being absent: a `getent` stub that always
    // reports "not found" (exit 2, matching real getent). Unlike the
    // combined-command version this replaces, the group check is now its
    // own ExecStartPre line, so it doesn't need to simulate the user
    // resolving first — systemd runs each ExecStartPre= line independently
    // and this line only ever invokes `getent group`.
    const missingGroupBin = join(caseDir, 'missing-group-bin');
    mkdirSync(missingGroupBin, { recursive: true });
    writeFileSync(join(missingGroupBin, 'getent'), '#!/usr/bin/env bash\nexit 2\n');
    chmodSync(join(missingGroupBin, 'getent'), 0o755);

    const guardResult = spawnSync('getent', argv, {
      env: { ...process.env, PATH: `${missingGroupBin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    assert.notEqual(guardResult.status, 0, 'guard must fail when the group does not exist');
  });

  it('reports active after restart when systemctl is-active reports the unit up', () => {
    // Companion to the "stays inactive" case below — asserts the two cases
    // actually differ from install.sh's own point of view. The original
    // shared systemctl stub hardcoded `is-active` to always exit 0
    // regardless of the simulated LoadState/ActiveState, so a "failed unit"
    // test case and an "active unit" test case were indistinguishable to
    // install.sh's post-restart poll loop — both looked active. This pair
    // drives `is-active`'s exit code explicitly via writeLoadStateSystemctlStub's
    // `isActive` param instead of relying on the always-succeeds default.
    const caseDir = join(workDir, 'post-restart-poll-active');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeLoadStateSystemctlStub(binDir, caseDir, 'loaded', false, true);

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
    assert.match(result.stdout, /active after \d+s/, `expected install.sh to report active, got stdout: ${result.stdout}`);
    assert.doesNotMatch(result.stdout, /did not report active/, 'must not warn when is-active reports up');
  });

  it('warns rather than reports active when systemctl is-active never reports the unit up', () => {
    // The other half of the pair above: when `is-active` genuinely stays
    // non-zero, install.sh's poll loop must fall through to its WARNING
    // path, not silently claim success. There is no override for the poll
    // loop's fixed 30s/2s timing, so this test genuinely waits out the
    // full 30s; kept as the suite's only test doing so.
    const caseDir = join(workDir, 'post-restart-poll-inactive');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    writeLoadStateSystemctlStub(binDir, caseDir, 'loaded', false, false);

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

    // install.sh itself still exits 0 here (the WARNING path logs and
    // continues rather than aborting the install) — the assertion that
    // matters is which message it printed.
    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);
    assert.match(
      result.stdout,
      /WARNING: .* did not report active within 30s/,
      `expected install.sh's inactive-after-restart WARNING, got stdout: ${result.stdout}`,
    );
    assert.doesNotMatch(result.stdout, /active after \d+s/, 'must not claim active when is-active never reported up');
  });
});

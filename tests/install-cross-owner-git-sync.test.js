/**
 * Regression coverage for lr-d2644c: deploy/install.sh's git-sync step must
 * not fail with "detected dubious ownership" when INSTALL_DIR is owned by
 * a different user than the one invoking install.sh.
 *
 * Verified live failure: NAOMI's post-merge automation ran install.sh as
 * root against /opt/clagentic-triage, whose .git directory was owned by
 * the service user (clagentic-triage) from a prior install run's chown
 * step. Git >= 2.35.2 refuses to run any command against a repo owned by
 * a different uid than the invoking process unless that path is
 * registered as `safe.directory` — every git-sync invocation failed with
 * exit 128, "fatal: detected dubious ownership in repository at ...".
 *
 * lr-f580b9 hardened the fix to be stateless: instead of writing
 * `safe.directory` into the invoking user's global gitconfig (which
 * requires a writable HOME — itself a headless-automation failure mode,
 * see install-headless-no-home.test.js), install.sh now passes
 * `-c safe.directory=<dir>` on every git invocation's own command line.
 * These tests assert the cross-owner sync still succeeds under that
 * stateless form and that no global gitconfig file is touched at all.
 *
 * Unlike install-user-provision.test.js (lr-7de17d), this suite does NOT
 * stub `git` — the dubious-ownership check is real git C code triggered by
 * real uid mismatches, so a stub would not exercise the bug at all. It
 * uses the real system `git` binary and the `nobody` account (uid 65534,
 * present on any standard Linux host/container) to reproduce a genuine
 * cross-owner checkout, then runs the real deploy/install.sh against it.
 *
 * Requires running as root (uid 0) to chown to another account and to
 * exercise both "install.sh invoked as root, repo owned by another uid"
 * (the exact NAOMI failure) — matches this project's CI/deploy context,
 * where install.sh itself requires root for /etc/systemd/system, /opt,
 * and useradd (see docs/DEPLOY.md). Skips itself when not root or when
 * the `nobody` account is unavailable, rather than failing a suite that
 * can't validly run in that environment.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, chownSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = join(__dirname, '..', 'deploy', 'install.sh');

const IS_ROOT = process.getuid ? process.getuid() === 0 : false;
let NOBODY_UID = null;
let NOBODY_GID = null;
try {
  const out = execSync('id -u nobody', { encoding: 'utf8' }).trim();
  NOBODY_UID = parseInt(out, 10);
  NOBODY_GID = parseInt(execSync('id -g nobody', { encoding: 'utf8' }).trim(), 10);
} catch {
  // nobody account unavailable — suite will skip.
}

const CAN_RUN = IS_ROOT && Number.isInteger(NOBODY_UID);

/**
 * Stub only the non-git external commands install.sh shells out to
 * (systemctl, npm, useradd family), leaving the real `git`/`chown` on
 * PATH so the ownership + safe.directory behaviour under test is genuine.
 */
function makeFakeNonGitSystem(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const write = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(p, 0o755);
  };
  write('id', `[ "$1" = "-u" ] && { echo 1000; exit 0; }; exit 1`);
  write('getent', `exit 0`);
  write('useradd', `exit 0`);
  write('groupadd', `exit 0`);
  write('systemctl', `case "$1" in is-active) exit 0 ;; *) exit 0 ;; esac`);
  write('npm', `exit 0`);
  return binDir;
}

function runInstall(env, extraPath, homeDir) {
  const fullEnv = {
    ...process.env,
    ...env,
    HOME: homeDir,
    PATH: `${extraPath}:${process.env.PATH}`,
  };
  return spawnSync('bash', [INSTALL_SH], { env: fullEnv, encoding: 'utf8' });
}

describe('deploy/install.sh — cross-owner git sync (lr-d2644c)', { skip: !CAN_RUN ? 'requires root + nobody account' : false }, () => {
  let workDir;
  let upstreamRepo;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'clagentic-cross-owner-'));
    // Real upstream repo to clone/fetch from — exercises the actual git
    // clone/fetch/checkout/reset commands, not stubs.
    upstreamRepo = join(workDir, 'upstream.git');
    mkdirSync(upstreamRepo, { recursive: true });
    execSync(`git init -q "${upstreamRepo}"`);
    execSync(`git -C "${upstreamRepo}" config user.email test@example.invalid`);
    execSync(`git -C "${upstreamRepo}" config user.name test`);
    mkdirSync(join(upstreamRepo, 'deploy'), { recursive: true });
    writeFileSync(
      join(upstreamRepo, 'deploy', 'clagentic-triage-run.template'),
      'cd "@@INSTALL_DIR@@"\nexec "@@NODE_BIN@@" src/cli.js watch\n',
    );
    writeFileSync(
      join(upstreamRepo, 'deploy', 'clagentic-triage.service.template'),
      '[Service]\nUser=@@RUN_USER@@\nGroup=@@RUN_GROUP@@\nWorkingDirectory=@@INSTALL_DIR@@\n',
    );
    execSync(`git -C "${upstreamRepo}" add -A`);
    execSync(`git -C "${upstreamRepo}" commit -q -m init`);
    execSync(`git -C "${upstreamRepo}" branch -M main`);
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reproduces the live failure with a plain git checkout (no safe.directory) to confirm the test setup is valid', () => {
    const caseDir = join(workDir, 'raw-reproduction');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    mkdirSync(caseDir, { recursive: true });
    execSync(`git clone -q "${upstreamRepo}" "${installDir}"`);
    // Simulate a prior install run's chown to the service user (nobody
    // stands in for RUN_USER here) — this is exactly what leaves the repo
    // "dubiously owned" from a later root-invoked run's point of view.
    chownSync(installDir, NOBODY_UID, NOBODY_GID);
    chownSync(join(installDir, '.git'), NOBODY_UID, NOBODY_GID);

    const isolatedHome = join(caseDir, 'root-home');
    mkdirSync(isolatedHome, { recursive: true });
    const result = spawnSync(
      'git',
      ['-C', installDir, 'fetch', 'origin', 'main'],
      { env: { ...process.env, HOME: isolatedHome }, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0, 'expected raw git to refuse a cross-owner checkout without safe.directory');
    assert.match(result.stderr, /dubious ownership/i);
  });

  it('install.sh git-syncs a cross-owner checkout without a dubious-ownership error', () => {
    const caseDir = join(workDir, 'install-sh-cross-owner');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    const isolatedHome = join(caseDir, 'root-home');
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });

    // Pre-seed installDir as a clone already owned by a different user
    // (nobody), mirroring the state install.sh's own chown step leaves
    // behind on a real host after a prior successful install.
    execSync(`git clone -q "${upstreamRepo}" "${installDir}"`);
    chownSync(installDir, NOBODY_UID, NOBODY_GID);
    chownSync(join(installDir, '.git'), NOBODY_UID, NOBODY_GID);

    const nonGitBin = makeFakeNonGitSystem(caseDir);

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_GIT_REMOTE: upstreamRepo,
        CLAGENTIC_TRIAGE_GIT_REF: 'main',
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'nobody',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'nogroup',
        CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      nonGitBin,
      isolatedHome,
    );

    assert.equal(result.status, 0, `install.sh failed: ${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stderr, /dubious ownership/i, 'git-sync must not hit the dubious-ownership error');
    assert.doesNotMatch(result.stdout, /dubious ownership/i);

    // The stateless fix (lr-f580b9) trusts INSTALL_DIR via a per-command
    // `-c safe.directory=...` flag, not a global gitconfig write — assert
    // the invoking user's global config was never touched at all, proving
    // the fix does not depend on (or mutate) HOME-resident state.
    const globalConfigPath = join(isolatedHome, '.gitconfig');
    assert.ok(!existsSync(globalConfigPath), 'install.sh must not write a global .gitconfig under the stateless fix');

    // Confirm the sync actually progressed (real HEAD resolved from the
    // real clone), not just that the script didn't crash. This verification
    // call is the test's own git invocation (not install.sh's), so it must
    // pass its own -c safe.directory — install.sh's stateless fix does not
    // (and must not) leave any trust behind for other invocations to ride on.
    const repoSha = execSync(`git -c safe.directory="${installDir}" -C "${installDir}" rev-parse HEAD`, {
      env: { ...process.env, HOME: isolatedHome },
      encoding: 'utf8',
    }).trim();
    assert.match(repoSha, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(installDir, '.installed-sha')));
    assert.equal(readFileSync(join(installDir, '.installed-sha'), 'utf8').trim(), repoSha);
  });

  it('re-running install.sh a second time (stateless per-invocation safe.directory) still succeeds', () => {
    const caseDir = join(workDir, 'install-sh-cross-owner-repeat');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    const isolatedHome = join(caseDir, 'root-home');
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });

    execSync(`git clone -q "${upstreamRepo}" "${installDir}"`);
    chownSync(installDir, NOBODY_UID, NOBODY_GID);
    chownSync(join(installDir, '.git'), NOBODY_UID, NOBODY_GID);

    const nonGitBin = makeFakeNonGitSystem(caseDir);
    const env = {
      CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
      CLAGENTIC_TRIAGE_GIT_REMOTE: upstreamRepo,
      CLAGENTIC_TRIAGE_GIT_REF: 'main',
      CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
      CLAGENTIC_TRIAGE_RUN_USER: 'nobody',
      CLAGENTIC_TRIAGE_RUN_GROUP: 'nogroup',
      CLAGENTIC_TRIAGE_SKIP_NPM_CI: '1',
      CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
      TMPDIR: caseDir,
    };

    const first = runInstall(env, nonGitBin, isolatedHome);
    assert.equal(first.status, 0, `first run failed: ${first.stderr}`);

    // install.sh's own chown re-applies RUN_USER:RUN_GROUP ownership at the
    // end of a real run; the fake chown-free environment here still leaves
    // the directory nobody-owned (chown stub isn't stubbed — real chown
    // ran as root inside install.sh itself), so the second invocation
    // faces the identical cross-owner condition again.
    const second = runInstall(env, nonGitBin, isolatedHome);
    assert.equal(second.status, 0, `second run failed: ${second.stderr}\n${second.stdout}`);
    assert.doesNotMatch(second.stderr, /dubious ownership/i);

    // Per-invocation `-c safe.directory=...` has nothing to dedup — no
    // global gitconfig entry ever accumulates, across any number of runs.
    assert.ok(
      !existsSync(join(isolatedHome, '.gitconfig')),
      'stateless fix must never write a global .gitconfig, even across repeated runs',
    );
  });
});

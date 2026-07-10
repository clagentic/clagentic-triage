/**
 * Regression coverage for lr-f580b9: deploy/install.sh must complete
 * end-to-end (git-sync AND npm ci) when invoked with HOME unset entirely —
 * the exact shape of NAOMI's post_merge_steps automation context (no PAM
 * session, no interactive login, no inherited HOME).
 *
 * Verified live failure: NAOMI's post-merge install of PR #27 failed with
 * "fatal: $HOME not set" (exit 128) from `git config --global`, the moment
 * install.sh tried to register safe.directory in the invoking user's global
 * gitconfig with no HOME to resolve `~/.gitconfig` against. npm ci was
 * flagged as the next likely HOME casualty (its cache/config resolution
 * also depends on `~`).
 *
 * This suite reproduces the automation context directly rather than
 * stubbing it away:
 *   - HOME is deleted from the child environment outright (not set to "" —
 *     unset, matching the live failure exactly).
 *   - git-sync runs against a service-user-owned checkout (mirrors the
 *     cross-owner condition from lr-d2644c/install-cross-owner-git-sync
 *     .test.js), so both HOME-unset and cross-owner conditions are live at
 *     once, exactly as NAOMI's real run hit them together.
 *   - npm ci runs for real (no stub) against this repo's own
 *     package.json/package-lock.json, which declare zero dependencies —
 *     genuinely exercises `npm ci --omit=dev` end to end without requiring
 *     network access to fetch anything.
 *
 * Requires running as root (uid 0) to chown to another account, matching
 * this project's CI/deploy context (install.sh itself requires root for
 * /etc/systemd/system, /opt, and useradd — see docs/DEPLOY.md). Skips
 * itself when not root or when the `nobody` account is unavailable.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, chownSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync, execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const INSTALL_SH = join(REPO_ROOT, 'deploy', 'install.sh');

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
 * Stub only the non-git, non-npm external commands install.sh shells out
 * to (systemctl, useradd family) — leaving the real `git`, `npm`, and
 * `chown` on PATH so the HOME-unset behaviour under test is genuine.
 */
function makeFakeSystemCommands(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const write = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(p, 0o755);
  };
  write('getent', 'exit 0');
  write('useradd', 'exit 0');
  write('groupadd', 'exit 0');
  write('systemctl', 'case "$1" in is-active) exit 0 ;; *) exit 0 ;; esac');
  return binDir;
}

function runInstallWithoutHome(env, extraPath) {
  // Build the child env from scratch (env -i style) rather than spreading
  // process.env and deleting HOME — guarantees HOME cannot leak back in
  // via some other inherited mechanism, matching a genuinely HOME-less
  // automation invocation.
  const fullEnv = {
    PATH: `${extraPath}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ...env,
  };
  delete fullEnv.HOME;
  return spawnSync('bash', [INSTALL_SH], { env: fullEnv, encoding: 'utf8' });
}

describe('deploy/install.sh — headless / HOME-unset automation context (lr-f580b9)', { skip: !CAN_RUN ? 'requires root + nobody account' : false }, () => {
  let workDir;
  let upstreamRepo;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'clagentic-headless-'));
    // Real upstream repo to clone/fetch from, seeded with this repo's own
    // package.json/package-lock.json (zero declared deps) so `npm ci` runs
    // for real without needing network access.
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
    copyFileSync(join(REPO_ROOT, 'package.json'), join(upstreamRepo, 'package.json'));
    copyFileSync(join(REPO_ROOT, 'package-lock.json'), join(upstreamRepo, 'package-lock.json'));
    execSync(`git -C "${upstreamRepo}" add -A`);
    execSync(`git -C "${upstreamRepo}" commit -q -m init`);
    execSync(`git -C "${upstreamRepo}" branch -M main`);
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('confirms the real failure mode: git config --global aborts with HOME unset', () => {
    // Sanity check that the test harness genuinely reproduces the live
    // failure this suite exists to guard against, independent of
    // install.sh — proves an unset HOME (not empty-string HOME) is what
    // trips git, matching the exact PR #27 failure.
    const env = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    };
    const result = spawnSync('git', ['config', '--global', '--add', 'safe.directory', '/tmp/whatever'], { env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'expected git config --global to fail with HOME unset');
    assert.match(result.stderr, /HOME.*not set|failed to expand user dir/i);
  });

  it('install.sh completes git-sync AND npm ci with HOME unset, against a service-user-owned checkout', () => {
    const caseDir = join(workDir, 'headless-install');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(caseDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });

    // Pre-seed installDir as a clone already owned by a different user
    // (nobody stands in for RUN_USER), mirroring a prior successful
    // install's chown step — reproduces both HOME-unset AND cross-owner
    // conditions simultaneously, exactly as NAOMI's live run hit them.
    execSync(`git clone -q "${upstreamRepo}" "${installDir}"`);
    chownSync(installDir, NOBODY_UID, NOBODY_GID);
    chownSync(join(installDir, '.git'), NOBODY_UID, NOBODY_GID);

    const nonGitBin = makeFakeSystemCommands(caseDir);

    const result = runInstallWithoutHome(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_GIT_REMOTE: upstreamRepo,
        CLAGENTIC_TRIAGE_GIT_REF: 'main',
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'nobody',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'nogroup',
        CLAGENTIC_TRIAGE_FORCE_UPDATE: '1',
        TMPDIR: caseDir,
      },
      nonGitBin,
    );

    assert.equal(result.status, 0, `install.sh failed with HOME unset: ${result.stderr}\n${result.stdout}`);
    assert.doesNotMatch(result.stderr, /HOME.*not set/i, 'no subtool should trip on a missing HOME');
    assert.doesNotMatch(result.stdout, /HOME.*not set/i);
    assert.doesNotMatch(result.stderr, /dubious ownership/i, 'git-sync must not hit the dubious-ownership error either');

    // git-sync actually progressed (real HEAD resolved from the real
    // clone) — not just that the script didn't crash. This verification
    // call is the test's own git invocation (not install.sh's), so it must
    // pass its own -c safe.directory — install.sh's stateless fix does not
    // (and must not) leave any trust behind for other invocations to ride on.
    const repoSha = execSync(`git -c safe.directory="${installDir}" -C "${installDir}" rev-parse HEAD`, { encoding: 'utf8' }).trim();
    assert.match(repoSha, /^[0-9a-f]{40}$/);
    assert.ok(existsSync(join(installDir, '.installed-sha')));
    assert.equal(readFileSync(join(installDir, '.installed-sha'), 'utf8').trim(), repoSha);

    // npm ci actually ran for real (not skipped, not stubbed) against a
    // zero-dependency package.json/package-lock.json — npm doesn't create
    // node_modules when there is nothing to install, so the strongest
    // real-execution signal is the deterministic cache directory install.sh
    // now pins via npm_config_cache (the actual behaviour under test):
    // proves npm resolved and used that path instead of trying (and
    // failing) to fall back to $HOME/.npm with HOME unset.
    assert.ok(
      existsSync(join(installDir, '.npm-cache')),
      'npm ci should have used the deterministic npm_config_cache path instead of a HOME-relative default',
    );
  });
});

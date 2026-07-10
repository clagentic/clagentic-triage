/**
 * Regression coverage for lr-4f59b5: deploy/install.sh must render the
 * GitHub App private-key-file env var into the systemd unit when
 * CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE is set on the installer host,
 * and must NOT leave a dangling Environment= placeholder line when it is
 * unset — this is what lets a fresh install support GitHub App auth without
 * a manual ExecStart override (the wrapper hack this task replaces).
 *
 * Reuses the fake-system stub harness introduced for install-user-provision
 * (lr-7de17d) — real deploy/install.sh, fake useradd/git/npm/systemctl/etc
 * on PATH, no root privileges or real system mutation.
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

function makeFakeSystem(dir) {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const write = (name, script) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(p, 0o755);
  };

  // Run identity always pre-exists in these tests — this suite is about
  // template rendering, not user provisioning (lr-7de17d covers that).
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
  writeFileSync(
    join(installDir, 'deploy', 'clagentic-triage-run.template'),
    'cd "@@INSTALL_DIR@@"\nexec "@@NODE_BIN@@" src/cli.js watch\n',
  );
  // Mirrors the real template's shape: the placeholder line sits between
  // WorkingDirectory and ExecStart.
  writeFileSync(
    join(installDir, 'deploy', 'clagentic-triage.service.template'),
    [
      '[Service]',
      'User=@@RUN_USER@@',
      'Group=@@RUN_GROUP@@',
      'WorkingDirectory=@@INSTALL_DIR@@',
      'EnvironmentFile=-@@ENV_FILE@@',
      '@@GITHUB_APP_PRIVATE_KEY_FILE_ENV_LINE@@',
      'ExecStart=@@RUN_WRAPPER_PATH@@',
      '',
    ].join('\n'),
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

describe('deploy/install.sh — GitHub App private-key-file rendering (lr-4f59b5)', () => {
  let workDir;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'clagentic-install-keyfile-test-'));
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('renders an Environment= line for the key file when CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE is set', () => {
    const caseDir = join(workDir, 'with-key-file');
    const installDir = join(caseDir, 'opt', 'clagentic-triage');
    const unitDir = join(caseDir, 'systemd');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(unitDir, { recursive: true });
    seedInstallDir(installDir);

    const { binDir } = makeFakeSystem(caseDir);
    const keyFilePath = '/etc/clagentic-triage/app-key.pem';

    const result = runInstall(
      {
        CLAGENTIC_TRIAGE_INSTALL_DIR: installDir,
        CLAGENTIC_TRIAGE_SYSTEMD_UNIT_DIR: unitDir,
        CLAGENTIC_TRIAGE_RUN_USER: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_RUN_GROUP: 'clagentic-triage-test',
        CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE: keyFilePath,
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

    assert.match(
      unitContents,
      new RegExp(`Environment=CLAGENTIC_TRIAGE_GITHUB_APP_PRIVATE_KEY_FILE=${keyFilePath.replace(/\//g, '\\/')}`),
    );
    assert.ok(
      !unitContents.includes('@@GITHUB_APP_PRIVATE_KEY_FILE_ENV_LINE@@'),
      'placeholder token must not survive rendering',
    );
  });

  it('drops the placeholder line entirely (no dangling Environment= or blank line) when the var is unset', () => {
    const caseDir = join(workDir, 'without-key-file');
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

    assert.ok(
      !unitContents.includes('GITHUB_APP_PRIVATE_KEY_FILE'),
      `no GitHub App key-file reference should appear when unset, got:\n${unitContents}`,
    );
    assert.ok(
      !unitContents.includes('@@GITHUB_APP_PRIVATE_KEY_FILE_ENV_LINE@@'),
      'placeholder token must not survive rendering',
    );
    // ExecStart must immediately follow EnvironmentFile — proves the
    // placeholder line was deleted outright, not left as a blank line.
    assert.match(unitContents, /EnvironmentFile=-[^\n]*\nExecStart=/);
  });
});

import { execFileSync } from 'child_process';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { after, describe, it } from 'node:test';
import {
  getRepoInfo,
  isCommitId,
  isSafeRef,
  listBranches,
  mergeBase,
  originFromHeuristic,
  originFromReflog,
  showFileAt,
} from '../src/git';

const PREFERRED = ['main', 'master', 'develop', 'dev'];
const tempDirs: string[] = [];

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

function newRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-'));
  tempDirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  return dir;
}

function commit(dir: string, file: string, content: string, msg: string): string {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
  return sh(dir, 'rev-parse', 'HEAD');
}

/** main → develop → feature/x, each with one commit on top. */
function layeredRepo(create: 'checkout' | 'branch'): { dir: string; developTip: string } {
  const dir = newRepo();
  commit(dir, 'app.txt', 'v1\n', 'initial');
  sh(dir, 'checkout', '-q', '-b', 'develop');
  const developTip = commit(dir, 'app.txt', 'v1\nv2\n', 'develop work');
  if (create === 'checkout') {
    sh(dir, 'checkout', '-q', '-b', 'feature/x');
  } else {
    sh(dir, 'branch', 'feature/x', 'develop');
    sh(dir, 'checkout', '-q', 'feature/x');
  }
  commit(dir, 'app.txt', 'v1\nv2\nv3\n', 'feature work');
  return { dir, developTip };
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('getRepoInfo', () => {
  it('resolves root, relative path and branch', async () => {
    const dir = newRepo();
    commit(dir, 'src/a/file.ts', 'x', 'init');
    const info = await getRepoInfo(path.join(dir, 'src', 'a', 'file.ts'));
    assert.equal(info.root, fs.realpathSync(dir));
    assert.equal(info.relPath, 'src/a/file.ts');
    assert.equal(info.branch, 'main');
  });

  it('rejects files outside a repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flashback-norepo-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'x.txt');
    fs.writeFileSync(file, 'x');
    await assert.rejects(getRepoInfo(file), /not inside a git repository/);
  });
});

describe('originFromReflog', () => {
  it('detects the origin of a branch made with `git checkout -b`', async () => {
    const { dir } = layeredRepo('checkout');
    assert.equal(await originFromReflog(dir, 'feature/x'), 'develop');
  });

  it('detects the origin of a branch made with `git branch <name> <start>`', async () => {
    const { dir } = layeredRepo('branch');
    assert.equal(await originFromReflog(dir, 'feature/x'), 'develop');
  });

  it('returns null for a detached HEAD', async () => {
    const { dir } = layeredRepo('checkout');
    sh(dir, 'checkout', '-q', '--detach');
    assert.equal(await originFromReflog(dir, 'HEAD'), null);
  });
});

describe('originFromHeuristic', () => {
  it('picks the closest branch when the reflog is unavailable', async () => {
    const { dir } = layeredRepo('checkout');
    sh(dir, 'reflog', 'expire', '--expire=now', '--all');
    assert.equal(await originFromReflog(dir, 'feature/x'), null);
    assert.equal(await originFromHeuristic(dir, 'feature/x', PREFERRED), 'develop');
  });

  it('ignores branches created from the current branch', async () => {
    const { dir } = layeredRepo('checkout');
    sh(dir, 'branch', 'feature/x-child');
    sh(dir, 'checkout', '-q', 'feature/x-child');
    commit(dir, 'child.txt', 'c', 'child work');
    sh(dir, 'checkout', '-q', 'feature/x');
    assert.equal(await originFromHeuristic(dir, 'feature/x', PREFERRED), 'develop');
  });

  it('prefers configured branches on a tie', async () => {
    const dir = newRepo();
    commit(dir, 'a.txt', 'a', 'init');
    sh(dir, 'branch', 'zzz-other');
    sh(dir, 'checkout', '-q', '-b', 'feature/y');
    commit(dir, 'a.txt', 'b', 'work');
    assert.equal(await originFromHeuristic(dir, 'feature/y', PREFERRED), 'main');
  });
});

describe('listBranches', () => {
  it('excludes the current branch', async () => {
    const { dir } = layeredRepo('checkout');
    const branches = await listBranches(dir, 'feature/x');
    assert.deepEqual(branches.sort(), ['develop', 'main']);
  });
});

describe('input validation', () => {
  it('accepts normal branch names', () => {
    for (const ref of ['main', 'origin/develop', 'feature/login-2', 'release/1.0']) {
      assert.equal(isSafeRef(ref), true, ref);
    }
  });

  it('rejects refs that could be read as git options or ranges', () => {
    for (const ref of ['', '-x', '--output=/tmp/x', 'a..b', 'a b', 'a\nb', 'a:b', 'HEAD~1', 'x^']) {
      assert.equal(isSafeRef(ref), false, JSON.stringify(ref));
    }
  });

  it('validates commit ids', () => {
    assert.equal(isCommitId('a'.repeat(40)), true);
    assert.equal(isCommitId('a'.repeat(64)), true);
    assert.equal(isCommitId('HEAD'), false);
    assert.equal(isCommitId('--all'), false);
  });

  it('mergeBase refuses option-like refs', async () => {
    const { dir } = layeredRepo('checkout');
    assert.equal(await mergeBase(dir, '--all'), null);
  });

  it('showFileAt refuses path traversal and invalid commits', async () => {
    const { dir } = layeredRepo('checkout');
    const sha = (await mergeBase(dir, 'develop'))!;
    assert.equal(await showFileAt(dir, sha, '../etc/passwd'), '');
    assert.equal(await showFileAt(dir, 'HEAD', 'app.txt'), '');
  });
});

describe('mergeBase + showFileAt', () => {
  it('returns the file as it was at the branch origin', async () => {
    const { dir, developTip } = layeredRepo('checkout');
    const sha = await mergeBase(dir, 'develop');
    assert.equal(sha, developTip);
    assert.equal(await showFileAt(dir, sha!, 'app.txt'), 'v1\nv2\n');
  });

  it('returns an empty string for files added on the branch', async () => {
    const { dir } = layeredRepo('checkout');
    commit(dir, 'new.txt', 'brand new', 'add file');
    const sha = await mergeBase(dir, 'develop');
    assert.equal(await showFileAt(dir, sha!, 'new.txt'), '');
  });
});

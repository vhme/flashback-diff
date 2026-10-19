import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** How the origin branch was determined. */
export type OriginSource = 'setting' | 'chosen' | 'reflog' | 'heuristic';

export interface RepoInfo {
  /** Absolute, symlink-resolved repository root. */
  root: string;
  /** File path relative to the repository root, using forward slashes. */
  relPath: string;
  /** Current branch name, or "HEAD" when detached. */
  branch: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_CANDIDATES = 300;

/**
 * Absolute path of the git executable. Defaults to "git" (resolved via PATH) and is
 * replaced at activation with the path resolved by VS Code's built-in Git extension,
 * so a `git` binary planted inside a workspace folder is never picked up on Windows.
 */
let gitPath = 'git';

export function setGitPath(p: string | undefined): void {
  if (p && path.isAbsolute(p)) gitPath = p;
}

/** True for a safe git ref name: not empty, no leading "-", no whitespace or control chars. */
export function isSafeRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 255 &&
    !ref.startsWith('-') &&
    // eslint-disable-next-line no-control-regex
    !/[\s\x00-\x1f\x7f~^:?*[\\]/.test(ref) &&
    !ref.includes('..')
  );
}

/** True for a full commit id (SHA-1 or SHA-256). */
export function isCommitId(sha: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha);
}

export class GitError extends Error {
  constructor(message: string, readonly args: readonly string[]) {
    super(message);
    this.name = 'GitError';
  }
}

/** Runs git and resolves with raw stdout. */
export function gitRaw(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      gitPath,
      args as string[],
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'buffer', windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr?.toString().trim() || err.message;
          reject(new GitError(msg, args));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/** Runs git and resolves with trimmed stdout as text. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, args)).toString('utf8').trim();
}

/** Runs git and resolves with trimmed stdout, or null when the command fails. */
export async function tryGit(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/** Resolves the repository, relative path and current branch for a file or folder. */
export async function getRepoInfo(fsPath: string): Promise<RepoInfo> {
  const real = fs.realpathSync(fsPath);
  const dir = fs.statSync(real).isDirectory() ? real : path.dirname(real);
  const top = await tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top) {
    throw new Error('This file is not inside a git repository.');
  }
  const root = fs.realpathSync(top);
  const relPath = path.relative(root, real).split(path.sep).join('/');
  const branch = (await tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  return { root, relPath, branch };
}

/** Lists local and remote branches, excluding the current branch and its remote twins. */
export async function listBranches(root: string, current: string): Promise<string[]> {
  const out = await git(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(
      (b) =>
        isSafeRef(b) &&
        b !== 'HEAD' &&
        b !== current &&
        !b.endsWith('/HEAD') &&
        !b.endsWith(`/${current}`)
    );
}

async function refExists(root: string, ref: string): Promise<boolean> {
  if (!isSafeRef(ref)) return false;
  return (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null;
}

/**
 * Finds the first "checkout: moving from X to <branch>" entry in the HEAD reflog.
 * Covers branches created with `git checkout -b` / `git switch -c`.
 */
export async function originFromHeadReflog(root: string, branch: string): Promise<string | null> {
  const out = await tryGit(root, ['reflog', 'show', '--format=%gs', 'HEAD']);
  if (!out) return null;
  const entries = out.split('\n').filter(Boolean).reverse(); // oldest first
  const re = /^checkout: moving from (.+) to (.+)$/;
  for (const entry of entries) {
    const m = re.exec(entry);
    if (m && m[2].trim() === branch) {
      const from = m[1].trim();
      return from !== branch ? from : null;
    }
  }
  return null;
}

/** Reads the branch reflog ("branch: Created from X") to find where the branch was created. */
export async function originFromReflog(root: string, branch: string): Promise<string | null> {
  if (branch === 'HEAD') return null;
  const out = await tryGit(root, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`]);
  if (!out) return null;
  const entries = out.split('\n').filter(Boolean);
  const oldest = entries[entries.length - 1];
  const m = oldest ? /^branch: Created from (.+)$/.exec(oldest) : null;
  if (!m) return null;

  let ref: string | null = m[1].trim();
  if (ref === 'HEAD') {
    ref = await originFromHeadReflog(root, branch);
  }
  if (!ref || /^[0-9a-f]{7,40}$/i.test(ref)) return null;
  return (await refExists(root, ref)) ? ref : null;
}

/**
 * Heuristic: picks the branch whose merge-base with HEAD is closest to HEAD.
 * Ties prefer branches listed in `preferred`, then local over remote.
 */
export async function originFromHeuristic(
  root: string,
  branch: string,
  preferred: readonly string[]
): Promise<string | null> {
  const rank = (b: string): number => {
    const short = b.replace(/^[^/]+\//, '');
    const i = preferred.indexOf(b) !== -1 ? preferred.indexOf(b) : preferred.indexOf(short);
    return i === -1 ? preferred.length : i;
  };

  const head = await tryGit(root, ['rev-parse', 'HEAD']);
  if (!head) return null;
  const branches = (await listBranches(root, branch)).slice(0, MAX_CANDIDATES);

  let best: { name: string; ahead: number; rank: number; local: boolean } | null = null;
  for (const name of branches) {
    const mb = await tryGit(root, ['merge-base', 'HEAD', name]);
    if (!mb) continue;

    // Skip branches that were created from the current one (they are ahead of HEAD).
    if (mb === head) {
      const behind = Number(await tryGit(root, ['rev-list', '--count', `HEAD..${name}`]));
      if (behind > 0) continue;
    }

    const ahead = Number(await tryGit(root, ['rev-list', '--count', `${mb}..HEAD`]));
    if (!Number.isFinite(ahead)) continue;

    const cand = { name, ahead, rank: rank(name), local: !name.includes('/') };
    if (
      !best ||
      cand.ahead < best.ahead ||
      (cand.ahead === best.ahead && cand.rank < best.rank) ||
      (cand.ahead === best.ahead && cand.rank === best.rank && cand.local && !best.local)
    ) {
      best = cand;
    }
  }
  return best ? best.name : null;
}

/** Returns the merge-base commit between HEAD and `ref`, or null. */
export async function mergeBase(root: string, ref: string): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  const sha = await tryGit(root, ['merge-base', 'HEAD', ref]);
  return sha && isCommitId(sha) ? sha : null;
}

/** Returns file contents at a commit, or an empty string if the file did not exist there. */
export async function showFileAt(root: string, sha: string, relPath: string): Promise<string> {
  if (!isCommitId(sha) || relPath.length === 0 || relPath.startsWith('/') || relPath.split('/').includes('..')) {
    return '';
  }
  try {
    return (await gitRaw(root, ['show', `${sha}:${relPath}`])).toString('utf8');
  } catch {
    return '';
  }
}

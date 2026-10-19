import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getRepoInfo,
  listBranches,
  mergeBase,
  originFromHeuristic,
  originFromReflog,
  isSafeRef,
  OriginSource,
  setGitPath,
  showFileAt,
} from './git';

const SCHEME = 'flashback-diff';
const CONFIG = 'flashbackDiff';
const STATE_PREFIX = 'origin:';

interface Origin {
  ref: string;
  source: OriginSource;
}

interface SnapshotQuery {
  root: string;
  sha: string;
  relPath: string;
}

let log: vscode.LogOutputChannel;

/**
 * Serves file contents at the origin commit for the left side of the diff.
 * Only URIs issued by this extension are served, so other extensions or links
 * cannot use the scheme to read arbitrary repositories.
 */
class SnapshotProvider implements vscode.TextDocumentContentProvider {
  private readonly issued = new Map<string, SnapshotQuery>();
  private readonly ids = new Map<string, string>();

  issue(query: SnapshotQuery): vscode.Uri {
    const key = `${query.root}\0${query.sha}\0${query.relPath}`;
    let id = this.ids.get(key);
    if (!id) {
      id = `${query.sha.slice(0, 12)}-${this.ids.size}`;
      this.ids.set(key, id);
      this.issued.set(id, query);
    }
    return vscode.Uri.from({ scheme: SCHEME, path: `/${query.relPath}`, query: id });
  }

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = this.issued.get(uri.query);
    if (!query) return Promise.resolve('');
    return showFileAt(query.root, query.sha, query.relPath);
  }
}

/** Uses the git binary resolved by VS Code's built-in Git extension, when available. */
async function resolveGitPath(): Promise<void> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { git: { path: string } } }>('vscode.git');
    if (!ext) return;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    const gitBin = exports?.getAPI(1)?.git?.path;
    setGitPath(gitBin);
    if (gitBin) log.info(`Using git at ${gitBin}`);
  } catch (err) {
    log.warn(`Could not resolve git path from the Git extension: ${String(err)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Flashback Diff', { log: true });
  const snapshots = new SnapshotProvider();
  const gitReady = resolveGitPath();

  const stateKey = (root: string, branch: string): string => `${STATE_PREFIX}${root}::${branch}`;
  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(CONFIG);

  async function resolveOrigin(root: string, branch: string): Promise<Origin | null> {
    const forced = config().get<string>('baseBranch', '').trim();
    if (forced) {
      if (!isSafeRef(forced)) {
        throw new Error(`"flashbackDiff.baseBranch" is not a valid branch name: ${forced}`);
      }
      return { ref: forced, source: 'setting' };
    }

    const saved = context.workspaceState.get<string>(stateKey(root, branch));
    if (saved) return { ref: saved, source: 'chosen' };

    const fromReflog = await originFromReflog(root, branch);
    if (fromReflog) return { ref: fromReflog, source: 'reflog' };

    const preferred = config().get<string[]>('preferredBranches', ['main', 'master', 'develop', 'dev']);
    const guess = await originFromHeuristic(root, branch, preferred);
    if (guess) return { ref: guess, source: 'heuristic' };

    return null;
  }

  async function pickOrigin(root: string, branch: string): Promise<string | undefined> {
    const branches = await listBranches(root, branch);
    if (branches.length === 0) {
      void vscode.window.showWarningMessage('Flashback Diff: no other branches found in this repository.');
      return undefined;
    }
    const choice = await vscode.window.showQuickPick(branches, {
      title: 'Flashback Diff',
      placeHolder: `Which branch was "${branch}" created from?`,
    });
    if (choice) {
      await context.workspaceState.update(stateKey(root, branch), choice);
      log.info(`Origin of "${branch}" set to "${choice}" (${root})`);
    }
    return choice;
  }

  async function compare(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') {
      void vscode.window.showWarningMessage('Flashback Diff: open or select a file saved on disk.');
      return;
    }

    try {
      await gitReady;
      const { root, relPath, branch } = await getRepoInfo(target.fsPath);

      const origin = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Flashback Diff: finding branch origin…' },
        () => resolveOrigin(root, branch)
      );

      let ref = origin?.ref;
      if (origin) {
        log.info(`"${branch}" → origin "${origin.ref}" (via ${origin.source})`);
      } else {
        ref = await pickOrigin(root, branch);
      }
      if (!ref) return;

      const sha = await mergeBase(root, ref);
      if (!sha) {
        void vscode.window.showErrorMessage(`Flashback Diff: could not find a common ancestor with "${ref}".`);
        return;
      }

      const left = snapshots.issue({ root, sha, relPath });
      const title = `${path.basename(relPath)} (${ref} @ ${sha.slice(0, 7)}) ↔ ${branch}`;

      await vscode.commands.executeCommand('vscode.diff', left, target, title, { preview: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      void vscode.window.showErrorMessage(`Flashback Diff: ${message}`);
    }
  }

  async function chooseOrigin(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!target || target.scheme !== 'file') return;
    try {
      await gitReady;
      const { root, branch } = await getRepoInfo(target.fsPath);
      const choice = await pickOrigin(root, branch);
      if (!choice) return;
      void vscode.window.showInformationMessage(`Flashback Diff: origin of "${branch}" is now "${choice}".`);
      if (fs.existsSync(target.fsPath) && fs.statSync(target.fsPath).isFile()) {
        await compare(target);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Flashback Diff: ${message}`);
    }
  }

  async function resetOrigin(): Promise<void> {
    for (const key of context.workspaceState.keys()) {
      if (key.startsWith(STATE_PREFIX)) {
        await context.workspaceState.update(key, undefined);
      }
    }
    void vscode.window.showInformationMessage('Flashback Diff: automatic origin detection restored.');
  }

  context.subscriptions.push(
    log,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, snapshots),
    vscode.commands.registerCommand('flashbackDiff.compare', compare),
    vscode.commands.registerCommand('flashbackDiff.chooseOrigin', chooseOrigin),
    vscode.commands.registerCommand('flashbackDiff.resetOrigin', resetOrigin)
  );
}

export function deactivate(): void {
  // Nothing to clean up: all disposables are registered on the extension context.
}

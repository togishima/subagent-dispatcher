import { execFile } from 'node:child_process';

/**
 * Deterministic change detection.
 *
 * A worker's own `changedFiles` list is a self-report, and self-reports are what
 * this project is built not to trust. When the working directory is a git
 * repository, the set of files a worker touched is observed instead: the worktree
 * state is snapshotted before and after, and the difference is the truth.
 *
 * Verification routing depends on this list (`changedFilesMatch`), so getting it
 * from git rather than from the worker matters.
 */

function git(args, cwd, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** A map of path -> status for every file git considers dirty, plus HEAD. */
export async function snapshotWorktree(cwd) {
  const porcelain = await git(['status', '--porcelain=v1', '--untracked-files=all'], cwd);
  if (porcelain === null) return null; // not a repository, or git unavailable
  const head = (await git(['rev-parse', 'HEAD'], cwd))?.trim() ?? null;
  const entries = new Map();
  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') continue;
    // "XY path" or "XY orig -> path" for renames.
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const path = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
    entries.set(path.replace(/^"|"$/g, ''), status);
  }
  return { entries, head };
}

/**
 * Files that changed between two snapshots. A file counts as changed when it
 * appeared, disappeared, or its status changed — which covers a worker that
 * created, edited, deleted or staged something.
 */
export function diffSnapshots(before, after) {
  if (!before || !after) return null;
  if (before.head !== after.head) {
    // The worker committed. Ask git directly what the commits touched.
    return { committed: true, files: null };
  }
  const changed = new Set();
  for (const [path, status] of after.entries) {
    if (before.entries.get(path) !== status) changed.add(path);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) changed.add(path);
  }
  return { committed: false, files: [...changed].sort() };
}

/** Files touched by commits made between two revisions. */
export async function filesBetween(cwd, from, to) {
  if (!from || !to) return null;
  const out = await git(['diff', '--name-only', `${from}..${to}`], cwd);
  return out === null ? null : out.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Resolve the authoritative changed-file list for one worker run.
 * Falls back to the worker's own report only when git cannot answer.
 */
export async function resolveChangedFiles({ cwd, before, reported }) {
  const after = await snapshotWorktree(cwd);
  const diff = diffSnapshots(before, after);
  if (!diff) return { files: reported, source: 'worker-report' };
  if (diff.committed) {
    const committed = await filesBetween(cwd, before.head, after.head);
    const merged = new Set([...(committed ?? []), ...(diff.files ?? [])]);
    return { files: [...merged].sort(), source: committed ? 'git-commit' : 'worker-report' };
  }
  return { files: diff.files, source: 'git-worktree' };
}

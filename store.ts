// The forge's whole state, in memory: repositories with their git objects and
// refs, and the issues, pull requests, labels and comments that live on top of
// them. One store serves the git, REST, GraphQL and MCP surfaces, so a change
// made through any one of them is visible through the others at once.
//
// Timestamps never read a clock: every created thing takes the next tick of a
// counter rooted at the scenario's day one, so two runs produce the same bytes.

import { viewerIdentity, type ViewerIdentity } from './scenario.ts';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitcore.ts';

export const SCENARIO_EPOCH_SEC = 1_735_689_600;

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  commitSeq: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

export class Store {
  readonly viewer: ViewerIdentity = viewerIdentity();
  private repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextObjectId = 1;
  private nextCommentSeq = 1;
  private clock = 0;
  private repoSeq = 0;

  /** A deterministic ISO timestamp: the scenario epoch plus one second per tick. */
  tick(): string {
    this.clock += 1;
    return new Date((SCENARIO_EPOCH_SEC + this.clock) * 1000).toISOString();
  }

  /** The same counter as epoch seconds (for commit objects). */
  tickSeconds(): number {
    this.clock += 1;
    return SCENARIO_EPOCH_SEC + this.clock;
  }

  private key(owner: string, name: string): string {
    return `${owner.toLowerCase()}\u0000${name.toLowerCase()}`;
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewer.login) out.push(repo);
    return out.sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(input: { name: string; description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name: input.name,
      description: input.description ?? '',
      private: input.private ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      createdSeq: ++this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      commitSeq: 0,
    };
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  /** The git object lookup for one repository. */
  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  ref(repo: Repo, name: string): string | undefined {
    return repo.refs.get(name);
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a ref name, a full sha, or HEAD to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      return repo.refs.get(this.headTarget(repo)) ?? null;
    }
    if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(full);
    if (oid !== undefined) return oid;
    // A short branch name that is not a head may be a tag.
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    return null;
  }

  /** The tip commit of the default branch, or null while the repository is unborn. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(this.headTarget(repo)) ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // trees and contents commits
  // -------------------------------------------------------------------------------------------

  /** The blob at `path` in the tree of `commitOid`, or null. */
  blobAtPath(repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    const segments = path.split('/').filter((part) => part !== '');
    let treeOid = parseCommit(commit.data).tree;
    for (let index = 0; index < segments.length; index += 1) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** The entries directly under `dir` in the tree of `commitOid` ('' for the root). */
  dirAtPath(repo: Repo, commitOid: string, dir: string): TreeEntry[] | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    if (dir === '' || dir === '/') {
      const tree = repo.objects.get(parseCommit(commit.data).tree);
      if (!tree || tree.type !== 'tree') return null;
      return parseTree(tree.data);
    }
    const segments = dir.split('/').filter((part) => part !== '');
    let treeOid = parseCommit(commit.data).tree;
    for (const segment of segments) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.data);
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null), built
   * from `baseTreeOid` (or from nothing for a root commit's first tree).
   */
  private setPath(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string | null => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const tree = repo.objects.get(treeOid);
        if (tree && tree.type === 'tree') {
          for (const entry of parseTree(tree.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth] as string;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const next = build(child && child.mode === '40000' ? child.oid : null, depth + 1);
        if (next === null) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      if (entries.size === 0) return null;
      return this.putObject(repo, 'tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /**
   * Commit one contents change on `branch` (creating the branch from the
   * default tip when it does not exist yet, or from nothing when the
   * repository is unborn). Returns the new commit's oid.
   */
  commitContents(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): string {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? (branch === repo.defaultBranch ? null : this.defaultTip(repo));
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip !== null) {
      const commit = repo.objects.get(tip);
      if (commit && commit.type === 'commit') {
        baseTree = parseCommit(commit.data).tree;
        parents.push(tip);
      }
    }
    let blobOid: string | null = null;
    if (content !== null) blobOid = this.putObject(repo, 'blob', content);
    const treeOid = this.setPath(repo, baseTree, path, blobOid);
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    repo.commitSeq += 1;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents,
        message: message.endsWith('\n') ? message : `${message}\n`,
        author: who,
        committer: who,
        timestamp: SCENARIO_EPOCH_SEC + repo.commitSeq,
      }),
    );
    repo.refs.set(refName, commitOid);
    return commitOid;
  }

  /** The tree oid of a commit, or null. */
  treeOf(repo: Repo, commitOid: string): string | null {
    const commit = repo.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** Flatten a tree into path -> blob oid, recursively. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, base: string): void => {
      const tree = repo.objects.get(oid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, entry.oid);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** A line-count diff between two blobs (multiset difference over lines). */
  private lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const linesOf = (data: Buffer | null): Map<string, number> => {
      const counts = new Map<string, number>();
      if (data === null) return counts;
      const text = data.toString('utf8');
      const lines = text === '' ? [] : text.split('\n');
      // A trailing newline does not start a new line.
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const oldLines = linesOf(oldData);
    const newLines = linesOf(newData);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) {
      const missing = count - (oldLines.get(line) ?? 0);
      if (missing > 0) additions += missing;
    }
    for (const [line, count] of oldLines) {
      const missing = count - (newLines.get(line) ?? 0);
      if (missing > 0) deletions += missing;
    }
    return { additions, deletions };
  }

  /**
   * The file changes between two commits' trees: added, removed and modified
   * paths with line counts.
   */
  diffCommits(repo: Repo, baseOid: string, headOid: string): FileChange[] {
    const baseTree = this.treeOf(repo, baseOid);
    const headTree = this.treeOf(repo, headOid);
    const baseFiles = baseTree === null ? new Map<string, string>() : this.flattenTree(repo, baseTree);
    const headFiles = headTree === null ? new Map<string, string>() : this.flattenTree(repo, headTree);
    const changes: FileChange[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const baseBlob = baseFiles.get(path);
      const headBlob = headFiles.get(path);
      if (baseBlob === headBlob) continue;
      if (baseBlob === undefined && headBlob !== undefined) {
        const data = repo.objects.get(headBlob)?.data ?? null;
        const counts = this.lineDiff(null, data);
        changes.push({ path, status: 'added', additions: counts.additions, deletions: 0 });
      } else if (headBlob === undefined && baseBlob !== undefined) {
        const data = repo.objects.get(baseBlob)?.data ?? null;
        const counts = this.lineDiff(data, null);
        changes.push({ path, status: 'removed', additions: 0, deletions: counts.deletions });
      } else if (baseBlob !== undefined && headBlob !== undefined) {
        const oldData = repo.objects.get(baseBlob)?.data ?? null;
        const newData = repo.objects.get(headBlob)?.data ?? null;
        const counts = this.lineDiff(oldData, newData);
        changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
      }
    }
    return changes;
  }

  // -------------------------------------------------------------------------------------------
  // issues and pull requests
  // -------------------------------------------------------------------------------------------

  nextIssueId(): number {
    return this.nextObjectId++;
  }

  nextCommentId(): number {
    return this.nextCommentSeq++;
  }

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of input.labels ?? []) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label ${JSON.stringify(name)} does not exist` };
      labels.push(label);
    }
    const now = this.tick();
    const issue: Issue = {
      id: this.nextIssueId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels,
      user: this.viewer.login,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPullRequest(
    repo: Repo,
    input: { title: string; body?: string; head: string; base: string },
  ): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, input.head);
    if (headSha === null) return { error: `head branch ${JSON.stringify(input.head)} does not exist` };
    const baseSha = this.resolveRef(repo, input.base);
    if (baseSha === null) return { error: `base branch ${JSON.stringify(input.base)} does not exist` };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
        return { error: 'a pull request is already open for this head and base' };
      }
    }
    const now = this.tick();
    const pull: PullRequest = {
      id: this.nextIssueId(),
      number: repo.nextNumber++,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      user: this.viewer.login,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** MERGEABLE, CONFLICTING or UNKNOWN for a pull request's head against its base. */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.conflictPaths(repo, pull).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The base branch's current tip (the baseSha recorded at creation goes stale once the base moves). */
  private baseTip(repo: Repo, pull: PullRequest): string {
    return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  }

  /** Paths changed on both sides since the merge base, with different results. */
  private conflictPaths(repo: Repo, pull: PullRequest): string[] {
    const baseTip = this.baseTip(repo, pull);
    const base = mergeBase(pull.headSha, baseTip, this.lookup(repo));
    if (base === null) return [];
    const baseFiles = this.treeOf(repo, base) === null ? new Map<string, string>() : this.flattenTree(repo, this.treeOf(repo, base) as string);
    const headFiles = this.treeOf(repo, pull.headSha) === null ? new Map<string, string>() : this.flattenTree(repo, this.treeOf(repo, pull.headSha) as string);
    const ontoFiles = this.treeOf(repo, baseTip) === null ? new Map<string, string>() : this.flattenTree(repo, this.treeOf(repo, baseTip) as string);
    const conflicts: string[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ontoFiles.keys()]);
    for (const path of paths) {
      const atBase = baseFiles.get(path);
      const atHead = headFiles.get(path);
      const atOnto = ontoFiles.get(path);
      const headChanged = atHead !== atBase;
      const ontoChanged = atOnto !== atBase;
      if (headChanged && ontoChanged && atHead !== atOnto) conflicts.push(path);
    }
    return conflicts;
  }

  /**
   * Squash-merge an open pull request onto its base branch. Returns the merge
   * commit's oid, or an error string ('conflict' for a conflicting merge).
   */
  mergePullRequest(repo: Repo, pull: PullRequest, message?: string): string | { error: string } {
    if (pull.state !== 'open') return { error: 'the pull request is not open' };
    if (this.conflictPaths(repo, pull).length > 0) return { error: 'conflict' };
    const baseTip = this.baseTip(repo, pull);
    const base = mergeBase(pull.headSha, baseTip, this.lookup(repo));
    const baseFiles = base === null ? new Map<string, string>() : this.flattenTree(repo, this.treeOf(repo, base) as string);
    const headFiles = this.flattenTree(repo, this.treeOf(repo, pull.headSha) as string);
    const ontoFiles = this.flattenTree(repo, this.treeOf(repo, baseTip) as string);
    // The merged tree: the base tip's files, with the head's changes applied.
    const merged = new Map<string, string>(ontoFiles);
    for (const [path, oid] of headFiles) {
      if (baseFiles.get(path) !== oid) merged.set(path, oid);
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path) && baseFiles.get(path) !== ontoFiles.get(path)) {
        // Deleted on the head side (and unchanged on the base side): drop it.
        if (ontoFiles.get(path) === baseFiles.get(path)) merged.delete(path);
      }
    }
    // Rebuild the tree from the flat map, bottom up.
    const treeOid = this.buildTreeFromMap(repo, merged);
    const who = `${this.viewer.name} <${this.viewer.email}>`;
    repo.commitSeq += 1;
    const mergeMessage = message ?? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const commitOid = this.putObject(
      repo,
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [baseTip],
        message: mergeMessage.endsWith('\n') ? mergeMessage : `${mergeMessage}\n`,
        author: who,
        committer: who,
        timestamp: SCENARIO_EPOCH_SEC + repo.commitSeq,
      }),
    );
    repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.tick();
    pull.mergeCommitSha = commitOid;
    pull.baseSha = commitOid;
    pull.updatedAt = pull.mergedAt;
    return commitOid;
  }

  /** Build a root tree oid from a flat path -> blob map. */
  private buildTreeFromMap(repo: Repo, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The git history of a ref, newest first (empty when the ref has no tip). */
  commitsOf(repo: Repo, ref: string): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    return listCommits(tip, this.lookup(repo));
  }

  /** Every object reachable from a repository's refs (for debugging, not the wire). */
  reachableObjects(repo: Repo): Set<string> {
    return collectReachable([...repo.refs.values()], this.lookup(repo), { allowMissing: true });
  }
}

export { ZERO_OID, isAncestor };

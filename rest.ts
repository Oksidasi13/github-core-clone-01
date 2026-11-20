// The GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, with the exact statuses, shapes
// and pagination the suite reads. Every reply is JSON and carries
// X-GitHub-Request-Id; a missing token is 401, a repository under another
// owner is 404 (never 403), and an unknown route is a JSON 404.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { isObjectId, parseCommit } from './gitcore.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  hasToken: boolean;
  host: string;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => ok(status, { message });

function userJson(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date(1_735_689_600 * 1000).toISOString(),
    updated_at: new Date(1_735_689_600 * 1000).toISOString(),
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: userJson(store),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(store),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** A Link header for a paginated list, with absolute same-origin URLs. */
function pageLinks(ctx: RestContext, basePath: string, page: number, perPage: number, total: number): Record<string, string> {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `http://${ctx.host}${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (pages > 1) links.push(`<${urlFor(pages)}>; rel="last"`);
  if (page > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  }
  if (links.length === 0) return {};
  return { link: links.join(', ') };
}

function pageOf<T>(items: readonly T[], ctx: RestContext): { page: T[]; pageNum: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? 30) || 30));
  const pageNum = Math.max(1, Number(ctx.query.get('page') ?? 1) || 1);
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNum, perPage };
}

function record(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The REST dispatcher. `segments` are the path parts after /api/v3. */
export function handleRest(ctx: RestContext): RestReply {
  const { store, method, segments } = ctx;

  // The API root: 200 with the token's scopes, no auth required (as shipped).
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    if (!ctx.hasToken) return err(401, 'Requires authentication');
    return ok(200, { installed_version: '1.0.0' });
  }

  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      if (!ctx.hasToken) return err(401, 'Requires authentication');
      return ok(200, userJson(store));
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        if (!ctx.hasToken) return err(401, 'Requires authentication');
        const input = record(ctx.body);
        if (!input) return err(400, 'the request body is not a JSON object');
        const name = asString(input.name);
        if (!name) return err(422, 'name is required');
        if (store.repo(store.viewer.login, name)) return err(422, 'Repository already exists');
        const repo = store.createRepo({
          name,
          description: asString(input.description),
          private: asBool(input.private),
          defaultBranch: asString(input.default_branch),
        });
        return ok(201, repoJson(store, repo));
      }
      if (method === 'GET') {
        if (!ctx.hasToken) return err(401, 'Requires authentication');
        const repos = store.viewerRepos();
        const { page, pageNum, perPage } = pageOf(repos, ctx);
        return ok(200, page.map((repo) => repoJson(store, repo)), pageLinks(ctx, '/api/v3/user/repos', pageNum, perPage, repos.length));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (segments[0] !== 'repos') return err(404, 'Not Found');
  if (segments.length < 3) return err(404, 'Not Found');
  const owner = decodePathSegment(segments[1] as string);
  const repoName = decodePathSegment(segments[2] as string);
  const repo = store.repo(owner, repoName);
  if (!repo) return err(404, 'Not Found');
  if (owner !== store.viewer.login) return err(404, 'Not Found');

  const rest = segments.slice(3);

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    if (method === 'GET') {
      if (!ctx.hasToken) return err(401, 'Requires authentication');
      return ok(200, repoJson(store, repo));
    }
    if (method === 'PATCH') {
      if (!ctx.hasToken) return err(401, 'Requires authentication');
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const description = asString(input.description);
      if (description !== undefined) repo.description = description;
      const isPrivate = asBool(input.private);
      if (isPrivate !== undefined) repo.private = isPrivate;
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      if (!ctx.hasToken) return err(401, 'Requires authentication');
      store.deleteRepo(repo);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  if (!ctx.hasToken) return err(401, 'Requires authentication');

  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .map((name) => name.slice('refs/heads/'.length))
        .sort();
      return ok(
        200,
        branches.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) }, protected: false })),
      );
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodePathSegment(rest[1] as string);
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name, commit: { sha }, protected: false });
    }
    return err(404, 'Not Found');
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const sha = ctx.query.get('sha');
      const tip = sha === null ? store.defaultTip(repo) : store.resolveRef(repo, sha);
      if (tip === null) return ok(200, []);
      const commits = store.commitsOf(repo, tip);
      return ok(
        200,
        commits.map((oid) => {
          const object = repo.objects.get(oid) as { data: Buffer };
          const parsed = parseCommit(object.data);
          // GitHub's API strips the trailing newline git appends to the message.
          return { sha: oid, commit: { message: parsed.message.replace(/\n+$/, ''), author: { name: parsed.author }, committer: { name: parsed.committer } } };
        }),
      );
    }
    return err(404, 'Not Found');
  }

  if (head === 'git') {
    if (rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const input = record(ctx.body);
        if (!input) return err(400, 'the request body is not a JSON object');
        const ref = asString(input.ref);
        const sha = asString(input.sha);
        if (!ref || !sha) return err(422, 'ref and sha are required');
        if (!ref.startsWith('refs/')) return err(422, 'ref must start with refs/');
        if (repo.refs.has(ref)) return err(422, 'the ref already exists');
        if (!repo.objects.has(sha)) return err(422, 'the sha does not exist in this repository');
        repo.refs.set(ref, sha);
        const object = repo.objects.get(sha) as { type: string };
        return ok(201, { ref, object: { sha, type: object.type } });
      }
      if (method === 'GET' && rest.length >= 3) {
        // GET /git/refs/heads/{branch} (or /git/refs/tags/{tag}).
        const refName = rest.slice(2).map(decodePathSegment).join('/');
        const full = `refs/${refName}`;
        const sha = repo.refs.get(full);
        if (sha === undefined) return err(404, 'Not Found');
        const object = repo.objects.get(sha) as { type: string };
        return ok(200, { ref: full, object: { sha, type: object.type } });
      }
      if (method === 'GET' && rest.length === 2) {
        return ok(
          200,
          [...repo.refs.entries()].map(([name, sha]) => ({ ref: name, object: { sha, type: (repo.objects.get(sha) as { type: string }).type } })),
        );
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (head === 'contents') {
    const path = rest.slice(1).map(decodePathSegment).join('/');
    if (path === '') return err(404, 'Not Found');
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? undefined;
      const tip = ref === undefined ? store.defaultTip(repo) : store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const file = store.blobAtPath(repo, tip, path);
      if (file) {
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: path.split('/').pop(),
          path,
          content: file.data.toString('base64'),
          sha: file.oid,
        });
      }
      const entries = store.dirAtPath(repo, tip, path);
      if (entries === null) return err(404, 'Not Found');
      return ok(
        200,
        entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        })),
      );
    }
    if (method === 'PUT') {
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const message = asString(input.message);
      const content = asString(input.content);
      if (!message || content === undefined) return err(422, 'message and content are required');
      let contentBytes: Buffer;
      try {
        contentBytes = Buffer.from(content, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const branch = asString(input.branch) ?? repo.defaultBranch;
      const sha = asString(input.sha);
      const tip = store.resolveRef(repo, branch);
      const existing = tip === null ? null : store.blobAtPath(repo, tip, path);
      if (existing) {
        if (sha === undefined) return err(409, 'sha is required to update a file');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
        const commitOid = store.commitContents(repo, branch, path, contentBytes, message);
        const blobOid = store.blobAtPath(repo, commitOid, path)?.oid ?? '';
        return ok(200, { content: { name: path.split('/').pop(), path, sha: blobOid, size: contentBytes.length, encoding: 'base64' }, commit: { sha: commitOid } });
      }
      if (sha !== undefined) return err(409, 'sha does not match: the file does not exist');
      const commitOid = store.commitContents(repo, branch, path, contentBytes, message);
      const blobOid = store.blobAtPath(repo, commitOid, path)?.oid ?? '';
      return ok(201, { content: { name: path.split('/').pop(), path, sha: blobOid, size: contentBytes.length, encoding: 'base64' }, commit: { sha: commitOid } });
    }
    if (method === 'DELETE') {
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const message = asString(input.message);
      if (!message) return err(422, 'message is required');
      const tip = store.defaultTip(repo);
      if (tip === null) return err(404, 'Not Found');
      const existing = store.blobAtPath(repo, tip, path);
      if (!existing) return err(404, 'Not Found');
      const sha = asString(input.sha);
      if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      const commitOid = store.commitContents(repo, repo.defaultBranch, path, null, message);
      return ok(200, { commit: { sha: commitOid } });
    }
    return err(404, 'Not Found');
  }

  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const name = asString(input.name);
      if (!name) return err(422, 'name is required');
      const color = asString(input.color) ?? 'ededed';
      const existing = repo.labels.get(name);
      if (existing) return ok(200, { name: existing.name, color: existing.color });
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    return err(404, 'Not Found');
  }

  if (head === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const title = asString(input.title);
      if (!title) return err(422, 'title is required');
      const labels = Array.isArray(input.labels) ? (input.labels.filter((entry) => typeof entry === 'string') as string[]) : undefined;
      const created = store.createIssue(repo, { title, body: asString(input.body), labels });
      if ('error' in created) return err(422, created.error);
      return ok(201, issueJson(store, repo, created));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, pageNum, perPage } = pageOf(issues, ctx);
      return ok(
        200,
        page.map((issue) => issueJson(store, repo, issue)),
        pageLinks(ctx, `/api/v3/repos/${owner}/${repoName}/issues`, pageNum, perPage, issues.length),
      );
    }
    if (rest.length === 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const input = record(ctx.body);
        if (!input) return err(400, 'the request body is not a JSON object');
        const state = asString(input.state);
        if (state === 'open' || state === 'closed') issue.state = state;
        const title = asString(input.title);
        if (title !== undefined) issue.title = title;
        const body = asString(input.body);
        if (body !== undefined) issue.body = body;
        issue.updatedAt = store.tick();
        return ok(200, issueJson(store, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (!issue) return err(404, 'Not Found');
      if (method === 'POST') {
        const input = record(ctx.body);
        if (!input) return err(400, 'the request body is not a JSON object');
        const body = asString(input.body);
        if (!body) return err(422, 'body is required');
        const comment = { id: store.nextCommentId(), body, user: store.viewer.login, createdAt: store.tick() };
        issue.comments.push(comment);
        return ok(201, { id: comment.id, body: comment.body, user: userJson(store), created_at: comment.createdAt });
      }
      if (method === 'GET') {
        return ok(
          200,
          issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: userJson(store), created_at: comment.createdAt })),
        );
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  if (head === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const input = record(ctx.body);
      if (!input) return err(400, 'the request body is not a JSON object');
      const title = asString(input.title);
      const headRef = asString(input.head);
      const baseRef = asString(input.base);
      if (!title || !headRef || !baseRef) return err(422, 'title, head and base are required');
      const created = store.createPullRequest(repo, { title, body: asString(input.body), head: headRef, base: baseRef });
      if ('error' in created) return err(422, created.error);
      return ok(201, pullJson(store, repo, created));
    }
    if (rest.length === 1 && method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, pageNum, perPage } = pageOf(pulls, ctx);
      return ok(
        200,
        page.map((pull) => pullJson(store, repo, pull)),
        pageLinks(ctx, `/api/v3/repos/${owner}/${repoName}/pulls`, pageNum, perPage, pulls.length),
      );
    }
    if (rest.length === 2) {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullJson(store, repo, pull));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return err(404, 'Not Found');
      const changes = store.diffCommits(repo, pull.baseSha, pull.headSha);
      return ok(
        200,
        changes.map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
        })),
      );
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const number = Number(rest[1]);
      if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return err(404, 'Not Found');
      if (pull.state !== 'open') return err(405, 'the pull request is not open');
      const merged = store.mergePullRequest(repo, pull);
      if (typeof merged !== 'string') {
        if (merged.error === 'conflict') return err(405, 'the pull request has conflicts');
        return err(422, merged.error);
      }
      return ok(200, { merged: true, sha: merged, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

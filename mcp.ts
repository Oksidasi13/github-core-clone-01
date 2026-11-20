// The Model Context Protocol server, served from /mcp over JSON-RPC 2.0 with
// Streamable HTTP: the 2026-07-28 era speaks `server/discover` first and
// carries an `_meta` revision on every request; the legacy era opens with
// `initialize` + `notifications/initialized`. Both eras share the same six
// tools, which write straight into the store the REST and GraphQL surfaces
// read. Errors are JSON-RPC errors, never HTTP 500s; a tools/call without an
// Authorization header is an HTTP 401.

import type { Store } from './store.ts';

export interface McpReply {
  status: number;
  body: unknown;
}

const ERR_PARSE = -32700;
const ERR_METHOD = -32601;
const ERR_INVALID = -32602;
const ERR_INTERNAL = -32603;

const TOOLS: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login (defaults to the viewer)' },
        name: { type: 'string', description: 'the repository name' },
        description: { type: 'string', description: 'a short description' },
        private: { type: 'boolean', description: 'whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login' },
        repo: { type: 'string', description: 'the repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login' },
        repo: { type: 'string', description: 'the repository name' },
        title: { type: 'string', description: 'the issue title' },
        body: { type: 'string', description: 'the issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login' },
        repo: { type: 'string', description: 'the repository name' },
        state: { type: 'string', description: 'open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request in a repository.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login' },
        repo: { type: 'string', description: 'the repository name' },
        title: { type: 'string', description: 'the pull request title' },
        head: { type: 'string', description: 'the head branch' },
        base: { type: 'string', description: 'the base branch' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'the owner login' },
        repo: { type: 'string', description: 'the repository name' },
        pull_number: { type: 'number', description: 'the pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

function success(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function failure(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolsList(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema })),
    nextCursor: null,
  };
}

function missing(present: unknown, name: string): boolean {
  return present === undefined || present === null || present === '';
}

function issueJson(store: Store, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): { ok: boolean; code?: number; message?: string; value?: unknown } {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) return { ok: false, code: ERR_INVALID, message: `unknown tool: ${name}` };
  const owner = typeof args.owner === 'string' ? args.owner : store.viewer.login;
  switch (name) {
    case 'create_repo': {
      if (missing(args.name, 'name')) return { ok: false, code: ERR_INVALID, message: 'create_repo requires a name argument' };
      const repoName = args.name as string;
      if (store.repo(owner, repoName)) return { ok: false, code: ERR_INVALID, message: 'the repository already exists' };
      const repo = store.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      });
      return {
        ok: true,
        value: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch },
      };
    }
    case 'get_repo': {
      if (missing(args.repo, 'repo')) return { ok: false, code: ERR_INVALID, message: 'get_repo requires a repo argument' };
      const repo = store.repo(owner, args.repo as string);
      if (!repo) return { ok: false, code: ERR_INVALID, message: `the repository ${owner}/${args.repo as string} was not found` };
      return {
        ok: true,
        value: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch },
      };
    }
    case 'create_issue': {
      if (missing(args.repo, 'repo') || missing(args.title, 'title')) {
        return { ok: false, code: ERR_INVALID, message: 'create_issue requires repo and title arguments' };
      }
      const repo = store.repo(owner, args.repo as string);
      if (!repo) return { ok: false, code: ERR_INVALID, message: `the repository ${owner}/${args.repo as string} was not found` };
      const created = store.createIssue(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return { ok: false, code: ERR_INVALID, message: created.error };
      return { ok: true, value: { id: created.id, number: created.number, title: created.title, body: created.body, state: created.state } };
    }
    case 'list_issues': {
      if (missing(args.repo, 'repo')) return { ok: false, code: ERR_INVALID, message: 'list_issues requires a repo argument' };
      const repo = store.repo(owner, args.repo as string);
      if (!repo) return { ok: false, code: ERR_INVALID, message: `the repository ${owner}/${args.repo as string} was not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? repo.issues : repo.issues.filter((issue) => issue.state === state);
      return { ok: true, value: issues.map((issue) => issueJson(store, issue)) };
    }
    case 'create_pull_request': {
      if (missing(args.repo, 'repo') || missing(args.title, 'title') || missing(args.head, 'head') || missing(args.base, 'base')) {
        return { ok: false, code: ERR_INVALID, message: 'create_pull_request requires repo, title, head and base arguments' };
      }
      const repo = store.repo(owner, args.repo as string);
      if (!repo) return { ok: false, code: ERR_INVALID, message: `the repository ${owner}/${args.repo as string} was not found` };
      const created = store.createPullRequest(repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head as string,
        base: args.base as string,
      });
      if ('error' in created) return { ok: false, code: ERR_INVALID, message: created.error };
      return {
        ok: true,
        value: { id: created.id, number: created.number, title: created.title, state: created.state, head: created.headRef, base: created.baseRef, head_sha: created.headSha, base_sha: created.baseSha },
      };
    }
    case 'merge_pull_request': {
      if (missing(args.repo, 'repo') || args.pull_number === undefined) {
        return { ok: false, code: ERR_INVALID, message: 'merge_pull_request requires repo and pull_number arguments' };
      }
      const repo = store.repo(owner, args.repo as string);
      if (!repo) return { ok: false, code: ERR_INVALID, message: `the repository ${owner}/${args.repo as string} was not found` };
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (!pull) return { ok: false, code: ERR_INVALID, message: `pull request #${number} was not found` };
      if (pull.state !== 'open') return { ok: false, code: ERR_INVALID, message: 'the pull request is not open' };
      const merged = store.mergePullRequest(repo, pull);
      if (typeof merged !== 'string') {
        return { ok: false, code: ERR_INVALID, message: merged.error === 'conflict' ? 'the pull request has conflicts' : merged.error };
      }
      return { ok: true, value: { merged: true, sha: merged, number: pull.number } };
    }
    default:
      return { ok: false, code: ERR_METHOD, message: `method not found: ${name}` };
  }
}

/** Serve one JSON-RPC request. `hasToken` says whether an Authorization header arrived. */
export function handleMcp(store: Store, bodyText: string, hasToken: boolean): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'the request body is not valid JSON' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: ERR_PARSE, message: 'the request body must be a JSON-RPC object' } } };
  }
  const request = parsed as Record<string, unknown>;
  const id = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? (request.params as Record<string, unknown>) : {};

  // Notifications carry no id and are answered with 202 and no body.
  if (id === null && method.startsWith('notifications/')) return { status: 202, body: '' };

  if (method === 'server/discover') {
    return {
      status: 200,
      body: success(id, {
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      }),
    };
  }

  if (method === 'initialize') {
    const result: Record<string, unknown> = {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
    };
    if (request._meta !== null && typeof request._meta === 'object') {
      result._meta = request._meta;
    }
    return { status: 200, body: success(id, result) };
  }

  if (method === 'tools/list') return { status: 200, body: success(id, toolsList()) };

  if (method === 'tools/call') {
    if (!hasToken) return { status: 401, body: { message: 'Requires authentication' } };
    const name = params.name;
    const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : null;
    if (typeof name !== 'string' || args === null) {
      return { status: 200, body: success(id, { content: [{ type: 'text', text: 'tools/call requires a name and an arguments object' }], isError: true }) };
    }
    const result = callTool(store, name, args);
    if (!result.ok) {
      return {
        status: 200,
        body: failure(id, result.code ?? ERR_INTERNAL, result.message ?? 'the tool call failed'),
      };
    }
    return {
      status: 200,
      body: success(id, {
        content: [{ type: 'text', text: typeof result.value === 'string' ? result.value : JSON.stringify(result.value) }],
        structuredContent: result.value ?? null,
        isError: false,
      }),
    };
  }

  if (method.startsWith('notifications/')) return { status: 202, body: '' };

  return { status: 200, body: failure(id, ERR_METHOD, `method not found: ${method}`) };
}

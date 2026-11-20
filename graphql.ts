// GitHub GraphQL v4, for the exact documents gh and github-mcp-server send:
// viewer and repository reads, the __type feature probes, issue and pull
// request reads and mutations, cursor pagination, node(id:) and operation
// batching. A small recursive-descent parser reads the query language subset
// those documents use (variables, inline enums and input objects, aliases,
// fragments on a type); the resolvers answer from the same store REST uses.

import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string; selections: SelectionNode[] };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selections: SelectionNode[];
}

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private skipSpace(): void {
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  private expect(ch: string): void {
    this.skipSpace();
    if (this.text[this.pos] !== ch) throw new ParseError(`expected ${JSON.stringify(ch)} at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipSpace();
    const start = this.pos;
    while (/[A-Za-z0-9_]/.test(this.text[this.pos] ?? '')) this.pos += 1;
    if (this.pos === start) throw new ParseError(`expected a name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private readString(): string {
    this.skipSpace();
    if (this.text[this.pos] !== '"') throw new ParseError(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) throw new ParseError('unterminated string');
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos] as string;
        this.pos += 1;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  private readValue(): ValueNode {
    this.skipSpace();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skipSpace();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'list', values };
        }
        values.push(this.readValue());
      }
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        this.skipSpace();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.readValue() });
      }
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      if (ch === '-') this.pos += 1;
      while (/[0-9]/.test(this.text[this.pos] ?? '')) this.pos += 1;
      let isFloat = false;
      if (this.text[this.pos] === '.') {
        isFloat = true;
        this.pos += 1;
        while (/[0-9]/.test(this.text[this.pos] ?? '')) this.pos += 1;
      }
      const num = Number(this.text.slice(start, this.pos));
      return isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private readType(): { type: string; required: boolean } {
    this.skipSpace();
    let type: string;
    if (this.peek() === '[') {
      this.pos += 1;
      const inner = this.readType();
      this.expect(']');
      type = `[${inner.type}]`;
    } else {
      type = this.readName();
    }
    this.skipSpace();
    let required = false;
    if (this.peek() === '!') {
      this.pos += 1;
      required = true;
    }
    return { type, required };
  }

  private readSelections(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      this.skipSpace();
      if (this.peek() === '}') {
        this.pos += 1;
        return selections;
      }
      if (this.text.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipSpace();
        if (this.text.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const type = this.readName();
          selections.push({ kind: 'fragment', type, selections: this.readSelections() });
          continue;
        }
        throw new ParseError('named fragments are not supported');
      }
      selections.push({ kind: 'field', field: this.readField() });
    }
  }

  private readField(): FieldNode {
    let name = this.readName();
    let alias: string | null = null;
    this.skipSpace();
    if (this.peek() === ':') {
      this.pos += 1;
      alias = name;
      name = this.readName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.skipSpace();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipSpace();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readName();
        this.expect(':');
        args.push({ name: argName, value: this.readValue() });
      }
    }
    this.skipSpace();
    const selections = this.peek() === '{' ? this.readSelections() : [];
    return { alias, name, args, selections };
  }

  parse(): OperationNode {
    this.skipSpace();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.text.slice(this.pos, this.pos + 5) === 'query' && !/[A-Za-z0-9_]/.test(this.text[this.pos + 5] ?? '')) {
      this.pos += 5;
      kind = 'query';
    } else if (this.text.slice(this.pos, this.pos + 8) === 'mutation' && !/[A-Za-z0-9_]/.test(this.text[this.pos + 8] ?? '')) {
      this.pos += 8;
      kind = 'mutation';
    }
    this.skipSpace();
    if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    const variables: Array<{ name: string; type: string; required: boolean }> = [];
    this.skipSpace();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipSpace();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        if (this.peek() === '$') this.pos += 1;
        const varName = this.readName();
        this.expect(':');
        const type = this.readType();
        variables.push({ name: varName, type: type.type, required: type.required });
      }
    }
    const selections = this.readSelections();
    return { kind, name, variables, selections };
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables (what __type reports, and what a field selection may name)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; values?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type'] },
  Viewer: { kind: 'OBJECT', fields: ['login'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate',
    ],
  },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount', 'edges'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'mergedAt', 'mergeCommit', 'url',
    ],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changes'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Node: { kind: 'OBJECT', fields: ['id'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'variable':
      return ctx.variables[node.name];
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argOf(field: FieldNode, name: string, ctx: Ctx): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : resolveValue(arg.value, ctx);
}

/** Global ids: opaque base64 over a namespaced triple, stable across reads. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`github-core-clone:${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^github-core-clone:([^:]+):(.+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1] as string, key: match[2] as string };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(ctx: Ctx, repo: Repo, issue: Issue, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('Issue', `${repo.id}:${issue.number}`);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = issueState(issue);
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        break;
      case 'createdAt':
        out[key] = issue.createdAt;
        break;
      case 'updatedAt':
        out[key] = issue.updatedAt;
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
        out[key] = null;
    }
  }
  return out;
}

function pullNode(ctx: Ctx, repo: Repo, pull: PullRequest, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('PullRequest', `${repo.id}:${pull.number}`);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullState(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = ctx.store.mergeable(repo, pull);
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'headRefOid':
        out[key] = pull.headSha;
        break;
      case 'baseRefOid':
        out[key] = pull.baseSha;
        break;
      case 'createdAt':
        out[key] = pull.createdAt;
        break;
      case 'mergedAt':
        out[key] = pull.mergedAt;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        break;
      case 'files': {
        const first = argOf(field, 'first', ctx);
        const changes = ctx.store.diffCommits(repo, pull.baseSha, pull.headSha);
        const limited = typeof first === 'number' ? changes.slice(0, first) : changes;
        out[key] = { nodes: limited.map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions, changes: change.additions + change.deletions })) };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
        out[key] = null;
    }
  }
  return out;
}

function typeNode(name: string, selections: SelectionNode[]): Record<string, unknown> | null {
  const entry = SCHEMA[name];
  if (!entry) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'name':
        out[key] = name;
        break;
      case 'kind':
        out[key] = entry.kind;
        break;
      case 'fields':
        out[key] = (entry.fields ?? []).map((fieldName) => ({ name: fieldName }));
        break;
      case 'enumValues':
        out[key] = (entry.values ?? []).map((value) => ({ name: value }));
        break;
      case 'description':
        out[key] = null;
        break;
      default:
        out[key] = null;
    }
  }
  return out;
}

function repoNode(ctx: Ctx, repo: Repo, selections: SelectionNode[]): Record<string, unknown> {
  const { store } = ctx;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('Repository', String(repo.id));
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = { login: repo.owner };
        break;
      case 'defaultBranchRef': {
        const tip = store.defaultTip(repo);
        out[key] = tip === null ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'isPrivate':
        out[key] = repo.private;
        break;
      case 'url':
        out[key] = `https://example.invalid/${repo.owner}/${repo.name}`;
        break;
      case 'issue': {
        const number = argOf(field, 'number', ctx);
        const issue = typeof number === 'number' ? repo.issues.find((entry) => entry.number === number) : undefined;
        out[key] = issue === undefined ? null : issueNode(ctx, repo, issue, field.selections);
        break;
      }
      case 'issues': {
        const first = argOf(field, 'first', ctx);
        const states = argOf(field, 'states', ctx);
        const orderBy = argOf(field, 'orderBy', ctx);
        const after = argOf(field, 'after', ctx);
        let issues = [...repo.issues];
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state)));
          issues = issues.filter((issue) => wanted.has(issueState(issue)));
        }
        if (orderBy !== null && typeof orderBy === 'object') {
          const order = orderBy as Record<string, unknown>;
          const direction = order.direction === 'ASC' ? 1 : -1;
          issues.sort((a, b) => (a.number - b.number) * direction);
        } else {
          issues.sort((a, b) => a.number - b.number);
        }
        let start = 0;
        if (typeof after === 'string' && after !== '') {
          const last = numberFromCursor(after);
          if (last !== null) {
            const index = issues.findIndex((issue) => issue.number === last);
            if (index >= 0) start = index + 1;
          }
        }
        const count = typeof first === 'number' ? first : issues.length;
        const page = issues.slice(start, start + count);
        const hasNext = start + page.length < issues.length;
        out[key] = {
          nodes: page.map((issue) => issueNode(ctx, repo, issue, field.selections.find((s) => s.kind === 'field' && s.field.name === 'nodes')?.field.selections ?? [])),
          pageInfo: {
            hasNextPage: hasNext,
            endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null,
          },
          totalCount: issues.length,
        };
        break;
      }
      case 'pullRequests': {
        const first = argOf(field, 'first', ctx);
        const pulls = [...repo.pulls].sort((a, b) => b.number - a.number);
        const count = typeof first === 'number' ? first : pulls.length;
        const page = pulls.slice(0, count);
        const nodeSelections = field.selections.find((s) => s.kind === 'field' && s.field.name === 'nodes')?.field.selections ?? [];
        out[key] = { nodes: page.map((pull) => pullNode(ctx, repo, pull, nodeSelections)), totalCount: pulls.length };
        break;
      }
      case 'pullRequest': {
        const number = argOf(field, 'number', ctx);
        const pull = typeof number === 'number' ? repo.pulls.find((entry) => entry.number === number) : undefined;
        out[key] = pull === undefined ? null : pullNode(ctx, repo, pull, field.selections);
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
        out[key] = null;
    }
  }
  return out;
}

function findRepoById(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number(decoded.key);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of store.viewerRepos()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const dbId = Number(repoId);
  const num = Number(number);
  if (!Number.isInteger(dbId) || !Number.isInteger(num)) return null;
  for (const repo of store.viewerRepos()) {
    if (repo.id !== dbId) continue;
    const issue = repo.issues.find((entry) => entry.number === num);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const dbId = Number(repoId);
  const num = Number(number);
  if (!Number.isInteger(dbId) || !Number.isInteger(num)) return null;
  for (const repo of store.viewerRepos()) {
    if (repo.id !== dbId) continue;
    const pull = repo.pulls.find((entry) => entry.number === num);
    if (pull) return { repo, pull };
  }
  return null;
}

function executeOperation(store: Store, op: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of op.selections) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (op.kind === 'query') {
      switch (field.name) {
        case 'viewer': {
          const viewerNode: Record<string, unknown> = {};
          for (const sub of field.selections) {
            if (sub.kind === 'fragment') continue;
            const key = sub.field.alias ?? sub.field.name;
            if (sub.field.name === 'login') viewerNode[key] = store.viewer.login;
            else if (sub.field.name === 'id') viewerNode[key] = globalId('User', String(store.viewer.id));
            else if (sub.field.name === 'name') viewerNode[key] = store.viewer.name;
            else {
              ctx.errors.push({ message: `Cannot query field "${sub.field.name}" on type "Viewer".` });
              viewerNode[key] = null;
            }
          }
          data[key] = viewerNode;
          break;
        }
        case 'repository': {
          const owner = argOf(field, 'owner', ctx);
          const name = argOf(field, 'name', ctx);
          const repo = typeof owner === 'string' && typeof name === 'string' ? store.repo(owner, name) : undefined;
          if (repo === undefined || repo.owner !== store.viewer.login) data[key] = null;
          else data[key] = repoNode(ctx, repo, field.selections);
          break;
        }
        case 'node': {
          const id = argOf(field, 'id', ctx);
          if (typeof id !== 'string') {
            data[key] = null;
            break;
          }
          const repo = findRepoById(store, id);
          if (repo) {
            const node: Record<string, unknown> = { id: globalId('Repository', String(repo.id)) };
            for (const sub of field.selections) {
              if (sub.kind === 'fragment' && sub.type === 'Repository') {
                const part = repoNode(ctx, repo, sub.selections);
                Object.assign(node, part);
              } else if (sub.kind === 'field' && sub.field.name === 'id') {
                node[sub.field.alias ?? 'id'] = globalId('Repository', String(repo.id));
              }
            }
            data[key] = node;
            break;
          }
          const issue = findIssueById(store, id);
          if (issue) {
            data[key] = issueNode(ctx, issue.repo, issue.issue, field.selections);
            break;
          }
          const pull = findPullById(store, id);
          if (pull) {
            data[key] = pullNode(ctx, pull.repo, pull.pull, field.selections);
            break;
          }
          data[key] = null;
          break;
        }
        case '__type': {
          const name = argOf(field, 'name', ctx);
          data[key] = typeof name === 'string' ? typeNode(name, field.selections) : null;
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
          data[key] = null;
      }
    } else {
      // Mutations.
      const input = argOf(field, 'input', ctx);
      const inputRecord = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      switch (field.name) {
        case 'createIssue': {
          const repoId = inputRecord.repositoryId;
          const title = inputRecord.title;
          const repo = typeof repoId === 'string' ? findRepoById(store, repoId) : null;
          if (!repo || typeof title !== 'string') {
            ctx.errors.push({ message: 'createIssue needs a repositoryId naming a repository and a title.' });
            data[key] = null;
            break;
          }
          const created = store.createIssue(repo, { title, body: typeof inputRecord.body === 'string' ? inputRecord.body : '' });
          if ('error' in created) {
            ctx.errors.push({ message: created.error });
            data[key] = null;
            break;
          }
          data[key] = { issue: issueNode(ctx, repo, created, field.selections.find((s) => s.kind === 'field' && s.field.name === 'issue')?.field.selections ?? []) };
          break;
        }
        case 'closeIssue': {
          const issueId = inputRecord.issueId;
          const found = typeof issueId === 'string' ? findIssueById(store, issueId) : null;
          if (!found) {
            ctx.errors.push({ message: 'closeIssue needs an issueId naming an issue.' });
            data[key] = null;
            break;
          }
          found.issue.state = 'closed';
          found.issue.updatedAt = store.tick();
          data[key] = { issue: issueNode(ctx, found.repo, found.issue, field.selections.find((s) => s.kind === 'field' && s.field.name === 'issue')?.field.selections ?? []) };
          break;
        }
        case 'createPullRequest': {
          const repoId = inputRecord.repositoryId;
          const repo = typeof repoId === 'string' ? findRepoById(store, repoId) : null;
          const head = inputRecord.headRefName;
          const base = inputRecord.baseRefName;
          const title = inputRecord.title;
          if (!repo || typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
            ctx.errors.push({ message: 'createPullRequest needs repositoryId, baseRefName, headRefName and title.' });
            data[key] = null;
            break;
          }
          const created = store.createPullRequest(repo, { title, head, base });
          if ('error' in created) {
            ctx.errors.push({ message: created.error });
            data[key] = null;
            break;
          }
          data[key] = { pullRequest: pullNode(ctx, repo, created, field.selections.find((s) => s.kind === 'field' && s.field.name === 'pullRequest')?.field.selections ?? []) };
          break;
        }
        case 'mergePullRequest': {
          const pullRequestId = inputRecord.pullRequestId;
          const found = typeof pullRequestId === 'string' ? findPullById(store, pullRequestId) : null;
          if (!found) {
            ctx.errors.push({ message: 'mergePullRequest needs a pullRequestId naming a pull request.' });
            data[key] = null;
            break;
          }
          const merged = store.mergePullRequest(found.repo, found.pull);
          if (typeof merged !== 'string') {
            ctx.errors.push({ message: merged.error === 'conflict' ? 'the pull request has conflicts' : merged.error });
            data[key] = { pullRequest: pullNode(ctx, found.repo, found.pull, field.selections.find((s) => s.kind === 'field' && s.field.name === 'pullRequest')?.field.selections ?? []) };
            break;
          }
          data[key] = { pullRequest: pullNode(ctx, found.repo, found.pull, field.selections.find((s) => s.kind === 'field' && s.field.name === 'pullRequest')?.field.selections ?? []) };
          break;
        }
        case 'addComment': {
          const subjectId = inputRecord.subjectId;
          const body = inputRecord.body;
          const found = typeof subjectId === 'string' ? findIssueById(store, subjectId) : null;
          if (!found || typeof body !== 'string') {
            ctx.errors.push({ message: 'addComment needs a subjectId naming an issue and a body.' });
            data[key] = null;
            break;
          }
          const comment = { id: store.nextCommentId(), body, user: store.viewer.login, createdAt: store.tick() };
          found.issue.comments.push(comment);
          const nodeSelections = field.selections.find((s) => s.kind === 'field' && s.field.name === 'commentEdge')?.field.selections ?? [];
          const nodeSel = nodeSelections.find((s) => s.kind === 'field' && s.field.name === 'node')?.field.selections ?? [];
          const node: Record<string, unknown> = {};
          for (const sub of nodeSel) {
            if (sub.kind !== 'field') continue;
            const k = sub.field.alias ?? sub.field.name;
            if (sub.field.name === 'id') node[k] = globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`);
            else if (sub.field.name === 'body') node[k] = comment.body;
          }
          data[key] = { commentEdge: { node } };
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
          data[key] = null;
      }
    }
  }
  return { data, errors: ctx.errors };
}

/**
 * Run one GraphQL operation body ({query, variables} or a batch array of
 * them). Returns the response body object (or array for a batch).
 */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'the operation body must be a JSON object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { errors: [{ message: 'the operation body carries no query string.' }] };
    }
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
    let op: OperationNode;
    try {
      op = new Parser(query).parse();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const { data, errors } = executeOperation(store, op, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}

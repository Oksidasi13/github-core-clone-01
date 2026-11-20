// The forge as one HTTP server: git smart HTTP, REST v3, GraphQL and MCP
// all read and write the same in-memory store. The server binds an ephemeral
// port on loopback, announces itself to the platform's environment URL, and
// exits once the suite says it is done; main.ts owns that lifecycle.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>, requestId = ''): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...extra });
    res.end();
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...extra,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId = ''): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, requestId = ''): void {
  sendJson(res, status, { message }, undefined, requestId);
}

export interface ForgeOptions {
  store?: Store;
}

export function createForge(options: ForgeOptions = {}): { store: Store; server: ReturnType<typeof createServer> } {
  const store = options.store ?? new Store();

  const server = createServer(async (req, res) => {
    const requestId = nextRequestId();
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const method = (req.method ?? 'GET').toUpperCase();
      const segments = url.pathname.split('/').filter((part) => part.length > 0);
      const hasToken = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');

      if (url.pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true }, undefined, requestId);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
      // The git handlers take a GitRequest and write the reply themselves.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const action = gitMatch[3] as string;
        const service = action === 'info/refs' ? (url.searchParams.get('service') ?? '') : action;
        const body = action === 'info/refs' ? Buffer.alloc(0) : await readBody(req);
        const gitCtx = { req, res, owner, repoName, service, store, body, requestId };
        if (action === 'info/refs') handleInfoRefs(gitCtx);
        else if (action === 'git-upload-pack') handleUploadPack(gitCtx);
        else handleReceivePack(gitCtx);
        return;
      }

      if (url.pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        if (!hasToken) {
          sendError(res, 401, 'Requires authentication', requestId);
          return;
        }
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendError(res, 400, 'the request body is not valid JSON', requestId);
          return;
        }
        const result = executeGraphQL(store, body);
        sendJson(res, result.status, result.body, undefined, requestId);
        return;
      }

      if (url.pathname === '/mcp') {
        if (method !== 'POST') {
          sendError(res, 404, 'Not Found', requestId);
          return;
        }
        const raw = await readBody(req);
        const result = handleMcp(store, raw.toString('utf8'), hasToken);
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body, undefined, requestId);
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'v3') {
        let body: unknown = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              sendError(res, 400, 'the request body is not valid JSON', requestId);
              return;
            }
          }
        }
        const reply = handleRest({
          store,
          method,
          segments: segments.slice(2),
          query: url.searchParams,
          body,
          hasToken,
          host: req.headers.host ?? '127.0.0.1',
        });
        if (reply.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, reply.headers, requestId);
        return;
      }

      // Unknown route: a JSON 404, never HTML.
      sendError(res, 404, 'Not Found', requestId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        sendError(res, 500, message, requestId);
      } catch {
        res.end();
      }
    }
  });

  return { store, server };
}

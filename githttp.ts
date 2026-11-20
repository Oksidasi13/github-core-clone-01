// The git smart-HTTP surface: info/refs advertisements (protocol v0 and v2),
// upload-pack (ls-refs and fetch), and receive-pack (push with report-status).
// The client is the suite's own dependency-free git client, so every frame here
// is shaped to what it parses: pkt-line framing, sideband-64k pack delivery,
// and the exact capability lists its checks read.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  collectReachable,
  commitDistance,
  decodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  packetLines,
  parseTag,
  planFetch,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';

const AGENT = 'github-core-clone/1.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

export interface GitRequest {
  req: IncomingMessage;
  res: ServerResponse;
  owner: string;
  repoName: string;
  service: string;
  store: Store;
  body: Buffer;
  requestId: string;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const text = `${JSON.stringify(body)}\n`;
  send(res, status, 'application/json; charset=utf-8', Buffer.from(text, 'utf8'), requestId);
}

/** The refs of a repository, sorted by name, as (ref, oid) pairs. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Peel an annotated tag ref to its target commit, or null. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** The v0 capability list for a service, with the HEAD symref first. */
function v0Caps(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const head = `symref=HEAD:${repo.defaultBranch === '' ? 'refs/heads/main' : `refs/heads/${repo.defaultBranch}`}`;
  if (service === 'git-receive-pack') {
    return `${head} report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  }
  return `${head} side-band-64k ofs-delta agent=${AGENT}`;
}

/**
 * A v0 ref advertisement: the service preamble, a flush, then one line per
 * ref (`<oid> <ref>`), the first carrying the capabilities after a NUL. An
 * annotated tag is followed by its peeled `<oid> <ref>^{}` line. An empty
 * repository advertises the zero `capabilities^{}` pseudo-ref.
 */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const caps = v0Caps(repo, service);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]?.oid ?? ZERO_OID;
    lines.push(`${headOid} HEAD\u0000${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(ctx: GitRequest): void {
  const { req, res, store } = ctx;
  const repo = store.repo(ctx.owner, ctx.repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    return;
  }
  const service = ctx.service;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: `unknown service ${service}` }, ctx.requestId);
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    send(res, 200, UPLOAD_AD, v2Advertisement(), ctx.requestId);
    return;
  }
  const body = v0Advertisement(repo, service);
  send(res, 200, service === 'git-upload-pack' ? UPLOAD_AD : RECEIVE_AD, body, ctx.requestId);
}

// ---------------------------------------------------------------------------------------------
// upload-pack (v2)
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Parse a v2 command request: `command=x`, optional agent/object-format lines, a delim, then args. */
function parseV2Request(body: Buffer): V2Request | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const lines = packetLines(packets);
  if (lines.length === 0) return null;
  const first = lines[0] as string;
  if (!first.startsWith('command=')) return null;
  const command = first.slice('command='.length).trim();
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (!pastDelim) continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text !== '') args.push(text);
  }
  return { command, args };
}

/** The ls-refs answer: one line per matching ref, then a flush. */
function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  // HEAD is a pseudo-ref: it is listed when a ref-prefix filter matches it
  // ("HEAD" starts with the "HEAD" prefix git clone sends), not only when
  // no filter is active — without it the client never learns the remote HEAD.
  const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headMatches) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${headTarget}\n` : `${headOid} HEAD\n`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:${headTarget}\n` : 'unborn HEAD\n');
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    // Only the HEAD pseudo-ref carries symref-target; a branch is a real ref
    // and must never claim to be a symref (a self-target breaks clone's
    // HEAD resolution).
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The fetch answer: an acknowledgments section only while negotiation is open, shallow-info when there is one, and the packfile section. */
function fetchResponse(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg === 'deepen-relative') deepenRelative = true;
    else if (arg.startsWith('deepen ')) {
      const value = Number(arg.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
  }
  for (const want of wants) {
    if (!isObjectId(want) || !repo.objects.has(want)) {
      throw new Error(`want ${want} is not an object this repository holds`);
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // `deepen-relative` (real git's --deepen) counts generations beyond the
  // client's current shallow boundary; a bare `deepen` (the suite client)
  // is an absolute depth from the tip. The boundary's distance from the
  // nearest want plus one is the current depth.
  let effectiveDepth = depth;
  if (depth !== null && deepenRelative && shallow.length > 0) {
    let base = 0;
    for (const want of wants) {
      for (const boundary of shallow) {
        const distance = commitDistance(want, boundary, lookup);
        if (distance !== null && distance + 1 > base) base = distance + 1;
      }
    }
    effectiveDepth = base + depth;
  }
  const plan = planFetch(wants, haves, shallow, effectiveDepth, lookup);
  const pack = writePack(plan.objects);

  const parts: Buffer[] = [];
  // The acknowledgments section is only sent while negotiation is still
  // open — that is, when the client did NOT send `done`. A client that sent
  // `done` (every clone and fetch the suite and real git make) expects the
  // packfile as the first section, and an ack section there breaks it. When
  // negotiation is open, the section names the common commits and ends with
  // `ready` + delim, because a packfile follows.
  if (!done) {
    const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
    let acknowledged = false;
    for (const have of haves) {
      if (!repo.objects.has(have)) continue;
      const common = wants.some((want) => have === want || isAncestor(want, have, lookup));
      if (!common) continue;
      ackLines.push(`ACK ${have}\n`);
      acknowledged = true;
    }
    if (!acknowledged) ackLines.push('NAK\n');
    ackLines.push('ready\n');
    ackLines.push('delim');
    parts.push(pktLines(ackLines));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim' | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(pktLines(lines));
  }
  // Packfile: the section header, then the pack as sideband band-1 packets.
  // One frame holds at most PKT_LINE_MAX bytes including its header and the
  // band byte, so a chunk is at most 65515 pack bytes.
  parts.push(pktLine('packfile\n'));
  const sideband: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const chunk = pack.subarray(offset, offset + 65515);
    offset += chunk.length;
    sideband.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (sideband.length === 0) sideband.push(pktLine(Buffer.from([1])));
  parts.push(Buffer.concat(sideband));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(ctx: GitRequest): void {
  const { req, res, store } = ctx;
  const repo = store.repo(ctx.owner, ctx.repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (!isV2) {
    // Protocol v0 fetch is not spoken by the suite's client (it always asks
    // for v2 when the advertisement offers it); a malformed body lands here
    // too, and either way a plain 400 keeps the server healthy.
    sendJson(res, 400, { message: 'protocol v0 fetch is not supported; send Git-Protocol: version=2' }, ctx.requestId);
    return;
  }
  const request = parseV2Request(ctx.body);
  if (request === null) {
    sendJson(res, 400, { message: 'the upload-pack request is not a valid pkt-line stream' }, ctx.requestId);
    return;
  }
  try {
    if (request.command === 'ls-refs') {
      send(res, 200, UPLOAD_RESULT, lsRefsResponse(repo, request.args), ctx.requestId);
      return;
    }
    if (request.command === 'fetch') {
      send(res, 200, UPLOAD_RESULT, fetchResponse(repo, request.args), ctx.requestId);
      return;
    }
    sendJson(res, 400, { message: `unknown upload-pack command ${request.command}` }, ctx.requestId);
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) }, ctx.requestId);
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack (push, v0)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface RefReport {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack body: pkt-line commands up to the flush, then the raw pack. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  // Find the first flush packet: everything after it is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) return null;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const commandText = nul >= 0 ? line.slice(0, nul) : line;
    const parts = commandText.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid) || !ref.startsWith('refs/')) return null;
    commands.push({ oldOid, newOid, ref });
    offset += length;
  }
  if (packStart < 0) return null;
  return { commands, pack: body.subarray(packStart) };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(ctx: GitRequest): void {
  const { res, store } = ctx;
  const repo = store.repo(ctx.owner, ctx.repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' }, ctx.requestId);
    return;
  }
  const parsed = parsePush(ctx.body);
  if (parsed === null || parsed.commands.length === 0) {
    sendJson(res, 400, { message: 'the receive-pack request is not a valid command list' }, ctx.requestId);
    return;
  }
  const { commands, pack } = parsed;

  // Unpack first: every object the pack carries lands in the store, whether
  // or not the ref updates that follow are accepted.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (hasUpdates || pack.length > 0) {
    if (pack.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error: an update needs a pack';
    } else {
      try {
        const read = readPack(pack);
        for (const object of read.objects) {
          const oid = hashObject(object.type, object.data);
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  const reports: RefReport[] = [];
  if (unpackOk) {
    const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // A delete: the old value must name the ref as it stands.
        if (current === undefined) {
          reports.push({ ref: command.ref, ok: false, reason: 'the ref does not exist' });
        } else if (current !== command.oldOid) {
          reports.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          reports.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'the new object is missing' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reports.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reports.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      const newObject = repo.objects.get(command.newOid) as GitObject;
      if (newObject.type === 'commit' && !isAncestor(command.newOid, command.oldOid, lookup)) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (newObject.type !== 'commit' && command.newOid !== command.oldOid) {
        // A tag ref moving to an unrelated tag object is not a fast-forward.
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reports.push({ ref: command.ref, ok: true, reason: '' });
    }
  }

  // The report, pkt-lined inside sideband band 1: `unpack ...`, one `ok`/`ng`
  // line per ref, then a flush packet *inside* the band-1 stream — git's
  // send-pack reads the demuxed stream with a packet reader that dies on
  // EOF, so the stream must end with a flush, not with the pipe closing.
  // After the sideband frames, one raw flush ends the sideband stream.
  const reportLines: Array<string | 'flush'> = [
    unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`,
  ];
  for (const report of reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  reportLines.push('flush');
  const reportBytes = pktLines(reportLines);
  const frames: Buffer[] = [];
  let offset = 0;
  const maxPayload = 65520 - 4 - 1; // one pkt-line frame, minus its header and the band byte
  while (offset < reportBytes.length) {
    const piece = reportBytes.subarray(offset, offset + maxPayload);
    offset += piece.length;
    frames.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  if (frames.length === 0) frames.push(pktLine(Buffer.from([1])));
  frames.push(pktFlush());
  send(res, 200, RECEIVE_RESULT, Buffer.concat(frames), ctx.requestId);
}

/** Everything reachable from a repository's refs (exported for the git tests). */
export function reachableOf(repo: Repo): Set<string> {
  return collectReachable([...repo.refs.values()], (oid) => repo.objects.get(oid), { allowMissing: true });
}

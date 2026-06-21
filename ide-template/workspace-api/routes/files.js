/**
 * /api/files/* — directory listing, text read, raw byte stream, watch SSE.
 *
 * Endpoints:
 *   GET  /api/files/tree?path=<rel>&include_hidden=true
 *        Lazy directory listing.
 *
 *   GET  /api/files/read?path=<rel>
 *        Small text file content as JSON. Refuses binary or > READ_MAX_BYTES.
 *
 *   GET  /api/files/raw?path=<rel>
 *        Streams file bytes with Content-Type. Used for image previews.
 *
 *   GET  /api/files/watch
 *        Long-lived SSE stream of file change events from chokidar.
 */

import { Router } from 'express';
import { statSync } from 'node:fs';
import archiver from 'archiver';
import {
  resolveSafePath, listDir, readTextFile, writeTextFile,
  makeDir, createFile, deletePath, movePath, openRawFile, displayPath,
} from '../lib/files.js';
import { subscribe } from '../lib/watcher.js';
import { requireActor } from '../lib/auth.js';
import { actorScope, actorCanAccess } from '../lib/file-scope.js';

export default function filesRouter() {
  const router = Router();

  // Team-mode actor scoping: a non-admin may only touch the shared team space
  // and their own users/<slug>/ subtree. Call AFTER resolveSafePath. Returns
  // false (and writes a 403) when the path is outside the actor's scope.
  const inScope = (abs, req, res) => {
    if (actorCanAccess(abs, req)) return true;
    res.status(403).json({ error: 'forbidden' });
    return false;
  };

  // Defense-in-depth — nginx auth_request already gates /api/* upstream, but
  // anything inside the container that talks to 127.0.0.1:3001 bypasses it.
  // requireActor cross-checks the JWT cookie on every request, so a malicious
  // MCP / terminal session can't read or mutate project files via this API.
  // Path-scoped to /files so requests for other routers (e.g. /branding,
  // which is intentionally pre-auth) flow through unaffected — every router
  // shares the /api mount point, so an unscoped router.use would gate them all.
  router.use('/files', requireActor);

  router.get('/files/tree', (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    // include_hidden (the "show system files" toggle) is admin-only — it
    // surfaces dotfiles + the users/ tree. Forced off for everyone else so a
    // member can't reveal system paths by passing the flag.
    const wantsHidden = req.query.include_hidden === 'true' || req.query.include_hidden === '1';
    const includeHidden = wantsHidden && actorScope(req).isAdmin;
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;

    let entries;
    try { entries = listDir(abs, { includeHidden }); }
    catch (err) {
      if (err.code === 'ENOENT')  return res.status(404).json({ error: 'not found' });
      if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'not a directory' });
      return res.status(500).json({ error: err.message });
    }
    res.json({ path: displayPath(abs), entries });
  });

  router.get('/files/read', (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;

    const result = readTextFile(abs);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({
      path: relPath.replace(/^\/+/, ''),
      size: result.size,
      mtime: result.mtime,
      content: result.content,
    });
  });

  // GET /api/files/search?q=<query> — workspace-wide search over file NAMES and
  // text CONTENT. Walks the same visible tree as /files/tree (hidden + system
  // paths excluded) and gates every hit through actorCanAccess, so it can never
  // surface a file the user couldn't already open. Binary/oversized files are
  // skipped (readTextFile refuses them). Bounded so a huge tree can't hang the
  // request; the UI debounces.
  router.get('/files/search', (req, res) => {
    const q = (typeof req.query.q === 'string' ? req.query.q : '').trim();
    if (q.length < 2) return res.json({ ok: true, results: [] });
    const ql = q.toLowerCase();
    const rootAbs = resolveSafePath('');
    if (!rootAbs) return res.status(400).json({ error: 'invalid path' });

    const MAX_RESULTS = 40;
    const MAX_DIRS = 4000;
    const MAX_CONTENT_FILES = 1200;
    const results = [];
    let dirsWalked = 0, contentScanned = 0;

    const queue = [{ abs: rootAbs, rel: '' }];
    while (queue.length && results.length < MAX_RESULTS && dirsWalked < MAX_DIRS) {
      const { abs, rel } = queue.shift();
      dirsWalked++;
      let entries;
      try { entries = listDir(abs, { includeHidden: false }); }
      catch { continue; }
      for (const e of entries) {
        if (results.length >= MAX_RESULTS) break;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childAbs = resolveSafePath(childRel);
        if (!childAbs || !actorCanAccess(childAbs, req)) continue;
        if (e.type === 'dir') { queue.push({ abs: childAbs, rel: childRel }); continue; }

        const nameMatch = e.name.toLowerCase().includes(ql);
        let snippet = null, line = null;
        if (contentScanned < MAX_CONTENT_FILES) {
          contentScanned++;
          const r = readTextFile(childAbs);
          if (r.kind === 'ok' && typeof r.content === 'string') {
            const idx = r.content.toLowerCase().indexOf(ql);
            if (idx !== -1) {
              const lineStart = r.content.lastIndexOf('\n', idx) + 1;
              let lineEnd = r.content.indexOf('\n', idx);
              if (lineEnd === -1) lineEnd = r.content.length;
              line = r.content.slice(0, idx).split('\n').length;
              snippet = r.content.slice(lineStart, lineEnd).trim().slice(0, 160);
            }
          }
        }
        if (nameMatch || snippet) results.push({ path: childRel, name: e.name, type: 'file', line, snippet, nameMatch });
      }
    }
    // File-name matches rank above content-only matches.
    results.sort((a, b) => (a.nameMatch === b.nameMatch ? 0 : a.nameMatch ? -1 : 1));
    res.json({ ok: true, results: results.map(({ nameMatch, ...r }) => r) });
  });

  router.post('/files/mkdir', (req, res) => {
    const { path: relPath } = req.body || {};
    if (typeof relPath !== 'string' || !relPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;
    const result = makeDir(abs);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({ path: relPath.replace(/^\/+/, '') });
  });

  router.post('/files/create', (req, res) => {
    const { path: relPath, content } = req.body || {};
    if (typeof relPath !== 'string' || !relPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;
    const result = createFile(abs, content ?? '');
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({ path: relPath.replace(/^\/+/, ''), size: result.size, mtime: result.mtime });
  });

  router.post('/files/move', (req, res) => {
    const { from, to } = req.body || {};
    if (typeof from !== 'string' || !from) return res.status(400).json({ error: 'from is required' });
    if (typeof to   !== 'string' || !to)   return res.status(400).json({ error: 'to is required' });
    const absFrom = resolveSafePath(from);
    const absTo   = resolveSafePath(to);
    if (!absFrom) return res.status(400).json({ error: 'invalid from' });
    if (!absTo)   return res.status(400).json({ error: 'invalid to' });
    if (!inScope(absFrom, req, res)) return;
    if (!inScope(absTo, req, res)) return;
    const result = movePath(absFrom, absTo);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({ from: from.replace(/^\/+/, ''), to: to.replace(/^\/+/, '') });
  });

  router.delete('/files/delete', (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;
    const result = deletePath(abs);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({ path: relPath.replace(/^\/+/, '') });
  });

  router.post('/files/write', (req, res) => {
    const { path: relPath, content } = req.body || {};
    if (typeof relPath !== 'string' || !relPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;

    const result = writeTextFile(abs, content);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.json({
      path: relPath.replace(/^\/+/, ''),
      size: result.size,
      mtime: result.mtime,
    });
  });

  router.get('/files/raw', (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;

    const result = openRawFile(abs);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    res.setHeader('Content-Type',   result.mime);
    res.setHeader('Content-Length', result.size);
    res.setHeader('Cache-Control',  'private, max-age=60');
    result.stream.on('error', () => res.end());
    result.stream.pipe(res);
  });

  // Download — file streams as attachment with original filename, folder
  // streams as a zip with the folder's basename as the archive name. Same
  // resolveSafePath gate as every other route, so escaping PROJECT_DIR or
  // hitting HARD_HIDDEN paths is rejected up front.
  router.get('/files/download', (req, res) => {
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const abs = resolveSafePath(relPath);
    if (!abs) return res.status(400).json({ error: 'invalid path' });
    if (!inScope(abs, req, res)) return;

    let st;
    try { st = statSync(abs); }
    catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
      return res.status(500).json({ error: err.message });
    }

    const baseName = relPath.split('/').filter(Boolean).pop() || 'workspace';

    if (st.isDirectory()) {
      // Zip stream — `archiver` pulls files lazily so memory stays flat.
      // RFC 5987 filename* form keeps non-ASCII names readable in modern
      // browsers; the plain `filename` is a 7-bit fallback for old clients.
      const safeAscii = baseName.replace(/[^\x20-\x7e]/g, '_');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeAscii}.zip"; filename*=UTF-8''${encodeURIComponent(baseName)}.zip`,
      );
      const zip = archiver('zip', { zlib: { level: 6 } });
      zip.on('error', err => {
        process.stderr.write(`[files/download] archiver error: ${err.message}\n`);
        try { res.end(); } catch { /* already closed */ }
      });
      zip.pipe(res);
      // Filtered recursive add — NOT zip.directory(), which walks the raw FS and
      // would sweep in HARD_HIDDEN secrets and every OTHER teammate's private
      // users/<slug>/ + memory/users/<slug>/ tree. Mirror /files/search: only
      // entries listDir deems visible (drops HARD_HIDDEN + dotfiles) AND that
      // actorCanAccess permits (drops cross-user + symlink-resolved escapes).
      const rootRel = relPath.replace(/^\/+|\/+$/g, '');
      const queue = [{ abs, rel: rootRel }];
      while (queue.length) {
        const cur = queue.shift();
        let entries;
        try { entries = listDir(cur.abs, { includeHidden: false }); } catch { continue; }
        for (const e of entries) {
          const childRel = cur.rel ? `${cur.rel}/${e.name}` : e.name;
          const childAbs = resolveSafePath(childRel);
          if (!childAbs || !actorCanAccess(childAbs, req)) continue;
          const sub = rootRel ? childRel.slice(rootRel.length + 1) : childRel;
          const inZip = `${baseName}/${sub}`;
          if (e.type === 'dir') queue.push({ abs: childAbs, rel: childRel });
          else zip.file(childAbs, { name: inZip });
        }
      }
      zip.finalize();
      return;
    }

    // Single file — same path as raw, but with attachment disposition.
    const result = openRawFile(abs);
    if (result.kind === 'error') return res.status(result.status).json({ error: result.error });
    const safeAscii = baseName.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Type',  result.mime);
    res.setHeader('Content-Length', result.size);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
    );
    result.stream.on('error', () => res.end());
    result.stream.pipe(res);
  });

  router.get('/files/watch', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.socket?.setNoDelay?.(true);

    const detach = subscribe(res);
    req.on('close', detach);
  });

  return router;
}

// server.mjs — 本地看板服务（零依赖，仅 Node 内置模块）
//
// 启动： node server.mjs
// 打开： http://localhost:8787
//
// 路由：
//   GET  /                  → 看板 index.html
//   GET  /history/*         → 历史快照
//   POST /api/refresh       → 抓取最新价 → 回写 index.html → 落历史快照
//   POST /api/commit        → git add history && git commit（推到 GitHub 由你手动 push）
//   GET  /api/status        → 最近一次快照的摘要

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runRefresh } from './refresh.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

let running = false;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  // ---- API：刷新 ----
  if (p === '/api/refresh' && req.method === 'POST') {
    if (running) return json(res, 429, { ok: false, error: '已有刷新任务在进行中，请稍候' });
    running = true;
    console.log('\n=== 收到刷新请求 ===');
    try {
      const r = await runRefresh({ onProgress: (s) => console.log(s) });
      json(res, 200, { ok: true, ...r });
    } catch (e) {
      console.error('刷新失败：', e);
      json(res, 500, { ok: false, error: e.message });
    } finally {
      running = false;
    }
    return;
  }

  // ---- API：状态 ----
  if (p === '/api/status') {
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'history', 'index.json'), 'utf8')); } catch {}
    const snaps = idx?.snapshots || [];
    return json(res, 200, { ok: true, count: snaps.length, last: snaps[snaps.length - 1] || null });
  }

  // ---- API：git 提交历史 ----
  if (p === '/api/commit' && req.method === 'POST') {
    try {
      git(['add', 'history']);
      const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
      let out = '';
      try {
        out = git(['commit', '-m', `chore(price): 价格快照 ${ts}`]);
      } catch (e) {
        // 无改动时 commit 会失败，属正常
        out = String(e.stdout || e.message || '');
      }
      return json(res, 200, { ok: true, output: out.trim() });
    } catch (e) {
      return json(res, 500, { ok: false, error: 'git 操作失败：' + (e.stderr || e.message) + '（若尚未 git init，请先在 starpool 目录 git init）' });
    }
  }

  // ---- 静态文件 ----
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404 not found: ' + rel); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log('▶ GPU 价格看板已启动');
  console.log('  打开： http://localhost:' + PORT);
  console.log('  刷新： 点击看板顶部「🔄 刷新价格」，或 POST /api/refresh');
  console.log('  快照：  写入 ./history/，可在 GitHub 备份');
});

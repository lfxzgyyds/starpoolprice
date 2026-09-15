// refresh.mjs — GPU 价格刷新引擎（本地优先）
//
// 做四件事：
//   1) 读取 index.html，解析出当前价格矩阵（基线）
//   2) 依次运行各平台「适配器」抓取最新价（失败则保留基线，不污染数据）
//   3) 把结果回写进 index.html 的 data 块
//   4) 在 history/ 落一个带时间戳的 JSON 快照，并更新 history/index.json
//
// 用法：
//   node refresh.mjs            # 抓取 + 回写 + 落快照
//   node refresh.mjs --dry      # 只抓取并打印，不写任何文件
//   node refresh.mjs --only 阿里云,腾讯云   # 只跑指定平台
//
// 依赖：仅 Node 内置模块（fetch / WebSocket / vm）。CDP 端口默认 9223。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adapters } from './adapters.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(ROOT, 'index.html');
const HIST_DIR = path.join(ROOT, 'history');
const HIST_INDEX = path.join(HIST_DIR, 'index.json');
export const CDP_PORT = Number(process.env.CDP_PORT || 9223);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
export const tsFull = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+08:00`;
export const tsFile = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;

// ---------- 读取看板基线 ----------
function domStub() {
  const el = {
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, insertAdjacentHTML() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {}, remove() {},
    querySelector() { return el; }, querySelectorAll() { return []; },
  };
  return {
    getElementById() { return el; }, createElement() { return el; },
    querySelector() { return el; }, querySelectorAll() { return []; },
    body: el, head: el, documentElement: el, addEventListener() {},
  };
}

export function loadDashboard() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html 中未找到 <script> 块');
  const sandbox = {
    document: domStub(),
    window: { addEventListener() {} },
    console,
    navigator: { userAgent: 'node' },
    location: { href: 'file:///' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    m[1] + '\n;globalThis.__x={data,platforms,cards,urls,fxRate,base};',
    sandbox,
    { filename: 'index.inline.js' }
  );
  return { html, script: m[1], ...sandbox.__x };
}

// ---------- 把矩阵序列化回 data 块 ----------
export function serializeData(data, cards) {
  const j = (v) => JSON.stringify(v == null ? '' : String(v));
  const body = cards
    .filter((c) => data[c] && Object.keys(data[c]).length)
    .map((card) => {
      const rows = Object.entries(data[card]).map(([p, e]) =>
        `    ${j(p)}:d(${j(e.value)},${j(e.status)},${j(e.type)},${j(e.source)},${j(e.note)},${j(e.label || '')},${j(e.unit || '¥/GPU·hr')},${j(e.captured)})`
      ).join(',\n');
      return `  ${j(card)}:{\n${rows}\n  }`;
    })
    .join(',\n');
  return `const data={\n${body}\n}`;
}

export function patchHtml(html, dataBlock) {
  const start = html.indexOf('const data={');
  if (start < 0) throw new Error('未找到 const data={ 块');
  const end = html.indexOf('\n};', start);
  if (end < 0) throw new Error('未找到 data 块结尾');
  return html.slice(0, start) + dataBlock + html.slice(end + 2); // 保留结尾分号
}

// ---------- CDP（连接本地已登录的可见 Chrome） ----------
export async function withCdp(fn, port = CDP_PORT) {
  let ver;
  try {
    ver = await (await fetch(`http://localhost:${port}/json/version`)).json();
  } catch {
    throw new Error(`CDP 端口 ${port} 无响应（请先用可见 Chrome 启动：--remote-debugging-port=${port} --remote-allow-origins=*）`);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')));
    setTimeout(() => rej(new Error('CDP 连接超时')), 8000);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, res);
      const msg = { id: myId, method, params };
      if (sessionId) msg.sessionId = sessionId;
      ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (pending.has(myId)) { pending.delete(myId); rej(new Error('CDP 超时: ' + method)); }
      }, 30000);
    });
  try {
    return await fn({ send, ws, port });
  } finally {
    try { ws.close(); } catch {}
  }
}

// 在指定 host 的标签页里导航 + 执行 JS，返回结果值
export async function cdpRead({ host, url, waitMs = 3500, before, expr }, port = CDP_PORT) {
  return withCdp(async ({ send }) => {
    let targets = (await send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page');
    // 按域名匹配（去掉 www. 前缀），避免 docs.example.com 之类匹配不到而反复新建标签
    const key = host ? host.replace(/^https?:\/\//, '').replace(/^www\./, '') : null;
    let target = key ? targets.find((t) => (t.url || '').includes(key)) : targets[0];
    if (!target) {
      const r = await send('Target.createTarget', { url: 'about:blank' });
      targets = (await send('Target.getTargets')).result.targetInfos.filter((t) => t.type === 'page');
      target = targets.find((t) => t.targetId === r.result.targetId) || targets[0];
    }
    const { sessionId } = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).result;
    if (url) { await send('Page.navigate', { url }, sessionId); await sleep(waitMs); }
    if (before) { await send('Runtime.evaluate', { expression: before, returnByValue: true }, sessionId); await sleep(waitMs); }
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.result && r.result.exceptionDetails) {
      throw new Error('页面脚本异常: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
    }
    return r.result?.result?.value;
  }, port);
}

// ---------- 主流程 ----------
export async function runRefresh({ dry = false, only = null, onProgress = null } = {}) {
  const t0 = Date.now();
  const log = (...a) => { const s = a.join(' '); console.log(s); if (onProgress) onProgress(s); };

  log('▶ 读取看板基线…');
  const { html, data, platforms, cards, urls, fxRate } = loadDashboard();
  log(`  卡型 ${cards.length} · 平台 ${platforms.length}`);

  const baseline = JSON.parse(JSON.stringify(data));
  const merged = JSON.parse(JSON.stringify(data));
  const nowISO = tsFull();

  const ctx = {
    cards, platforms, urls, fxRate, baseline,
    nowISO,
    log,
    fetchText: async (url, opts = {}) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    },
    fetchJson: async (url, opts = {}) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    },
    cdpRead: (o) => cdpRead(o),
    cdpSession: (fn) => withCdp(fn),
    sleep,
  };

  const list = adapters.filter((a) => !only || only.includes(a.platform));
  const perPlatform = {};
  const failures = [];

  for (const ad of list) {
    log(`▶ [${ad.platform}] 抓取中…（${ad.kind}）`);
    try {
      const res = (await ad.run(ctx)) || {};
      const n = Object.keys(res).length;
      if (!n) { log(`  ↳ 无可用结果，保留基线`); failures.push({ platform: ad.platform, reason: 'no-result' }); continue; }
      perPlatform[ad.platform] = res;
      log(`  ↳ 取得 ${n} 个卡型`);
    } catch (e) {
      log(`  ↳ 失败：${e.message}（保留基线）`);
      failures.push({ platform: ad.platform, reason: e.message });
    }
  }

  // 合并
  const changes = [];
  for (const [platform, byCard] of Object.entries(perPlatform)) {
    for (const [card, e] of Object.entries(byCard)) {
      if (!merged[card]) merged[card] = {};
      const old = merged[card][platform];
      merged[card][platform] = e;
      changes.push({ platform, card, from: old ? old.value : '(新增)', to: e.value, status: e.status });
    }
  }

  // 统计
  const all = Object.values(merged).flatMap((o) => Object.values(o));
  const summary = {
    cells: all.length,
    verified: all.filter((x) => x.status === 'verified').length,
    pending: all.filter((x) => x.status === 'pending').length,
    na: all.filter((x) => x.status === 'na').length,
  };

  log(`▶ 本次更新 ${changes.length} 个单元格；矩阵合计 ${summary.cells}（verified ${summary.verified} / pending ${summary.pending} / na ${summary.na}）`);

  if (dry) {
    log('（--dry 模式：不写文件）');
    return { dry: true, changes, failures, summary, ms: Date.now() - t0 };
  }

  // 回写 index.html
  const newBlock = serializeData(merged, cards);
  const newHtml = patchHtml(html, newBlock);
  fs.writeFileSync(INDEX, newHtml, 'utf8');
  log('▶ 已回写 index.html');

  // 落快照
  fs.mkdirSync(HIST_DIR, { recursive: true });
  const file = `prices-${tsFile()}.json`;
  const snapshot = {
    ts: nowISO,
    fxRate,
    source: 'refresh.mjs',
    summary,
    failures,
    changes,
    matrix: merged,
  };
  fs.writeFileSync(path.join(HIST_DIR, file), JSON.stringify(snapshot, null, 2), 'utf8');
  log(`▶ 已写入 history/${file}`);

  // 更新索引
  let idx = { desc: 'GPU 价格历史快照索引', fxRate, snapshots: [] };
  if (fs.existsSync(HIST_INDEX)) {
    try { idx = JSON.parse(fs.readFileSync(HIST_INDEX, 'utf8')); } catch {}
  }
  if (!Array.isArray(idx.snapshots)) idx.snapshots = [];
  idx.fxRate = fxRate;
  idx.snapshots.push({ file, ts: nowISO, summary, changed: changes.length });
  fs.writeFileSync(HIST_INDEX, JSON.stringify(idx, null, 2), 'utf8');
  log(`▶ 已更新 history/index.json（累计 ${idx.snapshots.length} 个快照）`);

  return { file, changes, failures, summary, ms: Date.now() - t0 };
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const onlyArg = args.find((a) => a.startsWith('--only'));
  const only = onlyArg ? (args[args.indexOf(onlyArg) + 1] || onlyArg.split('=')[1] || '').split(',').filter(Boolean) : null;
  runRefresh({ dry, only })
    .then((r) => {
      if (r.failures?.length) {
        console.log('\n保留基线的平台：');
        r.failures.forEach((f) => console.log(`  - ${f.platform}: ${f.reason}`));
      }
      console.log(`\n完成，用时 ${(r.ms / 1000).toFixed(1)}s`);
    })
    .catch((e) => { console.error('刷新失败：', e); process.exit(1); });
}

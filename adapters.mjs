// adapters.mjs — 各平台价格抓取适配器
//
// 每个适配器实现 run(ctx) → { 卡型: 价格条目 }。抛异常或返回空对象时，
// 引擎会保留基线（不会写坏数据），并把该平台列入 failures。
//
// ctx 提供：{ cards, urls, fxRate, baseline, nowISO, log,
//            fetchText(url), fetchJson(url), cdpRead({host,url,waitMs,before,expr}), cdpSession(fn), sleep }

const E = ({ value, status = 'verified', type = 'on-demand', source = '', note = '', label = '', unit = '¥/GPU·hr', captured }) =>
  ({ value, status, type, source, note, label, unit, captured });

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0 Safari/537.36' };

// ============================================================
// 阿里云 · ECS GPU 按量目录价（需登录的可见 Chrome，CDP 9223）
// ============================================================
const ALIYAUN_INST = {
  'gn7e-c16g1.4xlarge': { cards: ['A100'], gpus: 1, desc: '1×A100 80G（16vCPU/125GiB）' },
  'gn8is.2xlarge': { cards: ['L20'], gpus: 1, desc: '1×L20 48G（8vCPU/64GiB）' },
  'gn8v.4xlarge': { cards: ['H20'], gpus: 1, desc: '1×H20 96G（16vCPU/96GiB）' },
  'gn9t.6xlarge': { cards: ['RTX 5090'], gpus: 1, desc: '1×RTX 5090 32G（24vCPU/192GiB）' },
  'gn8t.4xlarge': { cards: ['RTX 4090'], gpus: 1, desc: '1×RTX 4090 24G（16vCPU/128GiB）' },
  'gn6v-c8g1.2xlarge': { cards: ['V100', 'V100_32G'], gpus: 1, desc: '1×V100 32G（8vCPU/32GiB）' },
  'gn6i-c4g1.xlarge': { cards: ['T4'], gpus: 1, desc: '1×T4 16G（4vCPU/15GiB）' },
  'gn7i-c8g1.2xlarge': { cards: ['L4'], gpus: 1, desc: '1×L4 24G（8vCPU/30GiB）' },
};

const aliyun = {
  platform: '阿里云',
  kind: 'cdp',
  async run(ctx) {
    const raw = await ctx.cdpRead({
      host: 'www.aliyun.com',
      url: 'https://www.aliyun.com/price/ecs/ecs-pricing/zh',
      waitMs: 7000,
      expr: `(function(){var o={};document.body.innerText.split('\\n').forEach(function(l){var m=l.match(/ecs\\.([A-Za-z0-9\\.\\-]+)\\t(\\d+)\\t([\\d\\.]+)\\t￥([\\d\\.]+)/);if(m)o[m[1]]={vcpu:+m[2],mem:+m[3],price:+m[4]};});return JSON.stringify(o);})()`,
    });
    const tbl = JSON.parse(raw || '{}');
    const out = {};
    for (const [inst, meta] of Object.entries(ALIYAUN_INST)) {
      if (!tbl[inst]) continue;
      const per = tbl[inst].price / meta.gpus;
      const e = E({
        value: `¥${per.toFixed(2)}`,
        source: 'https://www.aliyun.com/price/ecs/ecs-pricing/zh',
        note: `ECS GPU 实例 ${inst} = ${meta.desc}，按量目录价 ¥${tbl[inst].price}/实例·小时 ÷${meta.gpus} = ¥${per.toFixed(2)}/卡·小时（中国大陆区）`,
        label: '官方 ECS 按量目录价',
        captured: ctx.nowISO,
      });
      meta.cards.forEach((c) => { out[c] = e; });
    }
    if (!Object.keys(out).length) throw new Error('未解析到已知 GPU 实例（页面结构可能变化或未登录）');
    return out;
  },
};

// ============================================================
// 火山引擎 · 官方计费文档（通用队列按量价表，CDP 渲染）
// ============================================================
const VOLC_MAP = { A100: ['A100'], L20: ['L20'], L4: ['L4'], T4: ['T4'], V100: ['V100', 'V100_32G'], A30: ['A30'], '4090D': ['RTX 4090'] };

const volcengine = {
  platform: '火山引擎',
  kind: 'cdp',
  async run(ctx) {
    const raw = await ctx.cdpRead({
      host: 'www.volcengine.com',
      url: 'https://www.volcengine.com/docs/84772/1263500',
      waitMs: 6000,
      expr: `(function(){var t=document.body.innerText,o={},re=/([A-Za-z][A-Za-z0-9]{1,10})\\*1[\\s\\S]{0,160}?([\\d]+(?:\\.[\\d]+)?)\\s*元\\/GPU\\/小时/g,m;while((m=re.exec(t))){o[m[1]]=parseFloat(m[2]);}return JSON.stringify(o);})()`,
    });
    const tbl = JSON.parse(raw || '{}');
    const out = {};
    for (const [k, cards] of Object.entries(VOLC_MAP)) {
      if (tbl[k] == null) continue;
      const e = E({
        value: `¥${tbl[k]}`,
        source: 'https://www.volcengine.com/docs/84772/1263500',
        note: `通用队列按量付费（华北2北京/华东2上海）：${k}*1，${tbl[k]} 元/GPU/小时`,
        label: '官方文档价',
        captured: ctx.nowISO,
      });
      cards.forEach((c) => { out[c] = e; });
    }
    if (!Object.keys(out).length) throw new Error('未解析到价表（文档结构可能变化）');
    return out;
  },
};

// ============================================================
// 腾讯云 · 官网 CVM 价格计算器（公开）
// ============================================================
const TX_MAP = { 'GN7.2XLARGE32': ['T4'], 'GN10Xp.2XLARGE40': ['V100_32G'], 'GT4.4XLARGE96': ['A100'] };

const tencent = {
  platform: '腾讯云',
  kind: 'cdp',
  async run(ctx) {
    const raw = await ctx.cdpRead({
      host: 'cloud.tencent.com',
      url: 'https://buy.cloud.tencent.com/price/cvm/calculator',
      waitMs: 7000,
      before: `(function(){var a=document.querySelectorAll('*');for(var i=0;i<a.length;i++){if((a[i].innerText||'').trim()==='GPU机型'){a[i].click();return 1;}}return 0;})()`,
      expr: `(function(){var o={},re=/(GN[0-9A-Za-z\\.x]+|GT[0-9A-Za-z\\.x]+)[\\s\\S]{0,80}?(\\d+(?:\\.\\d+)?)\\s*(?:元|¥)/g,m,t=document.body.innerText;while((m=re.exec(t))){o[m[1]]=parseFloat(m[2]);}return JSON.stringify(o);})()`,
    });
    const tbl = JSON.parse(raw || '{}');
    const out = {};
    for (const [inst, cards] of Object.entries(TX_MAP)) {
      if (tbl[inst] == null) continue;
      const e = E({
        value: `¥${tbl[inst]}`,
        source: 'https://buy.cloud.tencent.com/price/cvm/calculator',
        note: `${inst} 官网价格计算器按量 T1 档 ¥${tbl[inst]}/实例·小时（公开计算器抓取）`,
        label: '官网计算器价',
        captured: ctx.nowISO,
      });
      cards.forEach((c) => { out[c] = e; });
    }
    if (!Object.keys(out).length) throw new Error('未解析到 GPU 机型表（计算器结构可能变化）');
    return out;
  },
};

// ============================================================
// 网鼎(立方云) · 公开 API（HTTP，无需浏览器）
// ============================================================
const lifang = {
  platform: '网鼎(立方云)',
  kind: 'http',
  async run(ctx) {
    const data = await ctx.fetchJson('https://www.lifangyun.com/api/v1/home/compute-instances/display', { headers: UA });
    const items = data?.data?.items || data?.items || (Array.isArray(data) ? data : []);
    const out = {};
    // 只取「按小时 + 1 张」的单卡条目
    const single = items.filter((x) => x.price_unit === 'hour' && /1\s*张/.test(String(x.gpu_spec || '')));
    for (const it of single) {
      const title = String(it.title || '');
      const p = it.price;
      if (p == null) continue;
      if (/5090/i.test(title)) out['RTX 5090'] = E({ value: `¥${p}`, type: '按小时', source: 'https://www.lifangyun.com/api/v1/home/compute-instances/display', note: `官网公开 API：${title} · ${it.gpu_spec} · price=${p} ${it.price_unit}`, label: '官网明码价', captured: ctx.nowISO });
      else if (/PRO\s*6000/i.test(title)) out['PRO 6000 BLACKWELL'] = E({ value: `¥${p}`, status: 'pending', type: '按小时', source: 'https://www.lifangyun.com/api/v1/home/compute-instances/display', note: `官网公开 API：${title} · ${it.gpu_spec} · price=${p}；页面未标注 Blackwell，型号待确认`, label: '型号待确认', captured: ctx.nowISO });
    }
    if (!Object.keys(out).length) throw new Error('API 未返回可解析的单卡小时价条目');
    return out;
  },
};

// ============================================================
// RunPod · 官网价格页（HTTP，JSON-LD / 文本解析）
// ============================================================
const RUNPOD_MAP = {
  'H100': ['H100'], 'H200': ['H200'], 'A100': ['A100'], 'L40S': ['L40S'], 'L40': ['L40'], 'L4': ['L4'],
  'RTX 6000 Ada': ['RTX 6000 Ada'], 'A6000': ['A6000'], 'T4': ['T4'], 'A40': ['A40'], 'RTX PRO 6000': ['RTX PRO 6000'],
};

const runpod = {
  platform: 'RunPod',
  kind: 'http',
  async run(ctx) {
    const html = await ctx.fetchText('https://www.runpod.io/pricing', { headers: UA });
    // 从页面中提取 “型号 … $x.xx/hr” 的最小价
    const out = {};
    const re = /([A-Za-z0-9 ]{2,18}?(?:H100|H200|A100|L40S|L40|L4|RTX 6000 Ada|A6000|T4|A40|RTX PRO 6000|RTX Pro 6000))[^$]{0,120}?\$\s*([0-9]+\.[0-9]+)/gi;
    const found = {};
    let m;
    while ((m = re.exec(html))) {
      const key = m[1].trim();
      const v = parseFloat(m[2]);
      if (!(key in found) || v < found[key]) found[key] = v;
    }
    for (const [k, cards] of Object.entries(RUNPOD_MAP)) {
      const hit = Object.keys(found).find((f) => f.toLowerCase().includes(k.toLowerCase()));
      if (hit == null) continue;
      const cny = (found[hit] * ctx.fxRate).toFixed(2);
      const e = E({ value: `¥${cny}`, type: 'Community / Secure on-demand', source: 'https://www.runpod.io/pricing', note: `${hit} $${found[hit]}/GPU·hr × ${ctx.fxRate}（页面解析最低价）`, label: '官网价', captured: ctx.nowISO });
      cards.forEach((c) => { out[c] = e; });
    }
    if (!Object.keys(out).length) throw new Error('未从价格页解析到已知型号');
    return out;
  },
};

// ============================================================
// 汇总注册表（未列入的平台 = 不自动抓取，保留基线）
// ============================================================
// 已跑通并启用：阿里云、火山引擎、网鼎(立方云)、RunPod
// 待补（代码保留但暂未启用，避免每次刷新产生失败噪音）：
//   - tencent：腾讯云计算器是 SPA，GPU机型 tab 由前端事件驱动，需进一步逆向后再启用
//   - AutoDL：登录态 + 专区 radio 多步交互，DOM 较脆，后续单独适配
export const adapters = [
  aliyun,
  volcengine,
  lifang,
  runpod,
];

// 保留导出，便于后续启用
export { tencent };

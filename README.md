# GPU 算力价格横向对比 · 本地刷新看板

本地优先：看板与数据都在本机；每次刷新在 `history/` 落一个历史快照，可提交到 GitHub 做备份。

## 目录

```
starpool/
├── index.html          # 看板（统一矩阵 / 海外 / 中国 / 我方基准 / 历史快照）
├── server.mjs          # 本地服务：提供「🔄 刷新价格」按钮的后端 + git 提交
├── refresh.mjs         # 刷新引擎：抓取 → 回写 index.html → 落历史快照
├── adapters.mjs        # 各平台抓取适配器
├── history/            # 历史快照（每次刷新一个 JSON）+ index.json 索引
└── .gitignore
```

## 使用

### 1. 启动本地服务（推荐，才有刷新按钮）

```bash
cd starpool
node server.mjs
```

浏览器打开 <http://localhost:8787> ，点顶部 **🔄 刷新价格** 即可：
抓最新价 → 回写 `index.html` → 写入 `history/prices-<时间戳>.json` → 页面自动重载。

### 2. 或直接命令行刷新（无按钮）

```bash
node refresh.mjs           # 抓取 + 回写 + 落快照
node refresh.mjs --dry     # 只抓取并打印，不写文件
node refresh.mjs --only 阿里云,火山引擎   # 只跑指定平台
```

### 3. GitHub 备份

```bash
cd starpool
git init
git add .
git commit -m "GPU 价格看板 + 历史快照"
git remote add origin <你的仓库地址>
git push -u origin main
```

之后每次刷新产生的 `history/*.json` 直接 `git add history && git commit && git push` 即可。
（本地服务还提供 `POST /api/commit`：自动 `git add history` 并 commit，push 仍由你手动执行。）

## 抓取范围

| 平台 | 自动刷新 | 说明 |
|---|---|---|
| 阿里云 | ✅ CDP | 登录后 ECS 价格详情页，取 ECS GPU 实例按量目录价 |
| 火山引擎 | ✅ CDP | 官方计费文档通用队列按量价表 |
| RunPod | ✅ HTTP | 官网价格页解析 |
| 网鼎(立方云) | ✅ HTTP | 官网公开 API |
| 腾讯云 | ⏳ 待补 | 计算器为 SPA，GPU机型 tab 由前端事件驱动，需进一步逆向 |
| AutoDL | ⏳ 待补 | 需登录态 + 专区 radio 多步交互，DOM 较脆 |
| 华为云 / 智星云 / IO.net / AWS / Google Cloud / Vast.ai / 我方平台 | 保留基线 | 未接入自动抓取，刷新时沿用看板中现值 |

> 未接入自动抓取的平台，刷新时会**原样保留**看板里的现值，不会被清空。

## 前置条件

- **Node 18+**（用到内置 `fetch` / `WebSocket`；本机用 22.x 已验证）。
- 需登录的平台（阿里云、火山引擎）依赖一个**已登录的可见 Chrome**：

```bash
chrome.exe --remote-debugging-port=9223 --remote-allow-origins=* --user-data-dir=<独立目录>
```

在该窗口登录阿里云 / 火山引擎后，`refresh.mjs` 通过 CDP(9223) 读取页面。
登录态过期时，刷新会**保留基线**并在结果里列出该平台，重新登录后再点一次即可。

## 调端口

```bash
PORT=9000 node server.mjs        # 改本地服务端口
CDP_PORT=9223 node refresh.mjs   # 改 Chrome 调试端口
```

## 部署到 GitHub Pages（分享给别人看）

线上是**只读快照**：查看价格矩阵 / 价格预警 / 导出 Excel / 历史快照 都可用；「🔄 刷新价格」按钮在线上会**自动禁用**（刷新仍需在本地跑 `node server.mjs`）。

### 首次部署

```bash
cd starpool
git init                       # 如尚未初始化
git add .
git commit -m "GPU 价格看板"
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

然后在 GitHub 仓库里：**Settings → Pages → Source 选「Deploy from a branch」→ Branch 选 `main` + `/ (root)` → Save**。
约 1 分钟后访问：

```
https://<用户名>.github.io/<仓库名>/
```

### 更新线上数据

本地刷新后再推一次即可（GitHub Pages 会自动重建）：

```bash
node server.mjs        # 打开 http://localhost:8787，点「🔄 刷新价格」
git add . && git commit -m "价格快照 $(date +%F)" && git push
```

### 注意事项

- 免费版 GitHub Pages 站点是 **公开的**，任何人拿到链接均可访问。
- 仓库已包含 `.nojekyll`，避免 GitHub Pages 用 Jekyll 处理时忽略 `_` 开头的文件。
- 若不希望公开 `_hw*.html/js/json` 等旁支文件，把它们加入 `.gitignore` 或移到独立仓库。
- 需要绑定自有域名，可在 Settings → Pages → Custom domain 配置。
- 想要「云端自动刷新」需借助 GitHub Actions，但**需要登录的平台（阿里云/火山引擎）在云端抓不了**（无本地登录态），只能跑免登录平台。

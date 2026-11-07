# 盯盘 · A股涨停实时盯盘

Windows / macOS 本地客户端：涨停 / 连板 / 炸板实时监控、连板天梯、语音播报、涨停雷达、筛选跳转、本地缓存加速。

技术栈：Vite + React + Ant Design + ECharts；FastAPI + SQLite；桌面壳 **pywebview + 便携 Python**（发给别人的安装包自带运行时，**无需预装 Node / Python**）。

> 行情来自东方财富 / 同花顺等公开接口，仅供个人研究，不构成投资建议。

---

## 发给其他用户（推荐）

功能改完后，在仓库根目录**双击**或命令行执行：

```bat
一键打包.bat
```

等价 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\prepare-resources.ps1 -OpenFolder
```

常用可选参数（`一键打包.bat` 也可带）：

| 参数 | 说明 |
|------|------|
| `--skip-frontend` | 跳过前端构建（仅改后端 / 启动器 / 文档时） |
| `--with-setup` | 额外编译 Inno 安装包（需已装 Inno Setup） |
| `--no-zip` | 不打 zip，只刷新 `out\DingPan` 目录 |

把下面任一产物发给对方即可：

| 产物 | 说明 |
|------|------|
| `packaging\out\DingPan-portable.zip` | **推荐发送这个 zip** |
| `packaging\out\DingPan\` | 解压后的完整目录（可直接拷贝） |

### 对方电脑怎么用

1. 解压 zip 到任意目录（如桌面、`D:\DingPan\`）
2. 双击 **`一键安装启动.bat`**（或 `DingPan.bat`）
3. 等待桌面窗口打开；首次拉数可能需几十秒～两分钟
4. 顶部显示「已连接」且涨停数量不为 0（交易日）即正常

对方电脑要求：

- Windows 10 / 11（64 位）
- 一般已自带 **WebView2**；若窗口空白，安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
- 能访问外网（拉取行情）
- **不需要** 安装 Python、Node.js

用户说明也在包内：`使用说明.txt`、`docs\使用手册.md`。

---

## 功能说明

### 1. 实时监控

| 功能 | 说明 |
|------|------|
| 连接状态 | 「已连接 / 重连中」+ 最近更新时间；WebSocket 推送 |
| 统计卡片 | 涨停、连板、封板率、炸板、跌停（今日 vs 昨日） |
| 分类 Tab | 涨停 / 连板 / 炸板 / 跌停 |
| 筛选栏 | 名称/代码模糊搜索；涨停时间；成交额/自由流通/实际流通（亿）；地域 |
| 监控表格 | 默认按首封时间倒序；列可自定义 |
| 行点击详情 | 基本面 + 涨停雷达（带本地缓存，二次打开更快） |

盘中轮询默认 **2.5 秒**（可在设置中改 1～30 秒）；盘后自动降频。

### 2. 连板天梯

| 功能 | 说明 |
|------|------|
| 晋级进度 / 晋级率 | 如「1进2」及成功比例 |
| 成 / 败 / 炸 | 晋级状态标注 |
| 点击名称 | 打开分时 / 日线图（弹窗约 80% 视口高） |
| 列表小按钮 | 跳转「实时监控」并选中该股、打开详情 |

### 3. 股票详情与涨停雷达

基本面、近一年封板/连板率、涨停基因指标、价格轨迹与涨跌停明细（部分来自同花顺）。

### 4. 语音播报

设置中可开关（默认关闭）；开启后按「实时播报」播新涨停 / 连板 / 炸板。

### 5. 设置项

| 项 | 说明 |
|------|------|
| 盘中轮询间隔 | 1～30 秒，保存后下一轮生效 |
| 表格列 / 详情字段 | 勾选显示内容 |
| 语音 | 开关与事件类型 |
| 持久化 | `%APPDATA%\DingPan\user_config.json` |

### 6. 缓存与数据

| 内容 | 位置 / 策略 |
|------|------|
| 用户配置 / 历史库 | `%APPDATA%\DingPan\` |
| 服务端接口缓存 | SQLite `payload_cache`（雷达/分时/日线等），约每 10 分钟清理过期 |
| 浏览器缓存 | localStorage，加速二次打开 |

---

## 开发者：源码一键启动（浏览器）

拷贝**完整源码仓库**到新电脑后：

```bat
一键安装启动.bat
```

会自动安装 Python/Node（若缺失）、依赖，并打开 `http://127.0.0.1:5173/`。  
这与「发给普通用户的便携包」不同：源码模式适合改代码；**普通用户请发 zip 便携包**。

其他开发命令见下方「开发环境」。完整界面说明见 [docs/使用手册.md](docs/使用手册.md)。

---

## 开发环境

### 要求

- Node.js `20.19.x` 或 `22.12+`（建议使用 22.12+）、Python 3.11+
- Windows 10/11 + WebView2；macOS 使用系统 WebKit，不安装 WebView2

### 安装与启动

```bat
python -m venv .venv
.\.venv\Scripts\pip install -r apps\server\requirements.txt
cd apps\web && npm install && cd ..\..
start-dev.bat
```

桌面壳（会自动 `npm run build`、同步到 `apps\server\web_dist`、刷新 pip 依赖后启动）：

```bat
start-desktop.bat
```

仅重启、跳过前端构建 / pip：

```bat
start-desktop.bat --skip-build
start-desktop.bat --skip-build --skip-pip
```

### 停止运行

```bat
停止盯盘.bat
```

（或 `stop.bat`）仅结束能够确认属于当前项目目录的盯盘进程，不会按端口直接结束其他程序。

### 目录结构

```
DingPan/
├── apps/web|server|desktop
├── packaging/          # 打包脚本与产物 out/
├── docs/使用手册.md
├── 一键打包.bat        # 打便携 zip（发给用户）
├── 一键安装启动.bat    # 源码环境一键（开发用）
├── 停止盯盘.bat        # 终止服务
├── start-dev.bat
└── start-desktop.bat
```

---

## 常见问题

| 现象 | 处理 |
|------|------|
| 已连接但全是 0 | 等 1～2 分钟；确认交易日与外网；重启 |
| 窗口空白 | 安装/修复 WebView2 |
| 无语音 | Windows 语音包 + 设置里开启播报 |
| 端口占用 | 结束占用 17831 的进程，或设 `DINGPAN_PORT` |
| 详情/图表慢 | 首次需拉网；第二次起走缓存会快很多 |

---

## 可选：Inno 安装包

已装 [Inno Setup](https://jrsoftware.org/isinfo.php) 时：

```bat
一键打包.bat --with-setup
```

得到 `packaging\out\DingPan-Setup-*.exe`（也可手动编译 `packaging\DingPan.iss`）。


## macOS（Intel / Apple Silicon）

目前提供源码运行方式，浏览器与 pywebview 桌面窗口共用同一套前后端。
`packaging/out/DingPan-portable.zip` 和 Inno Setup 产物仅适用于 Windows；尚未提供签名、公证的 macOS `.app` / `.dmg`。

先安装 Python 3.11+ 或 uv，建议使用 Python 3.11 / 3.12。不要从 Windows 复制 `.venv`、`node_modules`、`.tools`，这些目录需要在 Mac 上重新创建。

在终端切换到项目目录，然后执行：

```bash
# 准备环境；有 uv 时可自动取得 Python，缺少合适 Node 时下载对应 CPU 的 Node
bash scripts/dev.sh --setup-only

# 桌面模式：按需构建前端后打开窗口
bash scripts/dev.sh --desktop

# 或浏览器开发模式（前后端热更新），Ctrl+C 退出
bash scripts/dev.sh

# 在另一个终端停止当前目录的盯盘进程
bash scripts/dev.sh --stop
```

也可以使用 `make setup`、`make desktop`、`make dev`、`make stop`。
第一次使用 Finder 双击入口前，执行：

```bash
chmod +x *.command
```

随后双击 `启动盯盘.command`、`开发模式.command` 或 `停止盯盘.command`。
首次安装需要联网；若没有 uv 和 Python，先安装其中一个，脚本会给出提示。
macOS 桌面模式需要 pywebview 的 PyObjC 依赖，安装 requirements 时由平台依赖自动安装；渲染器使用系统 WKWebView。
官方说明：<https://pywebview.flowrl.com/guide/installation.html>。

macOS 用户配置和数据库位于 `~/Library/Application Support/DingPan/`。
开发端口默认 17831 / 5173；端口冲突时脚本报错并保留其他程序。
如需改后端端口，使用 `DINGPAN_PORT=17832 bash scripts/dev.sh`，前端代理随之调整。
语音使用系统语音能力，是否可用及中文音色需在目标 Mac 实测。

## 工程检查

```bash
npm --prefix apps/web run lint
npm --prefix apps/web test
npm --prefix apps/web run build
# Windows 将下方解释器替换为 .venv\Scripts\python.exe
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m pip check
```

工程测试使用隔离的临时数据目录，不读取或改写实际用户设置和行情数据库。
配置保存使用同目录临时文件和原子替换；读取异常会保留原文件并记录告警。
缓存持久化故障会记录限频日志，仍按原有策略回退，不改变行情和缓存时效规则。

前端 Hook 单元测试通过模拟浏览器 API 检查 WebSocket 回调更新、重连清理、语音队列顺序与去重，不替代真实浏览器或 macOS 原生窗口验收。


## 连接状态与提醒

- 顶部区分「连接中 / 已连接 / 重连中」，断线时说明当前保留的是上次收到的数据，并提供「立即重连」。
- 自动重试间隔依次为 2、4、8、16、30 秒，后续保持 30 秒；单次连接等待超过 10 秒会重新尝试。恢复连接后重置重试间隔。
- 网络恢复时立即尝试重连；浏览器网络状态不会主动断开仍可使用的本地连接。
- 曾成功连接后持续断线 5 秒才弹出页内提醒，同类断线提醒最多每分钟一次；有过断线提醒时，恢复后提示一次。
- 点击连接状态旁的铃铛，可开启「系统连接提醒」并发送测试提醒。默认关闭，仅在用户操作时申请通知权限，偏好保存在本机浏览器。
- 系统提醒只用于连接断开和恢复，在窗口后台或失去焦点时提交；系统是否展示取决于浏览器、桌面 WebView、通知权限和勿扰模式。不支持时保留页内提示，不影响行情功能。
- 「已连接」仅表示本地服务连接正常，请结合行情更新时间判断数据是否更新。

通知 API 说明：<https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API>。

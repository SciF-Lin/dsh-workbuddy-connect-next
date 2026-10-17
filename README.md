# DSH WorkBuddy Connect (Next)

把已登录的 **WorkBuddy 桌面 App** 中的模型接入 DeepSeek Harness（内核 `0.2.1-rc.2` 线），
复用 App 自身的登录状态，无需额外配置。

这是对 [`corrinehu/dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect)
的**重写适配版**：思路相同（读取 App 的加密凭据 → 拉取模型目录 → 以 OpenAI 兼容协议转发对话），
但实现完全基于当前内核的扩展点，不再依赖 `@earendil-works/pi-ai`、不再起本地回环代理。

## 为什么旧版会“炸”

旧版 `dsh-workbuddy-connect@0.7.5/0.7.6` 在 `package.json` 里把 7 个
`@deepseek-ai/dsh-*` peer 依赖**精确锁定**在 `0.2.0-rc.2`，又没有声明 `engines.dsh`。
内核 `0.2.1-rc.2` 的 `dsh-app-boot` 在**导入插件之前**先做兼容性校验：
`semver.satisfies("0.2.1-rc.2", "0.2.0-rc.2") === false` → 整个 bundle 被静默跳过
（只写一行 stderr），`apply()` 从未执行，模型分组自然消失。

## 设计

旧内核的接法是“pi-ai provider + 回环 OpenAI 代理”：插件起一个 `127.0.0.1` 的
OpenAI 兼容端点，再把 pi-ai 指过去。当前内核已经把这件事做成一等扩展点：

```
ctx.llm.registerAdapter(['workbuddy'], adapter)
```

本插件因此只剩一层：**一个原生 `LlmAdapter`**。

| 模块 | 职责 |
|---|---|
| `lib/credential.js` | 定位并解密 WorkBuddy 凭据；调用 App 自带的 Electron 二进制取静态保护密钥；按需刷新 token |
| `lib/upstream.js` | 请求头、消息/工具投影、SSE 解析、模型目录、错误分类 |
| `lib/catalog.js` | 模型目录（上游 → 磁盘缓存 → 内置兜底），到期刷新 |
| `lib/adapter.js` | `LlmAdapter` 实现：provider 信息、模型能力（含探测档位）、流式块翻译、显隐过滤 |
| `lib/probe.js` | 推理档位检测协议（baseline → sentinel → 逐档探测） |
| `lib/preferences.js` | 按账号保存的模型显隐与探测结果（原子写、版本化） |
| `lib/api.js` | 面向浏览器半边的 same-origin API：状态、积分、显隐、检测 |
| `index.js` | Cordis 插件入口：注册 provider、注册 HTTP 路由、后台刷新目录 |
| `client.js` | 浏览器半边：输入框余额徽章 + 插件页配置卡片 |

关键点：

- **凭据只读**：直接读 App 的 `workbuddy-desktop.info`，token 刷新写到插件自己的
  `$DSH_HOME/.workbuddy-connect-next-auth.json`，从不改 App 文件。
- **加密凭据**：WorkBuddy 5.6+ 的 `accessToken` / `refreshToken` 是
  `{$wbEncrypted:1, envelope}` 信封；密钥来自 App 的私有绑定
  `electron_browser_workbuddy_storage.loggerGet()`，用
  `ELECTRON_RUN_AS_NODE=1` 启动 App 自身二进制取回，再 `SHA256(base64文本)` 派生
  `AES-256-GCM` 密钥。
- **流式翻译**：上游 SSE（`delta.content` / `delta.reasoning_content` /
  `delta.tool_calls` / `finish_reason` / `usage`）→ 内核 `StreamChunk`
  （`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
  `block-end` / `usage` / `finish`）。
- **模型目录**：`GET /v3/config`（CLI UA），取 `data.models ∩ agents[name=cli].models`，
  含上下文窗口、最大输出、图片、工具、推理档位与倍率。
- **错误语义**：自建 `failure` 快照，让 `AUTH` / `QUOTA` / `RATE_LIMIT` /
  `SERVER` 能被内核的重试与提示正确识别。

## 界面与交互

浏览器半边（`client.js`）有两处入口，数据全部来自 Host 的 same-origin API：

- **输入框余额徽章**（`conversation.input.right`，模型选择器/发送键旁）：登录后显示
  `WB 469`，页内首次挂载读取一次真实积分（之后点击徽章才刷新）；查询失败显示 `WB !`，
  悬停可看原因。
- **插件页卡片**（插件面板 → 本插件 → 页面视图；`plugins.bundle.config`，key = 包名）：
  账号与令牌有效期、剩余积分与套餐明细（按套餐名聚合）、模型目录来源与刷新、
  逐模型显隐、逐模型推理档位检测。所有写操作都带 `x-workbuddy-connect: 1` 请求头，
  Host 只接受回环且同源 `Origin` 的请求。

### 模型显隐

按账号（`uid:enterpriseId`）保存隐藏列表到
`$DSH_HOME/.workbuddy-connect-next-visibility.json`；新账号与新模型默认可见。
隐藏只影响 `listModels`（选择器可选性），`resolveModel` 不过滤，正在使用已隐藏模型的
会话不受影响。

### 推理档位检测

只有未声明 `supportedEfforts` 的模型才提供「检测档位」，沿用原插件的三段式协议：

1. baseline（不带 `reasoning_effort`）确认请求本身可用；
2. sentinel（随机非法值）确认上游确实校验该参数；
3. 只有 sentinel 被拒时，才逐个尝试 `low|medium|high|xhigh|max`。

结果按账号与模型指纹存入 `$DSH_HOME/.workbuddy-connect-next-probe.json`（14 天有效）。
`resolveModel` 只对「未声明且验证通过」的模型暴露探测到的档位，声明过的档位永远优先；
非校验模型显示「该模型不校验该参数」，不给档位菜单。
检测必须点击卡片上的确认才会发请求（每次 2～7 个极短请求，会消耗少量积分）。

## 安装

```powershell
# 当前 profile（桌面版为 desktop，由 Desktop App 管理；用插件管理器安装）
dsh plugin --profile <profile> add E:\path\to\dsh-workbuddy-connect-next
```

或由 Agent 调用 `plugin_manager install_bundle`，目标为**包目录的绝对路径**。
安装后模型选择器出现「WorkBuddy」分组，重启或等 HMR 生效。

## 前置

- 本机已安装并登录 WorkBuddy 桌面 App。
- App 安装在非默认路径时，设置用户级环境变量
  `WORKBUDDY_ELECTRON_BIN=E:\path\to\WorkBuddy.exe`（插件也支持从卸载注册表自动发现）。
- 凭据文件默认位置：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，
  可用 `WORKBUDDY_AUTH_FILE` 覆盖。

## 已验证

- 凭据解密链路（真实密钥 + AES-GCM 解封）✅
- 模型目录拉取（18 个可用模型）✅
- 文本流、推理流（`reasoning_content` → reasoning 块）、工具调用与工具结果续轮 ✅
- 通过 DSH 正式链路：以 `workbuddy/glm-5.3-flash` 启动子 Agent，完成一次带工具调用的对话 ✅
- 余额查询：真实计费接口返回合计积分与套餐明细，按套餐名聚合 ✅
- 模型显隐：隐藏后 `listModels` 立即不再列出，`resolveModel` 仍可解析 ✅
- 推理档位检测：`glm-5.2` 实测为 `non-validating`（sentinel 被接受，2 个请求即停止）✅
- 浏览器半边：模块加载器契约与两个 Slot 注册参数由沙箱测试校验 ✅（页面渲染需刷新页面后确认）

## 与旧版的功能差异（未移植）

- `status` / `doctor` / `logout` 命令行与 `dsh-workbuddy-connect` bin
- 国际版（WorkBuddy AI）变体、更新提示、心跳
- 模型名的费率后缀与促销徽章（目录里已有 `badges` 字段，卡片暂只显示「免费」）
- 上下文窗口偏好（是否使用上游最大窗口）
- 推理档位的批量检测/自动检测（当前为逐模型手动确认）

## 许可

MIT。凭据解密与上游协议参照 `corrinehu/dsh-workbuddy-connect`（MIT）的实现整理，
本项目与其作者、腾讯、WorkBuddy、DeepSeek 均无隶属或背书关系。

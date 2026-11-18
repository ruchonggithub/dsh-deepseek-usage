# dsh-quota-usage

一个 **DeepSeek Harness（DSH）** 的额度与用量插件：在侧边栏告诉你**当前选中的模型背后还剩多少钱 / 多少积分 / 多少订阅余量**，**这个模型此刻什么价**，并把**会话里每个厂商、每个模型花了多少**按计费类型算清楚。

- **余额 / 积分 / 订阅余量**——预充值型看余额（带币种符号），积分型看渠道余量与百分比，订阅型按接口返回的窗口各画一个仪表盘。
- **单价可配**——103 条出厂价（18 个渠道），设置页里直接改，改完立即参与金额计算，不用重启。
- **用量统计**——回放会话日志，按**订阅型 / 预充值型 / 积分型**先分一层，再在每个类型下按**厂商 → 模型**汇总，带输入价 / 输出价 / 总额。
- **树形明细**——会话内「用量」页可一层层展开到单个厂商、单个模型；另有按工作区的汇总。

这是一个**私有插件**（`private: true`），不发 npm，只从 GitHub 仓库拉下来本地安装。

---

## 一、安装（从 GitHub clone）

DSH 的插件不是「把文件夹拷进 `node_modules` 就行」。宿主按 **profile 的 `package.json`** 解析依赖，再按 profile 的 **`cordis.patch.yml`** 注册插件。少做任何一步都不生效。

### 0. 先认清你的 profile 在哪

```
$DSH_HOME/profiles/<profileName>/
```

- `$DSH_HOME` 不设时默认为 `~/.dsh`（Windows 是 `C:\Users\<你>\.dsh`）。
- 桌面版常用 profile 名是 `desktop`，命令行 `dsh web` 常用 `web`。用哪个就在哪个里装。
- profile 目录里有两个关键文件：`package.json`（`dependencies` 声明插件）和 `cordis.patch.yml`（注册插件）。
- profile 用 **pnpm** 管理，并带 `pnpm-workspace.yaml`（`nodeLinker: hoisted`、`autoInstallPeers: false`）。

### 路线 1（推荐）：本地 clone + link

```sh
git clone https://github.com/ruchonggithub/dsh-quota-usage.git
cd dsh-quota-usage && git checkout dev
```

然后编辑 **profile** 的 `package.json`，往 `dependencies` 里加一条**绝对路径**的 link：

```json
{
  "dependencies": {
    "@ruchonggithub/dsh-quota-usage": "link:/绝对/路径/dsh-quota-usage"
  }
}
```

再在 profile 目录里装：

```sh
cd "$DSH_HOME/profiles/desktop"
pnpm install
```

最后确认 profile 的 `cordis.patch.yml` 里注册了这个插件（本包自带的 `cordis.patch.yml` 声明了同一条，宿主加载 bundle 时会自动插入；如果你在 profile 里手写了，写成一样即可）：

```yaml
- insert:
    - id: quota-usage
      name: '@ruchonggithub/dsh-quota-usage'
```

> **`id` 与 `name` 是两件事**：`name` 必须**逐字等于** `package.json` 的 `name`；`id` 是这个插件实例在 Loader 里的短名（`quota-usage`），浏览器半部靠它去取配置表单。两者不要求相同，但 `id` 不要随便改。

### 路线 2：直接写 git 依赖

不想 clone 到固定路径时，让 pnpm 自己拉：

```json
{
  "dependencies": {
    "@ruchonggithub/dsh-quota-usage": "github:ruchonggithub/dsh-quota-usage#dev"
  }
}
```

```sh
cd "$DSH_HOME/profiles/desktop"
pnpm install
```

两种路线的区别只在「代码从哪来」：link 是指向工作副本的软链，改代码后重载即生效；git 依赖是 pnpm 自己 clone 的一份副本，升级要重新 `pnpm install`。

> 两条路线都会把条目写进 **profile** 的 `package.json`。这是必须的——宿主就是按它解析依赖的，`cordis.patch.yml` 只负责注册、不负责解析。

### 装完必须重启

```sh
# 关掉正在运行的 DSH，再启动
dsh --profile desktop
```

侧边栏底部、Cordis 面板按钮下方会出现「账户用量」卡片。**不重启（或不重载插件）卡片不会出现**——插件行是启动时组合进 Loader 的。

### ⚠️ 一个常见的坑

> **光把插件文件夹拷进 `node_modules` 不会生效。**
> 宿主按 profile 的 `package.json` 解析依赖，并且插件必须在 `cordis.patch.yml` 里注册。只拷文件夹，结果是「文件在那儿但 DSH 根本不知道它存在」——侧边栏什么都没有，日志里也没有报错。

### 关于 `dsh plugin --profile ... add`

`dsh plugin --profile <name> <args...>` 这条命令是**真实存在的**（`dsh plugin --help` 的原话：*manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory*），但它的作用只是「把参数原样转发给 profile 目录里的 pnpm」。也就是说：

```sh
dsh plugin --profile desktop add @ruchonggithub/dsh-quota-usage
```

等价于在 profile 目录里跑 `pnpm add @ruchonggithub/dsh-quota-usage`，走的是 **npm registry**。而本包是 `private: true`、没有发布到 npm，所以这条命令会失败（找不到包）。想用它，就必须把包发到你能访问的 registry 上——本项目的既定方针是**不发布**，所以才有上面两条 GitHub 路线。

> 但同一个命令用来装**别的** npm 上的插件仍然好用：`dsh plugin --profile desktop add <某已发布插件>`。

---

## 二、依赖要求

| 依赖 | 版本要求 | 由谁提供 |
| --- | --- | --- |
| DeepSeek Harness | **0.2.x 及以上**（`0.2.0-rc.1` 起；同时兼容 `0.1.0-rc.6` 起的 0.1.x 线） | 你自己安装 |
| `@deepseek-ai/dsh-credentials` | `^0.1.0-rc.6 \|\| ^0.2.0-rc.1 \|\| ^0.2.1-rc.2` | **DSH 宿主提供**（peerDependency） |
| `@deepseek-ai/schemastery` | `^3.18.0` | **DSH 宿主提供**（peerDependency） |
| Node | 22 或 24（CI 两条线都跑） | 桌面版自带 24；命令行用你系统里的 |

**这些包不随本插件安装**——它们是 `peerDependencies`，由 DSH 宿主自己的依赖树提供。插件在 `lib/index.js` 里只 `import` 了上面两个；`ctx.webServer`、`ctx.credentials`、`ctx.connection`、`ctx.logger` 等都是运行时由 Cordis 注入到 `ctx` 上的**服务**，不是 import 的模块，因此不需要（也不应该）声明成 peer。

插件本身**没有构建步骤**：`lib/*.js` 就是直接跑的源码，装好即可用。

---

## 三、同时支持桌面版与 Web 版

插件同时支持 **DSH 桌面版**与 **`dsh web` 命令行版**。两者跑的是**同一套 Web GUI**，所以 `package.json` 里 `dsh.client.platform` 是 `"web"` —— 它指的是「浏览器运行环境」，桌面版的界面也是这套 web GUI 渲染的。

浏览器半部依赖三个宿主客户端模块，声明在 `package.json` 的 `dsh.client.inject`：

| 模块 | 用在哪 |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-slots` | `ctx.slots.inject(...)` / `ctx.slots.register(...)`：侧边栏卡片、会话「用量」页、设置项三个槽位 |
| `@deepseek-ai/dsh-client-locale` | `ctx.locale.register(NS, { zh, en })`：中英词典 |
| `@deepseek-ai/dsh-client-connection` | `ctx.remote.$on("settings/document-updated", ...)`：设置保存后让卡片立即按新配置重取 |

这**三个都要**，一个都不能少。补充两点容易误解的地方：

- `dsh.client.inject` 写的是**包名**（浏览器模块图里的依赖边），与浏览器半部 `lib/client.js` 自己 `export const inject = ["slots", "remote", "locale"]`（Cordis **服务**注入）是两套东西，不要混。后者已经声明在源码里，不需要写进 `package.json`。
- 这三个模块由**宿主**提供，因此**不写进 `peerDependencies`**。它们是宿主客户端模块，不是你要装的 npm 包。
- 打宿主 `/api/quota-usage/*` 路由用的是**浏览器同源 `fetch()`**，不需要额外模块。

另外「采集频率」表单读的是宿主的 `configForms` 服务（`ctx.get("configForms")`）。它不是必需的：宿主没有它时，那一块显示「当前宿主不提供配置表单」，卡片与其它设置照常工作，只是采集间隔要按清单 A1–A3 去配置文件里改。

> **将来版本注意**：如果某个 DSH 版本的桌面版改了 GUI 架构（例如不再复用同一个 web GUI），`dsh.client.inject` 里的模块名可能需要跟着调整。判断方法：看那个版本发布出来的 `@deepseek-ai/dsh-client-*` 包清单，缺哪个补哪个。

---

## 四、配置说明

分两张清单：**需要你配的**，和**插件自己搞定、你不用管的**。

### 清单 A：需要你提供 / 配置的

| # | 配什么 | 配在哪 | 默认值 | 不配会怎样 |
| --- | --- | --- | --- | --- |
| A1 | **采集间隔（积分）** | 设置 → 额度与用量 → 采集频率 → 「积分」 | **10 分钟** | 用默认 10 分钟 |
| A2 | **采集间隔（充值）** | 同上 → 「充值」 | **10 分钟** | 用默认 10 分钟 |
| A3 | **采集间隔（订阅）** | 同上 → 「订阅」 | **10 分钟** | 用默认 10 分钟 |
| A4 | **单价**（哪些渠道要手填） | 设置 → 额度与用量 →「单价」块 | 103 条出厂价（18 个渠道），来源标注 `official-doc` / `name-suffix` / `free` | 表里有的模型按出厂价算；**表里没有的模型不猜价**，金额显示「—」 |
| A5 | **API Key**（预充值 / 订阅类渠道） | DSH 设置 → 模型页填 Key；或写成环境变量 | 无 | 卡片说明「未配置密钥」，不显示余额 |
| A6 | **OAuth 令牌**（Claude Code / OpenAI Codex） | 经宿主凭据服务写入（`POST /api/quota-usage/token`，落盘在本机凭据文件） | 无 | 这两个订阅显示「尚未填写令牌」 |
| A7 | **`providerAliases`**（可选，第三方路由映射） | profile 的 `cordis.patch.yml` 里 `config.providerAliases`，或直接改配置文件 | `[]`（空） | 第三方插件注册的 provider 路由被当成「未识别」，卡片显示「本插件不支持 xxx」 |
| A8 | **`subscriptionMode`**（可选） | 配置文件 / `cordis.patch.yml` 的 `config.subscriptionMode`（设置页**没有**这个开关） | `independent`（但实际取数仍是 plugin 优先，见 B5） | 什么都不用做；只有想强制「只走插件」时才需要写 `plugin` |

**采集间隔的细节**（三项共用一套规则，代码在 `lib/collector.js`）：

- 单位是**分钟**，界面上按分钟填，落盘是毫秒。
- **硬下限 1 分钟**：填得比它小会被夹到 1 分钟，界面上直接告诉你「低于下限，已按 1 分钟执行」。
- **建议不低于 10 分钟**：界面原话就是这个。采太勤会被厂商当成异常客户端。
- 三项**各自独立**，只改一项不会把另外两项写死（升级后默认值仍然改得动）。
- 三项都**可以完全不配**，全部走默认 10 分钟。

**单价的细节**：

- 价格单位是**每百万 token**，字段为 **输入 / 输出 / 输入缓存**。
- 只有单一价的渠道，把三个格子填成一样的值即可。
- 双击模型名即可改价，改完点别处自动保存；**立即生效**，不需要重启（统计按新价重算）。
- 改过的记录 `source` 变成 `manual`，原有出处会保留在 `seedSource` 里，界面仍能解释「这条原本来自哪里」。
- 落盘位置：`$DSH_HOME/storages/dsh-quota-usage/price-table.json`。要指到别处（多份账本 / 隔离测试）设环境变量 `DSH_QUOTA_USAGE_PRICE_STORE` 为绝对文件路径。
- 「恢复默认价格」会把**所有**手改过的价格还原成出厂价，有确认弹窗。

**`providerAliases` 的写法**（可选，绝大多数人用不到）：

```yaml
- insert:
    - id: quota-usage
      name: '@ruchonggithub/dsh-quota-usage'
      config:
        providerAliases:
          - provider: chatgpt-codex      # 第三方插件注册的路由 id
            capability: openai-codex     # 映射到本插件支持的账户口径
```

`capability` 只能是下面这些 id 之一（与 `lib/accounts.js` 的能力表同源）：

```
deepseek-official, moonshotai, zai, openrouter, kimi-coding,
opencode, opencode-go, minimax, minimax-cn, anthropic, openai-codex
```

写错了不会让插件起不来——激活时只记一条 `dsh-quota-usage: ...` 开头的警告日志，然后按「没有这条映射」处理。

> 注意：设置页里只有「采集频率」与「单价」两块可配。`providerAliases` 与 `subscriptionMode` 这两个配置项**没有**设置页表单（映射编辑器与令牌区已按用户要求移除），要改只能在配置文件 / `cordis.patch.yml` 里手写。

### 清单 B：插件自动探测、你不用管的

| # | 什么事 | 插件怎么做的 | 你需要做什么 |
| --- | --- | --- | --- |
| B1 | **从哪读 API Key** | 走宿主凭据服务（`@deepseek-ai/dsh-credentials`），按 `provider` 派生引用名 `<PROVIDER>_API_KEY`（如 `DEEPSEEK_API_KEY`、`MOONSHOTAI_API_KEY`、`ZAI_API_KEY`、`OPENROUTER_API_KEY`、`KIMI_CODING_API_KEY`、`OPENCODE_API_KEY`、`MINIMAX_API_KEY`），派生名在前、适配器原生环境名在后，按顺序试 | **什么都不用做**——你在模型页填过的 Key 已经在那儿了 |
| B2 | **当前模型是哪个 provider** | 宿主把当前 provider id 交给插件，插件按能力表精确匹配；命中不了才查 `providerAliases`；**不按名字猜、不按端点猜** | 无 |
| B3 | **余额 / 订阅余量从哪来** | `lib/accounts.js` 的能力表：余额类打各家余额接口，订阅类打各家用量窗口接口，OAuth 订阅类用你填的令牌 | 无（只有 A5 / A6 要你填凭据） |
| B4 | **免费渠道积分从哪来** | 走内核 `connection` 服务调 `dsh-free-model` 挂的 `/api/channel-pack` RPC（`credits.balances`），拿到的是它自己页面看到的那份实时数据；同时读它落盘的 `$DSH_HOME/channel-pack/{state,auto-checkin,token-ledger}.json` 拿账号池与今日 token 消耗 | 无（装了 `dsh-free-model` 就自动有） |
| B5 | **订阅模式怎么选** | **plugin 优先**：先读 `dsh-chatgpt-subscription` 的多账号池，再读它的聚合桶，都拿不到才走 independent（自己打上游）。显式配 `subscriptionMode: plugin` 时**只走 plugin**，失败就报它自己的失败原因，**不会悄悄回退** | 无（默认 `independent` 就已经是 plugin 优先） |
| B6 | **Windows / 节假日口径** | `lib/pricing.js` 内置国务院办公厅放假日期表，DeepSeek 峰谷按北京时间算 | 无（表没覆盖到当年时会打一条警告日志，见第五节） |
| B7 | **采集失败怎么办** | **保留上一次的值**并标记为过期（stale），不把数字擦掉；三类互不影响，一类挂了另外两类照常 | 无 |
| B8 | **首次打开为什么是空的** | 展示侧**只读缓存**，不触发上游请求。第一次读快照时在后台垫一轮采集，响应仍是即时的空快照，几秒后卡片自己收敛 | 等几秒，或点一下卡片 |
| B9 | **金额算不出来时** | 显示「—」而**不是 ¥0.00**（后者会让人以为没花钱）；积分型 / 订阅型**不给金额**（把积分伪装成人民币是假话） | 无 |

一句话总结：**你只需要填 Key（和可选的令牌）、按需调采集频率、按需改单价。** 其余全部由插件自己探。

---

## 五、故障排查

### 侧边栏没有这张卡片

按顺序查，前三步覆盖 95% 的情况：

1. **profile 的 `package.json` 里有没有这条依赖？**
   ```sh
   cat "$DSH_HOME/profiles/desktop/package.json"
   ```
   没有 `@ruchonggithub/dsh-quota-usage` → 按第一节加进去。

2. **跑过 `pnpm install` 吗？**
   ```sh
   cd "$DSH_HOME/profiles/desktop" && pnpm install
   ```
   `node_modules/@ruchonggithub/dsh-quota-usage` 不存在或指向一个不存在的路径（link 的目标被删/改名）都会导致加载失败。

3. **重启过 DSH 吗？** 改完依赖必须重启，插件行是启动时组合的。

4. 以上都对还不行：确认 profile 的 `cordis.patch.yml` 里注册了 `id: quota-usage` / `name: '@ruchonggithub/dsh-quota-usage'`。`name` 必须**逐字**等于包名。

5. 再不行就看日志（见下）。

### 卡片在，但是空的

- **查账号是否登录 / 是否填了 Key。** 卡片只在「余额类错误」时置空并说明原因（未配置 Key、余额接口失败、网络不通）。
- **查当前模型背后的 provider 是否被支持。** 不支持时卡片会写「本插件不支持 xxx」。这时要么换模型，要么用清单 A7 的 `providerAliases` 映射过去。
- **刚启动时是正常的。** 展示侧只读缓存，第一次打开会在后台垫一轮采集，等几秒或点一下卡片。
- **订阅类显示「尚未填写令牌」** → Claude Code / OpenAI Codex 走 OAuth，API Key 读不到，必须按 A6 填令牌。

### 日志在哪、怎么认

插件的**所有**警告日志都带同一个前缀：

```
dsh-quota-usage: ...
```

在 DSH 的日志输出里搜 `dsh-quota-usage` 就能筛出全部。常见的几条：

| 日志 | 含义 | 怎么办 |
| --- | --- | --- |
| `dsh-quota-usage: 内置放假日期表未覆盖 <年> 年…` | 跨年了，节假日表还没更新 | 更新 `lib/pricing.js` 的 `HOLIDAY_RANGES`；不更新的话当年法定节假日白天会按高峰价算 |
| `dsh-quota-usage: <映射相关警告>` | `providerAliases` 里有非法项 | 按警告内容改配置；插件不会因此起不来 |
| `dsh-quota-usage: collect request failed` | 手动触发的采集请求失败 | 通常是那一轮上游抖动，等下一次定时采集 |
| `dsh-quota-usage: prices request failed` | 单价的读写通道出错 | 存储文件坏了会自动回落出厂价，重新打开设置页即可 |
| `[dsh-quota-usage] workspace.json 里有 N 个会话被多个工作区同时登记…` | 工作区汇总的去重提示 | 仅影响统计的去重口径，不影响卡片 |

### 卸载

从 profile 的 `package.json` 里删掉那条依赖，`pnpm install`，重启。
单价存储（`$DSH_HOME/storages/dsh-quota-usage/`）不会自动删除，要清干净就手动删掉那个目录。

---

## 六、`files` 与「哪些文件要在包里」

`files` 决定 `npm pack` 打包内容，也间接告诉别人「运行时到底需要哪些文件」。本包不发 npm，但这份清单仍然是**运行时必需品的权威说明**——从 GitHub 安装时，哪些文件必须保留，看这张表。

| 文件 / 目录 | 进 `files` | 理由 |
| --- | --- | --- |
| `lib/` | ✅ | 运行时必需，14 个文件全部是（逐个确认见下表） |
| `locale/` | ✅ | 插件列表里的名称与描述（`meta.title` / `meta.description` / `meta.detail`），宿主按语言读 |
| `icon.svg` | ✅ | `package.json` 的 `icon` 字段指向它，插件列表用它 |
| `cordis.patch.yml` | ✅ | `dsh.bundle.patch` 指向它，插件靠它注册进 Loader |
| `README.md` | ✅ | `locale/*.json` 的 `meta.detail` 指向 `README.md`，详情页正文就是它 |
| `test/` | ❌ | 开发用测试（20 个 `.mjs`），运行时不读 |
| `scripts/` | ❌ | 开发工具（`acceptance.mjs` 验收、`meta-check.mjs` / `meta-mutate.mjs` 元验收、`screenshot-price-editor.mjs` 截图） |
| `docs/` | ❌ | 已清空删除。设置页截图可由 `scripts/screenshot-price-editor.mjs` 重新生成，生成后再放进 `docs/` 即可。 |
| `ACCEPTANCE.md` | ❌ | 验收标准文档，开发用 |
| `.github/`、`.gitignore`、`.gitattributes` | ❌ | 仓库基建 |

### `lib/` 下 14 个文件逐个确认

| 文件 | 运行时必需 | 依据 |
| --- | --- | --- |
| `index.js` | ✅ | 宿主半部入口（`main` / `exports["."]`），`apply()` 注册 9 条 `/api/quota-usage/*` 路由 |
| `client.js` | ✅ | 浏览器半部入口（`exports["./client"]`），侧边栏卡片 / 用量页 / 设置项全靠它 |
| `accounts.js` | ✅ | provider 能力表（余额 / 订阅 / OAuth 三类端点与凭据引用），被 `index.js`、`providers.js`、`subscription.js` import |
| `channel-credits.js` | ✅ | 免费渠道积分的实时查询（channel-pack RPC），被 `index.js` import |
| `credits.js` | ✅ | 读 `dsh-free-model` 落盘状态（账号池 / 签到 / token 账本），被 `index.js`、`price-store.js` import |
| `collector.js` | ✅ | 统一采集调度器 + 缓存，被 `index.js` import |
| `cost.js` | ✅ | 用量 → 金额，被 `index.js` import |
| `price-store.js` | ✅ | 价格表持久化（读写 `storages/dsh-quota-usage/price-table.json`），被 `index.js`、`price-table.js` import |
| `price-table.js` | ✅ | 103 条出厂价种子 + 表读写，被 `index.js`、`cost.js` import |
| `pricing.js` | ✅ | 单价计算、峰谷时段、节假日表，被 `index.js`、`cost.js`、`price-table.js` import |
| `providers.js` | ✅ | `providerAliases` 归一化与 provider 解析，被 `index.js` import |
| `subscription.js` | ✅ | 订阅余量两种取数模式（plugin / independent），被 `index.js` import |
| `usage.js` | ✅ | 会话日志回放（多帧 zstd 解压）+ `resolveDshHome()`，被 `index.js`、`credits.js`、`price-store.js`、`workspaces.js` import |
| `workspaces.js` | ✅ | 工作区维度统计，被 `index.js` import |

**结论：14 个全部是运行时必需，没有一个是「只在测试里用」的。** 它们都是真实 import 链上的节点（`index.js` 拉 12 个，另外几个是它们之间的相互依赖），删任何一个都会让宿主半部加载失败。测试是**反过来** import 这些文件的，不是它们依赖测试。

---

## 七、这个插件是怎么取数的（实现要点）

<details>
<summary>余额（预充值型）</summary>

DeepSeek 官方 API（以及 Moonshot / Kimi、智谱 Z.ai、OpenRouter）公开账户余额，卡片直接显示带币种符号（`¥` / `$`）的余额。

- `deepseek-official` 走 `/user/balance`，密钥是你在模型页填的那把 Key；基址可被 `DEEPSEEK_BASE_URL` 覆盖。
- `deepseek-account` 是例外：不需要密钥——在 DSH 里登录 DeepSeek 账号即可，卡片读的是登录留下的授权；而且这条路由的端点**恒为官方源**，不随 `DEEPSEEK_BASE_URL` 被指向第三方中转（否则账号令牌就会被送到那个地址）。
- 只按 **provider + 模型 id** 精确查价：第三方路由上的同名 `deepseek-*` 模型按各自规则扣费，用官方快照算出来的数字与账单无关，因此不猜。
</details>

<details>
<summary>免费渠道积分（积分型）</summary>

对 **`dsh-free-model`** 插件的补充。那类渠道（Trae、Buddy、Qoder、MiniMax、Cline、Raccoon、ZCode 等）没有「余额」这个概念，额度是**积分**：签到领一点、提问扣一点，还分账号、分天刷新。

路径不是直接发 HTTP：`dsh-free-model` 把 `/api/channel-pack` 挂在宿主的 connection 服务上，只放行同进程的 owner Peer，所以插件从 `ctx` 取 `connection` 服务、用 `createSharedFetchHandler('/api')` + owner Peer 以内核自己的身份调用 `credits.balances`。

**百分比分母有一整套反直觉规则**（写错就会把 95.3% 显示成 91.1%）：

- 只统计仍在生效的积分包。失效包会把分母撑大。
- 剩余以 `balance.total` 为准（它已去重）；分母要找到「剩余等于 `balance.total` 的那个聚合包」，用 `balance.total + 该包.used`。
- 认不出形状时**不给百分比**，绝不拿「剩余 / 剩余」兜底造出一个自信的 100%。
- 单个账号查询失败（`balance: null`）只记一条错误，不会抹掉同渠道其它账号的数字。
</details>

<details>
<summary>订阅余量（订阅型）</summary>

对 **`@eddyskywalker/dsh-chatgpt-subscription`** 插件的补充。Kimi For Coding、OpenCode、MiniMax、Claude Code、OpenAI Codex 没有余额可查，只公开用量窗口。卡片按接口返回的窗口各画一个仪表盘——5 小时、周、月，返回几个画几个。

取数顺序是 **plugin 优先**：多账号池 → 聚合桶 → independent 兜底。显式配成 `plugin` 时只走 plugin，失败时明确报错，**不静默回退**（否则你会以为在看插件那份数据，实际两份数据的上游时刻、账号甚至账号池都不同）。
</details>

<details>
<summary>会话用量统计</summary>

**入口在会话里。** 打开任意会话，标题栏的视图 Tab 里会多出一个「用量」页，与「轨迹」并列。

会话日志（`$DSH_HOME/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`）里每条 `assistant/message` 都带 `data.message.source`（provider / model）与 `data.usage`（各类 token）。插件回放这些日志，按三大计费类型先分一层，再在每个类型下按厂商 → 模型汇总。

| 类型 | 含义 | 金额怎么显示 |
| --- | --- | --- |
| 订阅型 | 按月 / 按周期付固定费用 | 不给金额（`null`） |
| 预充值型 | 先充钱后按量扣，余额可见 | 真实货币，带币种符号 |
| 积分型 | 签到 / 活动发的积分 | 不给金额（把积分伪装成人民币是假话） |

三条口径：金额算不出来时显示「—」而**不是 ¥0.00**；价格快照日期随金额一起显示（价格是手动采集的，不标日期用户无法判断该不该信）；有价格表但该模型没采到价时显示「暂无定价」，不借用同族模型的价格。

**关键实现细节：会话日志是多帧 zstd。** DSH 边写边压，每批事件各自成为一个 zstd 帧。插件按帧魔数定位每个起点、切出单帧再解，因此 Node 22 / 24 / 26 结果一致。
</details>

---

## 八、已知限制

- **本机其它进程仍可访问插件路由。** 所有路由只接受本机来源（Host 必须是回环地址或本监听器绑定的地址，跨站请求标记与异源 Origin 一律拒绝），但这是本地工具的固有边界。
- **免费渠道积分依赖 `dsh-free-model` 的落盘格式与 RPC。** 那个插件改了格式，这里要跟着改。它没装时，这一块显示「无可用数据」而不是 0。
- **订阅余量依赖各家非公开接口**，字段来自官方文档或长期稳定的社区实现；解析不出就报「无法识别」，绝不猜数字。
- **价格快照是手动采集的**，厂商调价时随插件版本更新，不是实时拉取。表里没有的模型 `known=false`，单价行整组隐藏，卡片只留余额；想让它有价，按清单 A4 自己填。
- **会话统计的厂商分类是白名单制的。** 未知 provider id 归入「未分类」——猜错的分类比没有分类更糟。
- **统计不是实时的。** 它回放落盘的会话日志，当前这一轮还没写进日志的部分不计入；宿主侧按文件 mtime + size 缓存，未变化的文件不重复解压。缓存**全部落盘**（`$DSH_HOME/storages/dsh-quota-usage/usage-cache/`：record 与汇总各一个子目录），扫描器在堆内零驻留——目录删掉也无妨，下次扫描自动重建。
- **各工作区合计与全机合计不保证相等。** 分叉会话从汇总层认不出来，误差上界是分叉点之前那段历史。

---

## 九、目录结构

```
dsh-quota-usage/
├── package.json          # 包名、exports、dsh.client / dsh.bundle 清单
├── cordis.patch.yml      # 插件注册（id: quota-usage）
├── icon.svg              # 插件图标（¥ 硬币）
├── README.md             # 本文（也是 locale meta.detail 指向的详情页正文）
├── locale/
│   ├── zh.json           # 插件列表中文名称与描述
│   └── en.json           # 插件列表英文名称与描述
├── lib/                  # 运行时全部代码（14 个文件，见第六节）
├── test/                 # 测试（20 个 .mjs，开发用，不打包）
├── scripts/              # 验收与截图工具（开发用，不打包）
├── docs/                 # 设置页截图素材（不打包）
├── ACCEPTANCE.md         # 验收标准（开发用，不打包）
└── .github/workflows/
    └── ci.yml            # GitHub Actions：Node 22 / 24 上语法检查 + 跑测试
```

## 十、开发

```sh
node --test "test/*.test.mjs"   # 单元 / 行为测试
node scripts/acceptance.mjs     # 验收判据
```

CI 在 `dev` 分支的 push 与所有 PR 上跑：先对 `lib/*.js` 逐个 `node --check`，再 `npm test`，Node 22 与 24 两条线都要绿。

**本项目不发 npm**（`private: true`，无发布流程）。分发方式就是第一节的两条 GitHub 路线。

> AI生成

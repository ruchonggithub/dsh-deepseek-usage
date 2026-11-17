// dsh-quota-usage — browser half.
//
// 侧边栏底部用量卡片（注册进 `sidebar.footer.action` 槽位，独占一行，位于
// Cordis 面板按钮下方）。每 30 秒心跳一次：重算悬浮说明里的剩余时间并重新拉取
// 宿主路由 `/api/quota-usage`（见 lib/index.js），因此余额、档单价与峰谷指示灯
// 都随心跳更新，跨过峰谷切换点后最多滞后一次心跳；点击卡片任意位置可立即刷新；
// 还没拿到余额（宿主刚重启/接口刚起来）时按 QUICK_RETRY_MS 阶梯快速补几次请求，
// 卡片几秒内收敛。
// 两种形态：
//   · 侧边栏展开——完整卡片：余额（放大显示，符号随币种）或订阅制的 D 形仪表盘阵列
//     （5 小时 / 周 / 月并排，灰色弧是已用量、绿色弧是剩余量，剩余量在已用 ≥ 80%
//     时变红，周期徽章嵌在底部缺口里），加当前模型档单价（输入/输入缓存/输出，
//     图标 + 数字，位于卡片右下角）+ 计费区间指示灯（右上角，只有颜色；悬浮说明
//     给出距下次切换的剩余时间）。指示灯只在宿主给出计费区间时出现：DeepSeek 的
//     峰谷、其它 provider 的高峰/优惠时段；全天一价的模型只有单价行。
//   · 侧边栏折叠——36px 图标栏里只有计费区间指示灯（见下方 `if (!wide)` 分支）。
//
// 设计约束（用户只关心"我还能花多少、这会儿什么价"）：
//   · 插件的内部信息——取价路径、模型改名、放假日期来源——一律不出现在 UI 上
//     （历史上圆点的 title 里塞过这些，已删除）。
//   · 唯一的交互是「点击卡片刷新」；没有可切换的提示态。
//   · 只有余额类错误（未配置 Key / 余额接口或网络失败）才置空卡片说明原因。
//   · 档单价来自宿主的取价结果：宿主按 provider + 模型查 PRICE_TABLES（DeepSeek 只是
//     其中一条，见 lib/pricing.js）；表里没有的模型 known=false，单价行与指示灯整组
//     隐藏，卡片只留余额。
//   · 没有数据时不编数字：余额与单价显示「—」，而不是 0.00 / 0。
// 另外在设置面板注册一项「DeepSeek 用量」（`settings.section`）：采集频率 + 会话用量
// 统计。提供商映射与订阅令牌两块 UI 已移除——它们的后端能力（providerAliases 配置项、
// /token 路由）仍在，只是不再在设置页暴露编辑器。
// 样式仅使用 `--dsw-*` 主题变量（含兜底值），跟随明暗主题。
window.__ModuleLoader__.load({
	id: "@ruchonggithub/dsh-quota-usage",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } = react;
		const h = react.createElement;

		// ---- constants -------------------------------------------------
		// 卡片心跳：每 30 秒重算一次倒计时并重新取一次数（余额 + 当前档单价）。
		// 峰谷切换也因此不需要额外的检测逻辑——每次心跳都重新取数，切换后最多 30 秒翻正。
		const POLL_MS = 30 * 1000;
		// 倒计时心跳的**下限粒度**：进入秒级显示后，最快每秒重渲染一次。
		// 它只是下限——真正的下一次唤醒时刻由 nextCountdownTickMs() 按"下一个会
		// 改变可见文字的时刻"算出来，不必每秒空转。
		// 这个定时器**只重渲染、不发请求**，而且只在真有 `resetsAt` 时才起。
		const COUNTDOWN_MS = 1000;
		// 倒计时定时器的**启用阈值**：剩余时间 ≤（订阅采集间隔 + 这个余量）才起。
		// 采集间隔 10 分钟时，数据本来就 10 分钟才更新一次——倒计时每分钟走一次字
		// 是在显示一个不会变的事实。只有快到下次采集（余量 2 分钟）时，精确到分钟
		// 才有意义。见 countdownNeedsTimer 的注释。
		const COUNTDOWN_TIMER_LEAD_MS = 2 * 60 * 1000;
		// 订阅类采集间隔的**兜底值**：宿主没回策略（或回的不是有限数）时用它。
		// 与宿主 lib/collector.js 的 DEFAULT_INTERVAL_MS 一致（10 分钟）。
		const DEFAULT_COLLECT_INTERVAL_MS = 10 * 60 * 1000;
		const USAGE_PATH = "/api/quota-usage";
		// 放假日期：宿主路由（见 lib/index.js），浏览器启动时读一次，覆盖内置镜像表；
		// 读不到就继续用内置表（两边都是同一份国务院办公厅日期表）。
		const HOLIDAYS_PATH = "/api/quota-usage/holidays";
		// 会话用量统计：宿主回放会话日志后按「计费类型 → 厂商 → 模型」聚合。
		const STATS_PATH = "/api/quota-usage/stats";
		// 采集快照：展示侧唯一数据来源。宿主只读缓存，这里**不会**触发上游请求。
		const SNAPSHOT_PATH = "/api/quota-usage/snapshot";
		// 显式采集（人工刷新按钮）：允许在定时之外触发一次，不改变定时节奏。
		const COLLECT_PATH = "/api/quota-usage/collect";
		// 配置页「单价」块的数据通道：GET 拉整张表（listRecords 的记录 + 形态字段），
		// POST 保存/重置（body: {action: "save"|"reset", record: {...}}）。宿主侧路由见
		// lib/index.js 的 PRICES_PATH；宿主没实现时本块显示「暂不可用」，不影响其它设置。
		const PRICES_PATH = "/api/quota-usage/prices";
		// 统计页三个勾选（整机 / 工作区 / 会话）的**本地偏好**键名。
		//
		// 为什么放 localStorage 而不是配置：这是"这个视图上次怎么看的"，属于界面偏好，
		// 不是插件的运行参数。写进配置会带来三个坏处——每个工作区共享同一份、需要配置
		// 保存链路、还得为它加一个用户根本不懂的设置项。换浏览器/清缓存后回到默认值
		// 是可接受的退化，与"记住"相比代价小得多。
		const STATS_PREFS_KEY = "dsh-quota-usage:stats-checks";
		/**
		 * 读上次的勾选。**只认形状对的**：解析失败、字段缺失、空选、或 `session`
		 * 被勾上（那条依赖当前会话，没有会话时不可选）都回到默认值。
		 *
		 * @param {string} sessionId 当前会话 id（空串表示拿不到，此时 session 不可勾）
		 * @returns {{machine:boolean, workspace:boolean, session:boolean}|null}
		 *   null = 没有可用偏好，调用方用默认值
		 */
		function readStatsPrefs(sessionId) {
			try {
				if (typeof localStorage === "undefined") return null;
				const raw = localStorage.getItem(STATS_PREFS_KEY);
				if (typeof raw !== "string" || raw === "") return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return null;
				const machine = parsed.machine === true;
				const workspace = parsed.workspace === true;
				const session = parsed.session === true;
				// 空选不能记住：那会让统计页一打开就是"什么都没选"的空屏。
				if (!machine && !workspace && !session) return null;
				// 上次勾了"会话"，但这次拿不到当前会话 → 会话那一项不可用，
				// 保留其它两项；若只剩空，交给调用方的默认值。
				if (session && sessionId === "") {
					if (!machine && !workspace) return null;
					return { machine, workspace, session: false };
				}
				return { machine, workspace, session };
			} catch (e) {
				return null;
			}
		}
		/** 写上次的勾选；存储不可用/写满时静默失败（偏好丢了不该影响统计功能）。 */
		function writeStatsPrefs(checks) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(STATS_PREFS_KEY, JSON.stringify({
					machine: checks.machine === true,
					workspace: checks.workspace === true,
					session: checks.session === true,
				}));
			} catch (e) { /* 隐私模式或配额满：不记就是 */ }
		}
		// 常态卡片高度：上下 padding 8+12 + 金额行 minHeight 28 + 边框 2 = 50。
		// 无头 Chromium 实测常态卡片 50px，异常态用同一个 minHeight 兜住，侧边栏不跳动。
		const CARD_MIN_HEIGHT = 50;
		// 卡片还没拿到余额时的快速重试节奏（宿主刚重启、接口刚起来、或本次请求失败）：
		// 让空卡片在几秒内收敛，而不必等满下一次心跳。
		const QUICK_RETRY_MS = [4000, 8000, 15000, 30000];
		// 宿主错误文案的长度上限：上游异常文本可能很长，卡片高度不应被它撑开。
		const ERROR_MAX_CHARS = 120;

		// ---- i18n（DSH locale 服务；zh 用中文词典，其它语言一律英文）----
		// 注意：卡片上的文字只在两处悬浮说明里——单价行（单位「每百万 token 价格」+ 三个
		// 档位 + 计费币种）与倒计时/指示灯（离贵/便宜的那档价还有多久）。指示灯本身没有
		// 可见文字、只有颜色；倒计时统一用英文单位（d/h/m）且不带前缀，中英界面完全一致
		// ——插件内部的取价路径等一概不进 UI。
		const NS = "dsh-quota-usage";
		const ZH = {
			"price.input": "输入",
			"price.cache": "输入缓存",
			"price.output": "输出",
			"price.perMillion": "每百万 token 价格",
			"currency.CNY": "元",
			"currency.USD": "美元",
			"hint.peak": "距离峰价还剩",
			"hint.idle": "距离谷价还剩",
			"hint.switching": "即将切换价格",
			"status.peak": "高峰时段",
			"status.idle": "空闲时段",
			"status.error": "余额读取失败",
			"status.unavailable": "该提供商不支持查询",
			"status.mapAction": "去映射",
			"card.label": "账户用量，点击刷新",
			// 收缩态右下角那个 ▸：点开看订阅 / 充值 / 积分三大类。
			// 与三大类头部的 ▾ 是同一个开关的两端，文案只描述"点下去会发生什么"。
			"card.expand": "展开三大类",
			"card.collapse": "收回到当前厂商",
			// 收缩态但**当前厂商未知**（宿主没给 provider.id，或给的 id 认不出来）：
			// 必须明确说出来，不能拿别家的数字顶上——那会被读成"这就是我在花的"。
			"card.currentUnknown": "当前模型未识别",
			"sidebar.label": "账户用量",
			"view.usage": "用量",
			// 积分卡片的单位：上游给的是英文原文（credits / credit / token），
			// 展示层负责翻译。中文界面绝不回退成英文（用户报的 bug 就是卡片上写着
			// `credits5487.64 / 7400`：单位是英文，还和数字黏在一起）。
			"credit.unit.credit": "积分",
			"credit.unit.token": "令牌",
			// 渠道积分卡片：折叠摘要 / 逐渠道行 / 状态文案（结构对标 dsh-ofm-balance）。
			// 四种状态必须各自有话说——把「读取中」显示成「—」会被读成「没有数据」，
			// 把「未登录」显示成错误色会被读成「坏了」。
			"credit.card.title": "免费渠道积分",
			"credit.state.loading": "读取中…",
			"credit.state.failed": "读取失败",
			"credit.state.notLoggedIn": "未登录",
			"credit.state.notShown": "未显示",
			"credit.state.empty": "无可用数据",
			"credit.refresh": "刷新",
			"credit.updatedAt": "更新于 {n}",
			"credit.hint.current": "当前对话使用中",
			"credit.hint.accounts": "账号：{names}",
			"credit.hint.remain": "剩余 {remaining}",
			"credit.hint.remainTotal": "剩余 {remaining} / 共 {total}",
			// 档位词：人读「余额偏低」比读「18.4%」快，精确数字就在旁边。
			"credit.percent.gone": "即将耗尽",
			"credit.percent.low": "余额偏低",
			"credit.percent.watch": "注意",
			"credit.percent.fair": "一般",
			"credit.percent.ok": "尚可",
			"credit.percent.good": "充足",
			"credit.percent.full": "满额",
			// 三大类分区的标题。顺序固定 订阅 → 充值 → 积分，与采集器的三类同源：
			// 订阅按时间窗口算、充值按金额算、积分按渠道额度算，三种数据的形状完全不同，
			// 混在一张表里既排不了序也选不了形态，所以分区是必要的，不是装饰。
			"credit.section.subscription": "订阅",
			"credit.section.prepaid": "充值",
			"credit.section.credits": "积分",
			// 某个订阅来源有登记但读不到窗口时的一句话。不画空条——空条会被读成
			// "额度是 0"。来源名与具体原因（令牌没填 / 插件不可用）放在悬浮说明里。
			"credit.sub.empty": "暂无订阅数据",
			// 多账号池里**非活跃账号**的那一格。用户明确要求：不画条、不显示 0%。
			// 措辞刻意不用"无数据"——"无数据"听起来像查询失败，而这是正常状态：
			// 用量查询要发到该账号自己的后端，只有当前活跃的那个能查。
			"credit.sub.notFetched": "未取用量",
			// 订阅条的三句说明：条上方只放得下窗口名与剩余百分比，其余那截必须在
			// 悬浮说明里说清（已用值只在悬浮里出现，条本身不重复写）。
			"credit.ring.left": "剩余 {n}",
			// 圆环悬浮说明的分隔符：中文用全角逗号、英文用逗号加空格，不共用一套标点。
			"credit.ring.sep": "，",
			// 订阅条上排的重置倒计时。条上方不再写窗口名（「5 小时」「7 天」），那个
			// 位置让给倒计时本体：用户要的是"还有多久重置"，不是"这是哪个窗口"。
			// 倒计时是**自然语言**格式：`2天13小时后` / `5小时42分钟后` / `42分钟后`。
			// 需要本地化的有三个单位（天 / 小时 / 分钟）和一个后缀（中文「后」、
			// 英文「after」——两种语言的语序不同，所以后缀也进词典）。
			"credit.sub.countdownDay": "天",
			"credit.sub.countdownHour": "小时",
			"credit.sub.countdownMinute": "分钟",
			"credit.sub.countdownAfter": "后",
			// 充值行：有条时说「剩余 / 共」，没条时只有余额，且必须讲明为什么没有比例
			// ——否则用户会把"没画条"读成"额度已满"。
			"credit.prepaid.remainTotal": "剩余 {remaining}，共 {total}",
			// 缺已消耗时界面只留金额（用户口径：信息不够就只展示余额数字），
			// 原因只放在悬浮说明里——它不占布局宽度，也不会在同一行重复金额
			// （真实渲染里出现过 `¥12.34 … ¥12.34`）。
			"credit.prepaid.onlyAmount": "余额 {amount}（没有已消耗数据，算不出比例）",
			"collect.title": "采集频率",
			"collect.intro": "所有对厂商的请求都由宿主的定时任务统一采集并缓存，界面只读缓存——刷新页面不会打厂商接口，因此不会被限流或拉黑。三类各自独立频率，单位分钟。",
			"collect.recommended": "建议不低于 {n} 分钟。采得太勤会被厂商当成异常客户端。",
			"collect.minutes": "分钟",
			"collect.clamped": "低于下限，已按 {n} 分钟执行",
			"collect.kind.credits": "积分",
			"collect.kind.prepaid": "充值",
			"collect.kind.subscription": "订阅",
			"collect.kind.stats": "统计间隔",
			"collect.unavailable": "当前宿主不提供配置表单。",
			// 配置页「单价」块：改这里的价，统计金额立即按新价计算（cost.js 优先认
			// source === 'manual' 的记录）。键统一用 price.editor.* / price.notice.*，
			// 刻意避开 price.input / price.output / price.cache（用量页的列名）与
			// credit.*（单数，积分卡片还在用）；credits.*（复数）已随旧设置页删除，
			// 不再复活那批名字。
			"price.editor.title": "单价",
			"price.editor.intro": "改这里的价格，统计金额立即按新价计算（无需重启）。价格按「每百万 token」填写；只有单一价的渠道，把输入/输出/缓存读填成一样的值即可。双击模型名可以改价，改完点别处自动保存。",
			"price.editor.search": "搜索渠道或模型",
			"price.editor.searchLabel": "按渠道或模型过滤",
			"price.editor.unavailable": "价格表暂不可用（宿主缺少价格路由），统计仍按默认价格计算。",
			"price.editor.loading": "正在读取价格表…",
			"price.editor.model": "模型",
			"price.editor.editHint": "双击改价，改完点别处自动保存。",
			"price.editor.status": "状态",
			"price.editor.cancel": "取消",
			"price.editor.saving": "保存中…",
			"price.editor.edited": "已改",
			"price.editor.saved": "已保存",
			"price.editor.resetDone": "已恢复出厂价格。",
			"price.editor.invalidValue": "价格必须是 0 或正数（可带小数），负数与非数字会被拒写。",
			"price.editor.groupEdited": "{n} 条已改",
			"price.editor.groupCount": "共 {n} 条",
			"price.editor.problems": "存储里有 {n} 条无法解析的记录（已忽略，不计价）。",
			"price.editor.reset": "恢复默认价格",
			"price.editor.resetConfirm": "确定恢复出厂价格表？你自己改过的价格会全部还原（共 {n} 条已改）。",
			"price.editor.resetEmptyConfirm": "确定恢复出厂价格表？当前没有手改过的价格。",
			"price.notice.peak-merged": "峰谷已合并为同价（时段指示灯保留）。",
			"price.notice.promotion-cleared": "已清除厂商促销标记。",
			"price.notice.mirrors-cleared": "已清除镜像说明（手定价不再对应官方条目）。",
			"price.notice.schedule-dropped": "该渠道只有单一价，峰谷时段已移除。",
			"price.notice.now-free": "价格已改为免费（三个值全为 0）。",
			"price.notice.overwrote": "检测到价格存储损坏，已用新表替换（原文件无法解析）。",
			"price.error.invalid": "保存被拒绝：{reason}",
			"price.error.network": "保存失败（网络/宿主错误），原价未改动。",
			"price.error.resetFailed": "恢复默认失败：{reason}",
			"price.error.refreshFailed": "价格表读取失败，请稍后重试。",
			"error.refresh": "刷新失败，请稍后重试",
			"accounts.window.5h": "5 小时",
			"accounts.window.7d": "7 天",
			"accounts.window.7d-opus": "Opus 7 天",
			"accounts.window.30d": "30 天",
			"accounts.window.cycle": "当前周期",
			// 设置页的名字（导航项 + 页内标题）：改成「额度与用量」。
			// 为什么改：这一页管的不只是 DeepSeek 一家——积分/充值/订阅来自 Kimi、
			// GLM、OpenRouter、MiniMax 等十几家渠道，"DeepSeek 用量"在插件列表
			// 里会让人以为这只是 DeepSeek 的插件。插件本身的元数据标题（locale/*.json
			// 的 meta.title）已经一起改成「额度与用量」/「Quota & Usage」。
			"settings.nav": "额度与用量",
			"settings.title": "额度与用量",
			"settings.intro": "在这里调整积分、充值、订阅三类数据的采集频率，并查看按计费类型划分的会话用量统计。",
			"stats.title": "会话用量统计",
			"stats.titleSession": "本次会话用量",
			"stats.intro": "回放本机会话日志，按计费类型、再按厂商与模型汇总 token 消耗。历史会话一并计入，插件安装之前的账也不会丢。",
			"stats.introSession": "统计仅限当前这一次会话：按计费类型、再按厂商与模型汇总 token 消耗。",
			"stats.loading": "正在统计…",
			"stats.failed": "统计读取失败，请稍后重试。",
			"stats.empty": "还没有可统计的会话记录。",
			"stats.refresh": "刷新",
			// 「刷新」与「重新统计」是两件事，别合并：
			//   · 刷新     —— 重新读缓存（GET），打开页面默认就是这么做的；
			//   · 重新统计 —— 让后台真去扫一遍日志并**改写缓存**（POST），要等几秒。
			// 只给一个按钮时用户分不清"我看到的数字为什么不变"：打开页面本来就只读缓存，
			// 再点一次同样只读缓存的按钮，数字当然还是旧的。
			"stats.recalc": "重新统计",
			"stats.recalcBusy": "正在重新统计…",
			"stats.recalcFailed": "重新统计失败，请稍后重试。",
			"stats.computedAt": "统计于 {time}",
			"stats.computing": "正在后台统计…",
			"stats.stale": "日志有更新，点「重新统计」刷新数字",
			"stats.messages": "{n} 条消息",
			// 中文界面不能写英文 `tokens`（用户报的「统计也没改」里就有这一条）。
			"stats.tokens": "令牌",
			"stats.files": "已扫描 {n} 个会话文件",
			"stats.unclassified": "有 {n} 个 provider 未分类，按原样列出",
			"stats.kind.subscription": "订阅型",
			"stats.kind.prepaid": "预充值型",
			"stats.kind.credits": "积分型",
			"stats.kind.unknown": "未分类",
			"stats.kindHint.subscription": "固定周期付费，用量受窗口约束",
			"stats.kindHint.prepaid": "先充值后按量扣，余额可见",
			"stats.kindHint.credits": "签到或活动发的积分，扣完为止",
			"stats.kindHint.unknown": "不在分类表里的路由，未做归属推断",
			"stats.col.provider": "厂商 / 模型",
			"stats.col.messages": "消息",
			"stats.col.input": "输入",
			"stats.col.output": "输出",
			"stats.col.cache": "缓存读",
			"stats.col.total": "合计",
			"stats.col.cost": "金额",
			"stats.cost.total": "合计",
			"stats.cost.credit": "按积分计费",
			"stats.cost.unpriced": "暂无定价",
			"stats.cost.mixed": "多币种",
			// 免费是**已知结论**（价格表里写明 free），既不是 ¥0.00，也不是「按积分计费」。
			"stats.cost.free": "免费",
			// 与「暂无定价」分开：这句说的是"渠道根本没给这个模型的价"，
			// 而「暂无定价」是"这家按钱算、只是这个模型没采到"。
			"stats.cost.noPrice": "该渠道未提供价格",
			"stats.cost.singlePrice": "该渠道只提供单一价",
			"stats.priceLineUniform": "每百万 token：{price}（单一价）",
			"stats.promo": "促销：原 x{original} → 现 x{current}",
			"stats.mirror": "跨渠道镜像价，来源 {n}",
			"stats.cost.asOf": "价格快照日期",
			"stats.priceLine": "每百万 token：输入 {input} / 输出 {output}",
			"stats.scope.all": "全机",
			"stats.scope.workspace": "按工作区",
			"stats.scope.session": "本会话",
			"stats.workspace.title": "工作区用量",
			"stats.workspace.intro": "按会话所在工作区汇总，便于看清每个项目烧了多少。",
			"stats.workspace.empty": "还没有归属到工作区的会话记录。",
			"stats.workspace.failed": "工作区列表读取失败，请稍后重试。",
			"stats.workspace.archived": "含归档 {n} 个",
			"stats.col.workspace": "工作区",
			"stats.col.sessions": "会话",
			"stats.workspace.path": "路径",
			// 三勾选 + 树形统计：勾选标签就是用户嘴里的三个词（整机 / 工作区 / 会话）。
			"stats.pick.machine": "整机",
			"stats.pick.workspace": "工作区",
			"stats.pick.session": "会话",
			// 树里的根节点名。与勾选标签分开写：勾选框叫「整机」，
			// 树上那一行要说明"这是整台机器的合计"。
			"stats.tree.machine": "整机合计",
			"stats.tree.pickEmpty": "请至少勾选一项（整机 / 工作区 / 会话）",
			"stats.tree.archived": "已归档",
			"stats.tree.failed": "读取失败",
			"stats.tree.duplicate": "副本未计入",
			"stats.col.scope": "范围",
			// 中文界面的用量单位：宿主给的是 token 数，界面上写「令牌」而不是英文 token。
			"stats.unit.tokens": "令牌",
			// 用量页右上角的「配置」按钮：跳到设置面板里的本插件页（改采集频率）。
			"view.config": "配置",
			"view.configHint": "打开「DeepSeek 用量」设置页（采集频率）",
		};
		const EN = {
			"price.input": "Input",
			"price.cache": "Input cache",
			"price.output": "Output",
			"price.perMillion": "Price per 1M tokens",
			"currency.CNY": "CNY",
			"currency.USD": "USD",
			"hint.peak": "Peak pricing in",
			"hint.idle": "Off-peak pricing in",
			"hint.switching": "Price change imminent",
			"status.peak": "Peak hours",
			"status.idle": "Off-peak hours",
			"status.error": "Balance unavailable",
			"status.unavailable": "This provider has no query API",
			"status.mapAction": "Set up mapping",
			"card.label": "Account usage, click to refresh",
			"card.expand": "Show all sources",
			"card.collapse": "Collapse to current provider",
			// The current provider is unknown (no provider.id, or an id we cannot
			// recognise): say so instead of showing somebody else's figures.
			"card.currentUnknown": "Current model not recognised",
			"sidebar.label": "Account usage",
			"view.usage": "Usage",
			// 英文界面保留英文单位是**对的**：这里给的正是上游原文，不需要翻译。
			"credit.unit.credit": "credits",
			"credit.unit.token": "tokens",
			"credit.card.title": "Free-channel credits",
			"credit.state.loading": "Reading…",
			"credit.state.failed": "Read failed",
			"credit.state.notLoggedIn": "Not signed in",
			"credit.state.notShown": "not shown",
			"credit.state.empty": "No usable data",
			"credit.refresh": "Refresh",
			"credit.updatedAt": "Updated {n}",
			"credit.hint.current": "Used by this conversation",
			"credit.hint.accounts": "Accounts: {names}",
			"credit.hint.remain": "{remaining} left",
			"credit.hint.remainTotal": "{remaining} left of {total}",
			"credit.percent.gone": "Almost gone",
			"credit.percent.low": "Low",
			"credit.percent.watch": "Watch",
			"credit.percent.fair": "Fair",
			"credit.percent.ok": "OK",
			"credit.percent.good": "Plenty",
			"credit.percent.full": "Full",
			"credit.section.subscription": "Subscription",
			"credit.section.prepaid": "Prepaid",
			"credit.sub.empty": "No subscription data",
			// A pool account whose usage was not fetched this round. The host only
			// queries the currently active account, so the rest legitimately have no
			// numbers — this is a normal state, not a failure.
			"credit.sub.notFetched": "usage not fetched",
			"credit.section.credits": "Credits",
			"credit.ring.left": "{n} left",
			"credit.ring.sep": ", ",
			// Units of the subscription countdown. The countdown reads as a short
			// English phrase (`2d13h left` / `42m left`), so each unit carries its
			// own spacing and the suffix lives in the unit string too.
			"credit.sub.countdownDay": "d",
			"credit.sub.countdownHour": "h",
			"credit.sub.countdownMinute": "m",
			"credit.sub.countdownAfter": " left",
			"credit.prepaid.remainTotal": "{remaining} left of {total}",
			"credit.prepaid.onlyAmount": "{amount} left (no spent figure, so no ratio)",
			"collect.title": "Collection frequency",
			"collect.intro": "Every provider request is made by the host's scheduled collector and cached; the UI only reads the cache, so refreshing the page never hits a provider and cannot get you rate-limited. Each of the three kinds has its own interval, in minutes.",
			"collect.recommended": "Keep it at {n} minutes or more. Collecting too often looks like an abusive client to providers.",
			"collect.minutes": "min",
			"collect.clamped": "Below the floor; running at {n} min",
			"collect.kind.credits": "Credits",
			"collect.kind.prepaid": "Prepaid",
			"collect.kind.subscription": "Subscription",
			"collect.kind.stats": "Stats interval",
			"collect.unavailable": "This host does not provide a configuration form.",
			// 配置页「单价」块（与 ZH 块一一对应；前缀刻意避开 price.input 等既有键）。
			"price.editor.title": "Prices",
			"price.editor.intro": "Edit prices here and cost figures pick them up immediately (no restart needed). Prices are per 1M tokens; for single-price channels, fill the same value for input/output/cache-read. Double-click a model name to edit; changes save when you click away.",
			"price.editor.search": "Search provider or model",
			"price.editor.searchLabel": "Filter by provider or model",
			"price.editor.unavailable": "Price table is unavailable (host lacks the price route); costs still use the default prices.",
			"price.editor.loading": "Reading price table…",
			"price.editor.model": "Model",
			"price.editor.editHint": "Double-click to edit; changes save when you click away.",
			"price.editor.status": "Status",
			"price.editor.cancel": "Cancel",
			"price.editor.saving": "Saving…",
			"price.editor.edited": "Edited",
			"price.editor.saved": "Saved",
			"price.editor.resetDone": "Factory prices restored.",
			"price.editor.invalidValue": "A price must be 0 or a positive number (decimals allowed); negatives and non-numbers are rejected.",
			"price.editor.groupEdited": "{n} edited",
			"price.editor.groupCount": "{n} rows",
			"price.editor.problems": "{n} records in the store cannot be parsed (ignored, not priced).",
			"price.editor.reset": "Restore default prices",
			"price.editor.resetConfirm": "Restore the factory price table? All your edits will be reverted ({n} edited).",
			"price.editor.resetEmptyConfirm": "Restore the factory price table? Nothing has been edited yet.",
			"price.notice.peak-merged": "Peak and off-peak merged into one price (the schedule indicator stays).",
			"price.notice.promotion-cleared": "Vendor promotion tag cleared.",
			"price.notice.mirrors-cleared": "Mirror note cleared (a manual price no longer mirrors an official entry).",
			"price.notice.schedule-dropped": "This channel has a single price; the peak schedule was removed.",
			"price.notice.now-free": "Price set to free (all three values are 0).",
			"price.notice.overwrote": "The price store was unreadable and has been replaced with the new table.",
			"price.error.invalid": "Save rejected: {reason}",
			"price.error.network": "Save failed (network/host error); the previous price is untouched.",
			"price.error.resetFailed": "Restore failed: {reason}",
			"price.error.refreshFailed": "Reading the price table failed, please try again.",
			"error.refresh": "Refresh failed, please try again.",
			"accounts.window.5h": "5-hour",
			"accounts.window.7d": "7-day",
			"accounts.window.7d-opus": "Opus 7-day",
			"accounts.window.30d": "30-day",
			"accounts.window.cycle": "Current cycle",
			// Settings page name (nav entry + page heading): "Quota & Usage".
			// Why: this page covers more than DeepSeek — credits / prepaid /
			// subscription come from Kimi, GLM, OpenRouter, MiniMax and a dozen
			// other channels, so "DeepSeek Usage" reads as a DeepSeek-only plugin.
			// The plugin metadata title (locale/*.json meta.title) was renamed to
			// match.
			"settings.nav": "Quota & Usage",
			"settings.title": "Quota & Usage",
			"settings.intro": "Set how often credits, prepaid and subscription data are collected, and review session usage by billing type.",
			"stats.title": "Session usage",
			"stats.titleSession": "This session's usage",
			"stats.intro": "Replays this machine's session logs and totals token consumption by billing type, then by provider and model. Earlier sessions count too, so usage from before the plugin was installed is not lost.",
			"stats.introSession": "Counts only the current session, by billing type, then by provider and model.",
			"stats.loading": "Counting…",
			"stats.failed": "Could not read usage; please try again.",
			"stats.empty": "No session records to count yet.",
			"stats.refresh": "Refresh",
			"stats.recalc": "Recalculate",
			"stats.recalcBusy": "Recalculating…",
			"stats.recalcFailed": "Recalculation failed; please try again.",
			"stats.computedAt": "Counted at {time}",
			"stats.computing": "Counting in the background…",
			"stats.stale": "New log entries found; click Recalculate to update",
			"stats.messages": "{n} messages",
			"stats.tokens": "tokens",
			"stats.files": "{n} session files scanned",
			"stats.unclassified": "{n} unclassified providers listed as-is",
			"stats.kind.subscription": "Subscription",
			"stats.kind.prepaid": "Prepaid",
			"stats.kind.credits": "Credits",
			"stats.kind.unknown": "Unclassified",
			"stats.kindHint.subscription": "Fixed periodic fee; usage bounded by windows",
			"stats.kindHint.prepaid": "Top up first, then pay per use; balance visible",
			"stats.kindHint.credits": "Credits from check-ins or campaigns, until exhausted",
			"stats.kindHint.unknown": "Routes outside the table; no billing type inferred",
			"stats.col.provider": "Provider / model",
			"stats.col.messages": "Msgs",
			"stats.col.input": "Input",
			"stats.col.output": "Output",
			"stats.col.cache": "Cache read",
			"stats.col.total": "Total",
			"stats.col.cost": "Cost",
			"stats.cost.total": "Total",
			"stats.cost.credit": "Credits, no currency",
			"stats.cost.unpriced": "No pricing yet",
			"stats.cost.mixed": "Multiple currencies",
			"stats.cost.free": "Free",
			"stats.cost.noPrice": "No price for this channel",
			"stats.cost.singlePrice": "This channel offers a single price",
			"stats.priceLineUniform": "Per 1M tokens: {price} (single price)",
			"stats.promo": "Promo: was x{original} → now x{current}",
			"stats.mirror": "Mirrored price from {n}",
			"stats.cost.asOf": "Price snapshot",
			"stats.priceLine": "Per 1M tokens: input {input} / output {output}",
			"stats.scope.all": "This machine",
			"stats.scope.workspace": "By workspace",
			"stats.scope.session": "This session",
			"stats.workspace.title": "Workspace usage",
			"stats.workspace.intro": "Totals grouped by the workspace each session belongs to, so you can see what each project burned.",
			"stats.workspace.empty": "No sessions are attributed to a workspace yet.",
			"stats.workspace.failed": "Could not read the workspace list; please try again.",
			"stats.workspace.archived": "{n} archived",
			"stats.col.workspace": "Workspace",
			"stats.col.sessions": "Sessions",
			"stats.workspace.path": "Path",
			// Three checkboxes + tree: the labels are the user's own three words.
			"stats.pick.machine": "Machine",
			"stats.pick.workspace": "Workspace",
			"stats.pick.session": "Session",
			"stats.tree.machine": "Machine total",
			"stats.tree.pickEmpty": "Pick at least one level (machine / workspace / session)",
			"stats.tree.archived": "Archived",
			"stats.tree.failed": "Unreadable",
			"stats.tree.duplicate": "Duplicate, not counted",
			"stats.col.scope": "Scope",
			"stats.unit.tokens": "tokens",
			// The "Settings" button on the usage page: opens this plugin's settings page.
			"view.config": "Settings",
			"view.configHint": "Open the DeepSeek Usage settings page (collection frequency)",
		};

		/**
		 * DSH 语言设置 → 本插件使用的语言：中文（zh、zh-CN、zh-Hans…）用中文，
		 * 其它任何语言一律英文。
		 */
		function uiLang(active) {
			return typeof active === "string" && active.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
		}

		/**
		 * provider 路由 id → 能力表里的规范 id（大小写/空白容错；未知 id 原样返回）。
		 *
		 * 为什么客户端也要有这张表：同一份订阅会被不同插件注册成不同的路由 id。
		 * 真机上当前模型走的是 `codex-chatgpt`（第三方 Codex 插件注册），而采集
		 * 快照里的订阅来源 id 是 `openai-codex`（能力表的规范 id）。两边字符串
		 * 不相等时，按 id 精确匹配会筛出空集——收缩态整张卡只剩宿主那句
		 * 「当前插件不支持 codex-chatgpt」，而那份订阅的数据就在快照里躺着。
		 *
		 * 浏览器侧**import 不了** `lib/accounts.js`（那是宿主 Node 模块，客户端是
		 * 独立的浏览器产物），所以这里有一份等价的小表。两侧的别名必须一致：
		 * 宿主侧在 `lib/accounts.js` 的 `PROVIDER_ID_ALIASES`，改一处要同步另一处。
		 *
		 * 归一**只用于匹配**，不用于显示：界面上仍然显示快照里的来源名
		 * （「OpenAI Codex」），不显示路由 id。
		 */
		const PROVIDER_ID_ALIASES = new Map([
			["chatgpt-codex", "openai-codex"],
			["codex-chatgpt", "openai-codex"],
		]);

		/** 把路由 id 归一成规范 id（未知 id 原样返回，只做去空白与大小写）。 */
		function canonicalProviderId(providerId) {
			if (typeof providerId !== "string") return "";
			const id = providerId.trim().toLowerCase();
			return PROVIDER_ID_ALIASES.get(id) ?? id;
		}

		/** 没有 DSH locale 服务时的兜底：按浏览器语言走同一规则，取不到就是英文。 */
		function browserLang() {
			try {
				return uiLang(String(navigator.language || ""));
			} catch (e) {
				return "en";
			}
		}

		/** 指定语言的词典文案（词典里没有就原样返回 key）。 */
		function textOf(key, lang) {
			return (lang === "zh" ? ZH : EN)[key] || key;
		}

		/** 当前语言：优先读 DSH locale 快照，读不到用浏览器语言。 */
		function currentLang(ctx) {
			try {
				const locale = ctx && ctx.locale;
				if (locale && typeof locale.getSnapshot === "function") {
					return uiLang(locale.getSnapshot().active);
				}
			} catch (e) { /* locale 服务不可用，走浏览器语言 */ }
			return browserLang();
		}

		// locale 服务缺失时的回退快照：必须是同一个对象，否则 useSyncExternalStore
		// 会把每次渲染都当成快照变化，触发无限重渲染。
		const FALLBACK_LOCALE_SNAPSHOT = { active: browserLang(), locales: [], revision: 0 };

		// ---- 峰谷规则（必须与 lib/pricing.js 里 DeepSeek 快照的 schedule
		// （peakWindows / peakDays / holidays）与 HOLIDAY_RANGES 保持一致；浏览器侧
		// 无法 import 宿主模块，只能镜像。2026 年起官方口径：法定节假日全天、调休上班
		// 的周末都是空闲时段，所以放假日期必须一起镜像，否则中秋/国庆白天会被误显示成
		// 高峰价）----
		const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
		const PEAK_WINDOWS = [[9, 12], [14, 18]];
		const PEAK_WEEKDAYS_ONLY = true;
		/** 可能的切换时刻（北京时间整点）：高峰窗口的起止整点，nextChange 逐日枚举它们。 */
		const BOUNDARY_HOURS = [...new Set(PEAK_WINDOWS.flat())].sort((a, b) => a - b);
		// 放假日期（含起止，闭区间）：国务院办公厅 2026 年节假日安排。
		const HOLIDAY_RANGES = [
			['2026-01-01', '2026-01-03'],
			['2026-02-15', '2026-02-23'],
			['2026-04-04', '2026-04-06'],
			['2026-05-01', '2026-05-05'],
			['2026-06-19', '2026-06-21'],
			['2026-09-25', '2026-09-27'],
			['2026-10-01', '2026-10-07'],
		];
		const DAY_MS = 24 * 60 * 60 * 1000;

		/** 把 [起, 止] 闭区间展开成日期键集合（`yyyy-mm-dd`）。 */
		function expandHolidayRanges(ranges) {
			const set = new Set();
			for (const [from, to] of ranges) {
				if (typeof from !== "string" || typeof to !== "string") continue;
				if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
				const start = Date.parse(from + 'T00:00:00Z');
				const end = Date.parse(to + 'T00:00:00Z');
				if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
				// 解析结果必须与输入同一天，否则输入本身不是合法日期（已滚动到别的日子）。
				if (new Date(start).toISOString().slice(0, 10) !== from) continue;
				if (new Date(end).toISOString().slice(0, 10) !== to) continue;
				for (let t = start; t <= end; t += DAY_MS) set.add(new Date(t).toISOString().slice(0, 10));
			}
			return set;
		}

		/** 内置镜像表：宿主不可达时的兜底，也是 isPeak/nextChange 的缺省集合。 */
		const BUILTIN_HOLIDAY_DAYS = expandHolidayRanges(HOLIDAY_RANGES);

		/** 该时刻所在北京时间日历日是否为法定节假日（放假日期）。 */
		function isHoliday(ms, days) {
			return days.has(new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10));
		}

		/**
		 * 某时刻是否为高峰时段（按北京时间；节假日全天与周末恒为空闲）。与 lib/pricing.js 的 isPeak 等价。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 isPeak 同一口径。
		 */
		function isPeak(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			if (isHoliday(now, days)) return false;
			const d = new Date(now + SHANGHAI_OFFSET_MS);
			if (PEAK_WEEKDAYS_ONLY) {
				const dow = d.getUTCDay();
				if (dow === 0 || dow === 6) return false;
			}
			const h = d.getUTCHours();
			return PEAK_WINDOWS.some(([start, end]) => h >= start && h < end);
		}

		/**
		 * 距下一个计费时段边界的剩余时间；与 lib/pricing.js 的 nextChange 等价。
		 * 候选时刻是 PEAK_WINDOWS 起止整点落在各天的那些点，逐日枚举取第一个让 isPeak
		 * 翻转的，因此返回精确时刻（上限 32 天，覆盖春节长假 → 假期后首个工作日早晨）。
		 * 找不到切换点时 at 为 null——调用方据此显示「—」，不要当成"此刻在切换"。
		 * `days` 缺省用内置镜像表，与 lib/pricing.js 的 nextChange 同一口径。
		 */
		function nextChange(ms, days = BUILTIN_HOLIDAY_DAYS) {
			const now = Number.isFinite(ms) ? ms : Date.now();
			const current = isPeak(now, days);
			const hourMs = 60 * 60 * 1000;
			const dayStart = Date.parse(new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10) + 'T00:00:00Z') - SHANGHAI_OFFSET_MS;
			for (let day = 0; day < 32; day += 1) {
				const base = dayStart + day * DAY_MS;
				for (const hour of BOUNDARY_HOURS) {
					const at = base + hour * hourMs;
					if (at <= now) continue;
					const peak = isPeak(at, days);
					if (peak !== current) return { peak, at, ms: at - now };
				}
			}
			return { peak: !current, at: null, ms: 0 };
		}

		/**
		 * 剩余毫秒 → 给人读的完整时长：`2 天 15 小时` / `5 小时 47 分钟` / `21 分钟`，
		 * 英文为 `2 days 15 hours` / `21 minutes`。不足 1 分钟返回 null，由调用方换成
		 * 「即将切换」一类整句——不拼一个 `0 分钟` 出来。
		 */
		function fmtDuration(ms, lang) {
			const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 60000));
			if (total === 0) return null;
			const days = Math.floor(total / 1440);
			const hours = Math.floor((total % 1440) / 60);
			const minutes = total % 60;
			if (lang === "en") {
				const unit = (v, word) => `${v} ${word}${v === 1 ? "" : "s"}`;
				if (days > 0) return `${unit(days, "day")} ${unit(hours, "hour")}`;
				if (hours > 0) return `${unit(hours, "hour")} ${unit(minutes, "minute")}`;
				return unit(minutes, "minute");
			}
			if (days > 0) return `${days} 天 ${hours} 小时`;
			if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
			return `${minutes} 分钟`;
		}

		/** 一天 / 一小时的毫秒数。倒计时与窗口总长都用它，避免两处各写一个魔数。 */
		const HOUR_MS = 60 * 60 * 1000;

		/**
		 * 距重置剩余毫秒 → **给人读的倒计时文字**。
		 *
		 * 新格式（用户第五次口径，按优先级取**最粗**的那一档）：
		 *   · 天数 > 1        → `2天13小时后`
		 *   · 天数 = 0，小时 > 1 → `5小时42分钟后`
		 *   · 小时 = 0        → `42分钟后`
		 *
		 * **边界情况的处理（需求里点名要判断的）**：
		 *   · **天数 = 1**（小时位为 0）→ 显示 `1天后`，**不退化成** `1天0小时后`。
		 *     理由：`1天0小时后` 读着别扭（"0 小时"是个没有信息量的数），而且
		 *     "1天后"与"1天0小时后"说的是同一件事，后者只是多写了一个 0。
		 *     同理 **小时 = 1** → `1小时后`（不写 `1小时0分钟后`）。
		 *     一句话：**只在高一位非零时才带出低位**，低位为 0 就整段省略。
		 *   · **不补零**：小时/分钟一律自然写法（`2天13小时`、`5小时42分钟`），
		 *     不按旧的 `pad` 风格写成 `2天13小时` vs `2天03小时`。理由：这是**自然
		 *     语言**而不是时钟读数（`13:05` 那种才需要补零），补零反而像在读表。
		 *   · **秒不出现**：新格式只到分钟。秒级精度交给"快要重置时"的定时器，
		 *     那时显示 `N分钟后`（不足 1 分钟显示 `1分钟内`）。
		 *
		 * 为什么改回自然语言：用户原来要 `D:HH:MM:SS` 是为了"一眼看出还剩多久"，
		 * 但那个格式在 274px 的侧边栏里要占 7~9 个字符宽，而且 `0天0:29:17`
		 * 这种写法读起来像在读仪表。`2天13小时后` 直接把话说完了。
		 *
		 * 与窗口类型**无关**：段数由**剩余时间**决定（这与旧口径相反——旧的
		 * `countdownHasDays` 按窗口总长定段）。因为新格式是自然语言，"7 天窗口
		 * 剩 3 小时"说成 `3小时后` 完全正确；硬按窗口类型塞一个「0天」反而是
		 * 在给用户看一个没意义的 0。
		 *
		 * 为什么是纯毫秒算术、不经 `Date`：`Date` 的日界随时区与夏令时漂移，
		 * 用它拆天数可能把 23/25 小时的一天算错一格。这里时间差就是时间差，
		 * 一天恒等于 86400000 ms。
		 *
		 * @param ms  距重置的剩余毫秒（非有限数按 0 处理）
		 * @param t   本地化函数（「天」「小时」「分钟」这三个单位要翻译）
		 */
		function countdownText(ms, t) {
			const safe = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
			const days = Math.floor(safe / 86400);
			const hours = Math.floor((safe % 86400) / 3600);
			const minutes = Math.floor((safe % 3600) / 60);
			// 单位与后缀都走词典：中文是「2天13小时后」，英文是「2d13h left」——
			// 两种语言的语序不同（中文后缀在后，英文在后缀前），所以后缀也进词典。
			const dayUnit = t ? t("credit.sub.countdownDay") : "天";
			const hourUnit = t ? t("credit.sub.countdownHour") : "小时";
			const minuteUnit = t ? t("credit.sub.countdownMinute") : "分钟";
			const after = t ? t("credit.sub.countdownAfter") : "后";
			// 天数 > 1：带出小时位（小时为 0 时省掉，写成 `2天后`）。
			if (days > 1) {
				return hours > 0
					? `${days}${dayUnit}${hours}${hourUnit}${after}`
					: `${days}${dayUnit}${after}`;
			}
			// 天数 = 1：小时位为 0 就写 `1天后`，不再显示 `1天0小时后`。
			if (days === 1) {
				return hours > 0
					? `1${dayUnit}${hours}${hourUnit}${after}`
					: `1${dayUnit}${after}`;
			}
			// 天数 = 0：小时 > 1 才带分钟位（小时 = 1 时分钟为 0，写成 `1小时后`）。
			if (hours > 1) {
				return minutes > 0
					? `${hours}${hourUnit}${minutes}${minuteUnit}${after}`
					: `${hours}${hourUnit}${after}`;
			}
			if (hours === 1) {
				return minutes > 0
					? `1${hourUnit}${minutes}${minuteUnit}${after}`
					: `1${hourUnit}${after}`;
			}
			// 不足 1 小时：只有分钟。分钟为 0（剩余 < 1 分钟）时说「1分钟内」——
			// 「0分钟后」是在说一件已经过去的事。
			return minutes > 0
				? `${minutes}${minuteUnit}${after}`
				: `1${minuteUnit}内`;
		}

		/**
		 * 窗口 key → 倒计时要不要带「天」段。
		 *
		 * 只回答一个问题：这个窗口是**天级**的吗（总长 >= 24 小时）。
		 * 推不出总长（`cycle`、空 key、非法 key）→ false，按小时级渲染。
		 * 与 `windowSpanMs` 分开写是因为两者"不知道"的退路不同：那里退回中性色，
		 * 这里退回**短格式**——多印一个假的「0天」是错误信息，少印只是少一截，
		 * 而小时数照样把时间说清楚（`999:00:00` 也读得懂）。
		 */
		function countdownHasDays(key) {
			const span = windowSpanMs(key);
			return span !== null && Number.isFinite(span) && span >= DAY_MS;
		}

		/**
		 * 快照里所有窗口的 `resetsAt`（订阅窗口 + 旧载荷直接挂在来源上的窗口）。
		 *
		 * 与 `hasCountdownWindow` 的分工：那个函数只回答"有没有"，本函数把所有时刻
		 * 摊开来给 `nextCountdownTickMs` 算最近的一次变化点。
		 */
		function resetsAtValues(snapshots) {
			const out = [];
			if (snapshots === null || typeof snapshots !== "object") return out;
			const meta = snapshots.subscription;
			if (meta === null || typeof meta !== "object") return out;
			const value = meta.value;
			if (value === null || typeof value !== "object") return out;
			const list = Array.isArray(value.subscriptions) ? value.subscriptions : [value];
			for (const item of list) {
				if (item === null || typeof item !== "object") continue;
				const windows = [];
				const accounts = Array.isArray(item.accounts) ? item.accounts : [];
				for (const account of accounts) {
					if (account !== null && typeof account === "object" && Array.isArray(account.windows)) {
						windows.push(...account.windows);
					}
				}
				if (Array.isArray(item.windows)) windows.push(...item.windows);
				for (const w of windows) {
					if (w !== null && typeof w === "object" && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)) {
						out.push(w.resetsAt);
					}
				}
			}
			return out;
		}

		/**
		 * 倒计时**要不要起定时器**的阈值：剩余时间 ≤ 订阅采集间隔 + 2 分钟。
		 *
		 * 为什么是这个阈值（用户硬要求）：
		 * 订阅数据的采集间隔是 10 分钟时，那份数据本来就 10 分钟才更新一次。
		 * 每分钟给用户走一次字是在**显示一个不会变的事实**——用户看到「42分钟后」
		 * 倒成「41分钟后」，但底层数据一个字节都没变，等于在骗他。
		 * 倒计时只在**快要变**的时候才需要精确：进入「采集间隔 + 2 分钟」之后，
		 * 下一次采集很快就要发生，文字马上会被新数据刷新，这时精确到分钟才有意义。
		 *
		 * 阈值取「间隔 + 2 分钟」而不是「间隔」：留 2 分钟的余量，保证在数据刷新
		 * 之前，界面已经先一步把「还剩多久」说准了。
		 *
		 * @param intervalMs 订阅类的采集间隔（毫秒）。取不到/非法 → 用默认 10 分钟。
		 * @param remainMs   距重置的剩余毫秒
		 * @returns {boolean} true = 该起定时器；false = 显示静态文字，等下次刷新
		 */
		function countdownNeedsTimer(intervalMs, remainMs) {
			if (!Number.isFinite(remainMs) || remainMs <= 0) return false;
			const base = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_COLLECT_INTERVAL_MS;
			return remainMs <= base + COUNTDOWN_TIMER_LEAD_MS;
		}

		/**
		 * 距离**下一次可见文字变化**还有多少毫秒；没有可跑的倒计时时返回 null。
		 *
		 * 这个函数存在的唯一理由：**不需要精确时不唤醒**。原先固定 1 秒的
		 * setInterval 在分钟级显示下每秒重渲染一次整张卡片，而屏幕上一位数字一分钟
		 * 才变一次，其余 59 次纯属空转——侧边栏里常驻的组件，这是白烧电。
		 *
		 * 算法（对每个带 resetsAt 的窗口各算一次，取最小值）：
		 *   · 剩余 > 1 分钟 → 下一次分钟跳字 = `remain % 60000`
		 *     （正好落在整分上时取满 60 秒）。
		 *   · 剩余 <= 1 分钟 → 下一次整秒 = `remain % 1000`（整秒时取满 1 秒）。
		 *   · 剩余 <= 0 → 已归零且不再变化，跳过（不唤醒）。
		 * 全部跳过 → null，调用方据此**不起**任何倒计时定时器。
		 */
		function nextCountdownTickMs(snapshots, nowMs) {
			const now = Number.isFinite(nowMs) ? nowMs : Date.now();
			const resets = resetsAtValues(snapshots);
			let best = null;
			for (const resetsAt of resets) {
				const remain = resetsAt - now;
				if (!(remain > 0)) continue;
				let delay;
				if (remain > 60 * COUNTDOWN_MS) {
					const toMinute = remain % 60000;
					delay = toMinute === 0 ? 60 * COUNTDOWN_MS : toMinute;
				} else {
					const toSecond = remain % 1000;
					delay = toSecond === 0 ? COUNTDOWN_MS : toSecond;
				}
				if (best === null || delay < best) best = delay;
			}
			if (best === null) return null;
			// 夹一下：定时器最小 1ms（delay 为 0 会让部分浏览器立刻无限触发），
			// 最大 1 分钟（更远的空档交给 30 秒主心跳顺手重渲染，不必为一个远处的
			// 分钟边界睡很久——浏览器对超长 setTimeout 在后台标签页里会整体推迟）。
			return Math.max(1, Math.min(60 * COUNTDOWN_MS, Math.round(best)));
		}

		/**
		 * 窗口 key → 该窗口的**总时长**（毫秒）；编不出来时说 null。
		 *
		 * 宿主的窗口对象只有 `key` / `percent` / `resetsAt` 三个字段，**没有总长**，
		 * 所以只能从 key 反推——而 key 本身就把时长编码在里面：
		 * `5h` = 5 小时、`7d` = 7 天、`30d` = 30 天、`7d-opus` = 7 天（Opus 档）。
		 *
		 * `cycle`（Kimi 那种"当前账单周期"）**不猜**：周期长度取决于套餐与结算日，
		 * key 里没有这个信息，硬套 30 天会在月初给出一个看起来很确定、其实是编的
		 * 颜色进度。拿不到总长时上层退回中性色，宁可没有颜色，也不给错颜色。
		 */
		function windowSpanMs(key) {
			if (typeof key !== "string" || key === "") return null;
			const fixed = { "5h": 5 * HOUR_MS, "7d": 7 * DAY_MS, "7d-opus": 7 * DAY_MS, "30d": 30 * DAY_MS };
			if (fixed[key] !== undefined) return fixed[key];
			// 通用时长（`1h` / `3d` / `14d`）：未知档位也按同一口径折算。
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return Number(hours[1]) * HOUR_MS;
			const days = /^(\d+)d(?:-.+)?$/.exec(key);
			if (days !== null) return Number(days[1]) * DAY_MS;
			return null;
		}

		/**
		 * 金额 → 两位小数字符串。
		 * null / undefined / 空串都表示"没有拿到"，显示「—」：Number(null) 是 0，
		 * 直接转换会把"读不到余额"显示成"余额 0 元"。
		 */
		function money(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return n.toFixed(2);
		}

		/** 单价 → 去掉多余尾零的字符串；同样把"没有值"显示成「—」。 */
		function fmtPrice(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(parseFloat(n.toFixed(2)));
		}

		/** 币种 → 符号。未知币种显示代码本身（如 HKD 10.00），不假装成人民币。 */
		function currencySymbol(currency) {
			if (typeof currency !== "string" || currency === "") return "¥";
			const code = currency.trim().toUpperCase();
			if (code === "CNY" || code === "RMB") return "¥";
			if (code === "USD") return "$";
			if (code === "EUR") return "€";
			if (code === "JPY") return "¥";
			if (code === "GBP") return "£";
			return code + " ";
		}

		/**
		 * 账户读数 → 卡片金额行要显示的两截：符号 + 数值。
		 *
		 * 三种 kind：
		 *   · balance —— 币种符号 + 金额（`¥` / `$`，金额缺失时显示「—」）；
		 *   · usage / oauth —— 窗口标签 + 已用百分比。正常情况下卡片用
		 *     usageWindows() 给每个窗口画一个 D 形仪表盘，这里是窗口读不到数值时的
		 *     兜底（回退成最紧窗口或「—」）；
		 *   · 拿不到 —— 都是「—」，绝不显示 0.00 或 0%（那是"读到了 0"的意思）。
		 *
		 * @param kind     provider.kind
		 * @param account  { balance, usage }
		 * @param t        本地化函数（窗口标签需要它）
		 * @returns {{ symbol: string, value: string }}
		 */
		function accountLead(kind, account, t) {
			if (kind === "balance") {
				const balance = account && account.balance ? account.balance : null;
				return {
					symbol: currencySymbol(balance ? balance.currency : ""),
					value: money(balance ? balance.total : null),
				};
			}
			if (kind === "usage" || kind === "oauth") {
				const usage = account && account.usage ? account.usage : null;
				const windows = usage && Array.isArray(usage.windows) ? usage.windows : [];
				// 取已用百分比最高的窗口：它最先撞限，是用户最该看到的那个。
				let best = null;
				for (const w of windows) {
					if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
					if (best === null || w.percent > best.percent) best = w;
				}
				if (best === null) return { symbol: "", value: "—" };
				return {
					symbol: (t && t("accounts.window." + best.key)) || best.key,
					value: percentText(best.percent),
				};
			}
			return { symbol: "", value: "—" };
		}

		/**
		 * 从采集快照里找出「当前模型所属渠道」的积分读数。
		 *
		 * 为什么需要它：trae / buddy / qoder / zcode 这类免费渠道在旧路由的能力表里
		 * 没有条目，`/api/quota-usage` 会诚实地回答 `kind: 'none'` + "本插件不支持
		 * trae"。但积分其实已经由采集器采到了（`snapshots.credits.channels`），只是
		 * 卡片以前没人去读——于是用户看到的是"不支持"，而真正的原因是这个渠道的账户
		 * 不在 API Key 能力表里，它走的是积分。
		 *
		 * 匹配规则：provider id 归一后精确相等。不做前缀/模糊匹配——`trae` 与
		 * `trae-xxx` 是两个不同的东西（后者是账号 id），猜错会把别的渠道的积分
		 * 显示在当前模型下面。
		 *
		 * @param {object|null} snapshots 快照（`{credits: {value: {channels: [...]}}}`）
		 * @param {string} providerId 当前 provider id
		 * @returns {object|null} 该渠道的积分行（含 remaining / total / percent / unit）
		 */
		function creditRowOf(snapshots, providerId) {
			if (snapshots === null || typeof snapshots !== "object") return null;
			const credits = snapshots.credits;
			if (credits === null || typeof credits !== "object") return null;
			const value = credits.value;
			if (value === null || typeof value !== "object") return null;
			const channels = Array.isArray(value.channels) ? value.channels : [];
			const want = typeof providerId === "string" ? providerId.trim().toLowerCase() : "";
			if (want === "") return null;
			for (const row of channels) {
				if (row === null || typeof row !== "object") continue;
				const id = typeof row.channel === "string" ? row.channel.trim().toLowerCase() : "";
				if (id === want && row.state === "ok") return row;
			}
			return null;
		}

		/**
		 * 数字 → 中文量级缩写（亿 / 万），用于侧边栏卡片这类极窄容器。
		 *
		 * 为什么不用 K / M：中文界面上写 `16.0M` 是把英文缩写当成了自己的单位。
		 * 用户报的 bug 原文就是卡片显示 `token16.0M / 16.0M`——单位英文、量级也英文。
		 * 中文的读法就是「万」「亿」，一个 8 位数写成 `1600 万` 比 `16.0M` 还短。
		 *
		 * 只在 >= 1 万时缩写，其余按原数字（积分常见两位小数，去掉尾零）。
		 * `16000000` → `1600 万`；`160000000` → `1.6 亿`。
		 */
		function fmtCompactZh(value) {
			const abs = Math.abs(value);
			if (abs >= 1_0000_0000) return trimZero((value / 1_0000_0000).toFixed(1)) + " 亿";
			if (abs >= 1_0000) return trimZero((value / 1_0000).toFixed(1)) + " 万";
			return trimZero(value.toFixed(2));
		}

		/**
		 * 数字 → 英文量级缩写（B / M / K）。英文界面用这一套，与 zh 分开：
		 * 英文的 `16.0M` 完全正确，中文的 `1600 万` 也完全正确，两边不该共用一套缩写。
		 */
		function fmtCompactEn(value) {
			const abs = Math.abs(value);
			if (abs >= 1_000_000_000) return trimZero((value / 1_000_000_000).toFixed(1)) + "B";
			if (abs >= 1_000_000) return trimZero((value / 1_000_000).toFixed(1)) + "M";
			if (abs >= 1_000) return trimZero((value / 1_000).toFixed(1)) + "K";
			return trimZero(value.toFixed(2));
		}

		/** `1600.0` → `1600`、`1.60` → `1.6`：只去掉无意义的尾零，不丢有效小数。 */
		function trimZero(text) {
			return String(Number(text));
		}

		/**
		 * 上游 unit → 展示单位。返回 null 表示"不显示单位"。
		 *
		 * 上游给的是原文（`credits` / `credit` / `token` / `tokens`，个别渠道已经是
		 * `积分`），翻译由展示层负责——**不改宿主返回的数据**（同一份快照还被别处读）。
		 *
		 * 未知单位一律不显示：宁可只给数字，也绝不把英文原文漏到中文界面上
		 * （这正是用户报的 `credits5487.64` 那个 bug）。
		 * 英文界面直接把原文还给上游写法（credits / tokens），不需要"翻译成英文"。
		 */
		function creditUnitText(unit, t) {
			const raw = typeof unit === "string" ? unit.trim() : "";
			if (raw === "") return null;
			const lower = raw.toLowerCase();
			// 已经中文化的单位原样用（有的渠道上游就写「积分」）。
			if (raw === "积分") return t("credit.unit.credit");
			if (raw === "令牌") return t("credit.unit.token");
			if (lower === "credit" || lower === "credits") return t("credit.unit.credit");
			if (lower === "token" || lower === "tokens") return t("credit.unit.token");
			return null;
		}

		/**
		 * 百分比 → 整数字符串。null / 非数字是"没读到"，显示「—」而不是 0%
		 * （0% 是一个真实读数，含义完全相反）。
		 */
		function percentText(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return String(Math.round(n)) + "%";
		}

		/**
		 * 百分比 → 一位小数、但不留无意义的 `.0`（`8.1%` / `74%`，绝不出 `74.0%`）。
		 *
		 * 为什么不用 percentText（整数）：渠道余量经常落在 8.1% 这种位置，四舍五入成
		 * 8% 会让人以为"还早"，而 8.1% 与 8% 在"要不要现在去充值"上是两种判断。
		 * 但 74.0% 里的 `.0` 是纯噪声——所以只在真有小数时保留一位。
		 */
		function fmtPct(value) {
			if (value === null || value === undefined || value === "") return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			const rounded = Math.round(n * 10) / 10;
			return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%";
		}

		/**
		 * 余量 → 连续健康色的色相锚点。
		 *
		 * 三件事必须一起成立，任何一条错了这张卡都会误导人：
		 *
		 * 1. **数字是"剩余"**：100% = 满额（健康），0% = 耗尽（危险）。写反了会把
		 *    刚发的额度画成红色——这是最容易犯也最致命的错。
		 * 2. **连续插值，不分档**。分成七档固定颜色时，74% → 75% 会从琥珀整块跳到
		 *    橙，用户看到的是"颜色自己变了"，而不是"额度在减少"（OFM 的注释记录了
		 *    这个教训）。
		 * 3. **顶端要推进青绿（178°）**。如果色相在整段上线性铺开，90%~100% 只跨
		 *    二十几度，五个渠道全是几乎一样的绿，"满额"和"还行"读不出区别。锚点在
		 *    低端保持红→琥珀的警示坡度，把顶端拉开到青绿。
		 */
		const HUE_ANCHORS = [
			[0, 0],     // 耗尽：红
			[20, 25],   // 偏低：橙
			[40, 48],   // 注意：琥珀
			[60, 78],   // 一般：黄
			[75, 110],  // 尚可：黄绿
			[90, 148],  // 充足：绿
			[100, 178], // 满额：青绿
		];

		/** 在锚点之间求某个百分比对应的色相（度）。 */
		function hueFor(pct) {
			for (let i = 1; i < HUE_ANCHORS.length; i += 1) {
				const hiPct = HUE_ANCHORS[i][0];
				if (pct <= hiPct) {
					const loPct = HUE_ANCHORS[i - 1][0];
					const loHue = HUE_ANCHORS[i - 1][1];
					const hiHue = HUE_ANCHORS[i][1];
					const span = hiPct - loPct;
					const t = span <= 0 ? 0 : (pct - loPct) / span;
					return loHue + (hiHue - loHue) * t;
				}
			}
			return HUE_ANCHORS[HUE_ANCHORS.length - 1][1];
		}

		/**
		 * 剩余百分比 → 颜色。饱和度与明度也随值移动：越接近耗尽越浓越热，越满越
		 * 平和，整条色阶读起来才像"一把尺"，而不是一个色轮。
		 *
		 * 明确写成 `hsl()` 而不是主题变量：健康度是一条连续量，主题只有离散的
		 * success/warn/error 三档，用它就必然回到"分档跳变"的老问题。明度选在
		 * 52% 附近，明暗两套主题上都还能读。
		 */
		function percentColor(remainingPercent) {
			if (remainingPercent === undefined || remainingPercent === null) return null;
			const n = Number(remainingPercent);
			if (!Number.isFinite(n)) return null;
			const pct = Math.max(0, Math.min(100, n));
			const hue = hueFor(pct);
			const t = pct / 100;
			const sat = 52 + (1 - t) * 32;
			const light = 52 - (1 - t) * 3;
			return "hsl(" + hue.toFixed(1) + " " + sat.toFixed(0) + "% " + light.toFixed(0) + "%)";
		}

		/**
		 * 档位词（悬浮说明用）。故意做粗：人读「余额偏低」比读「18.4%」快，
		 * 精确数字就印在它旁边，不需要在这里再重复一遍。
		 */
		function percentLabelKey(remainingPercent) {
			if (remainingPercent === undefined || remainingPercent === null) return null;
			const pct = Number(remainingPercent);
			if (!Number.isFinite(pct)) return null;
			if (pct <= 5) return "credit.percent.gone";
			if (pct <= 20) return "credit.percent.low";
			if (pct <= 40) return "credit.percent.watch";
			if (pct <= 60) return "credit.percent.fair";
			if (pct <= 80) return "credit.percent.ok";
			if (pct <= 95) return "credit.percent.good";
			return "credit.percent.full";
		}

		/**
		 * **时间进度**的色相锚点——与上面 `HUE_ANCHORS`（剩余额度健康色）刻意分开。
		 *
		 * 两套色阶绝不能共用：它们问的是两个不同的问题，而同一张卡片上并排放着。
		 *   · `HUE_ANCHORS` 说的是「还剩多少额度」，红=快用完， mesures 的是**量**；
		 *   · 这一套说的是「这个窗口还剩多少时间」，红=快重置了，量的是**时间**。
		 * 实测这台机器上 5h 窗口是 `剩余额度 100% / 剩余时间 93.4%`，两个数颜色完全
		 * 相反（额度满=绿、时间将尽=绿…），共用一套会让读者以为其中一个标错了。
		 *
		 * 所以这里走一条自己的、**更淡**的锚点：
		 *   · 0%   = 时间已到尽头（马上重置）→ 淡红
		 *   · 50%  = 中间 → 中性灰
		 *   · 100% = 刚重置过 → 淡绿
		 * 用户原话是「红色绿色，要淡一点的」，并且明确不要淡到抢走右侧百分比健康色的
		 * 视线——所以饱和度和明度都比 `percentColor` 收一截（见 `countdownColor`）。
		 */
		const TIME_HUE_ANCHORS = [
			[0, 2],     // 时间将尽：红
			[40, 10],   // 已走过大半窗口：仍读作红（36% 这个常见位置就在这段里）
			[55, 58],   // 正中偏冷：黄，靠低饱和度压成中性
			[70, 108],  // 时间过半：转绿
			[100, 150], // 刚重置：绿
		];

		/** 时间进度百分比 → 色相（度）。与 `hueFor` 同一套线性插值，只是换锚点。 */
		function timeHueFor(pct) {
			for (let i = 1; i < TIME_HUE_ANCHORS.length; i += 1) {
				const hiPct = TIME_HUE_ANCHORS[i][0];
				if (pct <= hiPct) {
					const loPct = TIME_HUE_ANCHORS[i - 1][0];
					const loHue = TIME_HUE_ANCHORS[i - 1][1];
					const hiHue = TIME_HUE_ANCHORS[i][1];
					const span = hiPct - loPct;
					const t = span <= 0 ? 0 : (pct - loPct) / span;
					return loHue + (hiHue - loHue) * t;
				}
			}
			return TIME_HUE_ANCHORS[TIME_HUE_ANCHORS.length - 1][1];
		}

		/**
		 * 窗口的**时间进度**（0–100，100 = 刚重置、剩余时间占满整个窗口）→ 倒计时文字颜色。
		 *
		 * 与 `percentColor` 的三处关键差别，都是为了"淡一点"且"不抢戏"：
		 *   1. **饱和度更低**（34–46%，`percentColor` 是 52–84%）。中段还会再压一截，
		 *      让 50% 附近真的读成灰色，而不是一种"偏浑浊的绿/红"。
		 *   2. **明度更高**（58–62%），淡色配浅底更好读，也压不过右侧那个 600 粗体的
		 *      百分比（它是主角，这里是配角）。
		 *   3. **连续插值、不分档**——用户点名不要 50% 硬切换。分档会在剩余时间跨过
		 *      50% 的那一刻整块变色，读起来像"出事了"，而时间其实只是匀速流走。
		 *
		 * 拿不到总长（`cycle` 或未知 key）时返回 null：调用方退回主题次级色（中性），
		 * 宁可不染色，也不给一个自己编的进度。
		 */
		function countdownColor(timePercent) {
			if (timePercent === undefined || timePercent === null) return null;
			const n = Number(timePercent);
			if (!Number.isFinite(n)) return null;
			const pct = Math.max(0, Math.min(100, n));
			const hue = timeHueFor(pct);
			// 中段减饱和：`distance` 是到 50% 的距离（0 在正中、50 在两端）。
			// 整体比 `percentColor` 淡一档（那边是 52–84% / 52%），因为这一格是配角：
			// 右边那个 600 粗体的百分比才是主读数，倒计时只负责"还剩多久"的冷暖暗示。
			const distance = Math.abs(pct - 50) / 50;
			const sat = 16 + distance * 20;
			const light = 62 - distance * 2;
			return "hsl(" + hue.toFixed(1) + " " + sat.toFixed(0) + "% " + light.toFixed(0) + "%)";
		}

		/**
		 * 采集快照 → 渠道行数组。形状不对一律当"没有"处理，绝不猜。
		 *
		 * 与 creditRowOf 的分工：那个只挑「当前模型对应的那一条」，给单行读数用；
		 * 这个返回**全部**渠道，供逐渠道进度条与折叠摘要做选择。
		 */
		function creditChannelsOf(snapshots) {
			if (snapshots === null || typeof snapshots !== "object") return [];
			const credits = snapshots.credits;
			if (credits === null || typeof credits !== "object") return [];
			const value = credits.value;
			if (value === null || typeof value !== "object") return [];
			return Array.isArray(value.channels) ? value.channels.filter((row) => row !== null && typeof row === "object") : [];
		}

		/** 快照里"当前会话所用渠道"的 id；没有就返回 null（调用方再回退到 provider id）。 */
		function creditCurrentChannelOf(snapshots) {
			if (snapshots === null || typeof snapshots !== "object") return null;
			const credits = snapshots.credits;
			if (credits === null || typeof credits !== "object") return null;
			const value = credits.value;
			if (value === null || typeof value !== "object") return null;
			return typeof value.currentChannel === "string" && value.currentChannel !== "" ? value.currentChannel : null;
		}

		/**
		 * 渠道数组里有没有这个 id（归一后精确相等）。
		 *
		 * 用途：决定"能不能把当前 provider id 当成当前渠道"。判据是**数据**——
		 * 快照里真有这一行才认；不是"当前模型是不是免费渠道"。旧写法按 kind 判，
		 * 于是余额型模型即使自己在快照里有一行，摘要也不会认它。
		 *
		 * 不做前缀 / 模糊匹配，理由与 creditRowOf 相同：`trae` 与 `trae-xxx` 是两回事。
		 */
		function hasChannel(channels, channelId) {
			const want = typeof channelId === "string" ? channelId.trim().toLowerCase() : "";
			if (want === "" || !Array.isArray(channels)) return false;
			return channels.some((row) => row !== null && typeof row === "object"
				&& typeof row.channel === "string" && row.channel.trim().toLowerCase() === want);
		}

		/**
		 * 一行渠道的百分比（有限数才算，否则 null——null 是"没读到"，不是 0）。
		 *
		 * **分母缺失时按 100% 展示**（用户口径，覆盖了先前"没有分母就不出百分比"的做法）：
		 * 只有当这一行**有分子（remaining）但缺分母（total 缺失或 ≤ 0）**、且上游没给
		 * percent 时，才把分母补成分子，于是比例是 100%。
		 *
		 * 为什么补在这里而不是 channel-credits.js：采集侧那条规则（4c）说的是"不要编
		 * 造百分比"，它是对的——采集器不该替界面猜。这是**展示口径**，属于渲染层：
		 * 用户要的是"这一行别空着"，而不是"让采集器说谎"。所以采集侧照旧不给 percent，
		 * 由这里在渲染时兜底，快照本身仍然是诚实的原始数据。
		 *
		 * 三个边界必须守住，否则兜底会变成新的误导：
		 *   · **没有分子不补**：`remaining` 缺失时这是"没数据"，补 100% 会把空值画成满额。
		 *   · **上游给了 percent 就用上游的**，绝不覆盖——它是真实分母算出来的。
		 *   · 只影响积分渠道这一处；预充值走 prepaidRowOf，那条链路的"不伪造总量"
		 *     （验收 G5b）不受牵连。
		 */
		function channelPercent(row) {
			if (row === null || typeof row !== "object") return null;
			const pct = row.percent;
			if (typeof pct === "number" && Number.isFinite(pct)) return pct;
			// 分子有值、分母缺失/为 0 → 补成 100%。
			const remaining = typeof row.remaining === "number" && Number.isFinite(row.remaining) ? row.remaining : null;
			if (remaining === null) return null;
			// 分子必须是**正的**才补：`remaining === 0` 是"余额用光了"，补 100% 会画成
			// "满额"——0 分钱配 100% 是整张卡最刺眼的一种错。0 就不给百分比，
			// 让那个「0」自己说话。
			if (!(remaining > 0)) return null;
			const total = typeof row.total === "number" && Number.isFinite(row.total) ? row.total : null;
			if (total !== null && total > 0) return null;
			return 100;
		}

		/**
		 * 折叠摘要该说哪个渠道——这是整张卡最关键的一个选择，顺序不能乱：
		 *
		 * 1. **当前会话所用的渠道**能在快照里找到 → 就是它。用户问的是"我现在在花
		 *    的是什么"，只有这一行能回答。
		 * 2. **当前渠道不在快照里** → 报渠道名 + 「未显示」，**绝不退而显示别的渠道
		 *    的百分比**。那样写出来会被读成"这就是我在花的"，是最误导的一种错
		 *    （OFM 的注释专门写了这一条）。
		 * 3. **没有当前渠道** → 取剩余百分比最低的那条，也就是最可能耗尽的、最需要
		 *    用户行动的那条。数字是"剩余"，所以最小 = 最紧急。
		 *
		 * @returns {{channel: string|null, row: object|null, percent: number|null, notShown: boolean, empty: boolean}}
		 */
		function creditSummaryOf(channels, currentChannelId) {
			const list = Array.isArray(channels) ? channels : [];
			const want = typeof currentChannelId === "string" && currentChannelId !== "" ? currentChannelId.trim().toLowerCase() : null;
			if (want !== null) {
				const row = list.find((item) => typeof item.channel === "string" && item.channel.trim().toLowerCase() === want) || null;
				if (row !== null) {
					const pct = channelPercent(row);
					// 找到行但没有数字（查询失败 / 还没采到）：仍然报这个渠道名，
					// 明确说"未显示"——比换成别的渠道的数字诚实得多。
					return { channel: row.channel, row, percent: pct, notShown: pct === null, empty: false };
				}
				return { channel: currentChannelId, row: null, percent: null, notShown: true, empty: false };
			}
			let lowest = null;
			for (const row of list) {
				const pct = channelPercent(row);
				if (pct === null) continue;
				if (lowest === null || pct < lowest.percent) lowest = { channel: row.channel, row, percent: pct };
			}
			if (lowest !== null) return { channel: lowest.channel, row: lowest.row, percent: lowest.percent, notShown: false, empty: false };
			return { channel: null, row: null, percent: null, notShown: false, empty: list.length === 0 };
		}

		/**
		 * 卡片上的额度数字：**一律取整**，再大的走中文量级。
		 *
		 * 用户口径（「已买 44.00 分」→ 要显示成「已买 44 分」）：侧边栏上的积分数
		 * **不带小数**。两位小数在 274px 宽的侧边栏里要白吃两个字符的宽度，而它不回答
		 * 任何问题——没人会按 0.03 积分决定要不要充值。
		 *
		 * **为什么用 floor 而不是 round**（这一点是需求里点名要判断的）：
		 * 这个数是**剩余额度**（`row.remaining`），用户看它是为了判断"还够不够花"。
		 *   · floor **偏保守**：显示值永远 ≤ 真实值。真实 172.31 显示成「172 分」，
		 *     用户按显示值估算自己剩余额度时是**低估**——宁可觉得自己少一点，
		 *     也不会因为高估而把额度用到见底。
		 *   · round 会**向上**跨过整数（172.7 → 173），让用户以为比实际多。
		 * 余量读数虚高比虚低危险得多（虚高会让人放心大胆地烧，虚低只是多充一次）。
		 * 所以取 floor。
		 *
		 * 只影响**积分卡片**的读数：充值/余额走 `fmtMoney`（`¥6994.47` 那种），
		 * 单价走 `fmtPrice`（`¥0.4948` 那种），三者互不牵连。
		 */
		function fmtCreditAmount(value) {
			if (value === null || value === undefined) return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			const abs = Math.abs(n);
			if (abs >= 1_0000_0000) return trimZero((n / 1_0000_0000).toFixed(1)) + " 亿";
			if (abs >= 1_0000) return trimZero((n / 1_0000).toFixed(1)) + " 万";
			// 取整用 floor（向零截断）：积分不会为负，负数时 floor 会多给 1，
			// 所以这里按绝对值取整后再还原符号，负数也不会被抬高。
			return String(n < 0 ? -Math.floor(-n) : Math.floor(n));
		}

		/**
		 * 金额（余额）：去尾零、不带符号（符号由调用点单独画，币种可读性更高）。
		 * `20` → `20`、`12.5` → `12.5`、`12.34` → `12.34`，绝不留 `12.50` 这种假精度。
		 */
		function fmtMoney(value) {
			if (value === null || value === undefined) return "—";
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			return trimZero(n.toFixed(2));
		}

		/**
		 * 单条充值读数 → 展示形状。形状不认识就返回 null（调用方跳过这一条，
		 * 不是把它当成 0 元）。
		 *
		 * **数据事实（实测，不是猜）**：
		 *   · `balance.total` 是**剩余**，`balance.used` 是**已消耗**；
		 *   · OpenRouter 两个都给（`total_credits` + `total_usage`），所以能算出分母；
		 *   · DeepSeek / Moonshot / Z.ai 的余额接口只回剩余，`used` 为 null。
		 *
		 * 因此：只有 `used` 是有限数时才合并出总量并给百分比；否则 `total`/`percent`
		 * 都返回 null，调用方**不画条**——分母不存在时画出来的比例是编的，"100%" 会
		 * 被读成"额度还是满的"。
		 *
		 * @returns {{provider: string, displayName: string, currency: string,
		 *            remaining: number, used: number|null, total: number|null,
		 *            percent: number|null, ok: boolean} | null}
		 */
		function prepaidRowOf(value) {
			if (value === null || typeof value !== "object") return null;
			const balance = value.balance;
			if (balance === null || typeof balance !== "object") return null;
			// isAvailable === false 是"接口说这个账户没余额可查"，不是 0 元。
			if (balance.isAvailable === false) return null;
			const remaining = typeof balance.total === "number" && Number.isFinite(balance.total) ? balance.total : null;
			if (remaining === null) return null;
			const used = typeof balance.used === "number" && Number.isFinite(balance.used) && balance.used >= 0
				? balance.used
				: null;
			const currency = typeof balance.currency === "string" && balance.currency !== "" ? balance.currency : "CNY";
			const provider = typeof value.provider === "string" ? value.provider : "";
			const displayName = typeof value.displayName === "string" && value.displayName !== ""
				? value.displayName
				: provider;
			const total = used === null ? null : remaining + used;
			const percent = total !== null && total > 0 ? (remaining / total) * 100 : null;
			return { provider, displayName, currency, remaining, used, total, percent, ok: value.ok !== false };
		}

		/**
		 * 充值型快照 → **所有**有余额的提供商行（数组）。
		 *
		 * 采集侧现在返回 `{ providers: [...] }`：不再跟着当前对话模型走，而是枚举
		 * 所有配了凭据的提供商。所以才需要这个数组。
		 *
		 * 同时接受旧的单条形状（`{ provider, balance }`）：判据样本、老快照、以及
		 * 用户升级插件后宿主还没重采一轮的那几分钟，都会给单条。两种形状统一成数组，
		 * 渲染侧只有一条代码路径——兼容不是为了好看，是为了不让"还没采到新一轮"
		 * 变成"充值区突然空了"。
		 *
		 * @returns {Array<object>} 空数组 = 这一类确实没有可展示的数据
		 */
		function prepaidRowsOf(snapshots) {
			if (snapshots === null || typeof snapshots !== "object") return [];
			const meta = snapshots.prepaid;
			if (meta === null || typeof meta !== "object") return [];
			const value = meta.value;
			if (value === null || typeof value !== "object") return [];
			const list = Array.isArray(value.providers)
				? value.providers
				: [value];
			const rows = [];
			for (const item of list) {
				const row = prepaidRowOf(item);
				if (row !== null) rows.push(row);
			}
			return rows;
		}

		/**
		 * 订阅快照 → **所有**订阅来源（数组），每个来源带自己的**账号数组**。
		 *
		 * 采集侧返回 `{ subscriptions: [...] }`：plugin（dsh-chatgpt-subscription 里
		 * 已经登录好的那份）与 independent（本插件自己打上游）的成果并列。两种来源的
		 * 账号模型**不同**，但采集侧已经统一成 `accounts[]` 了：
		 *
		 *   · 多账号池型（OpenAI Codex）：一个池里多个账号，每个账号自己的用量。
		 *     只有当前活跃的那个有 windows，其余 `windows === null`。
		 *   · 单令牌型（Claude Code / Kimi / OpenCode / MiniMax）：一个凭据一个账号，
		 *     `accounts` 只有一个元素，`alias === null`（没有邮箱可显示）。
		 *
		 * 旧形状（`{ ok, windows }` 单条、没有 accounts）同样接受并折成单账号，
		 * 理由与充值那边一样：宿主与浏览器侧版本不一定同一步升级。
		 * `ok === false` 的来源**保留**：界面要能说清"这一组为什么没有数字"
		 * （令牌没填 / 插件不可用 / 上游挂了），把它丢掉会让整个分区消失，
		 * 用户只会看到"订阅没了"。
		 *
		 * @returns {Array<{provider: string, displayName: string, plan: string|null,
		 *                  mode: string, ok: boolean, error: string|null,
		 *                  accounts: Array<{id: string, alias: string|null, plan: string|null,
		 *                                  active: boolean,
		 *                                  windows: Array<{key, percent, resetsAt}>|null}>}>}
		 */
		function subscriptionGroupsOf(snapshots) {
			if (snapshots === null || typeof snapshots !== "object") return [];
			const meta = snapshots.subscription;
			if (meta === null || typeof meta !== "object") return [];
			const value = meta.value;
			if (value === null || typeof value !== "object") return [];
			const list = Array.isArray(value.subscriptions)
				? value.subscriptions
				: [value];
			const groups = [];
			for (const item of list) {
				if (item === null || typeof item !== "object") continue;
				const provider = typeof item.provider === "string" && item.provider !== "" ? item.provider : "";
				groups.push({
					provider,
					displayName: typeof item.displayName === "string" && item.displayName !== ""
						? item.displayName
						: provider,
					plan: typeof item.plan === "string" && item.plan !== "" ? item.plan : null,
					mode: typeof item.mode === "string" ? item.mode : "",
					ok: item.ok !== false,
					error: typeof item.error === "string" && item.error !== "" ? item.error : null,
					accounts: subscriptionAccountsOf(item),
				});
			}
			return groups;
		}

		/**
		 * 快照里是否存在**带重置时刻的订阅窗口**。
		 *
		 * 只做一件事：决定要不要起那个 1 秒心跳。倒计时是秒级的（用户要的是
		 * `1:30:20` 这种读数），30 秒的主心跳只够分钟级走字；但反过来，没有任何
		 * 倒计时可跑时也没必要每秒重渲染一次卡片。
		 *
		 * 与 `subscriptionGroupsOf` 分开写：这里只扫原始字段，不构造账号结构——
		 * 它要在组件体最前面回答一个布尔问题，不该顺手做一次完整归一。
		 */
		function hasCountdownWindow(snapshots) {
			if (snapshots === null || typeof snapshots !== "object") return false;
			const meta = snapshots.subscription;
			if (meta === null || typeof meta !== "object") return false;
			const value = meta.value;
			if (value === null || typeof value !== "object") return false;
			const list = Array.isArray(value.subscriptions) ? value.subscriptions : [value];
			for (const item of list) {
				if (item === null || typeof item !== "object") continue;
				const accounts = Array.isArray(item.accounts) ? item.accounts : [];
				const windows = [];
				for (const account of accounts) {
					if (account !== null && typeof account === "object" && Array.isArray(account.windows)) {
						windows.push(...account.windows);
					}
				}
				// 旧载荷（没有 accounts，窗口直接挂在来源上）同样要算。
				if (Array.isArray(item.windows)) windows.push(...item.windows);
				for (const w of windows) {
					if (w !== null && typeof w === "object" && typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt)) {
						return true;
					}
				}
			}
			return false;
		}

		/**
		 * 一个订阅来源 → 账号数组。
		 *
		 * `windows: null` 是**有含义的**：表示这个账号这次**没取到**用量（多账号池里
		 * 的非活跃账号就是这样）。它与"用量 0%"是两件完全不同的事——0% 是"额度用完
		 * 了"的真实读数，null 是"没去查/查不到"。界面必须能分开说，所以这里不把
		 * null 折成 0。
		 */
		function subscriptionAccountsOf(item) {
			const raw = Array.isArray(item.accounts) ? item.accounts : [];
			const accounts = [];
			for (const [index, entry] of raw.entries()) {
				if (entry === null || typeof entry !== "object") continue;
				const windows = Array.isArray(entry.windows) ? usageWindows({ usage: { windows: entry.windows } }) : [];
				const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : "account-" + index;
				accounts.push({
					id,
					// alias 为 null 时**不编**一个名字：界面回退到 provider 名 / 留空。
					// 编出来的"账号 1"会和真实账号混在一起分不清。
					alias: typeof entry.alias === "string" && entry.alias !== "" ? entry.alias : null,
					plan: typeof entry.plan === "string" && entry.plan !== "" ? entry.plan : null,
					// active 已经由采集侧按"取到 windows 没有"判过；旧载荷没这个字段时
					// 按 windows 在不在推——绝不用 `activeAccountId` 那种"默认账号"口径。
					active: entry.active === false ? false : windows.length > 0,
					windows: windows.length === 0 ? null : windows,
				});
			}
			// 旧载荷兜底：没有 accounts 但有顶层 windows → 折成一个无别名单账号，
			// 这样界面对"新老宿主"只有一种渲染路径。
			if (accounts.length === 0) {
				const legacy = usageWindows({ usage: { windows: item.windows } });
				if (legacy.length > 0) {
					accounts.push({ id: "default", alias: null, plan: null, active: true, windows: legacy });
				}
			}
			return accounts;
		}

		/**
		 * 订阅余量条：一个窗口一条 **4px 健康条**（与积分型同一形态）。
		 *
		 * 为什么不再画圆：用户看过真实界面后说"圆圈图太占位置"。这不是审美问题——
		 * 一个 34px 的圆外加下方两行标签（窗口名 + 已用值）在 274px 宽的侧边栏里
		 * 只放得下三个，而"每个账号一行"之后行数会翻倍（OpenAI Codex 这台机器上
		 * 就有两个账号），圆阵根本排不下。条只占 4px 高，宽度自适应，一行能并排
		 * 放两三个窗口。
		 *
		 * 口径与圆环完全一致，一个数都没有改：
		 *   · 条长 = **剩余**（100 − 已用），颜色也按剩余走（健康色与积分条同一套，
		 *     因为两者表达的是同一种"还剩多少"）。
		 *   · 条右侧的数字是**剩余**百分比，与条长同口径；已用值在悬浮说明里。
		 *     同一个读数里条长按已用、数字按剩余会自相矛盾——80% 的条配一个「20%」，
		 *     读者只会以为数字是反的。
		 *   · 宿主 `windows[].percent` 是**已用**（accounts.js 的 usedPercent 口径）。
		 *
		 * 上排左半边**不再是窗口名**。用户看完真实界面后连着提了三次，最后一句是
		 * 「算了，不要 5 小时和 7 天标题了，直接改成倒计时文字」——于是：
		 *   · 「5 小时」「7 天」整块去掉，位置让给 `D:HH:MM:SS` 倒计时；
		 *   · 倒计时按**时间进度**染色（淡红→淡绿），与右侧百分比的健康色是两套色阶；
		 *   · 拿不到 `resetsAt` 时退回原来的窗口名——这一格永远不能是空白，
		 *     空着比写着"5 小时"更让人摸不着头脑。
		 */
		function subscriptionBar(w, t, lang, key, nowMs) {
			const used = Math.max(0, Math.min(100, w.percent));
			const left = 100 - used;
			const color = percentColor(left) ?? C.sub;
			const now = Number.isFinite(nowMs) ? nowMs : Date.now();
			const resetsAt = typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null;
			// 剩余时间 → 倒计时文字 + 时间进度色。总长从 key 反推（宿主不给总长）；
			// 推不出来（`cycle`）时不染色，用中性次级色——宁可没有颜色，也不给错颜色。
			const remainMs = resetsAt === null ? null : Math.max(0, resetsAt - now);
			const spanMs = resetsAt === null ? null : windowSpanMs(w.key);
			// 时间进度 = 剩余时间 / 窗口总长。**越大越绿**（刚重置），越小越红（快重置）。
			// 剩余时间可能超出总长（宿主给的总长口径比实际窗口宽，或时钟回拨），
			// 夹到 0–100，别让颜色跑到色阶外面去。
			const timePercent = remainMs === null || spanMs === null || spanMs <= 0
				? null
				: Math.max(0, Math.min(100, (remainMs / spanMs) * 100));
			const timerColor = countdownColor(timePercent);
			// 有 resetsAt 就显示倒计时（恒显示，剩余 ≤0 时是「1分钟内」）；
			// 没有就退回窗口名。两种情况都只占一个 span，布局不因数据缺失而变。
			// 倒计时**不再看窗口 key**：新格式是自然语言，段数由剩余时间决定
			// （`2天13小时后` / `5小时42分钟后` / `42分钟后`），见 countdownText。
			const leadText = resetsAt === null ? windowLabel(t, w.key, lang) : countdownText(remainMs, t);
			// 悬浮说明：窗口名 + 已用 + 重置倒计时（`windowHint` 已经会拼，别在这里
			// 重写一份格式，否则同一个窗口在多提供商卡片上和订阅行里会显示两种说法），
			// 再补上条的读数（剩余）。条本身不写"已用"，那截只在悬浮里出现。
			const hint = windowHint(w, t, lang) + t("credit.ring.sep")
				+ fillN(t("credit.ring.left"), fmtPct(left));
			return h("div", {
				key,
				style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
				title: hint,
				role: "img",
				"aria-label": hint,
			},
				// 上排：倒计时（左，按时间进度染色）+ 剩余百分比（右）。
				// 两行结构不变——274px 里「文字 + 条 + 百分比」三样并排时，条会被压到
				// 只剩几个像素，等于没画（见本函数开头的注释）。
				h("div", {
					style: {
						display: "flex",
						alignItems: "baseline",
						gap: 4,
						minWidth: 0,
						fontSize: 9.5,
						lineHeight: "12px",
					},
				},
					// 倒计时**先分宽度、最后才让**：`1 1 auto` 让它吃掉剩余空间，百分比
					// 是 `0 0 auto` 不动。倒计时真的是放不下时才省略——按用户的优先级
					// （倒计时完整 > 百分比完整 > 条长），逗号在这里：条在下一行，不会被
					// 这一行的文字挤，所以先把宽度全给文字。
					h("span", {
						style: {
							// 有颜色就走时间进度色；没有（`resetsAt` 缺失 / `cycle`）
							// 退回次级色 + 降透明度，与原来的窗口名同一观感。
							color: timerColor === null ? undefined : timerColor,
							opacity: timerColor === null ? 0.6 : 1,
							// 定长数字 + tabular-nums：秒数每跳一次只换字符不换宽度，
							// 整块文字不会左右抖（用户点名要这个）。
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
							flex: "1 1 auto",
							minWidth: 0,
						},
					}, leadText),
					h("span", {
						style: {
							color,
							fontWeight: 600,
							fontVariantNumeric: "tabular-nums",
							whiteSpace: "nowrap",
							flex: "none",
						},
					}, fmtPct(left))),
				// 4px 条：轨道 + 剩余填充，与积分型 / 充值型同一套写法。
				h("span", {
					style: {
						height: 4,
						borderRadius: 2,
						background: C.track,
						overflow: "hidden",
						display: "block",
						minWidth: 0,
					},
				}, h("i", {
					style: {
						display: "block",
						height: "100%",
						borderRadius: 2,
						width: Math.max(0, Math.min(100, left)) + "%",
						// 填充带的短渐变与积分条一致：4px 高的纯色块在任何值上都读成
						// "一块绿"，看不出连续；12% 的色差刚好让坡度可见。
						background: "linear-gradient(90deg, " + percentColor(Math.max(0, left - 12)) + ", " + color + ")",
					},
				})));
		}

		/**
		 * 一个订阅账号一行。
		 *
		 * 三种形态必须能一眼分开：
		 *   · **多窗口账号**：左边别名，右边每个窗口一条 4px 条（窗口名在条上方）。
		 *     这台机器上 Codex 是 5 小时 + 7 天两个窗口，所以一行里并排两条。
		 *   · **单窗口账号**（Kimi / OpenCode / MiniMax 的 30 天、当前周期）：同一条路径，
		 *     只是数组里只有一个窗口。
		 *   · **未取用量的账号**（多账号池里的非活跃账号，`windows === null`）：**只写
		 *     「未取用量」，不画条、不显示 0%**。这是本条最关键的一条——0% 是"额度
		 *     用完"的真实读数，与"这次没去查"是两件完全不同的事，画成空条会把用户
		 *     骗去充值。
		 *
		 * 别名缺失（单令牌型没有任何邮箱可取）时**不留一个空列**：整行让给条。
		 * 编一个"账号 1"出来会和真实账号混在一起分不清。
		 */
		function subscriptionAccountRow(account, group, t, lang, key, nowMs) {
			// 别名：多账号池有邮箱；单令牌型 alias 是 null（没有邮箱可取）。`title`
			// 永远给全名，274px 宽下邮箱必然被省略号截断，悬浮是唯一能读全的地方。
			const aliasText = account.alias === null ? null : account.alias;
			const nameNode = aliasText === null ? null : h("span", {
				style: {
					fontSize: 10.5,
					opacity: 0.7,
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
					// 名字列最多占一半：条才是这一行的主体，长邮箱不能把条挤没。
					maxWidth: "52%",
					minWidth: 0,
					flex: "0 1 auto",
				},
				title: aliasText,
			}, aliasText);

			const tail = account.windows === null
				? h("span", {
					style: {
						fontSize: 10,
						opacity: 0.5,
						fontStyle: "italic",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						// **不收缩**（`0 0 auto`）。真实截图里这一格曾经是 `0 1 auto`，
						// 于是长邮箱（ruchonggg@gmail.com）把「未取用量」挤成「未取用」
						// 加半个残字——正是验收 G11 禁止的"1~2 字残段"。
						// 让邮箱先省略，这句话必须完整：它是这一行唯一的读数。
						flex: "0 0 auto",
						minWidth: 0,
					},
				}, t("credit.sub.notFetched"))
				: h("div", {
					style: {
						display: "flex",
						gap: 8,
						flex: "1 1 auto",
						minWidth: 0,
					},
				}, account.windows.map((w, i) => h("div", {
					key: "w-" + i,
					// 每个窗口平分剩余宽度：两个窗口各一半，三个各三分之一。
					// `minmax(0, 1fr)` 是必需的——默认的 `1fr` 是 `minmax(auto, 1fr)`，
					// 内容宽度会撑破容器（真实渲染里这样会把第三条挤出卡片）。
					style: { flex: "1 1 0", minWidth: 0, display: "flex" },
				}, subscriptionBar(w, t, lang, "bar-" + key + "-" + i, nowMs))));

			// 有别名时用两列（别名 / 条），没有别名时条独占整行。这样单令牌型的
			// 那条不会因为一个空列而短一截，视觉上也不会与多账号型错位。
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 7,
				minWidth: 0,
			};

			// 整个账号行的悬浮说明：账号是谁、套餐、以及"未取用量"的原因。
			// 这几个信息在 274px 里都放不下正文，但排查时必须有地方能看到。
			const tips = [aliasText, account.plan, group.displayName];
			const hint = tips.filter((part) => typeof part === "string" && part !== "").join(" · ");

			return h("div", {
				key,
				style: rowStyle,
				// 有正文说明时不重复；只有"未取用量"那种行才用 title 补账号身份。
				title: account.windows === null && hint !== "" ? hint : "",
			}, nameNode, tail);
		}

		// ---- 订阅用量窗口（一张卡片里同时显示多个档位）----
		/**
		 * 宿主的 usage.windows 已是归一后的 { key, percent, resetsAt }。这里只保留
		 * 数值有效的窗口，按固定顺序排列（5 小时 → 7 天 → Opus 7 天 → 30 天 →
		 * 当前周期），未知 key 殿后；百分比缺失的窗口不画——宁可不显示，也不画一条 0%。
		 */
		const WINDOW_ORDER = ["5h", "7d", "7d-opus", "30d", "cycle"];
		function usageWindows(account) {
			const usage = account && account.usage ? account.usage : null;
			const list = usage && Array.isArray(usage.windows) ? usage.windows : [];
			// 同 key 出现多次时保留已用百分比更高的那条（与宿主侧口径一致）。
			const byKey = new Map();
			for (const w of list) {
				if (!w || typeof w !== "object") continue;
				if (typeof w.percent !== "number" || !Number.isFinite(w.percent)) continue;
				const key = typeof w.key === "string" && w.key !== "" ? w.key : "cycle";
				const seen = byKey.get(key);
				if (seen !== undefined && seen.percent >= w.percent) continue;
				byKey.set(key, {
					key,
					percent: w.percent,
					resetsAt: typeof w.resetsAt === "number" && Number.isFinite(w.resetsAt) ? w.resetsAt : null,
				});
			}
			const rank = (key) => {
				const i = WINDOW_ORDER.indexOf(key);
				return i === -1 ? WINDOW_ORDER.length : i;
			};
			return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
		}

		/** 窗口 key → 本地化标签；词典里没有的通用时长（如 `1h` / `3d`）按语言拼。 */
		function windowLabel(t, key, lang) {
			const translated = t("accounts.window." + key);
			if (translated !== "accounts.window." + key) return translated;
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return lang === "en" ? hours[1] + "-hour" : hours[1] + " 小时";
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return lang === "en" ? days[1] + "-day" : days[1] + " 天";
			return key;
		}

		/**
		 * 周期徽章上的短标签（嵌在仪表盘底部缺口里，宽度有限）：统一用英文缩写，
		 * 短且与语言无关——`5H` / `7D` / `1M` / `OPUS` / `CYCLE`。
		 * 未知 key 按通用时长折算（1h → 1H、3d → 3D），仍不认得就原样大写。
		 */
		function windowBadge(key) {
			const fixed = { '5h': '5H', '7d': '7D', '30d': '1M', '7d-opus': 'OPUS', cycle: 'CYCLE' };
			if (fixed[key] !== undefined) return fixed[key];
			const hours = /^(\d+)h$/.exec(key);
			if (hours !== null) return hours[1] + 'H';
			const days = /^(\d+)d$/.exec(key);
			if (days !== null) return days[1] + 'D';
			return String(key).toUpperCase();
		}

		/** 单个窗口的悬浮说明：已用百分比 + 距重置的剩余时间。 */
		function windowHint(w, t, lang) {
			const label = windowLabel(t, w.key, lang);
			const used = percentText(w.percent);
			const left = typeof w.resetsAt === "number" ? w.resetsAt - Date.now() : null;
			const span = left !== null && left > 0 ? fmtDuration(left, lang) : null;
			if (lang === "en") {
				return span !== null ? `${label}: ${used} used, resets in ${span}` : `${label}: ${used} used`;
			}
			if (span !== null) return `${label}：已用 ${used}，${span}后重置`;
			if (left !== null && left > 0) return `${label}：已用 ${used}，即将重置`;
			return `${label}：已用 ${used}`;
		}

		/** 用量比例（0–1，超出部分按满格画，不改写数字本身）。 */
		function usageRatio(percent) {
			return Math.max(0, Math.min(100, percent)) / 100;
		}

		/**
		 * 强调色的低饱和度版本：主题的 state 色直接上屏太亮眼（绿、黄尤甚），
		 * 统一按 55% 主题色 + 45% 中性灰混合——色相不变、饱和度约减半，
		 * 明暗两套主题都跟着变。指示灯与仪表盘弧共用这一组值，
		 * 同一语义只有一种颜色。
		 */
		const desaturate = (token) => `color-mix(in srgb, ${token} 55%, #808080)`;

		/**
		 * 剩余额度弧的颜色：已用不到 80% 是绿色；80% 及以上是红色，
		 * 提醒剩余额度已经不多。已用部分始终是灰色。
		 * 绿/红都取降低饱和度后的强调色——绿色与指示灯里的绿色是同一个值。
		 */
		function remainingColor(percent) {
			return percent >= 80 ? C.alert : C.idle;
		}

		// 主题变量（带兜底值）
		const C = {
			bg: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.12))",
			// 卡片边框与侧边栏顶部「新会话」按钮同一套：0.5px、border-l3。
			cardBorder: "var(--dsw-alias-border-l3, rgba(127,127,127,.3))",
			track: "var(--dsw-alias-border-l1, rgba(127,127,127,.28))",
			label: "var(--dsw-alias-label-primary, #111)",
			sub: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
			// 错误文案保留主题错误色：它要表达"出问题了"，不做减饱和。
			err: "var(--dsw-alias-state-error-primary, rgb(200,40,40))",
			// `peak` 曾给峰谷指示灯用；指示灯整块去掉后它没有调用点，已删。
			idle: desaturate("var(--dsw-alias-state-success-primary, rgb(34,160,80))"),
			// 剩余额度不足（已用 ≥80%）的弧色；错误文案仍用 err。
			alert: desaturate("var(--dsw-alias-state-error-primary, rgb(200,40,40))"),
		};

		const svgBase = {
			width: 12,
			height: 12,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2.2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			style: { flex: "none", display: "block" },
		};
		// 输入：右箭头指向右边界（→|，数据进入边界）
		const IconIn = () => h("svg", svgBase,
			h("path", { d: "M20 4v16" }),
			h("path", { d: "M20 12H6" }),
			h("path", { d: "M10 7l5 5-5 5" }));
		// 输出：左边界发出右箭头（|→，数据从边界流出）
		const IconOut = () => h("svg", svgBase,
			h("path", { d: "M4 4v16" }),
			h("path", { d: "M4 12h14" }),
			h("path", { d: "M14 7l5 5-5 5" }));
		// 缓存：闪电（缓存命中，快）
		const IconCache = () => h("svg", svgBase,
			h("path", { d: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" }));
		/**
		 * 卡片的展开态，**存在模块作用域**而不是组件 state 里。
		 *
		 * 为什么不用 useState：侧边栏卡片会随语言切换、设置保存、工作区切换重新挂载，
		 * 用组件 state 时用户刚点开的三类列表每次都被合回去——读一份数据要看两遍
		 * 眼睛，是这个交互最烦人的地方。放模块作用域，一次点开后在整个页面生命周期里
		 * 都保持（刷新页面才复位，这符合"临时视图"的预期）。
		 *
		 * 它也不参与取数：展开/收缩不触发任何请求，缓存读取路径完全不变。
		 *
		 * **语义是两个形态，不是"更详细/更简略"**（用户口径：「收缩的时候只显示当前的，
		 * 展开的时候显示三大类所有的，不管当前是订阅型还是 ds 还是积分。」）：
		 *   · 收缩态 → 账户卡：当前这个模型/路由的读数；
		 *   · 展开态 → 三大类卡：订阅 / 充值 / 积分 的全部来源。
		 * 所以它不是"积分卡片的开关"，而是**整张卡**的开关——变量名随之改为 cardOpen。
		 *
		 * 默认**收缩**：用户口径是「收缩的时候只显示当前的，展开的时候显示三大类所有的」——
		 * 收缩态回答的是"我现在这个模型还剩多少"，那是打开侧边栏第一眼要看的那个数；
		 * 三大类清单是清单，该在用户主动要看的时候再展开。默认展开还有个实际代价：
		 * 会把侧边栏下方的按钮整块挤下去。
		 */
		let cardOpen = false;

		const IconWallet = () => h("svg", {
			viewBox: "0 0 16 16",
			width: 14,
			height: 14,
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.3,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			style: { flex: "none", display: "block", opacity: 0.7 },
		},
			h("path", { d: "M2 5.2a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6" }),
			h("rect", { x: 2, y: 5.2, width: 12, height: 7.2, rx: 1.6 }),
			h("path", { d: "M10.2 8.8h1.8" }));
		/**
		 * 时刻 → `HH:MM`（本地时区）。
		 *
		 * 只报时分：侧边栏那一行宽度有限，而"更新于 16:04"已经足够回答"这份数据新鲜
		 * 不新鲜"。日期不在卡片上出现——它属于悬浮说明。
		 */
		function clockText(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
			const d = new Date(ms);
			const hh = String(d.getHours()).padStart(2, "0");
			const mm = String(d.getMinutes()).padStart(2, "0");
			return hh + ":" + mm;
		}

		// ---- the widget -------------------------------------------------
		/**
		 * 当前正在看的会话 id。
		 *
		 * 为什么需要它：侧边栏卡片要显示**当前会话**用的那个模型的余额/单价，而宿主的
		 * `agentDefaultModel.currentSelection()` 给的是**全局默认选择**，与会话无关——
		 * 切到另一个用不同模型的会话时，它还返回旧值，面板就停在旧模型的读数上。
		 *
		 * 取法与宿主自己一致（`dsh-client-ui-layout/src/client/DocumentTitle.tsx`、
		 * `dsh-client-ui-cordis/src/client/CordisPanel.tsx`）：
		 * `Object.values(state.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id`。
		 * `retainedBy.mainView` 是"这个会话正被主面板持有"的计数，切换会话时它会转移，
		 * 因此这个选择器天然跟着切换走。
		 *
		 * `useSessions` 由槽位的 root 标准 props 提供（`sidebar.footer.action` 是
		 * `scope: 'root'`）。宿主没提供时（旧版本 / 单测里的迷你运行时）返回空串，
		 * 请求就不带 `?session=`，服务端回落到全局默认——与改造前的行为一致。
		 */
		function useCurrentSessionId(props) {
			const useSessions = props && props.useSessions;
			// 这里不能条件调用 hook（React 规则），所以先把订阅包成一个永远存在的函数。
			const subscribe = typeof useSessions === "function" ? useSessions : () => undefined;
			let id;
			try {
				id = subscribe((state) => {
					if (state === null || typeof state !== "object") return undefined;
					const byId = state.byId;
					if (byId === null || typeof byId !== "object") return undefined;
					for (const key of Object.keys(byId)) {
						const row = byId[key];
						if (row === null || typeof row !== "object") continue;
						const retained = row.retainedBy;
						const main = retained !== null && typeof retained === "object" ? retained.mainView : 0;
						if (typeof main === "number" && main > 0) return typeof row.id === "string" ? row.id : key;
					}
					return undefined;
				});
			} catch (e) {
				id = undefined;
			}
			return typeof id === "string" ? id : "";
		}

		function UsageCell(props) {
			const ctx = props.ctx;
			const wide = !!props.wide;
			// 整张卡的收缩/展开态（两种形态：收缩看当前账户读数，展开看三大类）。
			//
			// 用模块级开关 + 组件内 tick 触发重渲染（见 cardOpen 的注释）：
			// 卡片重新挂载后形态要保留，否则每次语言切换/保存设置都把它重置回去。
			const [, bumpCardOpen] = useState(0);
			const setOpen = (next) => {
				cardOpen = next;
				bumpCardOpen((v) => v + 1);
			};
			const open = cardOpen;
			// 当前会话 id：请求要带上它，服务端才能按会话取模型（见 useCurrentSessionId）。
			const sessionId = useCurrentSessionId(props);
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			// 倒计时走字用的心跳：每 30 秒 bump 一次，渲染时按当前时刻重算剩余时间。
			const [tick, setTick] = useState(0);
			const [holidayRanges, setHolidayRanges] = useState(() => HOLIDAY_RANGES);
			// 放假日期表：组件实例自己的集合（不做成模块级可变对象——同一页面挂两个实例
			// 时会互相覆盖，峰谷判定会无声翻转）。
			const holidayDays = useMemo(() => expandHolidayRanges(holidayRanges), [holidayRanges]);
			const mounted = useRef(true);
			// 请求序号：只有最后一次请求的结果可以写进 state。心跳、点击、设置事件
			// 会并发触发 load()，慢的旧响应回来得更晚，会把新数据盖掉。
			const requestSeq = useRef(0);
			// 快速重试：阶梯下标 + 定时器（宿主刚起来、余额接口还没返回时，几秒后自己再看一眼）。
			const retryStep = useRef(0);
			const retryTimer = useRef(null);
			// 页面可见性：后台标签页不做心跳（宿主每次都会真打一次官方余额接口）。
			const visible = useRef(typeof document === "undefined" || document.visibilityState !== "hidden");
			const locale = ctx && ctx.locale;

			// 订阅语言变化（DSH locale 服务；不可用时按浏览器语言兜底）。
			const lcSnap = react.useSyncExternalStore(
				(cb) => (locale && typeof locale.subscribe === "function" ? locale.subscribe(cb) : () => {}),
				() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot() : FALLBACK_LOCALE_SNAPSHOT),
			);
			// 中文（zh / zh-*）用中文词典，其它语言一律英文。
			const lang = uiLang(lcSnap && lcSnap.active);
			// locale.bind(ns) 返回绑定命名空间的翻译函数；不可用时按语言取本地词典。
			const boundT = locale && typeof locale.bind === "function" ? locale.bind(NS) : null;
			const t = (key) => {
				try {
					if (boundT) {
						const v = boundT(key);
						if (typeof v === "string" && v !== key) return v;
					}
				} catch (e) { /* 词典不可用，回退本地词典 */ }
				return textOf(key, lang);
			};
			// 词典也放进 ref：load 的依赖保持稳定（不随语言重建心跳），
			// 但兜底文案仍能取到当前语言。
			const tRef = useRef(t);
			tRef.current = t;

			// 宿主还在后台忙（重启后首次余额、接口刚起来）时按 QUICK_RETRY_MS 阶梯补几次请求，
			// 让卡片几秒内收敛，不必等下一次心跳（POLL_MS）。失败同样按此节奏重试。
			// 判断依据只看"有没有拿到余额"，不依赖宿主内部字段。
			const cancelRetry = useCallback(() => {
				if (retryTimer.current !== null) {
					clearTimeout(retryTimer.current);
					retryTimer.current = null;
				}
			}, []);

			// 语言放进 ref：load 的身份不随语言变化，切中英文时不会重建心跳定时器、
			// 也不会让旧语言的在途请求回填到新语言的界面上。
			const langRef = useRef(lang);
			langRef.current = lang;

			// 当前会话 id 同样放 ref：理由与 lang 一样——load 的身份要保持稳定，
			// 否则切会话会重建 30 秒心跳定时器。会话真变了由下面那个 effect 触发一次取数。
			const sessionRef = useRef(sessionId);
			sessionRef.current = sessionId;

			// loadRef 让下面两个回调可以互相引用而不必谁先声明。
			const loadRef = useRef(null);

			/** 按 QUICK_RETRY_MS 阶梯安排一次补请求（用 ref 记录进度；卸载时清理）。 */
			const scheduleRetry = useCallback(() => {
				if (!mounted.current) return;
				const delay = QUICK_RETRY_MS[retryStep.current];
				if (delay === undefined) return;
				retryStep.current += 1;
				cancelRetry();
				retryTimer.current = setTimeout(() => {
					retryTimer.current = null;
					const run = loadRef.current;
					if (run) run();
				}, delay);
			}, [cancelRetry]);

			const load = useCallback(async () => {
				const seq = ++requestSeq.current;
				try {
					// 两条数据一起拿：
					//   · USAGE_PATH —— 当前模型的余额 / 订阅窗口 / 单价（旧契约，用于余额类与订阅类）
					//   · SNAPSHOT_PATH —— 采集器缓存（积分类的唯一来源，且**不打上游**）
					//
					// 为什么必须合并：trae / buddy / qoder 这类免费渠道走的是积分，旧路由
					// 的能力表里没有它们，于是返回 kind:'none' + "本插件不支持 trae"，
					// 卡片就只剩一句"不支持"——而积分其实已经采到了，只是没人读。
					//
					// `session` 参数让宿主按**这个会话**的模型回答（会话级模型从会话日志里
					// 读，见 lib/usage.js 的 lastModelOf）。没有它时宿主只能回落全局默认，
					// 于是切到另一个用不同模型的会话后，卡片还停在旧模型的读数上。
					const nowSession = sessionRef.current;
					const usageUrl = USAGE_PATH + "?lang=" + langRef.current
						+ (nowSession === "" ? "" : "&session=" + encodeURIComponent(nowSession));
					const [usageRes, snapRes] = await Promise.all([
						fetch(usageUrl, { cache: "no-store" }),
						fetch(SNAPSHOT_PATH, { cache: "no-store" }).catch(() => null),
					]);
					let body = null;
					try {
						body = await usageRes.json();
					} catch (e) {
						body = null;
					}
					if (!usageRes.ok || body === null || typeof body !== "object" || body.ok !== true) {
						// 失败原因优先用宿主给的文案（未配置 Key / 余额接口异常，用户看得懂）；
						// 拿不到就用一句人话兜底——不把 HTTP 状态码这类传输细节摆到卡片上。
						throw new Error(body && typeof body.message === "string" && body.message !== "" ? body.message : tRef.current("error.refresh"));
					}
					// 快照是"附加信息"：读不到（宿主未挂上采集器 / 首次尚未采集）不影响
					// 余额类与订阅类的显示，所以这里吞掉失败，只把结果挂到 body 上。
					let snapshots = null;
					let policy = null;
					if (snapRes !== null && snapRes.ok) {
						try {
							const snapBody = await snapRes.json();
							if (snapBody && snapBody.ok === true && snapBody.snapshots) snapshots = snapBody.snapshots;
							// 采集间隔策略也走同一个响应：订阅类的间隔决定倒计时
							// 什么时候才需要精确（见 countdownNeedsTimer）。
							if (snapBody && snapBody.ok === true && snapBody.intervalPolicy) policy = snapBody.intervalPolicy;
						} catch (e) { snapshots = null; }
					}
					// 过期响应直接丢弃：晚到的旧结果不能盖掉新数据，也不能把刚填好的
					// 余额整个抹成错误态。
					if (!mounted.current || seq !== requestSeq.current) return;
					setData(snapshots === null ? body : { ...body, snapshots, intervalPolicy: policy });
					setError("");
					// 成功即取消待发的补请求并复位阶梯，否则上一次失败排下的定时器会
					// 在几秒后再打一发，可能把这份好数据换成错误态。
					cancelRetry();
					retryStep.current = 0;
				} catch (e) {
					if (!mounted.current || seq !== requestSeq.current) return;
					const message = e instanceof Error ? e.message : String(e);
					setError(message.length > ERROR_MAX_CHARS ? message.slice(0, ERROR_MAX_CHARS) + "…" : message);
					scheduleRetry();
				}
			}, [cancelRetry, scheduleRetry]);

			loadRef.current = load;

			// 语言切换后立刻按新语言重取一次：宿主返回的文案（余额/账户错误）要跟着
			// 换语言，不必等下一次心跳。用 ref 记录上一帧语言，挂载时不重复请求
			// （挂载 effect 已经 load 过），也不重建 30s 心跳定时器。
			const prevLangRef = useRef(lang);
			useEffect(() => {
				if (prevLangRef.current === lang) return;
				prevLangRef.current = lang;
				load();
			}, [lang, load]);

			// **切换会话**后立刻重取：另一个会话可能用的是完全不同的模型，卡片显示的是
			// "当前模型的余额/单价"，不重取就停在上一个会话的读数上——这正是用户报的
			// 「切过去之后标记没跟过去」。判据是会话 id 变化（`useSessions` 的
			// `retainedBy.mainView` 转移时它会变）；语言那条同理，用 ref 比较以免挂载时
			// 重复请求（挂载 effect 已经 load 过）。
			const prevSessionRef = useRef(sessionId);
			useEffect(() => {
				if (prevSessionRef.current === sessionId) return;
				prevSessionRef.current = sessionId;
				load();
			}, [sessionId, load]);

			useEffect(() => {
				mounted.current = true;
				load();
				// 模型切换（写入 settings 触发 document-updated）时立即刷新，单价跟着变。
				let off = null;
				try {
					if (ctx && ctx.remote && typeof ctx.remote.$on === "function") {
						off = ctx.remote.$on("settings/document-updated", () => {
							load().catch(() => {});
						});
					}
				} catch (e) {
					off = null;
				}
				return () => {
					mounted.current = false;
					cancelRetry();
					try {
						if (typeof off === "function") off();
					} catch (e) { /* 忽略退订错误 */ }
				};
			}, [load, ctx, cancelRetry]);

			// ---- 放假日期表（宿主是唯一权威：启动时拉一次，只用于本地兜底计算）----
			// 浏览器侧必须镜像峰谷规则（无法 import 宿主模块），放假日期也就不该各写一份，
			// 否则放假那几天两边会算出不同结果。这里用组件自己的 holidayDays 集合，
			// 宿主返回的表覆盖内置镜像。
			useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const res = await fetch(HOLIDAYS_PATH, { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						if (cancelled || !res.ok || !body || body.ok !== true) return;
						if (Array.isArray(body.ranges) && body.ranges.length > 0) setHolidayRanges(body.ranges);
					} catch (e) { /* 读不到就用内置表继续 */ }
				})();
				return () => { cancelled = true; };
			}, []);

			// 页面可见性：隐藏时停心跳，回到前台补一次。
			useEffect(() => {
				if (typeof document === "undefined") return;
				const onChange = () => {
					visible.current = document.visibilityState !== "hidden";
					if (visible.current) load().catch(() => {});
				};
				document.addEventListener("visibilitychange", onChange);
				return () => document.removeEventListener("visibilitychange", onChange);
			}, [load]);

			// 外部可主动通知「配置变了，立即重取一次」，不必等下一次心跳。
			// 历史上这个事件由设置页的映射编辑器在保存后派发；映射编辑器已移除，
			// 但监听保留为对外钩子（零成本，无派发方时就是空转）。
			useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
				const onConfig = () => { load().catch(() => {}); };
				window.addEventListener("dsh-usage:config-updated", onConfig);
				return () => window.removeEventListener("dsh-usage:config-updated", onConfig);
			}, [load]);

			// 心跳：每 POLL_MS 重算一次倒计时（setTick 触发重渲染）并重新取一次数。
			// 取数会带回最新的余额、峰谷状态与档单价，所以跨过峰谷切换点后单价与指示灯
			// 最多滞后一次心跳——不需要单独检测切换时刻。页面隐藏时不发请求。
			useEffect(() => {
				const timer = setInterval(() => {
					setTick((v) => v + 1);
					if (!visible.current) return;
					load().catch(() => {});
				}, POLL_MS);
				return () => clearInterval(timer);
			}, [load]);

			// 倒计时心跳：只在**真的要精确**时才起，而且**按需定步长**。
			//
			// **启用阈值（用户硬要求）**：剩余时间 > 订阅采集间隔 + 2 分钟 → **不起**
			// 定时器，界面显示按当时算好的**静态文字**，等下次采集刷新。
			// 理由：采集间隔 10 分钟时，那份数据 10 分钟才更新一次；每分钟给用户走
			// 一次字，是在显示一个**不会变的事实**——用户看到「42分钟后」倒成
			// 「41分钟后」，可底层数据一个字节都没变，那是在骗他。只有进入
			// 「间隔 + 2 分钟」之后、下次采集快要发生，精确到分钟才真的有意义。
			// 见 countdownNeedsTimer。
			//
			// 为什么不能复用上面那个 30 秒心跳：进入秒级显示后（剩 < 1 分钟）秒位
			// 必须每秒走一格，30 秒的粒度会让秒数一次跳 30，读起来像坏了。
			// 反过来，没有 `resetsAt` 时（这台机器上 Kimi 的 cycle 窗口就是）没有必要
			// 重渲染整张卡片，所以先问一句再决定起不起定时器。
			//
			// 起定时器后，步长按需：分钟级睡到下一个分钟边界，秒级睡到下一个整秒
			// （见 nextCountdownTickMs）。每次 tick 后重算一次阈值，所以跨过阈值
			// 门槛的那一刻会自动起定时器。
			//
			// 这个定时器**只重渲染、不发请求**：倒计时的输入是 `resetsAt`（绝对值）
			// 与本地时钟，不需要新数据。取数仍然只由 30 秒心跳和用户点击触发，
			// 「不轮询」的验收判据（G8）不受影响。
			//
			// 页面隐藏时同样停：后台标签页里重渲染是纯浪费。
			//
			// 订阅类的采集间隔从宿主回传的 intervalPolicy.configured.subscription 读
			// （与配置页「采集频率」用的是同一个值）。取不到时用默认 10 分钟。
			const countdownLive = hasCountdownWindow(data && data.snapshots);
			// 订阅采集间隔（毫秒）：宿主策略 → 配置表单 → 默认 10 分钟。
			const subscriptionIntervalMs = (() => {
				const policy = data && data.intervalPolicy;
				const configured = policy && typeof policy === "object" ? policy.configured : null;
				const ms = configured && typeof configured === "object" ? configured.subscription : null;
				if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
				return DEFAULT_COLLECT_INTERVAL_MS;
			})();
			// 最近的��次重置还有多久 → 决定要不要起定时器。
			const countdownRemainMs = (() => {
				const resets = resetsAtValues(data && data.snapshots);
				let best = null;
				for (const resetsAt of resets) {
					const remain = resetsAt - Date.now();
					if (!(remain > 0)) continue;
					if (best === null || remain < best) best = remain;
				}
				return best;
			})();
			// 下一次唤醒的毫秒数随 tick 重算：tick 一进来，可见文字的下一变化点就变了。
			const countdownNextMs = countdownLive && countdownNeedsTimer(subscriptionIntervalMs, countdownRemainMs)
				? nextCountdownTickMs(data && data.snapshots, Date.now())
				: null;
			useEffect(() => {
				if (!countdownLive || countdownNextMs === null) return undefined;
				if (typeof document !== "undefined" && document.visibilityState === "hidden") return undefined;
				const timer = setTimeout(() => {
					if (!visible.current) return;
					setTick((v) => v + 1);
				}, countdownNextMs);
				return () => clearTimeout(timer);
			}, [countdownLive, countdownNextMs, tick, data]);

			const tier = data && data.tier ? data.tier : null;
			// 当前 provider 的查询能力：balance 显示金额，usage/oauth 显示订阅窗口，
			// none 表示这个 provider 没有可查的接口（卡片置空说明原因）。
			//
			// **它只决定"画哪种形态"，不再决定"给不给看数据"**：三类采集数据（订阅 /
			// 充值 / 积分）一律显示，与当前模型是哪个 provider 无关。
			const kind0 = data && data.provider && typeof data.provider.kind === "string" ? data.provider.kind : "balance";
			// 当前模型的**路由 id**（用户看到的那条路由，例如 `codex-chatgpt`）。
			// 它只用于：① 剔除宿主那条「本插件不支持 X」错误文案（文案里写的是路由名）；
			// ② 展示时不显示路由 id，只显示来源名。
			const rawProviderId = data && data.provider && typeof data.provider.id === "string" ? data.provider.id : "";
			// 当前模型的**能力 id**（规范 id，例如 `openai-codex`）——匹配采集快照时用它。
			//
			// 为什么需要它：同一份 ChatGPT 订阅会被不同插件注册成不同路由 id。真机上当前
			// 模型走的是 `codex-chatgpt`（第三方 Codex 插件），而采集快照里的订阅来源 id
			// 是能力表的规范 id `openai-codex`。两边字符串不相等时按路由 id 精确匹配会
			// 筛出空集——收缩态整张卡只剩宿主那句「当前插件不支持 codex-chatgpt」，
			// 而那份订阅的数据就在快照里躺着。
			//
			// 归一**只在服务端做一次**（宿主用能力表算出 capability 再下发），客户端
			// 不自己维护别名表：浏览器 bundle import 不了宿主的 lib/accounts.js，两边
			// 各写一份必然漂移。老宿主没有这个字段时退回路由 id。
			const providerKey = data && data.provider && typeof data.provider.capability === "string" && data.provider.capability !== ""
				? data.provider.capability
				: rawProviderId;
			// 当前模型所属渠道的积分读数。判据是**数据**：采集快照里有没有这条渠道的
			// 积分行（creditRowOf 自己按 provider id 精确匹配）。**不是**"当前模型是不是
			// 免费渠道（kind none）"——旧写法把两者绑在一起，于是余额型模型永远拿不到
			// 自己那条积分读数，即使它就躺在快照里。
			//
			// 它现在只用来做一件事：宿主的"本插件不支持 X"那条错误在找到积分行时要剔掉
			// （数字就在手边，说"不支持"是误报）。**卡片形态不再由它决定**——账户读数
			// 与三类采集数据各按各的存在与否决定，见下面的 hasCardData。
			const creditRow = creditRowOf(data && data.snapshots, providerKey);
			// 账户读数（金额 / 订阅窗口）的形态由 kind 决定——这是**形态差异**：
			// 余额要画大数字、订阅要画仪表盘，两者不是"给不给看"的问题。
			const kind = kind0;
			const lead = accountLead(kind, data, t);
			const symbol = lead.symbol;
			const amount = lead.value;
			// 订阅用量：把宿主返回的每个窗口都画出来（D 形仪表盘 + 周期徽章 + 百分比），
			// 同一张卡片里并列显示 5 小时 / 周 / 月等多个档位，而不是只显示最紧的
			// 那一个。窗口读不到数值时回退成下面的 accountLead 兜底行。
			const usageRows = kind === "usage" || kind === "oauth" ? usageWindows(data) : [];
			// 档单价：宿主已按 provider + 模型查过价格表，known=false 表示"这个模型的价格
			// 插件不知道"，单价行不渲染。数据还没到（tier 为 null）时同样不显示——宁可
			// 少显示，也不要显示 0。
			const priced = !!tier && tier.known !== false;
			// provider 身份：本地兜底算倒计时、以及旧宿主响应的兼容判断都要用。
			// provider 字段缺失是老宿主的响应，按 DeepSeek 处理。
			const providerId = data && data.provider && typeof data.provider.id === "string"
				? data.provider.id.trim().toLowerCase()
				: "";
			const officialProvider = providerId === "" || ["deepseek-official", "deepseek-account", "deepseek"].includes(providerId);
			// 分时段计费：DeepSeek 的峰谷、其它 provider 的高峰/优惠时段都折算成
			// tier.window（'peak' 贵的一侧 / 'idle' 便宜的一侧）；null 表示全天一价，
			// 卡片只画单价行，不画指示灯与倒计时。订阅制路由上的 DeepSeek 模型也会
			// 由宿主填入时段（单价仍然 known=false），所以这张卡片也能显示峰谷灯。
			//
			// tier.window 是新宿主才有的字段：**旧宿主**（宿主进程没重启、只刷新了页面）
			// 的响应里没有它。那种情况退回旧口径——DeepSeek 官方模型照旧带峰谷指示灯，
			// 否则"刷新页面后指示灯凭空消失"。
			const hasWindows = !!tier && (tier.window === undefined ? priced && officialProvider : !!tier.window);
			// 卡片只显示"用户要的数字"：账户读数、当前档单价、状态圆点（悬浮给出
			// 距下次切换的剩余时间）。插件的内部信息（取价路径、模型改名）一律不进 UI，
			// 唯一的交互是点击卡片刷新。只有"账户类错误"（未配置密钥 / 接口或网络失败 /
			// 该 provider 没有可查接口）才把卡片置空并说明原因——否则读数是空的，
			// 用户无从判断。
			//
			// 例外：`kind === 'none'`（宿主说这条路由不在 API Key 能力表里）但在采集快照
			// 里找到了这个渠道的积分读数时，宿主的"不支持"文案是**对的但不该显示**——
			// 它说的是"能力表里没有这条路由"，而用户真正要的数字（积分余额与使用率）
			// 就在手边。这时把那条单独的错误剔掉。其它错误（未配置、网络失败）照旧显示。
			//
			// **这个判据必须留着 `kind0 === 'none'`**：它不是"给不给看数据"，而是
			// "这条错误说的是能力表缺条目，还是真的查失败了"。余额型 / 订阅型路由上的
			// 失败（未配置 Key、接口挂掉）是真的失败，绝不能因为快照里恰好有一行同名
			// 积分就被吞掉——那会变成"明明没配密钥却说一切正常"。
			const allErrs = (Array.isArray(data && data.errors) ? data.errors : []).concat(error ? [error] : []);
			const hasCurrentSnapshot = creditRow !== null
				|| subscriptionGroupsOf(data && data.snapshots).some((group) => canonicalProviderId(group.provider) === canonicalProviderId(providerKey))
				|| prepaidRowsOf(data && data.snapshots).some((row) => row.provider === rawProviderId);
			const errs = hasCurrentSnapshot && kind0 === "none"
				? allErrs.filter((line) => {
					// 只剔除"本插件不支持 X"这一类：宿主的 accountNoApi 文案带上渠道名，
					// 通过渠道名匹配即可，不去猜宿主内部错误码。
					if (typeof line !== "string") return true;
					const hint = rawProviderId === "" ? null : line.includes(rawProviderId);
					return !(hint === true && /不支持|unsupported|not supported|does not support/i.test(line));
				})
				: allErrs;
			const blanked = errs.length > 0;
			// 每次渲染都以"当前时刻"求剩余时间；tick 每 30 秒 bump 一次触发这次重算。
			const nowMs = Date.now();
			const nextAt = (() => {
				const raw = data && data.next ? Number(data.next.at) : NaN;
				// 宿主给的切换时刻必须还在将来：旧响应或时钟漂移会让它落在过去，
				// 那样悬浮说明里的时长会卡在 switching。
				if (Number.isFinite(raw) && raw > nowMs) return raw;
				// 只有"有计费区间 + DeepSeek 官方口径"才在本地重算；其它 provider 的
				// 时段表只在宿主里，本地没有镜像，不做猜测。
				if (!hasWindows || !officialProvider) return null;
				const age = data && Number(data.updatedAt) > 0 ? Math.max(0, nowMs - Number(data.updatedAt)) : 0;
				const local = nextChange(nowMs - age, holidayDays);
				return local.at !== null && local.at > nowMs ? local.at : null;
			})();
			void tick; // tick 只用来触发重渲染，值本身不参与计算
			// 计费区间切换的悬浮说明：指示灯本身只有颜色，指针悬停时用一句完整的话
			// 讲清"离贵/便宜的那档价还有多久"。拿不到切换时刻时退化成当前区间名，
			// 不足 1 分钟时说"即将切换"，都不拼数字。
			const statusText = data && data.peak ? t("status.peak") : t("status.idle");
			const switchHint = (() => {
				if (!hasWindows) return statusText;
				if (nextAt === null) return statusText;
				const span = fmtDuration(nextAt - nowMs, lang);
				if (span === null) return t("hint.switching");
				return `${t(data && data.peak ? "hint.idle" : "hint.peak")} ${span}`;
			})();
			// **指示灯已按用户要求整块去掉**（「当前大模型栏尾部的圆圈和小点可以不要的」）：
			//   · 宽态余额卡右上角那个——去掉；
			//   · 折叠态 36px 图标栏里那个（!wide 分支里的唯一内容）——去掉。
			// 峰谷信息没有丢：它还在**悬浮说明**里（switchHint：「距离峰价还剩 21 分钟」），
			// 指针悬到卡片上照样能读到。去掉的是那个没有文字、只有一个颜色的小圆点——
			// 它逼着用户去猜颜色的含义，却是侧边栏里最容易被误认成"状态指示"的东西。
			//
			// 画圆点的那几个定义（dotColor / dotCircle / dot / scheduleDot）已一并删除：
			// 它们没有调用点，留着只是"再也执行不到的代码"。真要恢复指示灯，按上面
			// 这段注释重新写即可，比留一份不能执行的实现更不容易误读。
			// 点击卡片：唯一动作 = 刷新。
			const onCardClick = () => {
				load().catch(() => {});
			};

			// 订阅用量形态下 symbol 是窗口标签（如「5 小时」），字号随正文，
			// 不再用 24px 的货币符号尺寸——标签比符号长，放大后会挤掉百分比。
			//
			// 这里**曾经**还有一档「积分类」（`kind === 'credits'`）：积分读数被当成
			// 账户读数直接画在卡片主体上时，它的数字长（`5487.64 / 7400 积分`），
			// 24px 会溢出侧边栏。门控拆掉之后，积分读数一律走下面「积分」分区里的
			// 逐渠道行（那里自带 11px 的字号与省略号），账户读数只画余额金额或订阅
			// 仪表盘，所以那一档再也没有调用路径——删掉，不留只能被读、不能被执行的
			// 分支。
			// 字号 15 是订阅仪表盘弧内数字专用的，这里不与它撞值。
			const usageLead = kind === "usage" || kind === "oauth";
			const leadStyle = usageLead
				? { fontWeight: 600, fontSize: 12, color: C.sub, lineHeight: "28px", marginRight: 1, flex: "none", whiteSpace: "nowrap" }
				: { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", marginRight: 3, flex: "none" };
			const amountStyle = { fontWeight: 700, fontSize: 24, color: C.label, lineHeight: "28px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

			// 折叠态（图标栏）：内容宽 36px（侧边栏 56px − 折叠态左右各 10px 内边距）。
			//
			// **指示灯已按用户要求去掉**（「当前大模型栏尾部的圆圈和小点可以不要的」）：
			// 这个栏原来**只有**那个 8px 的小圆点，没有别的内容。圆点去掉之后，
			// 这一栏就没有任何可显示的东西了——留一个 36px 的空盒子只会在侧边栏上
			// 留下一段空白（还会占掉点击区域，看起来像有个按钮却什么都不显示）。
			// 所以折叠态**整块不渲染**（返回 null）。
			//
			// 峰谷信息没有丢：它仍在宽态卡片的悬浮说明里（switchHint）。
			// 折叠态本来也放不下说明文字，指示灯是它唯一的表达方式——去掉之后
			// 折叠态选择"什么都不显示"，而不是"显示一个读不懂的颜色"。
			//
			// 以前这里渲染的是：kind==='none' 且没有真错误 → null（无内容可显示）；
			// 否则渲染一个 8px 的圆点（错误色 / 中性灰 / 峰谷色）。
			if (!wide) {
				return null;
			}

			// 只有"账户类错误"（未配置密钥 / 接口或网络失败 / 该 provider 没有可查
			// 接口）才走到这里：卡片置空、只显示原因文字，不画读数/单价/圆点/倒计时。
			// minHeight 兜住常态卡片高度（CARD_MIN_HEIGHT），侧边栏不跳动；
			// 文字多行时卡片自然变高。
			// 注意：这里不显示任何插件内部信息（取价路径、放假日期来源），历史上那批
			// 良性提示已随"去技术化"一起删除。
			// 折叠态（!wide）早在上面就返回了：它只有峰谷指示灯，没有文字空间。
			const fallbackAria = open ? t("card.collapse") : t("card.expand");
			const fallbackToggle = () => setOpen(!open);
			const fallbackRefresh = h("button", {
				type: "button",
				style: { alignSelf: "flex-end", appearance: "none", border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: "0 2px" },
				"aria-label": t("credit.refresh"),
				title: t("credit.refresh"),
				onClick: (e) => {
					if (e && typeof e.stopPropagation === "function") e.stopPropagation();
					onCardClick();
				},
				onKeyDown: (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); },
			}, "⟳");
			if (blanked && creditChannelsOf(data && data.snapshots).length === 0
				&& prepaidRowsOf(data && data.snapshots).length === 0
				&& subscriptionGroupsOf(data && data.snapshots).length === 0) {
				// 配色分流：`kind === 'none'` 不是错误——本插件就没打算查这个提供商，
				// 用户的账户没有任何问题。把它标红会让人以为出故障了，所以用常规
				// 次要文字色陈述事实；只有真去查过并失败（网络/认证/形状不认）才用红色。
				const unsupported = kind === "none";
				const reasonStyle = {
					color: unsupported ? C.sub : C.err,
					fontSize: 12,
					lineHeight: "16px",
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
				};
				const cardStyle = {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					minHeight: CARD_MIN_HEIGHT,
					padding: "8px 10px",
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 3,
					marginTop: 4,
					fontSize: "12px",
					lineHeight: "15px",
				};
				// 不支持的路由可以现场去映射：原因下面给一个直达「DeepSeek 用量」设置页的
				// 按钮；宿主没有设置外壳（旧版本 / 未认证页面）时不渲染，避免死按钮。
				if (unsupported) {
					const canMap = canOpenUsageSettings(ctx);
					return h("div", { style: { ...cardStyle, gap: 6 } },
						h("div", {
							style: { ...reasonStyle, cursor: "pointer" },
							role: "button",
							tabIndex: 0,
							"aria-label": fallbackAria,
				"aria-expanded": open === true,
							onClick: fallbackToggle,
							onKeyDown: (e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									fallbackToggle();
								}
							},
						}, errs.join(" | ")),
						fallbackRefresh,
						canMap
							? h("button", {
								type: "button",
								style: {
									alignSelf: "flex-start",
									boxSizing: "border-box",
									height: 22,
									padding: "0 8px",
									borderRadius: 6,
									border: "0.5px solid " + C.cardBorder,
									background: "transparent",
									color: C.label,
									font: "inherit",
									fontSize: 11,
									lineHeight: "20px",
									cursor: "pointer",
								},
								onClick: (e) => {
									if (e && typeof e.stopPropagation === "function") e.stopPropagation();
									openUsageSettings(ctx);
								},
							}, t("status.mapAction"))
							: null,
					);
				}
				return h("div", {
					style: { ...cardStyle, cursor: "pointer" },
					role: "button",
					tabIndex: 0,
					"aria-label": fallbackAria,
				"aria-expanded": open === true,
					onClick: fallbackToggle,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							fallbackToggle();
						}
					},
				}, h("div", { style: reasonStyle }, errs.join(" | ")), fallbackRefresh);
			}

			// ---- 免费渠道积分卡片：折叠一行摘要 + 展开逐渠道进度条 ----
			//
			// 这一段的结构抄自 dsh-ofm-balance，理由不是"好看"，是这张卡要回答的问题
			// 变了：从"我这一个账户还有多少钱"变成"这几个免费渠道各自还剩多少"。
			// 一个大数字只能回答前者；渠道一多，它必然被压成"某个渠道的数字"，而
			// 用户根本不知道那是哪个渠道。
			//
			// 三条从 OFM 的注释里学来的规矩，每条都对应一个真实误读：
			//   1. 折叠态只报**一个**渠道（当前对话用的那个），因为侧边栏宽度只够一句；
			//   2. 那个渠道没数据时说「未显示」，**绝不**换成别的渠道的数字 —— 换成
			//      别的渠道会被读成"这就是我在花的"，是最误导的一种错；
			//   3. 百分比是**剩余**，颜色随余量连续变化，名字不染色（颜色已被健康度
			//      占用，再给名字染色，两个都读成状态，谁也读不清）。
			const creditChannels = creditChannelsOf(data && data.snapshots);
			const snapshotCurrent = creditCurrentChannelOf(data && data.snapshots);
			// 当前对话用的渠道：快照自己报了就用它；没报就把当前 provider id 当成渠道 id
			// ——**但前提是这条渠道真的在快照里**。判据是数据，不是"当前模型是不是免费
			// 渠道"：旧写法要求 `kind === 'none'` 才敢用 provider id，于是余额型模型
			// （DeepSeek 官方）即使自己在积分快照里有一行，摘要也不会认它。
			// 「必须在快照里」这条不能省：deepseek-official 这类预充值路由常常没有积分行，
			// 那时摘要是凭空捏出来的渠道名，比不显示更误导。
			const creditCurrentChannelId = snapshotCurrent !== null
				? snapshotCurrent
				: (rawProviderId !== "" && hasChannel(creditChannels, rawProviderId) ? rawProviderId : null);
			const creditsMeta = data && data.snapshots && data.snapshots.credits ? data.snapshots.credits : null;
			// 采集器从未采过（value 为 null）：这是"读取中"，不是"没有数据"。
			const creditsLoading = creditsMeta !== null && (creditsMeta.value === null || creditsMeta.value === undefined);
			const creditUpdatedAt = creditsMeta && typeof creditsMeta.updatedAt === "number" && creditsMeta.updatedAt > 0
				? creditsMeta.updatedAt
				: (data && typeof data.updatedAt === "number" && data.updatedAt > 0 ? data.updatedAt : null);
			// 这一轮要展示的三类数据。**先算，再决定要不要渲染卡片**：卡片的存在
			// 条件不再只是"有积分渠道"，而是"三类里任意一类有东西"——只配了订阅、
			// 或者只有 OpenRouter 余额的机器，同样该看到这张卡。
			//
			// 充值 / 订阅都是**数组**：采集侧已改成枚举所有可用来源（预充值看凭据，
			// 订阅看 plugin 与 OAuth 两条路），不再跟着当前对话模型走。
			const prepaidRows = prepaidRowsOf(data && data.snapshots);
			const subGroups = subscriptionGroupsOf(data && data.snapshots);
			// 这张卡（订阅 / 充值 / 积分 三大类）的存在条件**只有一个**：三类里任意一类
			// 有数据。**与当前模型是哪个 provider 无关**——同一台机器、同一份采集数据，
			// 不该因为当前对话换了个模型就换一套界面。
			//
			// 旧写法还要求 `kind0 === 'none'`（"当前模型是免费渠道"），理由是"余额型
			// 与订阅型各有自己的卡片，不能被这张顶掉"。那个顾虑是对的，但解法用错了
			// 量：该防的是**同一份账户读数出现两次**，不是按当前模型类型决定给不给看
			// 采集数据。形态**不再由这里决定**：收缩看账户读数、展开看三大类，
			// 判据是展开态（见函数末尾的 open 分支），与当前模型是什么类型无关。
			const hasCardData = creditChannels.length > 0 || creditsLoading
				|| prepaidRows.length > 0 || subGroups.length > 0;
			// 三大类卡：先造出来放进变量，**不在这里 return**。
			//
			// 这里曾经直接 `return` —— 于是只要采集器采到过任意一类数据（真机上
			// 几乎恒为真），函数就在此结束，下面那张"当前模型的余额 / 订阅仪表盘"
			// 永远画不出来：DeepSeek 官方的 ¥6970.17 与 Codex 的 5 小时 / 7 天窗口
			// 一起消失，侧边栏只剩一张与当前模型无关的渠道列表。
			let threeKindCard = null;
			if (hasCardData) {
				const summary = creditSummaryOf(creditChannels, creditCurrentChannelId);
				const sumRow = summary.row;
				const sumPct = summary.notShown ? null : summary.percent;
				const sumColor = percentColor(sumPct);
				// 展开态不重复单位。折叠时这一行是**唯一**的信息来源，单位必须给；
				// 展开后同一个"积分"在下方「积分」分区标题与每行读数里已经出现两遍，
				// 头部再给第三遍纯属噪声，还占掉本可以给渠道名的宽度。
				// 顺带避开一个真实的歧义：两张分区标题与单位同名时，用户读到的是
				// "积分"这个词在三个层级上指三件不同的事（单位 / 分区 / 卡片）。
				const sumUnit = sumRow === null || open ? null : creditUnitText(sumRow.unit, t);
				// 摘要里的数值：有总数就报「剩余/总额」，没有总数就只报剩余。
				// 数字与百分比并排（OFM 只给百分比），因为本插件的宿主能拿到绝对
				// 剩余量，而"还剩 8.1%"与"还剩 300 积分"对用户是两种信息。
				const sumNumbers = (() => {
					if (sumRow === null) return null;
					const remaining = typeof sumRow.remaining === "number" && Number.isFinite(sumRow.remaining) ? sumRow.remaining : null;
					const total = typeof sumRow.total === "number" && Number.isFinite(sumRow.total) ? sumRow.total : null;
					// 摘要这一行的宽度是全卡最紧张的地方（图标 + 摘要 + 刷新 + 箭头），
					// 所以用 fmtCreditAmount：≥1000 取整、≥1万走中文量级。
					// 英文界面保留 B/M/K——那是英文的读法，不是本插件的单位。
					const fmt = lang === "en" ? fmtCompactEn : fmtCreditAmount;
					if (remaining === null && total === null) return null;
					const left = remaining === null ? "—" : fmt(remaining);
					// 「5069 / 7400」：斜杠两侧留空格。挤成「5069/7400积分」时
					// 数字、斜杠、单位连成一片，13px 以下尤其难扫读。
					return total === null ? left : left + " / " + fmt(total);
				})();
				const summaryNode = (() => {
					if (creditsLoading && creditChannels.length === 0) {
						return h("span", { style: { opacity: 0.55, fontStyle: "italic", fontWeight: 500 } }, t("credit.state.loading"));
					}
					if (summary.empty) {
						return h("span", { style: { opacity: 0.55, fontStyle: "italic", fontWeight: 500 } }, t("credit.state.empty"));
					}
					const parts = [
						h("span", { key: "n", style: { opacity: 0.85 } }, String(summary.channel ?? "")),
					];
					// 有没有**可显示的数字**，与有没有百分比是两件事。
					//
					// 误报就是这样来的：上游 creditSummaryOf 把「pct 为 null」直接判成
					// notShown，而下方这个分支又排在数字渲染之前，于是「有 remaining、
					// 没 total（于是没 percent）」的渠道（Minimax 就是）明明采到了一个
					// 真实数字，摘要却写「未显示」——用户看到的结论是"查不到"，实际上
					// 只是"算不出百分比"。数据在，却说没数据，这是这张卡上最坏的一种错。
					//
					// 所以判据换成「**数字和百分比都没有**」才叫未显示：只要能给出一个
					// 确定的数，就必须给，百分比缺了就只是不画百分比。
					const sumHasNumbers = sumNumbers !== null;
					if ((summary.notShown || sumPct === null) && !sumHasNumbers) {
						// 找到了渠道但没有数字，或干脆找不到这一行。三种情况必须分开说，
						// 合成一句「未显示」会让用户分不清"还没登录"和"查询挂了"：
						//   · 没登录账号 → 「未登录」（这是正常状态，不是故障）
						//   · 查询失败 → 「读取失败」
						//   · 快照里没这一行 → 「未显示」
						const rowState = sumRow === null ? "" : String(sumRow.state ?? "");
						const stateText = rowState === "empty"
							? t("credit.state.notLoggedIn")
							: (rowState === "error" ? t("credit.state.failed") : t("credit.state.notShown"));
						parts.push(h("span", { key: "d", style: { opacity: 0.35 } }, " · "));
						parts.push(h("span", { key: "s", style: { opacity: 0.55, fontStyle: "italic", fontWeight: 500 } }, stateText));
						return parts;
					}
					if (sumNumbers !== null) {
						parts.push(h("span", { key: "d1", style: { opacity: 0.35 } }, " · "));
						parts.push(h("span", { key: "v", style: { fontWeight: 500, opacity: 0.9 } }, sumNumbers));
						if (sumUnit !== null) parts.push(h("span", { key: "u", style: { opacity: 0.5, fontSize: 10 } }, sumUnit));
					}
					// 没有百分比就**到此为止**。绝不能补一个 `fmtPct(null)`：
					// 它会画成「—」，得到「minimax · 221 · —」这种读起来自相矛盾的一行
					// （说有了一个数，又说那个数是破折号）。缺分母只是缺一个信息，
					// 不该在数字后面再挂一个占位符冒充第二个信息。
					if (sumPct === null) return parts;
					parts.push(h("span", { key: "d2", style: { opacity: 0.35 } }, " · "));
					// 只有百分比染色。它是整张卡唯一的颜色信号。
					parts.push(h("span", { key: "p", style: { color: sumColor, fontWeight: 700 } }, fmtPct(sumPct)));
					return parts;
				})();
				// 收缩态要"从展开态里挑出当前厂商那一行"——所以筛选必须发生在**同一个
				// 构造器**里，而不是另写一套精简渲染。两套渲染一定会漂移：改了一边忘了
				// 另一边，收缩态显示的数字与展开态对不上，用户会以为哪一边是错的。
				//
				// `scope` 是**三态**，不是"有值 / null"两态：
				//   · 'all'  —— 展开态：用户主动要看全部；
				//   · 'none' —— 收缩态但**当前厂商未知**：明确说"当前模型未知"，
				//                一个别人的数据都不许画；
				//   · <id>  —— 收缩态且知道是哪一家：只画匹配的那一行。
				//
				// 旧写法把"当前未知"与"展开全部"压成了同一个值（null），于是当前
				// provider 为空时收缩态会变成全量——用户看到的是别人的账户。
				// 「不知道当前是谁」与「我要看全部」是两件事，必须能分开。
				//
				// 定义必须放在所有分区构造**之前**：积分行在下面第一个 map 里就要用它筛。
				const collapsed = !open;
				// 当前厂商 id **归一后**比较：账户路由 id 可能是别名
				//（`codex-chatgpt` → `openai-codex`），而快照里的来源 id 是规范 id。
				// 不归一就精确匹配不到，收缩态会筛出空集。
				//
				// providerKey 优先（宿主已归一）；老宿主没有这个字段时退回客户端自己的
				// 归一表（见 canonicalProviderId）——两侧都做归一，保证新旧宿主都能匹配。
				const currentProviderId = canonicalProviderId(providerKey);
				const scope = !collapsed ? "all" : (currentProviderId === "" ? "none" : currentProviderId);
				// 分区标题只在展开态画：收缩态只有一行，标题是纯噪声。
				const showSectionTitles = scope === "all";
				/**
				 * 这一行属于"当前厂商"吗？
				 *
				 * 订阅类按**归一后**的 id 匹配（同一份订阅的两种路由 id 都要算命中）；
				 * 充值类按**精确 id** 匹配——同一个厂商可能有两条不同的 API 路由
				 * （`deepseek-official` 与 `deepseek-account`），那是两份不同的余额，
				 * 显示当前那条之外的另一条等于报了个不相干的数。
				 */
				const isCurrentProvider = (id, kindHint) => {
					if (currentProviderId === "" || typeof id !== "string" || id.trim() === "") return false;
					const raw = id.trim().toLowerCase();
					if (kindHint === "prepaid") return raw === rawProviderId.trim().toLowerCase();
					return canonicalProviderId(raw) === currentProviderId;
				};
				const matchProvider = (id, kindHint) => scope === "all" || isCurrentProvider(id, kindHint);

				const channels = creditChannels.filter((row) => matchProvider(row.channel, "credits"));
				/**
				 * 积分区里的一行 → { node, row }。
				 *
				 * 返回 row 是为了**顶部当前行复用同一个节点**：顶部那一行必须与展开态
				 * 分区里那一行**同源同内容**（同一个数、同一个百分比），而不是两个
				 * 渲染器各算一遍——各算一遍迟早会漂移，用户看到两个不同的数就不知道
				 * 哪个是真的。所以这里只构造一次，顶部拿同一个 node 用。
				 */
				const creditRowNode = (row) => {
					const channelId = typeof row.channel === "string" ? row.channel : "";
					const isCurrent = creditCurrentChannelId !== null
						&& channelId.trim().toLowerCase() === creditCurrentChannelId.trim().toLowerCase();
					const pct = channelPercent(row);
					const color = percentColor(pct);
					const state = typeof row.state === "string" ? row.state : "ok";
					const unitText = creditUnitText(row.unit, t);
					// 行内数字与折叠摘要同一取整规则：≥1000 取整、≥1万走中文量级。
					// 两个地方各用一套格式时，同一份数据在头部写「5069」、在展开行写
					// 「5069.03」，看起来像两次不同的读数。
					const fmt = lang === "en" ? fmtCompactEn : fmtCreditAmount;
					const remaining = typeof row.remaining === "number" && Number.isFinite(row.remaining) ? row.remaining : null;
					const total = typeof row.total === "number" && Number.isFinite(row.total) ? row.total : null;
					// 悬浮说明：是否当前对话、账号、剩余/总数、档位词。精确数字放这里，
					// 折叠态那行才放得下。
					const labelKey = percentLabelKey(pct);
					const tip = [
						isCurrent ? t("credit.hint.current") : "",
						Array.isArray(row.nicknames) && row.nicknames.length > 0
							? fillN(t("credit.hint.accounts"), row.nicknames.join(", "))
							: "",
						total !== null
							// `credit.hint.remainTotal` / `credit.hint.remain` 用的是**具名**占位
							// （`{remaining}` / `{total}`），必须走 fillVars。这里原先写的是
							// fillN（只认 `{n}`），于是悬浮说明原样吐出「剩余 {remaining} /
							// 共 {total}」——一个旧 bug，只是以前卡片默认折叠、这段 title 不
							// 进渲染树，没人看见；默认展开之后它立刻暴露出来。
							? fillVars(t("credit.hint.remainTotal"), { remaining: remaining === null ? "—" : fmt(remaining), total: fmt(total) })
							: (remaining === null ? "" : fillVars(t("credit.hint.remain"), { remaining: fmt(remaining) })),
						labelKey === null ? "" : t(labelKey),
					].filter((line) => line !== "").join("\n");
					// 名称 / 进度条 / 数值三栏。当前渠道行靠左侧竖线与加粗标记，
					// 不用颜色——颜色已经被健康度占满了。
					const nameStyle = {
						fontSize: 11,
						opacity: isCurrent ? 1 : 0.75,
						fontWeight: isCurrent ? 600 : 400,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						minWidth: 0,
					};
					const rowStyle = {
						display: "grid",
						gridTemplateColumns: "62px minmax(0, 1fr) auto",
						alignItems: "center",
						gap: 7,
						minWidth: 0,
						position: "relative",
					};
					if (isCurrent) {
						rowStyle.marginLeft = -4;
						rowStyle.paddingLeft = 4;
					}
					// 值列：**剩余量能读出来就显示剩余量**，百分比只在有分母时追加。
					//
					// 旧写法按 total 分支（`total !== null ? 剩余 : fmtPct(pct)`），于是
					// 「有 remaining、无 total、无 percent」这一格同时丢掉了数字和百分比
					// —— 走 `fmtPct(null)` 渲染成破折号，`remaining` 整条被丢弃。这正是
					// 用户报的「MiniMax 查不到额度」：采集器采到了 remaining，界面上一片空。
					//
					// 更根本的问题是分支判据取错了量：能不能显示数字，取决于**有没有
					// remaining**，与有没有 total 无关；total 只决定能不能显示百分比。
					// 所以拆成两件独立的事：
					//   · 数字：有 remaining 就显示（含 0——「0 积分」是真实读数，
					//     与「没数据」不是一回事）；都没有才破折号；
					//   · 百分比：pct 非 null 才画。pct 可能来自上游，也可能是
					//     channelPercent 在「有分子缺分母」时按用户口径补出的 100%
					//     —— 那层兜底只改展示，采集侧仍然不编 percent。
					//
					// 还有一个方向不能弄丢：**没有 remaining 但有 pct** 的行（个别渠道
					// 只回一个比例）。那种行旧写法是对的（显示 `68.5%`），改判据时不能被
					// 压成一个「—」——破折号旁边挂个百分比，读起来像"比例算出来了、数量
					// 没算出来"，而真相是"这个渠道只报比例"。所以数字位在这一种情况下
					// 让位给百分比，不留破折号。
					const showPctOnly = remaining === null && total === null && pct !== null;
					const valueText = showPctOnly ? fmtPct(pct) : (remaining !== null ? fmt(remaining) : "—");
					const valueNode = state === "ok"
						? h("span", { style: { whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "right", fontSize: 11.5 } },
							h("span", { style: { fontWeight: 500 } }, valueText),
							// 单位跟着数字走：能被读到的那个数就是要标单位的那个数。
							// 原先只有 total 存在时印单位，无 total 的行即使有数字也没单位。
							remaining !== null && unitText !== null ? h("span", { style: { opacity: 0.5, fontSize: 10, marginLeft: 2 } }, unitText) : null,
							// 百分比独立判断：有分母才画。无 total 的行没有分母，只留数字。
							// pct-only 的情况百分比已经占用了数字位，不再重复画第二遍。
							pct !== null && !showPctOnly ? h("span", { style: { color: color, marginLeft: 5, fontSize: 10.5, fontWeight: 600 } }, fmtPct(pct)) : null)
						: h("span", { style: { fontSize: 10.5, opacity: 0.6, textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
							// empty = 这个渠道还没登录账号（正常状态，不是错误）；error 才是真失败。
							state === "empty" ? t("credit.state.notLoggedIn") : t("credit.state.failed"));
					const node = h("div", { key: channelId, style: rowStyle, title: tip },
						isCurrent
							? h("span", {
								style: {
									position: "absolute",
									left: 0,
									top: "50%",
									transform: "translateY(-50%)",
									width: 2,
									height: 11,
									borderRadius: 1,
									background: "currentColor",
									opacity: 0.45,
								},
							})
							: null,
						h("span", { style: nameStyle }, channelId),
						state === "ok" && pct !== null
							? h("span", {
								style: { height: 4, borderRadius: 2, background: C.track, overflow: "hidden", display: "block", minWidth: 0 },
							}, h("i", {
								style: {
									display: "block",
									height: "100%",
									borderRadius: 2,
									width: Math.max(0, Math.min(100, pct)) + "%",
									// 填充带一段极短的渐变：4px 高的纯色块在任何值上都读成
									// "一块绿"，看不出连续；12% 的色差刚好让坡度可见。
									background: "linear-gradient(90deg, " + percentColor(Math.max(0, pct - 12)) + ", " + color + ")",
								},
							}))
							: h("span", {
								style: {
									height: 4,
									borderRadius: 2,
									display: "block",
									minWidth: 0,
									// 读取中/未登录/出错的轨道：灰底，不画填充——没有数字就
									// 不画进度，画出来就是在编。
									background: state === "error" ? C.err : C.track,
									opacity: state === "error" ? 0.45 : 1,
								},
							}),
						valueNode);
					return { node, row };
				};
				const creditRows = channels.map((row) => creditRowNode(row));
				const rows = creditRows.map((entry) => entry.node);

				// ---- 三大类分区：订阅 → 充值 → 积分 ----
				//
				// 用户看过真实界面后定的形态：**卡片不再有标题**，只按三大计费类型分区。
				// 顺序是硬性的，理由不是审美：订阅按时间窗口收敛、充值按金额收敛、
				// 积分按渠道额度收敛，三者的"还剩多少"根本不是同一个量。放在一张表里
				// 排不了序，也选不了形态——所以先分区，再让每区用自己的图形。
				//
				// 空分区**不占位**（连标题都不渲染）：一个只有"订阅"标题、底下什么都没有
				// 的分区，读起来是"订阅出问题了"，而事实是"这台机器没配订阅"。
				// prepaidView / subWindows 已在上面（决定卡片存在与否时）算过一次。

				/** 分区标题：11px + 低不透明度，只做分组，不与数字抢注意力。 */
				const sectionTitle = (key, text) => h("div", {
					key,
					role: "heading",
					"aria-level": 3,
					style: {
						fontSize: 11,
						fontWeight: 600,
						opacity: 0.55,
						letterSpacing: 0.2,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						minWidth: 0,
					},
				}, text);

				// 订阅：**每个来源一组，组内每个账号一行**。
				//
				// 用户的两条要求在这里合流：
				//   · "所有订阅型都按账号显示（不只 GPT）" —— 数组统一成 accounts[] 之后，
				//     多账号池（Codex 两个账号）与单令牌型（Claude Code 一个账号）走同一条
				//     渲染路径，差别只在数组长度上。
				//   · "圆圈改条形" —— 每个窗口一条 4px 条，见 subscriptionBar。
				//
				// 来源名**永远显示**：行内可能出现两个长邮箱，不写来源名读者只能靠猜这是
				// 谁的额度（这台机器上可能同时有 ChatGPT 订阅和别家的订阅）。
				// 收缩态要"从展开态里挑出当前厂商那一行"——所以筛选必须发生在**同一个
				// 构造器**里，而不是另写一套精简渲染。两套渲染一定会漂移：改了一边忘了
				// 另一边，收缩态显示的数字与展开态对不上，用户会以为哪一边是错的。
				//
				// `scope` / `matchProvider` 在上面、所有分区构造之前就已经定义好了
				// （积分行的 map 比这里更早用到它）。
				//
				// 订阅类按**归一后**的 id 匹配：账户路由 id 可能是别名
				//（`codex-chatgpt`），快照里的来源 id 是规范 id（`openai-codex`），
				// 两者指同一份订阅。
				const subVisible = subGroups.filter((g) => matchProvider(g.provider, "subscription"));
				// 每个来源的节点单独存一份：顶部当前行要复用**同一个**来源节点
				// （同源同内容——两个渲染器各算一遍迟早漂移）。
				const subGroupNodes = subVisible.map((group, gi) => {
						const label = group.displayName !== "" ? group.displayName : group.provider;
						const header = group.plan === null ? label : label + " · " + group.plan;
						// 没有任何账号、也读不到窗口的来源：给一句话说清为什么（令牌没填 /
						// 插件不可用），不画空条——空条比不画更容易被读成"额度是 0"。
						const body = group.accounts.length === 0
							? h("span", {
								style: {
									fontSize: 10.5,
									opacity: 0.55,
									fontStyle: "italic",
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								},
								title: group.error === null ? "" : group.error,
							}, group.ok ? t("credit.sub.empty") : t("credit.state.failed"))
							: h("div", {
								style: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 },
							}, group.accounts.map((account, ai) => subscriptionAccountRow(account, group, t, lang, "acc-" + gi + "-" + ai, nowMs)));
						return { group, node: h("div", {
							key: "sub-" + gi,
							style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
						},
							h("span", {
								style: {
									fontSize: 10.5,
									opacity: 0.75,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
									minWidth: 0,
								},
								title: header,
							}, header),
							body) };
					});
				const subscriptionSection = subVisible.length === 0 ? null : h("div", {
					key: "sec.sub",
					style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
				},
					showSectionTitles ? sectionTitle("h", t("credit.section.subscription")) : null,
					...subGroupNodes.map((entry) => entry.node));

				// 充值：**每个提供商一行**。有已消耗才把「已消耗 + 剩余」合成总量画条；
				// 只有剩余时只报金额（分母不存在，画出来的比例是编的）。
				//
				// 充值型按**精确 id** 匹配（不归一）：同一个厂商可能有两条不同的 API
				// 路由（`deepseek-official` 与 `deepseek-account`），那是两份不同的
				// 余额，显示当前那条之外的另一条等于报了个不相干的数。
				const prepaidVisible = prepaidRows.filter((r) => matchProvider(r.provider, "prepaid"));
				// 每个充值来源的节点单独存一份：顶部当前行要复用**同一个**来源节点。
				const prepaidRowNodes = prepaidVisible.map((row, ri) => {
							const symbolText = currencySymbol(row.currency);
							const hasBar = row.percent !== null;
							const color = hasBar ? percentColor(row.percent) : null;
							const bar = hasBar
								? h("span", {
									style: {
										height: 4,
										borderRadius: 2,
										background: C.track,
										overflow: "hidden",
										display: "block",
										minWidth: 0,
									},
								}, h("i", {
									style: {
										display: "block",
										height: "100%",
										borderRadius: 2,
										width: Math.max(0, Math.min(100, row.percent)) + "%",
										background: "linear-gradient(90deg, " + percentColor(Math.max(0, row.percent - 12)) + ", " + color + ")",
									},
								}))
								// 分母不存在：不画条（画成 100% 是编的），中间格直接留空。
								// 这里曾经写一行小字「无已消耗数据」，用户口径是「没有足够
								// 信息就只展示余额数字」——那行字既占宽度，又要读者去理解一件
								// 他并不关心的事。金额右侧数值列已经有了；想知道为什么没有条
								// 的人可以悬停看 title（那不算可见文本，不占布局宽度）。
								: null;
							// 数值列：剩余 / 总量 + 百分比。百分比与斜杠那截之间必须留出明确
							// 间隔——`… / 20` 紧贴 `62.5%` 会读成「2062.5%」（真实渲染里出现过）。
							// 用 padding-left 而不是 marginLeft：它不会在行尾挤掉百分比。
							const valueNode = h("span", {
								style: {
									whiteSpace: "nowrap",
									fontVariantNumeric: "tabular-nums",
									textAlign: "right",
									fontSize: 11.5,
									flex: "none",
								},
							},
								h("span", { style: { fontWeight: 500 } },
									symbolText + fmtMoney(row.remaining)
									+ (hasBar ? " / " + fmtMoney(row.total) : "")),
								hasBar
									// 百分比单独一格，中间用「·」隔开。只靠 marginLeft 时，一旦
									// 容器被压缩，两个数字仍然会贴成「2062.5%」——分隔符不会消失，
									// 间距会。
									? h("span", { style: { opacity: 0.35, margin: "0 3px" } }, "·")
									: null,
								hasBar
									? h("span", { style: { color, fontSize: 10.5, fontWeight: 600 } }, fmtPct(row.percent))
									: null);
							const tip = hasBar
								? fillVars(t("credit.prepaid.remainTotal"), {
									remaining: symbolText + fmtMoney(row.remaining),
									total: symbolText + fmtMoney(row.total),
								})
								: fillVars(t("credit.prepaid.onlyAmount"), {
									amount: symbolText + fmtMoney(row.remaining),
								});
							return { row, node: h("div", {
								key: "pre-" + ri,
								style: {
									display: "grid",
									// 名字列用 auto：固定的 62px 会把「OpenRouter」截成
									// 「OpenRo…」（真实渲染里出现过）。条形列给
									// minmax(20px,1fr)，保证再长的名字也还剩一截可见的条。
									gridTemplateColumns: "auto minmax(20px, 1fr) auto",
									alignItems: "center",
									gap: 7,
									minWidth: 0,
								},
								title: tip,
							},
								h("span", {
									style: {
										fontSize: 11,
										opacity: 0.75,
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
										minWidth: 0,
										maxWidth: 84,
									},
								}, row.displayName),
								bar,
								valueNode) };
						});
				const prepaidSection = prepaidVisible.length === 0 ? null : h("div", {
					key: "sec.pre",
					style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
				},
					showSectionTitles ? sectionTitle("h", t("credit.section.prepaid")) : null,
					h("div", {
						style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 },
					},
						...prepaidRowNodes.map((entry) => entry.node)));

				const creditsSection = rows.length === 0 ? null : h("div", {
					key: "sec.cre",
					style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
				},
					showSectionTitles ? sectionTitle("h", t("credit.section.credits")) : null,
					...rows.map((node, i) => node));

				const sections = [subscriptionSection, prepaidSection, creditsSection].filter((node) => node !== null);

				const footNode = h("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						paddingTop: 2,
						marginTop: 2,
						borderTop: "1px solid " + C.track,
						fontSize: 10,
						opacity: 0.55,
					},
				},
					h("button", {
						type: "button",
						style: {
							appearance: "none", border: 0, background: "transparent", color: "inherit", font: "inherit",
							cursor: "pointer",
							padding: "1px 5px",
							borderRadius: 4,
							fontSize: 10,
							opacity: 0.9,
						},
						title: t("credit.refresh"),
						onClick: (e) => {
							if (e && typeof e.stopPropagation === "function") e.stopPropagation();
							onCardClick();
						},
					}, "⟳ " + t("credit.refresh")),
					h("span", null, creditUpdatedAt === null ? "" : fillN(t("credit.updatedAt"), clockText(creditUpdatedAt))));
				// ---- 顶部当前行 ----
				//
				// **展开态顶部保留与收缩态同源同内容的当前那一行**（用户口径：
				// 「展开后顶部还是那条当前数据」）。它必须**同源**——直接复用三大类里
				// 那一分区构造出来的**同一个节点**，而不是另画一个摘要：
				//   · 另画一份（早先的 creditSummaryOf 摘要）会永远指向积分渠道，
				//     于是当前模型是 DeepSeek 官方（充值型）时顶部却写着某个积分渠道；
				//   · 两个渲染器各算一遍迟早漂移，用户看到两个不同的数就不知道哪个是真的。
				//
				// 「当前那一行」是**按当前厂商从三大类里挑出来的那一行**，挑的顺序与
				// 收缩态一致：订阅（归一后匹配）→ 充值（精确 id）→ 积分（渠道名匹配）。
				// 挑不出来时明确说"当前模型未识别"，不画别人的数据。
				const currentRowNode = (() => {
					// 订阅：匹配当前厂商的那个来源（多账号全在那一行里）。
					const subHit = subGroupNodes.find((entry) => isCurrentProvider(entry.group.provider, "subscription"));
					if (subHit !== undefined) return subHit.node;
					// 充值：精确匹配当前 API 的那一行。
					const preHit = prepaidRowNodes.find((entry) => isCurrentProvider(entry.row.provider, "prepaid"));
					if (preHit !== undefined) return preHit.node;
					// 积分：匹配当前渠道的那一行。
					const creHit = creditRows.find((entry) => isCurrentProvider(entry.row.channel, "credits"));
					if (creHit !== undefined) return creHit.node;
					return null;
				})();
				// 当前厂商未知（宿主没给 provider.id / 给的 id 认不出来）：**不画任何
				// 一家的数据**，只说一句"未识别"。旧写法这里退化成"显示全部"——
				// 用户以为在看当前模型那一行，其实看到的是全机所有来源。
				const currentUnknown = currentRowNode === null;
				const currentRow = currentUnknown
					? h("div", {
						style: { fontSize: 10.5, opacity: 0.6, fontStyle: "italic", minWidth: 0 },
					}, currentProviderId === "" ? t("card.currentUnknown") : t("credit.state.empty"))
					: currentRowNode;
				/**
				 * 形态开关（双向）：收缩态点它展开，展开态点它收回。
				 *
				 * **整条当前数据行都是入口**，不只是右边那个小三角——用户看到的是
				 * 一行数据，点那一行的任何位置都该有反应（只让用户瞄准一个 8px 的
				 * 小三角，是把交互成本推给用户）。小三角保留，但它只是提示。
				 *
				 * 挂在**同一个节点**上：aria-label 随形态变（展开/收起），这样
				 * 屏幕阅读器与自动化用例都能认出这个开关。onClick 与 onKeyDown
				 * （Enter / Space）都要能切，键盘用户不能只有鼠标路径。
				 */
				const toggleAria = open ? t("card.collapse") : t("card.expand");
				const onToggle = (e) => {
					if (e && typeof e.stopPropagation === "function") e.stopPropagation();
					setOpen(!open);
				};
				const onToggleKey = (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen(!open);
					}
				};
				// 顶部那一行的容器：既承载内容，又是形态开关。
				// 展开态下它排在三大类**之前**；收缩态下三大类里只有当前那一行，
				// 于是这一行就是全部内容——两种形态下都只画一次、同一份内容。
				const currentRowContainer = currentRow === null ? null : h("div", {
					style: { minWidth: 0, cursor: "pointer" },
					role: "button",
					tabIndex: 0,
					"aria-label": toggleAria,
					"aria-expanded": open === true,
					title: toggleAria,
					onClick: onToggle,
					onKeyDown: onToggleKey,
				}, currentRow);
				threeKindCard = h("div", {
					style: {
						boxSizing: "border-box",
						flex: "1 1 100%",
						minWidth: 0,
						marginTop: 4,
						borderRadius: 8,
						// 收缩态的操作组（⟳ / ▸）绝对定位在右侧，需要一个定位祖先。
						position: "relative",
						// 不画边框、不填底色：侧边栏本身是透明的，任何有底色的框都会
						// 读成"贴上去的一个盒子"（OFM 为此专门删掉了边框与填充）。
						border: "none",
						background: "transparent",
						// 注意：这里**不能**写 color。百分比是整张卡唯一的染色元素，
						// 祖先一旦带颜色，取色会先命中祖先，"健康色"就永远看不到。
						userSelect: "none",
						fontSize: 12,
						lineHeight: 1.35,
					},
				},
					// 收缩态：数据行与操作组并排一行，用普通 flex，不用绝对定位。
					// （绝对定位在这张卡上被侧边栏的裁剪层吃过一次：DOM 里有、屏幕上没有。）
					h("div", {
						style: { display: "flex", flexDirection: "column", gap: 6, padding: open ? "5px 9px 8px 9px" : "6px 8px 6px 9px" },
					},
						h("div", {
							style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
						},
							h("div", {
								style: { display: "flex", flexDirection: "column", gap: open ? 9 : 0, minWidth: 0, flex: "1 1 auto" },
							},
								// 收缩态：三大类里只剩当前那一行，所以直接渲染 sections。
								// 展开态：先渲染**顶部当前行**（同源同内容），再渲染三大类全量。
								currentRowContainer,
								open ? (sections.length > 0
									? sections
									: h("div", { style: { fontSize: 10, opacity: 0.6 } }, t("credit.state.empty"))) : null),
							// 操作组（刷新 + 形态开关）**两种形态都有**：
							// 收缩态是 `▸`（回到三大类），展开态是 `▾`（收回去）。
							// 以前展开态这块是 null，于是展开之后就再也收不起来了——
							// 那不是"两种形态"，是单向消失。
							h("div", {
								style: { display: "flex", alignItems: "center", gap: 1, flex: "none", alignSelf: "flex-start" },
							},
								h("button", {
									type: "button",
									style: { appearance: "none", border: 0, background: "transparent", color: "inherit", font: "inherit", cursor: "pointer", fontSize: 10, opacity: 0.6, padding: "0 2px" },
									title: t("credit.refresh"),
									"aria-label": t("credit.refresh"),
									onClick: (e) => {
										// **必须**阻止冒泡：刷新是独立动作，不该连带切形态。
										if (e && typeof e.stopPropagation === "function") e.stopPropagation();
										onCardClick();
									},
								}, "⟳"),
								// 形态开关：收缩 `▸` / 展开 `▾`。小三角只是**提示**——
								// 真正的入口是整条当前数据行（上面那个容器）。它保留是因为
								// 箭头是"这里可以展开"的视觉惯例，而且它是键盘用户
								// 走到这个卡片时的最后一个显式入口。
								h("span", {
									style: { opacity: 0.55, fontSize: 10, padding: "0 3px" },
									"aria-hidden": "true",
								}, open ? "▾" : "▸"))),
						errs.length > 0 ? h("div", { style: { color: C.err, fontSize: 10.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" } }, errs.join(" | ")) : null,
						open ? footNode : null));
				// 放进变量继续往下走：账户卡（余额 / 订阅仪表盘）在这之后才画得出来。
			}

			// 单价组（图标 + 数字）：说明文字统一挂在下面的单价行上，命中区覆盖整行——鼠标
			// 落在数字上也出说明，不必精确指到那个小图标。
			const Price = (icon, value) =>
				h("span", { style: { display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, color: C.sub, whiteSpace: "nowrap" } },
					h("span", { style: { display: "inline-flex", alignItems: "center" }, "aria-hidden": "true" }, icon),
					h("span", { style: { fontWeight: 600 } }, fmtPrice(value)));

			// 单价行的悬浮说明：卡片上只有「图标 + 数字」，读不出单位也读不出三个档位分别
			// 指什么，所以整行共用一条 tooltip。单位是「每百万 tokens」，币种跟价格表走
			// （DeepSeek / Kimi 国内站 / MiniMax 国内站是人民币，Z.ai、OpenRouter 是美元）。
			// 原生 tooltip 不会自动折行，这里显式分两行：第一行讲单位，第二行给三个档位
			// ——侧边栏放不下时也不至于被拉成一长条。
			const priceCurrency = tier && typeof tier.currency === "string" && tier.currency !== "" ? tier.currency : "CNY";
			const priceUnitKey = "currency." + priceCurrency;
			const priceUnitText = t(priceUnitKey);
			const priceUnit = priceUnitText === priceUnitKey ? priceCurrency : priceUnitText;
			const priceTooltip = () => [
				t("price.perMillion"),
				[
					`${t("price.input")} ${fmtPrice(tier.input)} ${priceUnit}`,
					`${t("price.cache")} ${fmtPrice(tier.cacheRead)} ${priceUnit}`,
					`${t("price.output")} ${fmtPrice(tier.output)} ${priceUnit}`,
				].join(" / "),
			].join("\n");

			// 金额行：账户读数 + 右侧「倒计时 + 峰谷圆点」。
			// 倒计时与圆点放在同一个 flex 行里、alignItems:center，两者圆心必然重合；
			// 整组 alignSelf:flex-start + 负 margin，让圆点距卡片顶/右各 8px。
			// 两个反面做法都试过并实测过：
			//   · alignSelf:center → 圆点被压到卡片中线，不再是"右上角"；
			//   · paddingTop:6    → 金额行被撑高，卡片被撑大，圆点反而更靠下。
			// 金额行只放余额读数，在卡片内容区里竖向居中；单价行绝对定位在右下角，
			// 不再占据流式高度，因此金额能真正落在卡片竖直中线上。
			// 右侧留出单价行的宽度，长余额（¥1234567.89）用省略号截断，不会压到单价。
			// 有单价行时金额整体右移 10px，收窄它与右下角单价之间的空白。
			//
			// 顺序只有一种：符号在前（`¥12.34`），符号与金额同字号——这是货币的读法。
			// 这里**曾经**还有一条"积分类"分支（数字在前、单位在后、14px），那是积分
			// 读数被当成账户读数直接画在卡片主体上的年代留下的。门控拆掉后积分读数
			// 一律走下面「积分」分区里的逐渠道行，这条分支再没有调用路径，已删除。
			const leadNodes = [
				h("span", { key: "symbol", style: leadStyle }, symbol),
				h("span", { key: "amount", style: amountStyle }, amount),
			];
			// 收缩态的展开入口：右下角一个 ▸。
			//
			// 为什么账户卡也需要它：卡片的形态由 `open` 决定（收缩 = 当前账户读数，
			// 展开 = 三大类）。收缩态里如果不给入口，用户就再也回不到展开态——那不是
			// 一个两种形态的开关，而是一个单向消失。它与三大类头部的 ▾ 是**同一个
			// 开关的两端**，位置也对齐（都靠右），用户不会以为是两个功能。
			//
			// 没有三类数据可展开时（threeKindCard 为 null）不画：点了什么都不会变，
			// 一个按下去没反应的箭头比没有箭头更糟。
			const expandToggle = h("span", {
				type: "button",
				style: {
					appearance: "none", border: 0, background: "transparent", color: "inherit", font: "inherit",
					position: "absolute",
					right: 6,
					top: 3,
					cursor: "pointer",
					padding: "0 3px",
					fontSize: 10,
					lineHeight: "12px",
					opacity: 0.5,
					flex: "none",
				},
				"aria-hidden": "true",
			}, open ? "▾" : "▸");
			const balanceRow = h("div", {
				style: {
					display: "flex",
					alignItems: "baseline",
					minHeight: 28,
					minWidth: 0,
					gap: 6,
					paddingLeft: priced ? 10 : 0,
					paddingRight: priced ? 104 : 0,
				},
			}, leadNodes);

			// 订阅用量：每个窗口一个开口朝下的 D 形仪表盘。绿色弧是尚未使用的额度，
			// 灰色弧是已经用掉的部分；剩余额度在已用 ≥ 80% 时变红。周期缩写徽章嵌在
			// 底部缺口里，省掉单独一行标签。仪表盘按数量均分卡片宽度，竖向居中。
			const GAUGE = 45;
			const GAUGE_STROKE = 4;
			const GAUGE_RADIUS = (GAUGE - GAUGE_STROKE) / 2;
			const GAUGE_CIRC = 2 * Math.PI * GAUGE_RADIUS;
			// 保留底部 140° 的缺口放周期徽章；弧从缺口左端（160°）顺时针扫 220°。
			const GAUGE_SWEEP = 220 / 360;
			const GAUGE_ARC = GAUGE_CIRC * GAUGE_SWEEP;
			const GAUGE_START = 160;
			// 右上角指示灯占位：**已去掉**。
			//
			// 这里原来固定留 16px，是给右上角那个指示灯让位的：指示灯是否渲染取决于
			// 宿主有没有给计费区间（数据加载前后、不同模型之间都会变），但让位宽度
			// 必须恒定，否则三个仪表盘会随指示灯的显隐左右移动、间距也变。
			//
			// 指示灯按用户要求整块去掉后，这 16px 就是**一段纯空白**——它没有任何内容
			// 让位，只是把仪表盘阵列整体往左挤，在侧边栏里表现为仪表盘右边多出一截
			// 说不清是什么的空隙。所以连同 paddingRight 一起清掉，仪表盘重新居中。
			const usageGrid = h("div", {
				style: {
					display: "grid",
					gridTemplateColumns: "repeat(" + Math.max(1, usageRows.length) + ", minmax(0, 1fr))",
					justifyItems: "center",
					alignItems: "start",
					minWidth: 0,
					boxSizing: "border-box",
				},
			}, usageRows.map((w) => {
				const hint = windowHint(w, t, lang);
				const ratio = usageRatio(w.percent);
				const usedLength = GAUGE_ARC * ratio;
				const restLength = GAUGE_ARC - usedLength;
				return h("div", {
					key: w.key,
					style: { position: "relative", width: GAUGE, height: GAUGE, flex: "none" },
					title: hint,
					role: "img",
					"aria-label": hint,
				},
					h("svg", {
						width: GAUGE,
						height: GAUGE,
						viewBox: "0 0 " + GAUGE + " " + GAUGE,
						style: { display: "block" },
						"aria-hidden": "true",
					},
						// 未使用（默认绿色；已用 ≥ 80% 时变红）：从已用部分的末端开始，
						// 画满剩余弧长。颜色写在 style 里：color-mix() 在 presentation
						// attribute 上的支持不如 CSS 属性稳妥。
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: GAUGE_RADIUS,
							fill: "none",
							style: { stroke: remainingColor(w.percent) },
							strokeWidth: GAUGE_STROKE,
							strokeLinecap: ratio < 1 ? "round" : "butt",
							strokeDasharray: restLength + " " + GAUGE_CIRC,
							transform: "rotate(" + (GAUGE_START + 220 * ratio) + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
						}),
						// 已使用（灰色）：从起点顺时针覆盖已用比例。
						h("circle", {
							cx: GAUGE / 2,
							cy: GAUGE / 2,
							r: GAUGE_RADIUS,
							fill: "none",
							stroke: C.sub,
							strokeWidth: GAUGE_STROKE,
							// 0% 时用平头，否则圆头会在弧的起点画出一个"已经用了一点"的圆点。
							strokeLinecap: ratio > 0 ? "round" : "butt",
							strokeDasharray: usedLength + " " + GAUGE_CIRC,
							transform: "rotate(" + GAUGE_START + " " + GAUGE / 2 + " " + GAUGE / 2 + ")",
						})),
					// 弧内偏上的数字是「剩余量」而不是已用量（绿色/红色弧表示的也是剩余），
					// 去掉百分号、字号加大；完整的已用/剩余百分比与重置时间在悬浮说明里。
					// 用 HTML 而不是 SVG text，字体、字重与卡片其余数字完全一致。
					h("span", {
						style: {
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							paddingBottom: 10,
							fontSize: 15,
							lineHeight: "15px",
							fontWeight: 700,
							color: C.label,
							fontVariantNumeric: "tabular-nums",
						},
					}, String(Math.round(Math.max(0, Math.min(100, 100 - w.percent))))),
					// 周期徽章：嵌在弧的底部缺口里，贴近弧端，减少中间的空档。
					// 底色与卡片一致，遮住徽章底下可能露出的弧端。
					h("span", {
						style: {
							position: "absolute",
							left: "50%",
							bottom: 5,
							transform: "translateX(-50%)",
							boxSizing: "border-box",
							maxWidth: "100%",
							padding: "0 4px",
							border: "1px solid " + C.track,
							borderRadius: 99,
							background: C.bg,
							fontSize: 10,
							lineHeight: "12px",
							fontWeight: 600,
							color: C.sub,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						},
					}, windowBadge(w.key)));
			}));

			const accountCard = h("div", {
				style: {
					boxSizing: "border-box",
					flex: "1 1 100%",
					minWidth: 0,
					// 两种卡片同高（60px）。订阅卡的上内边距比下内边距多 9px，
					// 让仪表盘（弧 + 底部徽章）的视觉重心落在卡片中线上；余额卡上下各 6px。
					padding: usageRows.length > 0 ? "11px 10px 2px" : "6px 10px",
					minHeight: 60,
					borderRadius: 10,
					border: "0.5px solid " + C.cardBorder,
					background: C.bg,
					color: C.label,
					cursor: "pointer",
					userSelect: "none",
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					gap: 2,
					marginTop: 4,
					position: "relative",
					fontSize: "12px",
					lineHeight: "15px",
				},
				role: "button",
				tabIndex: 0,
				"aria-label": fallbackAria,
				"aria-expanded": open === true,
				// 峰谷信息（现在是高峰还是空闲、离切换还有多久）挂在**整张卡片**的
				// 悬浮说明上。指示灯去掉之前，这句话是由那个 8px 的小圆点带着的；
				// 圆点没了，说明得换个载体——否则"离峰价还剩多久"这句话就没人带了。
				// 挂在卡片上比挂在圆点上更好：命中区从 8px 变成整张卡片。
				title: hasWindows ? switchHint : undefined,
				onClick: fallbackToggle,
				onKeyDown: (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						fallbackToggle();
					}
				},
			},
				// 余额形态画金额行；订阅形态画多窗口行（同一张卡片，不拆成多张）。
				usageRows.length > 0 ? usageGrid : balanceRow,
				// 区间指示灯：**已按用户要求去掉**（栏尾的圆圈与小点都不要）。
				// 峰谷信息仍在悬浮说明里（switchHint），不靠这个颜色点表达。
				// 单价行：当前档单价，绝对定位在卡片右下角。价格表里没有的模型
				// （known=false）整行不渲染——表外数字与它们的实际账单无关。
				// 订阅制不按 token 计价，即使命中了价格表也不显示单价行。
				// 绝对定位不参与卡片高度计算：金额行因此能在卡片里竖直居中，
				// 底部也不会空出比顶部更多的一截。
				// 用 flex-end 而不是 space-between：容器只有一个子元素时 space-between 会把它
				// 推到最左侧（0.6.0 的回归点）。
				priced && usageRows.length === 0 && h("span", {
					style: {
						position: "absolute",
						right: 9,
						bottom: 4,
						display: "flex",
						alignItems: "center",
						justifyContent: "flex-end",
						gap: 6,
						minWidth: 0,
					},
					title: priceTooltip(),
				},
					h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5, flex: "none" } },
						Price(h(IconIn, null), tier.input),
						Price(h(IconCache, null), tier.cacheRead),
						Price(h(IconOut, null), tier.output))),
				// 收缩态的展开入口（见上面 expandToggle 的注释）。
				expandToggle,
				fallbackRefresh);

			// ---- 一张卡，两种状态：收缩看当前，展开看三类 ----
			//
			// 用户口径（原话）：「收缩的时候只显示当前的，展开的时候显示三大类所有的，
			// 不管当前是订阅型还是 ds 还是积分。」
			//
			// 所以这里不是"两张卡叠加"，而是**同一张卡的两种形态**：
			//   · 收缩态 → 账户卡：当前这个模型/路由的读数（DeepSeek 官方是金额，
			//     Codex 是订阅仪表盘，免费渠道是它的积分摘要）；
			//   · 展开态 → 三大类卡：这台机器上所有订阅 / 充值 / 积分来源。
			//
			// 历史包袱说明（两次都错在"用 kind 决定给不给看"，一次反向一次正向）：
			//   1. `kind === 'none' && hasCardData` —— 免费渠道才给看三大类，换模型就换界面；
			//   2. 删掉门控后 `if (hasCardData) return 三大类卡` —— 采集数据永远存在，
			//      账户读数被整个吞掉（余额 / 订阅窗口再也不显示）。
			// 现在判据换成**展开态自己**：形态由用户点开/收起决定，与当前模型类型无关。
			//
			// 账户卡的读数判据（决定收缩态有没有东西可显示）：
			//   · 订阅型（usage / oauth）：至少有一个窗口能画仪表盘；
			//   · 余额型：读到了金额。与 money() 对齐——它印成「—」就是没读到
			//     （null / 空串 / 非有限数），不是 0（0 元是真实余额，必须显示）；
			//   · `kind === 'none'`：accountLead 对它恒返回「—」，所以这里必然是假，
			//     收缩态会回落到三大类卡（积分摘要）——正是用户要的"免费渠道看积分"。
			const accountReading = usageRows.length > 0
				|| (kind !== "none" && money(data && data.balance ? data.balance.total : null) !== "—");
			// 收缩态由 `threeKindCard` 自己负责（它已按当前厂商筛好那一行）。
			// 只有当这台机器**一条三类数据都没有**时，才回落到账户卡——那时余额 / 订阅
			// 仪表盘是唯一能说点什么的画法。
			//
			// 注意：不再有"收缩给账户卡、展开给三大类卡"这对互斥分支。以前那样写时，
			// 免费渠道没有账户读数 → 收缩回落到三大类卡 → 与展开态相同 → ▸ 形同虚设。
			if (threeKindCard !== null) return threeKindCard;
			return accountCard;
		}

		// ---- 设置页：会话用量统计 --------------------------------------
		/**
		 * token 数的紧凑显示，按界面语言分两套：
		 *   · 中文：1.2 亿 / 34.5 万 / 987 —— 中文用户读的是「万」「亿」，不是 K/M；
		 *   · 英文：1.2B / 34.5M / 987 —— 英文界面保留英文缩写，这是对的。
		 *
		 * 统计面板要在一屏里排下十几个模型，原始数字（266725731）既占宽又读不出量级。
		 * 只在 >= 1 万（英文 >= 1000）时缩写——小数字缩写反而丢精度。
		 */
		function fmtTokens(n, lang) {
			const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
			// 负数不该出现在 token 数里，但真出现时按绝对值判量级、保留符号。
			const abs = Math.abs(value);
			const sign = value < 0 ? "-" : "";
			if (lang === "zh") {
				if (abs >= 1_0000_0000) return sign + trimZero((abs / 1_0000_0000).toFixed(1)) + " 亿";
				if (abs >= 1_0000) return sign + trimZero((abs / 1_0000).toFixed(1)) + " 万";
				return sign + String(Math.round(abs));
			}
			if (abs >= 1_000_000_000) return sign + trimZero((abs / 1_000_000_000).toFixed(1)) + "B";
			if (abs >= 1_000_000) return sign + trimZero((abs / 1_000_000).toFixed(1)) + "M";
			if (abs >= 1_000) return sign + trimZero((abs / 1_000).toFixed(1)) + "K";
			return sign + String(Math.round(abs));
		}

		/**
		 * 词典里带 `{n}` 占位的文案：把占位换成一个数字。
		 *
		 * DSH 的 locale 服务只接受字符串词典（`t(key)` 直接返回字符串），所以不能用
		 * 函数式词条；带参数的文案一律写成 `{n}` 模板，在调用点填充。
		 */
		function fillN(template, n) {
			const text = typeof template === "string" ? template : String(template ?? "");
			return text.replace(/\{n\}/g, String(n));
		}

		/**
		 * 多占位文案的填充：`{remaining}` / `{total}` 这类具名占位。
		 *
		 * 与 fillN 分开的理由：一条文案里出现两个数字时（`剩余 $12.5，共 $20`），
		 * 用 `{n}` 会逼着调用点自己拼字符串——拼出来的半句在不同语言里语序不同，
		 * 那就不是"翻译"了。具名占位让整句留在词典里。
		 * 缺值一律填「—」：绝不留下 `{total}` 这种原文给用户看见。
		 */
		function fillVars(template, vars) {
			const text = typeof template === "string" ? template : String(template ?? "");
			return text.replace(/\{(\w+)\}/g, (whole, name) => {
				const value = vars !== null && typeof vars === "object" ? vars[name] : undefined;
				return value === undefined || value === null ? "—" : String(value);
			});
		}

		/**
		 * 金额 / 单价的显示文案。
		 *
		 * 判定顺序（先看 form，再看 currency）：后端已经把"这条 渠道×模型 是怎么计价的"
		 * 算成一个 `form`，界面不该再用币种反推形态——`currency` 只说单位，说不了
		 * "渠道只给了一个价""这条免费"这两件事：
		 *   · `form: 'free'`（currency 也是 'free'）= 价格表里写明免费 → 「免费」。
		 *     既不是 ¥0.00（那是"花了 0 元"），也不是「按积分计费」（免费不需要积分）。
		 *   · `form: 'uniform'` = 渠道只给一个数字 → 照常显示金额，但必须让用户知道
		 *     "这个数不分输入输出"（悬浮说明给 stats.cost.singlePrice）。
		 *   · `form: 'split'` = 输入/输出两档 → 现有逻辑，`¥0.4948` 之类。
		 *   · `currency: 'credit'` = 新表旧表都查不到，且这家不按钱算（积分/订阅）→
		 *     「按积分计费」。这是**唯一**还会出现这句话的情形。
		 *   · `currency: 'unknown'` = 按钱算但查不到这个模型的价 → 「暂无定价」；
		 *     若这条本来就 priced:false（渠道没给价）→ 「该渠道未提供价格」。
		 *
		 * 三条铁律不变：
		 *   · `cost` 为 null = 算不出来，显示「—」或说明原因，**绝不显示 ¥0.00**。
		 *   · `amounts.total` 不是有限数（后端给了 amounts 但字段缺）= 算不出来，同样「—」。
		 */
		function moneyText(cost, t) {
			if (cost === undefined || cost === null) return "—";
			const currency = typeof cost.currency === "string" ? cost.currency : "";
			const form = typeof cost.form === "string" ? cost.form : "";
			if (currency === "free" || form === "free") return t("stats.cost.free");
			if (currency === "credit") return t("stats.cost.credit");
			if (currency === "unknown") {
				return cost.priced === false ? t("stats.cost.noPrice") : t("stats.cost.unpriced");
			}
			if (currency === "mixed") return t("stats.cost.mixed");
			const amounts = cost.amounts ?? cost.cost;
			if (amounts === null || amounts === undefined) return t("stats.cost.unpriced");
			const total = amounts.total;
			if (typeof total !== "number" || !Number.isFinite(total)) return "—";
			const symbol = currency === "USD" ? "$" : "¥";
			// 金额可能很小（0.0001），按量级决定小数位：别把 0.49 显示成 0.4948。
			const digits = total !== 0 && Math.abs(total) < 1 ? 4 : 2;
			return symbol + total.toFixed(digits);
		}

		/**
		 * 金额单元格的悬浮说明：补上「为什么是这一个数」。
		 *
		 * 三件事只在悬浮层说，不占正文列宽：
		 *   · 单一价渠道——这个数不分输入输出（否则用户会拿它和别家的输入/输出价对比）；
		 *   · 促销——原价与现价（只给现价会让用户以为表里就这个价，续费时对不上账）；
		 *   · 跨渠道镜像——这个价其实来自哪家的官方条目。
		 * 没有可说的就返回空串，渲染层据此不挂 title（空 title 会弹一个空提示框）。
		 */
		function costHint(cost, t) {
			if (cost === undefined || cost === null) return "";
			const form = typeof cost.form === "string" ? cost.form : "";
			const notes = [];
			if (form === "uniform") notes.push(t("stats.cost.singlePrice"));
			const promotion = cost.promotion;
			if (promotion !== null && typeof promotion === "object") {
				const fmt = (value) => (typeof value === "number" && Number.isFinite(value) ? fmtPrice(value) : null);
				const original = fmt(promotion.original);
				const current = fmt(promotion.current);
				if (original !== null || current !== null) {
					notes.push(fillVars(t("stats.promo"), { original, current }));
				}
			}
			const mirrors = typeof cost.mirrors === "string" && cost.mirrors !== "" ? cost.mirrors : "";
			if (mirrors !== "") notes.push(fillN(t("stats.mirror"), mirrors));
			return notes.join(" · ");
		}

		/**
		 * 把 costHint 的空串转成 `undefined`。
		 *
		 * 渲染层要的是"没话说就别挂 title"：空字符串会让浏览器弹出一个只有边框的
		 * 空提示框，看起来像功能坏了。这个转换放在这里，调用点就不用各写一遍三元式。
		 */
		function hintOf(cost, t) {
			const text = costHint(cost, t);
			return text === "" ? undefined : text;
		}

		/**
		 * 跨币种的分行金额：`¥0.49 · $0.02`。混币种**绝不相加**——CNY + USD 没有意义，
		 * 相加得到的数字既不对应任何账单，也没法换算（汇率是另一份数据，本插件不采）。
		 * 每个币种各自成形，中间用 ` · ` 分隔；给不出任何币种时退回「—」。
		 */
		function mixedMoneyText(cost) {
			const byCurrency = cost && typeof cost === "object" ? cost.byCurrency : null;
			if (byCurrency === null || byCurrency === undefined || typeof byCurrency !== "object") return "—";
			const parts = [];
			for (const code of Object.keys(byCurrency)) {
				const bucket = byCurrency[code];
				const total = bucket && typeof bucket.total === "number" && Number.isFinite(bucket.total) ? bucket.total : null;
				if (total === null) continue;
				const symbol = code === "USD" ? "$" : (code === "CNY" ? "¥" : code + " ");
				const digits = total !== 0 && Math.abs(total) < 1 ? 4 : 2;
				parts.push(symbol + total.toFixed(digits));
			}
			return parts.length === 0 ? "—" : parts.join(" · ");
		}

		/**
		 * 工作区行的金额：直接读后端给的 `workspace.cost`。
		 *
		 * 为什么不在界面上自己遍历 kinds 累加：跨币种、积分型、无定价这三类判定
		 * 后端（`aggregateWorkspaceCost`）已经做过一遍，界面再实现一遍必然漂移，
		 * 出现"类型合计说按积分计费、工作区合计说 ¥0.00"这种自相矛盾。
		 */
		function workspaceCostText(cost, t) {
			if (cost === undefined || cost === null) return "—";
			const currency = typeof cost.currency === "string" ? cost.currency : "";
			if (currency === "mixed") return mixedMoneyText(cost);
			return moneyText(cost, t);
		}

		/**
		 * 单价行的文案：每百万 token 的价。
		 *
		 * 这句文案现在会**上正文**（此前只挂在模型名的 title 上，用户看不到），
		 * 所以两件事都要顾到：单位（每百万 token）与币种符号，缺一个数字就没意义。
		 *
		 * 两种形态两套句式：
		 *   · split（输入/输出两档）→「每百万 token：输入 X / 输出 Y」；
		 *   · uniform（渠道只给一个数字）→「每百万 token：X（单一价）」。
		 *     写成两档句式会逼着把同一个数字填两遍，读起来像"输入输出同价"，
		 *     而单一价的真实含义是"渠道根本不分输入输出"。
		 * 积分型 / 免费 / 无定价 / 混币种一律返回空串——单价表里没有它们，画出来是编的。
		 */
		function priceText(cost, t) {
			if (cost === undefined || cost === null) return "";
			const prices = cost.prices;
			if (prices === null || prices === undefined) return "";
			const currency = typeof cost.currency === "string" ? cost.currency : "";
			const form = typeof cost.form === "string" ? cost.form : "";
			if (currency === "credit" || currency === "unknown" || currency === "mixed" || currency === "free") return "";
			if (form === "free") return "";
			const symbol = currency === "USD" ? "$" : "¥";
			// 单价常常很小（缓存读 0.04），用 fmtPrice 去掉尾零而不是固定两位，
			// 0.02 与 0.024 是两条不同的价，不能被四舍五入抹平。
			const fmt = (value) => (typeof value === "number" && Number.isFinite(value) ? symbol + fmtPrice(value) : "—");
			if (form === "uniform") {
				return t("stats.priceLineUniform").replace("{price}", fmt(prices.uniform));
			}
			return t("stats.priceLine")
				.replace("{input}", fmt(prices.input))
				.replace("{output}", fmt(prices.output));
		}

		/** 统计面板里的一张表：类型标题 + 说明 + 厂商/模型行。 */
		function UsageKindBlock(props) {
			const t = props.t;
			const lang = props.lang === "en" ? "en" : "zh";
			const kind = props.kind;
			const cellStyle = {
				padding: "3px 6px",
				fontSize: 12,
				lineHeight: "16px",
				textAlign: "right",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
			};
			const headStyle = {
				...cellStyle,
				fontWeight: 500,
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const rows = [];
			for (const provider of kind.providers) {
				rows.push(h("tr", {
					key: "p:" + provider.provider,
					style: { background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))" },
				},
					h("td", { style: { ...cellStyle, textAlign: "left", fontWeight: 500 } },
						provider.provider + (provider.classified ? "" : " · " + t("stats.kind.unknown"))),
					h("td", { style: cellStyle }, String(provider.messages)),
					h("td", { style: cellStyle }, fmtTokens(provider.inputTokens, lang)),
					h("td", { style: cellStyle }, fmtTokens(provider.outputTokens, lang)),
					h("td", { style: cellStyle }, fmtTokens(provider.cacheReadTokens, lang)),
					h("td", { style: { ...cellStyle, fontWeight: 500 } }, fmtTokens(provider.totalTokens, lang)),
					// 金额列的悬浮说明：单一价 / 促销 / 镜像价的背景信息（见 costHint）。
					h("td", {
						style: { ...cellStyle, fontWeight: 500 },
						title: hintOf(provider.cost, t),
					}, moneyText(provider.cost, t)),
				));
				for (const model of provider.models) {
					// 单价：**正文可见**，不再只藏在模型名的 title 里（用户看不到悬浮说明
					// 就等于没有单价）。模型名下面一行小字给出「每百万 token：输入 X / 输出 Y」，
					// 悬浮说明保留同一句，鼠标停在数字上也能读到。
					const priceLine = priceText(model.cost, t);
					rows.push(h("tr", { key: "m:" + provider.provider + ":" + model.model },
						h("td", {
							style: {
								...cellStyle,
								textAlign: "left",
								paddingLeft: 18,
								color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
								whiteSpace: "normal",
							},
						},
							h("div", null, model.model),
							priceLine === ""
								? null
								: h("div", {
									style: {
										fontSize: 11,
										lineHeight: "15px",
										fontWeight: 400,
										color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
										fontVariantNumeric: "tabular-nums",
									},
								}, priceLine),
						),
						h("td", { style: cellStyle }, String(model.messages)),
						h("td", { style: cellStyle }, fmtTokens(model.inputTokens, lang)),
						h("td", { style: cellStyle }, fmtTokens(model.outputTokens, lang)),
						h("td", { style: cellStyle }, fmtTokens(model.cacheReadTokens, lang)),
						h("td", { style: cellStyle }, fmtTokens(model.totalTokens, lang)),
						// 金额列：能算就是 `¥0.4948`；单一价渠道照常给金额但悬浮说明标注
						// 「该渠道只提供单一价」；免费是「免费」；积分型是「按积分计费」；
						// 算不出是「—」。全部由 moneyText 决定，**永远不会出现 ¥0.00**。
						h("td", {
							style: cellStyle,
							title: hintOf(model.cost, t),
						}, moneyText(model.cost, t)),
					));
				}
			}
			// 类型合计行：这一类的总花费（可能跨币种，那时给的是各币种小计）。
			const totalCost = kind.cost;
			// 价格快照日期：价格是手动采集的，不标日期用户无法判断该不该信。
			// 它现在跟在类型标题这一行里（规格要求「显示在类型标题旁」），
			// 不再单独占一行——一屏里三个类型各多一行会把表格挤散。
			const asOf = totalCost !== undefined && totalCost !== null && typeof totalCost.asOf === "string" && totalCost.asOf !== ""
				? totalCost.asOf
				: "";
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
				h("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
					h("h4", { style: { margin: 0, fontSize: 13, fontWeight: 600, lineHeight: "20px" } },
						t("stats.kind." + kind.kind)),
					asOf === ""
						? null
						: h("span", {
							style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" },
						}, t("stats.cost.asOf") + " " + asOf),
					h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" } },
						t("stats.kindHint." + kind.kind)),
					h("span", {
						style: {
							marginLeft: "auto",
							fontSize: 12,
							fontVariantNumeric: "tabular-nums",
							color: "var(--dsw-alias-label-secondary, rgba(0,0,0,.55))",
						},
					}, fmtTokens(kind.totalTokens, lang) + " " + t("stats.tokens")
						+ (totalCost !== undefined && totalCost !== null
							? " · " + t("stats.cost.total") + " " + moneyText(totalCost, t)
							: "")),
				),
				h("table", { style: { width: "100%", borderCollapse: "collapse" } },
					h("thead", null, h("tr", null,
						h("th", { style: { ...headStyle, textAlign: "left" } }, t("stats.col.provider")),
						h("th", { style: headStyle }, t("stats.col.messages")),
						h("th", { style: headStyle }, t("stats.col.input")),
						h("th", { style: headStyle }, t("stats.col.output")),
						h("th", { style: headStyle }, t("stats.col.cache")),
						h("th", { style: headStyle }, t("stats.col.total")),
						h("th", { style: headStyle }, t("stats.col.cost")),
					)),
					h("tbody", null, rows),
				),
			);
		}

		// ---- 树形用量统计：三勾选 + 层级表 --------------------------------
		/**
		 * 勾选组合 → 「要取哪几份数据」。
		 *
		 * 三种口径各有各的宿主接口，取数不能只取一份：
		 *   · 整机——缺省请求（`/stats`），回带 `kinds`（可自行累加 token）与 `messages`/`files`；
		 *   · 工作区——`?scope=workspace`，除每个工作区的汇总外**还带 `sessions[]`**；
		 *   · 单会话——`?session=<id>`，只有这一种口径带"会话自己的 kinds"。
		 *
		 * 会话行只从 workspace 口径拿得到（合并成树的前提是"所有会话在同一份响应里"），
		 * 所以「整机 + 会话」也要拉 workspace：它要列出**所有**会话，不只是当前这个。
		 * 反过来，"只勾会话"时直接查单会话 summary——一次请求就够，还多了 kinds。
		 */
		function statsFetchPlan(checks) {
			const machine = !!(checks && checks.machine);
			const workspace = !!(checks && checks.workspace);
			const session = !!(checks && checks.session);
			return {
				machine,
				workspaces: workspace || (session && machine),
				sessionOnly: session && !workspace && !machine,
			};
		}

		/** 工作区列表里，当前会话所属的那个工作区；找不到时返回 null。 */
		function currentWorkspaceOf(workspaces, sessionId) {
			const list = Array.isArray(workspaces) ? workspaces : [];
			const id = typeof sessionId === "string" ? sessionId : "";
			if (id === "") return null;
			for (const ws of list) {
				if (ws === null || typeof ws !== "object") continue;
				const sessions = Array.isArray(ws.sessions) ? ws.sessions : [];
				if (sessions.some((item) => item !== null && typeof item === "object" && item.id === id)) return ws;
			}
			// 工作区汇总里没有 `sessions[]`（旧宿主）时退回 sessionIds 之外的线索：
			// 一台机器只有一个工作区时，那个工作区就是"当前"的。
			return list.length === 1 ? list[0] : null;
		}

		/** 一组计费类型块的 token 合计（逐块 `totalTokens` 相加；缺字段按 0）。 */
		function sumTokensOfKinds(kinds) {
			const list = Array.isArray(kinds) ? kinds : [];
			let total = 0;
			for (const kind of list) {
				if (kind === null || typeof kind !== "object") continue;
				const value = typeof kind.totalTokens === "number" && Number.isFinite(kind.totalTokens) ? kind.totalTokens : 0;
				total += value;
			}
			return total;
		}

		/**
		 * 若干个 `cost` → 一行金额文案（整机合计行没有后端聚合好的 `cost` 字段）。
		 *
		 * 为什么这里可以自己合一次、而工作区行必须读后端的 `workspace.cost`：
		 * 后端给工作区的那一份是 `aggregateWorkspaceCost` 的结果，界面必须照用；
		 * 而**整机**这一行的响应里根本没有聚合好的金额（只有每个 kind 各自的 cost），
		 * 要么显示「—」，要么按同一口径合成。选后者，但**只做金额文案这一层**：
		 * 不重新判定"这是积分型还是免费"，直接复用 `moneyText` / `mixedMoneyText`
		 * 这两个已有出口，跨币种绝不相加（`mixedMoneyText` 的既有语义）。
		 */
		function mergeCostText(costs, t) {
			const list = Array.isArray(costs) ? costs : [];
			const byCurrency = {};
			let codes = [];
			let credit = 0;
			let free = 0;
			let unknown = 0;
			for (const cost of list) {
				if (cost === null || cost === undefined || typeof cost !== "object") continue;
				const currency = typeof cost.currency === "string" ? cost.currency : "";
				if (currency === "free" || cost.form === "free") { free += 1; continue; }
				if (currency === "credit") { credit += 1; continue; }
				const amounts = cost.amounts !== undefined && cost.amounts !== null ? cost.amounts : cost.cost;
				const total = amounts !== null && amounts !== undefined
					&& typeof amounts.total === "number" && Number.isFinite(amounts.total)
					? amounts.total
					: null;
				if (total === null || currency === "" || currency === "unknown") { unknown += 1; continue; }
				if (byCurrency[currency] === undefined) {
					byCurrency[currency] = { total: 0 };
					codes.push(currency);
				}
				byCurrency[currency].total += total;
			}
			if (codes.length === 1) return moneyText({ currency: codes[0], amounts: byCurrency[codes[0]] }, t);
			if (codes.length > 1) return mixedMoneyText({ byCurrency });
			if (unknown > 0) return t("stats.cost.unpriced");
			if (credit > 0) return t("stats.cost.credit");
			if (free > 0) return t("stats.cost.free");
			return "—";
		}

		/**
		 * 勾选组合 + 三份数据 → 树形节点列表（**纯函数**，直接断言层级用）。
		 *
		 * 八种组合的精确语义（用户逐字给的三条推导，落成这张表）：
		 *   | 仅整机            | 1 级 | 整机合计一行                                  |
		 *   | 仅工作区          | 1 级 | 当前工作区合计一行                            |
		 *   | 仅会话            | 1 级 | 当前会话合计一行                              |
		 *   | 整机+工作区       | 2 级 | 整机 → 每个工作区                            |
		 *   | 工作区+会话       | 2 级 | 当前工作区 → 它的每个会话                    |
		 *   | 整机+会话         | 2 级 | 整机 → 所有会话（跨工作区**平铺**，不分组） |
		 *   | 全选              | 3 级 | 整机 → 每个工作区 → 每个工作区的每个会话    |
		 *   | 空选              | —   | 不渲染树，只提示"请至少勾选一项"             |
		 *
		 * 每一行都是同一组列（会话数 / 消息 / 令牌 / 金额），`depth` 决定缩进，
		 * 所以"三级"就是缩进深度的差别，不是三张表——一张表才不会在三份数据
		 * 之间来回跳行距。
		 *
		 * @returns {Array<{depth:number, role:string, key:string, label:string,
		 *   badges:string[], sessions:number|null, messages:number|null,
		 *   tokens:number|null, costText:string}>}
		 */
		function statsTreeNodes(options) {
			const opts = options !== null && typeof options === "object" ? options : {};
			const checks = opts.checks !== null && typeof opts.checks === "object" ? opts.checks : {};
			const t = typeof opts.t === "function" ? opts.t : ((key) => key);
			const lang = opts.lang === "en" ? "en" : "zh";
			const sessionId = typeof opts.sessionId === "string" ? opts.sessionId : "";
			const machine = opts.machine !== null && typeof opts.machine === "object" ? opts.machine : null;
			const workspaces = Array.isArray(opts.workspaces) ? opts.workspaces : null;
			const session = opts.session !== null && typeof opts.session === "object" ? opts.session : null;
			const nodes = [];

			const wantMachine = !!checks.machine;
			const wantWorkspace = !!checks.workspace;
			const wantSession = !!checks.session;
			const current = workspaces === null ? null : currentWorkspaceOf(workspaces, sessionId);
			// 只有一个工作区时，"当前工作区"必然就是它（currentWorkspaceOf 已兜住）。

			const workspaceNode = (ws, depth) => {
				const totals = ws !== null && ws.totals !== null && typeof ws.totals === "object" ? ws.totals : null;
				const tokens = totals !== null && typeof totals.totalTokens === "number" && Number.isFinite(totals.totalTokens)
					? totals.totalTokens
					: sumTokensOfKinds(ws && ws.kinds);
				const archived = ws && Array.isArray(ws.archivedSessions) ? ws.archivedSessions.length : 0;
				const title = ws && typeof ws.title === "string" && ws.title !== "" ? ws.title : String(ws && ws.id !== undefined ? ws.id : "");
				return {
					depth,
					role: "workspace",
					key: "ws:" + String(ws && ws.id !== undefined ? ws.id : title),
					label: title,
					badges: archived > 0 ? [fillN(t("stats.workspace.archived"), archived)] : [],
					sessions: ws && typeof ws.sessionCount === "number" ? ws.sessionCount : null,
					messages: ws && typeof ws.messages === "number" ? ws.messages : null,
					tokens,
					costText: workspaceCostText(ws && ws.cost, t),
				};
			};

			const sessionNode = (item, depth) => {
				const totals = item !== null && item.totals !== null && typeof item.totals === "object" ? item.totals : null;
				const tokens = totals !== null && typeof totals.totalTokens === "number" && Number.isFinite(totals.totalTokens)
					? totals.totalTokens
					: null;
				const badges = [];
				if (item && item.archived === true) badges.push(t("stats.tree.archived"));
				if (item && item.ok === false) badges.push(t("stats.tree.failed"));
				if (item && typeof item.duplicateOf === "string" && item.duplicateOf !== "") badges.push(t("stats.tree.duplicate"));
				return {
					depth,
					role: "session",
					key: "se:" + String(item && item.id !== undefined ? item.id : ""),
					label: String(item && item.id !== undefined ? item.id : ""),
					badges,
					// 会话行没有"会话数"（叶子），空着比填 1 更少噪音。
					sessions: null,
					messages: item && typeof item.messages === "number" ? item.messages : null,
					tokens,
					// 会话级没有 kinds，算不出金额——**不编**，给「—」。
					costText: "—",
				};
			};

			const machineNode = () => {
				const kinds = machine && Array.isArray(machine.kinds) ? machine.kinds : [];
				// 会话数只在拉到 workspace 口径时才知道（整口径响应里没有会话计数）。
				let sessionCount = null;
				if (workspaces !== null) {
					sessionCount = 0;
					for (const ws of workspaces) {
						if (ws !== null && typeof ws === "object" && typeof ws.sessionCount === "number") sessionCount += ws.sessionCount;
					}
				}
				return {
					depth: 0,
					role: "machine",
					key: "machine",
					label: t("stats.tree.machine"),
					badges: [],
					sessions: sessionCount,
					messages: machine && typeof machine.messages === "number" ? machine.messages : null,
					tokens: sumTokensOfKinds(kinds),
					costText: mergeCostText(kinds.map((kind) => (kind !== null && typeof kind === "object" ? kind.cost : null)), t),
				};
			};

			// 1) 整机一行：只要勾了就有（是根，也可能是唯一一行）。
			if (wantMachine && machine !== null) nodes.push(machineNode());

			// 2) 工作区层与会话层必须**一起**装配：全选是"整机 → 每个工作区 → 它自己的
			// 会话"，如果先把所有工作区压进去再压会话，三级就变成了"工作区们 + 会话们"，
			// 归属关系（哪个会话属于哪个工作区）在缩进上完全看不出来。
			if (wantWorkspace && wantMachine) {
				// 整机 + 工作区（+ 会话）：整机下面列**每个**工作区；勾了会话就挂在各自工作区下。
				for (const ws of workspaces === null ? [] : workspaces) {
					if (ws === null || typeof ws !== "object") continue;
					nodes.push(workspaceNode(ws, 1));
					if (!wantSession) continue;
					const list = Array.isArray(ws.sessions) ? ws.sessions : [];
					for (const item of list) {
						if (item !== null && typeof item === "object") nodes.push(sessionNode(item, 2));
					}
				}
			} else if (wantWorkspace) {
				// 只勾（或"工作区 + 会话"）：根就是当前工作区，会话紧挂在它下面。
				if (current !== null) {
					nodes.push(workspaceNode(current, 0));
					if (wantSession) {
						const list = Array.isArray(current.sessions) ? current.sessions : [];
						for (const item of list) {
							if (item !== null && typeof item === "object") nodes.push(sessionNode(item, 1));
						}
					}
				}
			} else if (wantSession) {
				if (wantMachine) {
					// 整机 + 会话：**不按工作区分组**，跨工作区平铺（同 id 只出现一次）。
					// 取数走 workspace 口径，所以拿到的是**所有**会话，不只是当前这个。
					const seen = new Set();
					const list = workspaces === null ? [] : workspaces;
					for (const ws of list) {
						if (ws === null || typeof ws !== "object") continue;
						const sessions = Array.isArray(ws.sessions) ? ws.sessions : [];
						for (const item of sessions) {
							if (item === null || typeof item !== "object") continue;
							const id = typeof item.id === "string" ? item.id : "";
							if (id !== "" && seen.has(id)) continue;
							if (id !== "") seen.add(id);
							nodes.push(sessionNode(item, 1));
						}
					}
				} else if (session !== null) {
					// 只勾会话：单会话 summary（`?session=`），一行。
					const kinds = Array.isArray(session.kinds) ? session.kinds : [];
					nodes.push({
						depth: 0,
						role: "session",
						key: "session:current",
						label: t("stats.scope.session"),
						badges: [],
						sessions: null,
						messages: typeof session.messages === "number" ? session.messages : null,
						tokens: sumTokensOfKinds(kinds),
						costText: mergeCostText(kinds.map((kind) => (kind !== null && typeof kind === "object" ? kind.cost : null)), t),
					});
				}
			}

			return nodes;
		}

		/**
		 * 树形统计表：一张表，行按 `depth` 缩进。
		 *
		 * 为什么不用嵌套的 ul/li：三级里每一级都要对齐同一组数字列（会话/消息/令牌/金额），
		 * 嵌套列表每层都会重新算列宽，三级下来数字对不齐，读者只能一行行猜哪个数属于谁。
		 */
		function StatsTreeTable(props) {
			const t = props.t;
			const lang = props.lang === "en" ? "en" : "zh";
			const nodes = Array.isArray(props.nodes) ? props.nodes : [];
			const cellStyle = {
				padding: "3px 6px",
				fontSize: 12,
				lineHeight: "16px",
				textAlign: "right",
				fontVariantNumeric: "tabular-nums",
				whiteSpace: "nowrap",
			};
			const headStyle = {
				...cellStyle,
				fontWeight: 500,
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const tertiary = { color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))", fontWeight: 400, fontSize: 11 };
			const rows = nodes.map((node) => {
				const depth = typeof node.depth === "number" ? node.depth : 0;
				const badges = Array.isArray(node.badges) ? node.badges : [];
				return h("tr", { key: node.key, "aria-level": depth + 1, role: "row" },
					h("td", {
						style: {
							...cellStyle,
							textAlign: "left",
							whiteSpace: "normal",
							// 缩进用 padding，不用空格——空格会被 white-space 规则吃掉。
							paddingLeft: 6 + depth * 14,
							fontWeight: depth === 0 ? 600 : 500,
						},
					},
						node.label,
						badges.map((badge, index) => h("span", {
							key: "b" + index,
							style: { marginLeft: 6, ...tertiary },
						}, badge)),
					),
					h("td", { style: cellStyle }, node.sessions === null || node.sessions === undefined ? "—" : String(node.sessions)),
					h("td", { style: cellStyle }, node.messages === null || node.messages === undefined ? "—" : String(node.messages)),
					h("td", { style: { ...cellStyle, fontWeight: depth === 0 ? 600 : 500 } },
						node.tokens === null || node.tokens === undefined ? "—" : fmtTokens(node.tokens, lang)),
					h("td", { style: { ...cellStyle, fontWeight: depth === 0 ? 600 : 500 } },
						typeof node.costText === "string" && node.costText !== "" ? node.costText : "—"),
				);
			});
			return h("table", { style: { width: "100%", borderCollapse: "collapse" } },
				h("thead", null, h("tr", null,
					h("th", { style: { ...headStyle, textAlign: "left" } }, t("stats.col.scope")),
					h("th", { style: headStyle }, t("stats.col.sessions")),
					h("th", { style: headStyle }, t("stats.col.messages")),
					h("th", { style: headStyle }, t("stats.col.total")),
					h("th", { style: headStyle }, t("stats.col.cost")),
				)),
				h("tbody", null, rows),
			);
		}

		/**
		 * 用量统计面板：三勾选（整机 / 工作区 / 会话）决定**层级**，树形表显示合计。
		 *
		 * 迁移记录：这块原先在**配置页**（`UsageConfigSection`）里，用户要求搬到
		 * **用量页**，并把口径按钮换成三勾选 + 树形。所以本组件不再有 `scope` 入参，
		 * 也不再有"全机/按工作区"两个按钮——层级由勾选组合推导（见 statsTreeNodes）。
		 *
		 * 空选（三个都不勾）：不渲染树、不发请求、**不**静默退回全机——退回全机正是
		 * 用户担心的"我什么都没选，它自己给我看个全机的数"。只显示一句提示。
		 *
		 * 每一格的取数见 statsFetchPlan：勾选变化会重新取数（`load` 的依赖里带着
		 * 三个 plan 布尔与 sessionId），宿主侧按文件 mtime 缓存，反复切换不重解压日志。
		 */
		function UsageStatsSection(props) {
			const t = props.t;
			const lang = props.lang === "en" ? "en" : "zh";
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			// 默认：会话内视图 → 只看本次会话（与迁移前的行为一致，用户打开这个 Tab
			// 问的是"这次对话花了多少"）。拿不到 sessionId 时退回整机。
			//
			// 有本地偏好时**以偏好为准**（用户上次勾了哪些就看哪些）：统计页反复打开，
			// 每次都把选择重置回默认值等于永远记不住用户想看什么。
			const [checks, setChecks] = useState(() => {
				const remembered = readStatsPrefs(sessionId);
				if (remembered !== null) return remembered;
				return {
					machine: sessionId === "",
					workspace: false,
					session: sessionId !== "",
				};
			});
			const [state, setState] = useState({ status: "loading", data: null });
			// 「重新统计」自己的状态：idle / busy / failed。它与 state.status 分开，
			// 因为重算期间旧数据仍然有效（继续显示），不该把整页打回 loading。
			const [recalcState, setRecalcState] = useState("idle");
			const mountedRef = useRef(true);

			useEffect(() => () => { mountedRef.current = false; }, []);

			const plan = statsFetchPlan(checks);
			const anyChecked = !!(checks.machine || checks.workspace || checks.session);

			// 「重新统计」：主动让后台扫一遍日志并**改写缓存**（POST），再读回新结果。
			//
			// 与「刷新」的分工（用户口径）：
			//   · 刷新     —— GET，只读缓存；打开页面本来就是这么读的；
			//   · 重新统计 —— POST，真的重算；会等几秒，失败要能重试。
			// 两个按钮都在，别合并：只留「刷新」时用户点它数字不变（本来就只读缓存），
			// 会以为按钮坏了；只留「重新统计」时每次打开或者切勾选都在重算。
			const load = useCallback(async () => {
				if (!anyChecked) {
					setState({ status: "ready", data: { machine: null, workspaces: null, session: null } });
					return;
				}
				setState((prev) => ({ status: prev.data === null ? "loading" : "refreshing", data: prev.data }));
				const jobs = [];
				if (plan.machine) jobs.push(["machine", STATS_PATH]);
				if (plan.workspaces) jobs.push(["workspaces", STATS_PATH + "?scope=workspace"]);
				if (plan.sessionOnly) jobs.push(["session", STATS_PATH + "?session=" + encodeURIComponent(sessionId)]);
				try {
					const results = await Promise.all(jobs.map(async (job) => {
						const res = await fetch(job[1], { cache: "no-store" });
						let body = null;
						try { body = await res.json(); } catch (e) { body = null; }
						const ok = res.ok && body !== null && body !== undefined && body.ok === true;
						return { slot: job[0], body: ok ? body : null, ok };
					}));
					if (!mountedRef.current) return;
					const data = { machine: null, workspaces: null, session: null };
					let failed = false;
					for (const row of results) {
						if (!row.ok) { failed = true; continue; }
						// workspace 口径的响应是 `{ok, scope, workspaces:[...]}`：这里存**数组**，
						// 与上面三个入参的形状（machine/session 是整份 summary）不同——存整份会让
						// 下游 `Array.isArray(data.workspaces)` 判成 null，树只剩整机那一行。
						if (row.slot === "workspaces") {
							data.workspaces = Array.isArray(row.body.workspaces) ? row.body.workspaces : [];
							continue;
						}
						data[row.slot] = row.body;
					}
					setState({ status: failed ? "failed" : "ready", data });
				} catch (e) {
					if (mountedRef.current) setState({ status: "failed", data: null });
				}
			}, [anyChecked, plan.machine, plan.workspaces, plan.sessionOnly, sessionId]);

			useEffect(() => { load().catch(() => {}); }, [load]);

			/**
			 * 「重新统计」：让后台真扫一遍会话日志并**改写缓存**（POST），再读回新结果。
			 *
			 * 与「刷新」必须分开（用户口径）：刷新是 GET，只读缓存——打开页面本来就是
			 * 这么读的。只留刷新时用户点它数字不变（本来就只读缓存），会以为按钮坏了；
			 * 只留重新统计时，每次打开/切勾选都在重算，把后台预计算的意义又抹掉了。
			 *
			 * 失败与忙碌都是**自己的一份状态**：重算期间旧数字仍然有效，继续显示，
			 * 不把整页打回 loading。
			 */
			const recalc = useCallback(async () => {
				if (!anyChecked) return;
				setRecalcState("busy");
				try {
					const res = await fetch(STATS_PATH, {
						method: "POST",
						cache: "no-store",
						headers: { "content-type": "application/json" },
						body: "{}",
					});
					let body = null;
					try { body = await res.json(); } catch (e) { body = null; }
					if (!mountedRef.current) return;
					if (!res.ok || body === null || body.ok !== true) {
						setRecalcState("failed");
						return;
					}
					setRecalcState("idle");
					// 重算完成后再走一次普通读取，让界面拿到新缓存（复用同一条解析路径，
					// 不在这里另写一份响应解读）。
					await load();
				} catch (e) {
					if (mountedRef.current) setRecalcState("failed");
				}
			}, [anyChecked, load]);

			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 26,
				padding: "0 10px",
				cursor: "pointer",
			};
			const checkStyle = {
				display: "inline-flex",
				alignItems: "center",
				gap: 4,
				fontSize: 12,
				lineHeight: "18px",
				cursor: "pointer",
				userSelect: "none",
			};
			const switching = state.status === "loading" || state.status === "refreshing";
			const data = state.data;
			const machine = data === null ? null : data.machine;
			const workspaces = data === null || !Array.isArray(data.workspaces) ? null : data.workspaces;
			const session = data === null ? null : data.session;
			const nodes = anyChecked
				? statsTreeNodes({ checks, machine, workspaces, session, sessionId, t, lang })
				: [];

			// 标题：单级选择沿用原来的两句话（「本次会话用量」/「会话用量统计」），
			// 多级选择用中性的「用量统计」——它同时跨整机、工作区、会话，叫"会话用量"
			// 会让人以为只有会话那一层。
			const singleLevel = (checks.machine ? 1 : 0) + (checks.workspace ? 1 : 0) + (checks.session ? 1 : 0) === 1;
			const titleKey = singleLevel && checks.session
				? "stats.titleSession"
				: (singleLevel && checks.workspace ? "stats.workspace.title" : "stats.title");
			const introKey = singleLevel && checks.session
				? "stats.introSession"
				: (singleLevel && checks.workspace ? "stats.workspace.intro" : "stats.intro");

			// 单级选择时把「计费类型 → 厂商 → 模型」明细留在下面——那是这块面板原来的
			// 主要内容，改成树形后没有理由把它丢掉（树只回答"哪个范围花了多少"）。
			const detailKinds = singleLevel
				? (checks.machine
					? (machine && Array.isArray(machine.kinds) ? machine.kinds : [])
					: (checks.workspace
						? (() => {
							const current = workspaces === null ? null : currentWorkspaceOf(workspaces, sessionId);
							return current && Array.isArray(current.kinds) ? current.kinds : [];
						})()
						: (session && Array.isArray(session.kinds) ? session.kinds : [])))
				: [];
			const scopeSummary = singleLevel && (checks.machine || checks.session)
				? (() => {
					const body = checks.machine ? machine : session;
					if (body === null || typeof body !== "object") return null;
					const unclassified = Array.isArray(body.unclassified) ? body.unclassified.length : 0;
					return fillN(t("stats.messages"), body.messages) + " · " + fillN(t("stats.files"), body.files ?? 0)
						+ (unclassified > 0 ? " · " + fillN(t("stats.unclassified"), unclassified) : "");
				})()
				: null;

			const toggle = (key) => {
				if (key === "session" && sessionId === "") return;
				setChecks((prev) => {
					const next = { machine: prev.machine, workspace: prev.workspace, session: prev.session };
					next[key] = !prev[key];
					// 勾完立刻记住。放在 setChecks 的更新函数里是**故意**的：它拿到的是
					// 即将生效的最新值，不会因为闭包里的 prev 过期而把旧的组合写回去。
					writeStatsPrefs(next);
					return next;
				});
			};

			const CHECKBOXES = [
				["machine", "stats.pick.machine", false],
				["workspace", "stats.pick.workspace", false],
				["session", "stats.pick.session", sessionId === ""],
			];

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } },
						t(titleKey)),
					// 三勾选：勾哪些层级就长哪几级（语义见 statsTreeNodes 的表）。
					h("div", { style: { display: "flex", gap: 12, marginLeft: 8, flexWrap: "wrap" } },
						CHECKBOXES.map(([key, labelKey, disabled]) => h("label", { key, style: checkStyle },
							h("input", {
								type: "checkbox",
								checked: !!checks[key],
								disabled: disabled,
								onChange: () => toggle(key),
							}),
							h("span", null, t(labelKey)),
						)),
					),
					// 两个动作，别合并成一个（见 recalc 的注释）：
					//   刷新     —— 重读缓存，秒回；
					//   重新统计 —— 真扫日志改写缓存，要等几秒，期间禁用防连点。
					h("button", {
						type: "button",
						style: { ...buttonStyle, marginLeft: "auto" },
						disabled: switching || !anyChecked,
						"aria-label": t("stats.refresh"),
						title: t("stats.refresh"),
						onClick: () => load().catch(() => {}),
					}, t("stats.refresh")),
					h("button", {
						type: "button",
						style: {
							...buttonStyle,
							marginLeft: 6,
							// 忙碌时视觉上也要能看出"它在干活"，否则用户会以为点击没生效
							// 而反复点（虽然已禁用）。
							opacity: recalcState === "busy" ? 0.6 : 1,
							cursor: recalcState === "busy" ? "progress" : "pointer",
						},
						disabled: recalcState === "busy" || !anyChecked,
						"aria-label": recalcState === "busy" ? t("stats.recalcBusy") : t("stats.recalc"),
						title: recalcState === "busy" ? t("stats.recalcBusy") : t("stats.recalc"),
						"aria-busy": recalcState === "busy",
						onClick: () => recalc().catch(() => {}),
					}, recalcState === "busy" ? t("stats.recalcBusy") : t("stats.recalc")),
				),
				h("p", { style: hintStyle }, t(introKey)),
				// 空选：只提示，不取数、不渲染树、更不静默显示全机。
				!anyChecked
					? h("p", { style: hintStyle }, t("stats.tree.pickEmpty"))
					: null,
				state.status === "loading" ? h("p", { style: hintStyle }, t("stats.loading")) : null,
				state.status === "failed" ? h("p", { style: hintStyle }, t("stats.failed")) : null,
				// 重新统计失败要有明确反馈：否则用户点了、数字没变，只会以为按钮坏了。
				recalcState === "failed" ? h("p", { style: hintStyle }, t("stats.recalcFailed")) : null,
				anyChecked && state.status === "ready" && nodes.length === 0
					? h("p", { style: hintStyle }, t(checks.workspace && !checks.machine && !checks.session ? "stats.workspace.empty" : "stats.empty"))
					: null,
				scopeSummary !== null ? h("p", { style: hintStyle }, scopeSummary) : null,
				nodes.length > 0 ? h(StatsTreeTable, { t, lang, nodes }) : null,
				detailKinds.length > 0
					? h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
						detailKinds.map((kind) => h(UsageKindBlock, { key: kind.kind, t, lang, kind })))
					: null,
			);
		}

		// ---- 会话内视图：用量统计 Tab -----------------------------------
		/**
		 * 注册进 `conversation.view` 的会话内视图。
		 *
		 * 原话要的是"**在会话里**统计各个厂商各个模型的用量"，所以主入口必须是会话
		 * 自己的视图 Tab，而不是设置页里的一张表——用户看的是"这次对话花了多少"，
		 * 位置就该在对话里，与 trajectory（轨迹）并列。
		 *
		 * 槽位契约（见 dsh-client-ui-conversation 的 `conversation.session` 子槽位
		 * `conversation.view`，kind=list, scope=session）：注册项用 `id` 决定 Tab 的
		 * 稳定标识，`label` 是 thunk（切换语言后重新求值），渲染组件从 props 拿到
		 * 当前会话 id。
		 */
		const VIEW_ID = "usage-stats";
		const VIEW_ORDER = 20;

		/**
		 * 视图外壳：内容容器 + 「配置」按钮。
		 *
		 * 视图组件的 props 由注册项的 `inject(sessionId)` 提供（`sessionId`），`t`
		 * 来自槽位的 `locale: NS` 注入。样式只用 `--dsw-alias-*` 主题变量，跟随明暗主题。
		 *
		 * 「配置」按钮（用户原话：「用量页添加一个弹到配置页的按钮」）：统计块从配置页
		 * 搬到用量页之后，采集频率还留在配置页，用户在看统计时最想改的就是它，
		 * 所以这里给一个直达入口。跳转沿用现有的设置外壳：
		 * `settingsShellOf(ctx).actions.openSection(SETTINGS_SECTION_ID)`（见 openUsageSettings）。
		 * 外壳不存在（宿主没装设置面板 / 旧宿主）时**不渲染**这个按钮——画一个点了
		 * 没反应的按钮比没有按钮更糟。
		 */
		function UsageView(props) {
			const t = props.t ?? ((k) => textOf(k, currentLang(props.ctx)));
			// 会话内视图只统计当前会话；拿不到 sessionId 时退回整机统计（并在标题里说明）。
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			// 语言要显式传下去：t 只负责取文案，数字量级（万/亿 还是 M/K）得靠它。
			const lang = props.lang ?? currentLang(props.ctx);
			// ctx 从注册处闭包进来；拿不到就当作"没有设置外壳"。
			const ctx = props.ctx;
			const canConfigure = canOpenUsageSettings(ctx);
			const buttonStyle = {
				boxSizing: "border-box",
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				height: 26,
				padding: "0 10px",
				cursor: "pointer",
			};
			return h("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 16,
					padding: "16px 20px",
					minWidth: 0,
					color: "var(--dsw-alias-label-primary)",
				},
			},
				canConfigure
					? h("div", { style: { display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" } },
						h("button", {
							type: "button",
							style: buttonStyle,
							title: t("view.configHint"),
							onClick: () => { openUsageSettings(ctx); },
						}, t("view.config")))
					: null,
				h(UsageStatsSection, { t, lang, sessionId }),
			);
		}

		// ---- 采集频率设置 ------------------------------------------------
		/**
		 * 三类采集频率的设置块。
		 *
		 * 用户的原话是「按积分、充值、订阅集中方式设置采集频率，可调，初始值设置10分钟，
		 * 并写上建议不低于10分钟」。所以这里：
		 *   · 三个输入框，单位分钟（用户想的是"几分钟一次"，不是毫秒）
		 *   · 默认值从宿主回传的 intervalPolicy 读，不在客户端写死
		 *   · 界面上直接写"建议不低于 10 分钟"
		 *   · 低于硬下限（1 分钟）由宿主夹住，界面把"被夹过"显示出来，不让用户以为设置生效了
		 */
		function CollectIntervalSettings(props) {
			const t = props.t;
			const ctx = props.ctx;
			const configForms = ctx === undefined || ctx === null
				? undefined
				: (typeof ctx.get === "function" ? ctx.get("configForms") : ctx.configForms);
			const form = configForms && typeof configForms.get === "function"
				? configForms.get(CONFIG_ENTRY_ID)
				: undefined;

			const fallback = useMemo(() => ({
				subscribe: () => () => {},
				getSnapshot: () => ({ status: "unavailable", value: undefined, revision: 0, writable: false }),
			}), []);
			const store = form === undefined ? fallback : form;
			const subscribe = useCallback((notify) => store.subscribe(notify), [store]);
			const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
			const snapshot = useSyncExternalStore(subscribe, getSnapshot);

			// 宿主回传的策略（默认/下限/建议下限 + 当前生效值 + 是否被夹过）。
			const [policy, setPolicy] = useState(null);
			const mountedRef = useRef(true);
			useEffect(() => () => { mountedRef.current = false; }, []);
			useEffect(() => {
				(async () => {
					try {
						const res = await fetch(SNAPSHOT_PATH, { cache: "no-store" });
						const body = await res.json();
						if (!mountedRef.current) return;
						if (res.ok && body && body.ok === true && body.intervalPolicy) setPolicy(body.intervalPolicy);
					} catch (e) { /* 读不到策略就按默认展示，不影响设置 */ }
				})();
			}, []);

			const value = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
			const intervals = value.collectIntervals && typeof value.collectIntervals === "object" ? value.collectIntervals : {};
			// 毫秒 → 分钟（界面单位）。没配过就显示宿主的默认值。
			const defaultMs = policy ? policy.defaultMs : 10 * 60 * 1000;
			const minutesOf = (kind) => {
				const ms = typeof intervals[kind] === "number" && Number.isFinite(intervals[kind]) ? intervals[kind] : defaultMs;
				return String(Math.round(ms / 60000));
			};

			const hintStyle = {
				margin: 0,
				fontSize: 12,
				lineHeight: "18px",
				color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
			};
			const inputStyle = {
				boxSizing: "border-box",
				width: 80,
				borderRadius: "var(--dsw-radius-md, 6px)",
				border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: 12,
				padding: "4px 8px",
			};

			const KINDS = [
				["credits", "collect.kind.credits"],
				["prepaid", "collect.kind.prepaid"],
				["subscription", "collect.kind.subscription"],
				// 用量统计的后台预计算间隔。它是"第 4 类频率"：与前三条一样按分钟填、
				// 一样被宿主夹到硬下限，所以沿用同一张表与同一段渲染，不另起一套控件。
				// 缺了它，后台按 10 分钟算好的数字就只能按 10 分钟更新，用户无法调。
				["stats", "collect.kind.stats"],
			];

			// 保存：把分钟写回毫秒。低于硬下限的交给宿主夹（这里不重复实现夹取逻辑，
			// 免得两处判断漂移），保存后重新读策略把"被夹过"显示出来。
			const save = useCallback(async (kind, minutesText) => {
				if (form === undefined) return;
				const minutes = Number(minutesText);
				const ms = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60000) : undefined;
				if (ms === undefined) return;
				const nextIntervals = { ...intervals, [kind]: ms };
				try {
					await form.mutate([{ op: "set", path: ["collectIntervals"], value: nextIntervals }], snapshot.revision);
					const res = await fetch(SNAPSHOT_PATH, { cache: "no-store" });
					const body = await res.json();
					if (mountedRef.current && res.ok && body && body.ok === true && body.intervalPolicy) {
						setPolicy(body.intervalPolicy);
					}
				} catch (e) { /* 保存失败保持原值 */ }
			}, [form, intervals, snapshot, setPolicy]);

			if (form === undefined) {
				return h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
					h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("collect.title")),
					h("p", { style: hintStyle }, t("collect.unavailable")),
				);
			}

			return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("collect.title")),
				h("p", { style: hintStyle }, t("collect.intro")),
				// 「建议不低于 10 分钟」是用户明确要求写在界面上的。
				h("p", { style: hintStyle }, fillN(t("collect.recommended"), policy ? Math.round(policy.recommendedMinMs / 60000) : 10)),
				KINDS.map(([kind, labelKey]) => h("div", {
					key: kind,
					style: { display: "flex", alignItems: "center", gap: 8 },
				},
					h("span", { style: { fontSize: 12, minWidth: 72 } }, t(labelKey)),
					h("input", {
						type: "number",
						min: 1,
						style: inputStyle,
						defaultValue: minutesOf(kind),
						onBlur: (e) => save(kind, e.target.value).catch(() => {}),
					}),
					h("span", { style: hintStyle }, t("collect.minutes")),
					// 被夹住时明确告诉用户：他填的 1 分钟没生效，实际按硬下限跑。
					policy && policy.clamped && policy.clamped[kind] === true
						? h("span", { style: { ...hintStyle, color: "var(--dsw-alias-label-warning, #b54708)" } },
							fillN(t("collect.clamped"), Math.round((policy.minMs ?? 60000) / 60000)))
						: null,
				)),
			);
		}

		/**
		 * 设置面板「DeepSeek 用量」页的配置体：采集频率 + 单价。
		 *
		 * 用量统计已经搬到用量页（`conversation.view` 的「用量」Tab）：用户的原话是
		 * 「统计从配置页移到用量页」——统计是"看数"，归在每天都在看的用量页；
		 * 配置页留"设数"（采集频率、单价）。两件事分开放，配置页也不再因为一次统计
		 * 回放日志而拖慢打开速度。
		 *
		 * 「采集频率」自己按 CONFIG_ENTRY_ID 去取 `configForms` 控制器（它只管
		 * collectIntervals 一个字段）。条目 id 来自本包的 cordis.patch.yml（insert 的 id）。
		 * 「单价」走 PRICES_PATH（宿主路由读写 price-store），与 configForms 无关。
		 */
		const CONFIG_ENTRY_ID = "quota-usage";

		// ---- 配置页「单价」块 ------------------------------------------------
		//
		// 用户口径（已确认，照做）：配置页可以配置单价——直接改表；分项渠道改
		// input + output + cacheRead（单一渠道就填一样的值）；插件自己存储；
		// 价格在统计时生效（cost.js 优先认 source === 'manual' 的记录，已验收）。
		//
		// 103 条不能全平铺：按渠道分组折叠（渠道行可点开/收起），配一个
		// 大小写不敏感的子串过滤框（输入即滤，命中时自动展开分组）。**不做分页**——
		// 分页在设置页里体验差（用户原话）。
		//
		// 数据通道：GET PRICES_PATH 拉整张表；POST {action, record} 保存/重置。
		// 宿主路由（lib/index.js 的 PRICES_PATH）缺失时整块显示「暂不可用」，
		// 绝不静默失败，也不影响同页的采集频率设置。

		/** 记录 → 三字段形态（price-store.unifiedPricesOf 的**展示层镜像**）。 */
		function priceUnifiedOf(record) {
			if (record === null || typeof record !== "object") return null;
			const hasUniform = record.uniform !== undefined;
			const hasSplit = record.input !== undefined || record.output !== undefined || record.cacheRead !== undefined;
			const isFree = record.free === true && !hasUniform && !hasSplit;
			const slotStandard = (slot) => {
				if (slot === null || typeof slot !== "object") return null;
				const v = slot.standard;
				return typeof v === "number" && Number.isFinite(v) ? v : null;
			};
			const slotOffPeak = (slot) => {
				if (slot === null || typeof slot !== "object") return null;
				const v = slot.offPeak;
				return typeof v === "number" && Number.isFinite(v) ? v : null;
			};
			const base = {
				provider: record.provider,
				model: record.model,
				displayName: typeof record.displayName === "string" && record.displayName.trim() !== ""
					? record.displayName
					: String(record.model ?? ""),
				currency: record.currency,
				source: record.source,
				asOf: record.asOf,
				seedSource: record.seedSource,
				seedAsOf: record.seedAsOf,
				seedPromotion: record.seedPromotion,
				mirrors: record.mirrors,
				free: isFree,
				uniform: hasUniform && !hasSplit && !isFree && typeof record.uniform === "number" && Number.isFinite(record.uniform),
				input: null,
				output: null,
				cacheRead: null,
				peakDiffers: false,
			};
			if (isFree) return { ...base, input: 0, output: 0, cacheRead: 0 };
			if (base.uniform) {
				return { ...base, input: record.uniform, output: record.uniform, cacheRead: record.uniform };
			}
			if (!hasSplit) return null;
			const input = slotStandard(record.input);
			const output = slotStandard(record.output);
			const cacheRead = slotStandard(record.cacheRead);
			if (input === null || output === null || cacheRead === null) return null;
			const offPeak = { input: slotOffPeak(record.input), output: slotOffPeak(record.output), cacheRead: slotOffPeak(record.cacheRead) };
			const peakDiffers = offPeak.input !== null && offPeak.input !== input
				|| offPeak.output !== null && offPeak.output !== output
				|| offPeak.cacheRead !== null && offPeak.cacheRead !== cacheRead;
			return { ...base, input, output, cacheRead, peakDiffers };
		}

		/** 三字段编辑值 → 三元组（非法值返回 null：负数/非数字一律拒发）。 */
		function priceTripleOf(values) {
			const parse = (v) => {
				if (typeof v === "number") return Number.isFinite(v) ? v : null;
				if (typeof v !== "string" || v.trim() === "") return null;
				const n = Number(v.trim());
				return Number.isFinite(n) ? n : null;
			};
			const input = parse(values.input);
			const output = parse(values.output);
			const cacheRead = parse(values.cacheRead);
			if (input === null || output === null || cacheRead === null) return null;
			if (input < 0 || output < 0 || cacheRead < 0) return null;
			return { input, output, cacheRead };
		}

		/** notices（机器标记）→ 展示行：{ key, text }；没认识的标记不占行。 */
		function priceNoticeLines(notices, t) {
			const known = [
				"peak-merged",
				"promotion-cleared",
				"mirrors-cleared",
				"schedule-dropped",
				"now-free",
				"overwrote-corrupt-store",
			];
			const out = [];
			for (const notice of Array.isArray(notices) ? notices : []) {
				if (!known.includes(notice)) continue;
				const key = notice === "overwrote-corrupt-store" ? "price.notice.overwrote" : "price.notice." + notice;
				out.push({ key: notice, text: t(key) });
			}
			return out;
		}

		/** 行的稳定键：渠道 + 模型（两字段里都不会出现 NUL，用它分隔最稳）。 */
		function priceRowKey(row) {
			return String(row.provider ?? "") + "\u0000" + String(row.model ?? "");
		}

		/** 按渠道分组并保持存储顺序；每行带三字段形态。 */
		function priceGroupsOf(records) {
			const groups = [];
			const byProvider = new Map();
			for (const record of Array.isArray(records) ? records : []) {
				const row = priceUnifiedOf(record);
				if (row === null) continue;
				const provider = String(row.provider ?? "").trim().toLowerCase();
				if (provider === "") continue;
				let group = byProvider.get(provider);
				if (group === undefined) {
					group = { provider, rows: [] };
					byProvider.set(provider, group);
					groups.push(group);
				}
				group.rows.push(row);
			}
			return groups;
		}

		/** 过滤：provider/model/展示名 子串匹配（大小写不敏感）。空串匹配一切。 */
		function priceRowsMatchFilter(row, needle) {
			const q = needle.trim().toLowerCase();
			if (q === "") return true;
			return String(row.provider ?? "").toLowerCase().includes(q)
				|| String(row.model ?? "").toLowerCase().includes(q)
				|| String(row.displayName ?? "").toLowerCase().includes(q);
		}

		/**
		 * 配置页的「单价」块。
		 *
		 * 组件从 __internals 透出，test/client-behavior.test.mjs 用迷你 React
		 * 直接渲染它，不必先 mount 整个设置面板。
		 */
// 新版 PriceEditor（临时文件，先独立语法检查，再拼进 lib/client.js）。
//
// 缩进用 4 空格写在这里，拼进 client.js 时统一转成 tab（client.js 用 tab）。
// 这样可以先 `node --check` 验证语法，避免直接改 client.js 改出坏文件。

function PriceEditor(props) {
	const t = props.t;
	const lang = props.lang === "en" ? "en" : "zh";
	// 状态（迷你 React 与真实 React 都按 hook 顺序对齐，不要条件化 hook）。
	const [state, setState] = useState({ status: "loading", records: [], problems: 0 });
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(() => ({}));
	const [editingKey, setEditingKey] = useState(null);
	const [draft, setDraft] = useState(null);
	const [busy, setBusy] = useState(false);
	const [feedback, setFeedback] = useState(null);
	const [confirmingReset, setConfirmingReset] = useState(false);
	const mountedRef = useRef(true);
	// 编辑起始值：判断"用户到底改没改"——没改就不发请求。
	const originRef = useRef(null);
	// 上一发已经试过的草稿：同一个值不重复发请求。
	const lastAttemptRef = useRef(null);
	// 正在保存 / 还有一个待保存：防止并发重复提交。
	const busyRef = useRef(false);
	const pendingRef = useRef(false);
	// 草稿的最新值：异步保存流程里读它（闭包里的 draft 会过期）。
	const draftRef = useRef(null);
	// 自动聚焦：双击进入编辑后聚焦第一个输入框并全选。
	const focusRef = useRef(null);
	useEffect(() => () => { mountedRef.current = false; }, []);

	// 进入编辑态后聚焦第一个输入框并全选：用户可以直接改，不用先点一下。
	useEffect(() => {
		if (editingKey === null) return;
		const el = focusRef.current;
		if (el === null || typeof el.focus !== "function") return;
		el.focus();
		if (typeof el.select === "function") el.select();
	}, [editingKey]);

	const load = useCallback(async () => {
		try {
			const res = await fetch(PRICES_PATH, { cache: "no-store" });
			const body = await res.json();
			if (!mountedRef.current) return;
			if (res.ok && body && body.ok === true && Array.isArray(body.records)) {
				setState({
					status: "ready",
					records: body.records,
					problems: typeof body.problems === "number" ? body.problems : 0,
				});
			} else {
				setState({ status: "unavailable", records: [], problems: 0 });
			}
		} catch (e) {
			if (!mountedRef.current) return;
			setState({ status: "unavailable", records: [], problems: 0 });
		}
	}, []);
	useEffect(() => { void load(); }, [load]);

	// 保存/重置共用：POST 一次，按返回体反馈。ok:false 把 error 原样显示出来。
	const post = useCallback(async (body) => {
		const res = await fetch(PRICES_PATH, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		let payload = null;
		try { payload = await res.json(); } catch (e) { payload = null; }
		if (!res.ok || payload === null || payload.ok !== true) {
			const message = payload !== null && typeof payload === "object" && typeof payload.error === "string" && payload.error !== ""
				? payload.error
				: "";
			return { ok: false, error: message, notices: Array.isArray(payload?.notices) ? payload.notices : [] };
		}
		return { ok: true, notices: Array.isArray(payload.notices) ? payload.notices : [], saved: payload.saved };
	}, []);

	const manualCount = state.records.filter((r) => r !== null && typeof r === "object" && r.source === "manual").length;

	// 退出编辑态（清掉一切编辑痕迹）。
	const leaveEdit = useCallback(() => {
		setEditingKey(null);
		setDraft(null);
		draftRef.current = null;
		originRef.current = null;
		lastAttemptRef.current = null;
	}, []);

	// 改草稿：state 供渲染，ref 供异步保存流程读最新值。
	const updateDraft = useCallback((next) => {
		draftRef.current = next;
		setDraft(next);
	}, []);

	// 双击模型名 → 进入编辑态。
	const beginEdit = useCallback((row) => {
		const start = { input: String(row.input), output: String(row.output), cacheRead: String(row.cacheRead) };
		setEditingKey(priceRowKey(row));
		setDraft(start);
		draftRef.current = start;
		originRef.current = start;
		lastAttemptRef.current = null;
		setFeedback(null);
		setConfirmingReset(false);
	}, []);

	// Esc → 放弃编辑：还原原值，不发任何请求。
	const cancelEdit = useCallback(() => {
		leaveEdit();
		setFeedback(null);
	}, [leaveEdit]);

	/**
	* 失焦 → 自动保存。
	*
	* 三种结果：
	*   · 没改（草稿 == 起始值）→ 静默退出编辑态，**不发请求**。
	*   · 改了但非法（负数/非数字）→ 留在编辑态，行内给可见理由，不发请求。
	*   · 改了且合法 → POST 保存，成功后退出编辑态并刷新列表。
	*
	* "没改就不发请求"靠 originRef 比对：用户双击进来又随手点走，不该产生
	* 一次 POST（那会把 source 变成 manual，把这一行标记成"已改"）。
	*/
	const saveEdit = useCallback(async (row) => {
		const current = draftRef.current;
		if (current === null) return;
		// 上一发还在飞：记一笔，等它结束再存一次（避免丢改动、避免并发重复提交）。
		if (busyRef.current) { pendingRef.current = true; return; }
		const origin = originRef.current;
		// 没改：静默退出，不打请求。
		if (origin !== null
			&& current.input === origin.input
			&& current.output === origin.output
			&& current.cacheRead === origin.cacheRead) {
			leaveEdit();
			return;
		}
		// 同一个值已经试过（上次失败）：不重复发请求，留在编辑态让用户改。
		const last = lastAttemptRef.current;
		if (last !== null
			&& current.input === last.input
			&& current.output === last.output
			&& current.cacheRead === last.cacheRead) {
			return;
		}
		const triple = priceTripleOf(current);
		if (triple === null) {
			// 非法值：留在编辑态让用户改（不退出、不发请求）。
			setFeedback({ kind: "invalid", key: priceRowKey(row) });
			return;
		}
		busyRef.current = true;
		setBusy(true);
		setFeedback(null);
		lastAttemptRef.current = current;
		try {
			const result = await post({
				action: "save",
				record: {
					provider: row.provider,
					model: row.model,
					input: triple.input,
					output: triple.output,
					cacheRead: triple.cacheRead,
				},
			});
			if (!mountedRef.current) return;
			if (result.ok) {
				leaveEdit();
				setFeedback({ kind: "saved", key: null, notices: result.notices });
				await load();
			} else {
				// 保存被拒：留在编辑态，错误可见，用户改了可以重试。
				setFeedback({ kind: "error", key: priceRowKey(row), error: result.error, notices: result.notices });
			}
		} catch (e) {
			if (!mountedRef.current) return;
			setFeedback({ kind: "network", key: priceRowKey(row) });
		} finally {
			busyRef.current = false;
			setBusy(false);
			if (pendingRef.current) {
				pendingRef.current = false;
				void saveEdit(row);
			}
		}
	}, [post, load, leaveEdit]);

	const requestReset = useCallback(() => {
		setConfirmingReset(true);
		setFeedback(null);
	}, []);

	const doReset = useCallback(async () => {
		setConfirmingReset(false);
		setBusy(true);
		setFeedback(null);
		try {
			const result = await post({ action: "reset" });
			if (!mountedRef.current) return;
			if (result.ok) {
				leaveEdit();
				setFeedback({ kind: "reset-done", key: null, notices: result.notices });
			} else {
				setFeedback({ kind: "reset-failed", key: null, error: result.error });
			}
			await load();
		} catch (e) {
			if (!mountedRef.current) return;
			setFeedback({ kind: "network", key: null });
		}
		setBusy(false);
	}, [post, load, leaveEdit]);

	// 过滤 + 分组：命中时该渠道自动展开（搜索不该逼用户再点一次）。
	const q = query.trim().toLowerCase();
	const groups = priceGroupsOf(state.records).map((group) => ({
		...group,
		rows: group.rows.filter((row) => priceRowsMatchFilter(row, q)),
	})).filter((group) => group.rows.length > 0);

	if (state.status === "unavailable") {
		return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
			h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("price.editor.title")),
			h("p", { style: SETTINGS_INTRO_STYLE }, t("price.editor.unavailable")),
		);
	}

	const buttonStyle = {
		boxSizing: "border-box",
		borderRadius: "var(--dsw-radius-md, 6px)",
		border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
		background: "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 12,
		height: 26,
		padding: "0 10px",
		cursor: "pointer",
	};
	const primaryButton = { ...buttonStyle, borderColor: "var(--dsw-alias-border-active, rgba(9,105,218,.6))" };
	const inputStyle = {
		boxSizing: "border-box",
		width: 96,
		borderRadius: "var(--dsw-radius-md, 6px)",
		border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
		background: "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 12,
		padding: "4px 8px",
		fontVariantNumeric: "tabular-nums",
	};
	const cellStyle = {
		padding: "3px 6px",
		fontSize: 12,
		lineHeight: "18px",
		textAlign: "right",
		fontVariantNumeric: "tabular-nums",
		whiteSpace: "nowrap",
	};
	const leftCell = { ...cellStyle, textAlign: "left", whiteSpace: "normal" };
	const headStyle = {
		...cellStyle,
		fontWeight: 500,
		color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
	};
	const badgeStyle = {
		marginLeft: 6,
		fontSize: 10,
		lineHeight: "14px",
		padding: "0 5px",
		borderRadius: 7,
		border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.35))",
		whiteSpace: "nowrap",
	};

	const noticeRows = feedback !== null && (feedback.kind === "saved" || feedback.kind === "reset-done")
		? priceNoticeLines(feedback.notices, t)
		: [];
	const errorText = feedback === null ? ""
		: feedback.kind === "error" || feedback.kind === "reset-failed"
			? (feedback.error !== "" ? fillVars(t("price.error.invalid"), { reason: feedback.error }) : t("price.error.network"))
			: feedback.kind === "invalid"
				? t("price.editor.invalidValue")
				: feedback.kind === "network" ? t("price.error.network") : "";
	const doneText = feedback !== null && feedback.kind === "saved" ? t("price.editor.saved")
		: feedback !== null && feedback.kind === "reset-done" ? t("price.editor.resetDone") : "";
	const errorKey = feedback !== null && feedback.key !== null ? feedback.key : null;

	/**
	* 一条 渠道×模型 行：查看态或编辑态。
	*
	* 查看态：只显示「提供商给的模型显示别名」+ 三个价格 + 「已改」徽章。
	* 双击别名进入编辑态。
	*
	* 编辑态：三个输入框，失焦自动保存；Esc 放弃，Enter 提前结束编辑。
	*/
	const rowNode = (row) => {
		const key = priceRowKey(row);
		// 这一行的稳定键：焦点还在本行内时用它判断"是不是真失焦"。
		const rowToken = key;
		const editing = editingKey === key;
		if (!editing) {
			return h("tr", { key, role: "row" },
				h("td", {
					style: { ...leftCell, cursor: "text" },
					title: t("price.editor.editHint"),
					onDoubleClick: () => beginEdit(row),
				}, row.displayName),
				h("td", { style: cellStyle }, row.free ? "—" : fmtPrice(row.input)),
				h("td", { style: cellStyle }, row.free ? "—" : fmtPrice(row.output)),
				h("td", { style: cellStyle }, row.free ? "—" : fmtPrice(row.cacheRead)),
				h("td", { style: cellStyle, whiteSpace: "nowrap" },
					// 只留「已改」：它陈述事实（这行被手改过），不解释价格从哪来。
					row.source === "manual" ? h("span", { style: badgeStyle, "data-badge": "edited" }, t("price.editor.edited")) : null,
				),
			);
		}
		const invalidNow = priceTripleOf(draft) === null;
		// 键盘：Esc 放弃（还原原值，不发请求）；Enter 提前结束编辑（等价于失焦保存）。
		const onKeyDown = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				cancelEdit();
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				void saveEdit(row);
			}
		};
		// 失焦即自动保存。焦点还在本行的另一个输入框里 → 继续编辑（等真正离开
		// 这一行再一次性存）；换了字段就立刻存，免得用户以为没存上。
		const onBlur = (e) => {
			const target = e !== null && typeof e === "object" && e.relatedTarget !== undefined
				? e.relatedTarget
				: null;
			const nextRow = target !== null && typeof target.getAttribute === "function"
				? target.getAttribute("data-row")
				: null;
			if (nextRow !== null && nextRow === rowToken) return;
			void saveEdit(row);
		};
		const inputProps = (field, ariaLabel, isFirst) => ({
			type: "text",
			inputMode: "decimal",
			"aria-label": ariaLabel,
			"data-row": rowToken,
			style: inputStyle,
			value: draft[field],
			onChange: (e) => updateDraft({ ...draft, [field]: e.target.value }),
			onBlur,
			onKeyDown,
			// 双击进入后聚焦第一个输入框并全选：用户可以直接改。
			autoFocus: isFirst,
			ref: isFirst ? focusRef : undefined,
		});
		return h("tr", { key, role: "row", "data-editing": key },
			h("td", { style: leftCell }, row.displayName),
			h("td", { style: cellStyle }, h("input", inputProps("input", t("price.input"), true))),
			h("td", { style: cellStyle }, h("input", inputProps("output", t("price.output"), false))),
			h("td", { style: cellStyle }, h("input", inputProps("cacheRead", t("price.cache"), false))),
			// 只留「值非法」的可见理由（用户得知道为什么没存上）。
			// 峰谷合并提示没有了——那是价格从哪来的解释，用户不要。
			h("td", { style: { ...leftCell, fontSize: 11, color: "var(--dsw-alias-label-critical, #b42318)" } },
				invalidNow ? t("price.editor.invalidValue") : (busy ? t("price.editor.saving") : null),
			),
		);
	};

	return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } },
		h("h3", { style: { margin: 0, fontSize: 15, fontWeight: 600, lineHeight: "22px" } }, t("price.editor.title")),
		h("p", { style: SETTINGS_INTRO_STYLE }, t("price.editor.intro")),
		state.status === "loading"
			? h("p", { style: SETTINGS_INTRO_STYLE }, t("price.editor.loading"))
			: null,
		state.status === "ready" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } },
			// 过滤框：输入即滤，大小写不敏感；命中时分组自动展开。
			h("input", {
				type: "search",
				style: { ...inputStyle, width: 240 },
				placeholder: t("price.editor.search"),
				"aria-label": t("price.editor.searchLabel"),
				value: query,
				onChange: (e) => setQuery(e.target.value),
			}),
			// 确认条（恢复默认的二次确认）：一条行内提示 + 两个按钮，不用 window.confirm
			//（设置页是嵌入面板，原生对话框被很多外壳吞掉）。
			confirmingReset ? h("div", {
				style: {
					display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
					padding: "6px 10px",
					borderRadius: "var(--dsw-radius-md, 6px)",
					border: "1px solid var(--dsw-alias-border-warning, rgba(181,71,8,.5))",
					fontSize: 12,
				},
				role: "alertdialog",
				"aria-label": t("price.editor.reset"),
			},
				h("span", { style: { flex: "1 1 auto", minWidth: 0 } },
					fillN(manualCount > 0 ? t("price.editor.resetConfirm") : t("price.editor.resetEmptyConfirm"), manualCount)),
				h("button", { type: "button", style: primaryButton, disabled: busy, onClick: () => { void doReset(); } }, t("price.editor.reset")),
				h("button", { type: "button", style: buttonStyle, disabled: busy, onClick: () => setConfirmingReset(false) }, t("price.editor.cancel")),
			) : null,
			// 保存反馈：成功（含 notices）与失败分两行，失败绝不静默。
			doneText !== "" || noticeRows.length > 0 ? h("div", { style: { display: "flex", flexDirection: "column", gap: 2, fontSize: 12 } },
				doneText !== "" ? h("span", { style: { color: "var(--dsw-alias-label-success, #067647)" }, "data-feedback": "saved" }, doneText) : null,
				noticeRows.map((n) => h("span", { key: n.key, style: { color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))" }, "data-notice": n.key }, n.text)),
			) : null,
			errorText !== "" ? h("div", {
				style: { color: "var(--dsw-alias-label-critical, #b42318)", fontSize: 12 },
				role: "alert",
				"data-feedback": "error",
				"data-error-key": errorKey === null ? undefined : errorKey,
			}, errorText) : null,
			state.problems > 0 ? h("p", { style: SETTINGS_INTRO_STYLE }, fillN(t("price.editor.problems"), state.problems)) : null,
			// 表格：按渠道分组，渠道行可折叠。外层 overflowX:auto——窄宽度下
			// 允许横向滚动，绝不挤压出 1~2 字残段（G11）。
			h("div", { style: { overflowX: "auto", minWidth: 0 } },
				h("table", { style: { width: "100%", borderCollapse: "collapse" } },
					h("thead", null, h("tr", null,
						h("th", { style: { ...headStyle, textAlign: "left" } }, t("price.editor.model")),
						h("th", { style: headStyle }, t("price.input")),
						h("th", { style: headStyle }, t("price.output")),
						h("th", { style: headStyle }, t("price.cache")),
						h("th", { style: headStyle }, t("price.editor.status")),
					)),
					h("tbody", null,
						groups.map((group) => {
							const isCollapsed = q === "" && collapsed[group.provider] === true;
							const edited = group.rows.filter((r) => r.source === "manual").length;
							return [
								h("tr", { key: "g:" + group.provider, role: "row", "data-group": group.provider },
									h("td", {
										style: { ...leftCell, fontWeight: 600, cursor: "pointer" },
										colSpan: 5,
										onClick: () => setCollapsed((prev) => ({ ...prev, [group.provider]: prev[group.provider] !== true })),
									},
										(isCollapsed ? "▸ " : "▾ ") + group.provider,
										h("span", { style: { marginLeft: 8, ...SETTINGS_INTRO_STYLE } },
											fillN(t("price.editor.groupCount"), group.rows.length)),
										edited > 0 ? h("span", { style: { marginLeft: 8, ...SETTINGS_INTRO_STYLE } },
											fillN(t("price.editor.groupEdited"), edited)) : null,
									),
								),
								...(isCollapsed ? [] : group.rows.map(rowNode)),
							];
						}),
					),
				),
			),
			h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
				h("button", { type: "button", style: buttonStyle, disabled: busy, onClick: requestReset }, t("price.editor.reset")),
			),
		) : null,
	);
}
		function UsageConfigSection(props) {
			const t = props.t;
			const ctx = props.ctx;
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
				h(CollectIntervalSettings, { t, ctx }),
				h(PriceEditor, { t, lang: currentLang(ctx) }),
			);
		}

		// 设置导航项：id 与位置（放在 Plugins 15 之后、Agent presets 20 之前）。
		const SETTINGS_SECTION_ID = "quota-usage";
		const SETTINGS_SECTION_ORDER = 16;
		const SETTINGS_HEADING_STYLE = { margin: 0, fontSize: 18, lineHeight: "26px", fontWeight: 600 };
		const SETTINGS_INTRO_STYLE = {
			margin: 0,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-tertiary, rgba(0,0,0,.45))",
		};

		/** 设置面板里的「DeepSeek 用量」页：标题 + 说明 + 配置体。 */
		function UsageSettingsSection(props) {
			const t = props.t;
			return h("div", {
				style: {
					maxWidth: 760,
					color: "var(--dsw-alias-label-primary)",
					display: "flex",
					flexDirection: "column",
					gap: 16,
				},
			},
				h("h2", { style: SETTINGS_HEADING_STYLE }, t("settings.title")),
				h("p", { style: SETTINGS_INTRO_STYLE }, t("settings.intro")),
				h(UsageConfigSection, { t, ctx: props.ctx }),
			);
		}

		/**
		 * 设置外壳的共享实例：设置面板把「开/关 + 当前分区」的状态放在
		 * `sidebar.settings` 槽位注册项的 store 上，`create()` 返回的就是面板在用的
		 * 那个实例（settings-general 自己重写了 create，反复调用拿到的仍是同一个）。
		 * 槽位 ledger 的 entry 把 store 句柄放在 `entry.store`（options 是渲染侧擦除
		 * 过的空壳），老版本若把它投影在 options 里也一并兼容。宿主没有设置外壳时
		 * 返回 undefined。
		 */
		function settingsShellOf(ctx) {
			try {
				const slots = ctx && ctx.slots;
				if (!slots || typeof slots.entries !== "function") return undefined;
				for (const entry of slots.entries("sidebar.settings") || []) {
					const handle = entry && (entry.store || (entry.options ? entry.options.store : undefined));
					if (handle && typeof handle.create === "function") {
						const shell = handle.create();
						if (shell) return shell;
					}
				}
			} catch (e) { /* 宿主没有设置外壳 */ }
			return undefined;
		}

		/** 能否直接跳到「DeepSeek 用量」设置页（外壳存在且支持 openSection）。 */
		function canOpenUsageSettings(ctx) {
			const actions = settingsShellOf(ctx)?.actions;
			return !!(actions && typeof actions.openSection === "function");
		}

		/** 打开设置面板并切到「DeepSeek 用量」页；不可用时返回 false。 */
		function openUsageSettings(ctx) {
			try {
				const actions = settingsShellOf(ctx)?.actions;
				if (!actions || typeof actions.openSection !== "function") return false;
				actions.openSection(SETTINGS_SECTION_ID);
				return true;
			} catch (e) {
				return false;
			}
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots", "remote", "locale"];

		function apply(ctx) {
			// 注册 i18n 词典（DSH locale 服务；不可用时组件回退中文）。
			// 用 ctx.effect 管理生命周期：插件卸载时词典随之撤销。
			try {
				if (ctx.effect && ctx.locale && typeof ctx.locale.register === "function") {
					ctx.effect(
						() => ctx.locale.register(NS, { zh: ZH, en: EN }),
						"dsh-quota-usage: dictionaries",
					);
				} else if (ctx.locale && typeof ctx.locale.register === "function") {
					ctx.locale.register(NS, { zh: ZH, en: EN });
				}
			} catch (e) { /* 词典注册失败不影响卡片 */ }
			// 注入本包样式：footerActions 换行（卡片独占一行）。
			const tagId = "dsh-quota-usage";
			if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-quota-usage";
				style.dataset.pluginCss = tagId;
				style.textContent = 'div[class*="footerActions"]{flex-wrap:wrap}';
				document.head.appendChild(style);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				// label 用函数：每次求值时按当前 DSH 语言取，切换语言后不必重新注册槽位。
				{ name: "sidebar.footer.action", id: "dsh-usage", order: 100, label: () => textOf("sidebar.label", currentLang(ctx)) },
				// `useSessions` 是 root 标准 props 里的选择器（`sidebar.footer.action` 是
				// `scope: 'root'`），组件用它订阅「当前正被主面板持有的会话」，见
				// useCurrentSessionId。透传而不是在这里调用：hook 必须在组件里跑。
				(props) => h(UsageCell, { wide: props.wide, ctx, useSessions: props.useSessions }),
			));
			// 会话内视图（`conversation.view`）：与「轨迹」Tab 并列的「用量」页。
			// 这是原话「在会话里统计各个厂商各个模型的使用量」的落点。
			//
			// 槽位是 `scope: session`，所以 `inject(sessionId)` 拿得到当前会话 id，
			// 它返回的对象就是渲染组件收到的 props（与 trajectory 的写法一致）。
			ctx.slots.inject("conversation.view", () => ctx.slots.register(
				{
					name: "conversation.view",
					id: VIEW_ID,
					order: VIEW_ORDER,
					locale: NS,
					// label 是 thunk：切换语言后 Tab 名跟着变，不必重新注册。
					label: () => textOf("view.usage", currentLang(ctx)),
					inject: (sessionId) => ({ sessionId: typeof sessionId === "string" ? sessionId : "" }),
				},
				// 组件用闭包包一层：`t` 由槽位的 `locale: NS` 注入，缺失时按当前语言兜底。
				(props) => h(UsageView, { ...props, ctx }),
			));
			// 设置面板的「DeepSeek 用量」页：采集频率 + 会话用量统计。
			// 导航标题用 thunk，切换语言后重新求值；locale: NS 让页面拿到注入的 t。
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{
					name: "settings.section",
					id: SETTINGS_SECTION_ID,
					order: SETTINGS_SECTION_ORDER,
					label: () => textOf("settings.nav", currentLang(ctx)),
					locale: NS,
				},
				(props) => h(UsageSettingsSection, { t: props.t, ctx }),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		// 纯函数透出（供 test/client-layout.test.mjs 直接做确定性断言，不必模拟计时器）。
		exports.__internals = {
			nextChange,
			isPeak,
			// 卡片的收缩/展开是**模块级**状态（刻意如此：重挂载不该把用户点开的形态合回去）。
			// 代价是测试之间会互相影响——前一条把形态改成展开，后一条就拿到展开态。
			// 透出读写口，让测试能显式摆好起手形态，而不是靠"看到 ▾ 就以为对"。
			getCardOpen: () => cardOpen,
			setCardOpen: (next) => { cardOpen = next === true; },
			money,
			fmtPrice,
			currencySymbol,
			expandHolidayRanges,
			isHoliday,
			accountLead,
			percentText,
			usageWindows,
			windowLabel,
			windowBadge,
			windowHint,
			// 订阅条上排的倒计时：定长 `D天HH:MM:SS` / `H:MM:SS` 文案 + 按时间进度染的淡色。
			// 透出是为了能直接断言格式与色值（不必去数渲染树里的 span）。
			countdownText,
			// 段数（带不带天）由窗口类型决定，精度（分钟级/秒级）由剩余时间决定。
			countdownHasDays,
			// 下一次可见变化的相隔毫秒数（>= 10 分钟时不每秒唤醒的那套节奏）。
			nextCountdownTickMs,
			// 倒计时要不要起定时器的阈值判定（剩余 <= 订阅采集间隔 + 2 分钟）。透出是为了
			// 能直接断言阈值两侧的行为，不必去数渲染树里挂没挂定时器。
			countdownNeedsTimer,
			countdownColor,
			windowSpanMs,
			hasCountdownWindow,
			fmtDuration,
			usageRatio,
			remainingColor,
			uiLang,
			// 卡片与统计面板的显示层纯函数：把数字/单位/金额的取舍逻辑暴露出来，
			// 让测试能直接断言口径（中文万/亿、未知单位不显示、跨币种不相加），
			// 不必模拟 React 的 hook 顺序。
			//
			// 这里**曾经**还导出 `creditLead`（把一条积分行拼成"账户读数"的函数）。
			// 拆掉 kind 门控之后积分读数一律走「积分」分区里的逐渠道行，那个函数再没有
			// 调用路径，已删除——导出一个没人调的函数，等于给下一个人留一条能读不能跑的
			// 旧路。
			creditUnitText,
			fmtCompactZh,
			fmtCompactEn,
			fmtTokens,
			moneyText,
			mixedMoneyText,
			workspaceCostText,
			priceText,
			// 金额单元格的悬浮说明：单一价 / 促销 / 镜像价。测试断言它按 form 出文案，
			// 且"没话说时给 undefined"（空 title 会弹出空提示框）。
			costHint,
			hintOf,
			// 树形统计的三块纯逻辑：勾选 → 取数计划、勾选 + 三份数据 → 节点列表、
			// 工作区归属。透出是为了能直接断言八个勾选组合的层级结构，
			// 不必去数渲染树里的 tr（层级本身就是"数据长什么样"，与 React 无关）。
			statsFetchPlan,
			statsTreeNodes,
			currentWorkspaceOf,
			mergeCostText,
			// 配置页「单价」块：组件与它的纯函数。透出是为了让 client-behavior 测试
			// 用迷你 React 直接渲染这个组件（不必先 mount 整个设置面板），并对
			// 形态判定/过滤/notice 映射做确定性断言。
			PriceEditor,
			priceUnifiedOf,
			priceTripleOf,
			priceNoticeLines,
			priceRowKey,
			priceGroupsOf,
			priceRowsMatchFilter,
			PRICES_PATH,
			// 词典本体：测试断言 price.* 键在 ZH/EN 两份里同时存在、且没有撞
			// price.input / credit.* / credits.* 既有键。
			ZH,
			EN,
		};
		return module.exports;
	}
});

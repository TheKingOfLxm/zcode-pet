import { appendFileSync, createReadStream, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { BlockAssembler, ReasoningEffortId, createAssistantMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

//#region src/host/balance/internal.ts
/**
* 余额取数的内部工具（host 半侧）：网络策略、响应校验与金额处理。
*
* 只给 ./providers/* 使用，不含服务商知识，也不负责注册与路由。
* 统一 20s 超时加 3 次重试：目标端点多为境外，实测会间歇性超时。
* 依赖全局 fetch；始终成立：必填字段缺失或非法一律抛错，绝不静默当 0。
*
* @module dsh-pet/src/host/balance/internal
*/
/** 单次抓取超时（ms）。 */
const FETCH_TIMEOUT_MS = 2e4;
/** 单次抓取失败后的重试次数（间隔 0.8s）。 */
const RETRIES = 3;
/** 发起一次带超时的 fetch；失败抛错，是否重试由调用方决定。extraHeaders 可覆盖默认头（如裸 key 鉴权）。 */
async function fetchOnce(url, key, extraHeaders) {
	return fetch(url, {
		headers: {
			Authorization: "Bearer " + key,
			"User-Agent": "dsh-pet-balance",
			...extraHeaders
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
	});
}
async function fetchWithRetry(url, key, extraHeaders) {
	let last;
	for (let i = 0; i <= RETRIES; i++) try {
		return await fetchOnce(url, key, extraHeaders);
	} catch (e) {
		last = e;
		if (i < RETRIES) await new Promise((r) => setTimeout(r, 800));
	}
	throw last instanceof Error ? last : new Error(String(last));
}
function num(value, what) {
	const n = Number(value);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return n;
}
function str$1(value, what) {
	if (typeof value !== "string" || value.length === 0) throw new Error("dsh-pet: 余额数据非法字段 " + what);
	return value;
}
function looseNum(value) {
	if (value === void 0 || value === null || value === "") return void 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : void 0;
}
function obj(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
/**
* 归一重置时间：字符串原样返回，数字时间戳自动识别秒/毫秒。
* 0、负数与非法值返回 undefined —— 报文里空闲窗口的 resetAt: 0 是占位，不是 1970 年。
*/
function resetTime(value) {
	if (typeof value === "string") return value.length > 0 ? value : void 0;
	const n = looseNum(value);
	if (n === void 0 || n <= 0) return void 0;
	const ms = n < 1e12 ? n * 1e3 : n;
	const d = new Date(ms);
	return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
function readWindow(value) {
	const w = obj(value);
	if (!w) return void 0;
	const used = looseNum(w.used);
	const cap = looseNum(w.cap);
	if (used === void 0 || cap === void 0 || cap <= 0) return void 0;
	return {
		percent: Math.max(0, used / cap * 100),
		capUsd: cap,
		resetsAt: resetTime(w.resetAt)
	};
}
function queryString(params) {
	const pairs = Object.entries(params).filter(([, v]) => v !== void 0);
	return pairs.length > 0 ? "?" + pairs.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&") : "";
}
function money(value, what) {
	const raw = str$1(value, what);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error("dsh-pet: 账号余额金额非法 " + what);
	return n.toFixed(2);
}
function sumMoney(a, b) {
	return ((Math.round(Number(a) * 100) + Math.round(Number(b) * 100)) / 100).toFixed(2);
}

//#endregion
//#region src/host/balance/providers/commandcode.ts
/** 控制面基址（/alpha/* 固定在根域名）。 */
const API_BASE = "https://api.commandcode.ai";
/** 滚动窗的展示名：本服务商的 5h 窗口即 windowLimits.fiveHour。 */
const ROLLING_LABEL$1 = "5h";
/** 抓一次 JSON，HTTP 非 2xx 抛错；label 是接口路径，只用于错误信息。 */
async function fetchJson(url, key, label) {
	const res = await fetchWithRetry(url, key);
	if (!res.ok) throw new Error("commandcode " + label + " HTTP " + res.status);
	return await res.json();
}
function parseCommandCode(creditsBody, subscriptionBody, summaryBody, provider) {
	const root = obj(creditsBody);
	const credits = obj(root?.credits);
	if (!credits) throw new Error("dsh-pet: commandcode 响应缺少 credits");
	const creditFields = [
		credits.monthlyCredits,
		credits.purchasedCredits,
		credits.freeCredits
	];
	if (creditFields.every((v) => looseNum(v) === void 0)) throw new Error("dsh-pet: commandcode credits 响应缺少额度字段");
	const remaining = creditFields.reduce((sum, v) => sum + Math.max(0, looseNum(v) ?? 0), 0);
	const summary = obj(summaryBody);
	const spentRaw = summary?.totalCost;
	if (spentRaw === void 0 || spentRaw === null) throw new Error("dsh-pet: commandcode usage 响应缺少 totalCost");
	const spent = Math.max(0, num(spentRaw, "totalCost"));
	const pool = spent + remaining;
	const data = { monthly: pool > 0 ? spent / pool * 100 : 0 };
	if (pool > 0) data.monthlyCapUsd = pool;
	const subscription = obj(obj(subscriptionBody)?.data);
	const periodEnd = subscription?.currentPeriodEnd;
	if (typeof periodEnd === "string" && periodEnd.length > 0) data.monthlyResetsAt = periodEnd;
	const limits = obj(root?.windowLimits) ?? obj(credits.windowLimits);
	if (limits?.limited === true) {
		const fiveHour = readWindow(limits.fiveHour);
		if (fiveHour) {
			data.rolling = fiveHour.percent;
			data.rollingCapUsd = fiveHour.capUsd;
			data.rollingLabel = ROLLING_LABEL$1;
			if (fiveHour.resetsAt) data.rollingResetsAt = fiveHour.resetsAt;
		}
		const weekly = readWindow(limits.weekly);
		if (weekly) {
			data.weekly = weekly.percent;
			data.weeklyCapUsd = weekly.capUsd;
			if (weekly.resetsAt) data.weeklyResetsAt = weekly.resetsAt;
		}
	}
	return {
		ok: true,
		provider,
		shape: "windows",
		data
	};
}
const commandCode = {
	id: "commandcode",
	credential: {
		mode: "ref",
		ref: "COMMANDCODE_API_KEY"
	},
	async fetch({ key, provider }) {
		const whoami = obj(await fetchJson(API_BASE + "/alpha/whoami" + queryString({ limits: "1" }), key, "/alpha/whoami"));
		const org = obj(whoami?.org);
		const orgId = typeof org?.id === "string" && org.id.length > 0 ? org.id : void 0;
		const credits = await fetchJson(API_BASE + "/alpha/billing/credits" + queryString({ orgId }), key, "/alpha/billing/credits");
		let subscription;
		try {
			subscription = await fetchJson(API_BASE + "/alpha/billing/subscriptions" + queryString({ orgId }), key, "/alpha/billing/subscriptions");
		} catch {
			subscription = void 0;
		}
		const periodStart = obj(obj(subscription)?.data)?.currentPeriodStart;
		const summary = await fetchJson(API_BASE + "/alpha/usage/summary" + queryString({
			since: typeof periodStart === "string" ? periodStart : void 0,
			orgId
		}), key, "/alpha/usage/summary");
		return parseCommandCode(credits, subscription, summary, provider);
	}
};

//#endregion
//#region src/host/balance/deepseek-common.ts
const DEEPSEEK_FULL_BALANCE = {
	CNY: "20",
	USD: "5"
};
function deepseekFullBalance(currency) {
	return DEEPSEEK_FULL_BALANCE[currency];
}
function deepseekPricingTier(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(now);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const weekday = pick("weekday");
	const hour = Number(pick("hour"));
	if (weekday === "Sat" || weekday === "Sun") return "idle";
	return hour >= 9 && hour < 12 || hour >= 14 && hour < 18 ? "peak" : "idle";
}

//#endregion
//#region src/host/balance/providers/deepseek-account.ts
function parseAccountBalance(snapshot, provider) {
	if (!snapshot) throw new Error("dsh-pet: 账号未登录（deepseek-account）");
	if (snapshot.status !== "ready") throw new Error("dsh-pet: 账号余额查询失败");
	const wallets = Array.isArray(snapshot.value) ? snapshot.value : [];
	if (wallets.length === 0) throw new Error("dsh-pet: 账号没有充值钱包余额");
	const candidates = wallets.map((w) => obj(w)).filter((w) => w !== void 0);
	if (candidates.length === 0) throw new Error("dsh-pet: 账号钱包结构非法");
	const toppedUpBy = new Map();
	for (const w of candidates) {
		const currency = typeof w.currency === "string" && w.currency.length > 0 ? w.currency : "CNY";
		const amount = money(w.balance, "balance");
		const prev = toppedUpBy.get(currency);
		toppedUpBy.set(currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	const grantedBy = new Map();
	for (const raw of Array.isArray(snapshot.bonusWallets) ? snapshot.bonusWallets : []) {
		const w = obj(raw);
		if (!w || typeof w.currency !== "string" || w.currency.length === 0) continue;
		const amount = money(w.balance, "bonus balance");
		const prev = grantedBy.get(w.currency);
		grantedBy.set(w.currency, prev === void 0 ? amount : sumMoney(prev, amount));
	}
	for (const currency of grantedBy.keys()) if (!toppedUpBy.has(currency)) toppedUpBy.set(currency, "0.00");
	const walletsOut = [...toppedUpBy.entries()].map(([currency, toppedUp]) => {
		const granted = grantedBy.get(currency) ?? "0.00";
		const fullBalance = deepseekFullBalance(currency);
		return {
			currency,
			total: sumMoney(granted, toppedUp),
			granted,
			toppedUp,
			...fullBalance === void 0 ? {} : { fullBalance }
		};
	});
	return {
		ok: true,
		provider,
		shape: "money",
		data: {
			wallets: walletsOut,
			tier: deepseekPricingTier()
		}
	};
}
const deepseekAccount = {
	id: "deepseek-account",
	credential: { mode: "none" },
	async fetch({ provider, resolveAccount }) {
		if (!resolveAccount) throw new Error("dsh-pet: 缺少账号服务（" + provider + "）");
		return parseAccountBalance(await resolveAccount(), provider);
	}
};

//#endregion
//#region src/host/balance/providers/deepseek-official.ts
const deepseekOfficial = {
	id: "deepseek-official",
	credential: {
		mode: "ref",
		ref: "DEEPSEEK_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://api.deepseek.com/user/balance", key);
		if (!res.ok) throw new Error("deepseek balance HTTP " + res.status);
		const body = await res.json();
		const infos = body?.balance_infos;
		if (!Array.isArray(infos) || infos.length === 0) throw new Error("dsh-pet: deepseek balance 响应缺少 balance_infos");
		const wallets = infos.map((raw) => {
			const w = obj(raw) ?? {};
			const currency = str$1(w.currency, "currency");
			const fullBalance = deepseekFullBalance(currency);
			return {
				currency,
				total: str$1(w.total_balance, "total_balance"),
				granted: str$1(w.granted_balance, "granted_balance"),
				toppedUp: str$1(w.topped_up_balance, "topped_up_balance"),
				...fullBalance === void 0 ? {} : { fullBalance }
			};
		});
		return {
			ok: true,
			provider,
			shape: "money",
			data: {
				wallets,
				tier: deepseekPricingTier()
			}
		};
	}
};

//#endregion
//#region src/host/balance/providers/opencode-go.ts
/** 各窗口满额度（USD）：滚动 12、周 30、月 60；接口不回传，属业务常量。 */
const QUOTA_USD = {
	rolling: 12,
	weekly: 30,
	monthly: 60
};
/** 滚动窗的展示名：本服务商是 5 小时。 */
const ROLLING_LABEL = "5h";
const opencodeGo = {
	id: "opencode-go",
	credential: {
		mode: "ref",
		ref: "OPENCODE_GO_API_KEY"
	},
	async fetch({ key, provider }) {
		const res = await fetchWithRetry("https://opencode.ai/zen/go/v1/usage", key);
		if (!res.ok) throw new Error("opencode usage HTTP " + res.status);
		const body = await res.json();
		const usage = body?.usage;
		if (!usage || typeof usage !== "object") throw new Error("dsh-pet: opencode usage 响应缺少 usage");
		const u = usage;
		const rolling = u.rolling, weekly = u.weekly, monthly = u.monthly;
		if (!rolling || !weekly || !monthly) throw new Error("dsh-pet: opencode usage 响应缺少窗口");
		return {
			ok: true,
			provider,
			shape: "windows",
			data: {
				rolling: num(rolling.percent, "rolling.percent"),
				weekly: num(weekly.percent, "weekly.percent"),
				monthly: num(monthly.percent, "monthly.percent"),
				rollingCapUsd: QUOTA_USD.rolling,
				weeklyCapUsd: QUOTA_USD.weekly,
				monthlyCapUsd: QUOTA_USD.monthly,
				rollingLabel: ROLLING_LABEL,
				rollingResetsAt: str$1(rolling.resetsAt, "rolling.resetsAt"),
				weeklyResetsAt: str$1(weekly.resetsAt, "weekly.resetsAt"),
				monthlyResetsAt: str$1(monthly.resetsAt, "monthly.resetsAt")
			}
		};
	}
};

//#endregion
//#region src/host/balance/registry.ts
const BUILTIN_PROVIDERS = [
	opencodeGo,
	commandCode,
	deepseekOfficial,
	deepseekAccount
];
/** 第三方运行时登记表：provider id → 定义。 */
const external = new Map();
function registerBalanceProvider(def) {
	if (!def || typeof def !== "object") throw new TypeError("provider 定义必须是对象");
	if (typeof def.id !== "string" || def.id.length === 0) throw new TypeError("id 必须是非空字符串");
	if (typeof def.fetch !== "function") throw new TypeError("fetch 必须是函数");
	if (BUILTIN_PROVIDERS.some((p) => p.id === def.id)) throw new Error("不能覆盖内置服务商: " + def.id);
	if (external.has(def.id)) throw new Error("该服务商 id 已被注册: " + def.id);
	external.set(def.id, def);
	return () => {
		if (external.get(def.id) === def) external.delete(def.id);
	};
}
function listBalanceProviders() {
	return {
		builtin: BUILTIN_PROVIDERS.map((p) => p.id),
		external: [...external.keys()]
	};
}
function matchBalanceProvider(provider) {
	return BUILTIN_PROVIDERS.find((p) => p.id === provider) ?? external.get(provider);
}

//#endregion
//#region src/host/balance/index.ts
/** 第三方取数等待上限（ms）；内置 HTTP 服务商走各自的超时与重试。 */
const PLUGIN_FETCH_TIMEOUT_MS = 2e4;
/**
* 构造失败结果：三种 reason 走同一个出口，避免各处手写字段。
* `message` 缺省时不写这个键——叶子形状是对外契约，多一个 undefined 键会破坏严格比对。
*/
function failed(provider, reason, message) {
	return message === void 0 ? {
		ok: false,
		provider,
		reason
	} : {
		ok: false,
		provider,
		reason,
		message
	};
}
/** 把取数异常归一成 fetch-error（内置与第三方同一口径）。 */
function fetchFailed(provider, e) {
	return failed(provider, "fetch-error", e instanceof Error ? e.message : String(e));
}
async function queryBalance(provider, resolveKey, resolveAccount) {
	const def = matchBalanceProvider(provider);
	if (!def) return failed(provider, "unsupported");
	if (!("credential" in def)) {
		let timer;
		try {
			const timeout = new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("余额查询超时（20 秒），请稍后重试")), PLUGIN_FETCH_TIMEOUT_MS);
				timer.unref();
			});
			return await Promise.race([def.fetch({ provider }), timeout]);
		} catch (e) {
			return fetchFailed(provider, e);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	let key = "";
	if (def.credential.mode === "ref") {
		const resolved = await resolveKey(def.credential.ref);
		if (!resolved) return failed(provider, "credential-missing", "缺少凭证 " + def.credential.ref);
		key = resolved;
	} else if (!resolveAccount) return failed(provider, "credential-missing", "缺少账号服务（" + provider + "）");
	try {
		return await def.fetch({
			provider,
			key,
			resolveAccount
		});
	} catch (e) {
		return fetchFailed(provider, e);
	}
}

//#endregion
//#region src/host/llm-call.ts
const PET_CALL_IDENTITY = "zcode-pet";
function noTextReason(finish) {
	const { kind, failure } = finish ?? {};
	if (kind === "aborted") return "生成已取消";
	if (kind === "max-tokens") return "输出达到上限，未产出正文";
	if (kind !== "error") return "模型未返回文本";
	const { message, code } = failure ?? {};
	if (typeof message === "string" && message.trim() !== "") return message;
	if (typeof code === "string" && code.trim() !== "") return code;
	return "未提供失败原因";
}

//#endregion
//#region src/host/llm-reasoning.ts
async function supportsReasoningOff(ctx, provider, model) {
	const llm = ctx.llm;
	if (!llm || typeof llm.resolveModelInfo !== "function") return false;
	try {
		const info = await llm.resolveModelInfo(provider, model);
		return info?.reasoning?.efforts?.some((e) => e.id === "off") ?? false;
	} catch {
		return false;
	}
}

//#endregion
//#region src/host/log-file.ts
function isFileLogger(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.isFileLogger === true && typeof candidate.flush === "function" && typeof candidate.file === "string";
}
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 512 * 1024;
const LOG_FLUSH_MS = 1e3;
const LOG_FLUSH_LINES = 64;
const LOG_MAX_PENDING = 1e3;
function redactSensitive(text) {
	return text.replace(/(x-dsh-pet-token["'\s:=]+)[A-Za-z0-9_-]{16,}/gi, "$1***").replace(/(token["'\s:=]+)[A-Za-z0-9_-]{32,}/gi, "$1***").replace(/(#token=)[A-Za-z0-9_-]{16,}/g, "$1***").replace(/(DSH_PET_SITE_URL=)\S+/g, "$1***");
}
function tailForTrim(content, keepBytes) {
	if (content.length <= keepBytes) return content;
	return content.subarray(content.length - keepBytes);
}
function formatLogLine(level, message, now) {
	return `${now.toISOString()} [${level}] ${message}\n`;
}
function createFileLogger(options) {
	const file = options.file;
	const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
	const keepBytes = Math.max(0, Math.min(options.keepBytes ?? LOG_KEEP_BYTES, maxBytes));
	const flushMs = options.flushIntervalMs ?? LOG_FLUSH_MS;
	const threshold = Math.max(1, options.flushThreshold ?? LOG_FLUSH_LINES);
	const maxPending = Math.max(threshold, options.maxPending ?? LOG_MAX_PENDING);
	const debugEnabled = options.debugEnabled ?? false;
	const now = options.now ?? (() => new Date());
	let pending = [];
	let dropped = 0;
	let flushing = null;
	let disposed = false;
	/** 目录只建一次（首次 flush 时）；失败后不再重试，日志静默降级 */
	let dirReady = null;
	const ensureDir = () => dirReady ?? (dirReady = mkdir(dirname(file), { recursive: true }).then(() => void 0).catch(() => void 0));
	const push = (level, message) => {
		if (level === "debug" && !debugEnabled) return;
		try {
			options.base?.[level]?.(message);
		} catch {}
		pending.push(formatLogLine(level, redactSensitive(String(message)), now()));
		if (pending.length > maxPending) {
			dropped += pending.length - maxPending;
			pending.splice(0, pending.length - maxPending);
		}
		if (pending.length >= threshold) flush();
	};
	const flush = async () => {
		for (;;) {
			if (flushing) {
				await flushing;
				continue;
			}
			if (pending.length === 0) return;
			const chunk = pending.join("");
			const droppedNote = dropped;
			pending = [];
			dropped = 0;
			flushing = (async () => {
				await ensureDir();
				try {
					if (droppedNote > 0) await appendFile(file, formatLogLine("warn", `日志缓冲溢出，丢弃 ${droppedNote} 条`, now()), "utf8");
					await appendFile(file, chunk, "utf8");
				} catch {
					return;
				}
				try {
					const info = await stat(file);
					if (info.size > maxBytes) {
						const content = await readFile(file);
						await writeFile(file, tailForTrim(content, keepBytes));
					}
				} catch {}
			})().finally(() => {
				flushing = null;
			});
			await flushing;
		}
	};
	const timer = setInterval(() => {
		flush();
	}, flushMs);
	timer.unref?.();
	const onExit = () => {
		if (pending.length === 0) return;
		const chunk = pending.join("");
		pending = [];
		try {
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, chunk, "utf8");
		} catch {}
	};
	process.once("exit", onExit);
	return {
		file,
		isFileLogger: true,
		info: (message) => push("info", message),
		warn: (message) => push("warn", message),
		error: (message) => push("error", message),
		debug: (message) => push("debug", message),
		flush,
		dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			process.removeListener("exit", onExit);
			flush();
		}
	};
}
/**
* 模块级默认出口——给拿不到 `ctx.logger` 的纯模块用（./config、./chat、./whisper）。
*
* 这些模块是纯函数，签名里不该为一条告警塞一个 logger，但它们的 warn 同样是桌面版用户唯一能
* 看到的线索。宿主在 apply 开始时 `setDefaultLogger(log)`，之后直接 `defaultLog('warn', ...)`；
* 单测或极早期没有 logger 时退回 console，行为不变。
*/
let defaultLogger = null;
function setDefaultLogger(logger) {
	defaultLogger = logger;
}
function defaultLog(level, message) {
	const sink = defaultLogger?.[level];
	if (sink) {
		sink.call(defaultLogger, message);
		return;
	}
	if (level === "debug") {
		if (process.env.DSH_PET_LOG_DEBUG === "1") console.debug(message);
		return;
	}
	if (level === "info") console.info(message);
	else if (level === "warn") console.warn(message);
	else console.error(message);
}

//#endregion
//#region src/host/model-selection.ts
function configuredModel(conf, key) {
	const raw = conf?.[key];
	if (!raw || typeof raw !== "object") return void 0;
	const m = raw;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return void 0;
	const provider = m.provider.trim();
	const model = m.model.trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function currentModel(ctx) {
	try {
		const sel = ctx.agentDefaultModel?.currentSelection();
		return sel?.provider && sel?.model ? {
			provider: sel.provider,
			model: sel.model
		} : void 0;
	} catch {
		return void 0;
	}
}
function modelCandidates(ctx, preferred) {
	const out = [];
	const push = (m) => {
		if (!m) return;
		if (out.some((x) => x.provider === m.provider && x.model === m.model)) return;
		out.push(m);
	};
	push(preferred);
	push(currentModel(ctx));
	return out;
}
function modelLabel(m) {
	return m.provider + "/" + m.model;
}

//#endregion
//#region src/host/whisper.ts
/** 单次生成超时（ms）：碎碎念不需要长输出，30s 足够。 */
const TIMEOUT_MS$1 = 3e4;
/** 碎碎念指令：纯文本（没有配图时的原样请求）。 */
const USER_TEXT = "随便说一句日常碎碎念，一句就好，20 字以内。";
/**
* 碎碎念指令：带表情包时要求模型配合作画说一句。
*
* 明确「正文仍是一句话」：图是配图，不是让模型描述画面本身。
* 图由调用方随机抽而不是让模型选：碎碎念没有上下文可依（人设固定、无用户输入），
* 交模型选只能盲选，还多一层幻觉风险。
*/
function userTextWithMeme(meme) {
	return "随便说一句日常碎碎念，一句就好，20 字以内。\n这次会配一张表情包一起显示，图的内容是：" + meme.name + "（" + meme.desc + "）。\n请让这句话和这张图的情绪/场景自然契合，像是配合画面说出来的；不要描述画面本身。";
}
async function generateWhisper(ctx, system, meme, preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith$1(ctx, llm, sel, system, meme);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) defaultLog("warn", `dsh-pet: 碎碎念用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用一个确定的 provider/model 跑一次生成（候选链的一环；失败原样返回结构化原因，不吞）。 */
async function generateWith$1(ctx, llm, sel, system, meme) {
	const deadline = AbortSignal.timeout(TIMEOUT_MS$1);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [createUserMessage({
			content: [{
				type: "text",
				text: meme ? userTextWithMeme(meme) : USER_TEXT
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	return meme ? {
		ok: true,
		text,
		image: meme.name
	} : {
		ok: true,
		text
	};
}

//#endregion
//#region src/host/whisper-policy.ts
function automaticWhisperSchedule(policy, petEnabled, configuredPeriodSec) {
	if (!policy) return {
		enabled: petEnabled,
		periodSec: configuredPeriodSec
	};
	const period = policy.whisperIntervalSec();
	return {
		enabled: petEnabled && policy.isReady() && policy.canWhisper(),
		periodSec: Number.isFinite(period) ? Math.max(60, period) : 300
	};
}

//#endregion
//#region src/host/memes.ts
function readMemePool(memes, dirs) {
	if (!memes || typeof memes !== "object" || Array.isArray(memes)) return [];
	if (dirs.length === 0) return [];
	const out = [];
	for (const [name$1, desc] of Object.entries(memes)) {
		const text = typeof desc === "string" ? desc.trim() : "";
		if (!name$1 || !text) continue;
		if (!dirs.some((dir) => existsSync(join(dir, name$1 + ".png")))) continue;
		out.push({
			name: name$1,
			desc: text
		});
	}
	return out;
}
function pickMeme(pool, random = Math.random) {
	if (pool.length === 0) return void 0;
	const idx = Math.floor(random() * pool.length) % pool.length;
	return pool[idx];
}
function matchMeme(pool, name$1) {
	const key = String(name$1 ?? "").trim();
	return key ? pool.find((m) => m.name === key) : void 0;
}
/** 配图选择标记：`[图:名称]` 附在回复末尾（容忍全角冒号与前后空白）。 */
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
function extractChatImage(text, pool) {
	const m = IMG_TAG.exec(text);
	if (!m) return { text };
	const hit = matchMeme(pool, m[1] ?? "");
	const body = text.slice(0, m.index).trim();
	if (!hit || !body) return { text };
	return {
		text: body,
		image: hit.name
	};
}
function memeCatalog(pool) {
	return pool.map((m) => "- " + m.name + "：" + m.desc).join("\n");
}
function limitPool(pool, limit) {
	const n = Math.floor(Number(limit));
	if (!Number.isFinite(n) || n <= 0) return pool;
	return pool.slice(0, n);
}

//#endregion
//#region src/host/chat.ts
/** 单次生成超时（ms）：对话等 LLM 回复，60s 足够。 */
const TIMEOUT_MS = 6e4;
/** 配图指令：附在 user 正文之后（紧邻回答位置，模型更容易遵守）。
*  交给模型选而不是随机抽：对话有真实上下文（用户输入 + 历史），按语境挑才贴合。 */
function imageInstruction(pool) {
	return "\n\n[配图] 回复结尾可选附一张表情包给用户看，从下列清单里挑最贴合当前语境的：\n" + memeCatalog(pool) + "\n挑中就在回复最后另起一行写 [图:名称]（名称原样照抄）；没有合适的就完全不要写这个标记。";
}
async function generateChat(ctx, system, history, userText, pool = [], preferred) {
	const candidates = modelCandidates(ctx, preferred);
	if (candidates.length === 0) return {
		ok: false,
		reason: "provider-missing",
		message: "当前对话未配置模型"
	};
	const llm = ctx.llm;
	if (!llm || typeof llm.stream !== "function") return {
		ok: false,
		reason: "generate-error",
		message: "LLM 服务不可用"
	};
	let last = {
		ok: false,
		reason: "generate-error",
		message: noTextReason(void 0)
	};
	for (const [i, sel] of candidates.entries()) {
		const result = await generateWith(ctx, llm, sel, system, history, userText, pool);
		if (result.ok) return result;
		last = result;
		if (i + 1 < candidates.length) defaultLog("warn", `dsh-pet: 对话用 ${modelLabel(sel)} 生成失败（${result.message ?? result.reason}），回落到 ${modelLabel(candidates[i + 1])}`);
	}
	return last;
}
/** 用一个确定的 provider/model 跑一次对话生成（候选链的一环；失败原样返回结构化原因，不吞）。 */
async function generateWith(ctx, llm, sel, system, history, userText, pool) {
	const historyMessages = history.map((m) => m.role === "user" ? createUserMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: { kind: "user" }
	}) : createAssistantMessage({
		content: [{
			type: "text",
			text: m.content
		}],
		source: {
			provider: sel.provider,
			model: sel.model
		}
	}));
	const deadline = AbortSignal.timeout(TIMEOUT_MS);
	const supportsOff = await supportsReasoningOff(ctx, sel.provider, sel.model);
	const wantImage = pool.length > 0;
	const options = {
		provider: sel.provider,
		model: sel.model,
		sessionId: PET_CALL_IDENTITY,
		messages: [...historyMessages, createUserMessage({
			content: [{
				type: "text",
				text: wantImage ? userText + imageInstruction(pool) : userText
			}],
			source: { kind: "user" }
		})],
		system,
		temperature: 1,
		...supportsOff ? { reasoningEffort: ReasoningEffortId("off") } : {},
		signal: deadline
	};
	const assembler = new BlockAssembler();
	try {
		for await (const chunk of llm.stream(options)) assembler.push(chunk);
	} catch (e) {
		return {
			ok: false,
			reason: "generate-error",
			message: e instanceof Error ? e.message : String(e)
		};
	}
	const text = assembler.blocks().filter((b) => b.type === "text").map((b) => "text" in b ? b.text : "").join("").trim();
	if (!text) return {
		ok: false,
		reason: "generate-error",
		message: noTextReason(assembler.finish)
	};
	if (!wantImage) return {
		ok: true,
		text
	};
	const picked = extractChatImage(text, pool);
	return picked.image ? {
		ok: true,
		text: picked.text,
		image: picked.image
	} : {
		ok: true,
		text: picked.text
	};
}

//#endregion
//#region src/host/config.ts
/** 位置角落白名单 */
const CORNERS = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right"
];
const CORNER_SET = new Set(CORNERS);
/** display 白名单（导出：宿主路由 POST /pet-display 写单只宠物的显示位置时复用同一份枚举，
*  读写两侧必须同一份规则，不在路由里另写一个 Set） */
const PET_DISPLAYS = [
	"web",
	"desktop",
	"both",
	"none"
];
const PET_DISPLAY_SET = new Set(PET_DISPLAYS);
/** font.family 白名单（预设 id）——必须与 src/shared/fonts.ts 的 FONT_PRESETS 保持一致：
*  host 不能 import src/shared，这里是那份清单的自包含副本，加/删字体预设时两边都要改。 */
const FONT_FAMILY_SET = new Set([
	"candy",
	"yahei",
	"youyuan",
	"kaiti",
	"simsun",
	"comic",
	"system"
]);
/** font.size 合法区间（px，含端点）——与 src/shared/fonts.ts 的 FONT_SIZE_MIN / FONT_SIZE_MAX 同一口径 */
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 200;
const ID_FORBIDDEN = /[\\/:\x00-\x1f]/;
/**
* 「全局默认 + 种类可覆盖」的顶层字段白名单：这些是用户级成本 / 偏好 / 环境 / 节奏参数
* （chatMemoryRounds、两个模型、两个配图开关与张数上限、eventsRefreshSec、physics、confineToScreen、font），
* 不是「这个种类长什么样」，所以用户层写一次应对所有条目生效；种类文件仍可在自己顶层覆盖。
* 人设是例外：实例级 pets[].whisperPrompt 优先，回落由消费端做（./persona 的 petPersona）。
*/
const GLOBAL_DEFAULT_KEYS = [
	"physics",
	"font",
	"confineToScreen",
	"whisperImageEnabled",
	"chatImageEnabled",
	"chatImageLimit",
	"chatMemoryRounds",
	"whisperModel",
	"chatModel",
	"eventsRefreshSec"
];
/** 已告警过的 文件:字段（进程内去重：同一问题只告警一次，避免每请求刷屏；重启重置） */
const warnedKeys = new Set();
function warnOnce(key, message) {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	defaultLog("warn", "dsh-pet: " + message);
}
/** 仅删除字符串之外的 JSONC 注释，保留字符串转义、换行与相邻 JSON token 的分隔。 */
function stripJsonc(src) {
	let out = "";
	let inString = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inString) {
			out += ch;
			if (ch === "\\" && i + 1 < src.length) out += src[++i];
			else if (ch === "\"") inString = false;
		} else if (ch === "\"") {
			inString = true;
			out += ch;
		} else if (ch === "/" && src[i + 1] === "/") {
			out += " ";
			while (i + 1 < src.length && src[i + 1] !== "\r" && src[i + 1] !== "\n") i++;
		} else if (ch === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end === -1) throw new SyntaxError("Unterminated JSONC block comment");
			out += src.slice(i, end + 2).replace(/[^\r\n]/g, " ");
			i = end + 1;
		} else out += ch;
	}
	return out.trim();
}
/** 读取并解析 JSONC 文件；不存在/解析失败 → undefined（调用方决定处理） */
function readJsonc(path) {
	try {
		const raw = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		return raw && typeof raw === "object" ? raw : void 0;
	} catch {
		return void 0;
	}
}
function readUserConfig(paths) {
	const file = effectiveUserFile(paths);
	return file ? readJsonc(file) : void 0;
}
function userConfigUnparsable(paths) {
	const file = effectiveUserFile(paths);
	return file !== void 0 && readJsonc(file) === void 0;
}
/** 实际生效的用户层文件：优先 .jsonc；不存在则回落到旧的 .json（迁移前的老用户）；
*  两者都不存在 → undefined（首次使用，无用户层）。 */
function effectiveUserFile(paths) {
	if (existsSync(paths.userFile)) return paths.userFile;
	if (paths.legacyUserFile && existsSync(paths.legacyUserFile)) return paths.legacyUserFile;
	return void 0;
}
function migrateUserConfig(paths, log) {
	const legacy = paths.legacyUserFile;
	if (!legacy || !existsSync(legacy) || existsSync(paths.userFile)) return false;
	try {
		renameSync(legacy, paths.userFile);
	} catch {
		return false;
	}
	log?.(`用户配置已迁移到 JSONC：${legacy} → ${paths.userFile}`);
	return true;
}
/** 扫描 pet/ 目录：<名>-config.(json|jsonc) → 条目（按文件名排序） */
function scanPetFiles(petDir) {
	let entries;
	try {
		entries = readdirSync(petDir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((e) => e.isFile()).map((e) => e.name).filter((name$1) => /^.+?-config\.(json|jsonc)$/.test(name$1)).sort().map((name$1) => ({
		prefix: name$1.replace(/-config\.(json|jsonc)$/, ""),
		path: join(petDir, name$1)
	}));
}
function readPetConfigEntry(paths, entry) {
	const hit = scanPetFiles(paths.petDir).find((f) => f.prefix === entry);
	return hit ? {
		path: hit.path,
		raw: readJsonc(hit.path)
	} : void 0;
}
/** animations 段完整性校验（与旧 assertAnimationsHost 同一套规则；不 throw，非法返回 false） */
function animationsValid(a) {
	if (!a || typeof a !== "object") return false;
	const anims = a;
	for (const key of [
		"idle",
		"turn",
		"drag",
		"clicks"
	]) if (!Array.isArray(anims[key])) return false;
	const moves = anims.moves;
	if (!moves || typeof moves !== "object" || typeof moves.default !== "object" || moves.default === null || !Array.isArray(moves.actions)) return false;
	if (!Array.isArray(anims.categories)) return false;
	const ev = anims.events;
	if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
	const evEntries = ev;
	for (const pool of Object.values(evEntries)) {
		if (!Array.isArray(pool) || pool.length === 0) return false;
		for (const slot of pool) if (typeof slot === "string") {
			if (slot.length === 0) return false;
		} else if (Array.isArray(slot)) {
			if (slot.length === 0) return false;
			for (const name$1 of slot) if (typeof name$1 !== "string" || name$1.length === 0) return false;
		} else return false;
	}
	const balance = evEntries.balance;
	return Array.isArray(balance) && balance.length > 0;
}
/** animationWeights 段校验（idle/turn/move 三个非负数字） */
function weightsValid(w) {
	if (!w || typeof w !== "object") return false;
	const weights = w;
	for (const key of [
		"idle",
		"turn",
		"move"
	]) {
		const v = Number(weights[key]);
		if (!Number.isFinite(v) || v < 0) return false;
	}
	return true;
}
/** physics 段校验：gravity ≥ 0（0 = 无重力，合法）、restitution ∈ [0,1]、groundFriction ≥ 0（均为有限数字）、
*  ceilingBounce 为布尔、throwPower > 0（有限数字）、petCollision 为布尔 */
function physicsValid(value) {
	if (!value || typeof value !== "object") return false;
	const p = value;
	const g = Number(p.gravity);
	const r = Number(p.restitution);
	const f = Number(p.groundFriction);
	const tp = Number(p.throwPower);
	return Number.isFinite(g) && g >= 0 && Number.isFinite(r) && r >= 0 && r <= 1 && Number.isFinite(f) && f >= 0 && typeof p.ceilingBounce === "boolean" && Number.isFinite(tp) && tp > 0 && typeof p.petCollision === "boolean";
}
/** font 段校验：family ∈ 预设白名单、size 为区间内的有限数字、followPet 为布尔。
*  与 physics 同口径：整段校验——任一子键缺失/非法即整段非法（告警 + 取默认），
*  不做「缺子键逐个补默认」；对象字段一律整段替换。 */
function fontValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const f = value;
	if (typeof f.family !== "string" || !FONT_FAMILY_SET.has(f.family)) return false;
	const size = Number(f.size);
	if (!Number.isFinite(size) || size < FONT_SIZE_MIN || size > FONT_SIZE_MAX) return false;
	return typeof f.followPet === "boolean";
}
/** whisperModel / chatModel 段校验：{ provider, model } 两个字符串，
*  要么都留空（= 跟随当前对话的模型）要么都非空——只填一半会拼出「用 A 家的模型名去问 B 家」
*  这种必然失败的组合，按非法处理（告警 + 取默认）。 */
function modelSelectionValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value;
	if (typeof m.provider !== "string" || typeof m.model !== "string") return false;
	return m.provider.trim() === "" === (m.model.trim() === "");
}
/** workStatusTexts 段校验：二维数组——外层每项都是非空字符串数组（档位文案，每档可多句随机）；空数组不可用 */
function workStatusTextsValid(value) {
	if (!Array.isArray(value) || value.length === 0) return false;
	for (const group of value) {
		if (!Array.isArray(group) || group.length === 0) return false;
		for (const text of group) if (typeof text !== "string" || text.length === 0) return false;
	}
	return true;
}
/** 顶层标量字段的合法性（非法与缺失同处理：取默认值 + 告警） */
function topFieldValid(key, value) {
	switch (key) {
		case "whisperPrompt": return typeof value === "string" && value.length > 0;
		case "chatMemoryRounds": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "chatImageLimit": {
			const n = Number(value);
			return Number.isFinite(n) && n >= 0;
		}
		case "notificationsEnabled": return typeof value === "boolean";
		case "clickSoundEnabled": return typeof value === "boolean";
		case "whisperImageEnabled": return typeof value === "boolean";
		case "chatImageEnabled": return typeof value === "boolean";
		case "confineToScreen": return typeof value === "boolean";
		case "trayEnabled": return typeof value === "boolean";
		case "animations": return animationsValid(value);
		case "animationWeights": return weightsValid(value);
		case "eventsRefreshSec": return eventsRefreshSecValid(value);
		case "physics": return physicsValid(value);
		case "font": return fontValid(value);
		case "whisperModel":
		case "chatModel": return modelSelectionValid(value);
		case "workStatusTexts": return workStatusTextsValid(value);
		default: return true;
	}
}
/**
* eventsRefreshSec 段校验：事件名 → 间隔秒（正的有限数字）。
* 这是整段替换字段：缺的键由消费端各自兜底（1800 / 300），多写的键原样保留；空对象合法。
*/
function eventsRefreshSecValid(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	for (const v of Object.values(value)) {
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) return false;
	}
	return true;
}
/**
* 文件宠物条目的合并基座：内置默认 + 白名单字段改用用户层的值。那 9 个字段是用户级成本/偏好/
* 环境/节奏参数，不是种类属性，用户在设置页改一次应让所有宠物（含 pet pack）都生效。
* 语义仍是「种类可覆盖」：种类文件顶层写了自己的值就走 overlay 覆盖；用户层写了但非法的值直接跳过。
*/
function packBase(base, mainOverlay) {
	if (!mainOverlay) return base;
	let out;
	for (const key of GLOBAL_DEFAULT_KEYS) {
		const own = mainOverlay[key];
		if (own === void 0 || !topFieldValid(key, own)) continue;
		out ?? (out = { ...base });
		out[key] = own;
	}
	return out ?? base;
}
/** 一个覆盖文件 → 完整条目：顶层逐字段合并（没写/非法 → 内置默认 + 告警），pets 逐实例 */
function mergeEntry(base, overlay, label, basePets, seenIds) {
	const out = {};
	for (const key of Object.keys(base)) {
		if (key === "pets") {
			out.pets = mergePets(basePets, overlay?.[key], label, seenIds);
			continue;
		}
		const own = overlay ? overlay[key] : void 0;
		if (own === void 0) {
			out[key] = base[key];
			continue;
		}
		if (!topFieldValid(key, own)) {
			warnOnce(`${label}:${key}`, `「${label}」的 ${key} 非法，已取默认值`);
			out[key] = base[key];
			continue;
		}
		out[key] = own;
	}
	return out;
}
/** pets 数组合并：文件没写/空 → 默认列表；逐实例合并（缺字段 → 内置默认 pets[0]，静默）。 */
function mergePets(basePets, raw, label, seenIds) {
	const basePet = basePets[0] ?? {};
	if (!Array.isArray(raw) || raw.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 缺失或为空，已取默认宠物列表`);
		return basePets;
	}
	const out = [];
	for (const item of raw) {
		const pet = mergePet(basePet, item, label, seenIds);
		if (pet) out.push(pet);
	}
	if (out.length === 0) {
		warnOnce(`${label}:pets`, `「${label}」的 pets 全部被跳过（id 非法/重复/冲突），已取默认宠物列表`);
		return basePets;
	}
	return out;
}
/** 宠物实例字段取数字；缺失 → 静默取默认（结构性常态）；显式写但非法 → 告警 + 默认 */
function petNumber(own, def, min, label, field, id) {
	const n = Number(own);
	if (own !== void 0 && own !== null && Number.isFinite(n) && n >= min) return n;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Number(def);
}
/** 宠物实例字段取布尔；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petBool(own, def, label, field, id) {
	if (typeof own === "boolean") return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return Boolean(def);
}
/** 宠物实例字段取白名单枚举；缺失 → 静默取默认；显式写但非法 → 告警 + 默认 */
function petEnum(own, set, def, label, field, id) {
	if (typeof own === "string" && set.has(own)) return own;
	if (own !== void 0 && own !== null) warnOnce(`${label}:${field}:${id}`, `宠物「${id}」的 ${field} 非法，已取默认值`);
	return typeof def === "string" ? def : "";
}
/** 一只实例 → 完成品实例（id 必须自己的且全局唯一；其余字段没写/非法 → 默认 + 告警） */
function mergePet(base, raw, label, seenIds) {
	const p = raw && typeof raw === "object" ? raw : {};
	const id = typeof p.id === "string" ? p.id.trim() : "";
	if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) {
		warnOnce(`${label}:id:${id || "(空)"}`, `「${label}」的宠物 id「${id || "(空)"}」非法、重复或已存在，已跳过该实例`);
		return null;
	}
	seenIds.add(id);
	const rawName = typeof p.name === "string" ? p.name.trim() : "";
	const name$1 = rawName || id;
	if (!rawName) warnOnce(`${label}:name:${id}`, `宠物「${id}」缺少 name，已按 id 处理`);
	const basePos = base.position && typeof base.position === "object" ? base.position : {};
	const ownPos = p.position && typeof p.position === "object" ? p.position : {};
	return {
		id,
		name: name$1,
		size: petNumber(p.size, base.size, 1, label, "size", id),
		balanceEnabled: petBool(p.balanceEnabled, base.balanceEnabled, label, "balanceEnabled", id),
		whisperEnabled: petBool(p.whisperEnabled, base.whisperEnabled, label, "whisperEnabled", id),
		workStatusEnabled: petBool(p.workStatusEnabled, base.workStatusEnabled, label, "workStatusEnabled", id),
		fixedEnabled: petBool(p.fixedEnabled, base.fixedEnabled, label, "fixedEnabled", id),
		display: petEnum(p.display, PET_DISPLAY_SET, base.display, label, "display", id),
		position: {
			corner: petEnum(ownPos.corner, CORNER_SET, basePos.corner, label, "position.corner", id),
			marginX: petNumber(ownPos.marginX, basePos.marginX, -Infinity, label, "position.marginX", id),
			marginY: petNumber(ownPos.marginY, basePos.marginY, -Infinity, label, "position.marginY", id)
		},
		...petPersonaField(p.whisperPrompt, label, id)
	};
}
/**
* 实例级 whisperPrompt 的合并：写了非空字符串 → 原样带出；否则返回空对象（该键不出现）。
* 显式写了非字符串（数字/对象/布尔）才算配置错误 → 告警一次并忽略（回落条目），与 petNumber 同口径。
*/
function petPersonaField(own, label, id) {
	if (typeof own === "string") return own.trim() === "" ? {} : { whisperPrompt: own };
	if (own !== void 0 && own !== null) warnOnce(`${label}:whisperPrompt:${id}`, `宠物「${id}」的 whisperPrompt 非法，已忽略（回落所属条目人设）`);
	return {};
}
function readAllConfig(paths) {
	const base = readJsonc(paths.defaultFile);
	if (!base) throw new Error("dsh-pet: 内置默认配置缺失或解析失败（安装损坏）：" + paths.defaultFile);
	const basePets = Array.isArray(base.pets) ? base.pets : [];
	const seenIds = new Set();
	const out = {};
	const userFile = effectiveUserFile(paths);
	const mainOverlay = userFile ? readJsonc(userFile) : void 0;
	if (userFile && !mainOverlay) warnOnce("file:" + userFile, "用户主配置解析失败，已按无用户配置处理：" + userFile);
	out.main = mergeEntry(base, mainOverlay, "main-config.jsonc", basePets, seenIds);
	const filePetBase = packBase(base, mainOverlay);
	for (const file of scanPetFiles(paths.petDir)) {
		const parsed = readJsonc(file.path);
		if (!parsed) {
			warnOnce("file:" + file.path, "文件宠物配置解析失败，已跳过：" + file.path);
			continue;
		}
		out[file.prefix] = mergeEntry(filePetBase, parsed, file.prefix + "-config.json", basePets, seenIds);
	}
	return out;
}
function flattenPetList(merged) {
	const out = [];
	for (const conf of Object.values(merged)) if (Array.isArray(conf?.pets)) out.push(...conf.pets);
	return out;
}
function findPetInstance(merged, petId) {
	for (const [entry, conf] of Object.entries(merged)) {
		const pets = Array.isArray(conf?.pets) ? conf.pets : [];
		const found = pets.find((p) => String(p.id) === petId);
		if (found) return {
			entry,
			conf,
			pet: found
		};
	}
	return void 0;
}
function saveUserConfig(raw, existing) {
	const o = raw && typeof raw === "object" ? raw : {};
	const arr = Array.isArray(o.pets) ? o.pets : null;
	if (!arr || !arr.length) return null;
	const out = [];
	const seenIds = new Set();
	for (const p of arr) {
		if (!p || typeof p !== "object") return null;
		const pp = p;
		const id = typeof pp.id === "string" ? pp.id.trim() : "";
		if (!id || id.length > 64 || ID_FORBIDDEN.test(id) || seenIds.has(id)) return null;
		seenIds.add(id);
		const size = Number(pp.size);
		if (!Number.isFinite(size) || size <= 0) return null;
		let name$1 = typeof pp.name === "string" ? pp.name.trim() : "";
		if (!name$1) {
			defaultLog("warn", `dsh-pet: pet「${id}」缺少 name，已按默认 ${id}（宠物 id）处理`);
			name$1 = id;
		}
		const balanceEnabled = pp.balanceEnabled;
		if (typeof balanceEnabled !== "boolean") return null;
		const whisperEnabled = pp.whisperEnabled;
		if (whisperEnabled !== void 0 && typeof whisperEnabled !== "boolean") return null;
		const workStatusEnabled = pp.workStatusEnabled;
		if (workStatusEnabled !== void 0 && typeof workStatusEnabled !== "boolean") return null;
		const fixedEnabled = pp.fixedEnabled;
		if (fixedEnabled !== void 0 && typeof fixedEnabled !== "boolean") return null;
		const display = String(pp.display ?? "");
		if (!PET_DISPLAY_SET.has(display)) return null;
		const pos = pp.position && typeof pp.position === "object" ? pp.position : {};
		const corner = String(pos.corner ?? "");
		if (!CORNER_SET.has(corner)) return null;
		const marginX = Number(pos.marginX);
		const marginY = Number(pos.marginY);
		if (!Number.isFinite(marginX) || !Number.isFinite(marginY)) return null;
		const rawPersona = pp.whisperPrompt;
		if (rawPersona !== void 0 && rawPersona !== null && typeof rawPersona !== "string") return null;
		const persona = typeof rawPersona === "string" ? rawPersona.trim() : "";
		const pet = {
			id,
			name: name$1,
			size,
			balanceEnabled,
			whisperEnabled,
			workStatusEnabled,
			fixedEnabled,
			display,
			position: {
				corner,
				marginX,
				marginY
			}
		};
		if (persona) pet.whisperPrompt = persona;
		out.push(pet);
	}
	const ne = o.notificationsEnabled;
	if (ne !== void 0 && typeof ne !== "boolean") return null;
	const cse = o.clickSoundEnabled;
	if (cse !== void 0 && typeof cse !== "boolean") return null;
	const wie = o.whisperImageEnabled;
	if (wie !== void 0 && typeof wie !== "boolean") return null;
	const cie = o.chatImageEnabled;
	if (cie !== void 0 && typeof cie !== "boolean") return null;
	const cts = o.confineToScreen;
	if (cts !== void 0 && typeof cts !== "boolean") return null;
	const te = o.trayEnabled;
	if (te !== void 0 && typeof te !== "boolean") return null;
	const ph = o.physics;
	if (ph !== void 0 && !physicsValid(ph)) return null;
	const fo = o.font;
	if (fo !== void 0 && !fontValid(fo)) return null;
	const wm = o.whisperModel;
	if (wm !== void 0 && !modelSelectionValid(wm)) return null;
	const cm = o.chatModel;
	if (cm !== void 0 && !modelSelectionValid(cm)) return null;
	const cmr = o.chatMemoryRounds;
	if (cmr !== void 0 && !topFieldValid("chatMemoryRounds", cmr)) return null;
	const cil = o.chatImageLimit;
	if (cil !== void 0 && !topFieldValid("chatImageLimit", cil)) return null;
	const cleanModel = (v) => ({
		provider: String(v.provider).trim(),
		model: String(v.model).trim()
	});
	const outConfig = { pets: out };
	if (ne !== void 0) outConfig.notificationsEnabled = ne;
	if (cse !== void 0) outConfig.clickSoundEnabled = cse;
	if (wie !== void 0) outConfig.whisperImageEnabled = wie;
	if (cie !== void 0) outConfig.chatImageEnabled = cie;
	if (cts !== void 0) outConfig.confineToScreen = cts;
	if (te !== void 0) outConfig.trayEnabled = te;
	if (ph !== void 0) outConfig.physics = ph;
	if (fo !== void 0) outConfig.font = fo;
	if (wm !== void 0) outConfig.whisperModel = cleanModel(wm);
	if (cm !== void 0) outConfig.chatModel = cleanModel(cm);
	if (cmr !== void 0) outConfig.chatMemoryRounds = Number(cmr);
	if (cil !== void 0) outConfig.chatImageLimit = Number(cil);
	const bodyOwned = new Set(["pets"]);
	if (ne !== void 0) bodyOwned.add("notificationsEnabled");
	if (cse !== void 0) bodyOwned.add("clickSoundEnabled");
	if (wie !== void 0) bodyOwned.add("whisperImageEnabled");
	if (cie !== void 0) bodyOwned.add("chatImageEnabled");
	if (cts !== void 0) bodyOwned.add("confineToScreen");
	if (te !== void 0) bodyOwned.add("trayEnabled");
	if (ph !== void 0) bodyOwned.add("physics");
	if (fo !== void 0) bodyOwned.add("font");
	if (wm !== void 0) bodyOwned.add("whisperModel");
	if (cm !== void 0) bodyOwned.add("chatModel");
	if (cmr !== void 0) bodyOwned.add("chatMemoryRounds");
	if (cil !== void 0) bodyOwned.add("chatImageLimit");
	if (existing && typeof existing === "object") for (const key of Object.keys(existing)) {
		if (bodyOwned.has(key)) continue;
		outConfig[key] = existing[key];
	}
	return outConfig;
}
function syncUserConfigFromDefault(paths) {
	const raw = readFileSync(paths.defaultFile, "utf8");
	mkdirSync(dirname(paths.userFile), { recursive: true });
	writeFileSync(paths.userFile, raw, "utf8");
}
function sliceMemoryRounds(messages, rounds) {
	return rounds > 0 ? messages.slice(-Math.floor(rounds) * 2) : [];
}

//#endregion
//#region src/host/anim.ts
/** 配置里的池子收窄：非数组、非字符串项一律丢弃。 */
function strings(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
}
/** 朝向收窄：只认两个字面量，其余（大小写、空白、非字符串）一律不算。 */
const petFacing = (v) => v === "left" || v === "right" ? v : null;
function animationNames(animations) {
	const a = animations && typeof animations === "object" ? animations : {};
	const out = [];
	const push = (names) => {
		for (const n of names) if (!out.includes(n)) out.push(n);
	};
	push(strings(a.idle));
	push(strings(a.turn));
	push(strings(a.drag));
	push(strings(a.clicks));
	const moves = a.moves && typeof a.moves === "object" ? a.moves : {};
	push(Array.isArray(moves.actions) ? moves.actions.map((m) => m && typeof m === "object" ? m.name : void 0).filter((x) => typeof x === "string" && x !== "") : []);
	if (Array.isArray(a.categories)) {
		for (const c of a.categories) if (c && typeof c === "object") push(strings(c.actions));
	}
	const events = a.events && typeof a.events === "object" ? a.events : {};
	for (const key of Object.keys(events)) {
		const pool = events[key];
		if (!Array.isArray(pool)) continue;
		const names = [];
		for (const slot of pool) if (typeof slot === "string") names.push(slot);
		else names.push(...strings(slot));
		push(names);
	}
	return out;
}
function normalizeHttpUrl(v) {
	if (typeof v !== "string") return null;
	const raw = v.trim();
	if (!raw) return null;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return raw;
}
function decideAnim(args) {
	const { cfg, requested } = args;
	const name$1 = typeof args.name === "string" ? args.name.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (name$1 && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 与 url 只能给一个"
	};
	if (!name$1 && !rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "name 或 url 必须给一个"
	};
	let facing;
	if (args.facing !== void 0 && args.facing !== null) {
		const f = petFacing(args.facing);
		if (f === null) return {
			ok: false,
			reason: "bad-request",
			message: "facing 必须是 left / right"
		};
		facing = f;
	}
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			url,
			facing
		};
	}
	const allowed = animationNames(found.conf.animations);
	if (!allowed.includes(name$1)) return {
		ok: false,
		reason: "unknown-animation",
		message: "没有这个动画：" + name$1
	};
	return {
		ok: true,
		petId,
		name: name$1,
		facing
	};
}

//#endregion
//#region src/host/broadcast.ts
/** 气泡默认显示时长（ms）——与两端消费侧的常量同值（host 不得 import src/shared，只能各写一份）。
*  它只用于把缺省解析成显式值写进叶子，让 /state 里能看到实际生效的时长。 */
const DEFAULT_BUBBLE_DURATION_MS = 10 * 1e3;
function normalizeBroadcastText(text) {
	return typeof text === "string" ? text.trim() : "";
}
function normalizeBroadcastDuration(duration) {
	if (duration === void 0 || duration === null) return DEFAULT_BUBBLE_DURATION_MS;
	if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) return null;
	return duration;
}
function normalizeBroadcastAnim(anim) {
	return anim !== false;
}
/**
* `?pet=` → 实际落点（与 ./anim、./motion-cue 同一口径）：必填且必须真实存在。
*
* 两种失败分开报（绝不默认退到列表第一只）：没给 → pet-required，给了但配置里没有 → unknown-pet。
*/
function resolvePetId(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	const found = findPetInstance(cfg, petId);
	if (!found) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId,
		entry: found.entry,
		conf: found.conf
	};
}
function decideBroadcast(args) {
	const { cfg, requested, memeDirs } = args;
	const text = normalizeBroadcastText(args.text);
	if (!text) return {
		ok: false,
		reason: "bad-request",
		message: "text 为空"
	};
	const who = resolvePetId(cfg, requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	const petId = who.petId;
	const rawImage = typeof args.image === "string" ? args.image.trim() : "";
	const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
	if (rawImage && rawUrl) return {
		ok: false,
		reason: "bad-request",
		message: "image 与 url 只能给一个"
	};
	if (!rawImage && !rawUrl) return {
		ok: true,
		petId,
		text,
		duration: args.duration,
		anim: args.anim
	};
	if (rawUrl) {
		const url = normalizeHttpUrl(rawUrl);
		if (url === null) return {
			ok: false,
			reason: "bad-request",
			message: "url 必须是 http/https 的完整地址"
		};
		return {
			ok: true,
			petId,
			text,
			url,
			duration: args.duration,
			anim: args.anim
		};
	}
	const hit = matchMeme(readMemePool(who.conf.memes, memeDirs(who.entry)), rawImage);
	if (!hit) return {
		ok: false,
		reason: "unknown-image",
		message: "配图不在表情包池内：" + rawImage
	};
	return {
		ok: true,
		petId,
		text,
		image: hit.name,
		duration: args.duration,
		anim: args.anim
	};
}
function decideBubbleClear(args) {
	const who = resolvePetId(args.cfg, args.requested);
	if (!who.ok) return {
		ok: false,
		reason: who.reason,
		message: who.message
	};
	return {
		ok: true,
		petId: who.petId
	};
}

//#endregion
//#region src/host/lock.ts
const LOCK_DEFAULT_TTL_MS = 2 * 60 * 1e3;
const LOCK_MIN_TTL_MS = 1 * 1e3;
const LOCK_MAX_TTL_MS = 30 * 60 * 1e3;
/** cause → 给人看的一句话（回执里的 message；reason 才是机器读的那个）。 */
const CAUSE_TEXT = {
	expired: "占用已过期（没有及时续期）",
	released: "占用已被释放",
	preempted: "占用已被用户接管（拖拽/点击/隐藏/关闭）",
	unknown: "lock 不是当前生效的占用编号"
};
/** ttl 合法性说明（路由与决策层共用同一条规则，免得两处走样）。 */
const TTL_TEXT = `ttl 必须是 ${LOCK_MIN_TTL_MS}~${LOCK_MAX_TTL_MS} 之间的有限数字（毫秒）`;
function normalizeLockTtl(ttl, fallback) {
	if (ttl === void 0 || ttl === null) return fallback;
	if (typeof ttl !== "number" || !Number.isFinite(ttl)) return null;
	if (ttl < LOCK_MIN_TTL_MS || ttl > LOCK_MAX_TTL_MS) return null;
	return ttl;
}
/** lockId 规范化：缺省 / null → 空串（= 没给，走新建那条路）；非字符串 → null（非法）。
*  空串按「没给」处理是有意的（与 image / url 的宽松口径一致）。 */
function normalizeLockId(v) {
	if (v === void 0 || v === null) return "";
	if (typeof v !== "string") return null;
	return v.trim();
}
var LockStore = class {
	constructor(opts) {
		this.locks = new Map();
		this.tombstones = new Map();
		this.seq = 0;
		this.now = opts?.now ?? Date.now;
		this.onChange = opts?.onChange ?? (() => {});
	}
	/**
	* 当前占用（懒判过期）。到点即视为没有：清记录、记墓碑、同步一次叶子。
	*
	* 读方法带一次副作用是有意的：叶子是渲染端唯一能看到的信号，而宿主这一侧没有任何定时器——
	* 任一动作端点或内部来源调一次本方法，过期的锁就会被清掉并如实写进 S；即便一次都没人调，
	* 渲染端也会按叶子里的 expiresAt 自己解除静止。
	*/
	current(petId) {
		const rec = this.locks.get(petId);
		if (rec === void 0) return null;
		if (this.now() < rec.expiresAt) return rec;
		this.drop(petId, rec, "expired");
		return null;
	}
	/** 这只宠物此刻是否被占用（宿主内部自动来源用它决定跳过；同样懒判过期）。 */
	locked(petId) {
		return this.current(petId) !== null;
	}
	/**
	* 当前是否有任意宠物被占用（测试 / 观测用，同 ./state 的 waiterCount）。
	*
	* 生产路径上没有人调它：占用期间要挡的两个全局段（sections.balance / sections.workStatus）是
	* 所有宠物共用一份，宿主跳过写入会连带静音别的宠物，所以那两处改由渲染端按宠物自己忽略。
	*/
	anyLocked() {
		for (const petId of [...this.locks.keys()]) if (this.current(petId) !== null) return true;
		return false;
	}
	/**
	* 动作端点的门禁（/anim、/broadcast、/position、/throw、/bubble/clear 共用）。
	*
	* 无锁时按有没有带编号分两条：没带 → 放行（没有占用的常态下，既有调用方一个字都不用改）；
	* 带了编号却查不到锁 → lock-lost。带了编号就说明调用方以为自己还持有，这时放行等于把「你把锁
	* 丢了」悄悄抹掉，它会以为演出还在继续。cause 从墓碑里取，从没建过锁就是 unknown。
	*/
	gate(petId, provided) {
		const rec = this.current(petId);
		if (rec !== null) {
			if (provided && provided === rec.lockId) return { ok: true };
			if (!provided) return {
				ok: false,
				reason: "lock-required",
				message: "这只桌宠正被占用，必须带 lock=<lockId>"
			};
			return {
				ok: false,
				reason: "lock-lost",
				cause: "unknown",
				message: CAUSE_TEXT.unknown
			};
		}
		if (!provided) return { ok: true };
		const cause = this.causeOf(petId, provided);
		return {
			ok: false,
			reason: "lock-lost",
			cause,
			message: CAUSE_TEXT[cause]
		};
	}
	/**
	* 取锁 / 续期（二合一：`lockId` 给了就是续期，没给就是新建；真值表见 openapi.yaml）。
	*
	* 「有 id + 当前无锁」一律报错，不复活：过期 / 被释放 / 被抢占之后拿旧编号来续期，不能借这条路
	* 把锁重新建起来——否则「我丢了锁」这件事会被悄悄抹掉，持锁者会以为演出还在继续。
	*/
	acquire(args) {
		const { petId } = args;
		const renewId = normalizeLockId(args.lockId);
		if (renewId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		const rec = this.current(petId);
		if (renewId) {
			if (rec === null || rec.lockId !== renewId) {
				const cause = rec === null ? this.causeOf(petId, renewId) : "unknown";
				return {
					ok: false,
					reason: "lock-lost",
					cause,
					message: CAUSE_TEXT[cause]
				};
			}
			const ttl$1 = normalizeLockTtl(args.ttl, rec.ttl);
			if (ttl$1 === null) return {
				ok: false,
				reason: "bad-request",
				message: TTL_TEXT
			};
			rec.ttl = ttl$1;
			rec.expiresAt = this.now() + ttl$1;
			this.onChange(petId, {
				locked: true,
				expiresAt: rec.expiresAt
			});
			return {
				ok: true,
				petId,
				lockId: rec.lockId,
				expiresAt: rec.expiresAt,
				renewed: true
			};
		}
		if (rec !== null) return {
			ok: false,
			reason: "locked",
			expiresAt: rec.expiresAt,
			message: "这只桌宠已被占用"
		};
		const ttl = normalizeLockTtl(args.ttl, LOCK_DEFAULT_TTL_MS);
		if (ttl === null) return {
			ok: false,
			reason: "bad-request",
			message: TTL_TEXT
		};
		const record = {
			lockId: this.newId(),
			ttl,
			expiresAt: this.now() + ttl
		};
		this.locks.set(petId, record);
		this.tombstones.delete(petId);
		this.onChange(petId, {
			locked: true,
			expiresAt: record.expiresAt
		});
		return {
			ok: true,
			petId,
			lockId: record.lockId,
			expiresAt: record.expiresAt,
			renewed: false
		};
	}
	/**
	* 释放。两种形态二选一：`lockId` = 持锁者收工（cause: released），
	* `force: true` = 渲染端在用户拖拽 / 点击 / 隐藏 / 关闭时调（cause: preempted）。
	*
	* 幂等：当前没有锁时回 ok（released: false）——「让锁消失」这个意图在空状态下已经成立；
	* 但有锁而 lockId 不匹配时必须报错（不许误放别人的锁），那是唯一一条释放也会失败的路。
	* force 只认严格 true：宽松口径会把误传当真，代价是撤掉别人的锁。
	*/
	release(args) {
		const { petId } = args;
		const force = args.force === true;
		const releaseId = normalizeLockId(args.lockId);
		if (releaseId === null) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 必须是字符串"
		};
		if (force && releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 与 force 只能给一个"
		};
		if (!force && !releaseId) return {
			ok: false,
			reason: "bad-request",
			message: "lockId 或 force 必须给一个"
		};
		const rec = this.current(petId);
		if (rec === null) return {
			ok: true,
			petId,
			released: false
		};
		if (!force && rec.lockId !== releaseId) return {
			ok: false,
			reason: "lock-lost",
			cause: "unknown",
			message: CAUSE_TEXT.unknown
		};
		this.drop(petId, rec, force ? "preempted" : "released");
		return {
			ok: true,
			petId,
			released: true
		};
	}
	/** 撤掉全部占用（插件卸载路径）：不这样做的话，渲染端要等 TTL 到点才解除静止。 */
	releaseAll() {
		for (const petId of [...this.locks.keys()]) {
			const rec = this.locks.get(petId);
			if (rec !== void 0) this.drop(petId, rec, "released");
		}
	}
	/** 撤锁并记墓碑（唯一改状态的出口：释放 / 抢占 / 过期都走它，保证叶子与墓碑不漏写）。 */
	drop(petId, rec, cause) {
		this.locks.delete(petId);
		this.tombstones.set(petId, {
			lockId: rec.lockId,
			cause
		});
		this.onChange(petId, { locked: false });
	}
	/** 墓碑查询：编号对得上就回它当初的 cause，否则 unknown（拿错编号 / 从来没有过）。 */
	causeOf(petId, lockId) {
		const stone = this.tombstones.get(petId);
		return stone !== void 0 && stone.lockId === lockId ? stone.cause : "unknown";
	}
	/** 新编号：`lk-<时间36>-<自增36>`（与 ./playback 的 playbackId 同一套，只保证一次运行内唯一）。 */
	newId() {
		return "lk-" + this.now().toString(36) + "-" + (++this.seq).toString(36);
	}
};

//#endregion
//#region src/host/menu.ts
/**
* 第三方右键菜单注册表（进程内存态，DSH 重启即清空，不落盘）。
*
* 注册方用自己的 owner 注册菜单项，再用同一个 owner 查「我这一项被点了没有、在哪只宠物上点的」；
* 不负责菜单渲染与点击命中（两端按 target 过滤后自己拼「更多」）。必须始终成立：注册是 owner 级的
* 整体覆盖，菜单项生命周期与插件一致；点击是闩锁不是队列（连点两次只看到一次）；查询即清空（读取
* 即消费，没确认也没重投）；一个 owner 只该有一个消费者，两个进程同时查会互抢。
* 限额见下方常量；契约见 API.md 与 openapi.yaml。
* @module dsh-pet/src/host/menu
*/
/** owner 长度上限。 */
const OWNER_MAX = 64;
/** 单个菜单项 label 长度上限（面板宽 150–240px，再长会被省略号截断）。 */
const LABEL_MAX = 32;
/** 每 owner 菜单项上限。 */
const ITEMS_MAX = 20;
/** 全局 owner 上限。 */
const OWNERS_MAX = 32;
const MENU_WAIT_MAX_MS = 1e4;
/** 控制字符（换行、制表等会把菜单布局搞炸，一律拒绝）。 */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
/** 合法的 target 取值。 */
const MENU_TARGETS = new Set([
	"web",
	"desktop",
	"both"
]);
/** 缺省 target = 两端都显示（= 加这个字段之前的行为）。 */
const DEFAULT_TARGET = "both";
/** 校验一个显示用字符串：必须是 string、trim 后非空、不超长、无控制字符。 */
function displayText(value, max) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (text === "" || text.length > max || CONTROL_CHARS.test(text)) return null;
	return text;
}
var MenuRegistry = class {
	constructor() {
		this.owners = new Map();
		this.waiters = new Map();
	}
	/**
	* 注册（整体覆盖）：`{ owner, labels: string[], target?: 'web' | 'desktop' | 'both' }`。
	*
	* 覆盖粒度是整个 owner：注册方每次用一份完整列表描述「我现在有什么」，不必关心上次注册了什么，
	* 也不会留下已下线的僵尸项。`target` 选填、缺省 `both`（老调用方零改动），与 labels 一起被覆盖。
	*/
	register(raw) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
			ok: false,
			reason: "bad-request",
			message: "body 必须是 { owner, labels, target? }"
		};
		const body = raw;
		const owner = displayText(body.owner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const rawLabels = body.labels;
		if (!Array.isArray(rawLabels) || rawLabels.length === 0) return {
			ok: false,
			reason: "invalid-labels",
			message: "labels 必须是非空数组"
		};
		if (rawLabels.length > ITEMS_MAX) return {
			ok: false,
			reason: "too-many-items",
			message: `每个 owner 最多 ${ITEMS_MAX} 项`
		};
		const labels = [];
		for (const rawLabel of rawLabels) {
			const label = displayText(rawLabel, LABEL_MAX);
			if (label === null) return {
				ok: false,
				reason: "invalid-label",
				message: `每个 label 必须是 1–${LABEL_MAX} 字符的字符串（禁控制字符）`
			};
			if (!labels.includes(label)) labels.push(label);
		}
		if (!this.owners.has(owner) && this.owners.size >= OWNERS_MAX) return {
			ok: false,
			reason: "too-many-owners",
			message: `最多 ${OWNERS_MAX} 个 owner`
		};
		const rawTarget = body.target;
		let target = DEFAULT_TARGET;
		if (rawTarget !== void 0 && rawTarget !== null) {
			if (typeof rawTarget !== "string" || !MENU_TARGETS.has(rawTarget)) return {
				ok: false,
				reason: "invalid-target",
				message: "target 只能是 web / desktop / both（不写 = both）"
			};
			target = rawTarget;
		}
		this.owners.set(owner, {
			target,
			items: new Map(labels.map((label) => [label, null]))
		});
		return { ok: true };
	}
	/**
	* 清掉一个 owner 的全部菜单项（连它上面未取走的触发标记一起丢）。
	*
	* 幂等：owner 本来就不存在 → `removed: 0`，仍算成功，调用方重试注销时不该看到错误。
	* 挂在该 owner 上的长轮询会被叫醒，醒来后查不到 owner → 路由回 `unknown-owner`。
	*/
	clear(rawOwner) {
		const owner = displayText(rawOwner, OWNER_MAX);
		if (owner === null) return {
			ok: false,
			reason: "invalid-owner",
			message: `owner 必须是 1–${OWNER_MAX} 字符的字符串（禁控制字符）`
		};
		const entry = this.owners.get(owner);
		if (!entry) return {
			ok: true,
			removed: 0
		};
		const removed = entry.items.size;
		this.owners.delete(owner);
		const waiters = this.waiters.get(owner);
		this.waiters.delete(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			removed
		};
	}
	/** 全量快照（写进 state；顺序 = 注册顺序 + 列表顺序，两端渲染顺序与它一致）。 */
	snapshot() {
		const out = [];
		for (const [owner, entry] of this.owners) for (const label of entry.items.keys()) out.push({
			owner,
			label,
			target: entry.target
		});
		return out;
	}
	/**
	* 渲染端上报一次点击：把该项标成「被 petId 点了」，并叫醒该 owner 上挂着的长轮询。
	*
	* `delivered = false`（项不存在：菜单刚好被覆盖、还没注册）不算错误——渲染端拿的是上一拍
	* /state 快照，这一拍菜单已经变了，属于正常竞态，路由仍回 200。
	*/
	click(raw) {
		const body = raw && typeof raw === "object" ? raw : {};
		const owner = typeof body.owner === "string" ? body.owner : "";
		const label = typeof body.label === "string" ? body.label : "";
		const pet = typeof body.pet === "string" ? body.pet.trim() : "";
		const entry = this.owners.get(owner);
		if (!entry || !entry.items.has(label) || pet === "") return {
			ok: true,
			delivered: false
		};
		entry.items.set(label, pet);
		const waiters = this.waiters.get(owner);
		if (waiters) for (const wake of [...waiters]) wake();
		return {
			ok: true,
			delivered: true
		};
	}
	/**
	* 查询触发：返回 `{ label: petId | null }` 全量映射，返回即清空这些标记。
	*
	* `waitMs > 0` 且当下没有任何触发 → 挂起等待（被点、超时、被覆盖都会唤醒），超时后照常返回
	* 全 null 的映射。owner 不存在 → null（路由回 404，调用方据此知道要重新注册）。
	*/
	async poll(owner, waitMs) {
		const entry = this.owners.get(owner);
		if (!entry) return null;
		if (waitMs > 0 && !hasFired(entry.items)) await new Promise((resolve$1) => {
			const set = this.waiters.get(owner) ?? new Set();
			this.waiters.set(owner, set);
			const hold = {};
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (hold.timer !== void 0) clearTimeout(hold.timer);
				set.delete(finish);
				if (set.size === 0 && this.waiters.get(owner) === set) this.waiters.delete(owner);
				resolve$1();
			};
			hold.timer = setTimeout(finish, Math.min(waitMs, MENU_WAIT_MAX_MS));
			set.add(finish);
		});
		const current = this.owners.get(owner);
		if (!current) return null;
		const out = {};
		for (const [label, pet] of current.items) {
			out[label] = pet;
			current.items.set(label, null);
		}
		return out;
	}
};
/** 该 owner 当前有没有任意一项被点过。 */
function hasFired(items) {
	for (const pet of items.values()) if (pet !== null) return true;
	return false;
}

//#endregion
//#region src/host/motion-cue.ts
const POSITION_MODES = [
	"instant",
	"spring",
	"line"
];
/** 夹到 0~1：归一化坐标的合法范围，越界夹取而不是拒绝（响应里回的就是夹取后的值）。 */
const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 有限数字收窄：字符串、布尔、NaN、Infinity 一律不算（配置里也这么判）。 */
const finite = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
/** 模式收窄：只认三个字面量（大小写、空白、非字符串一律不算），不认识返回 `null`。 */
const positionMode = (v) => typeof v === "string" && POSITION_MODES.includes(v) ? v : null;
/**
* 目标宠物解析（与 ./anim、./broadcast 同一口径）：`?pet=` 必填且必须真实存在。
* 两种失败分开报：没给 → `pet-required`；给了但配置里没有 → `unknown-pet`。
*/
function resolvePet(cfg, requested) {
	const petId = String(requested ?? "").trim();
	if (!petId) return {
		ok: false,
		reason: "pet-required",
		message: "pet 必填：要指定操作哪只桌宠"
	};
	if (!flattenPetList(cfg).some((p) => String(p.id) === petId)) return {
		ok: false,
		reason: "unknown-pet",
		message: "没有这只桌宠：" + petId
	};
	return {
		ok: true,
		petId
	};
}
function decidePosition(args) {
	const x = finite(args.x);
	if (x === null) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字"
	};
	const y = finite(args.y);
	if (y === null) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字"
	};
	const mode = positionMode(args.mode);
	if (mode === null) return {
		ok: false,
		reason: "bad-request",
		message: "mode 必须是 instant / spring / line"
	};
	let duration = null;
	if (mode === "line") {
		const d = finite(args.duration);
		if (d === null || d < 0) return {
			ok: false,
			reason: "bad-request",
			message: "line 模式的 duration 必须是非负有限数字（毫秒）"
		};
		duration = d;
	}
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	return {
		ok: true,
		petId: pet.petId,
		x: clamp01(x),
		y: clamp01(y),
		mode,
		duration
	};
}
const positionLeafData = (d) => d.duration === null ? {
	x: d.x,
	y: d.y,
	mode: d.mode
} : {
	x: d.x,
	y: d.y,
	mode: d.mode,
	duration: d.duration
};
function decideThrow(args) {
	const angle = finite(args.angle);
	if (angle === null) return {
		ok: false,
		reason: "bad-request",
		message: "angle 必须是有限数字"
	};
	const power = finite(args.power);
	if (power === null || power <= 0) return {
		ok: false,
		reason: "bad-request",
		message: "power 必须是大于 0 的有限数字"
	};
	const pet = resolvePet(args.cfg, args.requested);
	if (!pet.ok) return pet;
	return {
		ok: true,
		petId: pet.petId,
		angle,
		power
	};
}

//#endregion
//#region src/host/playback.ts
const TERMINAL_STATUSES = [
	"ended",
	"failed",
	"cancelled"
];
const REPORTABLE_STATUSES = [
	"playing",
	"ended",
	"failed",
	"cancelled"
];
const PLAYBACK_KEEP_MS = 60 * 1e3;
const MAX_PLAYBACK_WAIT_MS = 10 * 1e3;
/** 终态判定用集合。 */
const TERMINAL = new Set(TERMINAL_STATUSES);
/** 可上报判定用集合。 */
const REPORTABLE = new Set(REPORTABLE_STATUSES);
const isTerminalStatus = (s) => TERMINAL.has(s);
const isPlaybackStatus = (s) => s === "accepted" || REPORTABLE.has(s);
const isReportableStatus = (s) => REPORTABLE.has(s);
function parsePlaybackPath(rest) {
	const m = /^playback\/([^/]+)(\/report)?$/.exec(rest);
	if (!m) return void 0;
	return {
		playbackId: m[1] ?? "",
		isReport: m[2] === "/report"
	};
}
function parseWaitQuery(waitRaw, timeoutRaw) {
	if (waitRaw === null && timeoutRaw === null) return { kind: "none" };
	if (waitRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "wait and timeout must be used together"
	};
	const wait = waitRaw.split(",").map((s) => s.trim()).filter((s) => s !== "");
	const bad = wait.find((s) => !isPlaybackStatus(s));
	if (wait.length === 0 || bad !== void 0) return {
		kind: "error",
		error: `invalid wait status: ${bad ?? waitRaw}`
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_PLAYBACK_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_PLAYBACK_WAIT_MS})`
	};
	return {
		kind: "ok",
		wait,
		timeoutMs
	};
}
var PlaybackStore = class {
	constructor() {
		this.records = new Map();
		this.waiters = new Map();
		this.activeByPet = new Map();
		this.seq = 0;
	}
	/**
	* 受理一次点播：建记录（accepted），并把该宠物上一场（若仍在非终态）标为 cancelled/superseded。
	* @returns 新建的记录（调用方取 playbackId 下发给调用方）。
	*/
	create(petId, name$1) {
		this.sweep();
		const prev = this.activeByPet.get(petId);
		if (prev !== void 0) this.finish(prev, "cancelled", "superseded");
		const now = Date.now();
		const record = {
			playbackId: "pb-" + now.toString(36) + "-" + (++this.seq).toString(36),
			petId,
			name: name$1,
			status: "accepted",
			createdAt: now,
			updatedAt: now
		};
		this.records.set(record.playbackId, record);
		this.activeByPet.set(petId, record.playbackId);
		return record;
	}
	/** 查记录；不存在 / 已过期返回 undefined（路由回 404）。 */
	get(playbackId) {
		this.sweep();
		return this.records.get(playbackId);
	}
	/**
	* 渲染端上报一次状态。
	*
	* 终态之后的上报一律 ignored（迟到的 ended 不许覆盖 cancelled），与当前状态相同的上报同样
	* ignored；两种情况路由都回 200——对上报方来说「已经这样了」就是成功。
	*/
	report(playbackId, status, reason) {
		this.sweep();
		const record = this.records.get(playbackId);
		if (!record) return "unknown";
		const next = typeof status === "string" ? status : "";
		if (!isReportableStatus(next)) return "invalid";
		if (isTerminalStatus(record.status) || record.status === next) return "ignored";
		const why = typeof reason === "string" && reason !== "" ? reason : void 0;
		this.finish(playbackId, next, why);
		return "ok";
	}
	/**
	* 挂起一个等待者。
	* @returns 取消函数；编号不存在时返回 undefined（路由据此立刻回 404，不挂）。
	*/
	wait(args) {
		this.sweep();
		const record = this.records.get(args.playbackId);
		if (!record) return void 0;
		const waiter = {
			wait: new Set(args.wait),
			onWake: args.onWake,
			record,
			timer: void 0
		};
		let set = this.waiters.get(args.playbackId);
		if (!set) {
			set = new Set();
			this.waiters.set(args.playbackId, set);
		}
		set.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(args.playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}, Math.max(0, args.timeoutMs));
		waiter.timer.unref?.();
		return () => this.dropWaiter(args.playbackId, waiter);
	}
	/** 结束所有挂起的等待（插件卸载 / 宿主退出路径）；唤醒时 matched=false，调用方据此立刻收尾。 */
	cancelAll() {
		for (const [playbackId, set] of [...this.waiters]) for (const waiter of [...set]) {
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, false);
		}
	}
	/**
	* 清理过期终态记录（惰性调用：create / get / report 各调一次，记录数很少，成本可忽略）。
	*
	* 必须先把还在等它的人叫醒：等待上限（10s）通常远小于保留时长（60s），但调用方完全可以在
	* 一条终态记录的保留窗口末尾注册一个等「别的状态」的等待者——不唤醒就成了永远等不到的悬挂等待者。
	*
	* @param now - 注入时间（单测用；缺省取当前时刻）。
	*/
	sweep(now = Date.now()) {
		for (const [playbackId, record] of this.records) {
			if (!isTerminalStatus(record.status)) continue;
			if (now - record.updatedAt < PLAYBACK_KEEP_MS) continue;
			const set = this.waiters.get(playbackId);
			if (set) for (const waiter of [...set]) {
				this.dropWaiter(playbackId, waiter);
				waiter.onWake(waiter.record, false);
			}
			this.records.delete(playbackId);
		}
	}
	/** 当前记录数（测试 / 观测用）。 */
	count() {
		return this.records.size;
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
	waiterCount() {
		let n = 0;
		for (const set of this.waiters.values()) n += set.size;
		return n;
	}
	/**
	* 落到一个终态：写状态、更新时间、摘掉「当前活跃」、唤醒在等这个状态的人。
	* 这是唯一的状态写入点，所以等待者唤醒只在这里发生（不需要 diff、不需要比对）。
	*/
	finish(playbackId, status, reason) {
		const record = this.records.get(playbackId);
		if (!record) return;
		record.status = status;
		record.updatedAt = Date.now();
		if (status === "ended") record.endedAt = record.updatedAt;
		if (reason !== void 0) record.reason = reason;
		if (this.activeByPet.get(record.petId) === playbackId) this.activeByPet.delete(record.petId);
		const set = this.waiters.get(playbackId);
		if (!set) return;
		for (const waiter of [...set]) {
			if (!waiter.wait.has(status)) continue;
			this.dropWaiter(playbackId, waiter);
			waiter.onWake(waiter.record, true);
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除 + 空集合回收）。 */
	dropWaiter(playbackId, waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		const set = this.waiters.get(playbackId);
		if (!set) return;
		set.delete(waiter);
		if (set.size === 0) this.waiters.delete(playbackId);
	}
};

//#endregion
//#region src/host/pose.ts
function normalizePoseInput(raw) {
	const o = raw && typeof raw === "object" ? raw : null;
	if (!o) return {
		ok: false,
		reason: "bad-request",
		message: "请求体必须是对象：{ x, y, facing }"
	};
	if (typeof o.x !== "number" || !Number.isFinite(o.x)) return {
		ok: false,
		reason: "bad-request",
		message: "x 必须是有限数字（归一化横坐标）"
	};
	if (typeof o.y !== "number" || !Number.isFinite(o.y)) return {
		ok: false,
		reason: "bad-request",
		message: "y 必须是有限数字（归一化纵坐标）"
	};
	if (o.facing !== "left" && o.facing !== "right") return {
		ok: false,
		reason: "bad-request",
		message: "facing 必须是 left / right"
	};
	return {
		ok: true,
		pose: {
			x: o.x,
			y: o.y,
			facing: o.facing
		}
	};
}
var PoseStore = class {
	constructor(opts) {
		this.byPet = new Map();
		this.now = opts?.now ?? Date.now;
	}
	/** 覆盖一只宠物的实况，返回落定的快照。 */
	set(petId, pose) {
		const snap = {
			x: pose.x,
			y: pose.y,
			facing: pose.facing,
			updatedAt: this.now()
		};
		this.byPet.set(petId, snap);
		return snap;
	}
	/** 读最近一次实况；从没上报过返回 undefined（路由回 pose-unavailable）。 */
	get(petId) {
		return this.byPet.get(petId);
	}
	/** 当前快照数（测试 / 观测用）。 */
	count() {
		return this.byPet.size;
	}
};

//#endregion
//#region src/host/surface.ts
const SURFACES = [
	"web",
	"desktop",
	"both",
	"any"
];
const SURFACE_TEXT = "surface 必填：web / desktop / both / any";
function normalizeSurface(v) {
	return typeof v === "string" && SURFACES.includes(v) ? v : null;
}
function displayCovers(want, display) {
	switch (want) {
		case "any": return display === "web" || display === "desktop" || display === "both";
		case "web": return display === "web" || display === "both";
		case "desktop": return display === "desktop" || display === "both";
		case "both": return display === "both";
	}
}

//#endregion
//#region src/host/work-status.ts
const HOST_WORK_STATUS_STATES = [
	"thinking",
	"working",
	"result",
	"waiting",
	"success",
	"error"
];
/**
* 回合结束原因 → 档位：completed → success，错误系（error / max-tokens / timeout）→ error，
* blocked → waiting；其余（aborted 等）→ null，由调用方清理会话回空闲——残留上一档会让回合被
* 打断后永远卡在 working。
*/
function turnEndState(kind) {
	if (kind === "completed") return "success";
	if (kind === "error" || kind === "max-tokens" || kind === "timeout") return "error";
	if (kind === "blocked") return "waiting";
	return null;
}
/** ask_user_question 工具名：模型在等用户选择题答复 → 归为 waiting（等待确认）而非普通工作。 */
const USER_QUESTION_TOOL$1 = "ask_user_question";
const GOAL_UPDATE_TOOL = "update_goal";
function goalUpdateAction(args) {
	try {
		const o = JSON.parse(args);
		const action = String(o?.action ?? "");
		if (action === "complete" || action === "blocked") return action;
	} catch {}
	return null;
}
function completedState(turn) {
	if (!turn?.goalRound) return "success";
	if (turn.closing === "blocked") return "error";
	if (turn.closing === "complete") return "success";
	return "result";
}
function reduceWorkStatus(event, turn) {
	switch (event?.type) {
		case "turn/start": return "thinking";
		case "tool/call": {
			if (String(event?.data?.name ?? "") === USER_QUESTION_TOOL$1) return "waiting";
			return "working";
		}
		case "tool/result": return "result";
		case "approval/asked": return "waiting";
		case "turn/end": {
			const reason = turnEndState(String(event?.data?.reason?.kind ?? ""));
			if (reason === "success") return completedState(turn);
			return reason;
		}
		default: return null;
	}
}
const TASK_TEXT_MAX = 40;
function currentTaskFromTodo(event) {
	const todos = Array.isArray(event?.data?.todos) ? event.data.todos : [];
	let current;
	for (const t of todos) if (t?.status === "in_progress") current = t;
	if (!current) current = todos.find((t) => t?.status === "pending");
	const content = String(current?.content ?? "").trim();
	if (!content) return null;
	const points = Array.from(content);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : content;
}
const WORK_STATUS_PRIORITY = {
	waiting: 60,
	error: 50,
	working: 40,
	thinking: 30,
	result: 25,
	success: 20
};
function pickDisplayed(entries) {
	let best;
	for (const entry of entries) if (!best || WORK_STATUS_PRIORITY[entry.state] > WORK_STATUS_PRIORITY[best.state] || WORK_STATUS_PRIORITY[entry.state] === WORK_STATUS_PRIORITY[best.state] && entry.seq > best.seq) best = entry;
	return best;
}
var WorkStatusStore = class {
	constructor() {
		this.sessions = new Map();
		this.snap = {
			state: null,
			task: null,
			ts: 0
		};
	}
	/** 该会话当前是否有活动条目（决定 todo/write 是否还值得更新它的文案）。 */
	has(sessionId) {
		return this.sessions.has(sessionId);
	}
	/** 该会话当前档位（无条目 / 已清返回 undefined）。 */
	stateOf(sessionId) {
		return this.sessions.get(sessionId)?.state;
	}
	/** 该会话当前任务详情（无条目返回 null）。 */
	taskOf(sessionId) {
		return this.sessions.get(sessionId)?.task ?? null;
	}
	/** 写会话状态（保留该会话已有的 task）；同状态且 seq 不更新则不写并返回 false（防刷屏）。 */
	setState(sessionId, state, seq = 0) {
		const prev = this.sessions.get(sessionId);
		if (prev?.state === state && prev.seq >= seq) return false;
		this.sessions.set(sessionId, {
			state,
			seq,
			task: prev?.task ?? null
		});
		this.refresh();
		return true;
	}
	/** 写该会话的任务详情（null = 清空）；会话无活动条目 → 不动（它不会被展示）。 */
	setTask(sessionId, task) {
		const prev = this.sessions.get(sessionId);
		if (!prev || prev.task === task) return false;
		this.sessions.set(sessionId, {
			...prev,
			task
		});
		this.refresh();
		return true;
	}
	/** 清掉某会话（回合结束 / 终态过期）：它的 task 一并消失，不会残留到后续活动里。 */
	clear(sessionId) {
		if (!this.sessions.delete(sessionId)) return false;
		this.refresh();
		return true;
	}
	/** 展示快照（对象引用稳定，供 /work-status 直接序列化）。 */
	snapshot() {
		return this.snap;
	}
	/** 重算展示：state 与 task 任一变化才更新 ts（轮询侧据此触发，两端都靠它刷新）。 */
	refresh() {
		const best = pickDisplayed(this.sessions.values());
		const nextState = best?.state ?? null;
		const nextTask = best?.task ?? null;
		if (nextState === this.snap.state && nextTask === this.snap.task) return;
		this.snap.state = nextState;
		this.snap.task = nextTask;
		this.snap.ts = Date.now();
	}
};

//#endregion
//#region src/host/tool-detail.ts
/** 文件名/图片类：每句都带 {target}。 */
const FILE_COPY = [
	"翻翻 {target} 看看嘛",
	"{target} 里面写了啥呢",
	"我先瞅瞅 {target} 哈"
];
/** 写文件。 */
const WRITE_COPY = [
	"写点东西到 {target}",
	"{target} 马上写出来",
	"给 {target} 添点料"
];
/** 改文件。 */
const EDIT_COPY = [
	"{target} 得改改啦",
	"我来动动 {target} 哦",
	"{target} 这里要修一下"
];
/** 找文件。 */
const GLOB_COPY = [
	"{target} 都躲哪儿了呢",
	"找找 {target} 在不在",
	"{target} 藏在哪个角落呀"
];
/** 搜内容。 */
const GREP_COPY = [
	"{target} 藏哪儿了呢",
	"搜搜 {target} 在哪",
	"哪儿有 {target} 呀"
];
/** 给人看文件。 */
const PRESENT_COPY = [
	"给你看 {target} 哦",
	"{target} 拿来给你瞧瞧",
	"喏，{target} 在这儿"
];
/** 学技能。 */
const SKILL_COPY = [
	"学个新本事 {target}",
	"{target} 这招得记住",
	"把 {target} 学起来"
];
/** 委派子任务。 */
const SUBAGENT_COPY = [
	"叫人搭把手：{target}",
	"让帮手去看看 {target}",
	"{target} 交给帮手了"
];
/** 工具 → 文案。没列在这里的工具走 UNKNOWN_TOOL_LINE。 */
const TOOL_COPY = {
	read: {
		lines: FILE_COPY,
		short: "翻翻代码看看"
	},
	read_image: {
		lines: [
			"这 {target} 长啥样呀",
			"让我瞧瞧 {target} 呗",
			"{target} 是张什么图呢"
		],
		short: "看看这张图是啥"
	},
	write: {
		lines: WRITE_COPY,
		short: "写点东西进去"
	},
	edit: {
		lines: EDIT_COPY,
		short: "这里得改改"
	},
	str_replace_editor: {
		lines: EDIT_COPY,
		short: "这里得改改"
	},
	glob: {
		lines: GLOB_COPY,
		short: "找找东西在哪"
	},
	grep: {
		lines: GREP_COPY,
		short: "到处翻翻看"
	},
	present: {
		lines: PRESENT_COPY,
		short: "拿个东西给你看"
	},
	skill: {
		lines: SKILL_COPY,
		short: "学个新本事"
	},
	subagent: {
		lines: SUBAGENT_COPY,
		short: "叫人来搭把手"
	},
	subagent_fork: {
		lines: SUBAGENT_COPY,
		short: "叫人来搭把手"
	},
	workflow: {
		lines: [
			"把活排个序，开工咯",
			"几件事一起安排上",
			"按顺序一件件来"
		],
		short: "把活排一排"
	},
	web_search: {
		lines: [
			"我去查查 {target}",
			"{target} 得搜搜才知道",
			"上网问问 {target} 吧"
		],
		short: "上网查查"
	},
	web_fetch: {
		lines: [
			"去 {target} 瞅瞅有啥",
			"{target} 这页我翻翻",
			"看看 {target} 上写了啥"
		],
		short: "去网上看看"
	}
};
/** 未知工具：只说一句氛围话，不报工具名（`str_replace_editor` 这种名字上屏很怪）。 */
const UNKNOWN_TOOL_LINE = "这工具是干嘛的";
/** 兜底：没进表的命令（npm / python / node / tsc / eslint / docker…），短命令名会上屏。 */
const COMMAND_FALLBACK = [
	"跑一下 {cmd} 咯",
	"{cmd} 跑起来了",
	"让 {cmd} 干点活"
];
/** 兜底：命令名本身太长（如 Get-NetTCPConnection）时用，不带名字。 */
const COMMAND_NAME_TOO_LONG = "跑一个命令咯";
const CD_COPY = [
	"先把位置挪一挪",
	"切到那个目录去",
	"挪个地方继续干活"
];
const LS_COPY = [
	"看看这儿都有啥",
	"这层都有什么东西",
	"翻翻这里有没有"
];
const CAT_COPY = [
	"把内容亮出来瞧瞧",
	"看看里头写了什么",
	"读读这份内容"
];
const MKDIR_COPY = [
	"建个新文件夹",
	"腾个地方出来",
	"新开一个目录"
];
const RM_COPY = [
	"把不要的清掉",
	"这份就别留了",
	"清理一下这些"
];
const MV_COPY = [
	"把东西挪个地儿",
	"换个位置放",
	"挪到那边去"
];
const CP_COPY = [
	"抄一份留着",
	"复制一份备用",
	"再备一份"
];
const CURL_COPY = [
	"去问问接口有没有人",
	"敲敲门看看通不通",
	"请求一下那个地址"
];
const CHECKOUT_COPY = [
	"换到那个分支瞧瞧",
	"切个分支看看",
	"换条路继续走"
];
/** 命令 / 「命令 子命令」→ 3 句候选（键一律小写，别名共用同一组）。 */
const COMMAND_COPY = {
	cd: CD_COPY,
	"set-location": CD_COPY,
	ls: LS_COPY,
	dir: LS_COPY,
	"get-childitem": LS_COPY,
	cat: CAT_COPY,
	"get-content": CAT_COPY,
	mkdir: MKDIR_COPY,
	"new-item": MKDIR_COPY,
	rm: RM_COPY,
	del: RM_COPY,
	"remove-item": RM_COPY,
	mv: MV_COPY,
	"move-item": MV_COPY,
	cp: CP_COPY,
	"copy-item": CP_COPY,
	curl: CURL_COPY,
	"invoke-webrequest": CURL_COPY,
	git: [
		"折腾折腾 git 仓库",
		"跟 git 打个交道",
		"git 这边动一动"
	],
	"git status": [
		"看看现在改了些什么",
		"查查工作区干不干净",
		"目前是啥状况呢"
	],
	"git diff": [
		"瞅瞅这次到底改哪了",
		"到底动了哪些地方呀",
		"对比看看都改了啥"
	],
	"git log": [
		"让我康康你的提交历史",
		"翻翻最近都提交了啥",
		"看看这些天干了什么"
	],
	"git add": [
		"先把这些攒起来",
		"好东西先收进去",
		"把改动的都登记上"
	],
	"git commit": [
		"代码得保存好才行",
		"打个提交，记一笔",
		"先存一份再说"
	],
	"git push": [
		"该推上去了吧，我来",
		"推送一下，交给我",
		"该让远端知道了"
	],
	"git pull": [
		"拉一下最新的过来",
		"把远端的新东西拿回来",
		"先同步一下再说"
	],
	"git fetch": [
		"先问问远端有没有新东西",
		"悄悄看一眼远端",
		"拉个最新状态下来"
	],
	"git checkout": CHECKOUT_COPY,
	"git switch": CHECKOUT_COPY,
	"git branch": [
		"看看都有哪些分支",
		"理理这些分支",
		"新建个分支备用"
	],
	"git merge": [
		"把两边合到一起",
		"合并一下，别打架",
		"这两条线该合了"
	],
	"git rebase": [
		"把历史重新捋一捋",
		"重新排一下顺序",
		"理一理提交顺序"
	],
	"git stash": [
		"先把改动收起来",
		"这些先搁一边",
		"暂时藏起来一下"
	],
	"git clone": [
		"把整个仓库搬回来",
		"照着一份抄下来",
		"把这份拿下来瞧瞧"
	],
	"git reset": [
		"把刚才的退回去",
		"撤销一下这几步",
		"回到之前的样子"
	],
	"git tag": [
		"给这次打个标记",
		"贴个版本标签",
		"记个里程碑"
	]
};
/**
* 语义已由别处表达、不该进气泡的工具：
* `todo_write` 的文案本身就是气泡正文（写它等于自己盖自己）；`ask_user_question` 与 goal 系已有
* 专门档位（waiting / success / error）；`exit_plan_mode` 是纯内部调度。
* 这些报出来不是重复就是噪音。
*/
const SILENT_TOOLS = new Set([
	"todo_write",
	"ask_user_question",
	"create_goal",
	"get_goal",
	"update_goal",
	"exit_plan_mode"
]);
/** 取目标的方式（与文案表按工具名关联；pwsh 不在这里，它走命令表）。 */
const TOOL_RULES = {
	read: {
		pick: fileTarget,
		path: true
	},
	read_image: {
		pick: fileTarget,
		path: true
	},
	write: {
		pick: fileTarget,
		path: true
	},
	edit: {
		pick: fileTarget,
		path: true
	},
	str_replace_editor: {
		pick: fileTarget,
		path: true
	},
	glob: { pick: (args) => firstStr(args, ["pattern", "path"]) },
	grep: { pick: (args) => firstStr(args, ["pattern", "path"]) },
	web_fetch: { pick: urlHost },
	web_search: { pick: queryTarget },
	subagent: { pick: (args) => firstStr(args, ["description"]) },
	subagent_fork: { pick: (args) => firstStr(args, ["description"]) },
	workflow: { pick: (args) => firstStr(args, ["name", "description"]) },
	skill: { pick: (args) => firstStr(args, ["name"]) },
	present: {
		pick: filesTarget,
		path: true
	}
};
/** 非空字符串（去首尾空白），否则 null——所有取参都先过它。 */
function str(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
/** 按候选顺序取第一个非空字符串：同名工具在不同版本里字段叫法可能不同（file_path / filePath / path）。 */
function firstStr(args, keys) {
	for (const key of keys) {
		const value = str(args[key]);
		if (value !== null) return value;
	}
	return null;
}
/** 文件类工具：`file_path` 是主流，`path` 是部分工具的写法。 */
function fileTarget(args) {
	return firstStr(args, [
		"file_path",
		"filePath",
		"path"
	]);
}
/** 网页：给主机名就够（完整 URL 又长又带查询串，气泡放不下也没必要）。 */
function urlHost(args) {
	const raw = str(args.url);
	if (raw === null) return null;
	try {
		const host = new URL(raw).host;
		return host === "" ? null : host;
	} catch {
		const rest = raw.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//, "");
		const head = rest.split(/[/?#]/)[0] ?? "";
		return head === "" ? null : head;
	}
}
/** 网络搜索：`queries` 可能是数组（主流）或单数字符串，两种都认。 */
function queryTarget(args) {
	const queries = args.queries;
	if (Array.isArray(queries)) {
		for (const item of queries) {
			const value = str(item);
			if (value !== null) return value;
		}
		return null;
	}
	return firstStr(args, ["queries", "query"]);
}
/** 展示文件：`files` 是 `[{ path, description }]`，取第一个的 path（没有就取 description）。 */
function filesTarget(args) {
	const files = args.files;
	if (!Array.isArray(files)) return null;
	for (const item of files) {
		if (item === null || typeof item !== "object") continue;
		const picked = firstStr(item, ["path", "description"]);
		if (picked !== null) return picked;
	}
	return null;
}
/**
* 命令名长什么样：ASCII 字母开头、至少两个字符、只含字母数字与 `_ . -`。
* 纯数字（`18016`）、中文串（`监听`）、符号（`==`）、开关（`-v`）、单字母变量（`x`）全部落选——
* 它们几乎只会是字符串字面量或参数，而不是命令本身。
*/
const COMMAND_LIKE = /^[A-Za-z][A-Za-z\d_.-]+$/;
/** 子命令长什么样：单词形态（`status` / `log` / `push`），不接受开关与路径。 */
const SUBCOMMAND_LIKE = /^[A-Za-z][A-Za-z\d-]*$/;
/** 复合命令：`;` `|` `&&` `||` 换行一律不猜（引号内的竖线也会被判成复合，宁保守）。 */
const COMPOUND_COMMAND = /[;|]|&&|\|\||\r?\n/;
/**
* 取命令名时要剥掉的边角字符（运算符、括号、重定向、引号、变量前缀…）。
* 例：`(Get-NetTCPConnection` → `Get-NetTCPConnection`；`$env:FOO` → `env:FOO`（随后判定落选）。
*/
const EDGE_CHARS = new Set("&.([{!@$^+:=,;|\"'`)]}>#");
/** 剥掉词首词尾的边角字符。 */
function trimEdges(token) {
	let start = 0;
	let end = token.length;
	while (start < end && EDGE_CHARS.has(token.charAt(start))) start += 1;
	while (end > start && EDGE_CHARS.has(token.charAt(end - 1))) end -= 1;
	return token.slice(start, end);
}
/**
* 把命令行切成「词」：引号内的整体算一个词（`"C:\Program Files\node.exe"` 不会被空格劈开），
* 引号本身丢弃，`;` / `|` 当分隔符。
*
* 这不是通用 shell 解析器，只为「找命令名」服务，所以只处理引号与分隔符，不解释变量、转义与管道。
*/
function tokenizeCommand(command) {
	const tokens = [];
	let current = "";
	let quote = null;
	for (const ch of command) {
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "\"" || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch) || ch === ";" || ch === "|") {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current !== "") tokens.push(current);
	return tokens.map(trimEdges).filter((token) => token !== "");
}
/** arguments 的解析上限（UTF-16 码元数）：超过就不解析（write / edit 会带上整个文件内容）。 */
const MAX_ARGS_CHARS = 64 * 1024;
/** 气泡里目标的展示上限（码点）：超过就只留文件名。 */
const TARGET_MAX = 22;
/**
* 目标上屏的长度上限（码点）：超过就整句换成该工具的氛围兜底。
* 比 TARGET_MAX 小是有意的——路径压缩后仍超过这个数的（长文件名、长 grep 正则、长 query）
* 硬塞进句子会撑破气泡（真实案例：`grep` 的 pattern 是 `WORK_STATE_GAP_MS|busyFlip|…`）。
*/
const TARGET_DISPLAY_MAX = 20;
/** 解析 tool/call 的 arguments（JSON 字符串；个别版本可能直接给对象）→ 参数对象；失败或超大 → null。 */
function parseArgs(raw) {
	if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
	if (typeof raw !== "string" || raw === "" || raw.length > MAX_ARGS_CHARS) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
/** 按码点截断（与 ./work-status 的 currentTaskFromTodo 同口径：超长留 TASK_TEXT_MAX 个 + 省略号）。 */
function clip(text) {
	const points = Array.from(text);
	return points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : text;
}
/** 随机取一句（同一句连着出现很假，这里按调用随机）。 */
function pickLine(lines) {
	return lines[Math.floor(Math.random() * lines.length)] ?? lines[0] ?? "";
}
/** 填占位符（`{target}` / `{cmd}` / `{tool}`）；未知占位符原样保留。 */
function fill(line, vars) {
	let out = line;
	for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(value);
	return out;
}
/**
* 目标压短：短路径原样，长路径只留文件名。
* 统一成 `/` 是为了跨平台文案一致（Windows 的 `\` 在气泡里更占宽度也更难读）。
*/
function compactTarget(raw, pathLike) {
	if (!pathLike) return raw;
	const text = raw.replace(/\\/g, "/").replace(/\/+$/, "");
	if (Array.from(text).length <= TARGET_MAX) return text;
	const parts = text.split("/").filter((part) => part !== "");
	return parts.length > 0 ? parts[parts.length - 1] : text;
}
/**
* `pwsh` 的文案：按命令名（必要时加子命令）查表，查不到走兜底。
*
* 复合命令 → null，让前端回落配置文案（无法判断真正在做什么）；`git log` 这类命中「命令 + 子命令」
* 用子命令文案，只命中命令（`git`、`cd`）用通用文案，都没命中（`npm`、`python`、`node`…）走兜底——
* 兜底带命令名，至少知道在跑什么。
*/
function pwshDetail(args) {
	const command = args === null ? null : str(args.command);
	if (command === null) return null;
	if (COMPOUND_COMMAND.test(command)) return null;
	const tokens = tokenizeCommand(command);
	const nameAt = tokens.findIndex((token) => COMMAND_LIKE.test(token));
	if (nameAt < 0) return null;
	const rawCmd = tokens[nameAt];
	const lookup = rawCmd.toLowerCase();
	const subAt = tokens.findIndex((token, index) => index > nameAt && SUBCOMMAND_LIKE.test(token));
	const sub = subAt < 0 ? null : tokens[subAt].toLowerCase();
	const lines = (sub === null ? void 0 : COMMAND_COPY[`${lookup} ${sub}`]) ?? COMMAND_COPY[lookup];
	if (lines !== void 0) return clip(pickLine(lines));
	if (Array.from(rawCmd).length > TARGET_DISPLAY_MAX) return clip(COMMAND_NAME_TOO_LONG);
	return clip(fill(pickLine(COMMAND_FALLBACK), { cmd: rawCmd }));
}
function toolDetailFromEvent(event) {
	const name$1 = str(event?.data?.name);
	if (name$1 === null) return null;
	if (SILENT_TOOLS.has(name$1)) return null;
	const args = parseArgs(event?.data?.arguments);
	if (name$1 === "pwsh") return pwshDetail(args);
	const entry = TOOL_COPY[name$1];
	if (entry === void 0) return clip(UNKNOWN_TOOL_LINE);
	const rule = TOOL_RULES[name$1];
	const line = pickLine(entry.lines);
	if (!line.includes("{target}")) return clip(line);
	const target = args === null || rule === void 0 ? null : rule.pick(args);
	if (target === null) return null;
	const shown = compactTarget(target, rule?.path === true);
	if (Array.from(shown).length > TARGET_DISPLAY_MAX) return clip(entry.short);
	return clip(fill(line, { target: shown }));
}

//#endregion
//#region src/host/notify-events.ts
function shouldNotifySession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return true;
	if (header.origin === "subagent") return false;
	const depth = header.delegationDepth;
	if (typeof depth === "number" && Number.isFinite(depth) && depth > 0) return false;
	return true;
}
function sessionIdOf(session) {
	const s = session;
	return String(s?.header?.id ?? s?.id ?? "unknown");
}
function withSessionId(frame, sessionId) {
	return sessionId === "unknown" ? frame : {
		...frame,
		sessionId
	};
}
function isCompletionTurnEnd(event) {
	const e = event;
	return e?.type === "turn/end" && e.data?.reason?.kind === "completed";
}
function hasBlockingActivity(activity) {
	if (!Array.isArray(activity)) return false;
	for (const item of activity) {
		const kind = item?.kind;
		if (kind === "job" || kind === "subagent" || kind === "schedule") return true;
	}
	return false;
}
function turnEndNotifyKind(kind) {
	if (kind === "completed") return "completed";
	if (kind === "error" || kind === "max-tokens") return kind;
	return null;
}
/** ask_user_question 工具名（与 work-status.ts 同源；该工具触发时模型在等用户答复）。 */
const USER_QUESTION_TOOL = "ask_user_question";
function parseToolQuestions(args) {
	if (typeof args !== "string") return null;
	try {
		const parsed = JSON.parse(args);
		const questions = parsed?.questions;
		if (!Array.isArray(questions)) return null;
		return questions;
	} catch {
		return null;
	}
}
function reduceNotifyFrame(event) {
	if (!event?.type) return null;
	switch (event.type) {
		case "turn/end": {
			const reason = event.data?.reason;
			const kind = turnEndNotifyKind(reason?.kind);
			if (!kind) return null;
			return {
				type: "session/event",
				event: {
					type: "turn/end",
					data: { reason }
				}
			};
		}
		case "approval/asked": {
			const data = event.data ?? {};
			return {
				type: "approval/requested",
				...typeof data.toolName === "string" && data.toolName ? { toolName: data.toolName } : {},
				...typeof data.reason === "string" && data.reason ? { reason: data.reason } : {}
			};
		}
		case "tool/call": {
			if (String(event.data?.name ?? "") !== USER_QUESTION_TOOL) return null;
			const questions = parseToolQuestions(event.data?.arguments);
			if (!questions || questions.length === 0) return null;
			return {
				type: "question/requested",
				questions
			};
		}
		default: return null;
	}
}
function agentErrorFrame(error) {
	const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
	return {
		type: "host/agent-error",
		message
	};
}

//#endregion
//#region src/host/storage-paths.ts
const DESKTOP_APP_NAME = "dsh-pet-electron-helper";
/** Electron 下载缓存的应用名（@electron/get 写死 env-paths('electron')，与插件名无关）。 */
const ELECTRON_PATHS_NAME = "electron";
/**
* 桌面端 userData 目录（Electron app.getPath('userData') 的等价推导）。
* 逐平台对齐 Electron 口径：win32 = %APPDATA%\<name>，darwin = ~/Library/Application Support/<name>，
* linux = $XDG_CONFIG_HOME/<name>，未设则 ~/.config/<name>。
*/
function desktopUserDataDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), DESKTOP_APP_NAME);
	if (platform === "darwin") return join(home, "Library", "Application Support", DESKTOP_APP_NAME);
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), DESKTOP_APP_NAME);
}
/**
* Electron 安装包下载缓存目录（@electron/get 默认 cacheRoot = env-paths('electron').cache）。
* win32 在 LOCALAPPDATA 下多一层 Cache，macOS 用 ~/Library/Caches，Linux 用 $XDG_CACHE_HOME
* （默认 ~/.cache）。该目录与其它用 @electron/get 的工具共用，删掉只是下次重新下载。
*/
function electronCacheDir(input) {
	const { home, env = process.env, platform = process.platform } = input;
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), ELECTRON_PATHS_NAME, "Cache");
	if (platform === "darwin") return join(home, "Library", "Caches", ELECTRON_PATHS_NAME);
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), ELECTRON_PATHS_NAME);
}
function storageEntries(input) {
	const items = [
		{
			key: "userData",
			path: input.userDataRoot
		},
		{
			key: "electron",
			path: input.electronDir
		},
		{
			key: "desktopCache",
			path: desktopUserDataDir(input)
		},
		{
			key: "electronCache",
			path: electronCacheDir(input)
		},
		{
			key: "package",
			path: input.packageRoot
		}
	];
	return items.map((it) => ({
		...it,
		exists: existsSync(it.path)
	}));
}
function profileNameFrom(packageRoot$1) {
	const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/][^\\/]+[\\/]?$/.exec(packageRoot$1);
	return m?.[1];
}

//#endregion
//#region src/host/state.ts
const MAX_STATE_WAIT_MS = 10 * 1e3;
function parseStateWaitQuery(sinceRaw, timeoutRaw) {
	if (sinceRaw === null && timeoutRaw === null) return { kind: "none" };
	if (sinceRaw === null || timeoutRaw === null) return {
		kind: "error",
		error: "since and timeout must be used together"
	};
	if (!/^\d+$/.test(sinceRaw)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!/^\d+$/.test(timeoutRaw)) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	const since = Number(sinceRaw);
	const timeoutMs = Number(timeoutRaw);
	if (!Number.isFinite(since)) return {
		kind: "error",
		error: "invalid since (expect a non-negative integer)"
	};
	if (!Number.isFinite(timeoutMs) || timeoutMs > MAX_STATE_WAIT_MS) return {
		kind: "error",
		error: `invalid timeout (expect 0..${MAX_STATE_WAIT_MS})`
	};
	return {
		kind: "ok",
		since,
		timeoutMs
	};
}
/** 空叶子：counter=0 表示从未写过——前端首拉把它当基线，之后 counter 变化才渲染。 */
const emptyLeaf = () => ({
	counter: 0,
	data: null
});
var PollStateStore = class {
	constructor() {
		this.last = 0;
		this.sections = {
			balance: emptyLeaf(),
			workStatus: emptyLeaf(),
			notify: emptyLeaf(),
			config: emptyLeaf(),
			menu: emptyLeaf()
		};
		this.pets = new Map();
		this.waiters = new Set();
	}
	/** 下一个 counter。 */
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	/**
	* 写一个全局叶子（余额 / 工作状态 / 通知 / 配置变更信号）。
	* 整体替换叶子对象而不是原地改字段：`read()` 拿到的引用因此不会半新半旧。
	*/
	writeSection(name$1, data) {
		this.sections[name$1] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/** 写一只宠物的叶子（宠物条目不存在则自动建立，所有槽位一起建好，形状恒定）。 */
	writePet(petId, leaf, data) {
		let entry = this.pets.get(petId);
		if (!entry) {
			entry = {
				say: emptyLeaf(),
				anim: emptyLeaf(),
				position: emptyLeaf(),
				throw: emptyLeaf(),
				lock: emptyLeaf()
			};
			this.pets.set(petId, entry);
		}
		entry[leaf] = {
			counter: this.next(),
			data
		};
		this.wakeWaiters();
	}
	/**
	* 当前 S（GET /state 的响应体）。
	* sections 是浅拷贝、pets 是新建对象——叶子对象本身共享，但写入永远整体替换，
	* 所以消费端不会读到写了一半的叶子。
	*/
	read() {
		return {
			counter: this.last,
			sections: { ...this.sections },
			pets: Object.fromEntries(this.pets)
		};
	}
	/**
	* 挂起一个等待者：直到 `last` 变得不等于 `since`、或超时、或调用方取消。
	*
	* 三种收尾对调用方是同一件事（去 `read()` 拿最新状态），所以回调不带参数。
	*
	* @returns 取消函数（清掉超时定时器并摘掉等待者）。
	*/
	wait(args) {
		const waiter = {
			since: args.since,
			onWake: args.onWake,
			timer: void 0
		};
		this.waiters.add(waiter);
		waiter.timer = setTimeout(() => {
			this.dropWaiter(waiter);
			waiter.onWake();
		}, Math.max(0, args.timeoutMs));
		if (process.env.NODE_TEST_CONTEXT === void 0) waiter.timer.unref?.();
		return () => this.dropWaiter(waiter);
	}
	/**
	* 结束所有挂起的等待（插件卸载 / 宿主退出路径）。
	* 唤醒时不给区分标志：调用方据此立刻收尾，而不是留一个悬挂的响应。
	*/
	cancelAll() {
		for (const waiter of [...this.waiters]) {
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 当前等待者数（测试 / 观测用：验证不泄漏）。 */
	waiterCount() {
		return this.waiters.size;
	}
	/**
	* 唤醒所有已经过期的等待者（唯一调用点是两个 write 方法，且必须在叶子写定之后）。
	* `since === this.last` 的跳过：那种等待者已经是最新的，叫醒它等于空转。
	* 必须写在 `this.sections[name] = …` 之后：放在 next() 里会让回调先于赋值执行，调用方读到旧状态。
	*/
	wakeWaiters() {
		if (this.waiters.size === 0) return;
		for (const waiter of [...this.waiters]) {
			if (waiter.since === this.last) continue;
			this.dropWaiter(waiter);
			waiter.onWake();
		}
	}
	/** 摘掉一个等待者（清定时器 + 从集合移除）。 */
	dropWaiter(waiter) {
		if (waiter.timer !== void 0) {
			clearTimeout(waiter.timer);
			waiter.timer = void 0;
		}
		this.waiters.delete(waiter);
	}
};

//#endregion
//#region src/host/time-context.ts
/**
* 时段划分表：[起始小时, 时段]，按起始小时从晚到早排列——匹配时取第一个不超过当前小时的档。
* 口径含起始小时（0–23 全覆盖、不重叠）：凌晨 0–4、清晨 5–6、早上 7–8、上午 9–10、中午 11–12、
* 下午 13–16、傍晚 17–18、晚上 19–22、深夜 23。
*/
const SLOTS = [
	[23, "深夜"],
	[19, "晚上"],
	[17, "傍晚"],
	[13, "下午"],
	[11, "中午"],
	[9, "上午"],
	[7, "早上"],
	[5, "清晨"],
	[0, "凌晨"]
];
/** 星期文案：索引 = Date.getDay()（0 = 周日）。 */
const WEEKDAYS = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六"
];
/** 一天毫秒数（日期算术用 UTC 毫秒，避开本地时区）。 */
const DAY_MS = 864e5;
/** 缺省窗口：提前 3 天预热、本身 1 天、过后 3 天回味。 */
const DEFAULT_AHEAD = 3;
const DEFAULT_SPAN = 1;
const DEFAULT_AFTER = 3;
/** 假期区间的窗口：提前 3 天预热、末尾 3 天说「快结束了」、结束后 3 天回味。 */
const SEASON_AHEAD = 3;
const SEASON_ENDING_AHEAD = 3;
const SEASON_AFTER = 3;
/** 两位补零（只用于时分；月/日刻意不补零——中文写「2月17日」比「02月17日」自然）。 */
function pad2(n) {
	return String(n).padStart(2, "0");
}
function timeSlotOf(hour) {
	for (const [start, slot] of SLOTS) if (hour >= start) return slot;
	return "凌晨";
}
function dayKindOf(day) {
	return day === 0 || day === 6 ? "周末" : "工作日";
}
/**
* 顺序 = 优先级（靠前的先说话）。一天只出一个从句，所以同一天被多个节日/假期覆盖时，谁在数组里
* 靠前就由谁说；想改优先级就挪那几行，不必动逻辑。几条硬约束：只有当天值得说的小节排在邻座之前
* 并掐掉回味；除夕、元宵必须排在春节之前；寒暑假排在传统节日之后、纪念日之前——假期里的节日仍由
* 节日说话，7/1 这类与纪念日撞车的日子则由暑假说话。`ahead / span / after` 缺省 3 / 1 / 3。
*/
const PRIORITY = [
	{
		kind: "solar",
		key: "2-14",
		name: "情人节",
		after: 0
	},
	{
		kind: "solar",
		key: "12-31",
		name: "跨年夜",
		after: 0
	},
	{
		kind: "solar",
		key: "4-1",
		name: "愚人节",
		after: 0
	},
	{
		kind: "solar",
		key: "5-4",
		name: "青年节",
		ahead: 0,
		after: 0
	},
	{
		kind: "lunarEve",
		name: "除夕",
		ahead: 1,
		after: 0
	},
	{
		kind: "lunar",
		key: "1-15",
		name: "元宵节"
	},
	{
		kind: "lunar",
		key: "1-1",
		name: "春节",
		spoken: "大年初一",
		span: 15
	},
	{
		kind: "lunar",
		key: "8-15",
		name: "中秋节",
		span: 3,
		after: 2
	},
	{
		kind: "solar",
		key: "10-1",
		name: "国庆节",
		span: 7
	},
	{
		kind: "solar",
		key: "1-1",
		name: "元旦",
		spoken: "新年第一天",
		span: 3
	},
	{
		kind: "lunar",
		key: "5-5",
		name: "端午节",
		span: 3
	},
	{
		kind: "solar",
		key: "4-4",
		name: "清明节",
		span: 3,
		ahead: 1
	},
	{
		kind: "solar",
		key: "5-1",
		name: "劳动节",
		span: 3
	},
	{
		kind: "solar",
		key: "6-1",
		name: "儿童节"
	},
	{
		kind: "lunar",
		key: "7-7",
		name: "七夕"
	},
	{
		kind: "lunar",
		key: "7-15",
		name: "中元节"
	},
	{
		kind: "lunar",
		key: "2-2",
		name: "龙抬头"
	},
	{
		kind: "lunar",
		key: "9-9",
		name: "重阳节"
	},
	{
		kind: "lunar",
		key: "12-8",
		name: "腊八节"
	},
	{
		kind: "lunar",
		key: "12-23",
		name: "小年"
	},
	{
		kind: "season",
		from: "1-20",
		to: "2-18",
		name: "寒假"
	},
	{
		kind: "season",
		from: "7-1",
		to: "8-29",
		name: "暑假"
	},
	{
		kind: "solar",
		key: "3-8",
		name: "妇女节"
	},
	{
		kind: "solar",
		key: "9-10",
		name: "教师节"
	},
	{
		kind: "solar",
		key: "7-1",
		name: "建党节"
	},
	{
		kind: "solar",
		key: "8-1",
		name: "建军节"
	},
	{
		kind: "solar",
		key: "10-31",
		name: "万圣夜"
	},
	{
		kind: "solar",
		key: "12-24",
		name: "平安夜",
		after: 0
	},
	{
		kind: "solar",
		key: "12-25",
		name: "圣诞节"
	}
];
/** 公历 / 农历 / 除夕 / 假期区间的索引（模块加载时按 PRIORITY 建一次）。 */
const SOLAR_INDEX = new Map();
const LUNAR_INDEX = new Map();
const SEASON_ENTRIES = [];
let LUNAR_EVE;
PRIORITY.forEach((entry, priority) => {
	if (entry.kind === "solar") SOLAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunar") LUNAR_INDEX.set(entry.key, {
		entry,
		priority
	});
	else if (entry.kind === "lunarEve") LUNAR_EVE = {
		entry,
		priority
	};
	else SEASON_ENTRIES.push({
		entry,
		priority,
		from: entry.from,
		to: entry.to
	});
});
/** ICU 中国农历格式器；null = 已判定本环境不可用（不重试、不抛错）。 */
let lunarFormatter;
/**
* 取 ICU 农历格式器。Intl 在缺少该日历时不会抛错，而是静默退回公历——那会让每个月都被当成农历
* 同月同日，所以用 resolvedOptions().calendar 确认它真的解析成了 'chinese'，否则一律判不可用。
*/
function getLunarFormatter() {
	if (lunarFormatter === null) return void 0;
	if (!lunarFormatter) {
		const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", {
			month: "numeric",
			day: "numeric",
			year: "numeric"
		});
		lunarFormatter = fmt.resolvedOptions().calendar === "chinese" ? fmt : null;
	}
	return lunarFormatter ?? void 0;
}
/** 年内日序号（0 起，按 UTC 计算，闰年自然正确）——假期区间比较用它。 */
function dayOfYear(date) {
	return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS;
}
/** '月-日' → 该年内的日序号（0 起）。 */
function dayOfYearOf(year, monthDay) {
	const [month, day] = monthDay.split("-").map(Number);
	return (Date.UTC(year, (month ?? 1) - 1, day ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS;
}
/**
* 公历日期 → 农历月日。
*
* 已知精度边界（已评估并接受）：朔时刻贴近 UTC+8 午夜时 ICU 会把农历初一放错一天——2025–2060 的
* 445 个月起点里错 2 个，都是正月（2027-02-06 距午夜 8 分钟、2030-02-03 距午夜 5 分钟），表现为那
* 两年春节与元宵各差一天；2027 一例已与香港天文台官方对照表核对。要绝对准确只需换掉本函数实现
* （换库或加修正表），下游逻辑一行不用动。
* @returns 农历月/日（闰月 month 为负）；环境不支持农历、取不到月日，或农历年与公历年不吻合
*   （自洽校验：农历年只可能是当年或前一年，挡住 ICU 退化时把公历当农历返回）→ undefined。
*/
function lunarPartsOf(date) {
	const fmt = getLunarFormatter();
	if (!fmt) return void 0;
	const parts = fmt.formatToParts(date);
	const pick = (type) => parts.find((p) => p.type === type)?.value;
	const rawMonth = pick("month");
	const rawDay = pick("day");
	const rawYear = pick("relatedYear") ?? pick("year");
	if (!rawMonth || !rawDay || !rawYear) return void 0;
	const month = Number.parseInt(rawMonth, 10);
	const day = Number.parseInt(rawDay, 10);
	const year = Number.parseInt(rawYear, 10);
	if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return void 0;
	const gregorianYear = date.getFullYear();
	if (year !== gregorianYear && year !== gregorianYear - 1) return void 0;
	return {
		month: /bis/i.test(rawMonth) ? -month : month,
		day
	};
}
/** 当天是否是除夕（腊月最后一天：次日为正月初一即成立，廿九/三十都能认）。 */
function isLunarEve(date) {
	const today = lunarPartsOf(date);
	if (!today || today.month !== 12) return false;
	const next = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
	return Boolean(next && next.month === 1 && next.day === 1);
}
/** 某一天命中的全部条目（公历、农历、除夕三类；假期区间不按天查，另行处理）。 */
function entriesAt(date) {
	const out = [];
	const solar = SOLAR_INDEX.get(date.getMonth() + 1 + "-" + date.getDate());
	if (solar) out.push(solar);
	const lunar = lunarPartsOf(date);
	if (lunar && lunar.month > 0) {
		const hit = LUNAR_INDEX.get(lunar.month + "-" + lunar.day);
		if (hit) out.push(hit);
	}
	if (LUNAR_EVE && isLunarEve(date)) out.push(LUNAR_EVE);
	return out;
}
/**
* 相位 → 从句措辞。
* @param entry - 节日条目；`name`/`spoken`/`span` 决定措辞与默认窗口。
* @param delta - 相对节日起始日的天数：> 0 = 还有这么多天；0 = 起始当天；< 0 = 已在节期内或过后。
*/
function phraseOf(entry, delta) {
	const span = entry.span ?? DEFAULT_SPAN;
	if (delta > 0) return delta === 1 ? "明天就是" + entry.name : "快要过" + entry.name + "了";
	if (delta === 0) return "今天是" + (entry.spoken ?? entry.name);
	const daysIn = -delta;
	if (daysIn < span) return span - daysIn === 1 ? entry.name + "假期最后一天了" : "还在" + entry.name + "假期里";
	const rest = daysIn - span;
	return rest <= 1 ? entry.name + "刚过完" : entry.name + "这么快就过完了";
}
/**
* 条目 → 候选从句（不在自身窗口内则返回 undefined）。
* @param ranked - 已排序条目；`priority` 高者先出候选。
* @param delta - 相对节日起始日的天数。
*/
function candidateOf(ranked, delta) {
	const { entry, priority } = ranked;
	const ahead = entry.ahead ?? DEFAULT_AHEAD;
	const span = entry.span ?? DEFAULT_SPAN;
	const after = entry.after ?? DEFAULT_AFTER;
	const daysIn = -delta;
	if (delta > 0) {
		if (delta > ahead) return void 0;
	} else if (delta < 0) {
		if (daysIn >= span + after) return void 0;
	}
	return {
		clause: phraseOf(entry, delta),
		priority
	};
}
/** 假期区间 → 候选从句（不在窗口内返回 undefined）。 */
function seasonCandidateOf(date) {
	const year = date.getFullYear();
	const today = dayOfYear(date);
	for (const ranked of SEASON_ENTRIES) {
		const { entry, priority, from: fromMd, to: toMd } = ranked;
		const name$1 = entry.name;
		const from = dayOfYearOf(year, fromMd);
		const to = dayOfYearOf(year, toMd);
		if (today < from) {
			const ahead = from - today;
			if (ahead > SEASON_AHEAD) continue;
			return {
				clause: ahead === 1 ? "明天就放" + name$1 + "了" : "快要放" + name$1 + "了",
				priority
			};
		}
		if (today <= to) {
			if (today === from) return {
				clause: name$1 + "开始了",
				priority
			};
			if (to - today < SEASON_ENDING_AHEAD) return {
				clause: name$1 + "快结束了",
				priority
			};
			return {
				clause: "正在放" + name$1,
				priority
			};
		}
		const rest = today - to - 1;
		if (rest >= SEASON_AFTER) continue;
		return {
			clause: rest <= 1 ? name$1 + "刚结束" : name$1 + "这么快就过完了",
			priority
		};
	}
	return void 0;
}
/** 条目里最长的预热天数与回看距离（长假 15 天 + 回味 3 天），据此决定扫描窗口。 */
const HOLIDAY_ENTRIES = PRIORITY.filter((e) => e.kind !== "season");
const MAX_AHEAD = Math.max(...HOLIDAY_ENTRIES.map((e) => e.ahead ?? DEFAULT_AHEAD));
const MAX_LOOKBACK = Math.max(...HOLIDAY_ENTRIES.map((e) => (e.span ?? DEFAULT_SPAN) - 1 + (e.after ?? DEFAULT_AFTER)));
/**
* 节日从句：扫描窗口内枚举每一天命中的条目、算出各自相位与措辞，取优先级最小（数组里最靠前）的那个。
* @returns 如「今天是大年初一」「快要过国庆节了」「还在春节假期里」「正在放暑假」；无节日时 ''。
*/
function holidayClauseOf(date) {
	let best;
	const keep = (candidate) => {
		if (candidate && (!best || candidate.priority < best.priority)) best = candidate;
	};
	for (let delta = -MAX_LOOKBACK; delta <= MAX_AHEAD; delta++) {
		const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
		for (const ranked of entriesAt(day)) keep(candidateOf(ranked, delta));
	}
	keep(seasonCandidateOf(date));
	return best ? best.clause : "";
}
function timeContextOf(date) {
	if (Number.isNaN(date.getTime())) return "";
	const day = date.getDay();
	const hour = date.getHours();
	const holiday = holidayClauseOf(date);
	return "【当下】现在是" + date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日" + (WEEKDAYS[day] ?? "星期?") + " " + pad2(hour) + ":" + pad2(date.getMinutes()) + "，" + timeSlotOf(hour) + "，" + dayKindOf(day) + (holiday ? "，" + holiday : "") + "。这只是背景，不必刻意报时，也别句句都提节日——多数时候正常说话就好，真贴切时才顺口带一句。";
}

//#endregion
//#region src/host/persona.ts
function petPersona(conf, pet) {
	const own = pet.whisperPrompt;
	if (typeof own === "string" && own.trim() !== "") return own;
	const entry = conf.whisperPrompt;
	return typeof entry === "string" ? entry : "";
}
function composeSystemPrompt(parts) {
	const name$1 = String(parts.name || parts.id);
	const nameLine = name$1 ? "你的名字是“" + name$1 + "”。" : "";
	const lines = [parts.prompt, nameLine].filter((line) => line !== "");
	const time = timeContextOf(parts.now);
	if (time) lines.push(time);
	return lines.join("\n");
}

//#endregion
//#region src/host/helper-process.ts
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultHelperMain = resolve(packageRoot, "runtime", "electron-helper", "main.js");
const BRIDGE_PREFIX = "dsh-pet-bridge:";
/** 只做基本文件校验：不验证二进制格式，也不实际启动候选。 */
function isNonEmptyFile(path) {
	try {
		const stat$1 = statSync(path);
		return stat$1.isFile() && stat$1.size > 0;
	} catch {
		return false;
	}
}
function resolveElectronPath(candidates = []) {
	const seen = new Set();
	const list = [];
	const push = (value) => {
		if (!value || seen.has(value)) return;
		seen.add(value);
		list.push(value);
	};
	for (const value of candidates) push(value);
	if (process.env.DSH_PET_ELECTRON_PATH) push(process.env.DSH_PET_ELECTRON_PATH);
	try {
		const resolved = require("electron");
		if (typeof resolved === "string" && resolved) push(resolved);
	} catch {}
	push(defaultElectronExe());
	return list.find(isNonEmptyFile);
}
function hasGraphicalDisplay() {
	if (process.platform !== "linux") return true;
	if (process.env.DSH_PET_DESKTOP_FORCE === "1") return true;
	return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
function dshHomeDir() {
	const userProfile = process.env.USERPROFILE || process.env.HOME || "";
	return process.env.ZCODE_PET_HOME || process.env.DSH_HOME || join(userProfile, ".zcode");
}
/** 当前平台标识（win32 / darwin / linux）。 */
const PLAT = process.platform;
/** $DSH_HOME/electron 落地目录下，可执行文件的相对路径（按平台）。 */
const ELECTRON_REL = PLAT === "win32" ? "electron.exe" : PLAT === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron";
function electronLandingDir() {
	return join(dshHomeDir(), "electron");
}
function defaultElectronExe() {
	return join(electronLandingDir(), ELECTRON_REL);
}
async function ensureElectronDownload(options = {}) {
	const version = options.version || process.env.DSH_PET_ELECTRON_VERSION || "43.3.0";
	const mirror = options.mirror || process.env.DSH_PET_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/";
	const timeoutMs = options.timeoutMs ?? 10 * 60 * 1e3;
	const targetDir = electronLandingDir();
	const exe = defaultElectronExe();
	if (isNonEmptyFile(exe)) return exe;
	const sink = options.logger ?? console;
	const log = (message) => sink.info?.(`[dsh-pet] ${message}`);
	const warn = (message) => sink.warn?.(`[dsh-pet] ${message}`);
	const info = (consoleText, text, done = false) => {
		log(consoleText);
		options.onLog?.({
			text,
			level: "info",
			done
		});
	};
	const fail = (consoleText, text) => {
		warn(consoleText);
		options.onLog?.({
			text,
			level: "warn",
			done: true
		});
	};
	const startedAt = Date.now();
	if (existsSync(exe)) info(`Electron cache is empty or not a regular file: ${exe}`, "Electron 缓存无效，准备重新下载");
	info(`Electron not found, downloading v${version} (${PLAT}-${process.arch}) ...`, `正在下载 Electron ${version}`);
	try {
		mkdirSync(targetDir, { recursive: true });
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error(`Electron download timed out after ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		let nextLogAt = Date.now() + 3e3;
		try {
			const { downloadArtifact } = await import("@electron/get");
			const zipPath = await downloadArtifact({
				version: `v${version}`,
				artifactName: "electron",
				mirrorOptions: { mirror: mirror.replace(/\/$/, "") + "/" },
				downloadOptions: {
					signal: controller.signal,
					quiet: true,
					getProgressCallback: async (progress) => {
						const now = Date.now();
						if (!progress.total || now < nextLogAt) return;
						nextLogAt = now + 3e3;
						const doneMb = (progress.transferred / 1024 / 1024).toFixed(1);
						const totalMb = (progress.total / 1024 / 1024).toFixed(1);
						const percent = Math.min(100, Math.floor(progress.transferred / progress.total * 100));
						info(`downloading ${doneMb}MB / ${totalMb}MB`, `Electron 下载 ${percent}% · ${doneMb}/${totalMb}MB`);
					}
				}
			});
			const seconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			info(`download complete (${seconds}s), extracting to ${targetDir} ...`, `下载完成（${seconds}s），正在解压`);
			const { default: extract } = await import("@electron-internal/extract-zip");
			await extract(zipPath, { dir: targetDir });
			if (!isNonEmptyFile(exe)) throw new Error(`Electron zip extracted, but ${ELECTRON_REL} is missing, empty or not a regular file`);
			const readySeconds = ((Date.now() - startedAt) / 1e3).toFixed(1);
			info(`ready in ${readySeconds}s: ${exe}`, `Electron 就绪（${readySeconds}s），正在启动桌宠`, true);
			return exe;
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		fail(`ensure failed: ${reason}`, `Electron 下载失败：${reason}`);
		warn("desktop pet unavailable. Set DSH_PET_ELECTRON_PATH to an existing Electron, or retry later.");
		return void 0;
	}
}
function defaultLaunch(options = {}) {
	const electronPath = resolveElectronPath([options.electronPath]);
	if (!electronPath) throw new Error("dsh-pet: cannot resolve Electron executable. Set DSH_PET_ELECTRON_PATH or install electron.");
	const helperPath = options.helperPath || defaultHelperMain;
	return {
		command: electronPath,
		args: [helperPath]
	};
}
const HELPER_STOP_TIMEOUT_MS = 3e3;
const HELPER_STOP_GRACE_MS = 1e3;
function helperSpawnEnv(hostPid, extra) {
	const env = {
		...process.env,
		DSH_PET_HOST_PID: String(hostPid),
		...extra
	};
	delete env.ELECTRON_RUN_AS_NODE;
	return env;
}
var HelperProcess = class {
	constructor(options = {}, logger = console) {
		this.options = options;
		this.logger = logger;
		this.child = void 0;
		this.stopping = false;
		this.restartTimer = void 0;
		this.restartFailures = 0;
		this.lastStartAt = 0;
		this.stdoutBuffer = "";
	}
	/** 拉起子进程；已有子进程在跑或正在停止时直接返回现有句柄。 */
	start() {
		if (this.child || this.stopping) return this.child;
		this.lastStartAt = Date.now();
		const helperPath = this.options.helperPath || defaultHelperMain;
		const launch = this.options.command ? {
			command: this.options.command,
			args: this.options.args || [helperPath]
		} : defaultLaunch(this.options);
		const command = launch.command;
		const args = this.options.args || launch.args;
		const cwd = this.options.cwd || dshHomeDir();
		mkdirSync(cwd, { recursive: true });
		const child = spawn(command, args, {
			cwd,
			env: helperSpawnEnv(process.pid, this.options.env),
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.once("error", (error) => {
			this.logger.error?.(`dsh-pet desktop helper failed to start: ${error.message}`);
			if (child.pid === void 0 && this.child === child) {
				this.child = void 0;
				this.scheduleRestart();
			}
		});
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = void 0;
			if (!this.stopping) {
				this.logger.warn?.(`dsh-pet desktop helper exited (code=${String(code)}, signal=${String(signal)}); restarting`);
				this.scheduleRestart();
			}
		});
		child.stdout.on("data", (chunk) => {
			this.onStdoutChunk(String(chunk));
		});
		child.stderr.on("data", (chunk) => {
			const line = String(chunk).trim();
			if (line) this.logger.warn?.(`[dsh-pet desktop helper] ${line}`);
		});
		child.stdin?.on("error", () => {});
		return child;
	}
	/** stdout 按行缓冲：`dsh-pet-bridge:` 前缀整行 = 协议请求，其余 = 日志行。 */
	onStdoutChunk(chunk) {
		this.stdoutBuffer += chunk;
		let nl;
		while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			const trimmed = line.trim();
			if (!trimmed) continue;
			if (trimmed.startsWith(BRIDGE_PREFIX)) {
				this.handleBridgeLine(trimmed);
				continue;
			}
			this.logger.debug?.(`[dsh-pet desktop helper] ${trimmed}`);
		}
	}
	/** 处理一条协议请求：交给宿主 bridgeHandler，结果按 id POST 回 main.js 的回调服务器
	*  （cb 由请求行携带；不走 stdin —— Electron 主进程收不到 piped stdin） */
	async handleBridgeLine(line) {
		const child = this.child;
		if (!child?.stdin || !this.options.bridgeHandler) return;
		let req;
		try {
			req = JSON.parse(line.slice(BRIDGE_PREFIX.length));
		} catch {
			this.logger.warn?.("[dsh-pet desktop helper] bridge 协议行非法，已忽略");
			return;
		}
		if (typeof req.id !== "number") return;
		try {
			const resp = await this.options.bridgeHandler(req);
			this.sendBridgeResponse(req, resp);
		} catch (e) {
			this.sendBridgeResponse(req, {
				id: req.id,
				status: 500,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({ error: `bridge handler error: ${e instanceof Error ? e.message : String(e)}` })
			});
		}
	}
	/** 把应答发回 main.js：优先 POST 到请求行携带的 cb（本地回调服务器）；无 cb 时回写 stdin（低版本兼容）。 */
	sendBridgeResponse(req, resp) {
		const cb = typeof req.cb === "string" && /^https?:[/][/]/.test(req.cb) ? req.cb : "";
		if (cb) {
			fetch(cb, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(resp)
			}).catch(() => {});
			return;
		}
		const child = this.child;
		if (!child?.stdin || child.stdin.destroyed) return;
		try {
			child.stdin.write(BRIDGE_PREFIX + JSON.stringify(resp) + "\n");
		} catch {}
	}
	/** 停止 helper：发 SIGTERM 即返回，不等它退出。宿主退出 / 插件卸载路径用它——宿主马上就没了
	*  （Windows 有 job 对象、POSIX 有 helper 自己的 host-liveness 兜底）。
	*  停止后要立刻重启的场景必须用 stopAndWait()，否则新旧进程会短暂重叠。 */
	stop(reason = "plugin-disposed") {
		this.stopping = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		this.logger.debug?.(`dsh-pet desktop helper stopping (${reason})`);
		const child = this.child;
		if (!child) return;
		child.kill();
	}
	/**
	* 停止 helper 并等它真正退出：只发一次 SIGTERM 就 spawn 新进程是不行的——Electron 收到 SIGTERM 后
	* 关窗、销毁 GPU/动画合成器是异步的（几百 ms 起），旧窗口（旧大小）还没消失、新窗口已经画出来，
	* 桌面上会短暂出现「两只宠物」。所以：① 先置 `stopping`（由 stop() 完成），守护逻辑不得把这次主动
	* 停止误判成崩溃去自动重启；② 只等 `exit` 不等 `close`——stdio 管道关闭远早于进程真正退出；③ 超时
	* （默认 3s）升级 SIGKILL，再给 1s 宽限，仍未退出就放弃等待，配置保存绝不能被无限挂住。
	*/
	async stopAndWait(reason = "plugin-disposed", timeoutMs = HELPER_STOP_TIMEOUT_MS) {
		this.stop(reason);
		const child = this.child;
		if (!child) return;
		await waitForChildExit(child, timeoutMs, () => {
			this.logger.warn?.(`dsh-pet desktop helper 未在 ${timeoutMs}ms 内退出，升级 SIGKILL（${reason}）`);
			try {
				child.kill("SIGKILL");
			} catch {}
		});
	}
	scheduleRestart() {
		if (this.restartTimer || this.stopping) return;
		if (helperRunIsStable(Date.now() - this.lastStartAt)) this.restartFailures = 0;
		else this.restartFailures += 1;
		if (shouldCircuitBreak(this.restartFailures, this.resolveMaxFailures())) {
			this.logger.error?.(`dsh-pet desktop helper crashed ${this.restartFailures} consecutive times; circuit breaker tripped, no more restarts. Fix the environment (e.g. DISPLAY/headless) or set DSH_PET_RESTART_MAX_FAILURES to raise the limit.`);
			return;
		}
		const base = this.resolveRestartBaseMs();
		const delay = restartBackoffDelayMs(this.restartFailures - 1, base);
		this.logger.warn?.(`dsh-pet desktop helper exited; restarting in ${Math.round(delay)}ms (attempt ${this.restartFailures}, consecutive-crash limit ${this.resolveMaxFailures()})`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start();
		}, delay);
		this.restartTimer.unref?.();
	}
	/** 退避基值：DSH_PET_RESTART_BASE_MS（ms，>0）可调，默认 750。 */
	resolveRestartBaseMs() {
		return envPositiveInt(process.env.DSH_PET_RESTART_BASE_MS, RESTART_BASE_MS_DEFAULT);
	}
	/** 熔断阈值：DSH_PET_RESTART_MAX_FAILURES（次，>0）可调，默认 12。 */
	resolveMaxFailures() {
		return envPositiveInt(process.env.DSH_PET_RESTART_MAX_FAILURES, RESTART_MAX_FAILURES_DEFAULT);
	}
};
/**
* 等子进程真正退出：已经退出（exitCode / signalCode 有值）→ 立即 resolve，不挂监听；只等 `exit`，
* `close` 只代表 stdio 管道关闭，远早于进程真正退出；到 timeoutMs 调 onTimeout()（调用方升级
* SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；宽限到点仍未退出就 resolve——调用方绝不能被无限挂住。
*/
function waitForChildExit(child, timeoutMs, onTimeout) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve$1) => {
		let giveUpTimer;
		const done = () => {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.removeListener("exit", done);
			resolve$1();
		};
		const killTimer = setTimeout(() => {
			onTimeout();
			giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
			giveUpTimer.unref?.();
		}, timeoutMs);
		killTimer.unref?.();
		child.once("exit", done);
	});
}
const HELPER_STABLE_MS = 3 * 60 * 1e3;
function restartBackoffDelayMs(consecutiveFailures, baseMs = 750) {
	const MAX = 3e4;
	const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
	return Math.min(raw, MAX);
}
function shouldCircuitBreak(consecutiveFailures, limit = 12) {
	return consecutiveFailures >= limit;
}
function helperRunIsStable(elapsedMs) {
	return elapsedMs >= HELPER_STABLE_MS;
}
/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
const RESTART_BASE_MS_DEFAULT = 750;
/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
const RESTART_MAX_FAILURES_DEFAULT = 12;
/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
function envPositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

//#endregion
//#region src/host/index.ts
const name = "pet";
const inject = [
	"webServer",
	"agentDefaultModel",
	"credentials",
	"llm",
	"commands",
	"connection"
];
/** 本包目录：宿主构建产物位于 lib/，其上一级即包根。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** 包内 assets 根 */
const PACKAGE_ROOT_ASSETS = join(PACKAGE_ROOT, "assets");
/** 包内表情包目录（表情包池的最后一环：assets/memes/<名称>.png） */
const PACKAGE_MEMES_DIR = join(PACKAGE_ROOT_ASSETS, "memes");
/** 路由前缀 */
const ROUTE_PREFIX = "/dsh-pet-7340";
/**
* 宿主是不是 DSH 桌面应用（Electron 宿主）：判据只用 `process.versions.electron`。
* 桌面应用以 `ELECTRON_RUN_AS_NODE=1` 跑宿主时该字段照样在，`dsh web` 与独立模式取不到；
* 据此把「打开网站」分派到桌面应用窗口（helper 走 `dsh://open`）或系统浏览器。
*/
const isDesktopHost = () => Boolean(process.versions.electron);
/** 不同扩展名对应的 Content-Type 映射 */
const MIME = {
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mp4": "video/mp4",
	".png": "image/png",
	".wav": "audio/wav",
	".json": "application/json; charset=utf-8",
	".jsonc": "application/json; charset=utf-8",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2"
};
/**
* 规范化并校验请求路径，确保它在 assets 根目录内（防路径穿越）。
* @returns 规范化后的绝对文件路径；非法（穿越）时返回 undefined。
*/
function resolveAsset(root, rel) {
	if (rel.length === 0) return void 0;
	const candidate = normalize(join(root, rel));
	const rootWithSep = root.endsWith(sep) ? root : root + sep;
	if (candidate !== root && !candidate.startsWith(rootWithSep)) return void 0;
	return candidate;
}
/** 在 root 下解析并确认实体存在；非法（穿越）或不存在时返回 undefined */
function resolveExisting(root, rel) {
	const candidate = resolveAsset(root, rel);
	return candidate && existsSync(candidate) ? candidate : void 0;
}
/**
* 流式返回一个文件（带 Content-Type / 长度 / 缓存头）。
*
* Content-Length 必须取自正在读的那个 fd（open 事件里 fstat）：先 stat 再另开流，会在素材被覆盖/
* 截断时声明长度大于实际字节，响应永远不结束也不报错（浏览器 stalled、视频 loadeddata 永不触发）。
* 同一个 fd 的 fstat 拿到的大小与随后读出的字节天然一致。
*/
function sendFile(res, file, contentType) {
	const stream = createReadStream(file);
	stream.once("open", (fd) => {
		if (res.destroyed || res.writableEnded) {
			stream.destroy();
			return;
		}
		try {
			res.writeHead(200, {
				"content-type": contentType,
				"content-length": fstatSync(fd).size,
				"cache-control": "public, max-age=3600"
			});
		} catch {
			res.writeHead(200, {
				"content-type": contentType,
				"cache-control": "public, max-age=3600"
			});
		}
		stream.pipe(res);
	});
	stream.on("error", () => res.destroy());
	res.on("close", () => stream.destroy());
}
/** 该宠物是否参与桌面模式（Electron 透明窗） */
const isDesktopVisible = (display) => display === "desktop" || display === "both";
/** 发送 JSON 响应（headers 可选：如 no-cache 触发计数） */
function sendJson(res, status, obj$1, headers = {}) {
	const body = JSON.stringify(obj$1);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	res.end(body);
}
/** 发送纯文本响应（素材 404/400 等显式错误文案） */
function sendText(res, status, body) {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
	res.end(body);
}
/** 收集请求体（文本） */
function readBody(req) {
	return new Promise((resolve2, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve2(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
function apply(ctx) {
	const dshHome = resolveDshHome();
	const userRoot = join(dshHome, "zcode-pet");
	const reusedLog = isFileLogger(ctx.logger) ? ctx.logger : void 0;
	const log = reusedLog ?? createFileLogger({
		file: join(userRoot, "logs.txt"),
		base: ctx.logger,
		debugEnabled: process.env.DSH_PET_LOG_DEBUG === "1"
	});
	setDefaultLogger(log);
	if (!reusedLog) ctx.effect(() => () => {
		log.flush();
		log.dispose();
	}, "dsh-pet: log file");
	/**
	* 软取宿主提供的可选服务（DSH 的 `ctx.get(name, required)` 语义：缺失返回 undefined，不抛）。
	*
	* 不能直接读 `ctx.xxx`：DSH 的 ctx 是严格 getter，读未写进 inject 的服务会抛异常而非返回 undefined
	* ——独立模式独有的 standaloneAi / shutdownApp 都没进 inject，裸读会让碎碎念 tick 每拍抛错、
	* /quit 回 500 而不是 {canQuit:false}。测试里的 fake ctx 没有 get，回落成属性读取即可。
	*/
	const optionalService = (name$1) => {
		const get = ctx.get;
		if (typeof get === "function") return get.call(ctx, name$1, false);
		return ctx[name$1];
	};
	/** 独立模式的碎碎念授权策略（可选能力）：DSH 宿主里是 undefined → 回落到只看 pet.whisperEnabled。 */
	const standaloneAiPolicy = () => optionalService("standaloneAi");
	const userConfigPath = join(userRoot, "main-config.jsonc");
	const legacyUserConfigPath = join(userRoot, "main-config.json");
	const petConfigDir = join(userRoot, "pet");
	const configPaths = {
		defaultFile: join(PACKAGE_ROOT, "assets", "config.jsonc"),
		userFile: userConfigPath,
		legacyUserFile: legacyUserConfigPath,
		petDir: petConfigDir
	};
	migrateUserConfig(configPaths, (msg) => log.info("[dsh-pet] " + msg));
	const thumbUserRoot = join(userRoot, "main-animation");
	const memesUserRoot = join(userRoot, "memes");
	/**
	* 表情包目录链，与动画素材（/thumb）同一套归属语义：`pet/<素材根>-memes/` 存在则只查它；
	* 否则用户目录优先、包内兜底。池（readMemePool）与路由（/pic/memes）必须走同一个函数，
	* 否则池里能选的名字路由取不到，气泡配图会图裂。
	* 素材根来自 URL 段，必须先过 resolveAsset，避免 Windows 上 %5C 解出的反斜杠逃出用户根。
	*/
	const memeDirsFor = (assetRoot) => {
		const own = resolveAsset(petConfigDir, assetRoot + "-memes");
		if (own !== void 0 && existsSync(own)) return [own];
		return [memesUserRoot, PACKAGE_MEMES_DIR];
	};
	const state = new PollStateStore();
	const menuRegistry = new MenuRegistry();
	ctx.provide("petApi7340", { balance: {
		register: registerBalanceProvider,
		list: listBalanceProviders
	} });
	const playback = new PlaybackStore();
	const workStatus = new WorkStatusStore();
	/** 外部写入槽：固定会话 id，最后写入者生效；不做多写者仲裁/租约/会话管理 */
	const EXTERNAL_WORK_SESSION = "api";
	let externalWorkSeq = 0;
	const WORK_STATE_GAP_MS = 5e3;
	let publishedWork = "\0";
	let publishedState = null;
	let publishedWorkAt = 0;
	let workFlushTimer = null;
	const publishWorkStatus = () => {
		const snap = workStatus.snapshot();
		const key = String(snap.state) + "\0" + String(snap.task);
		if (key === publishedWork) return;
		const busyFlip = publishedState === "working" && snap.state === "result";
		const wait = WORK_STATE_GAP_MS - (Date.now() - publishedWorkAt);
		if (busyFlip && wait > 0) {
			workFlushTimer ?? (workFlushTimer = setTimeout(() => {
				workFlushTimer = null;
				publishWorkStatus();
			}, wait));
			return;
		}
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		publishedWork = key;
		publishedState = snap.state;
		publishedWorkAt = Date.now();
		state.writeSection("workStatus", {
			state: snap.state,
			task: snap.task
		});
	};
	/** Electron 下载日志的收尾槽位保留时长（ms）：够看清「就绪 / 失败」，又不让这条日志一直盖住
	*  随后真实的工作状态（终态档在渲染端本来也会 10s 自动收起气泡）。 */
	const DOWNLOAD_SLOT_CLEAR_MS = 12 * 1e3;
	let downloadSlotTimer = null;
	/**
	* 写一条 Electron 下载日志进工作状态：桌面版用户没有控制台，这是唯一能看到「后台在下什么」的地方。
	* 借外部写入槽 `api`（不新增 section）；先 setState 再 setTask（条目不存在时 setTask 直接返回 false），
	* seq 必须递增（同档位且 seq 未更新时 setState 短路），文案按 TASK_TEXT_MAX 截断。
	*/
	const reportDownload = (text, state$1, terminal = false) => {
		const points = Array.from(text);
		const task = points.length > TASK_TEXT_MAX ? `${points.slice(0, TASK_TEXT_MAX).join("")}…` : text;
		externalWorkSeq += 1;
		workStatus.setState(EXTERNAL_WORK_SESSION, state$1, externalWorkSeq);
		workStatus.setTask(EXTERNAL_WORK_SESSION, task);
		publishWorkStatus();
		if (!terminal) return;
		if (downloadSlotTimer !== null) clearTimeout(downloadSlotTimer);
		downloadSlotTimer = setTimeout(() => {
			downloadSlotTimer = null;
			if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
		}, DOWNLOAD_SLOT_CLEAR_MS);
		downloadSlotTimer.unref?.();
	};
	const lock = new LockStore({ onChange: (petId, data) => state.writePet(petId, "lock", data) });
	const pose = new PoseStore();
	/**
	* `?surface=` 的参数级校验（缺省 / 非法 → `bad-request`）。放在读盘之前：必然失败的请求不碰磁盘；
	* 通过则给出收窄后的取值。
	*/
	const surfaceParam = (params) => {
		const want = normalizeSurface(params.get("surface"));
		if (want !== null) return {
			ok: true,
			want
		};
		return {
			ok: false,
			res: {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: SURFACE_TEXT
				}
			}
		};
	};
	/**
	* `?surface=` 与该宠物 `display` 的对齐校验：不满足 → `pet-not-displayed`，并把实际 display
	* 原样回给调用方；放行回 null。
	* 这是前置校验，不是按面分发——指令照旧写进同一个叶子、两端内容完全一致。
	*/
	const surfaceMismatch = (pet, petId, want) => {
		const display = String(pet.display ?? "");
		if (displayCovers(want, display)) return null;
		return {
			kind: "json",
			status: 200,
			obj: {
				ok: false,
				reason: "pet-not-displayed",
				message: petId + " 的显示模式是 " + display + "，不满足 surface=" + want,
				display
			}
		};
	};
	/**
	* 决策函数之后的 surface 校验（/anim、/broadcast、/bubble/clear、/position、/throw 共用）：
	* 这几条的 pet 解析住在各自决策模块里，所以按 petId 再查一次实例取 display。
	* 位置与 lockBlocked 一致——都在决策函数之后、任何副作用之前，顺序是「body → pet → surface → 锁」。
	*/
	const surfaceBlocked = (cfg, petId, params) => {
		const p = surfaceParam(params);
		if (!p.ok) return p.res;
		return surfaceMismatch(findPetInstance(cfg, petId)?.pet ?? {}, petId, p.want);
	};
	/**
	* 路由层的 pet 参数解析（/lock、/lock/release、/whisper、/chat 用；其余动作端点的同一套校验
	* 住在各自决策模块里，口径一致）：必填且必须真实存在。
	*
	* 两种失败分开报：没给 / 空串 → `pet-required`；给了但配置里没有 → `unknown-pet`。
	* 绝不默认退到列表第一只——落点会随用户 /pet 操作漂移，失败也不报，第三方无从预期。
	*
	* `cfg` 传惰性读取：pet 空串时不必碰磁盘（routes.test.ts 的「配置不可达」断言靠这个顺序钉住）。
	* `opts.surface` 只对会产生渲染端可见效果的端点开；/lock/release 与 /chat 的 GET 不开——
	* 释放必须永远能成功，读记忆与显示在哪一端无关。
	*/
	const requirePet = (params, cfg, opts) => {
		const fail = (reason, message) => ({
			ok: false,
			res: {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason,
					message
				}
			}
		});
		const petId = String(params.get("pet") ?? "").trim();
		if (!petId) return fail("pet-required", "pet 必填：要指定操作哪只桌宠");
		let want = null;
		if (opts?.surface === true) {
			const p = surfaceParam(params);
			if (!p.ok) return {
				ok: false,
				res: p.res
			};
			want = p.want;
		}
		const found = findPetInstance(cfg(), petId);
		if (!found) return fail("unknown-pet", "没有这只桌宠：" + petId);
		if (want !== null) {
			const mismatch = surfaceMismatch(found.pet, petId, want);
			if (mismatch) return {
				ok: false,
				res: mismatch
			};
		}
		return {
			ok: true,
			petId,
			entry: found.entry,
			conf: found.conf,
			pet: found.pet
		};
	};
	/**
	* 动作端点的占用门禁（/anim、/broadcast、/position、/throw、/bubble/clear 共用）：放行回 null。
	* 无锁时按「有没有带 lock」分流：没带 → 放行（既有调用方零改动）；带了但查不到 → `lock-lost`。
	* 位置在决策函数之后：petId 要先解析出来才知道问哪只宠物的锁，而那时还没有任何副作用。
	*/
	const lockBlocked = (petId, params) => {
		const g = lock.gate(petId, String(params.get("lock") ?? ""));
		if (g.ok) return null;
		return {
			kind: "json",
			status: 200,
			obj: g.reason === "lock-lost" ? {
				ok: false,
				reason: g.reason,
				cause: g.cause,
				message: g.message
			} : {
				ok: false,
				reason: g.reason,
				message: g.message
			}
		};
	};
	const pushNotifyFrame = (frame) => {
		state.writeSection("notify", frame);
	};
	const turnFlags = new Map();
	/** 终态（success/error）展示窗口定时器：约 60s 后清掉该会话条目，陈旧完成态不再浮上来。 */
	const terminalTimers = new Map();
	const TERMINAL_KEEP_MS = 60 * 1e3;
	/**
	* 每会话最近一条 todo 文案：工具跑完要把气泡「还」给它。没有这份缓存，`tool/result` 写 null
	* 就只能回落到通用档位文案，用户刚看到的清单进度会被抹掉。
	*/
	const lastTodoText = new Map();
	/**
	* 每会话「正在跑、且气泡上有具体描述」的工具数（不是布尔）：并行调用时先返回的那个不该把
	* 仍在中途的另一个描述顶掉。只统计拿到了目标的调用——没写出描述就不该占位。
	*/
	const toolsInFlight = new Map();
	const bumpToolsInFlight = (sessionId, delta) => {
		const next = (toolsInFlight.get(sessionId) ?? 0) + delta;
		if (next > 0) toolsInFlight.set(sessionId, next);
		else toolsInFlight.delete(sessionId);
	};
	/** 取消某会话待执行的终态清理：会话已回到非终态，那次清理到点后既不清理也不重排，留着只会误导 */
	const cancelTerminalCleanup = (sessionId) => {
		const t = terminalTimers.get(sessionId);
		if (t === void 0) return;
		clearTimeout(t);
		terminalTimers.delete(sessionId);
	};
	/** 排一个终态清理定时器（每会话一个，已排则跳过） */
	const scheduleTerminalCleanup = (sessionId) => {
		if (terminalTimers.has(sessionId)) return;
		const t = setTimeout(() => {
			terminalTimers.delete(sessionId);
			const sessionState = workStatus.stateOf(sessionId);
			if (sessionState === "success" || sessionState === "error") {
				workStatus.clear(sessionId);
				turnFlags.delete(sessionId);
				lastTodoText.delete(sessionId);
				toolsInFlight.delete(sessionId);
				publishWorkStatus();
			}
		}, TERMINAL_KEEP_MS);
		terminalTimers.set(sessionId, t);
	};
	const NOTIFY_ACTIVITY_DELAY_MS = 1500;
	/** 每会话一个待查定时器（同会话连续收尾只保留最后一次：后到覆盖先到，与单槽帧同语义） */
	const notifyActivityTimers = new Map();
	/** 这条会话是否还有在跑的活；判据不可用一律 false＝放行 */
	const sessionHasRunningWork = async (sessionId) => {
		const waterfall = ctx.waterfall;
		if (typeof waterfall !== "function") return false;
		try {
			const activity = await waterfall.call(ctx, "workspace/session-activity", { sessionId }, () => Promise.resolve([]));
			return hasBlockingActivity(activity);
		} catch {
			return false;
		}
	};
	/** 排一个活动门定时器：到点确认空闲才推这一帧 */
	const scheduleCompletionNotify = (sessionId, event) => {
		const prev = notifyActivityTimers.get(sessionId);
		if (prev !== void 0) clearTimeout(prev);
		notifyActivityTimers.set(sessionId, setTimeout(() => {
			notifyActivityTimers.delete(sessionId);
			(async () => {
				if (await sessionHasRunningWork(sessionId)) return;
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionId));
			})();
		}, NOTIFY_ACTIVITY_DELAY_MS));
	};
	let activePetId = "";
	const lastWhisperAt = new Map();
	const memoryPath = join(userRoot, "memory.json");
	let chatQueue = Promise.resolve();
	/** 读记忆文件：不存在 → 空；解析失败/根不是对象 → 记日志 + 空记忆（不备份、不改写源文件） */
	const readMemory = async () => {
		let raw;
		try {
			raw = await readFile(memoryPath, "utf8");
		} catch {
			return {};
		}
		try {
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
			return parsed;
		} catch (e) {
			log.error(`dsh-pet: 记忆文件无法解析（对话将从头开始）：${memoryPath}（${e instanceof Error ? e.message : String(e)}）`);
			return {};
		}
	};
	const writeMemory = async (mem) => {
		await mkdir(userRoot, { recursive: true });
		await writeFile(memoryPath, JSON.stringify(mem, null, 2), "utf8");
	};
	/** 把一次读写封进串行队列（同进程内防交错），返回 fn 的结果 */
	const withMemoryLock = (fn) => {
		const run = chatQueue.then(fn, fn);
		chatQueue = run.then(() => void 0, () => void 0);
		return run;
	};
	/** 某宠物的最终人设 system：实例级 `pets[].whisperPrompt` 优先，没写回落到所属条目的那份。
	*  拼装在 ./persona（纯函数）：人设正文 + 名字声明 + 一行时间背景，时间每次现算。
	*  收 `findPetInstance` 的命中结果而不是 (petId, cfg)：调用方都已解析过，再查只会多一处
	*  「查不到就兜底 main」的不可达分支。 */
	const petSystemPrompt = (found) => composeSystemPrompt({
		prompt: petPersona(found.conf, found.pet),
		name: String(found.pet.name ?? ""),
		id: String(found.pet.id ?? ""),
		now: new Date()
	});
	/** 对话记忆轮数（1 轮 = 1 问 1 答）：该宠物所属条目的 chatMemoryRounds（合并器已填默认）。
	*  收已解析的条目配置：调用方都已拿到 `findPetInstance` 的结果。 */
	const memoryRounds = (conf) => {
		const v = Number(conf.chatMemoryRounds);
		return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5;
	};
	/** 生成并返回某宠物的一句碎碎念（周期调度与菜单手动触发共用）：人设取它自己的 whisperPrompt，
	*  没写回落到所属条目；成功写进 S 的 pets.<id>.say——碎碎念 / 命令气泡 / 对话回复在前端是同一条
	*  展示链路，所以共用一个叶子。配图开关开启时从表情包池随机抽 1 张。
	*  失败带回真实 reason（含 unknown-pet），成功带回生成的文本——调用方不必再拉一拍 /state。 */
	const publishWhisper = async (petId) => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const system = petSystemPrompt(found);
		const meme = found.conf.whisperImageEnabled === true ? pickMeme(readMemePool(found.conf.memes, memeDirsFor(found.entry))) : void 0;
		const result = await generateWhisper(ctx, system, meme, configuredModel(found.conf, "whisperModel"));
		if (!result.ok) {
			log.warn("[dsh-pet] 碎碎念生成失败 pet=" + petId + " reason=" + result.reason + (result.message ? " " + result.message : ""));
			return result;
		}
		state.writePet(petId, "say", result.image ? {
			text: result.text,
			image: result.image
		} : { text: result.text });
		log.info(`[dsh-pet] 碎碎念生成成功 pet=${petId}，${result.text.length} 字` + (result.image ? `，配图=${result.image}` : ""));
		return {
			ok: true,
			text: result.text,
			...result.image ? { image: result.image } : {}
		};
	};
	/** 与某只宠物对话：截取最近记忆 → 生成回复 → 写入记忆 → 写进 S 的 pets.<id>.say。
	*  供 POST /chat 与 /chat 命令共用（锁内读写，防两端交错写盘）；成功带回回复文本。 */
	const chatWithPet = async (petId, text) => withMemoryLock(async () => {
		const cfg = readAllConfig(configPaths);
		const found = findPetInstance(cfg, petId);
		if (!found) return {
			ok: false,
			reason: "unknown-pet",
			message: "没有这只桌宠：" + petId
		};
		const rounds = memoryRounds(found.conf);
		const system = petSystemPrompt(found);
		const pool = found.conf.chatImageEnabled === true ? limitPool(readMemePool(found.conf.memes, memeDirsFor(found.entry)), Number(found.conf.chatImageLimit)) : [];
		const mem = await readMemory();
		const bucket = mem[found.entry] && typeof mem[found.entry] === "object" && !Array.isArray(mem[found.entry]) ? mem[found.entry] : mem[found.entry] = {};
		const existing = bucket[petId];
		if (existing !== void 0 && (!existing || !Array.isArray(existing.messages))) log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId}，按新会话处理：${memoryPath}`);
		const entry = existing && Array.isArray(existing.messages) ? existing : bucket[petId] = { messages: [] };
		const list = sliceMemoryRounds(entry.messages, rounds);
		const generated = await generateChat(ctx, system, list, text, pool, configuredModel(found.conf, "chatModel"));
		if (!generated.ok) return generated;
		const now = Date.now();
		entry.messages.push({
			role: "user",
			content: text,
			ts: now
		});
		entry.messages.push({
			role: "assistant",
			content: generated.text,
			ts: now
		});
		await writeMemory(mem);
		state.writePet(petId, "say", generated.image ? {
			text: generated.text,
			image: generated.image
		} : { text: generated.text });
		return {
			ok: true,
			text: generated.text,
			...generated.image ? { image: generated.image } : {}
		};
	});
	/** 当前生效宠物列表：成品配置拍平（合并器已保证 id 唯一、字段填满），命令与桌面模式共用。 */
	const effectivePetList = () => flattenPetList(readAllConfig(configPaths));
	/** 余额刷新周期（秒）：成品 main 条目的 eventsRefreshSec.balance（合并器已填默认；非法兜底 1800） */
	const balancePeriodSec = (cfg) => {
		const ers = cfg.main?.eventsRefreshSec;
		const n = Number(ers?.balance);
		return Number.isFinite(n) && n > 0 ? n : 1800;
	};
	/** 碎碎念周期（秒）：该宠物所属条目的 eventsRefreshSec.whisper（合并器已填默认；非法兜底 300）。
	*  收已解析的条目配置：唯一调用方是周期调度，它的 petId 就是从同一份 cfg 拍平出来的。 */
	const whisperPeriodSec = (conf) => {
		const ers = conf.eventsRefreshSec;
		const n = Number(ers?.whisper);
		return Number.isFinite(n) && n > 0 ? n : 300;
	};
	/**
	* 账号服务要求的调用方身份（`AccountClientMetadata`）：只影响请求来源标识与服务端本地化文案，
	* 不参与余额数值与币种。version 读自身 package.json（读不到回落 '0.0.0'）；locale 固定 zh-CN。
	*/
	const accountClientMetadata = () => {
		let version = "0.0.0";
		try {
			const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
			if (typeof raw.version === "string" && raw.version.length > 0) version = raw.version;
		} catch {}
		return {
			version,
			locale: "zh-CN",
			timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
		};
	};
	/**
	* 刷新余额并写入轮询状态：host 侧唯一的余额查询点，两端从 /state 读同一份结果。
	* 失败也写进状态（reason 区分 unsupported / credential-missing / fetch-error）：余额不可用要弹
	* 文字说明，不能静默；意外异常同样落成 fetch-error。
	*
	* @param manual - 这次刷新是否由用户触发（/balance 命令、桌面「查看余额」菜单）；标记随数据写进
	*   叶子，前端据此决定余额不可用时是否必弹文字说明（周期刷新只在原因变化时弹一次）。
	*/
	const refreshBalance = async (manual = false) => {
		log.info(`[dsh-pet] 余额刷新开始（${manual ? "手动" : "周期"}）`);
		const mark = (v) => manual ? {
			...v,
			manual: true
		} : v;
		try {
			const sel = ctx.agentDefaultModel.currentSelection();
			const result = await queryBalance(
				sel.provider,
				async (ref) => {
					const rc = await ctx.credentials.resolve(credentialRef(ref));
					return rc?.value;
				},
				// `deepseek-account`（免费额度 / 平台登录）没有 API Key：它的凭证是 DSH 账号服务
				// 持有的授权记录，只能经 getBalance 查询。账号服务是可选服务（软取，不放进 inject）
				// ——没装账号插件时它不在场，此时该路由报 credential-missing 而不是崩。
				async () => {
					const account = ctx.get("deepseekAccount", false);
					if (!account) return void 0;
					return account.getBalance(accountClientMetadata());
				}
);
			state.writeSection("balance", mark(result));
			if (result.ok) log.info(`[dsh-pet] 余额刷新成功 provider=${result.provider}（${result.shape}）`);
			else log.warn(`[dsh-pet] 余额刷新失败 provider=${result.provider} reason=${result.reason}` + (result.message ? " " + result.message : ""));
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			state.writeSection("balance", mark({
				ok: false,
				provider: "unknown",
				reason: "fetch-error",
				message
			}));
			log.warn("[dsh-pet] 余额刷新异常：" + message);
		}
	};
	/** 当前交互桌宠 id：/pet 已选且仍存在 → 该宠物；未选/已失效 → 有效宠物列表第一只（进程内，重启回默认） */
	const resolveActivePetId = () => {
		try {
			const eff = effectivePetList();
			if (eff.length === 0) return "";
			if (activePetId && eff.some((p) => String(p.id) === activePetId)) return activePetId;
			return String(eff[0].id);
		} catch {
			return activePetId;
		}
	};
	/** 宠物的显示名（name，缺失回落 id）——命令文案用 */
	const petDisplayName = (pet) => {
		const n = String(pet.name ?? "").trim();
		return n || String(pet.id ?? "");
	};
	let hasDesktopPet = false;
	/**
	* 桌面模式是否成功启动过（粘性，仅本插件生命周期内有效）：把「没有桌面宠物就不启动」放宽成
	* 「从来没有过桌面宠物才不启动」——桌面宠物全改成 web/none 之后，Helper 仍带着空列表常驻，
	* 只为留住托盘（那是桌面侧唯一还能把宠物切回桌面的入口）。
	* 判据收紧成 `desktopModeEverActive && trayOn`：托盘关掉时没人需要那个图标，常驻只是空进程。
	* 纯浏览器用户（从未有过桌面宠物）不受影响：照旧不探测、不下载、不拉起 Electron。
	*/
	let desktopModeEverActive = false;
	/** 系统托盘是否开启（main 条目的 trayEnabled，缺失按开）；与 hasDesktopPet 同一次读盘取得。 */
	let trayOn = true;
	const refreshDesktop = () => {
		hasDesktopPet = false;
		try {
			const merged = readAllConfig(configPaths);
			const pets = flattenPetList(merged);
			const desktopPets = pets.filter((p) => isDesktopVisible(p.display));
			hasDesktopPet = desktopPets.length > 0;
			trayOn = merged.main?.trayEnabled !== false;
			log.info(`[dsh-pet] 桌面判定：pets=${pets.length}，桌面可见=${desktopPets.length}（${desktopPets.map((p) => String(p.id)).join(",") || "无"}）→ hasDesktopPet=${hasDesktopPet} tray=${trayOn}`);
		} catch (e) {
			log.warn(`[dsh-pet] 宠物配置非法，桌面模式已跳过：${e instanceof Error ? e.message : String(e)}`);
		}
	};
	refreshDesktop();
	/** 桌面可见宠物列表（[{id,size}]）：透传 Helper 决定创建几个局部窗口（每宠物一个）。 */
	const desktopPetList = () => {
		try {
			return effectivePetList().filter((p) => isDesktopVisible(p.display)).map((p) => ({
				id: String(p.id),
				size: Number(p.size)
			}));
		} catch {
			return [];
		}
	};
	let helper;
	let startRetryTimer;
	let electronEnsure;
	let disposed = false;
	/** 「无图形环境」提示只在进程生命周期内打一次，避免守护循环刷屏 */
	let displayWarned = false;
	/** 「无桌面宠物 → 跳过」的 info 只打一次：纯网页用户每次启动都会走这条短路，不该刷屏 */
	let noDesktopSkipped = false;
	/** webServer 端口等待次数：只用于日志节流，不改变重试行为 */
	let portWaitAttempts = 0;
	/**
	* 宿主即应用（`src/app/main.ts`）：本进程自己就是 Electron 主进程，窗口由它直接建。
	* 两条启动路径都必须短路，缺一不可：launchHelper 会 spawn 第二个 electron.exe（用户看到两只
	* 宠物）；startHelper 会白下整套 Electron（实测 347 MB），双击启动变成一次大下载。
	* 用环境变量而不是 ctx 服务：只为这个布尔再撑大 apply() 的 ctx 契约不值得。
	*/
	const inProcessHost = process.env.DSH_PET_IN_PROCESS === "1";
	/** 用已确认存在的 Electron 路径拉起桌面 Helper（每只桌面宠物一个局部小窗口）。 */
	const launchHelper = (electronPath) => {
		if (inProcessHost) return;
		if (helper || disposed) return;
		if (!hasDesktopPet && !(desktopModeEverActive && trayOn)) return;
		const port = typeof ctx.webServer?.port === "number" ? ctx.webServer.port : 0;
		if (!port || port <= 0) {
			portWaitAttempts += 1;
			if (portWaitAttempts === 1) log.info(`[dsh-pet] webServer 端口尚未就绪（port=${String(port)}），每 500ms 重试拉起桌面 Helper`);
			else if (portWaitAttempts % 20 === 0) log.warn(`[dsh-pet] 已等待 webServer 端口 ${portWaitAttempts * 500 / 1e3}s 仍未就绪（port=${String(port)}），桌面 Helper 尚未拉起`);
			if (!startRetryTimer) {
				startRetryTimer = setTimeout(() => {
					startRetryTimer = void 0;
					launchHelper(electronPath);
				}, 500);
				startRetryTimer.unref?.();
			}
			return;
		}
		portWaitAttempts = 0;
		const origin = `http://127.0.0.1:${port}`;
		const siteUrl = ctx.connection.authenticatedUrl(origin);
		const configUrl = `${origin}${ROUTE_PREFIX}/config`;
		helper = new HelperProcess({
			electronPath,
			env: {
				DSH_PET_CONFIG_URL: configUrl,
				DSH_PET_SITE_URL: siteUrl,
				DSH_PET_OPEN_TARGET: isDesktopHost() ? "desktop" : "site",
				DSH_PET_SCALE: "1",
				DSH_PET_BRIDGE: "1",
				DSH_PET_PETS: JSON.stringify(desktopPetList())
			},
			bridgeHandler: async (req) => {
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", req.body);
				if (result.kind === "file") return {
					id: req.id,
					status: 200,
					contentType: result.contentType,
					file: result.file
				};
				if (result.kind === "text") return {
					id: req.id,
					status: result.status,
					contentType: "text/plain; charset=utf-8",
					body: result.body
				};
				if (result.kind === "none") return {
					id: req.id,
					status: 204,
					contentType: "text/plain; charset=utf-8",
					body: ""
				};
				return {
					id: req.id,
					status: result.status,
					contentType: "application/json; charset=utf-8",
					body: JSON.stringify(result.obj)
				};
			}
		}, log);
		try {
			helper.start();
			desktopModeEverActive = true;
			log.info(`dsh-pet desktop helper started (config: ${configUrl})`);
		} catch (e) {
			log.warn(`dsh-pet desktop helper start failed: ${e instanceof Error ? e.message : String(e)}`);
			helper = void 0;
		}
	};
	/** 拉起桌面 Helper：先探测本机 Electron；缺失时进程内异步下载
	*  （不 spawn 子进程，CLI node 与 DSH Desktop 均适用），下载完成后自动拉起。 */
	const startHelper = () => {
		if (inProcessHost) return;
		if (helper || electronEnsure || disposed) return;
		if (!hasDesktopPet && !(desktopModeEverActive && trayOn)) {
			if (!noDesktopSkipped) {
				noDesktopSkipped = true;
				log.info(`[dsh-pet] 无桌面宠物（display 均为 web/none）且无需保留托盘（tray=${trayOn}），已跳过桌面 Helper 启动`);
			}
			return;
		}
		if (!hasGraphicalDisplay()) {
			if (!displayWarned) {
				displayWarned = true;
				log.warn("[dsh-pet] 未检测到图形显示环境（DISPLAY/WAYLAND_DISPLAY 均为空），已跳过桌面宠物。浏览器内宠物不受影响；如需在服务器上启用桌面模式，请配置 Xvfb 后设置 DSH_PET_DESKTOP_FORCE=1。");
			}
			return;
		}
		const found = resolveElectronPath();
		if (found) {
			launchHelper(found);
			return;
		}
		log.warn(`[dsh-pet] 未找到 Electron 可执行文件：DSH_HOME=${dshHomeDir()}，查找路径=${defaultElectronExe()}，DSH_PET_ELECTRON_PATH=${process.env.DSH_PET_ELECTRON_PATH ?? "(未设置)"}`);
		log.warn(`[dsh-pet] 开始下载 Electron 到 ${defaultElectronExe()} ...`);
		electronEnsure = ensureElectronDownload({
			onLog: ({ text, level, done }) => reportDownload(text, level === "warn" ? "error" : done ? "success" : "working", done),
			logger: log
		}).then((path) => {
			if (path) launchHelper(path);
			else log.warn("[dsh-pet] Electron download failed; desktop pet unavailable. Set DSH_PET_ELECTRON_PATH and restart, or retry later.");
		}).finally(() => {
			electronEnsure = void 0;
		});
	};
	/** 停止桌面 Helper（保留配置，可再次拉起）。宿主退出/插件卸载路径：不等它退干净（见 stopAndWait）。 */
	const stopHelper = (reason = "settings-change") => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		helper?.stop(reason);
		helper = void 0;
	};
	/** 停止并等旧 helper 真正退出：配置变更触发的「停旧起新」专用。 */
	const stopHelperAndWait = async (reason) => {
		if (startRetryTimer) {
			clearTimeout(startRetryTimer);
			startRetryTimer = void 0;
		}
		const old = helper;
		helper = void 0;
		await old?.stopAndWait(reason);
	};
	/**
	* 宠物配置（display / size 等）变更后：重解析桌面宠物，等旧 helper 退出再拉起新的。
	*
	* Electron 收到 SIGTERM 后关窗是异步的（几百 ms 起），发完 kill 就 spawn 新进程会让旧窗口与
	* 新窗口短暂共存（用户看到「改完大小冒出来第二只宠物」）；连续保存也会交错拉起两个 helper，
	* 所以用队列串行，且队列自身绝不留下 rejected 状态。
	*/
	let desktopSyncQueue = Promise.resolve();
	const syncDesktop = () => {
		desktopSyncQueue = desktopSyncQueue.then(async () => {
			refreshDesktop();
			await stopHelperAndWait("desktop-config-change");
			startHelper();
		}).catch((e) => {
			log.warn(`[dsh-pet] 重启桌面 Helper 失败：${e instanceof Error ? e.message : String(e)}`);
		});
		return desktopSyncQueue;
	};
	/** 扩展名 → 素材子目录名（webm → webm/，mov → mov/；其余落在动画目录平级放行） */
	const animSubdirFor = (ext) => ext === ".mov" ? "mov" : "webm";
	/** 包内动画素材根：按扩展名取子目录（webm/ 随包发布；mov/ 不存在时为 404 兜底，仅 macOS 自维护）。 */
	const assetRootFor = (ext) => join(PACKAGE_ROOT, "assets", animSubdirFor(ext));
	/** 用户动画根：按扩展名取子目录（main-animation/webm 或 main-animation/mov）。 */
	const userRootFor = (ext) => join(thumbUserRoot, animSubdirFor(ext));
	let configQueue = Promise.resolve();
	/** 单次业务路由（HTTP 落盘与桌面 Helper 管道共用同一份实现）：输入 rawUrl + method + body 文本，
	*  返回 RouteResult，消费方各自落盘——业务逻辑只有一份，两端天然一致。
	*  signal 可选：调用方断开时中止挂起等待（只有 /playback 的 wait 分支会用到；管道侧不传）。 */
	const handlePetRoute = async (rawUrl, method, body, signal) => {
		const url = new URL(rawUrl, "http://localhost");
		const rest = decodeURIComponent(url.pathname.slice(ROUTE_PREFIX.length + 1));
		const run = () => dispatchPetRoute(url, rest, method, body, signal);
		if (rest === "config" || rest === "pet-display" && method === "POST") {
			const pending = configQueue.then(run, run);
			configQueue = pending.then(() => void 0, () => void 0);
			return pending;
		}
		return run();
	};
	const dispatchPetRoute = async (url, rest, method, body, signal) => {
		if (rest === "config") {
			if (method === "GET") try {
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths),
					headers: { "cache-control": "no-cache, no-store" }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
			if (method === "PUT") {
				let parsed;
				try {
					parsed = JSON.parse(body ?? "");
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: { error: "invalid JSON body" }
					};
				}
				try {
					const existing = readUserConfig(configPaths);
					const clean = saveUserConfig(parsed, existing);
					if (!clean) return {
						kind: "json",
						status: 400,
						obj: { error: "invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（id 为非空字符串且去除首尾空白后唯一；display 为 web/desktop/both/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled / trayEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）" }
					};
					if (url.searchParams.get("force") !== "1" && userConfigUnparsable(configPaths)) return {
						kind: "json",
						status: 409,
						obj: {
							error: "user config is unparsable",
							needConfirm: true,
							userFile: userConfigPath
						}
					};
					await mkdir(userRoot, { recursive: true });
					await writeFile(userConfigPath, JSON.stringify(clean, null, 2), "utf8");
					syncDesktop();
					return {
						kind: "json",
						status: 200,
						obj: readAllConfig(configPaths)
					};
				} catch (e) {
					ctx.logger?.warn?.(`[dsh-pet] config save failed: ${e instanceof Error ? e.message : String(e)}`);
					return {
						kind: "json",
						status: 500,
						obj: { error: "failed to save config" }
					};
				}
			}
			if (method === "POST") {
				try {
					syncUserConfigFromDefault(configPaths);
				} catch (e) {
					return {
						kind: "json",
						status: 500,
						obj: { error: e instanceof Error ? e.message : String(e) }
					};
				}
				syncDesktop();
				return {
					kind: "json",
					status: 200,
					obj: readAllConfig(configPaths)
				};
			}
			return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
		}
		if (rest === "pet-display") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const fail = (reason, message) => ({
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason,
					message
				}
			});
			let payload;
			try {
				payload = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const petId$1 = typeof payload.id === "string" ? payload.id.trim() : "";
			const nextDisplay = String(payload.display ?? "");
			if (!petId$1) return fail("pet-required", "pet 必填：要指定操作哪只桌宠");
			if (!PET_DISPLAY_SET.has(nextDisplay)) return fail("bad-request", `display 必须是 web / desktop / both / none：${nextDisplay}`);
			let merged;
			try {
				merged = readAllConfig(configPaths);
			} catch (e) {
				return fail("generate-error", e instanceof Error ? e.message : String(e));
			}
			const hit = findPetInstance(merged, petId$1);
			if (!hit) return fail("unknown-pet", `没有这只桌宠：${petId$1}`);
			let layerPath;
			let layerDir;
			let existing;
			if (hit.entry === "main") {
				layerPath = userConfigPath;
				layerDir = userRoot;
				existing = readUserConfig(configPaths);
			} else {
				const file$1 = readPetConfigEntry(configPaths, hit.entry);
				if (!file$1) return fail("generate-error", `宠物条目配置文件找不到：${hit.entry}`);
				layerPath = file$1.path;
				layerDir = petConfigDir;
				existing = file$1.raw;
			}
			const layerPets = Array.isArray(hit.conf.pets) ? hit.conf.pets : [];
			const pets = layerPets.map((p) => String(p.id) === petId$1 ? {
				...p,
				display: nextDisplay
			} : p);
			const clean = saveUserConfig({ pets }, existing);
			if (!clean) return fail("bad-request", "宠物配置非法");
			try {
				await mkdir(layerDir, { recursive: true });
				await writeFile(layerPath, JSON.stringify(clean, null, 2), "utf8");
			} catch (e) {
				return fail("generate-error", e instanceof Error ? e.message : String(e));
			}
			state.writeSection("config", {});
			if (nextDisplay === "none") lock.release({
				petId: petId$1,
				force: true
			});
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: readAllConfig(configPaths)
			};
		}
		if (rest === "reload") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			syncDesktop();
			return {
				kind: "json",
				status: 200,
				obj: { reloading: true }
			};
		}
		if (rest === "quit") {
			const quit = optionalService("shutdownApp");
			const canQuit = typeof quit === "function";
			if (method === "GET") return {
				kind: "json",
				status: 200,
				obj: { canQuit }
			};
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			if (!canQuit) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "unsupported",
					message: "宿主未提供退出能力（DSH 内请关闭桌面模式）"
				}
			};
			setImmediate(() => {
				try {
					quit("托盘退出");
				} catch (e) {
					log.warn(`[dsh-pet] 托盘退出失败：${e instanceof Error ? e.message : String(e)}`);
				}
			});
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "config/meta") return {
			kind: "json",
			status: 200,
			obj: {
				user: userConfigPath,
				default: join(PACKAGE_ROOT, "assets", "config.jsonc"),
				animations: thumbUserRoot,
				memes: memesUserRoot,
				logs: log.file,
				storage: storageEntries({
					userDataRoot: userRoot,
					electronDir: electronLandingDir(),
					home: homedir(),
					packageRoot: PACKAGE_ROOT
				}),
				profile: profileNameFrom(PACKAGE_ROOT) ?? ""
			}
		};
		if (rest === "menu/item") {
			if (method === "DELETE") {
				const result$1 = menuRegistry.clear(url.searchParams.get("owner") ?? "");
				if (!result$1.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: result$1.reason,
						message: result$1.message
					}
				};
				state.writeSection("menu", { items: menuRegistry.snapshot() });
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						removed: result$1.removed
					}
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const result = menuRegistry.register(parsed);
			if (!result.ok) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: result.reason,
					message: result.message
				}
			};
			state.writeSection("menu", { items: menuRegistry.snapshot() });
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "menu/events") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const owner = url.searchParams.get("owner") ?? "";
			const rawWait = Number(url.searchParams.get("wait") ?? "0");
			const waitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, MENU_WAIT_MAX_MS) : 0;
			const events = await menuRegistry.poll(owner, waitMs);
			if (events === null) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "unknown-owner",
					message: "这个 owner 没有注册，重新注册即可"
				}
			};
			return {
				kind: "json",
				status: 200,
				obj: {
					ok: true,
					events
				}
			};
		}
		if (rest === "menu/click") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			return {
				kind: "json",
				status: 200,
				obj: menuRegistry.click(parsed)
			};
		}
		if (rest === "models") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const llm = ctx.llm;
				const named = (id, name$1) => {
					const pid = String(id ?? "");
					return {
						id: pid,
						name: String(name$1 ?? "") || pid
					};
				};
				let providers = (typeof llm?.listProviders === "function" ? llm.listProviders() : []).map((p) => named(p?.id, p?.name));
				if (providers.length === 0 && typeof llm?.listConfigurableProviders === "function") providers = llm.listConfigurableProviders().map((p) => named(p?.provider, p?.displayName));
				providers = providers.filter((p) => p.id);
				const catalog = await Promise.all(providers.map(async (p) => {
					let models = [];
					try {
						const list = await llm?.listModels?.(p.id);
						models = (Array.isArray(list) ? list : []).map((m) => named(m?.id, m?.name)).filter((m) => m.id);
					} catch {}
					return {
						...p,
						models
					};
				}));
				return {
					kind: "json",
					status: 200,
					obj: { providers: catalog }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 500,
					obj: { error: e instanceof Error ? e.message : String(e) }
				};
			}
		}
		if (rest === "state") {
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const headers = { "cache-control": "no-cache, no-store" };
			const parsed = parseStateWaitQuery(url.searchParams.get("since"), url.searchParams.get("timeout"));
			if (parsed.kind === "error") return {
				kind: "json",
				status: 400,
				obj: { error: parsed.error }
			};
			const current = state.read();
			if (parsed.kind === "none" || current.counter !== parsed.since) return {
				kind: "json",
				status: 200,
				obj: current,
				headers
			};
			const since = parsed.since;
			return await new Promise((resolveWait) => {
				let settled = false;
				/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
				const settle = (result) => {
					if (settled) return;
					settled = true;
					resolveWait(result);
				};
				const cancel = state.wait({
					since,
					timeoutMs: parsed.timeoutMs,
					onWake: () => settle({
						kind: "json",
						status: 200,
						obj: state.read(),
						headers
					})
				});
				const onAbort = () => {
					cancel();
					settle({ kind: "none" });
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (rest === "work-status") {
			if (method === "DELETE") {
				if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
				return {
					kind: "text",
					status: 204,
					body: ""
				};
			}
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			if (Buffer.byteLength(body ?? "", "utf8") > 8 * 1024) return {
				kind: "json",
				status: 413,
				obj: { error: "body too large" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid JSON body" }
			};
			const payload = parsed;
			const state$1 = payload.state;
			if (typeof state$1 !== "string" || !HOST_WORK_STATUS_STATES.includes(state$1)) return {
				kind: "json",
				status: 400,
				obj: { error: "invalid state" }
			};
			let task;
			if (Object.prototype.hasOwnProperty.call(payload, "task")) if (payload.task === null) task = null;
			else if (typeof payload.task === "string") {
				const trimmed = payload.task.trim();
				if (trimmed === "") task = null;
				else if (Array.from(trimmed).length > TASK_TEXT_MAX) return {
					kind: "json",
					status: 400,
					obj: { error: `task too long (max ${TASK_TEXT_MAX} code points)` }
				};
				else task = trimmed;
			} else return {
				kind: "json",
				status: 400,
				obj: { error: "invalid task" }
			};
			externalWorkSeq += 1;
			workStatus.setState(EXTERNAL_WORK_SESSION, state$1, externalWorkSeq);
			if (task !== void 0) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
			publishWorkStatus();
			return {
				kind: "json",
				status: 200,
				obj: {
					state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state$1,
					task: workStatus.taskOf(EXTERNAL_WORK_SESSION)
				}
			};
		}
		if (rest === "balance") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			await refreshBalance(true);
			return {
				kind: "json",
				status: 200,
				obj: { ok: true }
			};
		}
		if (rest === "lock" || rest === "lock/release") {
			const isRelease = rest === "lock/release";
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: !isRelease });
				if (!who.ok) return who.res;
				const petId$1 = who.petId;
				if (isRelease) {
					const d$1 = lock.release({
						petId: petId$1,
						lockId: o.lockId,
						force: o.force
					});
					if (!d$1.ok) {
						const obj$1 = {
							ok: false,
							reason: d$1.reason,
							message: d$1.message
						};
						if (d$1.reason === "lock-lost") obj$1.cause = d$1.cause;
						return {
							kind: "json",
							status: 200,
							obj: obj$1
						};
					}
					return {
						kind: "json",
						status: 200,
						obj: { ok: true }
					};
				}
				const d = lock.acquire({
					petId: petId$1,
					lockId: o.lockId,
					ttl: o.ttl
				});
				if (!d.ok) {
					const obj$1 = {
						ok: false,
						reason: d.reason,
						message: d.message
					};
					if (d.reason === "locked") obj$1.expiresAt = d.expiresAt;
					if (d.reason === "lock-lost") obj$1.cause = d.cause;
					return {
						kind: "json",
						status: 200,
						obj: obj$1
					};
				}
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						lockId: d.lockId,
						petId: d.petId,
						expiresAt: d.expiresAt
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "whisper") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths), { surface: true });
				if (!who.ok) return who.res;
				const r = await publishWhisper(who.petId);
				if (r.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						text: r.text,
						...r.image ? { image: r.image } : {}
					}
				};
				const obj$1 = {
					ok: false,
					reason: r.reason
				};
				if (r.message) obj$1.message = r.message;
				return {
					kind: "json",
					status: 200,
					obj: obj$1
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "broadcast") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			if (!normalizeBroadcastText(o.text)) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "text 为空"
				}
			};
			const duration = normalizeBroadcastDuration(o.duration);
			if (duration === null) return {
				kind: "json",
				status: 200,
				obj: {
					ok: false,
					reason: "bad-request",
					message: "duration 必须是 ≥0 的有限数字（毫秒）"
				}
			};
			const anim = normalizeBroadcastAnim(o.anim);
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBroadcast({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					text: o.text,
					image: o.image,
					url: o.url,
					duration,
					anim,
					memeDirs: memeDirsFor
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				const pic = d.url !== void 0 ? { url: d.url } : d.image !== void 0 ? { image: d.image } : {};
				state.writePet(d.petId, "say", {
					text: d.text,
					...pic,
					duration: d.duration,
					anim: d.anim
				});
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "bubble/clear") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideBubbleClear({
					cfg,
					requested: String(url.searchParams.get("pet") ?? "")
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				state.writePet(d.petId, "say", { clear: true });
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "anim") {
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const d = decideAnim({
					cfg,
					requested: String(url.searchParams.get("pet") ?? ""),
					name: o.name,
					url: o.url,
					facing: o.facing
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				const record = playback.create(d.petId, d.url ?? d.name ?? "");
				state.writePet(d.petId, "anim", {
					...d.url !== void 0 ? { url: d.url } : { name: d.name },
					playbackId: record.playbackId,
					...d.facing === void 0 ? {} : { facing: d.facing }
				});
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						playbackId: record.playbackId
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "position" || rest === "throw") {
			const isPosition = rest === "position";
			if (method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsed;
			try {
				parsed = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			const o = parsed && typeof parsed === "object" ? parsed : {};
			try {
				const cfg = readAllConfig(configPaths);
				const requested = String(url.searchParams.get("pet") ?? "");
				if (isPosition) {
					const d$1 = decidePosition({
						cfg,
						requested,
						x: o.x,
						y: o.y,
						mode: o.mode,
						duration: o.duration
					});
					if (!d$1.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: d$1.reason,
							message: d$1.message
						}
					};
					const noSurface$1 = surfaceBlocked(cfg, d$1.petId, url.searchParams);
					if (noSurface$1) return noSurface$1;
					const blocked$1 = lockBlocked(d$1.petId, url.searchParams);
					if (blocked$1) return blocked$1;
					state.writePet(d$1.petId, "position", positionLeafData(d$1));
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							x: d$1.x,
							y: d$1.y
						}
					};
				}
				const d = decideThrow({
					cfg,
					requested,
					angle: o.angle,
					power: o.power
				});
				if (!d.ok) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: d.reason,
						message: d.message
					}
				};
				const noSurface = surfaceBlocked(cfg, d.petId, url.searchParams);
				if (noSurface) return noSurface;
				const blocked = lockBlocked(d.petId, url.searchParams);
				if (blocked) return blocked;
				state.writePet(d.petId, "throw", {
					angle: d.angle,
					power: d.power
				});
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		if (rest === "pose" || rest === "pose/report") {
			const isReport = rest === "pose/report";
			if (isReport && method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			if (!isReport && method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			let parsedPose;
			if (isReport) try {
				parsedPose = JSON.parse(body ?? "null");
			} catch {
				return {
					kind: "json",
					status: 400,
					obj: { error: "invalid JSON body" }
				};
			}
			try {
				const who = requirePet(url.searchParams, () => readAllConfig(configPaths));
				if (!who.ok) return who.res;
				if (isReport) {
					const p = normalizePoseInput(parsedPose);
					if (!p.ok) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: p.reason,
							message: p.message
						}
					};
					pose.set(who.petId, p.pose);
					return {
						kind: "json",
						status: 200,
						obj: { ok: true }
					};
				}
				const display = String(who.pet.display ?? "");
				if (!displayCovers("desktop", display)) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "pet-not-displayed",
						message: who.petId + " 的显示模式是 " + display + "；桌面端实况只对 display 含 desktop 的宠物有",
						display
					}
				};
				const snap = pose.get(who.petId);
				if (snap === void 0) return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "pose-unavailable",
						message: "还没收到过这只宠物的桌面端实况（桌面端没起来，或刚重启还没来得及上报）"
					}
				};
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: true,
						petId: who.petId,
						...snap
					}
				};
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const playbackPath = rest === "playback" || rest.startsWith("playback/") ? parsePlaybackPath(rest) : void 0;
		if (playbackPath) {
			const playbackId = playbackPath.playbackId;
			if (playbackPath.isReport) {
				if (method !== "POST") return {
					kind: "json",
					status: 405,
					obj: { error: "method not allowed" }
				};
				let reported;
				try {
					reported = JSON.parse(body ?? "null");
				} catch {
					return {
						kind: "json",
						status: 400,
						obj: { error: "invalid JSON body" }
					};
				}
				const o = reported && typeof reported === "object" ? reported : {};
				const outcome = playback.report(playbackId, o.status, o.reason);
				if (outcome === "unknown") return {
					kind: "json",
					status: 404,
					obj: { error: "unknown playback" }
				};
				if (outcome === "invalid") return {
					kind: "json",
					status: 400,
					obj: { error: "invalid status" }
				};
				return {
					kind: "json",
					status: 200,
					obj: { ok: true }
				};
			}
			if (method !== "GET") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			const record = playback.get(playbackId);
			if (!record) return {
				kind: "json",
				status: 404,
				obj: { error: "unknown playback" }
			};
			const parsed = parseWaitQuery(url.searchParams.get("wait"), url.searchParams.get("timeout"));
			if (parsed.kind === "error") return {
				kind: "json",
				status: 400,
				obj: { error: parsed.error }
			};
			if (parsed.kind === "none") return {
				kind: "json",
				status: 200,
				obj: {
					...record,
					matched: false
				}
			};
			const { wait: waitList, timeoutMs } = parsed;
			if (waitList.includes(record.status)) return {
				kind: "json",
				status: 200,
				obj: {
					...record,
					matched: true
				}
			};
			return await new Promise((resolveWait) => {
				let settled = false;
				/** 收尾：只认第一次（唤醒 / 超时 / 取消 / 调用方断开 都可能先后到达） */
				const settle = (result) => {
					if (settled) return;
					settled = true;
					resolveWait(result);
				};
				const cancel = playback.wait({
					playbackId,
					wait: waitList,
					timeoutMs,
					onWake: (r, matched) => settle({
						kind: "json",
						status: 200,
						obj: {
							...r,
							matched
						}
					})
				});
				if (cancel === void 0) {
					settle({
						kind: "json",
						status: 404,
						obj: { error: "unknown playback" }
					});
					return;
				}
				const onAbort = () => {
					cancel();
					settle({ kind: "none" });
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		if (rest === "chat") {
			if (method !== "GET" && method !== "POST") return {
				kind: "json",
				status: 405,
				obj: { error: "method not allowed" }
			};
			try {
				const roundsRaw = method === "GET" ? url.searchParams.get("rounds") : null;
				let roundsOverride = null;
				if (roundsRaw !== null && roundsRaw.trim() !== "") {
					const n = Number(roundsRaw);
					if (!Number.isInteger(n) || n < 0 || n > 200) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "rounds 必须是 0–200 的整数（不传则用配置）"
						}
					};
					roundsOverride = n;
				}
				let cfgCache;
				const cfg = () => cfgCache ?? (cfgCache = readAllConfig(configPaths));
				const who = requirePet(url.searchParams, cfg, { surface: method === "POST" });
				if (!who.ok) return who.res;
				const petId$1 = who.petId;
				if (method === "GET") {
					const mem = await readMemory();
					const rawMessages = mem[who.entry]?.[petId$1]?.messages;
					const list = Array.isArray(rawMessages) ? rawMessages.filter((m) => m && typeof m.content === "string") : [];
					if (rawMessages !== void 0 && !Array.isArray(rawMessages)) log.error(`[dsh-pet] 记忆结构异常（messages 不是数组）pet=${petId$1}，按空历史处理：${memoryPath}`);
					const rounds = roundsOverride ?? memoryRounds(who.conf);
					const messages = sliceMemoryRounds(list, rounds);
					return {
						kind: "json",
						status: 200,
						obj: {
							ok: true,
							messages,
							rounds
						}
					};
				}
				if (method === "POST") {
					const parsed = JSON.parse(body ?? "null") ?? {};
					const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
					if (!text) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息为空"
						}
					};
					if (text.length > 2e3) return {
						kind: "json",
						status: 200,
						obj: {
							ok: false,
							reason: "bad-request",
							message: "消息过长（限 2000 字）"
						}
					};
					const result = await chatWithPet(petId$1, text);
					return {
						kind: "json",
						status: 200,
						obj: result
					};
				}
			} catch (e) {
				return {
					kind: "json",
					status: 200,
					obj: {
						ok: false,
						reason: "generate-error",
						message: e instanceof Error ? e.message : String(e)
					}
				};
			}
		}
		const [scope, ...restParts] = rest.split("/");
		if (scope === "font") {
			const fontRoot = join(PACKAGE_ROOT, "assets", "fonts");
			const fontFile = resolveExisting(fontRoot, restParts.join("/"));
			if (fontFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: font not found"
			};
			const ext$1 = fontFile.slice(fontFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: fontFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope === "pic") {
			if (restParts[0] === "memes") {
				const segs = restParts.slice(1);
				const scoped = segs.length >= 2;
				const assetRoot = scoped ? segs[0] : "main";
				if (scoped && (assetRoot.length > 64 || ID_FORBIDDEN.test(assetRoot))) return {
					kind: "text",
					status: 400,
					body: "dsh-pet: invalid asset root"
				};
				const rel = (scoped ? segs.slice(1) : segs).join("/");
				let picFile$1;
				for (const dir of memeDirsFor(assetRoot)) {
					picFile$1 = resolveExisting(dir, rel);
					if (picFile$1 !== void 0) break;
				}
				if (picFile$1 === void 0) return {
					kind: "text",
					status: 404,
					body: "dsh-pet: pic not found"
				};
				const ext$2 = picFile$1.slice(picFile$1.lastIndexOf(".")).toLowerCase();
				return {
					kind: "file",
					file: picFile$1,
					contentType: MIME[ext$2] ?? "application/octet-stream"
				};
			}
			const picRoot = join(PACKAGE_ROOT, "assets", "pic");
			const picFile = resolveExisting(picRoot, restParts.join("/"));
			if (picFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: pic not found"
			};
			const ext$1 = picFile.slice(picFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: picFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope === "sound") {
			const soundRoot = join(PACKAGE_ROOT, "assets", "sound");
			const soundFile = resolveExisting(soundRoot, restParts.join("/"));
			if (soundFile === void 0) return {
				kind: "text",
				status: 404,
				body: "dsh-pet: sound not found"
			};
			const ext$1 = soundFile.slice(soundFile.lastIndexOf(".")).toLowerCase();
			return {
				kind: "file",
				file: soundFile,
				contentType: MIME[ext$1] ?? "application/octet-stream"
			};
		}
		if (scope !== "thumb") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		const [petId, ...nameParts] = restParts;
		if (!petId || nameParts.length === 0) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>"
		};
		if (ID_FORBIDDEN.test(petId)) return {
			kind: "text",
			status: 400,
			body: "dsh-pet: invalid pet id"
		};
		const fileName = nameParts.join("/");
		const ext = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
		if (ext !== ".webm" && ext !== ".mov") return {
			kind: "text",
			status: 400,
			body: "dsh-pet: unsupported animation format (expected .webm or .mov)"
		};
		const extraAnimDir = resolveAsset(petConfigDir, petId + "-animation");
		/** 按扩展名查同名素材（专属目录优先；否则用户根 → 包内根） */
		const findAnim = (e) => {
			const name$1 = fileName.replace(/\.(webm|mov)$/i, "") + e;
			return extraAnimDir !== void 0 && existsSync(extraAnimDir) ? resolveExisting(extraAnimDir, name$1) : resolveExisting(userRootFor(e), name$1) ?? resolveExisting(assetRootFor(e), name$1);
		};
		let file = findAnim(ext);
		let servedExt = ext;
		if (file === void 0 && ext === ".mov") {
			const fb = findAnim(".webm");
			if (fb !== void 0) {
				file = fb;
				servedExt = ".webm";
			}
		}
		if (file === void 0) return {
			kind: "text",
			status: 404,
			body: "dsh-pet: asset not found"
		};
		return {
			kind: "file",
			file,
			contentType: MIME[servedExt] ?? "application/octet-stream"
		};
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const abort = new AbortController();
			const onClose = () => abort.abort();
			res.on("close", onClose);
			try {
				const body = req.method === "PUT" || req.method === "POST" ? await readBody(req) : void 0;
				const result = await handlePetRoute(req.url ?? "/", req.method ?? "GET", body, abort.signal);
				res.off("close", onClose);
				if (result.kind === "json") sendJson(res, result.status, result.obj, result.headers);
				else if (result.kind === "text") sendText(res, result.status, result.body);
				else if (result.kind === "none") {} else sendFile(res, result.file, result.contentType);
			} catch (e) {
				res.off("close", onClose);
				if (!res.destroyed && !res.writableEnded) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
			}
		}
	}), "dsh-pet: /dsh-pet-7340 asset route");
	ctx.effect(() => {
		const dispose = ctx.on("session/event", (session, event) => {
			const type = event?.type;
			if (!type) return;
			const sessionId = String(session?.header?.id ?? session?.id ?? "unknown");
			if (type === "todo/write") {
				const text = currentTaskFromTodo(event);
				lastTodoText.set(sessionId, text);
				if ((toolsInFlight.get(sessionId) ?? 0) > 0) return;
				if (workStatus.has(sessionId)) {
					workStatus.setTask(sessionId, text);
					publishWorkStatus();
				}
				return;
			}
			if (type === "user/message") {
				const source = event?.data?.source;
				if (source?.kind === "goal") {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.goalRound = true;
					turnFlags.set(sessionId, flags);
				}
				return;
			}
			if (type === "turn/start") {
				turnFlags.set(sessionId, {
					goalRound: false,
					closing: null
				});
				workStatus.setTask(sessionId, null);
				lastTodoText.delete(sessionId);
				toolsInFlight.delete(sessionId);
				publishWorkStatus();
			}
			if (type === "tool/call" && String(event?.data?.name ?? "") === GOAL_UPDATE_TOOL) {
				const action = goalUpdateAction(String(event?.data?.arguments ?? ""));
				if (action) {
					const flags = turnFlags.get(sessionId) ?? {
						goalRound: false,
						closing: null
					};
					flags.closing = action;
					turnFlags.set(sessionId, flags);
				}
			}
			const next = reduceWorkStatus(event, turnFlags.get(sessionId));
			if (!next) {
				if (type === "turn/end") {
					turnFlags.delete(sessionId);
					cancelTerminalCleanup(sessionId);
					lastTodoText.delete(sessionId);
					toolsInFlight.delete(sessionId);
					workStatus.clear(sessionId);
					publishWorkStatus();
				}
				return;
			}
			const seq = Number(event.seq ?? 0);
			const detail = type === "tool/call" ? toolDetailFromEvent(event) : null;
			const changed = workStatus.setState(sessionId, next, seq);
			if (detail !== null) {
				bumpToolsInFlight(sessionId, 1);
				workStatus.setTask(sessionId, detail);
			} else if (type === "tool/result") {
				if ((toolsInFlight.get(sessionId) ?? 0) > 0) bumpToolsInFlight(sessionId, -1);
				if ((toolsInFlight.get(sessionId) ?? 0) === 0) workStatus.setTask(sessionId, lastTodoText.get(sessionId) ?? null);
			}
			publishWorkStatus();
			if (!changed) return;
			if (next === "success" || next === "error") scheduleTerminalCleanup(sessionId);
			else cancelTerminalCleanup(sessionId);
		});
		return () => {
			dispose();
			for (const t of terminalTimers.values()) clearTimeout(t);
			terminalTimers.clear();
		};
	}, "dsh-pet: work-status session events");
	ctx.effect(() => {
		const sessionDispose = ctx.on(
			"session/event",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- session/event 载荷无公开类型，any 只用于接收，函数内立刻交给 shouldNotifySession / reduceNotifyFrame 推导
			(session, event) => {
				if (!shouldNotifySession(session)) return;
				if (isCompletionTurnEnd(event)) {
					scheduleCompletionNotify(sessionIdOf(session), event);
					return;
				}
				const frame = reduceNotifyFrame(event);
				if (frame) pushNotifyFrame(withSessionId(frame, sessionIdOf(session)));
			}
);
		const errorDispose = ctx.on(
			"agent/error",
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- agent/error 载荷无公开类型，且低版本 DSH 可能不带 error 字段，只能 any 后按可选链取 payload?.error
			(payload) => {
				pushNotifyFrame(agentErrorFrame(payload?.error));
			}
);
		return () => {
			for (const t of notifyActivityTimers.values()) clearTimeout(t);
			notifyActivityTimers.clear();
			sessionDispose();
			errorDispose();
		};
	}, "dsh-pet: notify frames");
	ctx.effect(() => ctx.commands.register({
		name: "balance",
		description: "手动触发桌宠余额显示（立即弹出余额气泡）",
		handler: () => {
			refreshBalance(true);
			return {
				kind: "success",
				text: "已触发桌宠余额显示"
			};
		}
	}), "dsh-pet: /balance command");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		async function tick() {
			let sec;
			try {
				const cfg = readAllConfig(configPaths);
				sec = balancePeriodSec(cfg);
				if (flattenPetList(cfg).some((p) => p.balanceEnabled === true)) await refreshBalance();
				else log.info("[dsh-pet] 余额周期跳过：没有启用余额的宠物");
			} catch (e) {
				log.warn("[dsh-pet] 余额周期读配置失败，周期刷新已停止（重启 DSH 后恢复）：" + (e instanceof Error ? e.message : String(e)));
				return;
			}
			arm(sec);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: balance poll");
	ctx.effect(() => {
		let disposed$1 = false;
		let timer = null;
		function arm(sec) {
			if (disposed$1) return;
			timer = setTimeout(() => void tick(), Math.max(1e3, sec * 1e3));
		}
		function tick() {
			let next = 300;
			try {
				const cfg = readAllConfig(configPaths);
				const now = Date.now();
				let min = Infinity;
				let checked = 0;
				let due = 0;
				let notDue = 0;
				const skipped = [];
				for (const pet of flattenPetList(cfg)) {
					const petId = String(pet.id ?? "");
					if (!petId) continue;
					const found = findPetInstance(cfg, petId);
					if (!found) continue;
					checked += 1;
					const schedule = automaticWhisperSchedule(standaloneAiPolicy(), pet.whisperEnabled === true, whisperPeriodSec(found.conf));
					if (!schedule.enabled) {
						skipped.push(petId + ": " + (pet.whisperEnabled === true ? "独立模式未授权自动碎碎念" : "whisperEnabled=false"));
						continue;
					}
					const sec = schedule.periodSec;
					min = Math.min(min, sec);
					if (now - (lastWhisperAt.get(petId) ?? 0) < sec * 1e3) {
						notDue += 1;
						continue;
					}
					if (lock.locked(petId)) {
						skipped.push(petId + ": 占用锁跳过");
						continue;
					}
					due += 1;
					log.info(`[dsh-pet] 碎碎念到点 pet=${petId}（周期 ${sec}s），开始生成`);
					lastWhisperAt.set(petId, now);
					publishWhisper(petId).catch(() => {});
				}
				if (Number.isFinite(min)) next = min;
				log.info(`[dsh-pet] 碎碎念调度：检查 ${checked} 只 → 到点 ${due}、未到点 ${notDue}、跳过 ${skipped.length}` + (skipped.length > 0 ? `（${skipped.join("；")}）` : "") + `；下一拍 ${next}s`);
			} catch (e) {
				log.warn("[dsh-pet] 碎碎念调度读配置失败，自动碎碎念已停止（重启 DSH 后恢复）：" + (e instanceof Error ? e.message : String(e)));
				return;
			}
			arm(next);
		}
		tick();
		return () => {
			disposed$1 = true;
			if (timer !== null) clearTimeout(timer);
		};
	}, "dsh-pet: whisper poll");
	ctx.effect(() => ctx.commands.register({
		name: "pet",
		description: "选择桌宠（/chat 对话的目标；支持选择框或手输 id/名字）",
		input: { hint: "[宠物 id 或名字]（留空查看当前）" },
		handler: ({ rawInput }) => {
			const arg = rawInput.trim();
			let eff;
			try {
				eff = effectivePetList();
			} catch {
				eff = [];
			}
			if (!arg) {
				const cur = resolveActivePetId();
				const found = eff.find((p) => String(p.id) === cur);
				return {
					kind: "success",
					text: "当前桌宠：" + (found ? petDisplayName(found) : cur || "（无可交互桌宠）")
				};
			}
			const byId = eff.find((p) => String(p.id) === arg);
			if (byId) {
				activePetId = String(byId.id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byId)
				};
			}
			const byName = eff.filter((p) => petDisplayName(p) === arg);
			if (byName.length === 1) {
				activePetId = String(byName[0].id);
				return {
					kind: "success",
					text: "已选择桌宠：" + petDisplayName(byName[0])
				};
			}
			if (byName.length > 1) return {
				kind: "error",
				text: "「" + arg + "」有 " + byName.length + " 只桌宠（id：" + byName.map((p) => String(p.id)).join("、") + "），请用 id 指定"
			};
			return {
				kind: "error",
				text: "找不到桌宠「" + arg + "」（id 或名字都行；/pet 回车可打开选择框）"
			};
		}
	}), "dsh-pet: /pet command");
	ctx.effect(() => ctx.commands.register({
		name: "chat",
		description: "与桌宠对话：留空 = 碎碎念一句；输入消息 = 正常对话",
		input: { hint: "[消息]（留空 = 碎碎念）" },
		handler: ({ rawInput }) => {
			const petId = resolveActivePetId();
			if (!petId) return {
				kind: "error",
				text: "没有可交互的桌宠"
			};
			const text = rawInput.trim();
			if (!text) {
				publishWhisper(petId).catch((e) => log.warn("[dsh-pet] 碎碎念异常：" + (e instanceof Error ? e.message : String(e))));
				return {
					kind: "success",
					text: "已让桌宠碎碎念一句"
				};
			}
			if (text.length > 2e3) return {
				kind: "error",
				text: "消息过长（限 2000 字）"
			};
			chatWithPet(petId, text).then((r) => {
				if (!r.ok) log.warn("[dsh-pet] 对话失败 reason=" + r.reason + (r.message ? " " + r.message : ""));
			});
			return {
				kind: "success",
				text: "已发送，桌宠马上回应"
			};
		}
	}), "dsh-pet: /chat command");
	ctx.effect(() => () => {
		disposed = true;
		if (workFlushTimer !== null) {
			clearTimeout(workFlushTimer);
			workFlushTimer = null;
		}
		if (downloadSlotTimer !== null) {
			clearTimeout(downloadSlotTimer);
			downloadSlotTimer = null;
		}
		lock.releaseAll();
		playback.cancelAll();
		state.cancelAll();
		stopHelper("dsh-host-stop");
	});
	startHelper();
}

//#endregion
export { apply, inject, name };
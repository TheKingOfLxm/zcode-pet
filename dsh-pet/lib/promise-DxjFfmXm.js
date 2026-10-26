
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/tslib.mjs
function __classPrivateFieldSet(receiver, state, value, kind, f) {
	if (kind === "m") throw new TypeError("Private method is not writable");
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
	return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/errors.mjs
function isAbortError(err) {
	return typeof err === "object" && err !== null && ("name" in err && err.name === "AbortError" || "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
const castToError = (err) => {
	if (err instanceof Error) return err;
	if (typeof err === "object" && err !== null) {
		try {
			const tag = Object.prototype.toString.call(err);
			if (tag === "[object Error]" || tag === "[object DOMException]") {
				const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
				if (err.stack) error.stack = err.stack;
				if (err.cause && !error.cause) error.cause = err.cause;
				if (err.name) error.name = err.name;
				return error;
			}
		} catch {}
		try {
			return new Error(JSON.stringify(err));
		} catch {}
	}
	return new Error(err);
};

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError = /* @__PURE__ */ (() => {
	class AnthropicError$1 extends Error {}
	return AnthropicError$1;
})();
var APIError = class APIError extends AnthropicError {
	constructor(status, error, message, headers, type) {
		super(`${APIError.makeMessage(status, error, message)}`);
		this.status = status;
		this.headers = headers;
		this.requestID = headers?.get("request-id");
		this.workspaceID = headers?.get("anthropic-workspace-id");
		this.error = error;
		this.type = type ?? null;
	}
	static makeMessage(status, error, message) {
		const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
		if (status && msg) return `${status} ${msg}`;
		if (status) return `${status} status code (no body)`;
		if (msg) return msg;
		return "(no status code or body)";
	}
	static generate(status, errorResponse, message, headers) {
		if (!status || !headers) return new APIConnectionError({
			message,
			cause: castToError(errorResponse)
		});
		const error = errorResponse;
		const type = error?.["error"]?.["type"];
		if (status === 400) return new BadRequestError(status, error, message, headers, type);
		if (status === 401) return new AuthenticationError(status, error, message, headers, type);
		if (status === 403) return new PermissionDeniedError(status, error, message, headers, type);
		if (status === 404) return new NotFoundError(status, error, message, headers, type);
		if (status === 409) return new ConflictError(status, error, message, headers, type);
		if (status === 422) return new UnprocessableEntityError(status, error, message, headers, type);
		if (status === 429) return new RateLimitError(status, error, message, headers, type);
		if (status >= 500) return new InternalServerError(status, error, message, headers, type);
		return new APIError(status, error, message, headers, type);
	}
};
var APIUserAbortError = class extends APIError {
	constructor({ message } = {}) {
		super(void 0, void 0, message || "Request was aborted.", void 0);
	}
};
var APIConnectionError = class extends APIError {
	constructor({ message, cause }) {
		super(void 0, void 0, message || "Connection error.", void 0);
		if (cause) this.cause = cause;
	}
};
var APIConnectionTimeoutError = class extends APIConnectionError {
	constructor({ message } = {}) {
		super({ message: message ?? "Request timed out." });
	}
};
var RetryableError = class extends AnthropicError {
	constructor(message, { cause } = {}) {
		super(message ?? "Retryable error.");
		if (cause !== void 0) this.cause = cause;
	}
};
var BadRequestError = class extends APIError {};
var AuthenticationError = class extends APIError {};
var PermissionDeniedError = class extends APIError {};
var NotFoundError = class extends APIError {};
var ConflictError = class extends APIError {};
var UnprocessableEntityError = class extends APIError {};
var RateLimitError = class extends APIError {};
var InternalServerError = class extends APIError {};

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
const startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
const isAbsoluteURL = (url) => {
	return startsWithSchemeRegexp.test(url);
};
let isArray = (val) => (isArray = Array.isArray, isArray(val));
let isReadonlyArray = isArray;
function maybeObj(x) {
	if (typeof x !== "object") return {};
	return x ?? {};
}
function isEmptyObj(obj) {
	if (!obj) return true;
	for (const _k in obj) return false;
	return true;
}
function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}
function isObj(obj) {
	return obj != null && typeof obj === "object" && !Array.isArray(obj);
}
const validatePositiveInteger = (name, n) => {
	if (typeof n !== "number" || !Number.isInteger(n)) throw new AnthropicError(`${name} must be an integer`);
	if (n < 0) throw new AnthropicError(`${name} must be a positive integer`);
	return n;
};
const safeJSON = (text) => {
	try {
		return JSON.parse(text);
	} catch (err) {
		return void 0;
	}
};
function checkNever(_value) {}

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
function concatBytes(buffers) {
	let length = 0;
	for (const buffer of buffers) length += buffer.length;
	const output = new Uint8Array(length);
	let index = 0;
	for (const buffer of buffers) {
		output.set(buffer, index);
		index += buffer.length;
	}
	return output;
}
let encodeUTF8_;
function encodeUTF8(str) {
	let encoder;
	return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str);
}
let decodeUTF8_;
function decodeUTF8(bytes) {
	let decoder;
	return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
const readEnv = (env) => {
	if (typeof globalThis.process !== "undefined") return globalThis.process.env?.[env]?.trim() || void 0;
	if (typeof globalThis.Deno !== "undefined") return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
	return void 0;
};

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
const defaultLogLevel = "warn";
const levelNumbers = {
	off: 0,
	error: 200,
	warn: 300,
	info: 400,
	debug: 500
};
const parseLogLevel = (maybeLevel, sourceName, logger) => {
	if (!maybeLevel) return void 0;
	if (hasOwn(levelNumbers, maybeLevel)) return maybeLevel;
	logger.warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
	return void 0;
};
function noop() {}
function makeLogFn(fnLevel, logger, logLevel) {
	if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) return noop;
	else return logger[fnLevel].bind(logger);
}
const noopLogger = {
	error: noop,
	warn: noop,
	info: noop,
	debug: noop
};
let cachedLoggers = /* @__PURE__ */ new WeakMap();
function filterLogger(logger, logLevel) {
	const cachedLogger = cachedLoggers.get(logger);
	if (cachedLogger && cachedLogger[0] === logLevel) return cachedLogger[1];
	const levelLogger = {
		error: makeLogFn("error", logger, logLevel),
		warn: makeLogFn("warn", logger, logLevel),
		info: makeLogFn("info", logger, logLevel),
		debug: makeLogFn("debug", logger, logLevel)
	};
	cachedLoggers.set(logger, [logLevel, levelLogger]);
	return levelLogger;
}
function loggerFor(client) {
	const logger = client.logger;
	const logLevel = client.logLevel ?? "off";
	if (!logger) return noopLogger;
	return filterLogger(logger, logLevel);
}
let lastEnvLevel;
let cachedDefaultLogger;
function defaultLogger() {
	const envLevel = readEnv("ANTHROPIC_LOG");
	if (!cachedDefaultLogger || envLevel !== lastEnvLevel) {
		lastEnvLevel = envLevel;
		cachedDefaultLogger = filterLogger(console, parseLogLevel(envLevel, "process.env['ANTHROPIC_LOG']", filterLogger(console, defaultLogLevel)) ?? defaultLogLevel);
	}
	return cachedDefaultLogger;
}
function debugLogRequestDetails(logger, message, details) {
	if (logger.debug === noop) return;
	logger.debug(message, formatRequestDetails(details));
}
const formatRequestDetails = (details) => {
	if (details.options) {
		details.options = { ...details.options };
		delete details.options["headers"];
	}
	if (details.headers) details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [name, name.toLowerCase() === "authorization" || name.toLowerCase() === "proxy-authorization" || name.toLowerCase() === "api-key" || name.toLowerCase() === "x-api-key" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value]));
	if ("retryOfRequestLogID" in details) {
		if (details.retryOfRequestLogID) details.retryOf = details.retryOfRequestLogID;
		delete details.retryOfRequestLogID;
	}
	return details;
};

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/backoff.mjs
function isStatus(e, code) {
	return e instanceof APIError && e.status === code;
}
function is4xx(e) {
	return e instanceof APIError && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}
function isFatal4xx(e) {
	return is4xx(e) && !isStatus(e, 408) && !isStatus(e, 409) && !isStatus(e, 429);
}
function backoff(attempt, baseMs, capMs) {
	return Math.min(baseMs * 2 ** attempt, capMs);
}
function jitter(lowMs, highMs) {
	return lowMs + Math.random() * (highMs - lowMs);
}
function applyJitter(ms) {
	return ms * (1 - Math.random() * .25);
}

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
var ToolError = /* @__PURE__ */ (() => {
	/**
	* An error that can be thrown from a tool's `run` method to return structured
	* content blocks as the error result, rather than just a string message.
	*
	* When the ToolRunner catches this error, it will use the `content` property
	* as the tool result with `is_error: true`.
	*
	* @example
	* ```ts
	* const tool = {
	*   name: 'my_tool',
	*   run: async (input) => {
	*     if (somethingWentWrong) {
	*       throw new ToolError([
	*         { type: 'text', text: 'Error details here' },
	*         { type: 'image', source: { type: 'base64', data: '...', media_type: 'image/png' } },
	*       ]);
	*     }
	*     return 'success';
	*   },
	* };
	* ```
	*/
	class ToolError$1 extends Error {
		constructor(content) {
			const message = typeof content === "string" ? content : content.map((block) => {
				if (block.type === "text") return block.text;
				return `[${block.type}]`;
			}).join(" ");
			super(message);
			this.name = "ToolError";
			this.content = content;
		}
	}
	return ToolError$1;
})();

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/tools/agent-toolset/sync-interval.mjs
const DEFAULT_MEMORY_SYNC_INTERVAL_MS = 15e3;
const MIN_MEMORY_SYNC_INTERVAL_MS = 5e3;
function checkMemorySyncInterval(ms, option) {
	if (!(ms >= MIN_MEMORY_SYNC_INTERVAL_MS)) throw new AnthropicError(`${option} must be at least ${MIN_MEMORY_SYNC_INTERVAL_MS}ms (got ${ms}); to run without memory sync, pass \`memorySyncIntervalMs: null\` to the worker instead`);
}

//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.135.0_zod@4.6.7/node_modules/@anthropic-ai/sdk/internal/utils/promise.mjs
function promiseWithResolvers() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {
		promise,
		resolve,
		reject
	};
}

//#endregion
export { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AnthropicError, AuthenticationError, BadRequestError, ConflictError, DEFAULT_MEMORY_SYNC_INTERVAL_MS, InternalServerError, MIN_MEMORY_SYNC_INTERVAL_MS, NotFoundError, PermissionDeniedError, RateLimitError, RetryableError, ToolError, UnprocessableEntityError, __classPrivateFieldGet, __classPrivateFieldSet, applyJitter, backoff, castToError, checkMemorySyncInterval, checkNever, concatBytes, debugLogRequestDetails, decodeUTF8, defaultLogLevel, defaultLogger, encodeUTF8, isAbortError, isAbsoluteURL, isArray, isEmptyObj, isFatal4xx, isObj, isReadonlyArray, isStatus, jitter, loggerFor, maybeObj, parseLogLevel, promiseWithResolvers, readEnv, safeJSON, validatePositiveInteger };
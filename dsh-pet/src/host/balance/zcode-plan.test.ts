/**
 * ZCode BigModel 编码套餐余额路由的单测（providers/zcode-plan）。
 *
 * 解析层用真实接口抓包形状（TIME_LIMIT + 两条 TOKENS_LIMIT）钉死 unit 语义与兜底顺序；
 * 凭证层用临时文件验证显式失败与条目回退。全程离线，不发起网络请求。
 *
 * 用 Node 内置 test runner（node:test），不引入任何 npm 依赖。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePlanUsage, resolvePlanCredential, resolvePlanKey } from './providers/zcode-plan.ts';
import { createAiConfig } from '../../standalone/ai-config.ts';
import { writeAiSettings } from '../../standalone/ai-storage.ts';

/** 与 2026-10 实测响应同形状的 data 段：工具窗（TIME_LIMIT）+ 5h 滚动窗 + 月窗 */
const REAL_DATA = {
  limits: [
    {
      type: 'TIME_LIMIT',
      unit: 5,
      number: 1,
      usage: 4000,
      currentValue: 52,
      remaining: 3948,
      percentage: 1,
      nextResetTime: 1794206961984,
      usageDetails: [{ modelCode: 'search-prime', usage: 46 }],
    },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 21, nextResetTime: 1792999387868 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 7, nextResetTime: 1793349320999 },
  ],
  level: 'max',
};

describe('parsePlanUsage —— 套餐用量解析', () => {
  test('实测形状：unit 3×5 → 5h 滚动窗，unit 6×1 → 周窗（放 monthly 槽，标「周」）', () => {
    const usage = parsePlanUsage(REAL_DATA);
    assert.equal(usage.rolling, 21);
    assert.equal(usage.rollingLabel, '5h');
    assert.equal(usage.monthly, 7);
    assert.equal(usage.monthlyLabel, '周');
    assert.equal(usage.monthlyResetsAt, new Date(1793349320999).toISOString());
    assert.equal(usage.rollingResetsAt, new Date(1792999387868).toISOString());
    assert.equal(usage.weekly, undefined);
  });

  test('无 unit 的 TOKENS_LIMIT 按顺序兜底：第一窗滚动、第二窗周（标「周」）', () => {
    const usage = parsePlanUsage({
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1792999387868 },
        { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1793349320999 },
      ],
    });
    assert.equal(usage.rolling, 30);
    assert.equal(usage.monthly, 10);
    assert.equal(usage.monthlyLabel, '周');
    assert.equal(usage.rollingLabel, undefined);
  });

  test('只有一条 TOKENS_LIMIT 时无周窗：月位镜像滚动窗并沿用其标签，保住档位驱动', () => {
    const usage = parsePlanUsage({ limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 55 }] });
    assert.equal(usage.rolling, 55);
    assert.equal(usage.weekly, undefined);
    assert.equal(usage.monthly, 55);
    assert.equal(usage.monthlyLabel, undefined);
    assert.equal(usage.rollingLabel, undefined);
  });

  test('TIME_LIMIT（工具次数）不进 windows', () => {
    const usage = parsePlanUsage(REAL_DATA);
    // 三个窗口里没有它的位置：只有滚动与周（周在 monthly 槽）
    assert.deepEqual([usage.rolling, usage.weekly, usage.monthly], [21, undefined, 7]);
  });

  test('没有 TOKENS_LIMIT 视为响应变形并抛错', () => {
    assert.throws(() => parsePlanUsage({ limits: [{ type: 'TIME_LIMIT', percentage: 1 }] }));
    assert.throws(() => parsePlanUsage({}));
  });
});

describe('resolvePlanKey —— ZCode 配置取凭证', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-plan-test-'));
  const write = (name: string, json: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(json));
    return file;
  };

  test('编码套餐启用且有 key → 直接返回', () => {
    const file = write('a.json', {
      provider: { 'builtin:bigmodel-coding-plan': { enabled: true, options: { apiKey: ' k1 ' } } },
    });
    assert.equal(resolvePlanKey(file), 'k1');
  });

  test('编码套餐禁用 → 回退起步套餐', () => {
    const file = write('b.json', {
      provider: {
        'builtin:bigmodel-coding-plan': { enabled: false, options: { apiKey: 'k1' } },
        'builtin:bigmodel-start-plan': { options: { apiKey: 'k2' } },
      },
    });
    assert.equal(resolvePlanKey(file), 'k2');
  });

  test('没有可用 key / 文件不存在 / 非法 JSON → 显式抛错', () => {
    const empty = write('c.json', { provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: '' } } } });
    assert.throws(() => resolvePlanKey(empty), /没有启用的 BigModel/);
    assert.throws(() => resolvePlanKey(join(dir, 'missing.json')), /找不到 ZCode 配置/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{oops');
    assert.throws(() => resolvePlanKey(bad), /不是合法 JSON/);
  });
});

describe('resolvePlanCredential —— 套餐连接凭据与模型选择', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-plan-cred-'));
  const write = (name: string, json: unknown): string => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(json));
    return file;
  };

  test('取 baseURL 与 zcode.priority 最高的模型（GLM-5.3-Flash 优先于 GLM-5.3）', () => {
    const file = write('a.json', {
      provider: {
        'builtin:bigmodel-coding-plan': {
          options: { apiKey: 'k1', baseURL: 'https://open.bigmodel.cn/api/anthropic' },
          models: {
            'GLM-5.3': { zcode: { priority: 99 } },
            'GLM-5.3-Flash': { zcode: { priority: 100 } },
          },
        },
      },
    });
    const cred = resolvePlanCredential(file);
    assert.deepEqual(cred, {
      key: 'k1',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      model: 'GLM-5.3-Flash',
    });
  });

  test('缺 baseURL 与模型表时走缺省端点与兜底模型', () => {
    const file = write('b.json', {
      provider: { 'builtin:bigmodel-coding-plan': { options: { apiKey: 'k2' } } },
    });
    const cred = resolvePlanCredential(file);
    assert.equal(cred.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
    assert.equal(cred.model, 'GLM-5.3-Flash');
  });

  test('编码套餐禁用 → 回退起步套餐条目', () => {
    const file = write('c.json', {
      provider: {
        'builtin:bigmodel-coding-plan': { enabled: false, options: { apiKey: 'k1' } },
        'builtin:bigmodel-start-plan': { options: { apiKey: 'k3', baseURL: 'https://open.bigmodel.cn/api/anthropic' } },
      },
    });
    assert.equal(resolvePlanCredential(file).key, 'k3');
  });
});

describe('createAiConfig —— 无本地设置时自动接入 ZCode 套餐', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zcode-plan-ai-'));
  const home = mkdtempSync(join(tmpdir(), 'zcode-plan-home-'));

  test('ZCode 套餐在场 → 派生 anthropic 设置并启用，模型取 priority 最高者', () => {
    const cfg = join(dir, 'plan.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        provider: {
          'builtin:bigmodel-coding-plan': {
            options: { apiKey: 'kp', baseURL: 'https://open.bigmodel.cn/api/anthropic' },
            models: { 'GLM-5.3': { zcode: { priority: 99 } }, 'GLM-5.3-Flash': { zcode: { priority: 100 } } },
          },
        },
      }),
    );
    process.env.ZCODE_CONFIG_FILE = cfg;
    try {
      const store = createAiConfig(home);
      const s = store.current();
      assert.equal(s.enabled, true);
      assert.equal(s.protocol, 'anthropic');
      assert.equal(s.model, 'GLM-5.3-Flash');
      assert.equal(s.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
      assert.ok(s.apiKey.length > 0);
      assert.equal(store.publicSettings().hasKey, true);
    } finally {
      delete process.env.ZCODE_CONFIG_FILE;
    }
  });

  test('ZCode 套餐不在场 → 维持默认关闭，不抛错', () => {
    process.env.ZCODE_CONFIG_FILE = join(dir, 'missing.json');
    try {
      const home2 = mkdtempSync(join(tmpdir(), 'zcode-plan-home2-'));
      const store = createAiConfig(home2);
      assert.equal(store.current().enabled, false);
    } finally {
      delete process.env.ZCODE_CONFIG_FILE;
    }
  });

  test('已有本地保存的设置时以保存的为准，不被套餐覆盖', () => {
    const cfg = join(dir, 'plan.json');
    const home3 = mkdtempSync(join(tmpdir(), 'zcode-plan-home3-'));
    writeAiSettings(home3, {
      protocol: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      model: 'my-own-model',
      enabled: true,
      automaticWhispers: false,
      whisperIntervalSec: 300,
      maxTokens: 1024,
      timeoutMs: 30000,
      apiKey: 'mine',
    });
    process.env.ZCODE_CONFIG_FILE = cfg;
    try {
      const store = createAiConfig(home3);
      assert.equal(store.current().model, 'my-own-model');
      assert.equal(store.current().apiKey, 'mine');
    } finally {
      delete process.env.ZCODE_CONFIG_FILE;
    }
  });
});

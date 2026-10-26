/**
 * 统一日志落盘的行为测试（src/host/log-file.ts）。
 *
 * 钉住四件容易写错的事：
 *   ① 缓冲语义：没到阈值/间隔就不碰盘（否则「每秒一次写」的承诺就是假的）；
 *   ② 批量落盘：达到阈值后一次写完，行里有时间戳与级别；
 *   ③ 单文件截断：超过 maxBytes 只保留尾部 keepBytes，且保留的是最新内容；
 *   ④ 脱敏：令牌形态不得原样进文件。
 *
 * 全部用真实临时目录 + 真实 fs（不 mock）：本模块的价值就在文件行为，mock 掉就没意义了。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createFileLogger, formatLogLine, redactSensitive, tailForTrim } from './log-file.ts';

let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-pet-log-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('纯函数', () => {
  test('formatLogLine：ISO 时间 + 级别 + 正文 + 换行', () => {
    assert.equal(
      formatLogLine('warn', '出事了', new Date('2026-10-23T11:52:25.123Z')),
      '2026-10-23T11:52:25.123Z [warn] 出事了\n',
    );
  });

  test('redactSensitive：令牌、站点 URL 片段一律打码', () => {
    assert.equal(redactSensitive('x-dsh-pet-token: abcdefghijklmnopqrstuvwx'), 'x-dsh-pet-token: ***');
    assert.equal(redactSensitive('打开 http://x/#token=abcdefghijklmnopqrstuvwx'), '打开 http://x/#token=***');
    assert.equal(redactSensitive('DSH_PET_SITE_URL=http://127.0.0.1:1/?t=2'), 'DSH_PET_SITE_URL=***');
    // 普通文本不动
    assert.equal(redactSensitive('helper exited with code 3'), 'helper exited with code 3');
  });

  test('tailForTrim：未超限原样返回，超限只留尾部', () => {
    const small = Buffer.from('abc');
    assert.equal(tailForTrim(small, 10).toString(), 'abc');
    const big = Buffer.from('0123456789');
    assert.equal(tailForTrim(big, 3).toString(), '789');
  });
});

describe('createFileLogger', () => {
  test('未达阈值且未到间隔时不落盘', async () => {
    const file = join(dir, 'lazy.log');
    const logger = createFileLogger({ file, flushThreshold: 10, flushIntervalMs: 60_000 });
    try {
      logger.info('one');
      logger.info('two');
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(existsSync(file), false, '没到阈值就不许碰盘');
    } finally {
      logger.dispose();
    }
  });

  test('达到阈值后批量落盘，行内带级别', async () => {
    const file = join(dir, 'batch.log');
    const logger = createFileLogger({ file, flushThreshold: 2, flushIntervalMs: 60_000 });
    try {
      logger.info('first');
      logger.error('second');
      await logger.flush();
      const text = readFileSync(file, 'utf8');
      assert.match(text, /\[info\] first/);
      assert.match(text, /\[error\] second/);
      assert.equal(text.trim().split('\n').length, 2);
    } finally {
      logger.dispose();
    }
  });

  test('超过大小上限只保留尾部（最新的部分）', async () => {
    const file = join(dir, 'trim.log');
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      maxBytes: 400,
      keepBytes: 150,
    });
    try {
      for (let i = 0; i < 40; i += 1) logger.info(`line-${String(i).padStart(3, '0')}-padding-padding`);
      await logger.flush();
      const text = readFileSync(file, 'utf8');
      assert.ok(text.length <= 400, `文件应被截断到上限内，实际 ${text.length}`);
      assert.ok(text.includes('line-039'), '截断必须保留最新内容');
    } finally {
      logger.dispose();
    }
  });

  test('debug 默认不落盘，打开后才写', async () => {
    const off = join(dir, 'debug-off.log');
    const offLogger = createFileLogger({ file: off, flushThreshold: 1, flushIntervalMs: 60_000 });
    offLogger.debug('hidden');
    await offLogger.flush();
    offLogger.dispose();
    assert.equal(existsSync(off), false, 'debug 默认不该产生文件');

    const on = join(dir, 'debug-on.log');
    const onLogger = createFileLogger({
      file: on,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      debugEnabled: true,
    });
    onLogger.debug('shown');
    await onLogger.flush();
    onLogger.dispose();
    assert.match(readFileSync(on, 'utf8'), /\[debug\] shown/);
  });

  test('转发原 logger（node 版终端里照旧可见）', async () => {
    const file = join(dir, 'tee.log');
    const seen: string[] = [];
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      base: { warn: (message) => seen.push(message) },
    });
    logger.warn('both places');
    await logger.flush();
    logger.dispose();
    assert.deepEqual(seen, ['both places']);
    assert.match(readFileSync(file, 'utf8'), /\[warn\] both places/);
  });

  test('原 logger 抛错不影响落盘（日志系统不许成为故障源）', async () => {
    const file = join(dir, 'broken-base.log');
    const logger = createFileLogger({
      file,
      flushThreshold: 1,
      flushIntervalMs: 60_000,
      base: {
        error: () => {
          throw new Error('host logger exploded');
        },
      },
    });
    logger.error('still written');
    await logger.flush();
    logger.dispose();
    assert.match(readFileSync(file, 'utf8'), /\[error\] still written/);
  });

  test('落盘前脱敏：令牌不进文件', async () => {
    const file = join(dir, 'redact.log');
    const logger = createFileLogger({ file, flushThreshold: 1, flushIntervalMs: 60_000 });
    logger.info('请求头 x-dsh-pet-token: abcdefghijklmnopqrstuvwx');
    await logger.flush();
    logger.dispose();
    const text = readFileSync(file, 'utf8');
    assert.match(text, /x-dsh-pet-token: \*\*\*/);
    assert.ok(!text.includes('abcdefghijklmnopqrstuvwx'));
  });
});

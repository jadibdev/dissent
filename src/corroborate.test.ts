import {
  AISDKError,
  APICallError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  RetryError,
  jsonSchema,
} from 'ai';
import { MockLanguageModelV4, MockProviderV4 } from 'ai/test';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { canonicalJson } from './canonical/canonical-json.js';
import { sha256Hex } from './canonical/sha256.js';
import { compareFields } from './compare/compare-fields.js';
import { sortLabels } from './compare/util.js';
import { corroborate, corroborateWithHooks } from './corroborate.js';
import { DissentArgumentError } from './errors.js';
import {
  toRequestedIdentity,
  toServedIdentity,
} from './witness/normalize-witnesses.js';

import type { ModelMessage, TelemetryOptions } from 'ai';

import type { WitnessRecord } from './types.js';

type MockGenerateResult = Awaited<
  ReturnType<MockLanguageModelV4['doGenerate']>
>;

const BasicSchema = z.object({
  approved: z.boolean(),
  severity: z.enum(['low', 'medium', 'high']),
  tags: z.array(z.string()),
  rationale: z.string(),
});

function makeV4Usage(opts?: {
  inputTotal?: number | undefined;
  noCache?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  outputTotal?: number | undefined;
  text?: number | undefined;
  reasoning?: number | undefined;
}): MockGenerateResult['usage'] {
  return {
    inputTokens: {
      total: opts?.inputTotal,
      noCache: opts?.noCache ?? opts?.inputTotal,
      cacheRead: opts?.cacheRead,
      cacheWrite: opts?.cacheWrite,
    },
    outputTokens: {
      total: opts?.outputTotal,
      text: opts?.text ?? opts?.outputTotal,
      reasoning: opts?.reasoning,
    },
  };
}

function makeTextResult(
  jsonOrText: unknown,
  opts?: {
    unified?: MockGenerateResult['finishReason']['unified'];
    raw?: string;
    modelId?: string;
    usage?: MockGenerateResult['usage'];
    warnings?: MockGenerateResult['warnings'];
  },
): MockGenerateResult {
  const text =
    typeof jsonOrText === 'string' ? jsonOrText : JSON.stringify(jsonOrText);
  return {
    content: text.length > 0 ? [{ type: 'text', text }] : [],
    finishReason: { unified: opts?.unified ?? 'stop', raw: opts?.raw },
    usage: opts?.usage ?? makeV4Usage({ inputTotal: 10, outputTotal: 20 }),
    warnings: opts?.warnings ?? [],
    ...(opts?.modelId !== undefined
      ? { response: { modelId: opts.modelId } }
      : {}),
  };
}

function makeMockModel(
  payload: unknown,
  opts?: {
    provider?: string;
    modelId?: string;
    servedModelId?: string;
    unified?: MockGenerateResult['finishReason']['unified'];
    usage?: MockGenerateResult['usage'];
    warnings?: MockGenerateResult['warnings'];
  },
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: opts?.provider ?? 'mock-provider',
    modelId: opts?.modelId ?? 'mock-model',
    doGenerate: async () =>
      makeTextResult(payload, {
        ...(opts?.servedModelId !== undefined
          ? { modelId: opts.servedModelId }
          : {}),
        ...(opts?.unified !== undefined ? { unified: opts.unified } : {}),
        ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
        ...(opts?.warnings !== undefined ? { warnings: opts.warnings } : {}),
      }),
  });
}

async function expectArgError(
  fn: () => Promise<unknown>,
  code: DissentArgumentError['code'],
): Promise<void> {
  try {
    await fn();
    expect.unreachable(`Expected DissentArgumentError(${code})`);
  } catch (err) {
    expect(DissentArgumentError.isInstance(err)).toBe(true);
    if (DissentArgumentError.isInstance(err)) {
      expect(err.code).toBe(code);
    }
  }
}

function findUndefinedKeyPath(value: unknown, path = ''): string | null {
  if (value === undefined) return path || '(root)';
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findUndefinedKeyPath(value[i], `${path}[${i}]`);
      if (hit !== null) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc?.value === undefined) return `${path}.${key}`;
    const hit = findUndefinedKeyPath(desc.value, `${path}.${key}`);
    if (hit !== null) return hit;
  }
  return null;
}

function makeGatewayFailingMock(
  id: string,
  thrown: Error,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: 'gateway',
    modelId: id,
    doGenerate: async () => {
      throw thrown;
    },
  });
}

describe('corroborate (Phase 4)', () => {
  test('4.1 three witnesses agree on every compared field -> clear, quorum 3/3, stable fingerprints (I2, I3)', async () => {
    const answer = {
      approved: true,
      severity: 'low',
      tags: ['api', 'safe'],
      rationale: 'Each witness writes different prose.',
    };
    const witnesses = {
      alpha: makeMockModel(
        { ...answer, rationale: 'Alpha prose' },
        {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-2024-08-06',
        },
      ),
      beta: makeMockModel(
        { ...answer, rationale: 'Beta prose' },
        {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          servedModelId: 'claude-sonnet-4-20250514',
        },
      ),
      gamma: makeMockModel(
        { ...answer, rationale: 'Gamma prose' },
        {
          provider: 'google.generative-ai',
          modelId: 'gemini-2.5-flash',
          servedModelId: 'gemini-2.5-flash',
        },
      ),
    };

    const opts = {
      witnesses,
      schema: BasicSchema,
      prompt: 'Evaluate change',
      instructions: 'Be brief',
    };
    const ledger1 = await corroborate(opts);
    const ledger2 = await corroborate(opts);

    expect(ledger1.protocol).toBe('dissent-ledger/1');
    expect(ledger1.advisory).toBe('clear');
    expect(ledger1.quorum).toEqual({
      listed: 3,
      asked: 3,
      answered: 3,
      failed: 0,
      excluded: 0,
    });
    expect(ledger1.fields['/approved']?.status).toBe('agree');
    expect(ledger1.fields['/severity']?.status).toBe('agree');
    expect(ledger1.fields['/tags']?.status).toBe('agree');
    expect(ledger1.fields['/rationale']?.status).toBe('not-compared');

    expect(ledger1.question.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger1.plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger1.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger1.question.fingerprint).toBe(ledger2.question.fingerprint);
    expect(ledger1.plan.fingerprint).toBe(ledger2.plan.fingerprint);
    expect(ledger1.fingerprint).toBe(ledger2.fingerprint);
  });

  test('4.2 F1 regression: one witness APICallError 500 -> failed/api-error, others compared, no leaked body/headers (I1, I9)', async () => {
    const sentinel = 'SENTINEL_SECRET_BODY_VALUE';
    const failModel = new MockLanguageModelV4({
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      doGenerate: async () => {
        throw new APICallError({
          message: 'Upstream server error',
          url: `https://api.example.com/v1?secret=${sentinel}`,
          requestBodyValues: { prompt: sentinel },
          statusCode: 500,
          responseHeaders: { 'x-debug-token': sentinel },
          responseBody: `{"error":"${sentinel}"}`,
          isRetryable: true,
        });
      },
    });
    const ok = {
      approved: false,
      severity: 'high',
      tags: ['breaking'],
      rationale: 'Incompatible signature',
    };

    const ledger = await corroborate({
      witnesses: {
        a: failModel,
        b: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
        }),
        c: makeMockModel(ok, {
          provider: 'google.generative-ai',
          modelId: 'gemini-2.5-flash',
        }),
      },
      schema: BasicSchema,
      prompt: 'Check breaking',
      maxRetries: 0,
    });

    expect(ledger.quorum).toEqual({
      listed: 3,
      asked: 3,
      answered: 2,
      failed: 1,
      excluded: 0,
    });
    const failedRec = ledger.witnesses.a;
    expect(failedRec.status).toBe('failed');
    if (failedRec.status === 'failed') {
      expect(failedRec.error.kind).toBe('api-error');
      expect(failedRec.error.statusCode).toBe(500);
      expect(failedRec.error.isRetryable).toBe(true);
    }
    expect(ledger.fields['/approved']?.presented).toEqual(['b', 'c']);
    expect(ledger.fields['/approved']?.status).toBe('agree');
    expect(JSON.stringify(ledger)).not.toContain(sentinel);
  });

  test('4.3 every error kind in §7 classified accurately', async () => {
    const baseOk = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: 'ok' },
      { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
    );

    const runOneFail = async (
      failWitness:
        | MockLanguageModelV4
        | { model: MockLanguageModelV4; settings: { timeout: number } },
    ) => {
      const ledger = await corroborate({
        witnesses: {
          bad: failWitness,
          good: baseOk,
        },
        schema: BasicSchema,
        prompt: 'Check',
        maxRetries: 0,
      });
      const rec = ledger.witnesses.bad;
      expect(rec.status).toBe('failed');
      if (rec.status !== 'failed') throw new Error('Expected failed');
      return rec;
    };

    // 1. NoObjectGeneratedError with finishReason 'stop' -> invalid-output + rawText
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => makeTextResult('not valid json {'),
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('invalid-output');
      expect(rec.error.finishReason).toBe('stop');
      expect(rec.error.rawText).toBe('not valid json {');
    }

    // 2. finishReason 'length' with empty text (bare NoOutputGeneratedError) -> truncated via result.finishReason
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () =>
          makeTextResult('', { unified: 'length', modelId: 'gpt-4o-serving' }),
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('truncated');
      expect(rec.error.finishReason).toBe('length');
      expect(rec.served?.modelId).toBe('gpt-4o-serving');
      expect(rec.usage).not.toBeNull();
    }

    // 3. finishReason 'content-filter' -> refused
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () =>
          makeTextResult('', { unified: 'content-filter' }),
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('refused');
      expect(rec.error.finishReason).toBe('content-filter');
    }

    // 4. per-witness timeout: 10 -> timeout
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async ({ abortSignal }) =>
          new Promise<MockGenerateResult>((_resolve, reject) => {
            if (abortSignal?.aborted) {
              reject(abortSignal.reason);
              return;
            }
            abortSignal?.addEventListener(
              'abort',
              () => reject(abortSignal.reason),
              { once: true },
            );
          }),
      });
      const rec = await runOneFail({ model: m, settings: { timeout: 10 } });
      expect(rec.error.kind).toBe('timeout');
    }

    // 5. mock throwing AbortError without caller abort -> aborted
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          throw new DOMException('provider aborted', 'AbortError');
        },
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('aborted');
    }

    // 6. LoadAPIKeyError -> api-error
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          throw new LoadAPIKeyError({ message: 'Missing gateway API key' });
        },
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('api-error');
      expect('statusCode' in rec.error).toBe(false);
    }

    // 7. RetryError wrapping APICallError -> api-error with inner statusCode
    {
      const inner = new APICallError({
        message: 'Rate limited',
        url: 'https://api.example.com',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          throw new RetryError({
            message: 'Failed after 2 retries',
            reason: 'maxRetriesExceeded',
            errors: [inner],
          });
        },
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('api-error');
      expect(rec.error.statusCode).toBe(429);
      expect(rec.error.isRetryable).toBe(true);
    }

    // 8. TypeError -> unknown with name 'TypeError'
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          throw new TypeError('unexpected type');
        },
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('unknown');
      expect(rec.error.name).toBe('TypeError');
    }

    // 9. Thrown string -> unknown with name 'string'
    {
      const m = new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          // eslint-disable-next-line no-throw-literal
          throw 'boom-string';
        },
      });
      const rec = await runOneFail(m);
      expect(rec.error.kind).toBe('unknown');
      expect(rec.error.name).toBe('string');
      expect(rec.error.message).toBe('boom-string');
    }

    // Also direct check for NoObjectGeneratedError instance branch with cause depth
    expect(NoObjectGeneratedError.isInstance(new Error('nope'))).toBe(false);
  });

  test('4.4 answered witness with finishReason length and valid JSON -> answered + truncated-output info (D14)', async () => {
    const ok = {
      approved: true,
      severity: 'low',
      tags: ['a'],
      rationale: 'ok',
    };
    const m1 = makeMockModel(ok, {
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      unified: 'length',
    });
    const m2 = makeMockModel(ok, {
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-4',
    });

    const ledger = await corroborate({
      witnesses: { w1: m1, w2: m2 },
      schema: BasicSchema,
      prompt: 'Check',
    });

    expect(ledger.witnesses.w1.status).toBe('answered');
    const finding = ledger.findings.find(f => f.code === 'truncated-output');
    expect(finding).toEqual({
      code: 'truncated-output',
      severity: 'info',
      witnesses: ['w1'],
    });
    expect(ledger.advisory).toBe('clear');
  });

  test('4.5 caller abort before start and mid-flight rejects promptly without calling mocks/onWitness afterwards (§2.2.2, I9)', async () => {
    // Before start
    const preCtrl = new AbortController();
    preCtrl.abort('cancelled-before-start');
    const mA = makeMockModel({
      approved: true,
      severity: 'low',
      tags: [],
      rationale: 'a',
    });
    const mB = makeMockModel({
      approved: true,
      severity: 'low',
      tags: [],
      rationale: 'b',
    });

    await expect(
      corroborate({
        witnesses: { a: mA, b: mB },
        schema: BasicSchema,
        prompt: 'Hi',
        abortSignal: preCtrl.signal,
      }),
    ).rejects.toBe('cancelled-before-start');
    expect(mA.doGenerateCalls.length).toBe(0);
    expect(mB.doGenerateCalls.length).toBe(0);

    // Mid-flight
    const midCtrl = new AbortController();
    const seenOnWitness: string[] = [];
    const fastModel = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: 'fast' },
      { provider: 'openai.chat', modelId: 'gpt-4o' },
    );
    const hangingModel = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-4',
      doGenerate: async () => new Promise<MockGenerateResult>(() => {}),
    });

    const promise = corroborate({
      witnesses: { fast: fastModel, slow: hangingModel },
      schema: BasicSchema,
      prompt: 'Wait',
      abortSignal: midCtrl.signal,
      onWitness: label => {
        seenOnWitness.push(label);
        if (label === 'fast') {
          midCtrl.abort('caller-stop-now');
        }
      },
    });

    await expect(promise).rejects.toBe('caller-stop-now');
    await new Promise(r => setTimeout(r, 20));
    expect(seenOnWitness).toEqual(['fast']);
  });

  test('4.6 Zod transform returning Date fails with NonJsonValue and path while other witnesses succeed (I7, D15)', async () => {
    const DateTransformSchema = z.object({
      ok: z.boolean(),
      at: z
        .string()
        .transform(s =>
          s === 'make-date' ? new Date('2026-01-01T00:00:00Z') : s,
        ),
    });

    const ledger = await corroborate({
      witnesses: {
        bad: makeMockModel(
          { ok: true, at: 'make-date' },
          { provider: 'openai.chat', modelId: 'gpt-4o' },
        ),
        b: makeMockModel(
          { ok: true, at: '2026-01-01' },
          { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
        ),
        c: makeMockModel(
          { ok: true, at: '2026-01-01' },
          { provider: 'google.generative-ai', modelId: 'gemini-2.5-flash' },
        ),
      },
      schema: DateTransformSchema,
      prompt: 'Return date field',
    });

    expect(ledger.quorum.answered).toBe(2);
    expect(ledger.quorum.failed).toBe(1);
    const bad = ledger.witnesses.bad;
    expect(bad.status).toBe('failed');
    if (bad.status === 'failed') {
      expect(bad.error.kind).toBe('invalid-output');
      expect(bad.error.name).toBe('NonJsonValue');
      expect(bad.error.path).toBe('/at');
    }
    expect(ledger.fields['/ok']?.status).toBe('agree');

    // Non-object root JSON returned under unvalidated jsonSchema() is rejected as invalid-output (G2)
    const rawArraySchema = jsonSchema<{ approved: boolean }>({
      type: 'object',
      properties: { approved: { type: 'boolean' } },
      required: ['approved'],
      additionalProperties: false,
    });
    const nonObjectLedger = await corroborate({
      witnesses: {
        arr: makeMockModel([]),
        good1: makeMockModel({ approved: true }),
        good2: makeMockModel({ approved: true }),
      },
      schema: rawArraySchema,
      prompt: 'Non-object root check',
    });
    expect(nonObjectLedger.witnesses.arr.status).toBe('failed');
    if (nonObjectLedger.witnesses.arr.status === 'failed') {
      expect(nonObjectLedger.witnesses.arr.error.kind).toBe('invalid-output');
    }
    expect(nonObjectLedger.fields['/approved']?.status).toBe('agree');
  });

  test('4.7 maxOutputBytes exceeded -> invalid-output / OutputTooLarge, output not stored (§12.4)', async () => {
    const bigRationale = 'x'.repeat(2048);
    const ledger = await corroborate({
      witnesses: {
        huge: makeMockModel(
          {
            approved: true,
            severity: 'low',
            tags: [],
            rationale: bigRationale,
          },
          { provider: 'openai.chat', modelId: 'gpt-4o' },
        ),
        small: makeMockModel(
          { approved: true, severity: 'low', tags: [], rationale: 'tiny' },
          { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
        ),
      },
      schema: BasicSchema,
      prompt: 'Check size',
      maxOutputBytes: 1024,
    });

    const rec = ledger.witnesses.huge;
    expect(rec.status).toBe('failed');
    if (rec.status === 'failed') {
      expect(rec.error.kind).toBe('invalid-output');
      expect(rec.error.name).toBe('OutputTooLarge');
      expect(rec.error.message).toMatch(/\d+/);
      expect('output' in rec).toBe(false);
    }
    expect(JSON.stringify(ledger)).not.toContain(bigRationale);
  });

  test('4.8 error text sanitization, secret redaction, UTF-8 byte boundary truncation, and APICallError field stripping (§12.3)', async () => {
    const headerSentinel = 'PRIVATE_HEADER_SENTINEL';
    const bodySentinel = 'PRIVATE_BODY_SENTINEL';
    const secretPayload = [
      '\u001b[31mError\u001b[0m',
      'auth=Bearer abc.def',
      'sk-1234567890abcdef12',
      'api_key=my_secret_key',
      'https://host.test/p?key=query_secret',
      'bidi\u202ehidden',
      '😀'.repeat(120),
    ].join(' ');

    const errModel = new MockLanguageModelV4({
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      doGenerate: async () => {
        throw new APICallError({
          message: secretPayload,
          url: `https://api.example.com/${bodySentinel}`,
          requestBodyValues: { raw: bodySentinel },
          statusCode: 401,
          responseHeaders: { authorization: headerSentinel },
          responseBody: bodySentinel,
          isRetryable: false,
        });
      },
    });
    const okModel = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: 'ok' },
      { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
    );

    const maxBytes = 256;
    const ledger = await corroborate({
      witnesses: { bad: errModel, ok: okModel },
      schema: BasicSchema,
      prompt: 'Check error text',
      maxErrorTextBytes: maxBytes,
      maxRetries: 0,
    });

    const rec = ledger.witnesses.bad;
    expect(rec.status).toBe('failed');
    if (rec.status === 'failed') {
      const m = rec.error.message;
      expect(m).toContain('Bearer [REDACTED]');
      expect(m).toContain('[REDACTED]');
      expect(m).not.toContain('abc.def');
      expect(m).not.toContain('1234567890abcdef12');
      expect(m).not.toContain('my_secret_key');
      expect(m).not.toContain('query_secret');
      expect(m).not.toContain('\u001b');
      expect(m).not.toContain('\u202e');
      expect(rec.error.messageTruncated).toBe(true);
      expect(new TextEncoder().encode(m).byteLength).toBeLessThanOrEqual(
        maxBytes,
      );
      // Verify no lone surrogate at the end of truncated UTF-16 string
      const lastCode = m.charCodeAt(m.length - 1);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
    }

    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain(headerSentinel);
    expect(serialized).not.toContain(bodySentinel);
  });

  test('4.9 input fidelity: exact instructions, prompt/messages references passed; lineEndings affects hash only (I4, D4)', async () => {
    const instructions = 'Line1\r\nLine2\r\n';
    const promptCrlf = 'Check\r\nthis\r\n';
    const promptLf = 'Check\nthis\n';

    const m1 = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: '1' },
      { provider: 'openai.chat', modelId: 'gpt-4o' },
    );
    const m2 = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: '2' },
      { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
    );

    const lNorm = await corroborate({
      witnesses: { m1, m2 },
      schema: BasicSchema,
      instructions,
      prompt: promptCrlf,
      includeInput: 'full',
    });
    const lPreserve = await corroborate({
      witnesses: { m1, m2 },
      schema: BasicSchema,
      instructions,
      prompt: promptCrlf,
      lineEndings: 'preserve',
      includeInput: 'full',
    });

    const expectedLfHash = await sha256Hex(canonicalJson(promptLf));
    expect(lNorm.question.lineEndings).toBe('normalized-for-hash');
    expect(lNorm.question.inputHash).toBe(expectedLfHash);
    expect(lPreserve.question.lineEndings).toBe('preserved');
    expect(lPreserve.question.inputHash).not.toBe(expectedLfHash);
    expect(lNorm.question.raw?.prompt).toBe(promptCrlf);
    expect(lNorm.question.raw?.instructions).toBe(instructions);

    // Check raw call prompt forwarded untouched to the model
    const sentPrompt = m1.doGenerateCalls[0]?.prompt;
    expect(JSON.stringify(sentPrompt)).toContain('\\r\\n');

    // Also test messages object fidelity via onGenerateTextParams hook
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello\r\n' }] },
    ];
    let seenMessages: unknown;
    let seenInstructions: unknown;
    await corroborateWithHooks(
      {
        witnesses: { m1, m2 },
        schema: BasicSchema,
        instructions,
        messages,
      },
      {
        onGenerateTextParams: p => {
          seenMessages = p.messages;
          seenInstructions = p.instructions;
        },
      },
    );
    expect(seenMessages).toBe(messages);
    expect(seenInstructions).toBe(instructions);
  });

  test('4.10 synchronous validation rejects with documented DissentArgumentError codes and zero mock calls (§12.1)', async () => {
    let called = 0;
    const mk = () =>
      new MockLanguageModelV4({
        provider: 'openai.chat',
        modelId: 'gpt-4o',
        doGenerate: async () => {
          called++;
          return makeTextResult({
            approved: true,
            severity: 'low',
            tags: [],
            rationale: 'ok',
          });
        },
      });
    const m1 = mk();
    const m2 = mk();

    // 1 witness
    await expectArgError(
      () =>
        corroborate({
          witnesses: { only: m1 },
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'too-few-witnesses',
    );

    // 17 witnesses
    const seventeen: Record<string, MockLanguageModelV4> = {};
    for (let i = 0; i < 17; i++) seventeen[`w${i}`] = m1;
    await expectArgError(
      () =>
        corroborate({
          witnesses: seventeen,
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'too-many-witnesses',
    );

    // '' label
    await expectArgError(
      () =>
        corroborate({
          witnesses: { '': m1, ok: m2 },
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'invalid-label',
    );

    // '__proto__' label
    const protoWitnesses: Record<string, MockLanguageModelV4> = { ok: m2 };
    Object.defineProperty(protoWitnesses, '__proto__', {
      value: m1,
      enumerable: true,
      configurable: true,
    });
    await expectArgError(
      () =>
        corroborate({
          witnesses: protoWitnesses,
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'reserved-label',
    );

    // 'a b' label
    await expectArgError(
      () =>
        corroborate({
          witnesses: { 'a b': m1, ok: m2 },
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'invalid-label',
    );

    // 'constructor' label
    await expectArgError(
      () =>
        corroborate({
          witnesses: { constructor: m1, ok: m2 },
          schema: BasicSchema,
          prompt: 'hi',
        }),
      'reserved-label',
    );

    // both prompt and messages
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: BasicSchema,
          prompt: 'p',
          messages: [{ role: 'user', content: 'm' }],
        } as never),
      'prompt-and-messages',
    );

    // neither prompt nor messages
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: BasicSchema,
        } as never),
      'no-input',
    );

    // root schema z.string()
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: z.string(),
          prompt: 'hi',
        }),
      'schema-root-not-object',
    );

    // bad author model 'gpt-4o'
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: BasicSchema,
          prompt: 'hi',
          provenance: { authorModels: ['gpt-4o'] },
        }),
      'invalid-author-model',
    );

    // excludeAuthor without authors
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: BasicSchema,
          prompt: 'hi',
          provenance: { authorModels: [], excludeAuthor: true },
        }),
      'exclude-without-authors',
    );

    // maxConcurrency: 0
    await expectArgError(
      () =>
        corroborate({
          witnesses: { m1, m2 },
          schema: BasicSchema,
          prompt: 'hi',
          maxConcurrency: 0,
        }),
      'invalid-option',
    );

    // Missing / non-schema options.schema rejected before asSchema (G1)
    for (const badSchema of [
      undefined,
      null,
      'string-schema',
      { type: 'object', properties: { ok: { type: 'boolean' } } },
    ]) {
      await expectArgError(
        () =>
          corroborate({
            witnesses: { m1, m2 },
            schema: badSchema as unknown as typeof BasicSchema,
            prompt: 'hi',
          }),
        'invalid-option',
      );
    }

    expect(called).toBe(0);
  });

  test('4.11 model identity and matching table (§8.2)', async () => {
    expect(toRequestedIdentity('openai/gpt-4o')).toEqual({
      provider: 'gateway-string',
      modelId: 'openai/gpt-4o',
      canonicalId: 'openai/gpt-4o',
      providerKey: 'openai',
    });

    expect(toRequestedIdentity('gpt-4o')).toEqual({
      provider: 'gateway-string',
      modelId: 'gpt-4o',
      canonicalId: 'gpt-4o',
      providerKey: '(default)',
    });

    const openaiMock = new MockLanguageModelV4({
      provider: 'openai.chat',
      modelId: 'gpt-4o',
    });
    expect(toRequestedIdentity(openaiMock)).toEqual({
      provider: 'openai.chat',
      modelId: 'gpt-4o',
      canonicalId: 'openai/gpt-4o',
      providerKey: 'openai',
    });

    const gwMock = new MockLanguageModelV4({
      provider: 'gateway',
      modelId: 'OpenAI/GPT-4o',
    });
    expect(toRequestedIdentity(gwMock)).toEqual({
      provider: 'gateway',
      modelId: 'OpenAI/GPT-4o',
      canonicalId: 'openai/gpt-4o',
      providerKey: 'openai',
    });

    const bareReq = toRequestedIdentity('gpt-4o');
    expect(toServedIdentity(bareReq, 'gpt-4o-0613')).toEqual({
      provider: '(default)',
      modelId: 'gpt-4o-0613',
      canonicalId: '(default)/gpt-4o-0613',
      providerKey: '(default)',
    });
    expect(toServedIdentity(bareReq, 'Anthropic/Claude-Sonnet-4')).toEqual({
      provider: 'anthropic',
      modelId: 'Anthropic/Claude-Sonnet-4',
      canonicalId: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });
    expect(toServedIdentity(bareReq, undefined)).toBeNull();

    // End-to-end string resolution via AI_SDK_DEFAULT_PROVIDER without network
    const answer = {
      approved: true,
      severity: 'low',
      tags: [],
      rationale: 'ok',
    };
    const prev = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown })
      .AI_SDK_DEFAULT_PROVIDER;
    (
      globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
    ).AI_SDK_DEFAULT_PROVIDER = new MockProviderV4({
      languageModels: {
        'openai/gpt-4o': makeMockModel(answer, {
          provider: 'gateway',
          modelId: 'openai/gpt-4o',
          servedModelId: 'GPT-4o',
        }),
        'gpt-4o': makeMockModel(answer, {
          provider: 'default',
          modelId: 'gpt-4o',
        }),
      },
    });
    try {
      const ledger = await corroborate({
        witnesses: {
          gw: 'openai/gpt-4o',
          bare: 'gpt-4o',
        },
        schema: BasicSchema,
        prompt: 'Compare strings',
      });
      expect(ledger.witnesses.gw.requested.canonicalId).toBe('openai/gpt-4o');
      expect(ledger.witnesses.gw.requested.providerKey).toBe('openai');
      expect(ledger.witnesses.gw.status).toBe('answered');
      if (ledger.witnesses.gw.status === 'answered') {
        expect(ledger.witnesses.gw.served?.canonicalId).toBe('openai/gpt-4o');
      }
      expect(ledger.witnesses.bare.requested.canonicalId).toBe('gpt-4o');
      expect(ledger.witnesses.bare.requested.providerKey).toBe('(default)');

      // Non-Gateway providers keep their own providerKey even when modelId contains '/' (§8.2 A4)
      const openrouterMock = new MockLanguageModelV4({
        provider: 'openrouter.chat',
        modelId: 'anthropic/claude-sonnet-4',
      });
      const orReq = toRequestedIdentity(openrouterMock);
      expect(orReq).toEqual({
        provider: 'openrouter.chat',
        modelId: 'anthropic/claude-sonnet-4',
        canonicalId: 'openrouter/anthropic/claude-sonnet-4',
        providerKey: 'openrouter',
      });
      expect(toServedIdentity(orReq, 'anthropic/claude-sonnet-4')).toEqual({
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        canonicalId: 'openrouter/anthropic/claude-sonnet-4',
        providerKey: 'openrouter',
      });

      // Leading/trailing slashes do not produce empty providerKey
      const leadingSlashMock = new MockLanguageModelV4({
        provider: 'gateway',
        modelId: '/gpt-4o',
      });
      expect(toRequestedIdentity(leadingSlashMock)).toEqual({
        provider: 'gateway',
        modelId: '/gpt-4o',
        canonicalId: 'gateway//gpt-4o',
        providerKey: 'gateway',
      });
    } finally {
      (
        globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
      ).AI_SDK_DEFAULT_PROVIDER = prev;
    }
  });

  test('4.12 self-grading detection without exclusion emits finding and still compares (§8.3)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const ledger = await corroborate({
      witnesses: {
        author: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
        }),
        peer: makeMockModel(
          { ...ok, approved: false },
          { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
        ),
      },
      schema: BasicSchema,
      prompt: 'Review',
      provenance: { authorModels: ['OpenAI/GPT-4O'] },
    });

    expect(ledger.quorum.excluded).toBe(0);
    expect(ledger.quorum.answered).toBe(2);
    expect(ledger.independence.selfGradingWitnesses).toEqual([
      { witness: 'author', authorModel: 'openai/gpt-4o', on: 'requested' },
    ]);
    expect(ledger.findings).toContainEqual({
      code: 'self-grading',
      severity: 'warn',
      witnesses: ['author'],
      data: { authorModel: 'openai/gpt-4o', on: 'requested' },
    });
    expect(ledger.fields['/approved']?.status).toBe('split');
  });

  test('4.13 excludeAuthor before dispatch excludes without calling model (I5, I6)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const authorMock = makeMockModel(ok, {
      provider: 'openai.chat',
      modelId: 'gpt-4o',
    });
    const ledger = await corroborate({
      witnesses: {
        author: authorMock,
        b: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
        }),
        c: makeMockModel(ok, {
          provider: 'google.generative-ai',
          modelId: 'gemini-2.5-flash',
        }),
      },
      schema: BasicSchema,
      prompt: 'Review',
      provenance: {
        authorModels: ['openai/gpt-4o'],
        excludeAuthor: true,
      },
    });

    expect(authorMock.doGenerateCalls.length).toBe(0);
    expect(ledger.quorum).toEqual({
      listed: 3,
      asked: 2,
      answered: 2,
      failed: 0,
      excluded: 1,
    });
    expect(ledger.witnesses.author).toMatchObject({
      status: 'excluded',
      stage: 'before-dispatch',
      match: { authorModel: 'openai/gpt-4o', on: 'requested' },
      served: null,
      durationMs: 0,
      usage: null,
    });
    expect(ledger.independence.excludedWitnesses).toEqual([
      {
        witness: 'author',
        stage: 'before-dispatch',
        authorModel: 'openai/gpt-4o',
        on: 'requested',
      },
    ]);
    expect(ledger.findings).toContainEqual({
      code: 'witness-excluded',
      severity: 'info',
      witnesses: ['author'],
      data: {
        stage: 'before-dispatch',
        authorModel: 'openai/gpt-4o',
        on: 'requested',
      },
    });
  });

  test('4.14 excludeAuthor after response: served id matches -> excluded after-response, output kept, never compared (I6, D5)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const reroutedMock = makeMockModel(
      { ...ok, approved: false },
      {
        provider: 'gateway',
        modelId: 'xai/grok-3',
        servedModelId: 'openai/gpt-4o',
      },
    );
    const ledger = await corroborate({
      witnesses: {
        rerouted: reroutedMock,
        b: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
        }),
        c: makeMockModel(ok, {
          provider: 'google.generative-ai',
          modelId: 'gemini-2.5-flash',
        }),
      },
      schema: BasicSchema,
      prompt: 'Review',
      provenance: {
        authorModels: ['openai/gpt-4o'],
        excludeAuthor: true,
      },
    });

    expect(reroutedMock.doGenerateCalls.length).toBe(1);
    expect(ledger.quorum).toEqual({
      listed: 3,
      asked: 3,
      answered: 2,
      failed: 0,
      excluded: 1,
    });
    const excl = ledger.witnesses.rerouted;
    expect(excl.status).toBe('excluded');
    if (excl.status === 'excluded') {
      expect(excl.stage).toBe('after-response');
      expect(excl.output).toEqual({ ...ok, approved: false });
      expect(excl.served?.canonicalId).toBe('openai/gpt-4o');
    }
    expect(ledger.fields['/approved']?.status).toBe('agree');
    expect(ledger.fields['/approved']?.presented).toEqual(['b', 'c']);
  });

  test('4.15 exclusion leaving fewer than 2 witnesses throws too-few-witnesses-after-exclusion with zero calls', async () => {
    const a = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: 'ok' },
      { provider: 'openai.chat', modelId: 'gpt-4o' },
    );
    const b = makeMockModel(
      { approved: true, severity: 'low', tags: [], rationale: 'ok' },
      { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
    );

    await expectArgError(
      () =>
        corroborate({
          witnesses: { a, b },
          schema: BasicSchema,
          prompt: 'Hi',
          provenance: { authorModels: ['openai/gpt-4o'], excludeAuthor: true },
        }),
      'too-few-witnesses-after-exclusion',
    );
    expect(a.doGenerateCalls.length).toBe(0);
    expect(b.doGenerateCalls.length).toBe(0);
  });

  test('4.16 independence: duplicate-served-model, single-provider, and (default) exception (§8.4)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };

    const sameProviderLedger = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-2024-08-06',
        }),
        b: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4.1',
          servedModelId: 'gpt-4o-2024-08-06',
        }),
      },
      schema: BasicSchema,
      prompt: 'Check',
    });

    expect(sameProviderLedger.independence.uniqueRequestedProviders).toBe(1);
    expect(sameProviderLedger.independence.duplicateServedModels).toEqual([
      { canonicalId: 'openai/gpt-4o-2024-08-06', witnesses: ['a', 'b'] },
    ]);
    expect(sameProviderLedger.independence.sameProviderGroups).toEqual([
      { providerKey: 'openai', witnesses: ['a', 'b'] },
    ]);
    expect(
      sameProviderLedger.findings.some(
        f => f.code === 'duplicate-served-model',
      ),
    ).toBe(true);
    expect(
      sameProviderLedger.findings.some(f => f.code === 'single-provider'),
    ).toBe(true);

    // Two namespaced models on one aggregator trigger single-provider (§8.2 A4)
    const aggregatorLedger = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openrouter.chat',
          modelId: 'anthropic/claude-sonnet-4',
        }),
        b: makeMockModel(ok, {
          provider: 'openrouter.chat',
          modelId: 'openai/gpt-4o',
        }),
      },
      schema: BasicSchema,
      prompt: 'Check aggregator independence',
    });
    expect(aggregatorLedger.independence.uniqueRequestedProviders).toBe(1);
    expect(aggregatorLedger.independence.sameProviderGroups).toEqual([
      { providerKey: 'openrouter', witnesses: ['a', 'b'] },
    ]);
    expect(
      aggregatorLedger.findings.some(f => f.code === 'single-provider'),
    ).toBe(true);

    // Bare strings have providerKey '(default)' -> never emit 'single-provider'
    const prev = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown })
      .AI_SDK_DEFAULT_PROVIDER;
    (
      globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
    ).AI_SDK_DEFAULT_PROVIDER = new MockProviderV4({
      languageModels: {
        'bare-one': makeMockModel(ok, {
          provider: 'mock',
          modelId: 'bare-one',
        }),
        'bare-two': makeMockModel(ok, {
          provider: 'mock',
          modelId: 'bare-two',
        }),
      },
    });
    try {
      const bareLedger = await corroborate({
        witnesses: { x: 'bare-one', y: 'bare-two' },
        schema: BasicSchema,
        prompt: 'Check',
      });
      expect(bareLedger.independence.uniqueRequestedProviders).toBe(1);
      expect(bareLedger.findings.some(f => f.code === 'single-provider')).toBe(
        false,
      );
    } finally {
      (
        globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
      ).AI_SDK_DEFAULT_PROVIDER = prev;
    }
  });

  test('4.17 maxConcurrency: 1 serializes in label order; default overlaps; ledgers match modulo timing (I3)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const mkDelayed = (
      events: string[],
      label: string,
      activeRef: { cur: number; max: number },
      delayMs: number,
    ) =>
      new MockLanguageModelV4({
        provider: `p-${label}`,
        modelId: `m-${label}`,
        doGenerate: async () => {
          events.push(`start:${label}`);
          activeRef.cur++;
          activeRef.max = Math.max(activeRef.max, activeRef.cur);
          await new Promise(r => setTimeout(r, delayMs));
          activeRef.cur--;
          events.push(`end:${label}`);
          return makeTextResult(ok);
        },
      });

    const seqEvents: string[] = [];
    const seqActive = { cur: 0, max: 0 };
    const seqLedger = await corroborate({
      witnesses: {
        c: mkDelayed(seqEvents, 'c', seqActive, 10),
        a: mkDelayed(seqEvents, 'a', seqActive, 10),
        b: mkDelayed(seqEvents, 'b', seqActive, 10),
      },
      schema: BasicSchema,
      prompt: 'Concurrency check',
      maxConcurrency: 1,
    });
    expect(seqActive.max).toBe(1);
    expect(seqEvents).toEqual([
      'start:a',
      'end:a',
      'start:b',
      'end:b',
      'start:c',
      'end:c',
    ]);

    const parEvents: string[] = [];
    const parActive = { cur: 0, max: 0 };
    const parLedger = await corroborate({
      witnesses: {
        c: mkDelayed(parEvents, 'c', parActive, 25),
        a: mkDelayed(parEvents, 'a', parActive, 25),
        b: mkDelayed(parEvents, 'b', parActive, 25),
      },
      schema: BasicSchema,
      prompt: 'Concurrency check',
    });
    expect(parActive.max).toBe(3);
    expect(parEvents.slice(0, 3)).toEqual(['start:a', 'start:b', 'start:c']);
    expect(parLedger.fingerprint).toBe(seqLedger.fingerprint);
    expect(parLedger.fields).toEqual(seqLedger.fields);
  });

  test('4.18 witness insertion order produces identical ledger.fingerprint and fields (I3)', async () => {
    const mA = makeMockModel(
      { approved: true, severity: 'low', tags: ['x', 'y'], rationale: 'a' },
      { provider: 'openai.chat', modelId: 'gpt-4o' },
    );
    const mB = makeMockModel(
      { approved: false, severity: 'high', tags: ['y', 'z'], rationale: 'b' },
      { provider: 'anthropic.messages', modelId: 'claude-sonnet-4' },
    );
    const mC = makeMockModel(
      { approved: true, severity: 'low', tags: ['y'], rationale: 'c' },
      { provider: 'google.generative-ai', modelId: 'gemini-2.5-flash' },
    );

    const l1 = await corroborate({
      witnesses: { gamma: mC, alpha: mA, beta: mB },
      schema: BasicSchema,
      prompt: 'Order check',
    });
    const l2 = await corroborate({
      witnesses: { beta: mB, gamma: mC, alpha: mA },
      schema: BasicSchema,
      prompt: 'Order check',
    });

    expect(l1.fingerprint).toBe(l2.fingerprint);
    expect(canonicalJson(l1.fields)).toBe(canonicalJson(l2.fields));
    expect(Object.keys(l1.witnesses)).toEqual(['alpha', 'beta', 'gamma']);
    expect(Object.keys(l2.witnesses)).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('4.19 fingerprint scope (I3c)', async () => {
    const ok = { approved: true, severity: 'low', tags: ['a'], rationale: 'r' };

    const baseLedger = await corroborate({
      witnesses: {
        a: {
          model: makeMockModel(ok, {
            provider: 'openai.chat',
            modelId: 'gpt-4o',
            servedModelId: 'gpt-4o-v1',
            usage: makeV4Usage({ inputTotal: 5, outputTotal: 10 }),
            warnings: [{ type: 'other', message: 'warn-1' }],
          }),
          settings: { temperature: 0.1 },
        },
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('transient message 1');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
    });

    // Changing timing, usage, warnings, error message, temperature leaves fingerprint unchanged
    const sameInputsDifferentNoise = await corroborate({
      witnesses: {
        a: {
          model: makeMockModel(ok, {
            provider: 'openai.chat',
            modelId: 'gpt-4o',
            servedModelId: 'gpt-4o-v1',
            usage: makeV4Usage({ inputTotal: 999, outputTotal: 888 }),
            warnings: [
              { type: 'other', message: 'completely different warning' },
            ],
          }),
          settings: { temperature: 0.9 },
        },
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            await new Promise(r => setTimeout(r, 15));
            throw new Error('transient message 2');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
    });
    expect(sameInputsDifferentNoise.fingerprint).toBe(baseLedger.fingerprint);

    // Changing output changes fingerprint
    const diffOut = await corroborate({
      witnesses: {
        a: makeMockModel(
          { ...ok, approved: false },
          {
            provider: 'openai.chat',
            modelId: 'gpt-4o',
            servedModelId: 'gpt-4o-v1',
          },
        ),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('err');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
    });
    expect(diffOut.fingerprint).not.toBe(baseLedger.fingerprint);

    // Changing served id changes fingerprint
    const diffServed = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-v2',
        }),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('err');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
    });
    expect(diffServed.fingerprint).not.toBe(baseLedger.fingerprint);

    // Changing failure kind changes fingerprint
    const diffErrKind = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-v1',
        }),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new LoadAPIKeyError({ message: 'missing key' });
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
    });
    expect(diffErrKind.fingerprint).not.toBe(baseLedger.fingerprint);

    // Changing schema or prompt changes fingerprint
    const diffPrompt = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-v1',
        }),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('err');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Different prompt',
    });
    expect(diffPrompt.fingerprint).not.toBe(baseLedger.fingerprint);

    const diffSchema = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-v1',
        }),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('err');
          },
        }),
      },
      schema: BasicSchema.extend({ extra: z.boolean().optional() }),
      prompt: 'Check scope',
    });
    expect(diffSchema.fingerprint).not.toBe(baseLedger.fingerprint);

    // Changing comparator override changes plan.fingerprint and ledger.fingerprint
    const diffOverride = await corroborate({
      witnesses: {
        a: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-v1',
        }),
        b: new MockLanguageModelV4({
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          doGenerate: async () => {
            throw new Error('err');
          },
        }),
      },
      schema: BasicSchema,
      prompt: 'Check scope',
      compare: { rationale: 'exact' },
    });
    expect(diffOverride.plan.fingerprint).not.toBe(baseLedger.plan.fingerprint);
    expect(diffOverride.fingerprint).not.toBe(baseLedger.fingerprint);

    // Injecting a different compareFields computation changes fields, NOT ledger.fingerprint
    const mutatedCompare = await corroborateWithHooks(
      {
        witnesses: {
          a: makeMockModel(ok, {
            provider: 'openai.chat',
            modelId: 'gpt-4o',
            servedModelId: 'gpt-4o-v1',
          }),
          b: new MockLanguageModelV4({
            provider: 'anthropic.messages',
            modelId: 'claude-sonnet-4',
            doGenerate: async () => {
              throw new Error('err');
            },
          }),
        },
        schema: BasicSchema,
        prompt: 'Check scope',
      },
      {
        compareFields: (planFields, answered) => {
          const real = compareFields(planFields, answered);
          delete real['/tags'];
          return real;
        },
      },
    );
    expect(mutatedCompare.fields['/tags']).toBeUndefined();
    expect(mutatedCompare.fingerprint).toBe(baseLedger.fingerprint);
  });

  test('4.20 JSON round trip of full ledger with all statuses present has no undefined keys (I7, I8)', async () => {
    const ok = {
      approved: true,
      severity: 'low',
      tags: ['a'],
      rationale: 'ok',
    };
    const ledger = await corroborate({
      witnesses: {
        wAnswered1: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          servedModelId: 'gpt-4o-1',
        }),
        wAnswered2: makeMockModel(
          { ...ok, approved: false },
          {
            provider: 'google.generative-ai',
            modelId: 'gemini-2.5-flash',
          },
        ),
        wFailed: new MockLanguageModelV4({
          provider: 'mistral.chat',
          modelId: 'mistral-large',
          doGenerate: async () => {
            throw new LoadAPIKeyError({ message: 'missing' });
          },
        }),
        wExclBefore: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-author',
        }),
        wExclAfter: makeMockModel(ok, {
          provider: 'gateway',
          modelId: 'xai/grok',
          servedModelId: 'anthropic/claude-author',
        }),
      },
      schema: BasicSchema,
      prompt: 'Full round trip',
      includeInput: 'full',
      provenance: {
        authorModels: ['anthropic/claude-author'],
        excludeAuthor: true,
      },
    });

    expect(findUndefinedKeyPath(ledger)).toBeNull();
    const roundTripped: unknown = JSON.parse(JSON.stringify(ledger));
    expect(roundTripped).toEqual(ledger);
  });

  test('4.21 onWitness called once per settled witness; throwing aborts pending calls and rejects with thrown error (D18)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const settled: Array<[string, WitnessRecord<unknown>]> = [];
    await corroborate({
      witnesses: {
        a: makeMockModel(ok, { provider: 'openai.chat', modelId: 'gpt-4o' }),
        b: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
        }),
      },
      schema: BasicSchema,
      prompt: 'Check callbacks',
      onWitness: (label, record) => {
        settled.push([label, record]);
      },
    });
    expect(sortLabels(settled.map(([l]) => l))).toEqual(['a', 'b']);

    // Throwing in onWitness aborts pending calls and rejects with exact error
    const boom = new Error('callback-bug');
    let pendingSignal: AbortSignal | undefined;
    const fast = makeMockModel(ok, {
      provider: 'openai.chat',
      modelId: 'gpt-4o',
    });
    const pending = new MockLanguageModelV4({
      provider: 'anthropic.messages',
      modelId: 'claude-sonnet-4',
      doGenerate: async ({ abortSignal }) => {
        pendingSignal = abortSignal;
        return new Promise<MockGenerateResult>((_resolve, reject) => {
          abortSignal?.addEventListener(
            'abort',
            () => reject(abortSignal.reason),
            {
              once: true,
            },
          );
        });
      },
    });

    await expect(
      corroborate({
        witnesses: { fast, pending },
        schema: BasicSchema,
        prompt: 'Callback throw',
        onWitness: label => {
          if (label === 'fast') throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(pendingSignal?.aborted).toBe(true);
  });

  test('4.22 usage mapping and totals sum only reported numbers; null when nobody reported', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const ledger = await corroborate({
      witnesses: {
        w1: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          usage: makeV4Usage({
            inputTotal: 10,
            outputTotal: 20,
            cacheRead: 3,
          }),
        }),
        w2: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          usage: makeV4Usage({
            inputTotal: 5,
            outputTotal: undefined,
            cacheRead: 7,
          }),
        }),
      },
      schema: BasicSchema,
      prompt: 'Usage check',
    });

    expect(ledger.usage.perWitness.w1).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 3,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(ledger.usage.perWitness.w2).toEqual({
      inputTokens: 5,
      outputTokens: null,
      totalTokens: 5,
      cacheReadTokens: 7,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
    expect(ledger.usage.total).toEqual({
      inputTokens: 15,
      outputTokens: 20,
      totalTokens: 35,
      cacheReadTokens: 10,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });

    // When nobody reports any token field, all usage fields are null.
    const emptyUsageLedger = await corroborate({
      witnesses: {
        w1: makeMockModel(ok, {
          provider: 'openai.chat',
          modelId: 'gpt-4o',
          usage: makeV4Usage(),
        }),
        w2: makeMockModel(ok, {
          provider: 'anthropic.messages',
          modelId: 'claude-sonnet-4',
          usage: makeV4Usage(),
        }),
      },
      schema: BasicSchema,
      prompt: 'Empty usage check',
    });
    expect(emptyUsageLedger.usage.total).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    });
  });

  test('4.23 telemetry object is passed to generateText unchanged (same reference) (D2)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const seenFunctionIds: Array<string | undefined> = [];
    const telemetry: TelemetryOptions = {
      isEnabled: true,
      functionId: 'dissent-smoke-fn',
      integrations: [
        {
          onStart: event => {
            seenFunctionIds.push(event.functionId);
          },
        },
      ],
    };

    const passedRefs: Array<TelemetryOptions | undefined> = [];
    await corroborateWithHooks(
      {
        witnesses: {
          a: makeMockModel(ok, { provider: 'openai.chat', modelId: 'gpt-4o' }),
          b: makeMockModel(ok, {
            provider: 'anthropic.messages',
            modelId: 'claude-sonnet-4',
          }),
        },
        schema: BasicSchema,
        prompt: 'Telemetry check',
        telemetry,
      },
      {
        onGenerateTextParams: p => {
          passedRefs.push(p.telemetry);
        },
      },
    );

    expect(passedRefs).toHaveLength(2);
    expect(passedRefs[0]).toBe(telemetry);
    expect(passedRefs[1]).toBe(telemetry);
    expect(seenFunctionIds).toEqual(['dissent-smoke-fn', 'dissent-smoke-fn']);
  });

  test('4.25 Gateway error marker classification and sentinel isolation (§7.1, A1)', async () => {
    const ok = { approved: true, severity: 'low', tags: [], rationale: 'ok' };
    const gatewayMarker = Symbol.for('vercel.ai.gateway.error');
    const causeSentinel = 'GW_CAUSE_SECRET_SENTINEL';
    const genIdSentinel = 'GW_GEN_ID_SENTINEL';

    function makeMarkedGatewayError(opts: {
      name: string;
      message: string;
      markerValue?: unknown;
      statusCode?: number;
      isRetryable?: boolean;
      cause?: unknown;
    }): Error {
      const err = new Error(opts.message) as Error &
        Record<symbol | string, unknown>;
      err.name = opts.name;
      err[gatewayMarker] = opts.markerValue ?? true;
      if (opts.statusCode !== undefined) err.statusCode = opts.statusCode;
      if (opts.isRetryable !== undefined) err.isRetryable = opts.isRetryable;
      err.cause = opts.cause ?? { secret: causeSentinel };
      err.generationId = genIdSentinel;
      return err;
    }

    const gw403 = makeMarkedGatewayError({
      name: 'GatewayInternalServerError',
      message: 'Free tier payment required',
      statusCode: 403,
      isRetryable: false,
    });
    const gw429 = makeMarkedGatewayError({
      name: 'GatewayRateLimitError',
      message: 'Rate limit exceeded',
      statusCode: 429,
      isRetryable: true,
    });
    const inner429 = makeMarkedGatewayError({
      name: 'GatewayRateLimitError',
      message: 'Inner gateway rate limit',
      statusCode: 429,
      isRetryable: true,
    });
    const retryWrapped = new RetryError({
      message: 'Failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [inner429, inner429],
    });
    const gwTimeoutCause = makeMarkedGatewayError({
      name: 'GatewayInternalServerError',
      message: 'Upstream timed out',
      statusCode: 504,
      isRetryable: true,
      cause: new DOMException('Request timed out', 'TimeoutError'),
    });
    const markerStringTrue = makeMarkedGatewayError({
      name: 'FakeGatewayErrorStr',
      message: 'Wrong marker type string',
      markerValue: 'true',
      statusCode: 429,
      isRetryable: true,
    });
    const markerNumberOne = makeMarkedGatewayError({
      name: 'FakeGatewayErrorNum',
      message: 'Wrong marker type number',
      markerValue: 1,
      statusCode: 500,
      isRetryable: true,
    });
    const malformedAuthMarker = makeMarkedGatewayError({
      name: 'GatewayAuthenticationError',
      message: 'Wrong marker with auth name',
      markerValue: 'true',
      statusCode: 401,
      isRetryable: false,
    });
    const prodWrappedGwAuth = new AISDKError({
      name: 'GatewayError',
      message: 'completely different wording',
    });

    const ledger = await corroborate({
      witnesses: {
        ok: makeMockModel(ok, {
          provider: 'gateway',
          modelId: 'openai/gpt-4o-mini',
        }),
        gw403: makeGatewayFailingMock('openai/gpt-4o-mini', gw403),
        gw429: makeGatewayFailingMock('openai/gpt-4o-mini', gw429),
        retryGw: makeGatewayFailingMock('openai/gpt-4o-mini', retryWrapped),
        timeoutGw: makeGatewayFailingMock('openai/gpt-4o-mini', gwTimeoutCause),
        nonBoolStr: makeGatewayFailingMock(
          'openai/gpt-4o-mini',
          markerStringTrue,
        ),
        nonBoolNum: makeGatewayFailingMock(
          'openai/gpt-4o-mini',
          markerNumberOne,
        ),
        malformedAuth: makeGatewayFailingMock(
          'openai/gpt-4o-mini',
          malformedAuthMarker,
        ),
        prodWrapped: makeGatewayFailingMock(
          'openai/gpt-4o-mini',
          prodWrappedGwAuth,
        ),
      },
      schema: BasicSchema,
      prompt: 'Gateway marker check',
      maxRetries: 0,
    });

    const r403 = ledger.witnesses.gw403;
    expect(r403.status).toBe('failed');
    if (r403.status === 'failed') {
      expect(r403.error.kind).toBe('api-error');
      expect(r403.error.statusCode).toBe(403);
      expect(r403.error.isRetryable).toBe(false);
    }

    const r429 = ledger.witnesses.gw429;
    expect(r429.status).toBe('failed');
    if (r429.status === 'failed') {
      expect(r429.error.kind).toBe('api-error');
      expect(r429.error.statusCode).toBe(429);
      expect(r429.error.isRetryable).toBe(true);
    }

    const rRetry = ledger.witnesses.retryGw;
    expect(rRetry.status).toBe('failed');
    if (rRetry.status === 'failed') {
      expect(rRetry.error.kind).toBe('api-error');
      expect(rRetry.error.statusCode).toBe(429);
      expect(rRetry.error.isRetryable).toBe(true);
    }

    const rTimeout = ledger.witnesses.timeoutGw;
    expect(rTimeout.status).toBe('failed');
    if (rTimeout.status === 'failed') {
      expect(rTimeout.error.kind).toBe('timeout');
    }

    for (const rFake of [
      ledger.witnesses.nonBoolStr,
      ledger.witnesses.nonBoolNum,
      ledger.witnesses.malformedAuth,
    ]) {
      expect(rFake.status).toBe('failed');
      if (rFake.status === 'failed') {
        expect(rFake.error.kind).toBe('unknown');
        expect(rFake.error.statusCode).toBeUndefined();
        expect(rFake.error.isRetryable).toBeUndefined();
      }
    }

    const rProdWrapped = ledger.witnesses.prodWrapped;
    expect(rProdWrapped.status).toBe('failed');
    if (rProdWrapped.status === 'failed') {
      expect(rProdWrapped.error.kind).toBe('api-error');
      expect(rProdWrapped.error.name).toBe('GatewayError');
      expect(rProdWrapped.error.statusCode).toBeUndefined();
    }

    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain(causeSentinel);
    expect(serialized).not.toContain(genIdSentinel);
  });
});

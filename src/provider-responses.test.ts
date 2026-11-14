import { createAnthropic } from '@ai-sdk/anthropic';
// @ai-sdk/gateway@4.0.141 matches ai@7.0.168's own gateway dependency (dev-only test coverage).
import { createGateway } from '@ai-sdk/gateway';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { corroborate } from './corroborate.js';

const BasicSchema = z.object({
  approved: z.boolean(),
  severity: z.enum(['low', 'medium', 'high']),
  tags: z.array(z.string()),
  rationale: z.string(),
});

const OK_PAYLOAD = {
  approved: true,
  severity: 'low',
  tags: ['safe'],
  rationale: 'ok',
} as const;

const OK_JSON = JSON.stringify(OK_PAYLOAD);
const TRUNCATED_JSON = '{"approved":true,"severity":"low"';

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v4/ai/language-model';

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> | Response;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

function makeRecordedFetch(
  expectedUrl: string,
  responder: () => Response,
): typeof fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const actualUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (actualUrl !== expectedUrl) {
      throw new Error(
        `Unexpected fetch URL: ${actualUrl} (expected ${expectedUrl})`,
      );
    }
    return responder();
  }) as typeof fetch;
}

function openaiSuccessBody(
  text: string,
  incompleteReason: string | null = null,
) {
  return {
    id: 'resp_openai_1',
    created_at: 1711115037,
    model: 'gpt-4o-mini-2024-07-18',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_openai_1',
        content: [
          {
            type: 'output_text',
            text,
            annotations: [],
          },
        ],
      },
    ],
    incomplete_details:
      incompleteReason !== null ? { reason: incompleteReason } : null,
    usage: {
      input_tokens: 12,
      output_tokens: 18,
      total_tokens: 30,
    },
  };
}

function anthropicSuccessBody(text: string, stopReason = 'end_turn') {
  return {
    id: 'msg_anthropic_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 14,
      output_tokens: 20,
    },
  };
}

function googleSuccessBody(text: string, finishReason = 'STOP') {
  return {
    responseId: 'resp_google_1',
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 16,
      totalTokenCount: 27,
    },
  };
}

function gatewaySuccessBody(text: string, unified: 'stop' | 'length' = 'stop') {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified, raw: unified === 'stop' ? 'stop' : 'length' },
    usage: {
      inputTokens: {
        total: 10,
        noCache: 10,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: 15,
        text: 15,
        reasoning: 0,
      },
    },
  };
}

type FetchContainer = { fetch: typeof fetch };

const unexpectedGlobal: FetchHandler = () => {
  throw new Error('globalThis.fetch must not be called in recorded tests');
};

describe('4.26 recorded provider wire responses (A2)', () => {
  let globalFetchSpy: MockInstance;

  beforeEach(() => {
    globalFetchSpy = vi
      .spyOn(globalThis as unknown as FetchContainer, 'fetch')
      .mockImplementation(unexpectedGlobal as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('all four providers parse structured output and report served identity without network', async () => {
    const openai = createOpenAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(OPENAI_URL, () =>
        jsonResponse(openaiSuccessBody(OK_JSON)),
      ),
    });
    const anthropic = createAnthropic({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(ANTHROPIC_URL, () =>
        jsonResponse(anthropicSuccessBody(OK_JSON)),
      ),
    });
    const google = createGoogleGenerativeAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GOOGLE_URL, () =>
        jsonResponse(googleSuccessBody(OK_JSON)),
      ),
    });
    const gateway = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () =>
        jsonResponse(gatewaySuccessBody(OK_JSON)),
      ),
    });

    const ledger = await corroborate({
      witnesses: {
        openai: openai('gpt-4o-mini'),
        anthropic: anthropic('claude-haiku-4-5'),
        google: google('gemini-2.5-flash'),
        gateway: gateway('openai/gpt-4o-mini'),
      },
      schema: BasicSchema,
      prompt: 'Check recorded success responses',
      maxRetries: 0,
    });

    const wOpenai = ledger.witnesses.openai;
    expect(wOpenai.status).toBe('answered');
    expect(wOpenai.served).toEqual({
      provider: 'openai',
      modelId: 'gpt-4o-mini-2024-07-18',
      canonicalId: 'openai/gpt-4o-mini-2024-07-18',
      providerKey: 'openai',
    });

    const wAnthropic = ledger.witnesses.anthropic;
    expect(wAnthropic.status).toBe('answered');
    expect(wAnthropic.served).toEqual({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
      canonicalId: 'anthropic/claude-haiku-4-5-20251001',
      providerKey: 'anthropic',
    });

    const wGoogle = ledger.witnesses.google;
    expect(wGoogle.status).toBe('answered');
    expect(wGoogle.served).toEqual({
      provider: 'google',
      modelId: 'gemini-2.5-flash',
      canonicalId: 'google/gemini-2.5-flash',
      providerKey: 'google',
    });

    const wGateway = ledger.witnesses.gateway;
    expect(wGateway.status).toBe('answered');
    expect(wGateway.served).toEqual({
      provider: 'openai',
      modelId: 'openai/gpt-4o-mini',
      canonicalId: 'openai/gpt-4o-mini',
      providerKey: 'openai',
    });

    expect(ledger.advisory).toBe('clear');
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  test('each provider classifies HTTP 429 as retryable api-error', async () => {
    const openai = createOpenAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(OPENAI_URL, () =>
        jsonResponse(
          {
            error: {
              message: 'Rate limit reached for requests',
              type: 'requests',
              code: 'rate_limit_exceeded',
            },
          },
          429,
          { 'retry-after-ms': '0' },
        ),
      ),
    });
    const anthropic = createAnthropic({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(ANTHROPIC_URL, () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Rate limit exceeded',
            },
          },
          429,
          { 'retry-after-ms': '0' },
        ),
      ),
    });
    const google = createGoogleGenerativeAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GOOGLE_URL, () =>
        jsonResponse(
          {
            error: {
              code: 429,
              message: 'Resource has been exhausted',
              status: 'RESOURCE_EXHAUSTED',
            },
          },
          429,
          { 'retry-after-ms': '0' },
        ),
      ),
    });
    const gateway = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () =>
        jsonResponse(
          {
            error: {
              message: 'Gateway rate limit exceeded',
              type: 'rate_limit_exceeded',
            },
            generationId: 'gen_429',
          },
          429,
          { 'retry-after-ms': '0' },
        ),
      ),
    });

    const ledger = await corroborate({
      witnesses: {
        openai: openai('gpt-4o-mini'),
        anthropic: anthropic('claude-haiku-4-5'),
        google: google('gemini-2.5-flash'),
        gateway: gateway('openai/gpt-4o-mini'),
      },
      schema: BasicSchema,
      prompt: 'Check 429 error classification',
      maxRetries: 0,
    });

    for (const witness of [
      ledger.witnesses.openai,
      ledger.witnesses.anthropic,
      ledger.witnesses.google,
      ledger.witnesses.gateway,
    ]) {
      expect(witness.status).toBe('failed');
      if (witness.status === 'failed') {
        expect(witness.error.kind).toBe('api-error');
        expect(witness.error.statusCode).toBe(429);
        expect(witness.error.isRetryable).toBe(true);
      }
    }
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  test('each provider classifies HTTP 401 as non-retryable api-error', async () => {
    const openai = createOpenAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(OPENAI_URL, () =>
        jsonResponse(
          {
            error: {
              message: 'Incorrect API key provided',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          },
          401,
        ),
      ),
    });
    const anthropic = createAnthropic({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(ANTHROPIC_URL, () =>
        jsonResponse(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'invalid x-api-key',
            },
          },
          401,
        ),
      ),
    });
    const google = createGoogleGenerativeAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GOOGLE_URL, () =>
        jsonResponse(
          {
            error: {
              code: 401,
              message: 'API key not valid',
              status: 'UNAUTHENTICATED',
            },
          },
          401,
        ),
      ),
    });
    const gateway = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () =>
        jsonResponse(
          {
            error: {
              message: 'Invalid API key',
              type: 'authentication_error',
            },
            generationId: 'gen_401',
          },
          401,
        ),
      ),
    });

    vi.stubEnv('NODE_ENV', 'test');
    try {
      const ledger = await corroborate({
        witnesses: {
          openai: openai('gpt-4o-mini'),
          anthropic: anthropic('claude-haiku-4-5'),
          google: google('gemini-2.5-flash'),
          gateway: gateway('openai/gpt-4o-mini'),
        },
        schema: BasicSchema,
        prompt: 'Check 401 error classification',
        maxRetries: 0,
      });

      for (const id of ['openai', 'anthropic', 'google'] as const) {
        const witness = ledger.witnesses[id];
        expect(witness.status).toBe('failed');
        if (witness.status === 'failed') {
          expect(witness.error.kind).toBe('api-error');
          expect(witness.error.statusCode).toBe(401);
          expect(witness.error.isRetryable).toBe(false);
        }
      }

      // ai's wrapGatewayError converts GatewayAuthenticationError into an Error/AISDKError
      // without statusCode or isRetryable, so Dissent classifies it as api-error without fabricating them.
      const wGateway401 = ledger.witnesses.gateway;
      expect(wGateway401.status).toBe('failed');
      if (wGateway401.status === 'failed') {
        expect(wGateway401.error.kind).toBe('api-error');
        expect(wGateway401.error.name).toBe('GatewayAuthenticationError');
        expect(wGateway401.error.statusCode).toBeUndefined();
        expect(wGateway401.error.isRetryable).toBeUndefined();
      }
      expect(globalFetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('each provider classifies length-limited truncated JSON output per §7', async () => {
    const openai = createOpenAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(OPENAI_URL, () =>
        jsonResponse(openaiSuccessBody(TRUNCATED_JSON, 'max_output_tokens')),
      ),
    });
    const anthropic = createAnthropic({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(ANTHROPIC_URL, () =>
        jsonResponse(anthropicSuccessBody(TRUNCATED_JSON, 'max_tokens')),
      ),
    });
    const google = createGoogleGenerativeAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GOOGLE_URL, () =>
        jsonResponse(googleSuccessBody(TRUNCATED_JSON, 'MAX_TOKENS')),
      ),
    });
    const gateway = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () =>
        jsonResponse(gatewaySuccessBody(TRUNCATED_JSON, 'length')),
      ),
    });

    const ledger = await corroborate({
      witnesses: {
        openai: openai('gpt-4o-mini'),
        anthropic: anthropic('claude-haiku-4-5'),
        google: google('gemini-2.5-flash'),
        gateway: gateway('openai/gpt-4o-mini'),
      },
      schema: BasicSchema,
      prompt: 'Check length truncation classification',
      maxRetries: 0,
    });

    for (const witness of [
      ledger.witnesses.openai,
      ledger.witnesses.anthropic,
      ledger.witnesses.google,
      ledger.witnesses.gateway,
    ]) {
      expect(witness.status).toBe('failed');
      if (witness.status === 'failed') {
        expect(witness.error.kind).toBe('truncated');
      }
    }
    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  test('gateway classifies live free-tier HTTP 403 refusal and preserves inner 429 through RetryError', async () => {
    let retryCalls = 0;
    const gatewayRefusal = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () =>
        jsonResponse(
          {
            error: {
              message:
                'AI Gateway requires a valid credit card on file to service requests.',
              type: 'internal_server_error',
            },
            generationId: 'gen_403_free_tier',
          },
          403,
        ),
      ),
    });
    const gatewayRetry = createGateway({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(GATEWAY_URL, () => {
        retryCalls += 1;
        return jsonResponse(
          {
            error: {
              message: 'Gateway rate limit exceeded',
              type: 'rate_limit_exceeded',
            },
            generationId: `gen_429_attempt_${retryCalls}`,
          },
          429,
          { 'retry-after-ms': '0' },
        );
      }),
    });
    const okOpenai = createOpenAI({
      apiKey: 'test-key-not-real',
      fetch: makeRecordedFetch(OPENAI_URL, () =>
        jsonResponse(openaiSuccessBody(OK_JSON)),
      ),
    });

    const ledger = await corroborate({
      witnesses: {
        ok: okOpenai('gpt-4o-mini'),
        refusal: gatewayRefusal('anthropic/claude-haiku-4-5'),
        retried: gatewayRetry('openai/gpt-4o-mini'),
      },
      schema: BasicSchema,
      prompt: 'Check Gateway 403 refusal and RetryError wrapping 429',
      maxRetries: 1,
    });

    const wRefusal = ledger.witnesses.refusal;
    expect(wRefusal.status).toBe('failed');
    if (wRefusal.status === 'failed') {
      expect(wRefusal.error.kind).toBe('api-error');
      expect(wRefusal.error.statusCode).toBe(403);
      expect(wRefusal.error.isRetryable).toBe(false);
    }

    const wRetried = ledger.witnesses.retried;
    expect(retryCalls).toBe(2);
    expect(wRetried.status).toBe('failed');
    if (wRetried.status === 'failed') {
      expect(wRetried.error.kind).toBe('api-error');
      expect(wRetried.error.statusCode).toBe(429);
      expect(wRetried.error.isRetryable).toBe(true);
    }

    expect(globalFetchSpy).not.toHaveBeenCalled();
  });

  test('gateway 401 under NODE_ENV=production reports GatewayError without status fields', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const okOpenai = createOpenAI({
        apiKey: 'test-key-not-real',
        fetch: makeRecordedFetch(OPENAI_URL, () =>
          jsonResponse(openaiSuccessBody(OK_JSON)),
        ),
      });
      const gateway401 = createGateway({
        apiKey: 'test-key-not-real',
        fetch: makeRecordedFetch(GATEWAY_URL, () =>
          jsonResponse(
            {
              error: {
                message: 'Invalid API key',
                type: 'authentication_error',
              },
              generationId: 'gen_401_prod',
            },
            401,
          ),
        ),
      });

      const ledger = await corroborate({
        witnesses: {
          ok: okOpenai('gpt-4o-mini'),
          gateway: gateway401('openai/gpt-4o-mini'),
        },
        schema: BasicSchema,
        prompt: 'Check production Gateway 401 wrapper',
        maxRetries: 0,
      });

      const wGateway = ledger.witnesses.gateway;
      expect(wGateway.status).toBe('failed');
      if (wGateway.status === 'failed') {
        expect(wGateway.error.kind).toBe('api-error');
        expect(wGateway.error.name).toBe('GatewayError');
        expect(wGateway.error.statusCode).toBeUndefined();
        expect(wGateway.error.isRetryable).toBeUndefined();
      }
      expect(globalFetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

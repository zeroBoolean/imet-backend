import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAiTranslationProvider } from '../src/modules/translation/translation.provider.js';
import { AppError } from '../src/middleware/errorHandler.js';
import type { Language } from '../src/modules/translation/translation.validation.js';
const provider = () =>
  new OpenAiTranslationProvider({
    key: 'fixture-not-a-real-key',
    model: 'gpt-4.1-mini',
    timeout: 1000,
  });
const response = (lines: string[], status = 'completed') =>
  new Response(
    JSON.stringify({
      status,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ lines }) }],
        },
      ],
    }),
    { status: 200 },
  );
const assertSafeFailure = (fn: () => Promise<unknown>, status = 502) =>
  assert.rejects(
    fn,
    (e: unknown) =>
      e instanceof AppError &&
      e.statusCode === status &&
      !e.message.includes('fixture-not-a-real-key') &&
      !e.message.includes('PRIVATE UPSTREAM ERROR'),
  );

test('OpenAI adapter translates all six directions and preserves protected tokens, lines and original text', async (t) => {
  const samples: Record<Language, string> = {
    en: 'CAT 320 excavator with 1.0 m³ bucket capacity and 21.2 ton operating weight.\n\n- Contact ops@example.test or +880 1234-56789 at https://example.test/model-CAT320\n  Power 5 kW  ',
    bn: 'CAT 320 এক্সকাভেটর, 1.0 m³ ধারণক্ষমতা এবং 21.2 ton ওজন।\n\n- যোগাযোগ ops@example.test\n  শক্তি 5 kW  ',
    zh: 'CAT 320 挖掘机，容量 1.0 m³，重量 21.2 ton。\n\n- 联系 ops@example.test\n  功率 5 kW  ',
  };
  const replacement: Record<Language, string> = {
    en: 'Translated industrial content ',
    bn: 'অনূদিত শিল্প সামগ্রী ',
    zh: '翻译工业内容 ',
  };
  for (const [from, to] of [
    ['en', 'bn'],
    ['en', 'zh'],
    ['bn', 'en'],
    ['bn', 'zh'],
    ['zh', 'en'],
    ['zh', 'bn'],
  ] as [Language, Language][]) {
    const original = samples[from];
    let sent = '';
    const mock = t.mock.method(
      globalThis,
      'fetch',
      async (url: unknown, init?: RequestInit) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(init?.redirect, 'error');
        assert.equal(
          new Headers(init?.headers).get('Authorization'),
          'Bearer fixture-not-a-real-key',
        );
        sent = String(init?.body);
        const body = JSON.parse(sent);
        assert.equal(body.store, false);
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.max_output_tokens, 12000);
        assert(body.instructions.includes('untrusted'));
        const lines = JSON.parse(body.input).lines as string[];
        return response(
          lines.map((line) =>
            line
              ? replacement[to] +
                (line.match(/__IMET_[a-f0-9]+_\d+__/g) ?? []).join(' ')
              : '',
          ),
        );
      },
    );
    try {
      const result = await provider().translate(original, from, to);
      assert(result.includes(replacement[to].trim()));
      assert.equal(result.split('\n').length, original.split('\n').length);
      assert.equal(result.split('\n')[1], '');
      assert(result.split('\n')[2].startsWith('- '));
      assert(result.endsWith('  '));
      for (const token of [
        'CAT',
        '320',
        '1.0 m³',
        '21.2 ton',
        'ops@example.test',
        '5 kW',
      ]) {
        assert(result.includes(token), token);
        assert(
          !sent.includes(token),
          `protected token sent to provider: ${token}`,
        );
      }
      assert.equal(samples[from], original);
      assert.equal(mock.mock.callCount(), 1);
    } finally {
      mock.mock.restore();
    }
  }
});
test('same-language and missing-key requests never call OpenAI unnecessarily', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected provider request');
  });
  const absent = new OpenAiTranslationProvider({
    key: undefined,
    model: 'gpt-4.1-mini',
    timeout: 1000,
  });
  assert.equal(absent.isConfigured(), false);
  for (const l of ['en', 'bn', 'zh'] as const)
    assert.equal(
      await absent.translate(' Original\n text ', l, l),
      ' Original\n text ',
    );
  await assertSafeFailure(() => absent.translate('Machine', 'en', 'bn'), 503);
  assert.equal(mock.mock.callCount(), 0);
});
test('upstream rate limits, timeouts, malformed/refused/incomplete/oversized outputs and token changes fail safely', async (t) => {
  const cases = [
    () =>
      new Response('PRIVATE UPSTREAM ERROR fixture-not-a-real-key', {
        status: 429,
      }),
    () =>
      new Response('PRIVATE UPSTREAM ERROR fixture-not-a-real-key', {
        status: 500,
      }),
    () => {
      throw new DOMException('PRIVATE UPSTREAM ERROR', 'TimeoutError');
    },
    () => new Response('{bad-json', { status: 200 }),
    () => response(['anything'], 'incomplete'),
    () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'refusal', refusal: 'no' }] },
          ],
        }),
        { status: 200 },
      ),
    () => response(['CAT 321 invented values']),
    () => response([]),
    () => response(['A'.repeat(400000)]),
  ];
  for (let i = 0; i < cases.length; i++) {
    const mock = t.mock.method(globalThis, 'fetch', async () => cases[i]());
    try {
      await assertSafeFailure(
        () => provider().translate('CAT 320 excavator', 'en', 'bn'),
        i === 0 ? 429 : 502,
      );
    } finally {
      mock.mock.restore();
    }
  }
  const extra = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const line = JSON.parse(JSON.parse(String(init?.body)).input).lines[0];
      return response([line + ' 999']);
    },
  );
  try {
    await assertSafeFailure(() =>
      provider().translate('CAT 320 excavator', 'en', 'bn'),
    );
  } finally {
    extra.mock.restore();
  }
});

test('Bangla digits and Chinese quantity/unit expressions are protected without converting values', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const lines = JSON.parse(body.input).lines as string[];
      assert(!body.input.includes('২১.২ টন'));
      assert(!body.input.includes('二十一吨'));
      return response(
        lines.map(
          (line) =>
            'Translated ' +
            (line.match(/__IMET_[a-f0-9]+_\d+__/g) ?? []).join(' '),
        ),
      );
    },
  );
  for (const [original, source, token] of [
    ['মেশিন ২১.২ টন ওজন', 'bn', '২১.২ টন'],
    ['机器重量二十一吨', 'zh', '二十一吨'],
  ] as [string, Language, string][]) {
    assert(
      (await provider().translate(original, source, 'en')).includes(token),
    );
  }
  assert.equal(mock.mock.callCount(), 2);
});
test('provider request really aborts at the configured timeout', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      }),
  );
  const timed = new OpenAiTranslationProvider({
    key: 'fixture-not-a-real-key',
    model: 'gpt-4.1-mini',
    timeout: 100,
  });
  const started = Date.now();
  await assertSafeFailure(() => timed.translate('Excavator', 'en', 'bn'));
  assert(Date.now() - started < 1500);
  assert.equal(mock.mock.callCount(), 1);
});

test('embedded filenames and internationalized email strings never become translated content', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string;
      assert(!input.includes('manual.pdf'));
      assert(!input.includes('维修@example.test'));
      const lines = JSON.parse(input).lines as string[];
      return response(
        lines.map(
          (line) =>
            '文件 ' + (line.match(/__IMET_[a-f0-9]+_\d+__/g) ?? []).join(' '),
        ),
      );
    },
  );
  const result = await provider().translate(
    'Read manual.pdf and mail 维修@example.test',
    'en',
    'zh',
  );
  assert(result.includes('manual.pdf'));
  assert(result.includes('维修@example.test'));
  assert.equal(mock.mock.callCount(), 1);
});

test('a fluent response in the wrong target script is rejected instead of being published', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () =>
    response(['Excavator for industrial production']),
  );
  await assertSafeFailure(() =>
    provider().translate('Excavator for industrial production', 'en', 'bn'),
  );
  assert.equal(mock.mock.callCount(), 1);
});

test('heading, bullet and simple table structure remains separate from translated words', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const lines = JSON.parse(JSON.parse(String(init?.body)).input)
        .lines as string[];
      return response(
        lines.map((line) =>
          line
            ? 'অনূদিত ' +
              (line.match(/__IMET_[a-f0-9]+_\d+__/g) ?? []).join(' ')
            : '',
        ),
      );
    },
  );
  const original = '# Technical details\n- Capacity 1.0 m³\n| Power | 5 kW |';
  const result = await provider().translate(original, 'en', 'bn');
  assert(result.startsWith('# '));
  assert(result.split('\n')[1].startsWith('- '));
  assert.equal(result.split('\n')[2].split('|').length, 4);
  assert(result.includes('5 kW'));
  assert(result.includes('1.0 m³'));
  assert.equal(mock.mock.callCount(), 1);
});

test('signed values, fractions, scientific notation and tolerance operators are preserved exactly', async (t) => {
  const mock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      const lines = JSON.parse(JSON.parse(String(init?.body)).input)
        .lines as string[];
      return response(
        lines.map(
          (line) =>
            'সহনশীলতা ' +
            (line.match(/__IMET_[a-f0-9]+_\d+__/g) ?? []).join(' '),
        ),
      );
    },
  );
  const source =
    'Tolerance −10 mm ± 2 mm; ratio 1/2; pressure 1.0e-3 bar; length ≤ 20 mm';
  const result = await provider().translate(source, 'en', 'bn');
  for (const token of [
    '−10 mm',
    '±',
    '2 mm',
    '1/2',
    '1.0e-3 bar',
    '≤',
    '20 mm',
  ])
    assert(result.includes(token), token);
  assert.equal(mock.mock.callCount(), 1);
});

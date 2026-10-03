import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.RESEND_API_KEY = 're_test_fixture_not_a_real_key';
process.env.RESEND_FROM_EMAIL = 'fixture@example.test';
const { ResendProvider } =
  await import('../src/emails/providers/resendProvider.js');

test('Resend adapter sends the expected payload/idempotency key and rejects provider errors', async () => {
  const original = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (input, options) => {
    assert.equal(new URL(String(input)).hostname, 'api.resend.com');
    assert.equal(
      new Headers(options?.headers).get('idempotency-key'),
      'fixture-job',
    );
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body.to, ['recipient@example.test']);
    assert.equal(body.from, 'fixture@example.test');
    return new Response(
      JSON.stringify(
        fail
          ? {
              name: 'validation_error',
              message: 'Fixture rejection',
              statusCode: 422,
            }
          : { id: 'fixture-message-id' },
      ),
      {
        status: fail ? 422 : 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  try {
    const provider = new ResendProvider();
    const mail = {
      to: 'recipient@example.test',
      subject: 'Fixture',
      html: '<p>Fixture email</p>',
    };
    assert.deepEqual(await provider.send(mail, 'fixture-job'), {
      id: 'fixture-message-id',
    });
    fail = true;
    await assert.rejects(
      () => provider.send(mail, 'fixture-job'),
      /Transactional email delivery failed/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

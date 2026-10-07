import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.SSLCOMMERZ_STORE_ID = 'sandbox-test-merchant';
process.env.SSLCOMMERZ_STORE_PASSWORD = 'test-credential';
process.env.PAYMENT_CALLBACK_ORIGIN = 'https://api.example.test';
process.env.SSLCOMMERZ_IS_LIVE = 'false';
const { sslcommerz } = await import('../src/modules/payment/sslcommerz.js');
const { config } = await import('../src/config/env.js');
test('gateway transport uses fixed hosts, form credentials, callback URLs and authoritative validation', async () => {
  const actualFetch = globalThis.fetch;
  const original = { ...config };
  const calls: { url: URL; init?: RequestInit }[] = [];
  let result: unknown = {
    status: 'SUCCESS',
    GatewayPageURL: 'https://sandbox.sslcommerz.com/EasyCheckOut/test',
    sessionkey: 'test-session',
  };
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    const body = {
      transactionId: `imet_${'a'.repeat(24)}`,
      amount: '100.00',
      currency: 'BDT',
      product: 'Test plan',
      email: 'test@example.test',
      name: 'Buyer',
      phone: '1234567890',
      address: 'Factory Rd',
      city: 'Dhaka',
      country: 'Bangladesh',
    };
    const checkout = await sslcommerz.initiate(body);
    assert.equal(
      checkout.gatewayUrl,
      'https://sandbox.sslcommerz.com/EasyCheckOut/test',
    );
    assert.equal(
      calls[0].url.href,
      'https://sandbox.sslcommerz.com/gwprocess/v4/api.php',
    );
    const form = calls[0].init?.body;
    assert.ok(form instanceof URLSearchParams);
    assert.equal(form.get('total_amount'), '100.00');
    assert.equal(form.get('tran_id'), body.transactionId);
    assert.equal(
      form.get('store_passwd'),
      process.env.SSLCOMMERZ_STORE_PASSWORD,
    );
    assert.equal(
      form.get('ipn_url'),
      'https://api.example.test/api/v1/payments/ipn',
    );
    assert.equal(calls[0].init?.redirect, 'error');
    assert.ok(calls[0].init?.signal);
    result = {
      status: 'VALIDATED',
      tran_id: body.transactionId,
      val_id: 'validation',
      amount: '100.00',
      currency_type: 'BDT',
      currency_amount: '100.00',
      risk_level: 0,
    };
    assert.equal((await sslcommerz.validate('validation')).risk_level, '0');
    assert.equal(
      calls[1].url.pathname,
      '/validator/api/validationserverAPI.php',
    );
    assert.equal(calls[1].url.searchParams.get('val_id'), 'validation');
    result = {
      APIConnect: 'DONE',
      element: [{ tran_id: body.transactionId, status: 'FAILED' }],
    };
    assert.equal(
      (await sslcommerz.query(body.transactionId))[0].status,
      'FAILED',
    );
    assert.equal(
      calls[2].url.pathname,
      '/validator/api/merchantTransIDvalidationAPI.php',
    );
    for (const url of [
      'http://sandbox.sslcommerz.com/pay',
      'https://attacker.example.test/pay',
      'https://user:pass@sandbox.sslcommerz.com/pay',
    ]) {
      result = {
        status: 'SUCCESS',
        GatewayPageURL: url,
        sessionkey: 'test-session',
      };
      await assert.rejects(sslcommerz.initiate(body));
    }
    config.SSLCOMMERZ_API_BASE_URL = 'https://attacker.example.test';
    const count = calls.length;
    await assert.rejects(sslcommerz.initiate(body));
    assert.equal(calls.length, count);
    delete config.SSLCOMMERZ_API_BASE_URL;
    config.PAYMENT_CALLBACK_ORIGIN = 'http://localhost:5000';
    await assert.rejects(sslcommerz.initiate(body));
    assert.equal(calls.length, count);
    config.PAYMENT_CALLBACK_ORIGIN = original.PAYMENT_CALLBACK_ORIGIN;
    globalThis.fetch = async () => {
      throw new Error('Do not expose test-credential in error');
    };
    await assert.rejects(
      sslcommerz.validate('v'),
      /Gateway verification is temporarily unavailable/,
    );
  } finally {
    globalThis.fetch = actualFetch;
    Object.assign(config, original);
  }
});

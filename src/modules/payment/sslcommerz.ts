import { z } from 'zod';
import { config } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
const scalar = z.union([z.string(), z.number()]).transform(String);
export const validationResponse = z.object({
  status: z.string(),
  tran_id: z.string(),
  val_id: z.string(),
  amount: scalar,
  currency_type: z.string().optional(),
  currency_amount: scalar.optional(),
  currency: z.string().optional(),
  risk_level: scalar,
  bank_tran_id: z.string().max(150).optional(),
});
export type VerifiedOrder = z.infer<typeof validationResponse>;
function settings() {
  if (
    !config.SSLCOMMERZ_STORE_ID ||
    !config.SSLCOMMERZ_STORE_PASSWORD ||
    !config.PAYMENT_CALLBACK_ORIGIN
  )
    throw new AppError(
      'Online activation is not configured. Contact an administrator.',
      503,
    );
  const origin = `https://${config.SSLCOMMERZ_IS_LIVE ? 'securepay' : 'sandbox'}.sslcommerz.com`;
  // Restrict configured overrides: merchant credentials must never be sent to arbitrary hosts.
  for (const override of [
    config.SSLCOMMERZ_API_BASE_URL,
    config.SSLCOMMERZ_VALIDATION_BASE_URL,
  ])
    if (override && new URL(override).origin !== origin)
      throw new AppError('Invalid gateway configuration', 503);
  const callback = new URL(config.PAYMENT_CALLBACK_ORIGIN);
  const frontend = new URL(config.FRONTEND_URL);
  if (
    callback.protocol !== 'https:' ||
    (config.SSLCOMMERZ_IS_LIVE && frontend.protocol !== 'https:')
  )
    throw new AppError('Payment callbacks require HTTPS', 503);
  return {
    origin,
    callback: callback.origin,
    frontend: frontend.origin,
    store_id: config.SSLCOMMERZ_STORE_ID,
    store_passwd: config.SSLCOMMERZ_STORE_PASSWORD,
  };
}
async function request(url: URL, init?: RequestInit): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Gateway HTTP error');
    const body = await response.text();
    if (body.length > 100000) throw new Error('Oversized gateway response');
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError(
      'Gateway verification is temporarily unavailable. Check this payment again before retrying.',
      503,
    );
  }
}
export const sslcommerz = {
  assertConfigured() {
    settings();
  },
  isConfigured() {
    try {
      settings();
      return true;
    } catch {
      return false;
    }
  },
  async initiate(data: {
    transactionId: string;
    amount: string;
    currency: string;
    product: string;
    email: string;
    name: string;
    phone: string;
    address: string;
    city: string;
    country: string;
  }) {
    const s = settings();
    const callback = `${s.callback}/api/v1/payments`;
    const form = new URLSearchParams({
      store_id: s.store_id,
      store_passwd: s.store_passwd,
      total_amount: data.amount,
      currency: data.currency,
      tran_id: data.transactionId,
      success_url: `${callback}/callback/success`,
      fail_url: `${callback}/callback/fail`,
      cancel_url: `${callback}/callback/cancel`,
      ipn_url: `${callback}/ipn`,
      shipping_method: 'NO',
      product_name: data.product,
      product_category: 'Supplier subscription',
      product_profile: 'non-physical-goods',
      cus_name: data.name,
      cus_email: data.email,
      cus_phone: data.phone,
      cus_add1: data.address,
      cus_city: data.city,
      cus_country: data.country,
    });
    const response = z
      .object({
        status: z.string(),
        GatewayPageURL: z.url().optional(),
        sessionkey: z.string().max(200).optional(),
      })
      .parse(
        await request(new URL('/gwprocess/v4/api.php', s.origin), {
          method: 'POST',
          body: form,
        }),
      );
    if (
      response.status !== 'SUCCESS' ||
      !response.GatewayPageURL ||
      !response.sessionkey
    )
      throw new AppError('Gateway did not create a checkout session', 502);
    const checkout = new URL(response.GatewayPageURL);
    const allowed = config.SSLCOMMERZ_IS_LIVE
      ? ['securepay.sslcommerz.com']
      : ['sandbox.sslcommerz.com', 'sandbox-gw.sslcommerz.com'];
    if (
      checkout.protocol !== 'https:' ||
      checkout.username ||
      checkout.password ||
      !allowed.includes(checkout.hostname)
    )
      throw new AppError('Gateway returned an invalid checkout URL', 502);
    return { gatewayUrl: checkout.href, sessionKey: response.sessionkey };
  },
  async validate(validationId: string) {
    const s = settings(),
      url = new URL('/validator/api/validationserverAPI.php', s.origin);
    url.search = new URLSearchParams({
      val_id: validationId,
      store_id: s.store_id,
      store_passwd: s.store_passwd,
      v: '1',
      format: 'json',
    }).toString();
    return validationResponse.parse(await request(url));
  },
  async query(transactionId: string) {
    const s = settings(),
      url = new URL(
        '/validator/api/merchantTransIDvalidationAPI.php',
        s.origin,
      );
    url.search = new URLSearchParams({
      tran_id: transactionId,
      store_id: s.store_id,
      store_passwd: s.store_passwd,
      v: '1',
      format: 'json',
    }).toString();
    return z
      .object({
        APIConnect: z.literal('DONE'),
        element: z
          .array(
            z.object({
              tran_id: z.string(),
              status: z.string(),
              val_id: z.string().optional(),
            }),
          )
          .max(20),
      })
      .parse(await request(url)).element;
  },
};

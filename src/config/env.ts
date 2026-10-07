import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  SSLCOMMERZ_STORE_ID: z.string().min(1).optional(),
  SSLCOMMERZ_STORE_PASSWORD: z.string().min(1).optional(),
  SSLCOMMERZ_IS_LIVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SSLCOMMERZ_API_BASE_URL: z.url().optional(),
  SSLCOMMERZ_VALIDATION_BASE_URL: z.url().optional(),
  SSLCOMMERZ_CURRENCIES: z
    .string()
    .regex(/^[A-Z]{3}(,[A-Z]{3})*$/)
    .default('BDT'),
  PAYMENT_CALLBACK_ORIGIN: z.url().optional(),

  AI_TRANSLATION_API_KEY: z.string().optional(),
  AI_TRANSLATION_MODEL: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]{1,100}$/)
    .default('gpt-4.1-mini'),
  AI_TRANSLATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60000)
    .default(20000),
  AI_TRANSLATION_MAX_CHARACTERS: z.coerce
    .number()
    .int()
    .min(100)
    .max(12000)
    .default(6000),
  AI_TRANSLATION_DAILY_LIMIT: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(50),
  RFQ_EXPIRY_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  RFQ_REMINDER_DAYS: z.coerce.number().int().min(1).max(364).default(2),
  BUNNY_STORAGE_ZONE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  BUNNY_STORAGE_HOST: z
    .enum([
      'storage.bunnycdn.com',
      'sg.storage.bunnycdn.com',
      'ny.storage.bunnycdn.com',
      'la.storage.bunnycdn.com',
      'uk.storage.bunnycdn.com',
      'se.storage.bunnycdn.com',
      'br.storage.bunnycdn.com',
      'jh.storage.bunnycdn.com',
      'syd.storage.bunnycdn.com',
    ])
    .default('storage.bunnycdn.com'),
  BUNNY_STORAGE_ACCESS_KEY: z.string().optional(),
  EMAIL_QUEUE_NAME: z.string().default('imet-email'),
  PUBLIC_SIGNUP_ROLE: z.enum(['BUYER']).optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.email().optional(),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  DATABASE_URL: z
    .string()
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'DATABASE_URL must be a PostgreSQL connection URL',
    ),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
});
const result = schema.safeParse(process.env);
if (!result.success)
  throw new Error(
    `Invalid environment configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
  );
export const config = result.data;
if (config.RFQ_REMINDER_DAYS >= config.RFQ_EXPIRY_DAYS)
  throw new Error('RFQ_REMINDER_DAYS must be less than RFQ_EXPIRY_DAYS');

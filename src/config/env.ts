import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  EMAIL_QUEUE_NAME: z.string().default('imet-email'),
  PUBLIC_SIGNUP_ROLE: z.enum(['BUYER']).optional(),
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

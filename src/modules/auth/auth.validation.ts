import { z } from 'zod';
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128)
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/[0-9]/, 'Include a number');
const email = z.email().trim().toLowerCase().max(254);
export const registerSchema = z.object({
  body: z
    .object({
      displayName: z.string().trim().min(2).max(100),
      email,
      password: passwordSchema,
    })
    .strict(),
});
export const googleSchema = z.object({
  body: z.object({ idToken: z.string().min(50).max(16000) }).strict(),
});
export const loginSchema = z.object({
  body: z.object({ email, password: z.string().min(1).max(128) }).strict(),
});
export const emailSchema = z.object({ body: z.object({ email }).strict() });
export const tokenSchema = z.object({
  body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
});
export const refreshSchema = z.object({
  body: z.object({ refreshToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
});
export const resetSchema = z.object({
  body: z
    .object({
      token: z.string().regex(/^[a-f0-9]{64}$/),
      password: passwordSchema,
      confirmPassword: z.string(),
    })
    .strict()
    .refine((data) => data.password === data.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Passwords must match',
    }),
});
export const changeSchema = z.object({
  body: z
    .object({
      currentPassword: z.string().min(1).max(128),
      password: passwordSchema,
      confirmPassword: z.string(),
    })
    .strict()
    .refine((data) => data.password === data.confirmPassword, {
      path: ['confirmPassword'],
      message: 'Passwords must match',
    }),
});

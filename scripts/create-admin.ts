import 'dotenv/config';
import { z } from 'zod';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { hashPassword } from '../src/utils/hashing.js';
import { passwordSchema } from '../src/modules/auth/auth.validation.js';
const schema = z.object({
  ADMIN_EMAIL: z.email().transform((value) => value.toLowerCase()),
  ADMIN_NAME: z.string().min(2).max(100),
  ADMIN_PASSWORD: passwordSchema,
});
const input = schema.safeParse(process.env);
if (!input.success)
  throw new Error(
    'Provide ADMIN_EMAIL, ADMIN_NAME, and a strong ADMIN_PASSWORD securely',
  );
try {
  await prisma.user.create({
    data: {
      email: input.data.ADMIN_EMAIL,
      displayName: input.data.ADMIN_NAME,
      password: await hashPassword(input.data.ADMIN_PASSWORD),
      status: 'ACTIVE',
      isEmailVerified: true,
      assignedRole: { create: { role: 'ADMIN' } },
    },
  });
  console.info(
    'Administrator created. Remove bootstrap variables from your environment.',
  );
} finally {
  await disconnectDatabase();
}

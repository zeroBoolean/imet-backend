import { randomUUID } from 'node:crypto';
import { getEmailQueue } from './queue.js';
import { config } from '../config/env.js';
import { authEmail } from './templates/authEmail.js';
export const MailService = {
  async sendAuthEmail(
    to: string,
    name: string,
    purpose: 'verify-user' | 'reset-password',
    token: string,
  ) {
    const link = new URL(`/auth/${purpose}`, config.FRONTEND_URL);
    link.searchParams.set('token', token);
    const action =
      purpose === 'verify-user'
        ? 'Verify your email address'
        : 'Reset your password';
    await getEmailQueue().add(
      'authentication',
      {
        to,
        subject: `${action} — iMet Machinery`,
        html: authEmail(name, action, link.toString()),
      },
      { jobId: randomUUID() },
    );
  },
};

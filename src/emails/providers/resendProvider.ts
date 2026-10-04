import { Resend } from 'resend';
import { config } from '../../config/env.js';
import type { EmailJob } from '../queue.js';
export class ResendProvider {
  private client: Resend;
  constructor() {
    if (!config.RESEND_API_KEY || !config.RESEND_FROM_EMAIL)
      throw new Error(
        'RESEND_API_KEY and RESEND_FROM_EMAIL are required for the email worker',
      );
    this.client = new Resend(config.RESEND_API_KEY);
  }
  async send(email: EmailJob, id: string) {
    const { error, data } = await this.client.emails.send(
      {
        subject: email.subject,
        html: email.html,
        from: config.RESEND_FROM_EMAIL!,
        to: [email.to],
      },
      { idempotencyKey: id },
    );
    if (error || !data?.id)
      throw new Error('Transactional email delivery failed');
    return { id: data.id };
  }
}

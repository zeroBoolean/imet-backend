import { escapeHtml } from './escapeHtml.js';
export const serviceEventLabels: Readonly<Record<string, string>> =
  Object.freeze({
    TICKET_CREATED: 'Service request received',
    TICKET_UNDER_REVIEW: 'Service request under review',
    TICKET_ASSIGNED: 'Service party assigned',
    TICKET_IN_PROGRESS: 'Service work started',
    TICKET_RESOLVED: 'Service request resolved',
    TICKET_CLOSED: 'Service request closed',
    WARRANTY_ASSESSED: 'Warranty request assessed',
  });
export function serviceEmail(
  name: string,
  number: string,
  type: string,
  link: string,
) {
  const label = Object.hasOwn(serviceEventLabels, type)
    ? serviceEventLabels[type]
    : undefined;
  if (!label) return null;
  const text = `iMet Machinery\nHello ${name},\n${number} — ${label}\nOpen your service workspace: ${link}\nSign in to read the authorized details. Warranty decisions are manual; this email does not confirm payment or automatic coverage.`;
  return {
    subject: `${number} · ${label} — iMet Machinery`,
    text,
    html: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f5f7f8;font-family:Arial,sans-serif;color:#192b35"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(number)} — ${escapeHtml(label)}</div><main style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border:1px solid #dfe5e8;border-radius:12px"><h1 style="font-size:22px">iMet Machinery</h1><p>Hello ${escapeHtml(name)},</p><p style="font-size:12px;color:#526474">${escapeHtml(number)}</p><h2 style="font-size:20px">${escapeHtml(label)}</h2><p>A service workflow update is available in your account.</p><p><a style="display:inline-block;background:#a64b23;color:#fff;padding:12px 16px;border-radius:6px" href="${escapeHtml(link)}">Open service workspace</a></p><p style="font-size:12px;color:#526474">Sign in to read the authorized details. Warranty decisions are manual; this email does not confirm payment or automatic coverage.</p></main></body></html>`,
  };
}

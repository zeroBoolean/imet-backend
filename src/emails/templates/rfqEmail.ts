import { escapeHtml } from './escapeHtml.js';
export const rfqEmail = (
  name: string,
  number: string,
  title: string,
  event: string,
  link: string,
) =>
  `<html lang="en"><body style="font-family:Arial,sans-serif;color:#192b35"><h1>iMet Machinery</h1><p>Hello ${escapeHtml(name)},</p><h2>${escapeHtml(number)} · ${escapeHtml(event.replaceAll('_', ' ').toLowerCase())}</h2><p>${escapeHtml(title)}</p><p><a href="${escapeHtml(link)}">Open your RFQ workspace</a></p><p>Quotes, messages and contact information are available securely in your account. No payment is processed by this email.</p></body></html>`;

export const rfqEmailText = (
  name: string,
  number: string,
  event: string,
  link: string,
) =>
  `iMet Machinery\nHello ${name},\n${number} — ${event.replaceAll('_', ' ').toLowerCase()}\nOpen your RFQ workspace: ${link}\nQuotes, messages and contact information are available securely in your account. No payment is processed by this email.`;

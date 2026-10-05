import { escapeHtml } from './escapeHtml.js';
export const authEmail = (name: string, action: string, link: string) =>
  `<html lang="en"><body><h1>iMet Machinery</h1><p>Hello ${escapeHtml(name)},</p><p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p><p>This link expires in one hour and can be used once. If you did not request it, ignore this email.</p></body></html>`;

export const authEmailText = (name: string, action: string, link: string) =>
  `iMet Machinery\nHello ${name},\n${action}: ${link}\nThis link expires in one hour and can be used once. If you did not request it, ignore this email.`;

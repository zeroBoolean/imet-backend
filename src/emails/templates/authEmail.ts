const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
export const authEmail = (name: string, action: string, link: string) =>
  `<html lang="en"><body><h1>iMet Machinery</h1><p>Hello ${escapeHtml(name)},</p><p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p><p>This link expires in one hour and can be used once. If you did not request it, ignore this email.</p></body></html>`;

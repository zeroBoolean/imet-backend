import process from 'node:process';
import console from 'node:console';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.resolve(server, '../imet-client');
for (const [root, file, key] of [
  [server, '.env', 'JWT_SECRET'],
  [client, '.env.local', 'NEXTAUTH_SECRET'],
]) {
  const destination = path.join(root, file);
  if (!existsSync(destination))
    copyFileSync(path.join(root, '.env.example'), destination);
  const content = readFileSync(destination, 'utf8');
  const pattern = new RegExp(`^${key}=(.*)$`, 'm');
  const existing = content.match(pattern)?.[1]?.trim();
  // Preserve existing local values and injected bindings; never copy injected credentials to disk.
  if (existing || process.env[key]) continue;
  const line = `${key}=${randomBytes(48).toString('hex')}`;
  const updated = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content}\n${line}\n`;
  writeFileSync(destination, updated, { mode: 0o600 });
}
console.info(
  'Local signing configuration initialized. Existing bindings preserved.',
);

import { catalogueImageService } from './catalogue.images.service.js';
import { disconnectDatabase } from '../../config/database.js';
// Reuses durable asset states and Bunny DELETE; no second queue or storage provider.
let stopped = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopped = true;
  });
while (!stopped) {
  try {
    await catalogueImageService.cleanup();
  } catch {
    console.error('Catalogue image cleanup deferred; retrying');
  }
  for (let second = 0; second < 60 && !stopped; second++)
    await new Promise((resolve) => setTimeout(resolve, 1000));
}
await disconnectDatabase();

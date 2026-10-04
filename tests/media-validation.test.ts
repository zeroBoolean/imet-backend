import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateMedia,
  validateGlb,
  imageDimensions,
} from '../src/modules/media/media.validation.js';
import { glbFixture, panoramaFixture } from './helpers/mediaFixtures.js';
test('M9 accepts embedded standard GLB geometry and a valid 2:1 panorama', async () => {
  assert.equal(validateGlb(glbFixture()).fileType, 'model/gltf-binary');
  assert.equal(
    (await validateMedia(panoramaFixture(), 'VIEW_360')).fileType,
    'image/png',
  );
  assert.deepEqual(imageDimensions(panoramaFixture(), 'image/png'), {
    width: 512,
    height: 256,
  });
});
test('M9 rejects renamed content, oversized uploads, external resources and unsupported model features', async () => {
  for (const input of [
    Buffer.from('<script>bad</script>'),
    Buffer.alloc(25 * 1024 * 1024 + 1),
    glbFixture({
      buffers: [{ byteLength: 36, uri: 'https://private.invalid/file' }],
    }),
    glbFixture({ extensionsRequired: ['KHR_draco_mesh_compression'] }),
    glbFixture({ nodes: [{ mesh: 0, children: [0] }] }),
    glbFixture({
      accessors: [
        { bufferView: 0, componentType: 5126, count: 1000000, type: 'VEC3' },
      ],
    }),
    glbFixture({ bufferViews: [{ buffer: 0, byteLength: 1000 }] }),
  ])
    assert.throws(() => validateGlb(input));
  await assert.rejects(validateMedia(glbFixture(), 'VIEW_360'));
  await assert.rejects(validateMedia(panoramaFixture(512, 512), 'VIEW_360'));
  await assert.rejects(
    validateMedia(Buffer.alloc(10 * 1024 * 1024 + 1), 'VIEW_360'),
  );
  await assert.rejects(
    validateMedia(panoramaFixture().subarray(0, 33), 'VIEW_360'),
  );
  const corrupt = panoramaFixture();
  corrupt[45] ^= 255;
  await assert.rejects(validateMedia(corrupt, 'VIEW_360'));
  assert.throws(() =>
    validateGlb(
      glbFixture({
        images: Array.from({ length: 17 }, () => ({
          bufferView: 0,
          mimeType: 'image/png',
        })),
      }),
    ),
  );
  const truncated = glbFixture().subarray(0, 40);
  assert.throws(() => validateGlb(truncated));
});

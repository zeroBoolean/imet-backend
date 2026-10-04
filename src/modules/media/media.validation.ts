import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../../middleware/errorHandler.js';
export const mediaParams = z.object({ id: z.uuid() });
export const mediaInput = z
  .object({
    type: z.enum(['MODEL_3D', 'VIEW_360']),
    title: z.string().trim().min(1).max(150),
  })
  .strict();
function invalid(message: string): never {
  throw new AppError(message, 422);
}
const integer = (v: unknown, max: number) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const objects = (v: unknown): Record<string, unknown>[] => {
  if (v === undefined) return [];
  if (
    !Array.isArray(v) ||
    v.length > 10000 ||
    v.some((x) => !x || typeof x !== 'object' || Array.isArray(x))
  )
    return invalid('Invalid or excessively complex GLB structure');
  return v as Record<string, unknown>[];
};
export function validateGlb(buffer: Buffer) {
  if (
    buffer.length < 28 ||
    buffer.length > 25 * 1024 * 1024 ||
    buffer.readUInt32LE(0) !== 0x46546c67 ||
    buffer.readUInt32LE(4) !== 2 ||
    buffer.readUInt32LE(8) !== buffer.length
  )
    invalid('Upload a valid GLB 2.0 model no larger than 25 MB');
  const length = buffer.readUInt32LE(12);
  if (
    length % 4 ||
    length < 2 ||
    length > 2 * 1024 * 1024 ||
    20 + length > buffer.length ||
    buffer.readUInt32LE(16) !== 0x4e4f534a
  )
    invalid('Invalid GLB JSON chunk');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(
      buffer.subarray(20, 20 + length).toString('utf8'),
    ) as Record<string, unknown>;
  } catch {
    return invalid('Invalid GLB JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    invalid('Invalid GLB document');
  const stack: unknown[] = [data];
  let entries = 0;
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'number' && !Number.isFinite(v))
      invalid('Model numeric values must be finite');
    if (++entries > 200000) invalid('GLB is too complex');
    if (v && typeof v === 'object')
      for (const [k, child] of Object.entries(v)) {
        if (
          k === 'uri' ||
          k === 'extensions' ||
          k === '__proto__' ||
          k === 'constructor'
        )
          invalid(
            'Use self-contained, uncompressed GLB without external resources or extensions',
          );
        stack.push(child);
      }
  }
  const asset = data.asset as Record<string, unknown> | undefined;
  if (
    !asset ||
    asset.version !== '2.0' ||
    (data.extensionsRequired !== undefined &&
      (!Array.isArray(data.extensionsRequired) ||
        data.extensionsRequired.length))
  )
    invalid('Only standard GLB 2.0 is supported');
  const start = 20 + length;
  if (
    start + 8 > buffer.length ||
    buffer.readUInt32LE(start + 4) !== 0x004e4942 ||
    buffer.readUInt32LE(start) % 4 ||
    start + 8 + buffer.readUInt32LE(start) !== buffer.length
  )
    invalid('GLB must contain exactly one embedded binary chunk');
  const binary = buffer.readUInt32LE(start),
    buffers = objects(data.buffers);
  if (
    buffers.length !== 1 ||
    !integer(buffers[0].byteLength, binary) ||
    binary - Number(buffers[0].byteLength) > 3
  )
    invalid('Invalid GLB embedded buffer');
  const views = objects(data.bufferViews),
    accessors = objects(data.accessors),
    images = objects(data.images);
  for (const v of views) {
    if (
      v.buffer !== 0 ||
      !integer(v.byteLength, binary) ||
      !integer(v.byteOffset ?? 0, binary) ||
      Number(v.byteOffset ?? 0) + Number(v.byteLength) >
        Number(buffers[0].byteLength)
    )
      invalid('GLB buffer view exceeds embedded data');
    if (
      v.byteStride !== undefined &&
      (!integer(v.byteStride, 252) ||
        Number(v.byteStride) < 4 ||
        Number(v.byteStride) % 4)
    )
      invalid('Invalid GLB byte stride');
  }
  let values = 0;
  const dimensions: Record<string, number> = {
      SCALAR: 1,
      VEC2: 2,
      VEC3: 3,
      VEC4: 4,
      MAT2: 4,
      MAT3: 9,
      MAT4: 16,
    },
    sizes: Record<string, number> = {
      5120: 1,
      5121: 1,
      5122: 2,
      5123: 2,
      5125: 4,
      5126: 4,
    };
  for (const a of accessors) {
    if (
      a.sparse !== undefined ||
      !integer(a.bufferView, views.length - 1) ||
      !integer(a.count, 1000000) ||
      !dimensions[String(a.type)] ||
      !sizes[String(a.componentType)] ||
      !integer(a.byteOffset ?? 0, binary)
    )
      invalid('Unsupported or invalid GLB accessor');
    values += Number(a.count) * dimensions[String(a.type)];
    if (values > 12000000) invalid('Model exceeds geometry complexity limit');
    const v = views[Number(a.bufferView)],
      size = dimensions[String(a.type)] * sizes[String(a.componentType)],
      stride = Number(v.byteStride ?? size);
    if (
      stride < size ||
      Number(a.byteOffset ?? 0) +
        (Number(a.count) ? (Number(a.count) - 1) * stride + size : 0) >
        Number(v.byteLength)
    )
      invalid('GLB accessor exceeds its buffer view');
  }
  const meshes = objects(data.meshes),
    nodes = objects(data.nodes),
    scenes = objects(data.scenes),
    textures = objects(data.textures),
    materials = objects(data.materials);
  let primitives = 0;
  for (const mesh of meshes) {
    for (const p of objects(mesh.primitives)) {
      if (++primitives > 1000) invalid('Too many model primitives');
      if (
        !p.attributes ||
        typeof p.attributes !== 'object' ||
        Array.isArray(p.attributes)
      )
        invalid('Invalid model attributes');
      for (const i of Object.values(p.attributes))
        if (!integer(i, accessors.length - 1))
          invalid('Invalid attribute accessor');
      if (
        !integer(
          (p.attributes as Record<string, unknown>).POSITION,
          accessors.length - 1,
        )
      )
        invalid('Model needs position geometry');
      if (p.indices !== undefined && !integer(p.indices, accessors.length - 1))
        invalid('Invalid index accessor');
      if (
        p.material !== undefined &&
        !integer(p.material, materials.length - 1)
      )
        invalid('Invalid material');
      if (p.mode !== undefined && !integer(p.mode, 6))
        invalid('Invalid primitive mode');
      if (p.targets !== undefined) invalid('Morph targets are not supported');
    }
  }
  if (
    !primitives ||
    !nodes.length ||
    !scenes.length ||
    !integer(data.scene ?? 0, scenes.length - 1)
  )
    invalid('GLB needs a scene with model geometry');
  if (objects(data.animations).length || objects(data.skins).length)
    invalid('Upload a static model without animations or skins');
  let traversals = 0;
  const visit = (index: number, path: Set<number>, depth: number) => {
    if (++traversals > 50000 || depth > 100 || path.has(index))
      invalid('Invalid cyclic or deep model hierarchy');
    const n = nodes[index];
    for (const [field, length] of [
      ['matrix', 16],
      ['translation', 3],
      ['rotation', 4],
      ['scale', 3],
    ] as const) {
      const value = n[field];
      if (
        value !== undefined &&
        (!Array.isArray(value) ||
          value.length !== length ||
          value.some((x) => typeof x !== 'number' || !Number.isFinite(x)))
      )
        invalid('Invalid model transform');
    }
    if (n.skin !== undefined) invalid('Skinned models are not supported');
    if (n.mesh !== undefined && !integer(n.mesh, meshes.length - 1))
      invalid('Invalid model mesh reference');
    const next = new Set(path).add(index);
    if (n.children !== undefined) {
      if (!Array.isArray(n.children) || n.children.length > 10000)
        invalid('Invalid model children');
      for (const child of n.children) {
        if (!integer(child, nodes.length - 1))
          invalid('Invalid child reference');
        visit(Number(child), next, depth + 1);
      }
    }
  };
  // Every node is checked, including unreachable ones, and shared subtrees are bounded.
  for (let i = 0; i < nodes.length; i++) visit(i, new Set(), 0);
  for (const s of scenes) {
    if (
      !Array.isArray(s.nodes) ||
      !s.nodes.length ||
      s.nodes.some((i) => !integer(i, nodes.length - 1))
    )
      invalid('Invalid GLB scene roots');
  }
  if (images.length > 16 || textures.length > 32 || materials.length > 256)
    invalid('Model exceeds texture or material limits');
  let texturePixels = 0;
  for (const i of images) {
    if (
      !integer(i.bufferView, views.length - 1) ||
      !['image/png', 'image/jpeg'].includes(String(i.mimeType))
    )
      invalid('Only embedded PNG/JPEG model textures are supported');
    const v = views[Number(i.bufferView)];
    const image = buffer.subarray(
      start + 8 + Number(v.byteOffset ?? 0),
      start + 8 + Number(v.byteOffset ?? 0) + Number(v.byteLength),
    );
    const d = imageDimensions(image, String(i.mimeType));
    texturePixels += d.width * d.height;
    if (
      d.width < 1 ||
      d.height < 1 ||
      d.width > 4096 ||
      d.height > 4096 ||
      texturePixels > 32 * 1024 * 1024
    )
      invalid('Embedded model textures must not exceed 4096 pixels');
  }
  for (const t of textures)
    if (!integer(t.source, images.length - 1))
      invalid('Invalid embedded texture reference');
  return { fileType: 'model/gltf-binary', ext: 'glb' };
}
export function imageDimensions(buffer: Buffer, mime: string) {
  if (mime === 'image/png') {
    if (
      buffer.length < 33 ||
      buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      buffer.toString('ascii', 12, 16) !== 'IHDR' ||
      buffer.readUInt32BE(8) !== 13
    )
      invalid('Invalid PNG image');
    let offset = 8,
      ended = false,
      hasData = false,
      chunks = 0;
    while (offset + 12 <= buffer.length) {
      if (++chunks > 10000) invalid('PNG has too many chunks');
      const length = buffer.readUInt32BE(offset);
      if (length > buffer.length - offset - 12) invalid('Truncated PNG chunk');
      const kind = buffer.toString('ascii', offset + 4, offset + 8);
      if (
        crc32(buffer.subarray(offset + 4, offset + 8 + length)) !==
        buffer.readUInt32BE(offset + 8 + length)
      )
        invalid('Invalid PNG chunk checksum');
      if (kind === 'acTL') invalid('Animated PNG is not supported');
      if (kind === 'IDAT') hasData = true;
      if (kind === 'IEND') {
        if (length !== 0 || offset + 12 !== buffer.length)
          invalid('Invalid PNG end');
        ended = true;
        break;
      }
      offset += length + 12;
    }
    if (!ended || !hasData) invalid('PNG image is incomplete');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (
    buffer.length < 4 ||
    buffer[0] !== 255 ||
    buffer[1] !== 216 ||
    buffer[buffer.length - 2] !== 255 ||
    buffer[buffer.length - 1] !== 217
  )
    invalid('Invalid JPEG image');
  let i = 2;
  while (i + 4 <= buffer.length) {
    if (buffer[i++] !== 255) invalid('Invalid JPEG marker');
    while (buffer[i] === 255) i++;
    const marker = buffer[i++];
    if (marker === 217 || marker === 218) break;
    const size = buffer.readUInt16BE(i);
    if (size < 2 || i + size > buffer.length) invalid('Invalid JPEG segment');
    if ([192, 193, 194].includes(marker)) {
      if (size < 8) invalid('Invalid JPEG dimensions');
      return {
        height: buffer.readUInt16BE(i + 3),
        width: buffer.readUInt16BE(i + 5),
      };
    }
    i += size;
  }
  return invalid('JPEG dimensions could not be read');
}
export async function validateMedia(
  buffer: Buffer,
  type: 'MODEL_3D' | 'VIEW_360',
) {
  if (type === 'MODEL_3D') return validateGlb(buffer);
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    invalid('Panoramas must be no larger than 10 MB');
  const file = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (!file || !['image/png', 'image/jpeg'].includes(file.mime))
    invalid('Upload a JPEG or PNG panorama matching its file content');
  const d = imageDimensions(buffer, file.mime);
  if (
    d.width < 512 ||
    d.height < 256 ||
    d.width !== 2 * d.height ||
    d.width > 8192 ||
    d.height > 4096
  )
    invalid('Use a 2:1 equirectangular panorama, 512×256 to 8192×4096 pixels');
  return {
    fileType: file.mime,
    ext: file.mime === 'image/jpeg' ? 'jpg' : 'png',
  };
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

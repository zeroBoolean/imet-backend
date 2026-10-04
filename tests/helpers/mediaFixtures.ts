import { deflateSync } from 'node:zlib';
export function glbFixture(extra: Record<string, unknown> = {}) {
  const positions = Buffer.alloc(36);
  [-1, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) =>
    positions.writeFloatLE(v, i * 4),
  );
  const data = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [-1, 0, 0],
        max: [1, 1, 0],
      },
    ],
    ...extra,
  };
  const json = Buffer.from(
    JSON.stringify(data).padEnd(
      Math.ceil(Buffer.byteLength(JSON.stringify(data)) / 4) * 4,
      ' ',
    ),
  );
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + positions.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.alloc(8);
  binary.writeUInt32LE(positions.length, 0);
  binary.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, binary, positions]);
}
function crc32(b: Buffer) {
  let c = 0xffffffff;
  for (const v of b) {
    c ^= v;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    head = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([head, name, data, crc]);
}
export function panoramaFixture(width = 512, height = 256) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * (width * 3 + 1) + 1 + x * 3;
      pixels[p] = x % 256;
      pixels[p + 1] = y % 256;
      pixels[p + 2] = 180;
    }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

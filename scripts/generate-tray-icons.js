#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const outputDir = path.join(__dirname, "..", "assets", "tray");
const size = 32;
const icons = {
  idle: [142, 148, 158],
  running: [34, 197, 94],
  approval: [239, 68, 68],
  done: [6, 182, 212],
  error: [245, 158, 11],
  stale: [139, 92, 246]
};

fs.mkdirSync(outputDir, { recursive: true });

for (const [name, color] of Object.entries(icons)) {
  fs.writeFileSync(path.join(outputDir, `tray-${name}.png`), makePng(size, color));
}

function makePng(width, color) {
  const height = width;
  const radius = width * 0.36;
  const center = (width - 1) / 2;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;

  for (let y = 0; y < height; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      const edge = radius - distance;
      const alpha = edge >= 1 ? 255 : edge > 0 ? Math.round(edge * 255) : 0;
      const shade = distance < radius * 0.58 ? 1.12 : 1;
      raw[offset++] = Math.min(255, Math.round(color[0] * shade));
      raw[offset++] = Math.min(255, Math.round(color[1] * shade));
      raw[offset++] = Math.min(255, Math.round(color[2] * shade));
      raw[offset++] = alpha;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

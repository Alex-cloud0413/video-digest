#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const projectRoot = path.resolve(__dirname, "..");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodeRgbaPng(file) {
  const png = fs.readFileSync(file);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Invalid PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error("Expected a non-interlaced 8-bit RGBA PNG");
      }
    } else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const encoded = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
  let inputOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = encoded[inputOffset];
    inputOffset += 1;
    for (let column = 0; column < stride; column += 1) {
      const raw = encoded[inputOffset + column];
      const outputIndex = row * stride + column;
      const left = column >= 4 ? pixels[outputIndex - 4] : 0;
      const above = row > 0 ? pixels[outputIndex - stride] : 0;
      const upperLeft = row > 0 && column >= 4 ? pixels[outputIndex - stride - 4] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paeth(left, above, upperLeft)
                  : null;
      if (predictor === null) throw new Error(`Unsupported PNG filter ${filter}`);
      pixels[outputIndex] = (raw + predictor) & 0xff;
    }
    inputOffset += stride;
  }
  return { width, height, pixels };
}

function encodeRgbaPng({ width, height, pixels }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (stride + 1);
    raw[outputOffset] = 0;
    pixels.copy(raw, outputOffset + 1, row * stride, (row + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const file = path.join(projectRoot, "icons", `icon${size}.png`);
  const image = decodeRgbaPng(file);
  for (let index = 0; index < image.pixels.length; index += 4) {
    const red = image.pixels[index];
    const green = image.pixels[index + 1];
    const blue = image.pixels[index + 2];
    const alpha = image.pixels[index + 3];
    if (alpha && red > green * 1.15 && red > blue * 1.15) {
      image.pixels[index] = 255;
      image.pixels[index + 1] = 0;
      image.pixels[index + 2] = 51;
    }
  }
  fs.writeFileSync(file, encodeRgbaPng(image));
}

process.stdout.write("Recolored extension icons to #FF0033.\n");

/**
 * 测试用的合法图片字节。
 *
 * 服务端现在做**魔数校验**（文件头必须与声明的类型匹配），
 * 所以测试里不能用 `Buffer.from('任意文本')` 冒充图片 ——
 * 那样会被正确地拒绝。
 */

/** 最小合法 JPEG（SOI + EOI 标记） */
export function fakeJpeg(payload = 'x'): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.from(payload),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** 最小合法 PNG（8 字节签名 + IHDR 开头） */
export function fakePng(payload = 'x'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload),
  ]);
}

/** 最小合法 WebP（RIFF....WEBP） */
export function fakeWebp(payload = 'x'): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from(payload),
  ]);
}

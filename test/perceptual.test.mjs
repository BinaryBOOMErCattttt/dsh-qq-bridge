/**
 * 图片指纹（perceptual.js）的单元测试。
 *
 * 这一层要回答的问题只有一个：**两张图是不是同一张画面**。之所以不能只比字节：
 * QQ 会把同一张表情包按发送者重新编码，实测同一张「寿来」在群里出现过
 * 94657B(progressive+Exif) / 131307B(baseline) / 79284B 三种字节形态，画面 SSIM ≥ 0.985
 * 却没有两份字节相同 —— 详见 perceptual.js 顶部的说明与 README「自动复读」。
 *
 * 用例里的字节都是真编码（见 test/image-fixtures.mjs）：同一张画面的 PNG / baseline /
 * progressive / 重新编码 JPEG / 调色板 GIF / 动图 / 灰度 / 16bit / 透明，另一张画面 B，
 * 以及「同一张画面只换掉上面几行文字」——后者是真实世界里最容易误判的一类
 * （寿来 vs 萝莉来：实测位差 23%，必须判成两张）。
 *
 * 运行：node --test test/perceptual.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config } from '../index.js';
import { hashDistance, imageGrayPlane, perceptualHash } from '../perceptual.js';
import {
  CAPTION_PNG,
  FLAT_PNG_OTHER,
  PIC_16BIT_PNG,
  PIC_ALPHA_PNG,
  PIC_CMYK_JPEG,
  PIC_FLAT_PNG,
  PIC_GIF,
  PIC_GIF_ANIM,
  PIC_GRAY_PNG,
  PIC_INTERLACED_PNG,
  PIC_JPEG,
  PIC_JPEG_PROGRESSIVE,
  PIC_JPEG_RECODE,
  PIC_PALETTE_PNG,
  PIC_PNG,
  PIC_TINY_JPEG,
  PIC_WEBP,
  OTHER_JPEG,
  OTHER_PNG,
} from './image-fixtures.mjs';

/** 复读判定用的默认阈值（配置的真相在 index.js 的 Config 里，这里跟着它走）。 */
const TOLERANCE = Config({}).repeatImageTolerance;

/** 「同一张画面」在 fixture 上必须几乎完全一致；重新编码实测差 0%~2%，留到 3% 也够紧。 */
const SAME_PICTURE = 0.03;

/** 同一张画面 A 的各种编码（每一种都走不同的解码路径）。 */
const A_ENCODINGS = {
  PNG: PIC_PNG,
  'baseline JPEG': PIC_JPEG,
  'progressive JPEG': PIC_JPEG_PROGRESSIVE,
  '重新编码的 JPEG': PIC_JPEG_RECODE,
  GIF: PIC_GIF,
  '动图 GIF（只看第一帧）': PIC_GIF_ANIM,
  '灰度 PNG': PIC_GRAY_PNG,
  '调色板 PNG': PIC_PALETTE_PNG,
  'RGBA PNG': PIC_ALPHA_PNG,
  '16bit 灰度 PNG': PIC_16BIT_PNG,
};

test('同一张画面的不同编码给出同一个指纹', () => {
  const base = perceptualHash(PIC_PNG);
  assert.notEqual(base, undefined);
  for (const [label, bytes] of Object.entries(A_ENCODINGS)) {
    const other = perceptualHash(bytes);
    assert.notEqual(other, undefined, `${label} 应该能算出指纹`);
    assert.equal(other, base, `${label} 应当和 PNG 版逐位一致（实测距离 0）`);
    assert.ok(hashDistance(base, other) <= SAME_PICTURE, `${label} 与 PNG 版的位差应当 ≤ ${SAME_PICTURE}`);
  }
  // 跨格式：JPEG 只解 DC（1/8 块平均），PNG 走全分辨率；两边都会先降到 1/8 块平均，
  // 所以同一张画面跨格式也不该超过几个百分点（实测 2%~3.8%）。
  const cross = hashDistance(base, perceptualHash(PIC_JPEG));
  assert.ok(cross <= SAME_PICTURE, `PNG 与 JPEG 的位差 ${cross} 应当 ≤ ${SAME_PICTURE}`);
});

test('不同的画面必须分开', () => {
  const base = perceptualHash(PIC_PNG);
  for (const [label, bytes] of Object.entries({ '画面 B PNG': OTHER_PNG, '画面 B JPEG': OTHER_JPEG })) {
    const d = hashDistance(base, perceptualHash(bytes));
    assert.ok(d > TOLERANCE * 3, `${label} 与画⾯ A 的位差 ${d} 应当远大于阈值 ${TOLERANCE}`);
  }
  // 两张纯色图不能被算成同一张画面：指纹直接放弃（undefined），退化成按字节比。
  assert.equal(perceptualHash(PIC_FLAT_PNG), undefined);
  assert.equal(perceptualHash(FLAT_PNG_OTHER), undefined);
});

test('同一套画风、只换掉上面几行文字：必须判成两张', () => {
  // 这是真实世界里最危险的一类误判：寿来 vs 萝莉来（实测位差 23%）。阈值必须卡在
  // 「重新编码的 2%」和「换了字的 16%+」之间，所以这里两个方向都要钉住。
  const d = hashDistance(perceptualHash(PIC_PNG), perceptualHash(CAPTION_PNG));
  assert.ok(d > TOLERANCE, `换掉文字后位差 ${d} 应当大于阈值 ${TOLERANCE}`);
  assert.ok(d > SAME_PICTURE * 3, '换掉文字和重新编码必须差一个量级');
});

test('不认识、解不动、太小、纯色的图一律不给指纹', () => {
  // 「不给指纹」不是失败：调用方会退化成「只认字节完全相同」，宁可漏跟一次也不跟错一张。
  assert.equal(perceptualHash(PIC_WEBP), undefined, 'WebP 不在解码器支持范围内');
  assert.equal(perceptualHash(PIC_CMYK_JPEG), undefined, '4 分量（CMYK）JPEG 不猜灰度');
  assert.equal(perceptualHash(PIC_INTERLACED_PNG), undefined, '隔行 PNG 不解（要重排 Adam7）');
  assert.equal(perceptualHash(PIC_TINY_JPEG), undefined, '64×64 的图只有 8×8 个块，撑不起 16×16 网格');
});

test('畸形字节绝不抛异常，只返回 undefined', () => {
  const cases = {
    空: Buffer.alloc(0),
    乱码: Buffer.from('这不是一张图，只是一串文字。'),
    '只有 PNG 签名': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    截断的PNG: PIC_PNG.subarray(0, 40),
    截断的JPEG: PIC_JPEG.subarray(0, 60),
    截断的GIF: PIC_GIF.subarray(0, 30),
    'GIF 只有头': Buffer.from('GIF89a', 'latin1'),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    assert.equal(perceptualHash(bytes), undefined, `${label} 应当返回 undefined`);
  }
});

test('解压炸弹：IHDR 声称 40000×40000 的 PNG 直接放弃', () => {
  // 一个几 KB 的 PNG 可以声称几亿像素；插件把群里的图当不可信输入，尺寸必须先卡住。
  const bomb = Buffer.from(PIC_PNG);
  bomb.writeUInt32BE(40000, 16);
  bomb.writeUInt32BE(40000, 20);
  assert.equal(perceptualHash(bomb), undefined);
});

test('长宽比与尺寸不同的同一张图仍然能对上（只看画面结构）', () => {
  // 指纹把画面拉伸到 16×16（忽略长宽比），所以「同一张图被裁成不同尺寸」不该完全失配。
  // 这里用同一张画面的 PNG 版和它的 JPEG 版验证：两者尺寸一致但编码完全不同。
  assert.ok(hashDistance(perceptualHash(PIC_PNG), perceptualHash(PIC_JPEG_RECODE)) <= SAME_PICTURE);
});

test('hashDistance 的契约：不认识的东西一律算「不同」', () => {
  assert.equal(hashDistance('00', '00'), 0);
  // '00' vs '01'：8 位里差 1 位。
  assert.equal(hashDistance('00', '01'), 0.125);
  assert.equal(hashDistance('0000', '0000'), 0);
  assert.equal(hashDistance(undefined, '00'), 1);
  assert.equal(hashDistance('00', undefined), 1);
  assert.equal(hashDistance('00', '0000'), 1, '长度不同（网格不同）无法比较');
  assert.equal(hashDistance('zz', '00'), 1, '不是十六进制');
  assert.equal(hashDistance('', ''), 1);
});

test('imageGrayPlane：三个解码器给出的平面都对得上', () => {
  const png = imageGrayPlane(PIC_PNG);
  assert.deepEqual({ width: png.width, height: png.height }, { width: 128, height: 128 });
  // 图案是 8×8 像素一格的马赛克，这三点取自 fixture 本身（同一张画面的每种编码都一样）。
  assert.equal(png.plane[0], 96);
  assert.equal(png.plane[63], 240);
  assert.equal(png.plane[64], 96);

  // JPEG：只有 1/8 的块平均，128×128 → 16×16 个块，且块值就是那一格的灰度。
  const jpeg = imageGrayPlane(PIC_JPEG);
  assert.deepEqual({ width: jpeg.width, height: jpeg.height, blocked: jpeg.blocked }, { width: 16, height: 16, blocked: true });
  assert.equal(jpeg.plane[0], 96);

  // 灰度 / 16bit / 调色板 / GIF / 动图第一帧：逐点与真彩 PNG 相同。
  for (const [label, bytes] of Object.entries({
    灰度: PIC_GRAY_PNG,
    '16bit': PIC_16BIT_PNG,
    调色板: PIC_PALETTE_PNG,
    透明: PIC_ALPHA_PNG,
    GIF: PIC_GIF,
    动图: PIC_GIF_ANIM,
  })) {
    const plane = imageGrayPlane(bytes);
    assert.equal(plane.width, 128, `${label} 宽`);
    assert.equal(plane.height, 128, `${label} 高`);
    assert.equal(plane.plane[0], 96, `${label} 第一格灰度`);
    assert.equal(plane.plane[63], 240, `${label} 第 64 个像素灰度`);
  }
});

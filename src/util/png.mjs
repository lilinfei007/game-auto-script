/**
 * 极简 PNG 解码器（零依赖，只用 node:zlib）。
 *
 * 存在意义：本项目需要在**看不到图**的环境下判断截图内容 ——
 * 例如「这张图是黑屏还是游戏画面」「两次截图有没有变化」。
 * 支持 8 位、非隔行的灰度/RGB/RGBA（MaaFramework 截图即为此类）。
 */
import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG。
 * @returns {{width:number, height:number, channels:number, colorType:number, data:Buffer}}
 */
export function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('不是 PNG 文件');
  }

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) break;

    if (type === 'IHDR') {
      header = {
        width: buf.readUInt32BE(dataStart),
        height: buf.readUInt32BE(dataStart + 4),
        bitDepth: buf[dataStart + 8],
        colorType: buf[dataStart + 9],
        compression: buf[dataStart + 10],
        filter: buf[dataStart + 11],
        interlace: buf[dataStart + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // 跳过 CRC
  }

  if (!header) throw new Error('缺少 IHDR');
  if (header.bitDepth !== 8) throw new Error(`暂不支持 ${header.bitDepth} 位深`);
  if (header.interlace !== 0) throw new Error('暂不支持隔行 PNG');
  const channels = CHANNELS[header.colorType];
  if (!channels) throw new Error(`暂不支持颜色类型 ${header.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;

    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];

      switch (filterType) {
        case 0:
          cur[x] = v;
          break;
        case 1:
          cur[x] = (v + a) & 0xff;
          break;
        case 2:
          cur[x] = (v + b) & 0xff;
          break;
        case 3:
          cur[x] = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          cur[x] = (v + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`未知的过滤器类型 ${filterType}（第 ${y} 行）`);
      }
    }
  }

  return { width, height, channels, colorType: header.colorType, data: out };
}

/**
 * 统计图像特征，用于在看不到图时判断内容。
 * @returns {{width,height,mean:[r,g,b],std:number,uniqueRatio:number,isBlank:boolean,verdict:string}}
 */
export function imageStats(buf) {
  const img = decodePng(buf);
  const { width, height, channels, data } = img;
  const total = width * height;

  let sr = 0;
  let sg = 0;
  let sb = 0;
  let s2 = 0;
  const seen = new Set();

  // 按步长采样，避免大图统计过慢
  const step = Math.max(1, Math.floor(Math.sqrt(total / 40000)));

  let count = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = channels >= 3 ? data[i + 1] : r;
      const b = channels >= 3 ? data[i + 2] : r;
      sr += r;
      sg += g;
      sb += b;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      s2 += lum * lum;
      seen.add((r << 16) | (g << 8) | b);
      count++;
    }
  }

  const mean = [sr / count, sg / count, sb / count];
  const meanLum = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2];
  const std = Math.sqrt(Math.max(0, s2 / count - meanLum * meanLum));
  const uniqueRatio = seen.size / count;

  const isBlank = std < 3 || uniqueRatio < 0.005;
  let verdict;
  if (isBlank && meanLum < 12) verdict = '几乎纯黑 —— 很可能没有画面输出';
  else if (isBlank) verdict = '近乎纯色 —— 可能卡在加载/纯色页面';
  else if (std < 15) verdict = '对比度偏低 —— 可能是暗色界面或加载页';
  else verdict = '有明确画面内容';

  return {
    width,
    height,
    mean: mean.map((v) => Math.round(v)),
    std: Number(std.toFixed(1)),
    uniqueRatio: Number(uniqueRatio.toFixed(4)),
    isBlank,
    verdict,
  };
}

/** 逐像素比较两张同尺寸 PNG，返回差异比例（0~1）。 */
export function diffRatio(bufA, bufB) {
  const a = decodePng(bufA);
  const b = decodePng(bufB);
  if (a.width !== b.width || a.height !== b.height) return 1;

  const len = Math.min(a.data.length, b.data.length);
  let diff = 0;
  let count = 0;
  const step = a.channels * Math.max(1, Math.floor(Math.sqrt((a.width * a.height) / 40000)));
  for (let i = 0; i + a.channels <= len; i += step) {
    count++;
    if (Math.abs(a.data[i] - b.data[i]) > 8) diff++;
  }
  return count ? diff / count : 0;
}

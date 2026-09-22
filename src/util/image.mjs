/**
 * 图像工具：落盘与尺寸解析。
 * maa-node 的 ImageData 就是 ArrayBuffer（通常为 PNG 编码）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 把截图数据写入文件，自动建目录。 */
export function saveImage(imageData, filePath) {
  if (!imageData) throw new Error('saveImage: imageData 为空');
  const buf = Buffer.isBuffer(imageData) ? imageData : Buffer.from(imageData);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
  return { path: filePath, bytes: buf.length };
}

/** 从 PNG / JPEG 头部解析尺寸；无法识别返回 null。 */
export function readImageSize(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) {
        return {
          format: 'jpeg',
          height: buf.readUInt16BE(i + 5),
          width: buf.readUInt16BE(i + 7),
        };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** 短边长度（用于校验 720 归一是否生效）。 */
export function shortSide(size) {
  return size ? Math.min(size.width, size.height) : null;
}

/**
 * 自定义识别器（进程内注册，不使用 AgentServer socket）。
 *
 * 注册在 Resource 上，由 MaaFramework 在同一进程内直接回调 —— 因此没有 socket、
 * 没有连接超时、没有跨进程版本错配（上一版 MAA-WJDR 的 agent 就死在 5s 超时上）。
 *
 * 回调契约（v5.13.1 types.d.ts）：
 *   CustomRecognitionCallback = (self) => [out_box: Rect, out_detail: string] | null
 *   self = { context, id, task, name, param, image, roi }
 *   Rect = [x, y, width, height]
 */
import { recoObject } from '../util/detail.mjs';

/** 运行一次内置识别（直接调用，不经过 pipeline 节点）。返回 RecoDetail。 */
async function recoDirect(self, type, param) {
  return self.context.run_recognition_direct(type, param, self.image);
}

/**
 * wjdr_read_count —— 读一个数字（剩余次数 / 资源量 / 费用）。
 * param: { roi?: Rect, expected?: string(正则), pattern?: string(取值正则), fallback?: number }
 * 返回 detail 为解析出的数值字符串；解析不到返回原文本。
 */
async function readCount(self, logger) {
  const param = self.param ?? {};
  const det = await recoDirect(self, 'OCR', {
    roi: param.roi ?? self.roi,
    expected: param.expected ?? '\\d+',
  });
  const best = recoObject(det).best;
  if (!best) {
    logger.debug(`wjdr_read_count: 未识别到内容 (roi=${JSON.stringify(param.roi ?? self.roi)})`);
    return null;
  }

  const text = String(best.text ?? '');
  const m = text.match(param.pattern ? new RegExp(param.pattern) : /-?\d+/);
  const value = m ? Number(m[0]) : null;
  const detail = value !== null ? String(value) : text;
  logger.debug(`wjdr_read_count: "${text}" -> ${detail}`);
  return [best.box, detail];
}

/**
 * wjdr_find_march_slot —— 在给定区域内找出可用的目标（如空闲行军队列）。
 * param: { template: string, roi?: Rect, threshold?: number, pick?: 'top'|'left'|'first' }
 * 返回 detail 为命中数量。
 */
async function findMarchSlot(self, logger) {
  const param = self.param ?? {};
  if (!param.template) throw new Error('wjdr_find_march_slot 需要 param.template');

  const det = await recoDirect(self, 'TemplateMatch', {
    template: param.template,
    roi: param.roi ?? self.roi,
    threshold: param.threshold ?? 0.8,
  });
  const { all } = recoObject(det);
  if (all.length === 0) {
    logger.debug(`wjdr_find_march_slot: 未匹配到 ${param.template}`);
    return null;
  }

  const pick = param.pick ?? 'top';
  const sorted = [...all].sort((a, b) => {
    if (pick === 'left') return a.box[0] - b.box[0] || a.box[1] - b.box[1];
    if (pick === 'first') return 0;
    return a.box[1] - b.box[1] || a.box[0] - b.box[0];
  });
  const chosen = sorted[0];
  logger.debug(
    `wjdr_find_march_slot: 命中 ${all.length} 个，选 ${JSON.stringify(chosen.box)}（pick=${pick}）`,
  );
  return [chosen.box, String(all.length)];
}

/**
 * wjdr_visible —— 判断若干候选是否可见，返回第一个命中的框。
 * param: { templates?: string[], ocr?: string[], roi?: Rect, threshold?: number }
 * 供自定义动作做条件分支用（比在 pipeline 里写一堆 Or 节点更灵活）。
 */
async function visible(self, logger) {
  const param = self.param ?? {};
  const roi = param.roi ?? self.roi;
  const threshold = param.threshold ?? 0.8;

  for (const template of param.templates ?? []) {
    const det = await recoDirect(self, 'TemplateMatch', { template, roi, threshold });
    const best = recoObject(det).best;
    if (best) {
      logger.debug(`wjdr_visible: 命中模板 ${template} @ ${JSON.stringify(best.box)}`);
      return [best.box, template];
    }
  }
  for (const expected of param.ocr ?? []) {
    const det = await recoDirect(self, 'OCR', { roi, expected });
    const best = recoObject(det).best;
    if (best) {
      logger.debug(`wjdr_visible: 命中文本 "${best.text}" (期望 ${expected})`);
      return [best.box, String(best.text ?? expected)];
    }
  }

  logger.debug('wjdr_visible: 全部候选均未命中');
  return null;
}

export function registerRecognitions(resource, logger) {
  resource.register_custom_recognition('wjdr_read_count', (self) => readCount(self, logger));
  resource.register_custom_recognition('wjdr_find_march_slot', (self) =>
    findMarchSlot(self, logger),
  );
  resource.register_custom_recognition('wjdr_visible', (self) => visible(self, logger));
  logger.info('已注册自定义识别：wjdr_read_count, wjdr_find_march_slot, wjdr_visible');
}

/**
 * 自定义动作（进程内注册）。
 *
 * 回调契约（v5.13.1 types.d.ts）：
 *   CustomActionCallback = (self) => boolean
 *   self = { context, id, task, name, param, recoId, box }
 *
 * ⚠️ 自定义**动作**的 self 里**没有 image**（只有自定义**识别**才有）。
 * 早先这里误用 `self.image`，取到 undefined 传给 run_recognition_direct，
 * 回调瞬间抛错、被框架吞成 `false`，表现为「动作 3ms 就返回失败」。
 * 所以动作里要自己截一张图：见 grabImage()。
 *
 * 点击/按键一律走 controller 的明确 API（post_click / post_click_key），
 * 避免 run_action_direct 的参数 schema 歧义。
 */
import { bestOf } from '../util/detail.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function controllerOf(self) {
  const ctrl = self.context.tasker?.controller;
  if (!ctrl) throw new Error('自定义动作拿不到 controller');
  return ctrl;
}

/** 现场截一张图（自定义动作没有 self.image，必须自己截）。 */
async function grabImage(self) {
  const job = controllerOf(self).post_screencap().wait();
  if (!(await job.succeeded)) throw new Error('自定义动作内截图失败');
  return job.get();
}

async function clickPoint(self, x, y) {
  await controllerOf(self).post_click(Math.round(x), Math.round(y)).wait();
}

async function pressBack(self) {
  await controllerOf(self).post_click_key(4).wait(); // KEYCODE_BACK
}

/** 取 Rect 中心点。 */
function center(box) {
  return [box[0] + box[2] / 2, box[1] + box[3] / 2];
}

/**
 * wjdr_pick_upgrade_target —— 在若干候选里挑「最便宜/最省时」的一项并点击。
 * param: {
 *   candidates: [{ name: string, roi: Rect }],
 *   metric?: 'cost' | 'time',     // 仅用于日志
 *   expected?: string,            // OCR 正则，默认 \d+
 *   skipIfEmpty?: boolean
 * }
 * 返回 true 表示已点击某项。
 */
async function pickUpgradeTarget(self, logger) {
  const param = self.param ?? {};
  const candidates = param.candidates ?? [];
  if (candidates.length === 0) {
    logger.warn('wjdr_pick_upgrade_target: candidates 为空，跳过');
    return false;
  }

  const image = await grabImage(self);
  let best = null;
  for (const cand of candidates) {
    const det = await self.context.run_recognition_direct(
      'OCR',
      { roi: cand.roi, expected: param.expected ?? '\\d+' },
      image,
    );
    const entry = bestOf(det);
    const text = String(entry?.text ?? '');
    const num = text.match(/-?\d+/);
    const value = num ? Number(num[0]) : Number.POSITIVE_INFINITY;

    logger.debug(`  候选 ${cand.name}: "${text}" -> ${Number.isFinite(value) ? value : '无法解析'}`);
    if (best === null || value < best.value) best = { cand, value, box: entry?.box ?? cand.roi };
  }

  if (!best || !Number.isFinite(best.value)) {
    logger.info(`wjdr_pick_upgrade_target: 没有可解析的候选（metric=${param.metric ?? 'cost'}），跳过`);
    return false;
  }

  const [x, y] = center(best.box);
  logger.info(`wjdr_pick_upgrade_target: 选 ${best.cand.name}（${param.metric ?? 'cost'}=${best.value}）点击 (${x},${y})`);
  await clickPoint(self, x, y);
  return true;
}

/**
 * 城市主界面的判定基准（720 短边归一后实测）。
 *
 * ⚠️ 必须用「野外」而不是「探险|英雄|背包|商店|联盟」那一整排：
 * 世界地图（点野外之后）的底部导航是「探险 英雄 背包 商店 联盟 **城镇**」，
 * 前五个一模一样，用它们判会把世界地图误当成主界面，导致守卫提前返回。
 * 只有「野外 ↔ 城镇」这一格能区分两者。
 */
const HOME_ROI = [595, 1225, 125, 55];
const HOME_OCR = ['^野外$'];
/** 世界地图上「野外」那一格会变成「城镇」，点它才能回城。 */
const WORLD_MAP_OCR = ['^城镇$'];

/** 在 roi 内按顺序尝试若干 OCR 正则，返回命中的框；未命中返回 null。 */
async function findText(self, image, roi, patterns) {
  for (const expected of patterns) {
    const det = await self.context.run_recognition_direct('OCR', { roi, expected }, image);
    const entry = bestOf(det);
    if (entry) return entry.box;
  }
  return null;
}

/**
 * wjdr_ensure_home —— 界面守卫：反复操作，直到命中「主界面标记」。
 *
 * 三种情况分开处理：
 *   1. 已在主界面      → 直接成功
 *   2. 在世界地图      → 点「城镇」回城（**按返回键在世界地图上不起作用**）
 *   3. 其它任意界面    → 按返回键退一层
 *
 * param: { templates?: string[], ocr?: string[], roi?: Rect, maxAttempts?: number, intervalMs?: number }
 */
async function ensureHome(self, logger) {
  const param = self.param ?? {};
  const maxAttempts = param.maxAttempts ?? 6;
  const intervalMs = param.intervalMs ?? 800;
  const roi = param.roi ?? HOME_ROI;
  const patterns = param.ocr ?? HOME_OCR;

  for (let i = 0; i < maxAttempts; i++) {
    // 每次尝试都重新截图：操作之后画面会变
    const image = await grabImage(self);
    const nth = i + 1;

    for (const template of param.templates ?? []) {
      const det = await self.context.run_recognition_direct(
        'TemplateMatch',
        { template, roi, threshold: param.threshold ?? 0.8 },
        image,
      );
      if (bestOf(det)) {
        logger.debug(`wjdr_ensure_home: 第 ${nth} 次命中模板 ${template}，已在主界面`);
        return true;
      }
    }

    if (await findText(self, image, roi, patterns)) {
      logger.debug(`wjdr_ensure_home: 第 ${nth} 次命中主界面标记，已在主界面`);
      return true;
    }

    const mapBox = await findText(self, image, roi, WORLD_MAP_OCR);
    if (mapBox) {
      const [x, y] = center(mapBox);
      logger.debug(`wjdr_ensure_home: 第 ${nth} 次检测到世界地图，点击「城镇」(${x},${y}) 回城`);
      await clickPoint(self, x, y);
      await sleep(intervalMs);
      continue;
    }

    logger.debug(`wjdr_ensure_home: 第 ${nth} 次未命中，按返回`);
    await pressBack(self);
    await sleep(intervalMs);
  }

  logger.warn(`wjdr_ensure_home: ${maxAttempts} 次仍未回到主界面`);
  return false;
}

/**
 * wjdr_dismiss_popup —— 关闭意外弹窗。
 * param: { templates: string[], roi?: Rect, threshold?: number, keycode?: number }
 * 依次尝试关闭按钮模板；都未命中且给了 keycode 则按一次键。
 */
async function dismissPopup(self, logger) {
  const param = self.param ?? {};
  const roi = param.roi ?? [0, 0, 0, 0];

  const image = await grabImage(self);
  for (const template of param.templates ?? []) {
    const det = await self.context.run_recognition_direct(
      'TemplateMatch',
      { template, roi, threshold: param.threshold ?? 0.8 },
      image,
    );
    const best = bestOf(det);
    if (best) {
      const [x, y] = center(best.box);
      logger.info(`wjdr_dismiss_popup: 命中 ${template}，点击关闭 (${x},${y})`);
      await clickPoint(self, x, y);
      return true;
    }
  }

  if (param.keycode !== undefined) {
    logger.info(`wjdr_dismiss_popup: 未命中任何关闭按钮，发送 keycode=${param.keycode}`);
    await controllerOf(self).post_click_key(param.keycode).wait();
    return true;
  }

  logger.debug('wjdr_dismiss_popup: 无需处理');
  return false;
}

/**
 * wjdr_tap_center —— 点击识别结果框中心（把「识别 → 点击」合并成一步）。
 * param: { offsetX?: number, offsetY?: number }
 * 使用上游识别结果的 box。
 */
async function tapCenter(self, logger) {
  const param = self.param ?? {};
  const box = self.box;
  if (!box || box[2] <= 0 || box[3] <= 0) {
    logger.warn(`wjdr_tap_center: 上游识别框无效 ${JSON.stringify(box)}`);
    return false;
  }
  const [x, y] = center(box);
  const tx = x + (param.offsetX ?? 0);
  const ty = y + (param.offsetY ?? 0);
  logger.debug(`wjdr_tap_center: 点击 (${tx},${ty})，来源框 ${JSON.stringify(box)}`);
  await clickPoint(self, tx, ty);
  return true;
}

/** 已注册的自定义动作名（供界面提示「名字拼错了」，见 reco.mjs 同名导出）。 */
export const CUSTOM_ACTIONS = [
  'wjdr_pick_upgrade_target',
  'wjdr_ensure_home',
  'wjdr_dismiss_popup',
  'wjdr_tap_center',
];

export function registerActions(resource, logger) {
  resource.register_custom_action('wjdr_pick_upgrade_target', (self) =>
    pickUpgradeTarget(self, logger),
  );
  resource.register_custom_action('wjdr_ensure_home', (self) => ensureHome(self, logger));
  resource.register_custom_action('wjdr_dismiss_popup', (self) => dismissPopup(self, logger));
  resource.register_custom_action('wjdr_tap_center', (self) => tapCenter(self, logger));
  logger.info(`已注册自定义动作：${CUSTOM_ACTIONS.join(', ')}`);
}

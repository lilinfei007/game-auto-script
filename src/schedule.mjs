/**
 * 极简 cron 解析与调度器。
 *
 * 为什么自己写：项目运行时零新增依赖（`dependencies` 只有 maa-node），
 * 而标准 5 段 cron 的解析只要几十行、还能完整单测。不支持 `L`/`W`/`#`
 * 这类扩展语法 —— 本项目只需要「每天几点」「每 N 小时」这类固定节奏。
 *
 * 时间一律按**本地时区**解释（`timezone` 只支持 `'local'`），
 * 因为使用者关心的就是他自己机器上的钟点。
 */
import fs from 'node:fs';
import path from 'node:path';

import { PATHS } from './config.mjs';
import { createLogger } from './util/log.mjs';

/** 各字段的取值范围（5 段：分 时 日 月 周）。 */
const FIELDS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '星期', min: 0, max: 7 }, // 0 与 7 都表示周日
];

/** 常见写法的别名，让界面上的报错更容易看懂。 */
export const CRON_EXAMPLES = [
  { expr: '0 8 * * *', text: '每天 08:00' },
  { expr: '30 7 * * 1-5', text: '工作日 07:30' },
  { expr: '0 */6 * * *', text: '每 6 小时' },
  { expr: '0 12,20 * * *', text: '每天 12:00 与 20:00' },
];

/**
 * 展开一个字段为「允许值的集合」。
 * 支持 `*`、单值、范围（a-b）、带步长（步长用斜杠分隔）、逗号列表。
 * 注意：文档注释里不要出现「星号 + 斜杠」这个组合，它会提前闭合块注释。
 */
function expandField(spec, field) {
  const out = new Set();
  const parts = String(spec).split(',');
  if (parts.some((p) => p === '')) return { ok: false, error: `${field.name}字段里有空项` };

  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return { ok: false, error: `${field.name}的步长非法：${part}` };
      step = Number(stepPart);
      if (step < 1) return { ok: false, error: `${field.name}的步长必须 >= 1：${part}` };
    }

    let lo;
    let hi;
    if (rangePart === '*') {
      lo = field.min;
      hi = field.max;
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = stepPart !== undefined ? field.max : lo;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      return { ok: false, error: `${field.name}字段无法解析：${part}` };
    }

    if (lo < field.min || hi > field.max || lo > hi) {
      return {
        ok: false,
        error: `${field.name}超出范围（${field.min}-${field.max}）：${part}`,
      };
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  // 星期 7 归一到 0（周日），避免 0/7 两套写法匹配不上
  if (field.name === '星期' && out.has(7)) {
    out.delete(7);
    out.add(0);
  }
  return { ok: true, values: out };
}

/**
 * 解析 5 段 cron。
 * @returns {{ok:true, expr:string, sets:Set<number>[], source:string} | {ok:false, error:string}}
 */
export function parseCron(expr) {
  if (typeof expr !== 'string') return { ok: false, error: '表达式必须是字符串' };
  const trimmed = expr.trim();
  if (!trimmed) return { ok: false, error: '表达式为空' };

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `需要 5 段（分 时 日 月 周），收到 ${parts.length} 段：${trimmed}` };
  }

  const sets = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const r = expandField(parts[i], FIELDS[i]);
    if (!r.ok) return { ok: false, error: r.error };
    sets.push(r.values);
  }
  return { ok: true, expr: trimmed, sets, source: trimmed };
}

/** 某个日期是否命中（分钟粒度）。 */
export function matchesCron(parsed, date = new Date()) {
  if (!parsed || !parsed.ok) return false;
  const [minutes, hours, days, months, weekdays] = parsed.sets;
  if (!minutes.has(date.getMinutes())) return false;
  if (!hours.has(date.getHours())) return false;
  if (!months.has(date.getMonth() + 1)) return false;
  // 「日」与「星期」同时被限定时，cron 的惯例是「或」关系（满足其一即可）
  const dayRestricted = days.size !== 31;
  const weekRestricted = weekdays.size !== 7;
  const dayHit = days.has(date.getDate());
  const weekHit = weekdays.has(date.getDay());
  if (dayRestricted && weekRestricted) return dayHit || weekHit;
  if (dayRestricted) return dayHit;
  if (weekRestricted) return weekHit;
  return true;
}

/**
 * 下一次触发时间（严格晚于 `from`，分钟粒度）。
 * 逐分钟向前找，最多找 366 天；找不到返回 null。
 */
export function nextRunAt(expr, from = new Date()) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!parsed || !parsed.ok) return null;

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(parsed, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** 人类可读的「下次触发」描述。 */
export function describeNextRun(expr, from = new Date()) {
  const next = nextRunAt(expr, from);
  if (!next) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())} ` +
    `${pad(next.getHours())}:${pad(next.getMinutes())}`
  );
}

// ---------------------------------------------------------------- 调度器

/** 调度历史文件的软上限（超过就滚动成 .1）。 */
const SCHEDULE_LOG_MAX = 1024 * 1024;

/**
 * 创建调度器。**时间与触发都从外部注入**，因此可以完全离线单测。
 *
 * @param {object} options
 * @param {() => Array<object>} options.getPresets 取当前任务集里的 preset 列表
 * @param {(preset:object, info:object) => Promise<void>} options.onFire 触发执行
 * @param {() => boolean} [options.canRun] 现在能不能跑（例如设备就绪、没有别的任务在跑）
 * @param {(msg:string, level?:string)=>void} [options.onEvent] 观测量：界面/日志
 * @param {() => Date} [options.now] 注入时钟（测试用）
 */
export function createScheduler(options) {
  const {
    getPresets,
    onFire,
    canRun = () => true,
    onEvent = () => {},
    now = () => new Date(),
    logger = createLogger('schedule'),
  } = options;

  let timer = null;
  let running = false;
  // 记住每个 preset 上一次「已触发」的分钟，防止同一分钟被 tick 两次
  const lastFiredMinute = new Map();
  /** 最近一次触发结果，供界面显示。 */
  const history = [];

  const minuteKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;

  function jobs() {
    return (getPresets() ?? [])
      .filter((p) => p.schedule?.enabled === true && !!p.schedule.cron)
      .map((p) => {
        const parsed = parseCron(p.schedule.cron);
        return {
          presetId: p.id,
          name: p.name,
          cron: p.schedule.cron,
          ok: parsed.ok,
          error: parsed.ok ? null : parsed.error,
          next: parsed.ok ? nextRunAt(parsed, now())?.toISOString() ?? null : null,
          nextText: parsed.ok ? describeNextRun(parsed, now()) : null,
          lastFiredMinute: lastFiredMinute.get(p.id) ?? null,
        };
      });
  }

  function appendHistory(entry) {
    history.unshift(entry);
    if (history.length > 50) history.length = 50;
    try {
      fs.mkdirSync(path.dirname(PATHS.scheduleLog), { recursive: true });
      if (fs.existsSync(PATHS.scheduleLog) && fs.statSync(PATHS.scheduleLog).size > SCHEDULE_LOG_MAX) {
        fs.renameSync(PATHS.scheduleLog, `${PATHS.scheduleLog}.1`);
      }
      fs.appendFileSync(PATHS.scheduleLog, `${JSON.stringify(entry)}\n`);
    } catch (e) {
      logger.debug(`调度历史写入失败：${e.message}`);
    }
  }

  /**
   * 检查一次并触发到点的任务。
   * 单独暴露出来是为了测试可以手动 `tick()`，不必等真实定时器。
   */
  async function tick() {
    if (running) return { checked: 0, fired: 0, skipped: 0, busy: true };
    running = true;
    let fired = 0;
    let skipped = 0;
    let checked = 0;
    try {
      const at = now();
      for (const preset of getPresets() ?? []) {
        if (preset.schedule?.enabled !== true || !preset.schedule.cron) continue;
        const parsed = parseCron(preset.schedule.cron);
        if (!parsed.ok) continue;
        checked++;
        if (!matchesCron(parsed, at)) continue;

        const key = minuteKey(at);
        if (lastFiredMinute.get(preset.id) === key) continue;

        if (!canRun()) {
          // 正在跑别的任务：跳过本次而不是排队，避免开机后堆积一串补跑
          skipped++;
          lastFiredMinute.set(preset.id, key);
          const entry = {
            ts: at.getTime(),
            presetId: preset.id,
            name: preset.name,
            result: 'skipped',
            reason: '已有任务在运行',
          };
          history.unshift(entry);
          appendHistory(entry);
          onEvent(`定时任务「${preset.name}」到点，但有任务在运行，跳过本次`, 'warn');
          continue;
        }

        lastFiredMinute.set(preset.id, key);
        fired++;
        onEvent(`定时任务触发：${preset.name}（${preset.schedule.cron}）`, 'info');
        const entry = { ts: at.getTime(), presetId: preset.id, name: preset.name, result: 'fired' };
        history.unshift(entry);
        if (history.length > 50) history.length = 50;
        appendHistory(entry);
        try {
          await onFire(preset, { trigger: 'schedule', at: at.getTime() });
        } catch (e) {
          logger.error(`定时任务「${preset.name}」执行失败：${e.message}`);
          onEvent(`定时任务「${preset.name}」执行失败：${e.message}`, 'error');
        }
      }
    } finally {
      running = false;
    }
    return { checked, fired, skipped, busy: false };
  }

  return {
    /** 启动周期检查（默认每 30 秒；cron 最小粒度是分钟，30 秒足够且够省）。 */
    start(intervalMs = 30000) {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((e) => logger.error(`调度检查出错：${e.message}`));
      }, intervalMs);
      timer.unref?.();
      logger.info(`调度器已启动（每 ${Math.round(intervalMs / 1000)}s 检查一次）`);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** 立即重新计算（任务集变更后调用）。 */
    refresh() {
      onEvent('调度计划已更新', 'info');
    },

    tick,
    jobs,
    getHistory: () => history.slice(),
    isRunning: () => running,
  };
}

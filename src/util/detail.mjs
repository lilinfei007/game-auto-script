/**
 * 识别结果（RecoDetail）读取辅助。
 *
 * ⚠️ 易错点（v5.13.1）：
 *   `Tasker.post_recognition()` / `post_task()` 返回的是 `TaskJob`，
 *   其 `get()` 解析出的是 **TaskDetail**（`{ entry, nodes, status }`），
 *   而不是 RecoDetail！必须再走一步：
 *
 *       const task = await job.get()          // TaskDetail
 *       const node = tasker.node_detail(task.nodes[0])
 *       const reco = node.reco                // 这才是 RecoDetail
 *
 *   直接读 `task.detail` 会永远是 undefined，表现为「识别到了但读不出结果」。
 *
 * 另外 `RecoDetail.detail` 有两种形态：
 *   - `RecoDetailObject`：单个算法结果（TemplateMatch / OCR / ColorMatch ...）
 *   - `RecoDetailWithoutDraws[]`：And / Or 这类复合识别
 * 用 recoObject() 统一成对象形态，避免调用方各自判断。
 */

/** 把 RecoDetail.detail 统一成 { all, filtered, best }。 */
export function recoObject(reco) {
  const d = reco?.detail;
  if (!d || Array.isArray(d)) return { all: [], filtered: [], best: null };
  return { all: d.all ?? [], filtered: d.filtered ?? [], best: d.best ?? null };
}

/** 取最佳结果（可能为 null）。 */
export function bestOf(reco) {
  return recoObject(reco).best;
}

/** 取全部结果（可能是空数组）。 */
export function allOf(reco) {
  return recoObject(reco).all;
}

/**
 * 用 Tasker 直接跑一次识别，返回 RecoDetail（失败返回 null）。
 * 这条路径适合「手上有图、想立刻看识别结果」的诊断场景。
 */
export async function recognizeWithTasker(tasker, recoType, recoParam, image) {
  const job = tasker.post_recognition(recoType, recoParam, image).wait();
  if (!(await job.succeeded)) return null;

  const task = await job.get(); // TaskDetail，不是 RecoDetail
  const nodeId = task?.nodes?.[0];
  if (nodeId === undefined || nodeId === null) return null;

  const node = tasker.node_detail(nodeId);
  return node?.reco ?? null;
}

/**
 * 从 TaskDetail 里取出全部节点对应的识别结果。
 * 复合识别（And / Or）会产生多个节点。
 */
export function recosFromTask(tasker, task) {
  const out = [];
  for (const nodeId of task?.nodes ?? []) {
    const node = tasker.node_detail(nodeId);
    if (node?.reco) out.push(node.reco);
  }
  return out;
}

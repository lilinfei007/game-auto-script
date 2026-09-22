/**
 * 一次性排查脚本：找出「块注释里出现星号加斜杠组合」的行。
 *
 * 背景：schedule.mjs 里曾把「星号加斜杠」写在反引号内当作示例，
 * 但它依然会**提前闭合块注释**，导致后面几十行被当成代码解析。
 * 这个坑很隐蔽（报错行号会指到很远的地方），所以留个自动检查。
 */
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const TICK = String.fromCharCode(96); // 反引号，避免本文件自己踩同样的坑

let bad = 0;
for (const f of [...walk('src'), ...walk('test'), ...walk('tools')]) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let inBlock = false;
  lines.forEach((line, i) => {
    const startsInBlock = inBlock;
    const openAt = line.indexOf('/*');
    const closeAt = line.indexOf('*/');

    // 判据：本行结束之后块注释「仍然开着」，但本行在真正收尾之前又出现了一个
    // 「/*」——说明前一个 */ 把注释提前闭合了（反引号保护不了它）。
    // 正常写法（单行 /** ... */，或多行注释的最后一行 */）不会命中这条。
    const closedHere = closeAt >= 0 && (!startsInBlock || closeAt >= openAt || openAt < 0);
    const reopenedAfter = closeAt >= 0 && line.indexOf('/*', closeAt + 2) >= 0;
    if (closedHere && reopenedAfter) {
      const tickAt = line.indexOf(TICK);
      const hint = tickAt >= 0 && tickAt < closeAt ? '（反引号内的星号斜杠同样会提前闭合注释）' : '';
      console.log(`可疑 ${f}:${i + 1}  ${line.trim()} ${hint}`);
      bad++;
    }

    // 维护块注释状态
    let cursor = 0;
    while (cursor < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', cursor);
        if (end < 0) break;
        inBlock = false;
        cursor = end + 2;
      } else {
        const start = line.indexOf('/*', cursor);
        if (start < 0) break;
        inBlock = true;
        cursor = start + 2;
      }
    }
  });
}

console.log(bad === 0 ? '未发现可疑注释行' : `共 ${bad} 处可疑，请人工确认`);
process.exit(bad === 0 ? 0 : 1);

/**
 * 测试入口：在一个进程内加载全部用例。
 *
 * 为什么不直接用 `node --test test/`：
 * Node 自带的 test runner 会为每个文件 spawn 子进程并用管道回收结果，
 * 在受限环境（沙箱 / 部分 CI）下管道被禁会直接 `EPERM`。
 * 这里改为同进程加载，行为一致且到处都能跑。
 */
import './core.test.mjs';
import './util.test.mjs';
import './foundation.test.mjs';
import './web.test.mjs';
import './replay.test.mjs';
import './zip.test.mjs';

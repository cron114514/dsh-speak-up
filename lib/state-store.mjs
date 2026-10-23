// 极小的 JSON 状态存储（与 dsh-feiyu-mood 里那份同构，各仓库自包含）。
//
// 写入走「临时文件 + rename」：提示词组装是同步读，半个 JSON 会直接让
// 那次请求失败，代价太大。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH 的主目录；没设 $DSH_HOME 时退回 ~/.dsh。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 创建状态存储。
 * @param {object} options
 * @param {string} options.file 绝对路径
 * @param {(raw: unknown, now?: number) => object} options.coerce 洗数据
 * @param {() => object} options.initial 首次启动的默认状态
 */
export function createStateStore({ file, coerce, initial }) {
  function load(now = Date.now()) {
    try {
      return coerce(JSON.parse(fs.readFileSync(file, 'utf8')), now);
    } catch {
      return initial();
    }
  }

  function save(state) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  return { file, load, save };
}

// 后台定时任务不该在网关没连上时空跑：B 站刷视频、空间日记/互动、主动搭话都会调 OneBot，
// 没连上时跑了只会白白触发请求和日志。这里锁住「调度入口带网关判断」这个行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const MODULES = ['bili', 'diary', 'qzone-social', 'speakup']

for (const id of MODULES) {
  test(`模块 ${id}：网关未连接时跳过定时任务`, () => {
    const src = readFileSync(new URL(`../src/modules/${id}/index.js`, import.meta.url), 'utf8')
    assert.match(src, /api\.core\.onebot\?\.state/, `${id}/index.js 的定时任务缺少 onebot 状态判断`)
    assert.match(src, /!== 'connected'/, `${id}/index.js 的定时任务没有判断「未连接」`)
  })
}

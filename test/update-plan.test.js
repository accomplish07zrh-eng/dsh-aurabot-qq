// 更新命令/链接要按宿主平台和安装形态给，不能写死 Windows 桌面版路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostEnv, updateCommand, updatePlan } from '../src/core/update.js'

test('updateCommand：Windows 用 PowerShell 写法，Linux/macOS 用 shell 写法', () => {
  const win = updateCommand('a/b', 'beta', { env: hostEnv({ platform: 'win32', cli: 'C:\\tools\\dsh.cmd', profile: 'desktop' }) })
  assert.match(win, /^& "C:\\tools\\dsh\.cmd" plugin --profile desktop add github:a\/b#beta$/)
  const lin = updateCommand('a/b', 'main', { env: hostEnv({ platform: 'linux', cli: '/usr/bin/dsh', profile: 'work' }) })
  assert.match(lin, /^"\/usr\/bin\/dsh" plugin --profile work add github:a\/b$/)
})

test('updatePlan：带平台标签、发布页和 tag 链接', () => {
  const plan = updatePlan({ repo: 'a/b', channel: 'beta', latest: '1.3.0-beta.1', env: hostEnv({ platform: 'darwin', cli: '/Applications/dsh' }) })
  assert.equal(plan.platformLabel, 'macOS')
  assert.equal(plan.releaseUrl, 'https://github.com/a/b/releases')
  assert.equal(plan.tagUrl, 'https://github.com/a/b/releases/tag/v1.3.0-beta.1')
  assert.match(plan.command, /plugin --profile desktop add github:a\/b#beta/)
})

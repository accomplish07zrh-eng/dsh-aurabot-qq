import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize } from '../src/core/config.js'
import { presetFor } from '../src/chat/access.js'
import { rulesText } from '../src/persona/personas.js'
import { createDangerGuard } from '../src/security/danger.js'

test('新安装默认打开长任务模式，老用户存过的不变', () => {
  assert.equal(normalize({}).longTasks, true)
  assert.equal(normalize({ longTasks: false }).longTasks, false)
  assert.equal(presetFor('full', normalize({})), 'aurabot-private-long')
  assert.equal(presetFor('social', normalize({})), 'aurabot-social')
})

test('规则跟着开关走，只进主人私聊', () => {
  assert.match(rulesText('private', normalize({ ownerName: '主人' })), /放到后台/)
  assert.doesNotMatch(rulesText('private', normalize({ longTasks: false })), /放到后台/)
  assert.doesNotMatch(rulesText('social', normalize({})), /放到后台/)
})

test('预设里不挂团队工具：DSH 的开关已经全局挂了，重复注册会让会话建不起来', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(yml, /^\s*(- id:|name:).*agent-team/m)
  assert.match(rulesText('private', normalize({})), /spawn_teammate/)
  assert.doesNotMatch(rulesText('social', normalize({})), /spawn_teammate/)
})

test('spawn_teammate 只有主人私聊能用', async () => {
  const guard = createDangerGuard({
    getConfig: () => ({}), ownerQQ: () => '1',
    chatOfSession: (id) => ({ own: 'private:1', group: 'group:9', other: 'private:2', sys: 'system:diary' })[id] || '',
  })
  const run = (id, name = 'spawn_teammate') => guard.preExecute({ name, agent: { session: { id } } }, async () => ({ kind: 'allow' }))
  assert.equal((await run('own')).kind, 'allow')
  for (const id of ['group', 'other', 'sys']) assert.equal((await run(id)).kind, 'deny', id)
  assert.equal((await run('dsh-normal')).kind, 'allow', 'DSH 自己的会话不管')
  assert.equal((await run('group', 'qq_send_message')).kind, 'allow')
})

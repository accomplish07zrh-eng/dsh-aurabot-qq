// 排期（dailyPosts）的规范化契约：
// 模块侧按下标取「今天第几篇」，所以空项必须原样保留位置；话题上限要和模块一致（4 个）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'

test('dailyPosts 里的空项要保留位置，不能被过滤掉', () => {
  const raw = {
    heybox: {
      dailyPosts: [
        {},                                                          // 第 1 篇：跟全局
        { style: 'news', wordsMin: 2000, wordsMax: 3000, hint: '第2篇' },  // 第 2 篇：单独配
      ],
    },
  }
  const c = normalize(raw)
  assert.equal(c.heybox.dailyPosts.length, 2, '两篇都要在，空项不能被过滤')
  // 第 1 项是空项（各项字段都是空/0）
  const p1 = c.heybox.dailyPosts[0]
  assert.equal(p1.style, '', '空项 style 应为空（走全局）')
  assert.equal(p1.wordsMin, 0)
  assert.equal(p1.hashtags.length, 0)
  // 第 2 项必须还是自己的配置，不能被第 1 项顶掉
  const p2 = c.heybox.dailyPosts[1]
  assert.equal(p2.style, 'news', '第 2 篇要保住自己的风格')
  assert.equal(p2.wordsMin, 2000, '第 2 篇要保住自己的字数下限')
  assert.equal(p2.hint, '第2篇')
})

test('dailyPosts 的话题上限是 4（模块允许 活动 1 + 普通 3）', () => {
  const raw = {
    heybox: {
      dailyPosts: [{
        hashtagsText: '分享我的养鱼日常,盒友日常,deepseek,ai人工智能,手机',
        wordsMin: 100, wordsMax: 500,
      }],
    },
  }
  const c = normalize(raw)
  const hs = c.heybox.dailyPosts[0].hashtags
  assert.equal(hs.length, 4, '要保留 4 个，不能截到 3')
  assert.deepEqual(hs, ['分享我的养鱼日常', '盒友日常', 'deepseek', 'ai人工智能'])
})

test('dailyPosts 最多 5 篇，超出的截掉但前面的位置不变', () => {
  const slots = []
  for (let i = 0; i < 8; i++) slots.push(i === 1 ? { style: 'mix', hint: '第2篇' } : {})
  const c = normalize({ heybox: { dailyPosts: slots } })
  assert.equal(c.heybox.dailyPosts.length, 5)
  assert.equal(c.heybox.dailyPosts[1].style, 'mix', '第 2 篇仍在第 2 个位置')
})

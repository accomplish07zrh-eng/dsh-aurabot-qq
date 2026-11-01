import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRef, midOf } from '../index.mjs'

test('正文链接：https://weibo.com/<uid>/<mid>', () => {
  const r = parseRef('https://weibo.com/7139002855/5035515162399674')
  assert.equal(r.kind, 'post')
  assert.equal(r.mid, '5035515162399674')
})

test('正文链接（带参数/query）也能认', () => {
  const r = parseRef('https://weibo.com/7139002855/5035515162399674?refer_flag=1001030103_')
  assert.equal(r.kind, 'post')
  assert.equal(r.mid, '5035515162399674')
})

test('主页链接 /u/<uid> 必须识别为 profile，不能当成微博 id', () => {
  const r = parseRef('https://weibo.com/u/7139002855')
  assert.equal(r.kind, 'profile')
  assert.equal(r.uid, '7139002855')
})

test('主页链接 /<uid> 结尾也识别为 profile', () => {
  const r = parseRef('https://weibo.com/7139002855')
  assert.equal(r.kind, 'profile')
})

test('/detail/<mid> 这种新链接能认', () => {
  const r = parseRef('https://weibo.com/detail/5035515162399674')
  assert.equal(r.kind, 'post')
  assert.equal(r.mid, '5035515162399674')
})

test('纯数字默认当微博 id', () => {
  const r = parseRef('5035515162399674')
  assert.equal(r.kind, 'post')
})

test('midOf 对主页链接给出可执行的错误提示，而不是"可能被删"', () => {
  assert.throws(() => midOf('https://weibo.com/u/7139002855'), /主页链接.*不是某条微博/s)
})

test('垃圾输入会明确报错', () => {
  assert.throws(() => parseRef('随便什么'), /认不出/)
})

// SPDX-License-Identifier: MIT
// Source-grounded conversation recall. Generated replies remain labelled replies,
// never promoted to facts about a person. This module makes no model/network calls.
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const POINTER = /然后|后来|那个|这个|那件|这件|当时|刚才|继续|上次|之前|还记得|接着|\b(it|that|then|continue|previous|earlier)\b/i
const RESET = /^(换个话题|另一个问题|不说这个|先不聊|new topic\b)/i
const STOP = new Set(['然后', '后来', '那个', '这个', '什么', '怎么', '之前', '刚才', '我们', '你们', '他们', '一下', '记得', '时候'])
export const clip = (text, length) => Array.from(String(text || '')).slice(0, Math.max(0, length)).join('')

export function terms(text) {
  const normalized = String(text || '').normalize('NFKC').toLowerCase()
  const result = normalized.match(/[a-z0-9][a-z0-9_+.-]*/g) || []
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i + 1 < run.length; i++) if (!STOP.has(run.slice(i, i + 2))) result.push(run.slice(i, i + 2))
  }
  return result
}

export function queriesFor(query, recent = []) {
  const current = String(query || '').trim()
  if (!current) return []
  const result = [clip(current, 600)]
  const hasNamedTopic = /[a-z][a-z0-9_+.-]{2,}/i.test(current) || terms(current).length >= 2
  if (RESET.test(current) || (!POINTER.test(current) && hasNamedTopic)) return result
  // Most recent user cues have priority. Assistant text is only a last-resort
  // discourse cue and is never evidence for a user/prototype fact.
  const users = recent.filter(m => m.role === 'user' && m.text).slice(-3).reverse()
  for (const m of users) if (terms(m.text).length) result.push(clip(m.text, 400))
  if (result.length === 1) {
    const last = recent.filter(m => m.role === 'assistant' && m.text).at(-1)
    if (last) result.push(clip(last.text, 250))
  }
  return [...new Set(result)].slice(0, 4)
}

/** BM25 over independent query variants, reciprocal-rank fusion, and diversity. */
export function retrieve(queries, documents, { limit = 6, textOf = d => d.text, eligible = () => true } = {}) {
  const docs = documents.filter(eligible).map(item => {
    const words = terms(textOf(item)), tf = new Map()
    for (const word of words) tf.set(word, (tf.get(word) || 0) + 1)
    return { item, tf, length: words.length || 1 }
  })
  const df = new Map(), avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1)
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1)
  const fused = new Map()
  queries.forEach((query, qi) => {
    const words = [...new Set(terms(query))]
    const hits = docs.map(d => {
      let score = 0
      for (const word of words) {
        const f = d.tf.get(word) || 0
        if (f) score += Math.log(1 + (docs.length - df.get(word) + .5) / (df.get(word) + .5)) * f * 2.2 / (f + 1.2 * (.25 + .75 * d.length / avg))
      }
      return { d, score }
    }).filter(h => h.score >= (docs.length < 4 ? .1 : .45)).sort((a, b) => b.score - a.score).slice(0, 30)
    hits.forEach((h, i) => {
      const previous = fused.get(h.d.item) || { item: h.d.item, score: 0, lexical: 0, tf: h.d.tf }
      previous.score += (qi === 0 ? 2.5 : .65) / (30 + i + 1)
      previous.lexical = Math.max(previous.lexical, h.score)
      fused.set(h.d.item, previous)
    })
  })
  const selected = []
  for (const hit of [...fused.values()].sort((a, b) => b.score - a.score || b.lexical - a.lexical)) {
    const duplicate = selected.some(other => {
      let shared = 0
      for (const t of hit.tf.keys()) if (other.tf.has(t)) shared++
      const overlap = shared / (hit.tf.size + other.tf.size - shared || 1)
      // Keep versions of a fact: similar wording can contain a crucial negation.
      return overlap > .94 && String(textOf(hit.item)) === String(textOf(other.item))
    })
    if (!duplicate) selected.push(hit)
    if (selected.length >= limit) break
  }
  return selected.map(h => ({ ...h.item, retrievalScore: h.score }))
}

export function packEvidence(items, render, maxCharacters = 4000) {
  const result = [], selected = []
  let used = 0
  for (const item of items) {
    const line = render(item), size = Array.from(line).length + 1
    // Do not cut JSON/source records in half, and try smaller remaining records.
    if (used + size > maxCharacters) continue
    result.push(line); selected.push(item); used += size
  }
  return { text: result.join('\n'), selected, characters: Math.max(0, used - 1) }
}

export function recentWithin(messages, maxCharacters = 6000) {
  const result = []; let used = 0
  // Preserve complete user/assistant exchanges. A final outstanding user message
  // is also retained as a complete unit. Oversized units are skipped, not sliced.
  const units = []
  for (const message of messages) {
    if (message.role === 'user' || !units.length) units.push([])
    units.at(-1).push(message)
  }
  for (const unit of units.reverse()) {
    const size = unit.reduce((n, m) => n + Array.from(m.text || '').length, 0)
    if (used + size > maxCharacters) break
    result.unshift(...unit); used += size
  }
  return result
}

/** Durable, persona- and chat-isolated archive; append-only journal is the source. */
export function createConversationArchive({ directory, namespace = 'default', now = Date.now, visible = () => true } = {}) {
  if (!directory) throw new Error('Conversation archive directory required')
  const cache = new Map()
  const keyFor = chatId => createHash('sha256').update(namespace + '\0' + String(chatId)).digest('hex')
  function state(chatId) {
    if (!/^(private|group):[^\s:]+$/.test(String(chatId))) throw new Error('Invalid conversation identity')
    const key = keyFor(chatId)
    if (cache.has(key)) return cache.get(key)
    const journal = join(directory, key + '.jsonl'), checkpoint = join(directory, key + '.json')
    const value = { journal, checkpoint, messages: [], revision: 0 }
    // Recover from the journal, including a turn appended before a checkpoint
    // write was interrupted. Reject malformed committed lines rather than reset.
    if (existsSync(journal)) {
      const raw = readFileSync(journal, 'utf8'), lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { value.messages.push(JSON.parse(lines[i])) }
        catch (error) {
          if (i !== lines.length - 1) throw new Error('Conversation journal is corrupt; preserving source')
          throw new Error('Conversation journal has an incomplete tail; preserving source for recovery')
        }
      }
    }
    cache.set(key, value); return value
  }
  function append(chatId, { role, text, id = randomUUID(), speakerId = '', at = now(), contextAt = at }) {
    if (!['user', 'assistant'].includes(role)) throw new Error('Invalid conversation role')
    const value = state(chatId), body = String(text || '').trim()
    if (!body || value.messages.some(m => m.id === id)) return false
    const message = { id, role, text: body, speakerId: String(speakerId), at: Number(at) || now(), contextAt: Number(contextAt) || Number(at) || now() }
    mkdirSync(directory, { recursive: true })
    appendFileSync(value.journal, JSON.stringify(message) + '\n', { encoding: 'utf8', mode: 0o600 })
    value.messages.push(message); value.revision++
    // Checkpoint is inspectable metadata, not a second source of truth.
    const temp = value.checkpoint + '.' + process.pid + '.tmp'
    writeFileSync(temp, JSON.stringify({ version: 1, namespace, chatId, messages: value.messages.length, lastId: id }), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, value.checkpoint)
    return true
  }
  const available = chatId => state(chatId).messages.filter(m => visible(chatId, m))
  function recent(chatId, limit = 32) {
    const count = Math.max(0, Math.min(256, Math.trunc(Number(limit) || 0)))
    return count ? available(chatId).slice(-count).map(m => ({ ...m })) : []
  }
  function episodes(chatId, { maxCharacters = 2000 } = {}) {
    const result = []; let block = [], serializedSize = 0
    // Reserve the episode wrapper and evidence IDs. Split at source-message
    // boundaries, so a large paste cannot hide its small neighboring facts.
    const recordBudget = Math.max(1, maxCharacters - 256)
    const emit = () => {
      if (!block.length) return
      result.push({ id: 'conversation-' + block[0].id, at: block[0].at, source: 'new_conversation',
        visibility: 'same_conversation', evidence_ids: block.map(m => m.id), context: block.map(m => ({ ...m })),
        text: block.map(m => `${m.role}: ${m.text}`).join('\n') }); block = []; serializedSize = 0
    }
    for (const m of available(chatId)) {
      const size = JSON.stringify(m).length + JSON.stringify(m.id).length + 2
      if (block.length && (m.at - block.at(-1).at > 30 * 60_000 || (m.role === 'user' && block.length >= 8) || serializedSize + size > recordBudget)) emit()
      block.push(m); serializedSize += size
      if (serializedSize >= recordBudget) emit()
    }
    emit(); return result
  }
  function recall(chatId, query, { maxCharacters = 4000, recentMessages = recent(chatId), excludeIds = [] } = {}) {
    const excluded = new Set([...excludeIds, ...recentMessages.map(m => m.id)])
    const render = e => JSON.stringify({ id: e.id, source: e.source, evidence_ids: e.evidence_ids, context: e.context })
    const docs = episodes(chatId, { maxCharacters: Math.min(2000, maxCharacters) }).filter(e => e.context.some(m => !excluded.has(m.id)))
      .map(e => ({ ...e, context: e.context.filter(m => !excluded.has(m.id)) }))
      .map(e => ({ ...e, evidence_ids: e.context.map(m => m.id), text: e.context.map(m => `${m.role}: ${m.text}`).join('\n') }))
      .filter(e => Array.from(render(e)).length <= maxCharacters)
    const hits = retrieve(queriesFor(query, recentMessages), docs, { limit: 6 })
    return packEvidence(hits, render, maxCharacters)
  }
  return { append, recent, recall, episodes }
}

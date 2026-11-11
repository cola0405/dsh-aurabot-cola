// QQ 机器人「扫码连接」：手机 QQ 扫一下，官方直接把机器人的 AppID / AppSecret 交过来，
// 顺便告诉我们扫码的那个人的 openid —— 所以扫码的人天然就是主人，不用再配对码。
//
// 走的是 QQ 开放平台给「接入方」用的那条通道（dsh-qqbot 用的 @tencent-connect/qqbot-connector
// 也是这个协议，这里按协议自己实现一遍，不引它的包）：
//   1. POST /lite/create_bind_task  { key }        → task_id（key 是本地随机 32 字节，base64）
//   2. 二维码内容 = https://q.qq.com/qqbot/openclaw/connect.html?task_id=…&source=…&_wv=2
//   3. POST /lite/poll_bind_result  { task_id }    → status / bot_appid / bot_encrypt_secret / user_openid
//   4. AppSecret = AES-256-GCM 解密(bot_encrypt_secret, key)
//
// status：0 未扫 / 1 已扫待确认 / 2 完成 / 3 过期

import { randomBytes, createDecipheriv } from 'node:crypto'

const RAW_HOST = String(process.env.AURABOT_QQBOT_CONNECT_HOST || 'q.qq.com').replace(/\/+$/, '')
// 支持写完整地址（自测时指到本地假服务），也支持只写域名
const BASE = /^https?:\/\//.test(RAW_HOST) ? RAW_HOST : `https://${RAW_HOST}`
const TIMEOUT = 10000
const SOURCE = 'aurabot'

export const BIND_STATUS = { NONE: 0, PENDING: 1, COMPLETED: 2, EXPIRED: 3 }

async function postJson (path, body, fetchFn) {
  const url = `${BASE}${path}`
  const doFetch = fetchFn || globalThis.fetch
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const r = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}（${path}）`)
    return await r.json()
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连不上 QQ 扫码服务（超时）')
    const why = error?.cause?.code || error?.message || String(error)
    throw new Error(`连不上 QQ 扫码服务：${why}`)
  } finally {
    clearTimeout(t)
  }
}

/** 发起一次扫码任务：拿到 task_id 和本地密钥（密钥只留在宿主进程里）。 */
export async function createBindTask ({ fetchFn } = {}) {
  const key = randomBytes(32).toString('base64')
  const j = await postJson('/lite/create_bind_task', { key }, fetchFn)
  if (Number(j?.retcode) !== 0) throw new Error(j?.msg || 'create_bind_task 失败')
  const taskId = String(j?.data?.task_id || '')
  if (!taskId) throw new Error('create_bind_task 没返回 task_id')
  return { taskId, key }
}

/** 二维码里要放的那条链接（手机 QQ 扫开就是官方绑定页）。 */
export function connectUrl (taskId, source = SOURCE) {
  return `${BASE}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source)}&_wv=2`
}

/** 查一次扫码结果。完成时顺手把 AppSecret 解出来。 */
export async function pollBindResult (taskId, key, { fetchFn } = {}) {
  const j = await postJson('/lite/poll_bind_result', { task_id: taskId }, fetchFn)
  if (Number(j?.retcode) !== 0) throw new Error(j?.msg || 'poll_bind_result 失败')
  const d = j?.data || {}
  const status = Number(d.status ?? BIND_STATUS.NONE)
  const done = status === BIND_STATUS.COMPLETED
  return {
    status,
    appId: done ? String(d.bot_appid || '') : '',
    appSecret: done ? decryptSecret(String(d.bot_encrypt_secret || ''), key) : '',
    userOpenid: String(d.user_openid || ''),
  }
}

/**
 * 解官方给的密钥：AES-256-GCM，密钥是建任务时那个随机 key，
 * 密文是 base64(iv[12] + ciphertext + tag[16])。
 */
export function decryptSecret (payload, keyBase64) {
  if (!payload) return ''
  const key = Buffer.from(String(keyBase64 || ''), 'base64')
  const buf = Buffer.from(String(payload), 'base64')
  if (key.length !== 32) throw new Error('扫码密钥长度不对（应该是 32 字节）')
  if (buf.length <= 28) throw new Error('扫码返回的密钥格式不对')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const data = buf.subarray(12, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

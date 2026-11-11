// QQ 官方机器人 HTTP 侧：取 access_token、调 OpenAPI、上传富媒体。
// 只依赖 Node 自带的 fetch，和 onebot/client.js 一个路数。

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { OneBotError } from '../onebot/client.js'
import { API_BASE, TOKEN_BASE, sourceOf } from './convert.js'

// 二进制直传的上限（官方文档：超过 5M 要走分片上传，这里没接分片）
export const DIRECT_UPLOAD_MAX = 5 * 1024 * 1024
const TOKEN_SAFETY_MS = 60_000
const MEDIA_CACHE_MAX = 60

const notConnected = (error) => ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(error?.cause?.code)

/** 官方错误体（{code,message}）→ OneBotError。4xx 的业务错误算确定失败，网络层错误算 transport。 */
function apiError(action, body, status) {
  const code = Number(body?.code ?? body?.err_code ?? 0) || (status && status >= 400 ? status : 0)
  const message = String(body?.message || body?.msg || `HTTP ${status}`)
  return new OneBotError(action, { message: `${message}${code ? `（${code}）` : ''}`, retcode: code || -1, status: 'failed' })
}

/**
 * @param {object} o
 * @param {() => {appId:string, appSecret:string}} o.credentials 每次请求现取（面板改了立刻生效）
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 * @param {typeof fetch} [o.fetchFn] 测试时替换
 */
export function createQqBotApi({ credentials, log, fetchFn }) {
  const doFetch = fetchFn || globalThis.fetch
  let token = { value: '', expiresAt: 0 }
  const mediaCache = new Map() // key → {fileInfo, expiresAt}
  let lastSendAt = 0

  /** 接口域名：默认官方正式环境；留个环境变量是为了自测和走代理落地。 */
  const apiBase = () => {
    const override = process.env.AURABOT_QQBOT_API_BASE
    return override ? String(override).replace(/\/+$/, '') : API_BASE
  }

  async function post(url, body, { headers = {}, timeoutMs = 20000, action = 'request' } = {}) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      })
      let j = null
      try { j = await r.json() } catch (error) { j = null }
      if (!j) throw new OneBotError(action, { message: `网关响应无法解析（HTTP ${r.status}）`, retcode: -1 })
      if (!r.ok || (j.code !== undefined && Number(j.code) !== 0)) throw apiError(action, j, r.status)
      return j
    } catch (error) {
      if (error instanceof OneBotError) throw error
      if (error.name === 'AbortError') throw new OneBotError(action, { message: '超时', retcode: -1 }, { uncertain: true })
      const why = error?.cause?.code || error?.cause?.message || error?.message || String(error)
      throw new OneBotError(action, { message: `连不上 QQ 开放平台：${why}`, retcode: -1 }, { transport: notConnected(error) })
    } finally {
      clearTimeout(t)
    }
  }

  /** access_token 有效期 7200 秒；提前一分钟换新的。 */
  async function accessToken() {
    if (token.value && Date.now() < token.expiresAt) return token.value
    const { appId, appSecret } = credentials()
    if (!appId || !appSecret) throw new OneBotError('getAppAccessToken', { message: '还没填 AppID / AppSecret', retcode: -1 }, { transport: true })
    const j = await post(`${TOKEN_BASE}/app/getAppAccessToken`, { appId, clientSecret: appSecret }, { action: 'getAppAccessToken', timeoutMs: 15000 })
    const value = String(j.access_token || '')
    if (!value) throw new OneBotError('getAppAccessToken', { message: '没拿到 access_token', retcode: -1 })
    const ttl = Number(j.expires_in || 7200) * 1000
    token = { value, expiresAt: Date.now() + Math.max(30_000, ttl - TOKEN_SAFETY_MS) }
    log?.debug?.(`access_token 已更新，${Math.round(ttl / 1000)}s 后过期`)
    return token.value
  }

  async function request(method, path, body, { action = path, timeoutMs = 20000 } = {}) {
    const tk = await accessToken()
    const url = `${apiBase()}${path}`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await doFetch(url, {
        method,
        headers: { 'content-type': 'application/json', authorization: `QQBot ${tk}` },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
        signal: ctrl.signal,
      })
      let j = null
      try { j = await r.json() } catch (error) { j = null }
      if (!r.ok) throw apiError(action, j, r.status)
      if (j && j.code !== undefined && Number(j.code) !== 0) throw apiError(action, j, r.status)
      return j || {}
    } catch (error) {
      if (error instanceof OneBotError) throw error
      if (error.name === 'AbortError') throw new OneBotError(action, { message: '超时', retcode: -1 }, { uncertain: true })
      const why = error?.cause?.code || error?.cause?.message || error?.message || String(error)
      throw new OneBotError(action, { message: `连不上 QQ 开放平台：${why}`, retcode: -1 }, { transport: notConnected(error) })
    } finally {
      clearTimeout(t)
    }
  }

  /** 拿 WSS 接入点。 */
  async function gateway() {
    return request('GET', '/gateway', null, { action: 'gateway', timeoutMs: 15000 })
  }

  async function readBytes(src) {
    if (src.kind === 'base64') return Buffer.from(src.value, 'base64')
    if (src.kind === 'path') return readFileSync(src.value)
    return null
  }

  /**
   * 上传一份富媒体，返回 file_info。
   * 官方两种打法：给 URL 让它自己下（远程图），或者直传二进制（≤5M）；再大要分片，这里不接。
   */
  async function upload({ scope, targetId, fileType, file, name }) {
    const src = typeof file === 'string' ? sourceOf(file) : file
    if (src.kind === 'none') throw new OneBotError('upload', { message: '没有要上传的文件', retcode: -1 })
    const path = scope === 'group' ? `/v2/groups/${encodeURIComponent(targetId)}/files` : `/v2/users/${encodeURIComponent(targetId)}/files`
    const fileName = String(name || '').trim() || fileNameOf(src, fileType)
    const bytes = await readBytes(src)
    const key = createHash('sha1').update(`${scope}:${targetId}:${fileType}:${fileName}:`).update(bytes || String(src.value)).digest('hex')
    const hit = mediaCache.get(key)
    if (hit && Date.now() < hit.expiresAt) return hit.fileInfo

    let body
    if (src.kind === 'url') {
      body = { file_type: fileType, url: src.value, file_name: fileName, srv_send_msg: false }
    } else {
      if (!bytes || !bytes.length) throw new OneBotError('upload', { message: `读不到文件：${src.value}`, retcode: -1 })
      if (bytes.length > DIRECT_UPLOAD_MAX) {
        throw new OneBotError('upload', {
          message: `QQ 官方机器人单个文件上限 5 MB，这个有 ${(bytes.length / 1024 / 1024).toFixed(1)} MB（分片上传还没接，先压小一点或换成链接）`,
          retcode: -1,
        })
      }
      body = { file_type: fileType, file_name: fileName, file_data: bytes.toString('base64'), srv_send_msg: false }
    }
    const j = await request('POST', path, body, { action: 'upload_media', timeoutMs: 60000 })
    const info = String(j.file_info || '')
    if (!info) throw new OneBotError('upload_media', { message: '上传成功但没拿到 file_info', retcode: -1 })
    const ttl = Number(j.ttl || 0)
    mediaCache.set(key, { fileInfo: info, expiresAt: Date.now() + (ttl > 0 ? Math.max(30_000, ttl * 1000 - 30_000) : 10 * 60_000) })
    if (mediaCache.size > MEDIA_CACHE_MAX) mediaCache.delete(mediaCache.keys().next().value)
    return info
  }

  /**
   * 生成机器人分享链接（官方 /v2/generate_url_link）：手机 QQ 扫码打开资料卡，
   * 就能把机器人加好友 / 拉进群。callback_data 可选，最长 32 字符。
   */
  async function shareLink(callbackData) {
    const body = callbackData ? { callback_data: String(callbackData).slice(0, 32) } : {}
    const j = await request('POST', '/v2/generate_url_link', body, { action: 'generate_url_link', timeoutMs: 15000 })
    const url = String(j?.data?.url || j?.url || '')
    if (!url) throw new OneBotError('generate_url_link', { message: '官方没返回分享链接', retcode: -1 })
    return url
  }

  /** 发一条消息（msg_type 0 文本 / 7 富媒体）。 */  async function sendMessage({ scope, targetId, payload }) {
    const path = scope === 'group' ? `/v2/groups/${encodeURIComponent(targetId)}/messages` : `/v2/users/${encodeURIComponent(targetId)}/messages`
    // 官方按「单关系」限频（主动 20/qpm）：同一目标两条之间留一点空隙，别自己把自己限住
    const wait = lastSendAt + 350 - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastSendAt = Date.now()
    return request('POST', path, payload, { action: scope === 'group' ? 'send_group_msg' : 'send_private_msg', timeoutMs: 30000 })
  }

  return {
    accessToken,
    request,
    gateway,
    upload,
    sendMessage,
    shareLink,
    reset() { token = { value: '', expiresAt: 0 } },
    get tokenReady() { return Boolean(token.value) && Date.now() < token.expiresAt },
  }
}

function fileNameOf(src, fileType) {
  if (src.kind === 'url') {
    try { return decodeURIComponent(new URL(src.value).pathname.split('/').pop() || '') || defaultName(fileType) } catch (error) { return defaultName(fileType) }
  }
  if (src.kind === 'path') {
    const parts = String(src.value).split(/[\\/]/)
    return parts[parts.length - 1] || defaultName(fileType)
  }
  return defaultName(fileType)
}

function defaultName(fileType) {
  return { 1: 'image.png', 2: 'video.mp4', 3: 'voice.mp3', 4: 'file.bin' }[fileType] || 'file.bin'
}

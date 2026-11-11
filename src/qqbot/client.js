// QQ 官方机器人客户端：WebSocket 收事件，HTTP 发消息。
//
// 对外和 createOneBotClient 一模一样的接口（call / start / stop / restart / state），
// 所以插件上半边（host.js、聊天中枢、模块）一行都不用改就能换平台。
//
// 官方和 OneBot 的差别都在这里吸收掉：
//   · 没有 QQ 号，只有 openid —— 直接当 user_id / group_id 用（都是字符串）
//   · 被动回复有窗口和次数 —— 按 msg_id + 递增 msg_seq 回，用完或过期才退化成主动消息
//   · 一条消息只能是纯文字或一个附件 —— 消息段拆开发
//   · 没有好友 / 群成员 / 资料接口 —— 明确报「不支持」，让上层走降级路径

import { OneBotError } from '../onebot/client.js'
import { createQqBotApi } from './api.js'
import {
  INTENT_GROUP_AND_C2C, REPLY_QUOTA, TEXT_CHUNK, chunkText, splitSegments, toOneBotEvent, toOneBotNotice,
} from './convert.js'

const RECONNECT_MIN = 2000
const RECONNECT_MAX = 30000
const HEARTBEAT_GRACE = 2

/** 这些错误说明「被动回复窗口没了」，可以改用主动消息再试一次。 */
const EXPIRED_CODES = new Set([304103, 40034005, 40034128, 40034024, 40034025, 40034026])

/**
 * @param {object} o
 * @param {() => object} o.getConfig 现取配置（面板改了立刻生效）
 * @param {(event: object) => void} o.onEvent
 * @param {(state: string, detail?: string) => void} [o.onState]
 * @param {{info:Function, warn:Function, debug:Function}} o.log
 * @param {typeof fetch} [o.fetchFn] 测试替换
 * @param {new (url: string) => any} [o.socketFactory] 测试替换（默认用 Node 自带的 WebSocket）
 */
export function createQqBotClient({ getConfig, onEvent, onState, log, fetchFn, socketFactory, now = Date.now }) {
  let state = 'stopped'
  let stopped = true
  let ws = null
  let timer = null
  let backoff = RECONNECT_MIN
  let heartbeatTimer = null
  let heartbeatInterval = 30000
  let heartbeatMissed = 0
  let session = null // { id, seq, url }
  let seq = 0
  let botName = ''
  let lastError = ''
  let lastConnectAt = 0
  const passive = new Map() // 'group:xxx' → { msgId, at, seq }
  const seen = new Set() // 同一事件可能重复推送：按 id + msg_idx 去重
  const unsupportedLogged = new Set()

  const api = createQqBotApi({
    credentials: () => ({
      appId: String(getConfig().qqbot?.appId || ''),
      appSecret: String(getConfig().qqbot?.appSecret || ''),
    }),
    log,
    fetchFn,
  })

  const setState = (s, detail) => {
    if (state === s) return
    state = s
    if (s === 'connected') lastConnectAt = now()
    try { onState?.(s, detail) } catch (error) {}
  }

  const makeSocket = (url) => {
    if (socketFactory) return socketFactory(url)
    return new WebSocket(url)
  }

  // ---------- 被动回复记账 ----------
  const keyOf = (scope, targetId) => `${scope}:${targetId}`

  function rememberReply(scope, targetId, msgId) {
    if (!msgId) return
    const key = keyOf(scope, targetId)
    passive.set(key, { msgId, at: now(), seq: 0 })
    if (passive.size > 500) passive.delete(passive.keys().next().value)
  }

  /** 下一个可用的被动回复凭据；窗口过期或额度用完返回 null。 */
  function nextPassive(scope, targetId) {
    const key = keyOf(scope, targetId)
    const p = passive.get(key)
    if (!p) return null
    const quota = REPLY_QUOTA[scope] || REPLY_QUOTA.group
    if (now() - p.at > quota.windowMs) { passive.delete(key); return null }
    if (p.seq >= quota.maxReplies) return null
    p.seq += 1
    return { msg_id: p.msgId, msg_seq: p.seq }
  }

  // ---------- 发送 ----------
  const failureHint = (error) => {
    const code = Number(error?.data?.retcode || 0)
    if (code === 40034105 || code === 40034100) return '主动消息发不出去：要么频控，要么对方在机器人资料卡里关掉了「允许主动发送」'
    if (EXPIRED_CODES.has(code)) return '被动回复窗口过期了（群聊 5 分钟 / 单聊 60 分钟），只能改发主动消息'
    if (code === 40054010) return 'QQ 不让机器人发链接（官方对 URL 有审核），这条被拦了'
    if (code === 40054007) return '内容太长了，QQ 官方限制单条长度'
    if (code === 40054005 || code === 304061) return '消息被去重了（同一个 msg_id 回复了两次）'
    if (code === 40054002) return '机器人被禁言了'
    return ''
  }

  /** 发一条已经拼好的官方消息体；被动凭据过期就退化成主动消息再试一次。 */
  async function sendOne({ scope, targetId, payload }) {
    const cred = nextPassive(scope, targetId)
    const body = { ...payload, ...(cred || {}) }
    try {
      return await api.sendMessage({ scope, targetId, payload: body })
    } catch (error) {
      const code = Number(error?.data?.retcode || 0)
      if (!cred || !EXPIRED_CODES.has(code)) {
        const hint = failureHint(error)
        throw hint ? new OneBotError(scope === 'group' ? 'send_group_msg' : 'send_private_msg', { ...error.data, message: `${error.data?.message || error.message}｜${hint}`, retcode: code || -1, status: 'failed' }) : error
      }
      log?.debug?.(`被动回复不能再用了（${code}），改发主动消息`)
      return api.sendMessage({ scope, targetId, payload })
    }
  }

  async function sendChat(scope, targetId, message) {
    const { texts, media } = splitSegments(message)
    const chunks = texts.flatMap((t) => chunkText(t, TEXT_CHUNK))
    if (!chunks.length && !media.length) return { message_id: '' }
    let firstId = ''
    let sent = 0
    for (const content of chunks) {
      const r = await sendOne({ scope, targetId, payload: { msg_type: 0, content } })
      firstId = firstId || String(r?.id || '')
      sent += 1
    }
    for (const m of media) {
      const fileInfo = await api.upload({ scope, targetId, fileType: m.fileType, file: m.source, name: m.name })
      const r = await sendOne({ scope, targetId, payload: { msg_type: 7, media: { file_info: fileInfo } } })
      firstId = firstId || String(r?.id || '')
      sent += 1
    }
    log?.debug?.(`→ ${scope}:${String(targetId).slice(0, 8)} 发了 ${sent} 条（文字 ${chunks.length} / 媒体 ${media.length}）`)
    return { message_id: firstId, sent }
  }

  // ---------- 能力表 ----------
  async function sendFile(kind, params) {
    const scope = kind === 'group' ? 'group' : 'private'
    const targetId = String(kind === 'group' ? params.group_id : params.user_id)
    const file = String(params.file || '')
    const name = String(params.name || '')
    const fileInfo = await api.upload({ scope, targetId, fileType: 4, file, name })
    const r = await sendOne({ scope, targetId, payload: { msg_type: 7, media: { file_info: fileInfo } } })
    return { message_id: String(r?.id || '') }
  }

  const unsupported = (action, why) => {
    if (!unsupportedLogged.has(action)) {
      unsupportedLogged.add(action)
      log?.debug?.(`QQ 官方机器人不支持 ${action}：${why}`)
    }
    throw new OneBotError(action, { message: `QQ 官方机器人不支持这个操作（${why}）`, retcode: -1 })
  }

  async function call(action, params = {}, opts = {}) {
    if (stopped) throw new OneBotError(action, { message: 'QQ 机器人客户端没在运行' })
    const cfg = getConfig()
    switch (action) {
      case 'get_login_info':
        return { user_id: String(cfg.qqbot?.appId || cfg.botQQ || ''), nickname: botName || 'QQ 机器人' }
      case 'send_private_msg':
        return sendChat('private', String(params.user_id ?? ''), params.message)
      case 'send_group_msg':
        return sendChat('group', String(params.group_id ?? ''), params.message)
      case 'upload_private_file':
        return sendFile('private', params)
      case 'upload_group_file':
        return sendFile('group', params)
      case 'get_group_member_list':
        return [] // 官方不给群成员名单，@ 走文字降级
      case 'get_group_info':
        return { group_id: String(params.group_id ?? ''), group_name: '', member_count: 0 }
      case 'set_input_status':
        return {} // 「正在输入」官方没有对应接口
      case 'get_group_member_info':
        return unsupported(action, '拿不到群成员资料')
      case 'get_stranger_info':
        return unsupported(action, '拿不到陌生人资料')
      case 'get_friend_list':
        return unsupported(action, '拿不到好友列表')
      case 'get_msg':
        return unsupported(action, '查不到单条消息')
      case 'get_forward_msg':
        return unsupported(action, '合并转发取不到')
      case 'get_group_msg_history':
      case 'get_friend_msg_history':
        return unsupported(action, '拉不到历史消息')
      case 'send_poke':
        return unsupported(action, '不能戳一戳')
      default:
        return unsupported(action, '没有对应接口')
    }
  }

  // ---------- WebSocket ----------
  function send(payload) {
    try { ws?.send(JSON.stringify(payload)) } catch (error) { log?.debug?.('WS 发送失败：', error.message) }
  }

  function startHeartbeat(interval) {
    clearInterval(heartbeatTimer)
    heartbeatInterval = Number(interval) > 1000 ? Number(interval) : 30000
    heartbeatMissed = 0
    heartbeatTimer = setInterval(() => {
      if (stopped) return
      if (heartbeatMissed >= HEARTBEAT_GRACE) {
        log?.warn?.('心跳没回，重连')
        reconnect(true)
        return
      }
      heartbeatMissed += 1
      send({ op: 1, d: seq || null })
    }, heartbeatInterval)
    heartbeatTimer.unref?.()
  }

  function identifyOrResume() {
    let token = ''
    // 鉴权用 access_token，异步取；拿不到就先断开、稍后重连
    Promise.resolve()
      .then(() => api.accessToken())
      .then((tk) => {
        token = tk
        if (stopped || !ws) return
        if (session?.id) {
          send({ op: 6, d: { token: `QQBot ${token}`, session_id: session.id, seq: session.seq || 0 } })
          log?.info?.('已在恢复之前的会话（补发漏掉的事件）')
        } else {
          send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: Number(getConfig().qqbot?.intents) || INTENT_GROUP_AND_C2C,
              shard: [0, 1],
              properties: { $os: 'linux', $browser: 'aurabot', $device: 'aurabot' },
            },
          })
        }
      })
      .catch((error) => {
        lastError = `取 access_token 失败：${error.message}`
        log?.warn?.(lastError)
        setState('disconnected', lastError)
        reconnect(true)
      })
  }

  function handleDispatch(t, d) {
    if (t === 'READY') {
      session = { id: String(d?.session_id || ''), seq: seq || 0, url: String(d?.resume_gateway_url || '') }
      botName = String(d?.user?.username || '')
      lastError = ''
      setState('connected')
      log?.info?.(`已连上 QQ 开放平台（机器人：${botName || '未知'}）`)
      return
    }
    if (t === 'RESUMED') {
      setState('connected')
      log?.info?.('会话已恢复')
      return
    }
    // 同名事件可能重复推：按 id + msg_idx 去重，避免她同一句回两遍
    const dedupeKey = `${t}:${d?.id || ''}:${Array.isArray(d?.message_scene?.ext) ? d.message_scene.ext.join(',') : ''}`
    if (d?.id) {
      if (seen.has(dedupeKey)) return
      seen.add(dedupeKey)
      if (seen.size > 1000) seen.delete(seen.values().next().value)
    }
    const selfId = String(getConfig().qqbot?.appId || getConfig().botQQ || '')
    const ev = toOneBotEvent(t, d, { selfId })
    if (ev) {
      // 先记下这条消息的 msg_id：这一轮的回复都靠它走被动通道
      rememberReply(ev.message_type === 'group' ? 'group' : 'private', ev.message_type === 'group' ? ev.group_id : ev.user_id, ev.message_id)
      try { onEvent(ev) } catch (error) { log?.warn?.('处理事件出错：', error.message) }
      return
    }
    const notice = toOneBotNotice(t, d, { selfId })
    if (notice) {
      try { onEvent(notice) } catch (error) { log?.warn?.('处理通知出错：', error.message) }
      return
    }
    log?.debug?.(`忽略事件 ${t}`)
  }

  function handlePayload(raw) {
    let p
    try { p = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')) } catch (error) { return }
    if (!p || typeof p !== 'object') return
    if (p.s) seq = Number(p.s)
    switch (p.op) {
      case 10: // Hello
        startHeartbeat(p.d?.heartbeat_interval)
        identifyOrResume()
        break
      case 11: // Heartbeat ACK
        heartbeatMissed = 0
        break
      case 1: // 服务端要心跳
        send({ op: 1, d: seq || null })
        break
      case 7: // 要求重连
        log?.info?.('服务端要求重连')
        reconnect(false)
        break
      case 9: // 鉴权失败 / session 无效
        lastError = `鉴权失败（${JSON.stringify(p.d ?? '')}），检查 AppID / AppSecret 和事件权限`
        log?.warn?.(lastError)
        session = null
        reconnect(true)
        break
      case 0: // Dispatch
        handleDispatch(String(p.t || ''), p.d)
        break
      default:
        break
    }
  }

  function connect() {
    if (stopped) return
    setState('connecting')
    Promise.resolve()
      .then(() => api.gateway())
      .then((j) => {
        if (stopped) return
        const url = String(j?.url || '')
        if (!url) throw new Error('没拿到 WSS 接入点')
        log?.debug?.('接入点：' + url)
        let sock
        try {
          sock = makeSocket(url)
        } catch (error) {
          throw new Error(`建立 WebSocket 失败：${error.message}`)
        }
        ws = sock
        sock.onopen = () => {
          backoff = RECONNECT_MIN
          log?.info?.('WebSocket 已建立，等 Hello')
        }
        sock.onmessage = (ev) => handlePayload(ev?.data)
        sock.onclose = (ev) => {
          if (ws === sock) ws = null
          clearInterval(heartbeatTimer)
          if (!stopped) {
            setState('disconnected', `code ${ev?.code ?? ''}`)
            reconnect(false)
          }
        }
        sock.onerror = () => {}
      })
      .catch((error) => {
        lastError = error.message
        log?.warn?.('连不上 QQ 开放平台：', error.message)
        setState('disconnected', error.message)
        reconnect(true)
      })
  }

  /** force=true：丢掉 session 重新鉴权（接下来会补不全断线期间的事件，但比一直连不上强）。 */
  function reconnect(force) {
    if (stopped) return
    clearInterval(heartbeatTimer)
    if (force) session = null
    try { ws?.close() } catch (error) {}
    ws = null
    clearTimeout(timer)
    timer = setTimeout(connect, backoff)
    timer.unref?.()
    backoff = Math.min(RECONNECT_MAX, backoff * 2)
  }

  return {
    call,
    start() {
      if (!stopped) return
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      clearInterval(heartbeatTimer)
      try { ws?.close() } catch (error) {}
      ws = null
      setState('stopped')
    },
    restart() {
      this.stop()
      stopped = false
      backoff = RECONNECT_MIN
      connect()
    },
    /** 面板「测试连接」：只验 AppID / AppSecret 和接入点，不真的挂上去。 */
    async probe() {
      try {
        await api.accessToken()
        const j = await api.gateway()
        api.reset()
        const env = 'QQ 开放平台'
        return { ok: true, message: `${env}：AppID / AppSecret 没问题，接入点 ${String(j?.url || '').split('?')[0]}`, url: String(j?.url || '') }
      } catch (error) {
        return { ok: false, message: error.message }
      }
    },
    /** 换 AppID / AppSecret：把 access_token 丢掉，下次重新取 */
    reset() { api.reset() },
    /** 生成机器人的分享链接（扫码加好友 / 拉群） */
    shareLink(callbackData) { return api.shareLink(callbackData) },
    status() {
      const p = [...passive.entries()].map(([k, v]) => ({ chat: k, at: v.at, used: v.seq }))
      return {
        state,
        botName,
        appId: String(getConfig().qqbot?.appId || ''),
        session: Boolean(session?.id),
        connectedAt: lastConnectAt,
        lastError,
        passive: p,
      }
    },
    get state() {
      return state
    },
  }
}

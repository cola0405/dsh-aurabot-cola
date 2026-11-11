// QQ 官方机器人（bot.q.qq.com / api-v2）⇄ OneBot v11 形状互转。
// 只做纯函数：给客户端和测试共用，不碰网络、不碰配置。
//
// 为什么要转：Aurabot 的聊天中枢、模块、命令、记忆全是照 OneBot v11 写的。
// 官方机器人给的是一套完全不同的东西（openid 不是 QQ 号、没有好友/群成员列表、
// 群聊只有被 @ 才收得到），所以这里把事件掰成 OneBot 的形状，把消息段掰回官方格式。

// 事件订阅位（intents）：只需要群聊/单聊消息。互动事件（INTERACTION）要先申请权限，
// 没权限时带上会被网关直接踢掉，所以默认不带。
export const INTENT_GROUP_AND_C2C = 1 << 25
export const INTENT_INTERACTION = 1 << 26

// 接口地址：默认官方域名。留两个环境变量是为了自测（用本地假网关）和走代理落地。
const envBase = (name, fallback) => String(process.env[name] || fallback).replace(/\/+$/, '')
export const TOKEN_BASE = envBase('AURABOT_QQBOT_TOKEN_BASE', 'https://bots.qq.com')
export const API_BASE = envBase('AURABOT_QQBOT_API_BASE', 'https://api.bot.qq.com')

/** 文本消息一次能塞多少字（官方限制比这个宽松，拆小一点更稳，也方便她一句一句发）。 */
export const TEXT_CHUNK = 1200

// 被动回复的额度：群聊 5 分钟 / 5 条，单聊 60 分钟 / 4 条。
export const REPLY_QUOTA = {
  group: { maxReplies: 5, windowMs: 5 * 60_000 },
  private: { maxReplies: 4, windowMs: 60 * 60_000 },
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'])

/** 附件里这一张算什么：1 图片 2 视频 3 语音 4 文件（官方 file_type）。 */
export function fileTypeOf(contentType, name = '') {
  const t = String(contentType || '').toLowerCase()
  if (IMAGE_TYPES.has(t)) return 1
  if (t === 'video/mp4' || t.startsWith('video/')) return 2
  if (t === 'voice' || t.startsWith('audio/')) return 3
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return 1
  if (/\.mp4$/i.test(name)) return 2
  if (/\.(silk|slk|mp3|wav|ogg|amr)$/i.test(name)) return 3
  return 4
}

/** 官方附件 → OneBot 消息段（附件的 url 是平台给的临时直链，能直接下载）。 */
export function segmentOfAttachment(att) {
  const ct = String(att?.content_type || '').toLowerCase()
  const type = fileTypeOf(ct, att?.filename)
  const url = String(att?.url || '')
  if (!url) return null
  if (type === 1) {
    return { type: 'image', data: { file: url, url, summary: att.filename || '[图片]', width: att.width, height: att.height, size: att.size } }
  }
  if (type === 2) return { type: 'video', data: { file: url, url } }
  if (type === 3) {
    // 官方会把语音转成文字（asr_refer_text）：拿得到就当中文本来读，拿不到才标记「[语音]」
    const asr = String(att?.asr_refer_text || '').trim()
    const wav = String(att?.voice_wav_url || '')
    return { type: 'record', data: { file: url, url: wav || url, text: asr, asr }, asr }
  }
  return { type: 'file', data: { file: url, url, name: String(att.filename || ''), size: Number(att.size) || 0, id: String(att.filename || '') } }
}

/** 卡片消息（分享、小程序）只留一句能给模型看的话。 */
export function arkText(ark) {
  if (!ark || typeof ark !== 'object') return ''
  const f = ark.fields && typeof ark.fields === 'object' ? ark.fields : {}
  const title = String(f.title || ark.prompt || '').trim()
  const kind = String(ark.ark_name || ark.ark_type || '卡片').trim()
  return title ? `[${kind}：${title}]` : `[${kind}]`
}

/**
 * 官方事件体 → OneBot v11 消息事件。
 * 认不出的事件返回 null（由调用方决定要不要记日志）。
 * @param {string} type 事件名（payload.t）
 * @param {object} d 事件体（payload.d）
 * @param {{selfId?: string}} opts
 */
export function toOneBotEvent(type, d, { selfId = '' } = {}) {
  if (!d || typeof d !== 'object') return null
  const now = Math.floor(Date.now() / 1000)
  const base = { post_type: 'message', self_id: String(selfId || ''), time: now }
  const author = d.author || {}
  const isGroup = type === 'GROUP_AT_MESSAGE_CREATE' || type === 'GROUP_MESSAGE_CREATE'
  if (!isGroup && type !== 'C2C_MESSAGE_CREATE') return null

  const userId = String((isGroup ? author.member_openid : author.user_openid) || author.id || '')
  const groupId = isGroup ? String(d.group_openid || '') : ''
  const nickname = String(author.username || '')

  const message = []
  let text = String(d.content || '')
  // 引用消息：把被引用的那句先用一句话垫在前面，模型才看得懂「他说的那句」
  if (Array.isArray(d.msg_elements) && d.msg_elements.length) {
    const quoted = d.msg_elements.map((e) => String(e?.content || '').trim()).filter(Boolean).join(' ')
    if (quoted) text = `[引用] ${quoted.slice(0, 200)}\n${text}`
  }
  if (d.ark_data) {
    const card = arkText(d.ark_data)
    if (card) text = text ? `${text}\n${card}` : card
  }
  // 群里她只收得到被 @ 的那条：补一个 @她 的段，中枢才会当成「在叫她」
  if (isGroup && selfId) message.push({ type: 'at', data: { qq: String(selfId), name: '我' } })
  for (const m of d.mentions || []) {
    const id = String(m?.member_openid || m?.id || '')
    if (id && id !== userId) message.push({ type: 'at', data: { qq: id, name: String(m?.username || '') } })
  }
  if (text.trim()) message.push({ type: 'text', data: { text } })
  for (const att of d.attachments || []) {
    const seg = segmentOfAttachment(att)
    if (!seg) continue
    message.push(seg)
    // 语音带转写：把文字也塞进正文，她的「听语音」这条路就通了
    if (seg.type === 'record' && seg.asr) message.push({ type: 'text', data: { text: `[语音] ${seg.asr}` } })
  }

  return {
    ...base,
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: String(d.id || ''),
    user_id: userId,
    group_id: groupId,
    raw_message: text,
    message,
    sender: isGroup
      ? { user_id: userId, nickname: nickname || userId, card: nickname, role: String(author.member_role || 'member') }
      : { user_id: userId, nickname: nickname || userId, card: nickname },
    // 官方给的原事件留一份，方便排查（也方便模块自己取原始字段）
    qqbot: { type, raw: d },
  }
}

/** 加群 / 加好友 / 消息开关这类通知，转成中枢认得的 notice。 */
export function toOneBotNotice(type, d, { selfId = '' } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const base = { post_type: 'notice', self_id: String(selfId || ''), time: now }
  if (type === 'GROUP_ADD_ROBOT') {
    return { ...base, notice_type: 'group_increase', sub_type: 'invite', group_id: String(d?.group_openid || ''), user_id: String(d?.op_member_openid || ''), operator_id: String(d?.op_member_openid || '') }
  }
  if (type === 'GROUP_DEL_ROBOT') {
    return { ...base, notice_type: 'group_decrease', sub_type: 'kick_me', group_id: String(d?.group_openid || ''), user_id: '', operator_id: String(d?.op_member_openid || '') }
  }
  if (type === 'FRIEND_ADD') {
    return { ...base, notice_type: 'friend_add', user_id: String(d?.openid || '') }
  }
  if (type === 'FRIEND_DEL') {
    return { ...base, notice_type: 'friend_recall', user_id: String(d?.openid || '') }
  }
  if (type === 'C2C_MSG_REJECT') return { ...base, notice_type: 'bot_offline', tag: '用户关闭了主动消息', user_id: String(d?.openid || '') }
  if (type === 'GROUP_MSG_REJECT') return { ...base, notice_type: 'bot_offline', tag: '群管理员关闭了主动消息', group_id: String(d?.group_openid || '') }
  return null
}

/**
 * OneBot 消息段数组 → 官方消息内容。
 * 官方一条消息只能是「纯文字」或者「一个附件」，所以这里拆成若干条：
 * 文字先发，附件各自一条。
 * @returns {{texts: string[], media: {fileType:number, source:string, name:string}[]}}
 */
export function splitSegments(message, { faceNames = null } = {}) {
  const texts = []
  const media = []
  let buf = ''
  const flush = () => { if (buf.trim()) texts.push(buf.trim()); buf = '' }
  for (const seg of Array.isArray(message) ? message : []) {
    if (!seg || typeof seg !== 'object') continue
    const d = seg.data || {}
    switch (seg.type) {
      case 'text':
        buf += String(d.text ?? '')
        break
      case 'at': {
        // 官方文本消息里 @ 的语法各家客户端不一定认，硬塞会变成一串乱码标签，所以只留名字
        const name = String(d.name || '')
        if (name && String(d.qq) !== 'all') buf += `@${name} `
        break
      }
      case 'face':
        // 系统表情没有对应关系，去掉标签而不是把 <face:xxx> 发出去
        break
      case 'reply':
        // 引用：被动回复本身就是在回这条消息，不需要额外段
        break
      case 'image':
      case 'mface':
        flush()
        if (d.file || d.url) media.push({ fileType: 1, source: String(d.file || d.url), name: String(d.summary || d.name || '') })
        break
      case 'record':
        flush()
        if (d.file || d.url) media.push({ fileType: 3, source: String(d.file || d.url), name: String(d.name || '') })
        break
      case 'video':
        flush()
        if (d.file || d.url) media.push({ fileType: 2, source: String(d.file || d.url), name: String(d.name || '') })
        break
      case 'file':
      case 'flash_file':
        flush()
        if (d.file || d.url) media.push({ fileType: 4, source: String(d.file || d.url), name: String(d.name || d.title || '') })
        break
      default:
        break
    }
  }
  flush()
  return { texts, media }
}

/** 长文本切成几条（官方单条有长度上限，超了直接报 40054007）。 */
export function chunkText(text, size = TEXT_CHUNK) {
  const s = String(text ?? '')
  if (!s.trim()) return []
  if (s.length <= size) return [s]
  const out = []
  let rest = s
  while (rest.length > size) {
    // 优先在换行 / 句号处断开，实在找不到就硬切
    const window = rest.slice(0, size)
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'))
    if (cut < size * 0.5) cut = -1
    const take = cut >= 0 ? cut + 1 : size
    out.push(rest.slice(0, take).trim())
    rest = rest.slice(take)
  }
  if (rest.trim()) out.push(rest.trim())
  return out.filter(Boolean)
}

/** base64:// / http(s):// / 本机路径 → 上传时用得上的来源描述。 */
export function sourceOf(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { kind: 'none' }
  if (/^base64:\/\//i.test(s)) return { kind: 'base64', value: s.slice(9) }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', value: s }
  if (/^data:[^,]+,/i.test(s)) return { kind: 'base64', value: s.slice(s.indexOf(',') + 1) }
  return { kind: 'path', value: s }
}

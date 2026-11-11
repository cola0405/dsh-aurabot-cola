// QQ 官方机器人（api-v2）：事件转换、消息拆条、被动回复记账、不支持操作的降级。
// 全部用假 fetch + 假 socket 跑，不碰真网关。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  toOneBotEvent, toOneBotNotice, splitSegments, chunkText, sourceOf, fileTypeOf, REPLY_QUOTA,
} = await import('../src/qqbot/convert.js')
const { createQqBotClient } = await import('../src/qqbot/client.js')

const silent = { info () {}, warn () {}, debug () {}, error () {} }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function waitFor (fn, { timeout = 2000 } = {}) {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('等超时了')
    await tick(5)
  }
}

// ---------- 事件转换 ----------

test('单聊消息：转成 OneBot 的 private 事件，openid 当 user_id', () => {
  const ev = toOneBotEvent('C2C_MESSAGE_CREATE', {
    id: 'ROBOT1.0_abc',
    author: { id: 'OPENID_A', user_openid: 'OPENID_A', username: '小明' },
    content: '在吗',
    timestamp: '2026-07-21T10:00:00+08:00',
  }, { selfId: '1020001' })
  assert.equal(ev.post_type, 'message')
  assert.equal(ev.message_type, 'private')
  assert.equal(ev.user_id, 'OPENID_A')
  assert.equal(ev.group_id, '')
  assert.equal(ev.message_id, 'ROBOT1.0_abc')
  assert.deepEqual(ev.message, [{ type: 'text', data: { text: '在吗' } }])
  assert.equal(ev.sender.nickname, '小明')
})

test('群 @ 消息：转成 group 事件，并带上 @她 的段（中枢靠它判断在叫她）', () => {
  const ev = toOneBotEvent('GROUP_AT_MESSAGE_CREATE', {
    id: 'ROBOT1.0_g',
    author: { id: 'M1', member_openid: 'M1', username: '小红', member_role: 'admin' },
    content: ' 今天天气',
    group_openid: 'GROUP_X',
  }, { selfId: '1020001' })
  assert.equal(ev.message_type, 'group')
  assert.equal(ev.user_id, 'M1')
  assert.equal(ev.group_id, 'GROUP_X')
  assert.equal(ev.message[0].type, 'at')
  assert.equal(ev.message[0].data.qq, '1020001')
  assert.equal(ev.message[1].data.text, ' 今天天气')
  assert.equal(ev.sender.role, 'admin')
})

test('附件：图片 / 语音（带转写）/ 文件各归各位', () => {
  const ev = toOneBotEvent('C2C_MESSAGE_CREATE', {
    id: 'x',
    author: { user_openid: 'U1' },
    content: '看看',
    attachments: [
      { content_type: 'image/png', url: 'https://a/1.png', filename: '1.png' },
      { content_type: 'voice', url: 'https://a/v.silk', asr_refer_text: '你好呀' },
      { content_type: 'file', url: 'https://a/d.zip', filename: 'd.zip', size: 12 },
    ],
  }, { selfId: '1' })
  const types = ev.message.map((s) => s.type)
  assert.deepEqual(types, ['text', 'image', 'record', 'text', 'file'])
  // 语音的转写也进正文，她的「听语音」才通
  assert.equal(ev.message[3].data.text, '[语音] 你好呀')
  assert.equal(ev.message[2].data.file, 'https://a/v.silk')
})

test('引用消息：把被引用那句垫在前面；卡片只留一句话', () => {
  const ev = toOneBotEvent('C2C_MESSAGE_CREATE', {
    id: 'x',
    author: { user_openid: 'U1' },
    content: '这个好',
    message_type: 103,
    msg_elements: [{ content: '今天下午三点开会' }],
    ark_data: { ark_name: '小程序', fields: { title: '每日打卡' } },
  }, { selfId: '1' })
  const text = ev.message.find((s) => s.type === 'text').data.text
  assert.match(text, /\[引用\] 今天下午三点开会/)
  assert.match(text, /\[小程序：每日打卡\]/)
})

test('加群 / 加好友通知转成 notice；认不出的事件返回 null', () => {
  assert.equal(toOneBotNotice('GROUP_ADD_ROBOT', { group_openid: 'G1', op_member_openid: 'U1' }).notice_type, 'group_increase')
  assert.equal(toOneBotNotice('FRIEND_ADD', { openid: 'U1' }).notice_type, 'friend_add')
  assert.equal(toOneBotNotice('WHATEVER', {}), null)
  assert.equal(toOneBotEvent('WHATEVER', {}), null)
})

// ---------- 拆条 ----------

test('消息段拆成「文字 + 各自一条附件」：官方一条消息只能装一种', () => {
  const { texts, media } = splitSegments([
    { type: 'reply', data: { id: '1' } },
    { type: 'at', data: { qq: 'U2', name: '小明' } },
    { type: 'text', data: { text: '给你看' } },
    { type: 'image', data: { file: 'base64://AAA' } },
    { type: 'face', data: { id: '1' } },
    { type: 'record', data: { file: '/tmp/a.mp3' } },
  ])
  assert.deepEqual(texts, ['@小明 给你看'])
  assert.equal(media.length, 2)
  assert.equal(media[0].fileType, 1)
  assert.equal(media[1].fileType, 3)
  // 系统表情没有对应关系，宁可去掉也不把 <face:…> 发出去
  assert.ok(!texts.join('').includes('face'))
})

test('长文本按行断开，每段不超过上限', () => {
  const line = '这是一行普普通通的聊天内容。\n'
  const chunks = chunkText(line.repeat(200), 500)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 500, '超长了')
  assert.ok(chunks.join('').replace(/\s/g, '').length > 1000)
})

test('文件来源和 file_type 认得三种写法', () => {
  assert.equal(sourceOf('base64://AAA').kind, 'base64')
  assert.equal(sourceOf('https://x/a.png').kind, 'url')
  assert.equal(sourceOf('D:\\tmp\\a.mp3').kind, 'path')
  assert.equal(fileTypeOf('image/png'), 1)
  assert.equal(fileTypeOf('video/mp4'), 2)
  assert.equal(fileTypeOf('voice'), 3)
  assert.equal(fileTypeOf('application/zip', 'a.zip'), 4)
})

// ---------- 客户端 ----------

/** 一套假网关：token / 接入点 / 发消息都记账，WS 自己驱动。 */
function fakeGateway() {
  const calls = []
  let socket = null
  const fetchFn = async (url, init = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url: u, method: init.method, body })
    if (u.endsWith('/app/getAppAccessToken')) return json({ access_token: 'TK', expires_in: '7200' })
    if (u.endsWith('/gateway')) return json({ url: 'wss://fake/websocket' })
    if (u.endsWith('/v2/generate_url_link')) return json({ data: { url: 'https://qun.qq.com/qunpro/robot/qunshare?robot_appid=1020001&robot_uin=1&data=x' } })
    if (u.includes('/messages')) return json({ id: 'MSG' + calls.length, timestamp: 'now' })
    if (u.includes('/files')) return json({ file_info: 'FILEINFO', ttl: 300 })
    return json({ code: 404, message: 'not found' }, 404)
  }
  const socketFactory = (url) => {
    socket = {
      url,
      sent: [],
      readyState: 1,
      send (s) { this.sent.push(JSON.parse(s)) },
      close () { this.readyState = 3; this.onclose?.({ code: 1000 }) },
      push (payload) { this.onmessage?.({ data: JSON.stringify(payload) }) },
    }
    return socket
  }
  return { fetchFn, socketFactory, calls, socket: () => socket }
}
const json = (v, status = 200) => ({ ok: status < 400, status, json: async () => v })

function bootClient (over = {}) {
  const cfg = {
    gateway: 'qqbot',
    botQQ: '1020001',
    ownerQQ: 'OWNER',
    qqbot: { appId: '1020001', appSecret: 'SECRET', intents: 33554432 },
    ...over,
  }
  const events = []
  const states = []
  const gw = fakeGateway()
  const client = createQqBotClient({
    getConfig: () => cfg,
    log: silent,
    fetchFn: gw.fetchFn,
    socketFactory: gw.socketFactory,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
  })
  return { client, cfg, events, states, gw }
}

/** 走完握手：Hello → Identify → READY。 */
async function handshake (c) {
  const sock = await waitFor(() => c.gw.socket())
  sock.onopen?.()
  sock.push({ op: 10, d: { heartbeat_interval: 45000 } })
  const identify = await waitFor(() => sock.sent.find((p) => p.op === 2))
  sock.push({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1', user: { username: '大肥鱼' } } })
  return identify
}

test('握手：先取 token 再 identify，READY 之后算连上', async () => {
  const c = bootClient()
  c.client.start()
  const identify = await handshake(c)
  assert.equal(identify.d.token, 'QQBot TK')
  assert.equal(identify.d.intents, 33554432)
  assert.ok(c.gw.calls.some((x) => x.url.endsWith('/app/getAppAccessToken')))
  await waitFor(() => c.states.includes('connected'))
  assert.equal(c.client.status().botName, '大肥鱼')
  c.client.stop()
})

test('收到消息会转成 OneBot 事件；同一条重复推送只处理一次', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  const d = { id: 'MID1', author: { user_openid: 'U1', username: '小明' }, content: '在吗' }
  c.gw.socket().push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d })
  await waitFor(() => c.events.length === 1)
  assert.equal(c.events[0].message_type, 'private')
  // 官方会重复推同一条，要按 id 去重
  c.gw.socket().push({ op: 0, s: 3, t: 'C2C_MESSAGE_CREATE', d })
  await tick(30)
  assert.equal(c.events.length, 1)
  c.client.stop()
})

test('回复走被动通道：带 msg_id 和递增的 msg_seq，额度用完就不再带', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  c.gw.socket().push({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'MID2', author: { member_openid: 'U1' }, content: '在吗', group_openid: 'G1' } })
  await waitFor(() => c.events.length === 1)

  const send = (text) => c.client.call('send_group_msg', { group_id: 'G1', message: [{ type: 'text', data: { text } }] })
  await send('第一句')
  await send('第二句')
  const bodies = c.gw.calls.filter((x) => x.url.includes('/v2/groups/G1/messages')).map((x) => x.body)
  assert.equal(bodies[0].msg_id, 'MID2')
  assert.equal(bodies[0].msg_seq, 1)
  assert.equal(bodies[1].msg_seq, 2)

  // 群聊一条消息最多回 5 次：第 6 次开始不带 msg_id（走主动消息）
  for (let i = 0; i < 3; i++) await send('再来')
  await send('第六条')
  const last = c.gw.calls.filter((x) => x.url.includes('/v2/groups/G1/messages')).map((x) => x.body).at(-1)
  assert.equal(last.msg_id, undefined, '额度用完应改走主动消息')
  assert.equal(REPLY_QUOTA.group.maxReplies, 5)
  c.client.stop()
})

test('一条回复里有文字有图片：文字先发，图片单独上传再发', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  await c.client.call('send_private_msg', {
    user_id: 'U1',
    message: [{ type: 'text', data: { text: '给你画好了' } }, { type: 'image', data: { file: 'base64://QUJD' } }],
  })
  const urls = c.gw.calls.map((x) => x.url)
  assert.ok(urls.some((u) => u.endsWith('/v2/users/U1/files')), '应该先上传')
  const sends = c.gw.calls.filter((x) => x.url.endsWith('/v2/users/U1/messages'))
  assert.equal(sends.length, 2)
  assert.equal(sends[0].body.msg_type, 0)
  assert.equal(sends[1].body.msg_type, 7)
  assert.equal(sends[1].body.media.file_info, 'FILEINFO')
  c.client.stop()
})

test('官方没有的接口：明确报「不支持」，不假装成功', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  await assert.rejects(() => c.client.call('get_stranger_info', { user_id: 'U1' }), /不支持/)
  await assert.rejects(() => c.client.call('send_poke', { user_id: 'U1' }), /不支持/)
  // 群成员列表返回空数组：@ 走文字降级，不该让聊天卡住
  assert.deepEqual(await c.client.call('get_group_member_list', { group_id: 'G1' }), [])
  // 「正在输入」没有对应接口，静默成功
  assert.deepEqual(await c.client.call('set_input_status', { user_id: 'U1' }), {})
  c.client.stop()
})

test('默认走官方正式域名', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  const urls = c.gw.calls.map((x) => x.url)
  assert.ok(urls.some((u) => u === 'https://bots.qq.com/app/getAppAccessToken'), '取 token 走 bots.qq.com')
  assert.ok(urls.some((u) => u.startsWith('https://api.bot.qq.com/gateway')), '接入点走 api.bot.qq.com')
  c.client.stop()
})

test('扫码添加：调官方 /v2/generate_url_link 拿分享链接', async () => {
  const c = bootClient()
  c.client.start()
  await handshake(c)
  const url = await c.client.shareLink()
  assert.match(url, /^https:\/\/qun\.qq\.com\/qunpro\/robot\/qunshare/)
  const call = c.gw.calls.find((x) => x.url.endsWith('/v2/generate_url_link'))
  assert.equal(call.method, 'POST')
  c.client.stop()
})

test('二维码：结构对得上官方 qrcode 库（版本/尺寸/定位图案）', async () => {
  const { qrMatrix, qrSvgDataUrl } = await import('../src/qqbot/qr.js')
  const m = qrMatrix('hello', { ecc: 'M' })
  assert.equal(m.size, 21, 'hello 落在版本 1')
  // 三个定位图案的左上角都是黑点，且角上是 7×7 的方框
  for (const [r0, c0] of [[0, 0], [0, 14], [14, 0]]) {
    assert.equal(m.dark(r0, c0), true)
    assert.equal(m.dark(r0 + 1, c0 + 1), false, '定位图案内圈是白的')
    assert.equal(m.dark(r0 + 3, c0 + 3), true, '定位图案中心是黑的')
  }
  const big = qrMatrix('a'.repeat(120), { ecc: 'M' })
  assert.ok(big.size > 21, '长内容会自动升版本')
  const dataUrl = qrSvgDataUrl('hello')
  assert.match(dataUrl, /^data:image\/svg\+xml;charset=utf-8,/)
  assert.match(decodeURIComponent(dataUrl), /<svg[^>]*viewBox="0 0 29 29"/, '21 模块 + 4 边距 = 29')
})

test('取 token 失败：状态变成断开了并带上原因，不会卡在连接中', async () => {  const cfg = { gateway: 'qqbot', botQQ: '', ownerQQ: '', qqbot: { appId: '', appSecret: '', intents: 33554432 } }
  const states = []
  const client = createQqBotClient({
    getConfig: () => cfg,
    log: silent,
    fetchFn: async () => json({ code: 100016, message: 'invalid appid or secret' }),
    socketFactory: () => { throw new Error('不该建 socket') },
    onEvent: () => {},
    onState: (s) => states.push(s),
  })
  client.start()
  await waitFor(() => states.includes('disconnected'))
  assert.match(client.status().lastError, /AppID|AppSecret/)
  client.stop()
})

// 端到端：假 DSH 宿主 + 假 QQ 官方机器人网关，验证「系统 → 连接」里换成官方机器人之后整条链路通。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockQqBot } from './helpers/mock-qqbot.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const APP_ID = '1020001'
const OWNER = 'OWNER_OPENID_AAAA'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 8000) {
  const t = Date.now()
  while (Date.now() - t < ms) {
    const v = await fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error('等不到条件成立')
}

let fake
let mock
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-qqbot-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  mock = await startMockQqBot({ appId: APP_ID })
  // 接口地址指到假网关（模块加载时读环境变量，所以必须在 import host 之前设好）
  process.env.AURABOT_QQBOT_TOKEN_BASE = mock.baseUrl
  process.env.AURABOT_QQBOT_API_BASE = mock.baseUrl
  process.env.AURABOT_QQBOT_CONNECT_HOST = mock.baseUrl
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    gateway: 'qqbot',
    qqbot: { appId: APP_ID, appSecret: 'SECRET' },
    ownerQQ: OWNER,
    allow: { private: [], groups: ['GROUP_A'] },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    group: { interjectChance: 0, burstMax: 50 },
    merge: { waitSec: 0.2, maxSec: 1, groupWaitSec: 0.2, groupMaxSec: 1 },
  }))
  fake = createFakeDsh({ brain: async ({ text }) => (text.includes('在吗') ? '在呢' : '收到') })
  const host = await import('../src/host.js')
  host.apply(fake.ctx)
  await fake.call('/onebot/reconnect')
  await until(() => mock.connected() > 0)
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const c2c = (openid, content, id = 'MID' + Math.floor(Math.random() * 1e6)) => ({
  id,
  author: { id: openid, user_openid: openid, username: '小明' },
  content,
  timestamp: new Date().toISOString(),
})

test('面板状态：平台认成 QQ 官方机器人，AppID / 绑定状态都在', async () => {
  const s = (await fake.call('/state')).json()
  assert.equal(s.onebot.provider, 'qqbot')
  assert.equal(s.qqbot.appId, APP_ID)
  assert.equal(s.qqbot.ownerBound, true)
  assert.equal(s.onebot.state, 'connected')
})

test('单聊来一句：走被动通道回（带 msg_id 和 msg_seq）', async () => {
  mock.push('C2C_MESSAGE_CREATE', c2c(OWNER, '在吗', 'MID_C2C'), 20)
  const sent = await until(() => {
    const list = mock.sent('private', OWNER)
    return list.length ? list : null
  })
  const body = sent[0].body
  assert.equal(body.msg_type, 0)
  assert.equal(body.content, '在呢')
  assert.equal(body.msg_id, 'MID_C2C')
  assert.ok(body.msg_seq >= 1)
  // 请求头得是官方那套鉴权
  assert.match(sent[0].auth, /^QQBot /)
})

test('群里被 @：回到群里，且带上被 @ 那条消息的 msg_id', async () => {
  mock.push('GROUP_AT_MESSAGE_CREATE', {
    id: 'MID_GROUP',
    author: { id: 'M1', member_openid: 'M1', username: '小红', member_role: 'member' },
    content: '在吗',
    group_openid: 'GROUP_A',
    timestamp: new Date().toISOString(),
  }, 21)
  const sent = await until(() => {
    const list = mock.sent('group', 'GROUP_A')
    return list.length ? list : null
  })
  assert.equal(sent[0].body.msg_id, 'MID_GROUP')
  assert.equal(sent[0].body.content, '在呢')
})

test('不在白名单的群：不理，也不报错', async () => {
  const before = mock.sent('group', 'GROUP_B').length
  mock.push('GROUP_AT_MESSAGE_CREATE', {
    id: 'MID_GROUP_B',
    author: { id: 'M2', member_openid: 'M2', username: '路人' },
    content: '在吗',
    group_openid: 'GROUP_B',
    timestamp: new Date().toISOString(),
  }, 22)
  await sleep(600)
  assert.equal(mock.sent('group', 'GROUP_B').length, before)
})

test('扫码添加：面板接口返回分享链接 + 二维码', async () => {
  const r = (await fake.call('/qqbot/share', {})).json()
  assert.equal(r.ok, true)
  assert.match(r.url, /qunshare\?robot_appid=1020001/)
  assert.match(r.qr, /^data:image\/svg\+xml;charset=utf-8,/)
})

test('配对码：陌生人发码过来就认成主人，并回一句确认', async () => {
  const pair = (await fake.call('/qqbot/pair')).json()
  assert.match(pair.code, /^\d{6}$/)
  mock.push('C2C_MESSAGE_CREATE', c2c('STRANGER_OPENID', pair.code, 'MID_PAIR'), 23)
  await until(() => mock.sent('private', 'STRANGER_OPENID').length > 0)
  const s = (await fake.call('/state')).json()
  assert.equal(s.config.ownerQQ, 'STRANGER_OPENID')
  // 认主之后，白名单里也顺手能看到这个会话
  assert.ok(s.qqbot.seen.some((x) => x.id === 'STRANGER_OPENID'))
})

test('扫码连接：出二维码 → 轮询到完成 → AppID 存好、扫码的人自动当主人', async () => {
  const start = (await fake.call('/qqbot/qr/start', {})).json()
  assert.equal(start.ok, true)
  assert.match(start.qr, /^data:image\/svg\+xml;charset=utf-8,/)
  assert.match(start.url, /connect\.html\?task_id=/)

  const pending = (await fake.call('/qqbot/qr/poll', { taskId: start.taskId })).json()
  assert.equal(pending.status, 'waiting')

  mock.state.bindScanned = true
  const done = (await fake.call('/qqbot/qr/poll', { taskId: start.taskId })).json()
  assert.equal(done.status, 'done')
  assert.equal(done.appId, APP_ID)
  assert.equal(done.owner, 'SCAN_OWNER')

  const st = (await fake.call('/state')).json()
  assert.equal(st.qqbot.appId, APP_ID)
  assert.equal(st.config.ownerQQ, 'SCAN_OWNER')

  // 用过的任务不能再用
  const again = (await fake.call('/qqbot/qr/poll', { taskId: start.taskId })).json()
  assert.equal(again.status, 'unknown')
})

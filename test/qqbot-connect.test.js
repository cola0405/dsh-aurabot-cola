// 扫码连接协议：建任务 / 轮询 / 解密钥。用假 fetch，不碰真 q.qq.com。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { createBindTask, pollBindResult, connectUrl, decryptSecret, BIND_STATUS } from '../src/qqbot/connect.js'

/** 按官方那套格式造一个 bot_encrypt_secret：base64(iv[12] + ciphertext + tag[16])。 */
function encryptSecret (secret, keyBase64) {
  const key = Buffer.from(keyBase64, 'base64')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()])
  return Buffer.concat([iv, body, c.getAuthTag()]).toString('base64')
}

function fakeFetch (answer) {
  const calls = []
  const fn = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url: String(url), body })
    const r = answer(String(url), body)
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json }
  }
  fn.calls = calls
  return fn
}

test('建任务：POST /lite/create_bind_task，返回 task_id 和一个本地 32 字节密钥', async () => {
  const fetchFn = fakeFetch(() => ({ json: { retcode: 0, data: { task_id: 'TASK-1' } } }))
  const { taskId, key } = await createBindTask({ fetchFn })
  assert.equal(taskId, 'TASK-1')
  assert.equal(Buffer.from(key, 'base64').length, 32, '密钥要 32 字节')
  assert.equal(fetchFn.calls[0].url, 'https://q.qq.com/lite/create_bind_task')
  assert.equal(fetchFn.calls[0].body.key, key, '密钥要带给官方')
})

test('建任务失败：retcode 非 0 直接抛，别拿着空 task_id 去画二维码', async () => {
  const fetchFn = fakeFetch(() => ({ json: { retcode: 10001, msg: '参数异常' } }))
  await assert.rejects(() => createBindTask({ fetchFn }), /参数异常/)
})

test('二维码链接：官方绑定页 + task_id + source', () => {
  const url = connectUrl('TASK-1')
  assert.match(url, /^https:\/\/q\.qq\.com\/qqbot\/openclaw\/connect\.html\?task_id=TASK-1&source=aurabot&_wv=2$/)
})

test('轮询：没扫 / 已扫待确认 / 完成 三种状态', async () => {
  const key = randomBytes(32).toString('base64')
  let status = BIND_STATUS.NONE
  const fetchFn = fakeFetch(() => ({ json: { retcode: 0, data: { status } } }))
  assert.equal((await pollBindResult('TASK-1', key, { fetchFn })).status, BIND_STATUS.NONE)
  status = BIND_STATUS.PENDING
  assert.equal((await pollBindResult('TASK-1', key, { fetchFn })).status, BIND_STATUS.PENDING)
  status = BIND_STATUS.EXPIRED
  assert.equal((await pollBindResult('TASK-1', key, { fetchFn })).status, BIND_STATUS.EXPIRED)
})

test('轮询到完成：AppSecret 解出来，顺便带回扫码者 openid（就是主人）', async () => {
  const key = randomBytes(32).toString('base64')
  const secret = 'AppSecret_测试_9f8e7d'
  const fetchFn = fakeFetch(() => ({ json: { retcode: 0, data: {
    status: BIND_STATUS.COMPLETED,
    bot_appid: '1020001',
    bot_encrypt_secret: encryptSecret(secret, key),
    user_openid: 'OPENID_OWNER',
  } } }))
  const r = await pollBindResult('TASK-1', key, { fetchFn })
  assert.equal(r.appId, '1020001')
  assert.equal(r.appSecret, secret)
  assert.equal(r.userOpenid, 'OPENID_OWNER')
})

test('解密钥：密钥不对要报错，不能静默给个空串', () => {
  const key = randomBytes(32).toString('base64')
  const payload = encryptSecret('secret', key)
  assert.equal(decryptSecret(payload, key), 'secret')
  assert.throws(() => decryptSecret(payload, randomBytes(32).toString('base64')), /unable to authenticate|bad decrypt/i)
  assert.equal(decryptSecret('', key), '')
  assert.throws(() => decryptSecret(payload, 'short'), /32 字节/)
})

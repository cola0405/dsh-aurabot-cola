// 恢复备份时不能把「能连上 QQ 的那套连接」换掉。
//
// 起因（线上真实踩到）：一份很早打的包（gateway=snowluma、ownerQQ 空、没有 AppSecret）被导入后，
// 把当时正确连着的 QQ 官方机器人配置整个盖掉——之后所有消息都被当成陌生人静默丢掉。
// 这里守两件事：旧包先问一句；真恢复时连接层面的字段只「补」不「清」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'aurabot-restore-'))
process.env.AURABOT_DATA_DIR = dataDir
process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')

const { createBackup, stageRestore, applyPendingRestore, usableConnection } = await import('../src/core/backup.js')

const OPENID = '83CBF23F831270F285EFEFCF4AC57913'
const APPID = '1906403029'
const SECRET = 'secret-should-survive'

const configFile = join(dataDir, 'config.json')
const pendingFile = join(dataDir, '.restore-pending.json')

const writeConfig = (cfg) => writeFileSync(configFile, JSON.stringify(cfg, null, 2))
const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'))

/** 已经配好的 QQ 官方机器人：这就是不能被旧包覆盖的那份。 */
const GOOD = {
  enabled: true,
  dryRun: false,
  setupDone: true,
  gateway: 'qqbot',
  botQQ: APPID,
  ownerQQ: OPENID,
  qqbot: { appId: APPID, appSecret: SECRET, intents: 33554432 },
  allow: { private: [], groups: [] },
  persona: { current: 'default' },
}

/** 很早以前的那份：SnowLuma、没绑主人、没有 AppSecret。 */
const OLD = {
  enabled: true,
  dryRun: true,
  setupDone: false,
  gateway: 'snowluma',
  botQQ: '',
  ownerQQ: '',
  qqbot: { appId: '', appSecret: '', intents: 33554432 },
  allow: { private: [], groups: [] },
  persona: { current: 'default' },
}

/** 拿 OLD 打一个一小时前的包，然后把当前配置换回 GOOD。 */
async function oldBackup() {
  writeConfig(OLD)
  const made = await createBackup({ version: '1.3.3', workspaceDir: '', now: new Date(Date.now() - 3600_000) })
  writeConfig(GOOD)
  return made.file
}

test('usableConnection 只看「真的能连上」的配置', () => {
  assert.equal(usableConnection(GOOD), 'qqbot')
  assert.equal(usableConnection(OLD), '')
  assert.equal(usableConnection({ gateway: 'onebot', snowluma: { wsUrl: 'ws://127.0.0.1:3001' } }), 'onebot')
  assert.equal(usableConnection({ gateway: 'snowluma', botQQ: '123456', ownerQQ: '654321' }), 'snowluma')
  assert.equal(usableConnection({ gateway: 'qqbot', qqbot: { appId: APPID } }), '', '缺 AppSecret 不算能连')
})

test('旧包会清掉主人和密钥：先不落地，把要丢的东西列出来', async () => {
  const zip = await oldBackup()
  const r = await stageRestore(zip)
  assert.equal(r.ok, false)
  assert.equal(r.needConfirm, true)
  assert.ok(r.warnings.length >= 2, '至少要提示「更旧」和「没有能用的连接」')
  assert.ok(r.warnings.some((w) => w.includes('还旧')), r.warnings.join('|'))
  assert.ok(r.warnings.some((w) => w.includes('连不上')), r.warnings.join('|'))
  assert.ok(r.warnings.some((w) => w.includes('主人绑定')), r.warnings.join('|'))
  assert.ok(r.file, '确认后要能拿这个路径直接重来，不用重传')
  assert.equal(existsSync(pendingFile), false, '没确认就不能写待恢复标记')
  assert.equal(readConfig().gateway, 'qqbot', '当前配置不能被动到')
})

test('确认后恢复：记忆人设照换，QQ 连接保住', async () => {
  const zip = await oldBackup()
  const forced = await stageRestore(zip, { force: true })
  assert.equal(forced.ok, true, forced.message)
  assert.equal(existsSync(pendingFile), true)

  const files = applyPendingRestore()
  assert.ok(files > 0)
  const cfg = readConfig()
  assert.equal(cfg.gateway, 'qqbot', '网关不能被旧包退回 snowluma')
  assert.equal(cfg.botQQ, APPID)
  assert.equal(cfg.ownerQQ, OPENID, '主人绑定不能被清空')
  assert.equal(cfg.qqbot.appId, APPID)
  assert.equal(cfg.qqbot.appSecret, SECRET, 'AppSecret 不能被清掉')
  assert.equal(cfg.setupDone, true)
  assert.equal(existsSync(pendingFile), false)
})

test('新机器第一次恢复：现在的配置本来就连不上，不该拦', async () => {
  writeConfig({ ...OLD, gateway: 'snowluma' })
  const zip = await oldBackup()
  writeConfig({ ...OLD })
  const r = await stageRestore(zip)
  assert.equal(r.ok, true, '连不上 QQ 的机器上恢复备份是正常用法')
  assert.deepEqual(r.warnings, [])
  assert.equal(existsSync(pendingFile), true)
  // 收尾：清掉这次留下的待恢复标记，免得影响后面的用例
  applyPendingRestore()
})

test('包里连接是全的：不拦，人格和开关按包里的来', async () => {
  writeConfig(GOOD)
  const incoming = { ...GOOD, enabled: false, persona: { current: 'other' } }
  writeConfig(incoming)
  const made = await createBackup({ version: '1.3.3', workspaceDir: '', now: new Date() })
  writeConfig(GOOD)
  const r = await stageRestore(made.file)
  assert.deepEqual(r.warnings, [], '连接是全的就不该拦')
  applyPendingRestore()
  const cfg = readConfig()
  assert.equal(cfg.persona.current, 'other', '人格应该是包里的')
  assert.equal(cfg.enabled, false, '开关应该是包里的')
  assert.equal(cfg.qqbot.appSecret, SECRET)
})

test('同一个网关但包里没绑主人：问一句，恢复时只把主人补回来', async () => {
  writeConfig(GOOD)
  writeConfig({ ...GOOD, ownerQQ: '' })
  const made = await createBackup({ version: '1.3.3', workspaceDir: '', now: new Date() })
  writeConfig(GOOD)
  const r = await stageRestore(made.file)
  assert.equal(r.needConfirm, true)
  assert.ok(r.warnings.some((w) => w.includes('主人绑定')), r.warnings.join('|'))
  assert.equal(r.warnings.length, 1, '密钥和机器人号都在，别多报：' + r.warnings.join('|'))
  assert.equal((await stageRestore(made.file, { force: true })).ok, true)
  applyPendingRestore()
  const cfg = readConfig()
  assert.equal(cfg.ownerQQ, OPENID, '包里没主人就留现在的')
  assert.equal(cfg.qqbot.appSecret, SECRET, '包里没密钥就留现在的')
})

// 面板「连接」页在 QQ 官方机器人模式下的源码契约：
// 扫码优先、手动填第二；只留必要卡片；没有沙箱开关（按用户要求去掉）。
// 客户端是单文件、没有构建产物，只能对源码断言；这样以后重构把哪块丢了会直接红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('网关三选一里有 QQ 官方机器人', () => {
  assert.ok(src.includes("{ value: 'qqbot', label: '接 QQ 官方机器人'"), '缺官方机器人选项')
})

test('扫码连接是第一选项，手动填 AppID 排第二', () => {
  const i = src.indexOf('function QqBotLink(')
  assert.ok(i > 0, '缺「怎么连」组件 QqBotLink')
  const body = src.slice(i, i + 900)
  const qr = body.indexOf("{ value: 'qr'")
  const manual = body.indexOf("{ value: 'manual'")
  assert.ok(qr > 0 && manual > qr, '扫码必须排在手动前面')
  assert.ok(body.includes('扫码连接（推荐）'), '扫码要标成推荐')
})

test('扫码走 /qqbot/qr/start + /qqbot/qr/poll，二维码渲染成图片', () => {
  assert.ok(src.includes("post('/qqbot/qr/start'"), '没接扫码建任务接口')
  assert.ok(src.includes("post('/qqbot/qr/poll'"), '没接扫码轮询接口')
  assert.ok(src.includes("h('img', { src: qr.qr"), '二维码没渲染成图片')
})

test('官方机器人模式三张卡：接上 QQ / 把她加进 QQ / 谁能跟她说话', () => {
  const start = src.indexOf("official ? h(Fragment, null,")
  const end = src.indexOf("h(Card, { title: '接上 QQ（SnowLuma）'")
  const branch = src.slice(start, end)
  for (const t of ['接上 QQ（官方机器人）', '把她加进 QQ', '谁能跟她说话']) {
    assert.ok(branch.includes(`title: '${t}'`), `官方模式下缺「${t}」卡片`)
  }
  assert.ok(!branch.includes('title: \'认主人\''), '认主人不该再单独占一张卡（扫码已经自动认了）')
})

test('官方机器人模式不显示 SnowLuma / 工作区搬家 / 远端桌宠', () => {
  assert.ok(src.includes("official ? null : h(Card, { title: 'QQ 会话放在哪'"), '工作区卡片要按模式隐藏')
  assert.ok(src.includes('official ? null : (() => {'), '远端桌宠卡片要按模式隐藏')
  const start = src.indexOf("official ? h(Fragment, null,")
  const end = src.indexOf("h(Card, { title: '接上 QQ（SnowLuma）'")
  const branch = src.slice(start, end)
  assert.ok(!branch.includes('SnowLumaAuth'), '官方分支混进了 SnowLuma 授权组件')
  assert.ok(!branch.includes('snowluma.dir'), '官方分支混进了 SnowLuma 目录字段')
})

test('没有沙箱开关了', () => {
  assert.ok(!src.includes('qqbot.sandbox'), '面板里不该再有沙箱开关')
})

// 首次安装不再强制走设置向导：打开插件就是正常的配置面板，向导改成「想按步骤来再自己点开」。
// 客户端是单文件源码（数据目录里没有构建产物），只能在源码上断言接线，和 about-panel 等测试一致。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')

test('默认落到配置面板，不再按 setupDone 强制进向导', () => {
  assert.ok(src.includes('const showWizard = wizardOpen'), '面板默认入口必须是配置界面')
  assert.ok(!/showWizard\s*=\s*!cfg\.setupDone/.test(src), '别再拿 setupDone 把首次进入拦到向导里')
})

test('向导仍然能手动打开，并且随时能关掉', () => {
  assert.ok(src.includes('openWizard: () => setWizardOpen(true)'), '缺「打开向导」的入口')
  assert.ok(src.includes('onClose: () => setWizardOpen(false)'), '缺「关闭向导」的回调')
  assert.ok(src.includes("'走一遍设置向导'"), '「连接」页要有走向导的按钮')
  assert.ok(src.includes("'重新走一遍设置向导'"), '走过向导的用户给「重新走一遍」的文案')
})

test('没配过的用户能在概览页看到向导提示，配好后自动不再提示', () => {
  assert.ok(src.includes('const provisioned = Boolean(cfg.botQQ && cfg.ownerQQ && cfg.botQQ !== cfg.ownerQQ)'), '缺「配好了没有」的判断')
  assert.ok(src.includes('!cfg.setupDone && !provisioned'), '首次引导提示要以「没走完向导且还没配好」为条件')
})

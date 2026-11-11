// 测试用的假 QQ 官方机器人网关：token / 接入点 / 发消息 / 富媒体上传 + WebSocket 推送。
// 协议按 bot.q.qq.com api-v2 写：连上先给 Hello(op 10)，客户端 Identify(op 2)，回 READY(op 0)。
import http from 'node:http'
import { createHash, createCipheriv } from 'node:crypto'

function wsAccept (key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}

function encodeFrame (str) {
  const payload = Buffer.from(str, 'utf8')
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x81, len])
  else if (len < 65536) {
    head = Buffer.alloc(4)
    head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([head, payload])
}

function decodeFrames (buf) {
  const out = []
  let i = 0
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f
    let len = buf[i + 1] & 0x7f
    const masked = buf[i + 1] & 0x80
    let p = i + 2
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 } else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8 }
    let mask
    if (masked) { mask = buf.subarray(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    const data = Buffer.from(buf.subarray(p, p + len))
    if (mask) for (let k = 0; k < data.length; k++) data[k] ^= mask[k % 4]
    out.push({ op, data })
    i = p + len
  }
  return { frames: out, rest: buf.subarray(i) }
}

export async function startMockQqBot ({ appId = '1020001', botName = '大肥鱼', secret = 'SECRET' } = {}) {
  const calls = [] // { method, path, body }
  const sockets = new Set()
  const state = { failSend: null, seq: 0, bindKey: '', bindScanned: false }

  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const body = raw ? JSON.parse(raw) : null
    const path = req.url.split('?')[0]
    calls.push({ method: req.method, path, body, auth: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    const send = (v, status = 200) => { res.statusCode = status; res.end(JSON.stringify(v)) }

    if (path === '/app/getAppAccessToken') {
      if (body?.appId !== appId || body?.clientSecret !== secret) return send({ code: 100016, message: 'invalid appid or secret' }, 401)
      return send({ access_token: 'TK', expires_in: '7200' })
    }
    if (path === '/gateway') return send({ url: `ws://127.0.0.1:${server.address().port}/websocket` })
    // 扫码连接（q.qq.com 那套 lite 接口）
    if (path === '/lite/create_bind_task') {
      state.bindKey = String(body?.key || '')
      return send({ retcode: 0, data: { task_id: 'TASK-1' } })
    }
    if (path === '/lite/poll_bind_result') {
      if (!state.bindScanned) return send({ retcode: 0, data: { status: 1 } })
      const key = Buffer.from(state.bindKey, 'base64')
      const iv = Buffer.from('00112233445566778899aabb', 'hex')
      const c = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([c.update('SCANNED_SECRET', 'utf8'), c.final()])
      const secret = Buffer.concat([iv, enc, c.getAuthTag()]).toString('base64')
      return send({ retcode: 0, data: { status: 2, bot_appid: appId, bot_encrypt_secret: secret, user_openid: 'SCAN_OWNER' } })
    }
    if (path === '/v2/generate_url_link') return send({ data: { url: `https://qun.qq.com/qunpro/robot/qunshare?robot_appid=${appId}&robot_uin=12345678&data=x` } })
    if (/\/files$/.test(path)) return send({ file_info: 'FILE_INFO', ttl: 300 })
    if (/\/messages$/.test(path)) {
      if (state.failSend) return send(state.failSend, 400)
      return send({ id: 'SENT' + ++state.seq, timestamp: 'now' })
    }
    send({ code: 404, message: 'not found' }, 404)
  })

  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`)
    sockets.add(socket)
    // 一连上就发 Hello
    socket.write(encodeFrame(JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } })))
    let pending = Buffer.alloc(0)
    socket.on('data', (d) => {
      pending = Buffer.concat([pending, d])
      const { frames, rest } = decodeFrames(pending)
      pending = rest
      for (const f of frames) {
        if (f.op === 8) { socket.end(); return }
        if (f.op !== 1) continue
        const m = JSON.parse(f.data.toString('utf8'))
        calls.push({ method: 'WS', path: 'ws', body: m })
        if (m.op === 2) {
          socket.write(encodeFrame(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'S1', user: { id: appId, username: botName, bot: true } } })))
        }
        if (m.op === 6) {
          socket.write(encodeFrame(JSON.stringify({ op: 0, s: 2, t: 'RESUMED', d: '' })))
        }
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    appId,
    secret,
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    state,
    connected: () => sockets.size,
    /** 推一个事件下去（模拟平台下发）。 */
    push (type, d, seq = 10) {
      const payload = encodeFrame(JSON.stringify({ op: 0, s: seq, t: type, d }))
      for (const s of sockets) s.write(payload)
    },
    sent: (kind, targetId) => calls.filter((c) => c.method === 'POST' && c.path === (kind === 'group' ? `/v2/groups/${targetId}/messages` : `/v2/users/${targetId}/messages`)),
    async close () {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

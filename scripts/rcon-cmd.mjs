import { Socket } from 'node:net'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25575)
const password = process.argv[4] ?? ''
const command = process.argv.slice(5).join(' ') || 'list'

const TYPE_AUTH = 3
const TYPE_CMD = 2

function pack (id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const len = 4 + 4 + payload.length + 2
  const buf = Buffer.alloc(4 + len)
  buf.writeInt32LE(len, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  buf.writeInt16LE(0, 12 + payload.length)
  return buf
}

const sock = new Socket()
let buffer = Buffer.alloc(0)
let authed = false

sock.on('connect', () => sock.write(pack(1, TYPE_AUTH, password)))

sock.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const len = buffer.readInt32LE(0)
    if (buffer.length < 4 + len) break
    const id = buffer.readInt32LE(4)
    const body = buffer.subarray(12, 4 + len - 2).toString('utf8')
    buffer = buffer.subarray(4 + len)
    if (!authed) {
      if (id === -1) { console.error('rcon auth failed'); process.exit(1) }
      authed = true
      sock.write(pack(2, TYPE_CMD, command))
      setTimeout(() => sock.end(), 500)
    } else {
      process.stdout.write(body.replace(/§./g, ''))
    }
  }
})

sock.on('error', (e) => { console.error('rcon error:', e.message); process.exit(1) })
sock.on('close', () => process.exit(0))
sock.connect({ host, port })

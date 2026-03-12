/**
 * Minimal WebSocket server — zero dependencies.
 * Implements RFC 6455 enough for text frames + close.
 */

import { createHash } from 'node:crypto';

const MAGIC = '258EAFA5-E914-47DA-95CA-5AB5AFDC65B2';

export class WebSocketServer {
  constructor() {
    this._clients = new Set();
  }

  handleUpgrade(req, socket, head, callback) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const accept = createHash('sha1')
      .update(key + MAGIC)
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
    );

    const ws = new WebSocket(socket);
    this._clients.add(ws);
    ws.on('close', () => this._clients.delete(ws));

    if (head && head.length) socket.unshift(head);
    callback(ws);
  }
}

class WebSocket {
  constructor(socket) {
    this._socket = socket;
    this._listeners = {};
    this.readyState = 1; // OPEN

    socket.on('data', (buf) => this._onData(buf));
    socket.on('close', () => { this.readyState = 3; this._emit('close'); });
    socket.on('error', () => { this.readyState = 3; this._emit('close'); });
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(data, 'utf8');
    const frame = this._encodeFrame(payload);
    this._socket.write(frame);
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  _emit(event, ...args) {
    for (const fn of (this._listeners[event] || [])) fn(...args);
  }

  _onData(buf) {
    // Minimal frame parser — text frames only
    let offset = 0;
    while (offset < buf.length) {
      if (buf.length - offset < 2) break;

      const byte1 = buf[offset];
      const byte2 = buf[offset + 1];
      const opcode = byte1 & 0x0f;
      const masked = (byte2 & 0x80) !== 0;
      let payloadLen = byte2 & 0x7f;
      offset += 2;

      if (payloadLen === 126) {
        if (buf.length - offset < 2) break;
        payloadLen = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buf.length - offset < 8) break;
        payloadLen = Number(buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (buf.length - offset < 4) break;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }

      if (buf.length - offset < payloadLen) break;
      const payload = buf.slice(offset, offset + payloadLen);
      offset += payloadLen;

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        this.readyState = 2;
        this._socket.end(this._encodeFrame(Buffer.alloc(0), 0x08));
        this.readyState = 3;
        this._emit('close');
        return;
      }

      if (opcode === 0x09) {
        // Ping → Pong
        this._socket.write(this._encodeFrame(payload, 0x0a));
        continue;
      }

      if (opcode === 0x01) {
        // Text frame
        this._emit('message', payload.toString('utf8'));
      }
    }
  }

  _encodeFrame(payload, opcode = 0x01) {
    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    return Buffer.concat([header, payload]);
  }
}

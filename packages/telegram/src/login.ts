import { createConnection } from 'node:net';

export type LoginCommand = 'start' | 'code' | 'password';

/** One request per connection. Payload is never persisted by this client. */
export function sendLoginCommand(command: LoginCommand, value = '', socketPath = process.env.TELEGRAM_LOGIN_SOCKET ?? './data/telegram-login.sock'):
  Promise<{ ok: boolean; state?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Telegram 登录 worker 响应超时')); }, 30_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(JSON.stringify({ command, value }) + '\n'));
    socket.on('data', chunk => { response += chunk; if (response.length > 8192) socket.destroy(new Error('响应过大')); });
    socket.on('end', () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(response)); } catch { reject(new Error('Telegram 登录 worker 响应无效')); }
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

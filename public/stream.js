// The browser reconnects for a fresh 30-second snapshot after a broken connection.
export function openStream({ onConnection, onMessage, url, Socket = WebSocket,
  retry = (fn, ms) => setTimeout(fn, ms) }) {
  url ??= (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  let delay = 250;
  let closed = false;
  let socket;
  function connect() {
    if (closed) return;
    socket = new Socket(url);
    socket.addEventListener('open', () => { delay = 250; onConnection(true); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      onMessage(message);
    });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      onConnection(false);
      if (!closed) {
        retry(connect, delay);
        delay = Math.min(delay * 2, 4000);
      }
    });
  }
  connect();
  return () => { closed = true; socket.close(); };
}

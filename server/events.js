/**
 * Server-Sent Events: pushes live speaker state to every open app so volume,
 * now playing, presets etc. update instantly on all phones.
 */
export class EventHub {
  constructor(getState) {
    this.clients = new Set();
    this.getState = getState;
    this.keepAlive = setInterval(() => {
      for (const res of this.clients) res.write(': ping\n\n');
    }, 20000);
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    this.clients.add(res);
    this.sendTo(res, 'state', this.getState());
    req.on('close', () => this.clients.delete(res));
  }

  sendTo(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const res of this.clients) this.sendTo(res, event, data);
  }

  close() {
    clearInterval(this.keepAlive);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

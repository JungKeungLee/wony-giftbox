// gift/realtime.js
// Server-Sent Events(SSE)로 관리자 화면과 OBS 오버레이에 실시간 이벤트를 보냅니다.
// (backup/server.js에서 쓰던 SSE 방식과 같습니다)
//
// SSE를 고른 이유:
// - 오버레이는 "받기만" 하면 되므로 양방향 WebSocket이 필요 없습니다.
// - 브라우저의 EventSource가 연결이 끊기면(OBS 새로고침, 서버 재시작) 자동으로 다시 연결합니다.
// - 추가 패키지가 필요 없습니다.
//
// 메시지 형식: data: {"type":"DONATION_RECEIVED","seq":12,"at":"...","state":{...}, ...}

const HEARTBEAT_MS = 25000;

function createRealtimeHub() {
  const clients = new Set();
  let seq = 0;

  function send(res, message) {
    res.write(`id: ${message.seq}\ndata: ${JSON.stringify(message)}\n\n`);
  }

  // 새 연결을 받습니다. 현재 상태를 STATE_SYNC로 즉시 한 번 보내줘서,
  // 새로고침/재연결 직후에도 화면이 바로 현재 회차 상태를 그리게 합니다.
  // sendSnapshot(write): 상태를 조회해서 write(state)를 호출하는 함수 (giftEventService의 전송 순서에 맞춰 실행)
  function handleConnection(req, res, sendSnapshot) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 등 프록시가 버퍼링하지 않도록
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n'); // 끊기면 2초 후 재연결

    clients.add(res);
    let closed = false;
    req.on('close', () => {
      closed = true;
      clients.delete(res);
    });

    Promise.resolve()
      .then(() => sendSnapshot((state) => {
        if (!closed) send(res, { type: 'STATE_SYNC', seq, at: new Date().toISOString(), state });
      }))
      .catch((error) => console.error('[gift] STATE_SYNC 전송 실패:', error.message));
  }

  function publish(type, payload = {}) {
    seq += 1;
    const message = { ...payload, type, seq, at: new Date().toISOString() };
    for (const res of clients) {
      try {
        send(res, message);
      } catch (error) {
        clients.delete(res);
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': heartbeat\n\n');
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  return { handleConnection, publish, clientCount: () => clients.size };
}

module.exports = { createRealtimeHub };

// soop/connector/connector.js
// /soop-connector 화면입니다. 핵심 로직은 connectorCore.js에 있고, 여기서는 공식 SDK/서버 API를 연결하고 화면만 그립니다.
// 서버 인증은 HttpOnly 쿠키로만 하므로 이 파일에는 Client Secret도, OPERATOR_TOKEN도 없습니다.
// (Chat SDK가 요구하는 Access Token만 서버에서 받아 SDK에 넘깁니다)

(function () {
  'use strict';

  var AUTO_CONNECT_KEY = 'soopConnector.autoConnect';
  var RESULT_LABELS = { COUNTED: '집계', IGNORED: '미집계(수집 중 아님)', EXCLUDED: '제외', REJECTED: '거절', DUPLICATE: '중복' };
  var $ = function (id) { return document.getElementById(id); };

  function storage(action, value) {
    try {
      if (action === 'get') return localStorage.getItem(AUTO_CONNECT_KEY) === '1';
      if (value) localStorage.setItem(AUTO_CONNECT_KEY, '1');
      else localStorage.removeItem(AUTO_CONNECT_KEY);
    } catch (e) { /* 저장소를 못 쓰면 자동 재연결만 꺼집니다 */ }
    return false;
  }

  function request(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var error = new Error(data.error || ('HTTP ' + res.status));
          error.status = res.status;
          throw error;
        }
        return data;
      });
    });
  }

  var api = {
    getSession: function () { return request('GET', '/api/soop/session'); },
    refreshToken: function () { return request('POST', '/api/soop/token/refresh'); },
    postStatus: function (body) { return request('POST', '/api/soop/status', body); },
    postBalloon: function (body) { return request('POST', '/api/soop/balloon', body); },
    logout: function () { return request('POST', '/api/soop/logout'); },
  };

  function createSdk(clientId) {
    if (!window.SOOP || !window.SOOP.ChatSDK) {
      throw new Error('SOOP 공식 Chat SDK 스크립트를 불러오지 못했습니다. 네트워크/광고 차단 설정을 확인해주세요.');
    }
    // Client Secret 없이 생성합니다. (공식 문서: Client Secret은 생략 가능, 토큰 발급은 서버가 담당)
    return new window.SOOP.ChatSDK(clientId);
  }

  function formatTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '-' : d.toLocaleTimeString('ko-KR', { hour12: false });
  }

  function cell(text, className) {
    var td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function render(s) {
    $('disconnectedView').hidden = s.oauthConnected;
    $('connectedView').hidden = !s.oauthConnected;
    $('notConfigured').hidden = s.configured;
    $('loginBtn').hidden = !s.configured;

    $('oauthPill').textContent = s.oauthConnected ? '연결됨' : '연결 안 됨';
    $('oauthPill').dataset.state = s.oauthConnected ? 'ON' : 'OFF';
    $('bjName').textContent = s.bjNickname ? s.bjNickname + (s.bjId ? ' (' + s.bjId + ')' : '') : (s.bjId || '방송 연결 후 표시');
    $('sdkPill').textContent = s.sdkState;
    $('sdkPill').dataset.state = s.sdkState;
    $('connectBtn').disabled = s.sdkState === 'CONNECTING' || s.sdkState === 'CONNECTED';
    $('disconnectBtn').disabled = !s.wantConnected && s.sdkState !== 'CONNECTED';

    $('errorLine').hidden = !s.lastError;
    $('errorLine').textContent = s.lastError || '';
    $('pendingLabel').textContent = s.pending ? '전송 대기 ' + s.pending + '건' : '';

    var tbody = $('recentTable');
    tbody.textContent = '';
    if (!s.recent.length) {
      var tr = document.createElement('tr');
      var td = cell('아직 받은 별풍선이 없습니다.', 'empty');
      td.colSpan = 4;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    s.recent.forEach(function (item) {
      var row = document.createElement('tr');
      row.appendChild(cell(item.nickname));
      row.appendChild(cell(item.count.toLocaleString('ko-KR') + '개'));
      row.appendChild(cell(formatTime(item.at)));
      var label = RESULT_LABELS[item.result] || item.result;
      row.appendChild(cell(item.note && item.result !== 'COUNTED' ? label + ' · ' + item.note : label, 'result-' + item.result));
      tbody.appendChild(row);
    });
  }

  var core = new window.SoopConnectorCore.SoopConnectorCore({ createSdk: createSdk, api: api, onChange: render });

  $('redirectUri').textContent = location.origin + '/soop-connector/callback';

  $('connectBtn').addEventListener('click', function () {
    storage('set', true);
    core.connect();
  });
  $('disconnectBtn').addEventListener('click', function () {
    storage('set', false);
    core.disconnect();
  });
  $('logoutBtn').addEventListener('click', function () {
    if (!confirm('SOOP 계정 연결을 끊을까요? 다시 쓰려면 [SOOP 계정 연결]을 해야 합니다.')) return;
    storage('set', false);
    core.logout().catch(function (error) { alert(error.message); });
  });

  // 방송 중 실수로 닫는 것을 막습니다.
  window.addEventListener('beforeunload', function (event) {
    if (core.sdkState === 'CONNECTED' || core.queue.length) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  core.loadSession().then(function (session) {
    // 새로고침/재접속 시, 직전에 [방송 연결] 상태였다면 자동으로 다시 연결합니다.
    if (session.connected && storage('get')) core.connect();
  }).catch(function (error) {
    core.lastError = '서버 상태를 불러오지 못했습니다: ' + error.message;
    core.emit();
  });
})();

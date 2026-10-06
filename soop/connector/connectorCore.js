// soop/connector/connectorCore.js
// /soop-connector 페이지의 핵심 로직입니다. 브라우저와 Node(테스트)에서 같은 코드를 씁니다.
//
// - Chat SDK는 createSdk(clientId)로 주입받습니다. 실제 페이지는 공식 window.SOOP.ChatSDK,
//   테스트는 Mock Chat SDK Adapter를 넣습니다.
// - 서버 통신도 api 객체로 주입받습니다. (브라우저: same-origin fetch + HttpOnly 세션 쿠키)
// - BALLOON_GIFTED만 서버로 보냅니다. VOD/중계방 제외 판단은 서버가 다시 합니다(신뢰 경계).
// - 수신 1건마다 clientEventId(UUID)를 붙여, 네트워크 오류로 재전송해도 서버에서 한 번만 반영되게 합니다.
//   같은 사람이 같은 개수를 두 번 보내면 UUID가 서로 달라 두 건 모두 집계됩니다.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SoopConnectorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEARTBEAT_MS = 15000;
  var RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
  var RECONNECT_DELAYS_MS = [3000, 5000, 10000, 30000, 60000];
  var REFRESH_BEFORE_MS = 10 * 60 * 1000;
  var RECENT_LIMIT = 30;
  var BALLOON_FIELDS = ['bjId', 'userId', 'userNickname', 'count', 'relaysBroad', 'fromVod'];

  function defaultUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function pick(message) {
    var out = {};
    for (var i = 0; i < BALLOON_FIELDS.length; i += 1) {
      var key = BALLOON_FIELDS[i];
      if (message && message[key] !== undefined) out[key] = message[key];
    }
    return out;
  }

  function errorText(error) {
    return (error && (error.message || error.code)) || String(error);
  }

  function SoopConnectorCore(options) {
    this.createSdk = options.createSdk;
    this.api = options.api;
    this.onChange = options.onChange || function () {};
    this.now = options.now || function () { return Date.now(); };
    this.setTimer = options.setTimeout || setTimeout.bind(null);
    this.clearTimer = options.clearTimeout || clearTimeout.bind(null);
    this.uuid = options.uuid || defaultUuid;
    this.heartbeatMs = options.heartbeatMs || HEARTBEAT_MS;
    this.retryDelays = options.retryDelaysMs || RETRY_DELAYS_MS;
    this.reconnectDelays = options.reconnectDelaysMs || RECONNECT_DELAYS_MS;

    this.session = null;
    this.sdk = null;
    this.sdkState = 'IDLE';
    this.wantConnected = false;
    this.bjId = null;
    this.bjNickname = null;
    this.lastError = null;
    this.recent = [];
    this.queue = [];
    this.sending = false;
    this.retryIndex = 0;
    this.reconnectIndex = 0;
    this.timers = {};
  }

  var proto = SoopConnectorCore.prototype;

  proto.snapshot = function () {
    return {
      oauthConnected: Boolean(this.session && this.session.connected),
      configured: this.session ? this.session.configured !== false : true,
      sdkState: this.sdkState,
      bjId: this.bjId,
      bjNickname: this.bjNickname,
      lastError: this.lastError,
      recent: this.recent.slice(),
      pending: this.queue.length,
      wantConnected: this.wantConnected,
    };
  };

  proto.emit = function () {
    try { this.onChange(this.snapshot()); } catch (e) { /* 화면 갱신 오류는 무시 */ }
  };

  proto.setTimerFor = function (name, fn, ms) {
    this.clearTimerFor(name);
    var self = this;
    this.timers[name] = this.setTimer(function () { delete self.timers[name]; fn(); }, ms);
  };

  proto.clearTimerFor = function (name) {
    if (this.timers[name]) {
      this.clearTimer(this.timers[name]);
      delete this.timers[name];
    }
  };

  proto.setSdkState = function (state, error) {
    this.sdkState = state;
    if (error) this.lastError = error;
    this.reportStatus(error);
    this.emit();
  };

  proto.reportStatus = function (error) {
    if (!this.session || !this.session.connected) return Promise.resolve();
    var self = this;
    return Promise.resolve()
      .then(function () {
        return self.api.postStatus({ sdkState: self.sdkState, bjId: self.bjId, bjNickname: self.bjNickname, error: error || null });
      })
      .then(function (res) {
        if (res && res.bjMismatch) {
          self.lastError = '서버에 설정된 방송인(SOOP_BJ_ID=' + res.allowedBjId + ')과 연결된 계정(' + self.bjId + ')이 다릅니다. 이 계정의 별풍선은 집계되지 않습니다.';
          self.emit();
        }
      })
      .catch(function () { /* 하트비트 실패는 다음 주기에 다시 시도 */ });
  };

  // 서버에서 OAuth 연결 상태를 읽습니다. (페이지 로드 시)
  proto.loadSession = function () {
    var self = this;
    return this.api.getSession().then(function (session) {
      self.session = session;
      self.scheduleTokenRefresh();
      self.emit();
      return session;
    });
  };

  proto.scheduleTokenRefresh = function () {
    this.clearTimerFor('refresh');
    var s = this.session;
    if (!s || !s.connected || !s.canRefresh || !s.accessTokenExpiresAt) return;
    var self = this;
    var delay = Math.max(60000, Date.parse(s.accessTokenExpiresAt) - this.now() - REFRESH_BEFORE_MS);
    this.setTimerFor('refresh', function () {
      self.refreshToken().catch(function () {});
    }, delay);
  };

  proto.refreshToken = function () {
    var self = this;
    return this.api.refreshToken().then(function (session) {
      self.session = session;
      if (self.sdk) self.sdk.setAuth(session.accessToken);
      self.scheduleTokenRefresh();
      self.emit();
      return session;
    }, function (error) {
      self.lastError = 'Access Token 재발급 실패: ' + errorText(error);
      if (error && error.status === 401) self.handleSessionLost();
      else self.setTimerFor('refresh', function () { self.refreshToken().catch(function () {}); }, 60000);
      self.emit();
      throw error;
    });
  };

  proto.tokenExpiringSoon = function () {
    var s = this.session;
    return Boolean(s && s.canRefresh && s.accessTokenExpiresAt && Date.parse(s.accessTokenExpiresAt) - this.now() < 2 * 60 * 1000);
  };

  // [방송 연결]
  proto.connect = function () {
    var self = this;
    if (!this.session || !this.session.connected) {
      this.setSdkState('ERROR', 'SOOP 계정이 연결되어 있지 않습니다. 먼저 [SOOP 계정 연결]을 눌러주세요.');
      return Promise.resolve(false);
    }
    if (this.sdkState === 'CONNECTING' || this.sdkState === 'CONNECTED') return Promise.resolve(true);
    this.wantConnected = true;
    this.clearTimerFor('reconnect');
    this.setSdkState('CONNECTING');

    return Promise.resolve()
      .then(function () { return self.tokenExpiringSoon() ? self.refreshToken() : null; })
      .then(function () {
        self.teardownSdk();
        var sdk = self.createSdk(self.session.clientId);
        self.sdk = sdk;
        sdk.handleMessageReceived(function (action, message) { self.onMessage(sdk, action, message); });
        sdk.handleChatClosed(function () { self.onClosed(sdk); });
        sdk.handleError(function (code, message) {
          if (sdk !== self.sdk) return;
          self.lastError = 'Chat SDK 오류: ' + code + (message ? ' ' + message : '');
          self.reportStatus(self.lastError);
          self.emit();
        });
        // 문서 예제에는 init()이 있지만 현재 배포된 SDK 인스턴스에는 없어서, 있을 때만 호출합니다.
        return Promise.resolve(typeof sdk.init === 'function' ? sdk.init() : null).then(function () {
          sdk.setAuth(self.session.accessToken);
          return sdk.connect();
        }).then(function () { return sdk; });
      })
      .then(function (sdk) {
        if (sdk !== self.sdk || !self.wantConnected) return false;
        var room = null;
        try { room = sdk.getRoomInfo ? sdk.getRoomInfo() : null; } catch (e) { room = null; }
        return Promise.resolve(room).then(function (info) {
          if (info && info.bjId) self.bjId = String(info.bjId);
          self.reconnectIndex = 0;
          self.lastError = null;
          self.setSdkState('CONNECTED');
          self.startHeartbeat();
          return true;
        });
      })
      .catch(function (error) {
        self.setSdkState('ERROR', 'Chat SDK 연결 실패: ' + errorText(error));
        if (error && error.status === 401) return false;
        self.scheduleReconnect();
        return false;
      });
  };

  // [연결 해제]
  proto.disconnect = function () {
    this.wantConnected = false;
    this.clearTimerFor('reconnect');
    this.teardownSdk();
    this.setSdkState('DISCONNECTED');
  };

  proto.teardownSdk = function () {
    var sdk = this.sdk;
    this.sdk = null;
    if (sdk) {
      try { sdk.disconnect(); } catch (e) { /* 이미 끊긴 연결 */ }
    }
  };

  proto.onClosed = function (sdk) {
    if (sdk !== this.sdk) return;
    this.sdk = null;
    this.setSdkState('DISCONNECTED', this.wantConnected ? '채팅 서버 연결이 끊겼습니다. 자동으로 다시 연결합니다.' : null);
    if (this.wantConnected) this.scheduleReconnect();
  };

  proto.scheduleReconnect = function () {
    if (!this.wantConnected) return;
    var self = this;
    var delay = this.reconnectDelays[Math.min(this.reconnectIndex, this.reconnectDelays.length - 1)];
    this.reconnectIndex += 1;
    this.setTimerFor('reconnect', function () {
      if (!self.wantConnected) return;
      self.sdkState = 'DISCONNECTED';
      self.connect();
    }, delay);
  };

  proto.startHeartbeat = function () {
    var self = this;
    this.setTimerFor('heartbeat', function () {
      self.reportStatus();
      if (self.sdkState === 'CONNECTED' || self.wantConnected) self.startHeartbeat();
    }, this.heartbeatMs);
  };

  proto.onMessage = function (sdk, action, message) {
    if (sdk !== this.sdk) return;
    if (action === 'JOIN' && message && message.userId && (!this.bjId || message.userId === this.bjId)) {
      this.bjNickname = message.userNickname || this.bjNickname;
      this.reportStatus();
      this.emit();
      return;
    }
    // 일반 별풍선만 전달합니다. (도전미션/대결미션/애드벌룬/스티커 등 다른 action은 집계하지 않음)
    if (action !== 'BALLOON_GIFTED' || !message) return;
    this.queue.push({ action: 'BALLOON_GIFTED', message: pick(message), clientEventId: this.uuid(), receivedAt: this.now() });
    this.emit();
    this.flush();
  };

  // 받은 순서대로 한 건씩 서버에 보냅니다. 서버/네트워크 오류면 같은 clientEventId로 재시도합니다.
  proto.flush = function () {
    if (this.sending || this.queue.length === 0) return Promise.resolve();
    var self = this;
    var item = this.queue[0];
    this.sending = true;
    return Promise.resolve()
      .then(function () {
        return self.api.postBalloon({ action: item.action, message: item.message, clientEventId: item.clientEventId });
      })
      .then(function (res) {
        self.queue.shift();
        self.retryIndex = 0;
        self.pushRecent(item, res.result, res.message || res.reason || null);
      }, function (error) {
        var status = error && error.status;
        if (status === 401) {
          self.lastError = '서버 세션이 끊겨 별풍선을 보낼 수 없습니다. SOOP 계정을 다시 연결해주세요. (미전송 ' + self.queue.length + '건)';
          self.handleSessionLost();
          return 'stop';
        }
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
          // 잘못된 데이터는 다시 보내도 같으므로 버리고 기록만 남깁니다.
          self.queue.shift();
          self.pushRecent(item, 'REJECTED', errorText(error));
          return null;
        }
        var delay = self.retryDelays[Math.min(self.retryIndex, self.retryDelays.length - 1)];
        self.retryIndex += 1;
        self.lastError = '별풍선 전송 실패, ' + Math.round(delay / 1000) + '초 후 재시도: ' + errorText(error);
        self.setTimerFor('retry', function () { self.flush(); }, delay);
        return 'wait';
      })
      .then(function (outcome) {
        self.sending = false;
        self.emit();
        if (outcome !== 'stop' && outcome !== 'wait') return self.flush();
        return null;
      });
  };

  proto.pushRecent = function (item, result, note) {
    this.recent.unshift({
      nickname: item.message.userNickname || item.message.userId || '-',
      count: Number(item.message.count) || 0,
      at: new Date(item.receivedAt).toISOString(),
      result: result,
      note: note,
    });
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT;
  };

  proto.handleSessionLost = function () {
    this.session = { connected: false, configured: this.session ? this.session.configured : true };
    this.wantConnected = false;
    this.clearTimerFor('reconnect');
    this.clearTimerFor('refresh');
    this.clearTimerFor('heartbeat');
    this.teardownSdk();
    this.sdkState = 'ERROR';
    this.emit();
  };

  // [SOOP 계정 연결 해제]
  proto.logout = function () {
    var self = this;
    this.disconnect();
    return Promise.resolve(this.api.logout()).then(function () {
      self.session = { connected: false, configured: self.session ? self.session.configured : true };
      self.clearTimerFor('refresh');
      self.clearTimerFor('heartbeat');
      self.sdkState = 'IDLE';
      self.emit();
    });
  };

  proto.stopAll = function () {
    this.wantConnected = false;
    for (var name in this.timers) this.clearTimerFor(name);
    this.teardownSdk();
  };

  return { SoopConnectorCore: SoopConnectorCore };
});

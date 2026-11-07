// Callback/queue unit tests with mocked browser APIs; not a browser integration test.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const webRequire = createRequire(resolve(__dirname, '../apps/web/package.json'));
const ts = webRequire('typescript');

function loadHook(name, browser) {
  const slots = [];
  let index = 0;
  let pending = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const effect = (fn, deps) => {
    const i = index++;
    if (!equal(slots[i]?.deps, deps)) pending.push(() => {
      slots[i]?.cleanup?.();
      slots[i] = { deps, cleanup: fn() };
    });
  };
  const react = {
    useRef(value) { const i = index++; return slots[i] ??= { current: value }; },
    useState(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof value === 'function' ? value() : value };
      return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }];
    },
    useCallback(fn, deps) {
      const i = index++;
      if (!equal(slots[i]?.deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useLayoutEffect: effect,
    useEffect: effect,
  };
  const modulePath = name === 'ConnectionStatus' ? `components/${name}.tsx` : `hooks/${name}.ts`;
  const source = readFileSync(resolve(__dirname, `../apps/web/src/${modulePath}`), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: id => {
    if (id === 'react') return react;
    assert.ok(browser.modules?.[id], `Unexpected import ${id}`);
    return browser.modules[id];
  }, ...browser });
  return {
    render(...args) {
      index = 0;
      const result = exports[name](...args);
      const effects = pending;
      pending = [];
      effects.forEach(fn => fn());
      return result;
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); },
  };
}

function timers() {
  let id = 0;
  const scheduled = new Map();
  const delays = new Map();
  const listeners = new Map();
  return {
    scheduled, delays,
    setTimeout(fn, delay) { scheduled.set(++id, fn); delays.set(id, delay); return id; },
    clearTimeout(i) { scheduled.delete(i); delays.delete(i); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { listeners.get(type)?.forEach(fn => fn()); },
    listenerCount() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    fireNext() {
      const [i, fn] = scheduled.entries().next().value;
      const delay = delays.get(i);
      scheduled.delete(i); delays.delete(i); fn();
      return delay;
    },
  };
}

test('socket uses latest committed callbacks without reconnecting, and stops reconnecting after unmount', () => {
  const sockets = [];
  const calls = [];
  class WebSocket {
    constructor() { sockets.push(this); }
    close() { this.onclose?.(); }
    receive() { this.onmessage({ data: JSON.stringify({ speech_events: [{}], alert_events: [{}] }) }); }
  }
  const clock = timers();
  const hook = loadHook('useMarketSocket', { WebSocket, location: { protocol: 'http:', host: 'localhost' }, window: clock });
  hook.render(() => calls.push('speech-old'), () => calls.push('alert-old'));
  sockets[0].receive();
  hook.render(() => calls.push('speech-new'), () => calls.push('alert-new'));
  sockets[0].receive();
  assert.equal(sockets.length, 1);
  assert.deepEqual(calls, ['speech-old', 'alert-old', 'speech-new', 'alert-new']);
  sockets[0].close();
  assert.equal(clock.scheduled.size, 1);
  hook.unmount();
  assert.equal(clock.scheduled.size, 0);
});

function speechHook() {
  const spoken = [];
  const clock = timers();
  const window = { ...clock, speechSynthesis: { speak(u) { spoken.push(u); }, cancel() {}, speaking: false } };
  const hook = loadHook('useSpeech', { window, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  return { hook, spoken };
}
const event = (code, text, type = 'zt') => ({ code, text, type, board_count: 1 });

test('speech queue drains recursively, prioritizes alerts, and deduplicates repeated events', () => {
  const { hook, spoken } = speechHook();
  const api = hook.render(true, ['zt'], true, ['speed']);
  api.push([event('1', 'first'), event('2', 'second')]);
  api.push([event('1', 'first')]);
  api.pushAlert([event('3', 'alert', 'speed')]);
  assert.deepEqual(spoken.map(u => u.text), ['first']);
  spoken[0].onend();
  spoken[1].onend();
  spoken[2].onend();
  assert.deepEqual(spoken.map(u => u.text), ['first', 'alert', 'second']);
});

test('stable speech callback observes updated event types after commit', () => {
  const { hook, spoken } = speechHook();
  const first = hook.render(true, ['zt'], true, ['speed']);
  const second = hook.render(true, ['lb'], true, ['speed']);
  assert.equal(first.push, second.push);
  first.push([event('1', 'excluded'), event('2', 'included', 'lb')]);
  assert.deepEqual(spoken.map(u => u.text), ['included']);
});

function socketHook() {
  const sockets = [];
  class WebSocket {
    static CLOSED = 3;
    constructor() { this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const clock = timers();
  const hook = loadHook('useMarketSocket', { WebSocket, location: { protocol: 'http:', host: 'localhost' }, window: clock });
  const api = hook.render();
  return { sockets, clock, hook, api };
}

test('repeated connection failures back off to 30 seconds, then reset after connection succeeds', () => {
  const { sockets, clock, hook } = socketHook();
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    sockets.at(-1).onerror();
    assert.equal(clock.scheduled.size, 1);
    assert.equal(clock.fireNext(), delay);
  }
  sockets.at(-1).open();
  assert.equal(clock.scheduled.size, 0);
  assert.equal(hook.render().connected, true);
  sockets.at(-1).close();
  assert.equal(clock.fireNext(), 2000);
  hook.unmount();
});

test('connection timeout, manual retry and stale socket events keep exactly one live attempt', () => {
  const { sockets, clock, hook, api } = socketHook();
  const staleOpen = sockets[0].onopen;
  assert.equal(clock.fireNext(), 10000);
  assert.equal(clock.scheduled.size, 1);
  api.reconnect();
  assert.equal(sockets.length, 2);
  assert.equal(clock.scheduled.size, 1);
  staleOpen();
  assert.equal(hook.render().connected, false);
  sockets[1].open();
  assert.equal(hook.render().connected, true);
  assert.equal(clock.scheduled.size, 0);
  hook.unmount();
  assert.equal(sockets[1].readyState, 3);
  assert.equal(clock.listenerCount(), 0);
  api.reconnect();
  assert.equal(sockets.length, 2);
});

test('network recovery retries failed sockets immediately and leaves healthy local connections alone', () => {
  const { sockets, clock, hook } = socketHook();
  sockets[0].open();
  clock.emit('online');
  assert.equal(sockets.length, 1);
  sockets[0].close();
  clock.emit('online');
  assert.equal(sockets.length, 2);
  assert.equal(clock.scheduled.size, 1); // only the connection timeout remains
  hook.unmount();
  assert.equal(clock.scheduled.size, 0);
});

function notificationModule(overrides = {}) {
  const notices = [];
  let permissionRequests = 0;
  const storage = new Map();
  class Notification {
    static permission = 'granted';
    static requestPermission() { permissionRequests++; return Promise.resolve(this.permission); }
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; }
  }
  const window = { isSecureContext: true, focus() { this.focused = true; } };
  const document = { visibilityState: 'hidden', hasFocus: () => false };
  const context = { Notification, window, document, localStorage: {
    getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
  }, ...overrides };
  const source = readFileSync(resolve(__dirname, '../apps/web/src/lib/connectionNotifications.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...context });
  return { api: exports, context, notices, permissionRequests: () => permissionRequests };
}

test('system reminders default off, persist explicit choice, and never request permission automatically', () => {
  const { api, permissionRequests } = notificationModule();
  assert.equal(api.loadConnectionNotifications(), false);
  api.saveConnectionNotifications(true);
  assert.equal(api.loadConnectionNotifications(), true);
  api.saveConnectionNotifications(false);
  assert.equal(api.loadConnectionNotifications(), false);
  assert.equal(permissionRequests(), 0);
});

test('native reminders skip focused pages, share one tag and focus the app on click', () => {
  const { api, context, notices } = notificationModule();
  context.document.visibilityState = 'visible';
  context.document.hasFocus = () => true;
  assert.equal(api.showConnectionNotification('disconnected'), false);
  assert.equal(notices.length, 0);
  context.document.visibilityState = 'hidden';
  assert.equal(api.showConnectionNotification('disconnected'), true);
  assert.equal(api.showConnectionNotification('restored'), true);
  assert.equal(notices[0].options.tag, notices[1].options.tag);
  notices[1].onclick();
  assert.equal(context.window.focused, true);
  assert.equal(notices[1].closed, true);
});

test('unsupported notifications, denied permission and disabled storage fail gracefully', () => {
  assert.equal(notificationModule({ Notification: undefined }).api.showConnectionNotification('test'), false);
  const denied = notificationModule();
  denied.context.Notification.permission = 'denied';
  assert.equal(denied.api.showConnectionNotification('test'), false);
  const broken = notificationModule({ localStorage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } } });
  assert.equal(broken.api.loadConnectionNotifications(), false);
  assert.doesNotThrow(() => broken.api.saveConnectionNotifications(true));
});

test('connection reminders ignore startup and brief outages, pair recovery with a warning, and throttle flapping', () => {
  const notices = [];
  const clock = timers();
  let now = 1000;
  const api = {
    warning(value) { notices.push(['warning', value.title]); },
    success(value) { notices.push(['success', value.title]); },
  };
  const jsx = () => null;
  const hook = loadHook('ConnectionStatus', {
    window: clock, Date: { now: () => now },
    modules: {
      'react/jsx-runtime': { jsx, jsxs: jsx },
      '@ant-design/icons': {},
      antd: { notification: { useNotification: () => [api, null] } },
      '../lib/connectionNotifications': {
        loadConnectionNotifications: () => false,
        supportsDesktopNotifications: () => false,
      },
    },
  });
  const props = connected => ({ connected, retryAttempt: connected ? 0 : 1, retryDelayMs: 2000, updatedAt: '', onReconnect() {} });
  hook.render(props(false));
  assert.equal(clock.scheduled.size, 0);
  hook.render(props(true));
  assert.equal(notices.length, 0);
  hook.render(props(false));
  hook.render(props(true));
  assert.equal(clock.scheduled.size, 0);
  assert.equal(notices.length, 0);
  hook.render(props(false));
  assert.equal(clock.fireNext(), 5000);
  hook.render(props(true));
  assert.deepEqual(notices.map(n => n[0]), ['warning', 'success']);
  hook.render(props(false));
  clock.fireNext();
  hook.render(props(true));
  assert.equal(notices.length, 2);
  now += 60000;
  hook.render(props(false));
  clock.fireNext();
  assert.equal(notices.length, 3);
  hook.render(props(true));
  hook.render(props(false));
  hook.unmount();
  assert.equal(clock.scheduled.size, 0);
});

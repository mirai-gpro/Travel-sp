// tools/poc-tests/_browser-env.cjs
//
// poc-tests 用の最小ブラウザ環境 mock。
// 製品コードを node で実行するために、node に存在しないブラウザ API だけを用意する。
// 製品コードのロジックは一切 mock しない。
//
// 注意: tools/poc-tests/frontend_generation_isolation.spec.cjs は
//       Phase 2 時点の内容を凍結しているため、この helper を使っていない。
//       同等の mock がそちらにも入っている（意図的な重複）。

function makeElement(tag) {
    const el = {
        tagName: tag || 'div',
        _classes: new Set(),
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        loop: false,
        paused: true,
        style: {},
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        classList: {
            add: (...c) => c.forEach((x) => el._classes.add(x)),
            remove: (...c) => c.forEach((x) => el._classes.delete(x)),
            contains: (c) => el._classes.has(c),
            toggle: (c) => (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c)),
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: (c) => { el.children.push(c); return c; },
        removeChild: () => {},
        remove: () => {},
        querySelector: () => makeElement('div'),
        querySelectorAll: () => [],
        scrollIntoView: () => {},
        focus: () => {},
        blur: () => {},
        play: () => Promise.resolve(),
        pause: () => {},
        load: () => {},
        setAttribute: () => {},
        getAttribute: () => null,
        dispatchEvent: () => true,
        insertAdjacentHTML: () => {},
        closest: () => null,
        getContext: () => null,
    };
    return el;
}

function install(opts) {
    opts = opts || {};
    const STORE = new Map(Object.entries(opts.localStorage || {}));

    global.localStorage = {
        getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
        setItem: (k, v) => STORE.set(k, String(v)),
        removeItem: (k) => STORE.delete(k),
        clear: () => STORE.clear(),
    };

    // document: addEventListener / dispatchEvent は実際に動く必要がある
    // （FIRST_VALID_FRAME_RENDERED の中継が CustomEvent 経由のため）
    const listeners = new Map();
    global.document = {
        hidden: false,
        getElementById: () => makeElement('div'),
        querySelector: () => makeElement('div'),
        querySelectorAll: () => [],
        createElement: (t) => makeElement(t),
        addEventListener: (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener: (type, fn) => {
            const a = listeners.get(type) || [];
            const i = a.indexOf(fn);
            if (i !== -1) a.splice(i, 1);
        },
        dispatchEvent: (ev) => {
            (listeners.get(ev && ev.type) || []).slice().forEach((fn) => fn(ev));
            return true;
        },
        body: makeElement('body'),
        head: makeElement('head'),
    };

    global.window = {
        location: {
            origin: 'http://localhost',
            search: opts.search || '',
            pathname: opts.pathname || '/',
            href: 'http://localhost/',
        },
        innerWidth: 1280,
        innerHeight: 800,
        scrollTo: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        localStorage: global.localStorage,
        document: global.document,
        dispatchEvent: (ev) => global.document.dispatchEvent(ev),
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        devicePixelRatio: 2,
    };
    global.location = global.window.location;

    Object.defineProperty(global, 'navigator', {
        value: {
            userAgent: 'node-test',
            mediaDevices: {
                getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
            },
        },
        writable: true,
        configurable: true,
    });
    global.window.navigator = global.navigator;

    global.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    };
    global.Event = global.CustomEvent;

    global.Audio = class Audio {
        constructor() { this.paused = true; this.src = ''; }
        play() { this.paused = false; return Promise.resolve(); }
        pause() { this.paused = true; }
        addEventListener() {}
        load() {}
    };

    global.fetch = opts.fetch || (async () => ({
        ok: true,
        json: async () => ({ session_id: 'test-session-id' }),
        text: async () => '',
    }));

    if (!global.URL.createObjectURL) {
        global.URL.createObjectURL = () => 'blob:test';
        global.URL.revokeObjectURL = () => {};
    }

    const WORKLET_NODES = [];
    global.AudioWorkletNode = class AudioWorkletNode {
        constructor() {
            this.port = { onmessage: null, postMessage: () => {} };
            WORKLET_NODES.push(this);
        }
        connect() {}
        disconnect() {}
    };
    global.AudioContext = class AudioContext {
        constructor() {
            this.state = 'running';
            this.currentTime = 0;
            this.sampleRate = 48000;
            this.destination = {};
            this.audioWorklet = { addModule: async () => {} };
        }
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
        createGain() { return { connect: () => {}, gain: { value: 1 } }; }
        createBuffer(ch, len) {
            return { duration: len / 24000, copyToChannel: () => {}, length: len };
        }
        createBufferSource() {
            return { buffer: null, connect: () => {}, start: () => {}, stop: () => {}, onended: null };
        }
        resume() { return Promise.resolve(); }
        suspend() { return Promise.resolve(); }
        close() { return Promise.resolve(); }
    };
    global.webkitAudioContext = global.AudioContext;
    global.window.AudioContext = global.AudioContext;
    global.window.webkitAudioContext = global.AudioContext;
    global.window.AudioWorkletNode = global.AudioWorkletNode;

    return { STORE, WORKLET_NODES, makeElement };
}

function makeFakeSocket() {
    const handlers = new Map();
    return {
        connected: true,
        emitted: [],
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
        },
        once(event, fn) { this.on(event, fn); },
        off() {},
        emit(event, data) { this.emitted.push({ event, data }); },
        connect() {},
        disconnect() {},
        serverEmit(event, data) { (handlers.get(event) || []).forEach((fn) => fn(data)); },
        hasHandler(event) { return (handlers.get(event) || []).length > 0; },
        takeEmitted(event) { return this.emitted.filter((e) => e.event === event); },
        clearEmitted() { this.emitted.length = 0; },
    };
}

module.exports = { install, makeElement, makeFakeSocket };

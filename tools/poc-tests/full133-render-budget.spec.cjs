// tools/poc-tests/full133-render-budget.spec.cjs
//
// FULL133 + スマホのときだけ drawing buffer の DPR を 1.0 にすることを固定する。
// 「それ以外は 100% 現状維持」が要点。
//
// 実行:
//   npx esbuild src/scripts/chat/full133-render-budget.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.render-budget.cjs
//   node tools/poc-tests/full133-render-budget.spec.cjs

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

function load() {
    delete require.cache[require.resolve('./.render-budget.cjs')];
    return require('./.render-budget.cjs');
}

// ---- three.js WebGLRenderer の pixel ratio 挙動を再現した fake ----------
// 実装の根拠: gaussian-splat-renderer-for-lam.module.js :116185-116193
//   setPixelRatio(value) { if (_pixelRatio === value) return; _pixelRatio = value;
//                          setSize(_width, _height, false); }
// setSize は _pixelRatio を使って drawing buffer を決め、CSS は updateStyle で別管理。
function makeThree(cssW, cssH, dpr) {
    const t = {
        _pixelRatio: dpr,
        _width: cssW,
        _height: cssH,
        domElement: { clientWidth: cssW, clientHeight: cssH, width: cssW * dpr, height: cssH * dpr },
        setPixelRatio(v) {
            if (t._pixelRatio === v) return;
            t._pixelRatio = v;
            t.setSize(t._width, t._height, false);
        },
        setSize(w, h, updateStyle = true) {
            t._width = w; t._height = h;
            t.domElement.width = Math.floor(w * t._pixelRatio);
            t.domElement.height = Math.floor(h * t._pixelRatio);
            if (updateStyle) { t.domElement.clientWidth = w; t.domElement.clientHeight = h; }
        },
        getContext() {
            return { drawingBufferWidth: t.domElement.width, drawingBufferHeight: t.domElement.height };
        },
    };
    return t;
}

function makeRenderer(cssW, cssH, dpr, withSplatMesh = true) {
    const three = makeThree(cssW, cssH, dpr);
    const viewer = {
        devicePixelRatio: dpr,
        renderer: three,
        splatMesh: withSplatMesh ? { devicePixelRatio: dpr } : null,
    };
    return { viewer, _three: three };
}

function setEnv({ modelUrl, dpr, mobile }) {
    global.window = {
        devicePixelRatio: dpr,
        location: { search: '', pathname: '/concierge' },
        __lamAvatarConfig: modelUrl ? { modelUrl } : undefined,
        localStorage: { getItem: () => null },
        navigator: { maxTouchPoints: mobile ? 5 : 0 },
        matchMedia: (q) => ({ matches: mobile && /any-pointer:\s*coarse/.test(q) }),
    };
    global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
}

const FULL133 = '/avatar/uika-full133-skin.zip';

(async () => {
    const m0 = (() => { setEnv({ modelUrl: FULL133, dpr: 3, mobile: true }); return load(); })();
    ok(m0.FULL133_AVATAR_ID === 'uika-full133-skin',
       '対象 avatar は uika-full133-skin のみ', m0.FULL133_AVATAR_ID);
    ok(m0.FULL133_MOBILE_DPR === 1, '落とし先の DPR は 1.0 のみ', String(m0.FULL133_MOBILE_DPR));

    // ---- Case 1: FULL133 / mobile / DPR=3 -> effective 1.0 ----------------
    {
        setEnv({ modelUrl: FULL133, dpr: 3, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 3);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === true, '★ Case1 FULL133+mobile+DPR3 で適用される', s.reason);
        ok(r.viewer.devicePixelRatio === 1, '★ Case1 viewer.devicePixelRatio = 1');
        ok(r.viewer.splatMesh.devicePixelRatio === 1, '★ Case1 splatMesh.devicePixelRatio = 1');
        ok(r._three._pixelRatio === 1, '★ Case1 three renderer の pixelRatio = 1');
        ok(s.effectiveDPR === 1 && s.deviceDPR === 3,
           '★ Case1 effectiveDPR=1 / deviceDPR=3', `eff=${s.effectiveDPR} dev=${s.deviceDPR}`);
        ok(r._three.domElement.clientWidth === 390 && r._three.domElement.clientHeight === 650,
           '★ Case1 canvas CSS サイズは変わらない',
           `${r._three.domElement.clientWidth}x${r._three.domElement.clientHeight}`);
        ok(r._three.domElement.width === 390 && r._three.domElement.height === 650,
           '★ Case1 drawing buffer が 1170x1950 -> 390x650 に縮む',
           `${r._three.domElement.width}x${r._three.domElement.height}`);
    }

    // ---- Case 2: FULL133 / mobile / DPR=1 -> effective 1.0 ---------------
    {
        setEnv({ modelUrl: FULL133, dpr: 1, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 1);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === true, '★ Case2 FULL133+mobile+DPR1 でも適用扱い', s.reason);
        ok(s.effectiveDPR === 1 && r._three._pixelRatio === 1,
           '★ Case2 effective DPR = 1.0');
        ok(r._three.domElement.width === 390 && r._three.domElement.height === 650,
           'Case2 buffer サイズは元から 1 倍なので不変');
    }

    // ---- Case 3: FULL133 / desktop / DPR=2 -> 変更なし -------------------
    {
        setEnv({ modelUrl: FULL133, dpr: 2, mobile: false });
        const m = load();
        const r = makeRenderer(1707, 842, 2);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === false, '★ Case3 PC+UIKA では適用しない', s.reason);
        ok(r.viewer.devicePixelRatio === 2 && r._three._pixelRatio === 2,
           '★ Case3 PC の DPR は 2 のまま', `viewer=${r.viewer.devicePixelRatio}`);
        ok(r.viewer.splatMesh.devicePixelRatio === 2, 'Case3 splatMesh も 2 のまま');
        ok(r._three.domElement.width === 3414, 'Case3 buffer も不変', String(r._three.domElement.width));
    }

    // ---- Case 4: LAM / mobile -> 変更なし --------------------------------
    {
        setEnv({ modelUrl: '/avatar/meruru.zip', dpr: 3, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 3);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === false, '★ Case4 スマホ+LAM では適用しない', s.reason);
        ok(r.viewer.devicePixelRatio === 3 && r._three._pixelRatio === 3,
           '★ Case4 LAM の DPR は 3 のまま');
        ok(r.viewer.splatMesh.devicePixelRatio === 3, 'Case4 splatMesh も 3 のまま');
    }

    // ---- Case 5: その他 avatar / mobile -> 変更なし ----------------------
    for (const url of ['/avatar/uika-b-20k.zip', '/avatar/uika-gakki-133k.zip',
                       '/avatar/elf.zip', '/avatar/uika-b-current.zip']) {
        setEnv({ modelUrl: url, dpr: 3, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 3);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === false && r._three._pixelRatio === 3,
           `★ Case5 ${url.split('/').pop()} では適用しない`, s.reason);
    }

    // ---- Case 5b: ?uika133k=1 の hidden 経路は対象外 ---------------------
    {
        setEnv({ modelUrl: FULL133, dpr: 3, mobile: true });
        global.window.location.search = '?uika133k=1';
        const m = load();
        const r = makeRenderer(390, 650, 3);
        const s = await m.installFull133RenderBudget(r, 10);
        ok(s.applied === false, '★ ?uika133k=1 の hidden PoC 経路は対象外', s.reason);
        ok(r._three._pixelRatio === 3, 'hidden 経路の DPR は 3 のまま');
    }

    // ---- Case 6: resize / orientation change 後も 1.0 維持 ---------------
    // Viewer の ResizeObserver は setSize だけを呼ぶ (:137164-137169)。
    // three.js は pixel ratio を _pixelRatio に保持し setSize はそれを使う
    // (:116185-116193) ので、監視ループ無しで 1.0 が維持される。
    {
        setEnv({ modelUrl: FULL133, dpr: 3, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 3);
        await m.installFull133RenderBudget(r, 10);
        ok(r._three._pixelRatio === 1, 'Case6 事前条件: DPR 1.0 が入っている');
        // ResizeObserver 相当 (orientation change で 650x390 になった想定)
        r._three.setSize(650, 390);
        ok(r._three._pixelRatio === 1, '★ Case6 resize 後も pixelRatio = 1 を維持');
        ok(r._three.domElement.width === 650 && r._three.domElement.height === 390,
           '★ Case6 resize 後の buffer も 1 倍',
           `${r._three.domElement.width}x${r._three.domElement.height}`);
        ok(r.viewer.devicePixelRatio === 1 && r.viewer.splatMesh.devicePixelRatio === 1,
           '★ Case6 viewer / splatMesh も 1 のまま');
    }

    // ---- 二重適用しない --------------------------------------------------
    {
        setEnv({ modelUrl: FULL133, dpr: 3, mobile: true });
        const m = load();
        const r = makeRenderer(390, 650, 3);
        await m.installFull133RenderBudget(r, 10);
        const s2 = await m.installFull133RenderBudget(r, 10);
        ok(s2.applied === false && /すでに適用済み/.test(s2.reason),
           '★ 2 回目は適用済みとして何もしない', s2.reason);
        ok(r._three._pixelRatio === 1, '2 回目後も DPR 1');
    }

    // ---- viewer が無くても例外を投げない --------------------------------
    {
        setEnv({ modelUrl: FULL133, dpr: 3, mobile: true });
        const m = load();
        const s = await m.installFull133RenderBudget({}, 3);
        ok(s.applied === false && /viewer/.test(s.reason),
           'viewer 不在でも例外なく applied=false', s.reason);
    }

    // ---- mobile 判定 -----------------------------------------------------
    {
        const m = load();
        const mk = (coarse, touch) => ({
            matchMedia: (q) => ({ matches: coarse && /any-pointer:\s*coarse/.test(q) }),
            navigator: { maxTouchPoints: touch },
        });
        ok(m.isMobileClassDevice(mk(true, 5)) === true,  '★ coarse pointer + touch = mobile');
        ok(m.isMobileClassDevice(mk(false, 0)) === false, '★ fine pointer + touch 無し = desktop');
        ok(m.isMobileClassDevice(mk(true, 0)) === false,  'coarse だけでは mobile にしない');
        ok(m.isMobileClassDevice(mk(false, 5)) === false, 'touch だけでは mobile にしない');
        ok(m.isMobileClassDevice({}) === false, 'API 不在でも例外なく false');
    }

    // ---- ソースが変えてよい範囲だけ触っていること ------------------------
    {
        const src = require('fs').readFileSync('src/scripts/chat/full133-render-budget.ts', 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        for (const bad of ['setInterval', 'MutationObserver', 'camera', 'fov', 'projection',
                           'setSize', 'style.', 'sort', 'morph', 'predeform', 'shader']) {
            ok(!new RegExp(bad.replace('.', '\\.'), 'i').test(code),
               `★ ソースに ${bad} を含まない`);
        }
    }

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();

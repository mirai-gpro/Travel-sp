// src/scripts/chat/uika-133k-mode.ts
/**
 * UIKA Native 133K hidden PoC モード
 *
 * `?uika133k=1` のときだけ有効になる。通常の Travel-sp アバターには
 * 一切影響させない (この module の関数は UIKA mode 以外から呼ばれない)。
 *
 * やること:
 *   1. skeletal animation を止めて H_head = 恒等 を維持する
 *   2. nose_tip/gakki/meta.json の camera を再現する
 *   3. OrbitControls による camera pose 上書きを止める
 *
 * やらないこと:
 *   - A2E morph の停止 (ARKit morph 経路には触らない)
 *   - 通常モードの camera / avatar-config / 6° polar 補正への影響
 *
 * 根拠 (gaussian-splat-renderer-for-lam@0.0.9-alpha.1 の build を実読):
 *   - vertex shader の USE_SKINNING 分岐 (:61785-61809) が
 *     `bone.name == 'head'` の bone の skinning 行列を全 splat center に掛ける。
 *     headBoneIndex は :64588-64592 で決まり、行列は
 *     `flameModel.skeleton.boneTexture` (= bone.matrixWorld × boneInverse) から読む。
 *   - その skeleton は :152581-152582 の AnimationMixer + AnimationManager が
 *     animation.glb を再生して動かす。
 *   - Viewer.update() は controls.enabled に関係なく controls.update() を呼び
 *     (:138815-138816)、OrbitControls.update() 末尾の object.lookAt(target)
 *     (:59121) が camera 姿勢を毎フレーム上書きする。
 *   - ARKit morph は別経路 (:61746-61767 の bsCount ループ) なので、
 *     骨格を止めても morph は効く。
 */

/**
 * nose_tip/gakki/meta.json の記録値。Source of Truth。
 * ここの 1024x1024 / fx=fy=2590.80322265625 / cx=cy=512 は **meta の原値**で、
 * Render Parity 診断 (scripts/parity_testA.html) 用の条件でもある。
 * 実 canvas へは applyUikaCamera() が縦基準の等方 scale で移す。
 */
export const UIKA_META_CAMERA = {
    radius: 0.7826237921249264,
    lookAt: [0, 0, 0] as [number, number, number],
    up: [0, 1, 0] as [number, number, number],
    fx: 2590.80322265625,
    fy: 2590.80322265625,
    cx: 512.0,
    cy: 512.0,
    renderSize: 1024,
    near: 0.01,
    far: 100.0,
} as const;

/**
 * UIKA canonical (`cano_nose90`, 原点中心) → LAM 骨格 bind 空間 の translation。
 *
 * `docs/UIKA_NATIVE_133K_DEFORM_PREFLIGHT.md` §2/§4 の実測値 (フル精度)。
 * 両 ZIP の `skin.glb` POSITION 重心の差:
 *   LAM  (20,018 点) 重心 = [-0.00046714589244861276, 1.6701843360406747,  0.04134637168342093]
 *   UIKA (133,541 点) 重心 = [-0.00018298009111780735, -0.012531577479376211, -0.0251610800968702]
 * `H_head` は bind 空間 (頭の重心 y ≈ 1.67) の点に当てる前提の行列なので、
 * 原点中心の cano にそのまま当てると回転成分がほぼ効かず平行移動だけが残る
 * (実測で通常 LAM の 4.75 倍)。この d を挟むと 1.01 倍になる。
 */
export const UIKA_CANO_TO_LAM_BIND: readonly [number, number, number] = [
    -0.00028416580133080538,
    1.6827159135200509,
    0.066507451780291132,
];

/** H_head が恒等とみなせる上限。指示どおりの gate。 */
export const H_HEAD_IDENTITY_TOL = 1e-6;

export type UikaSortMode = 'full' | '10fps' | 'camera';

/**
 * `?sortMode=` を読む。**UIKA mode の既定は `camera`**。
 *
 * `full` は `viewer.update()` が毎フレーム呼ぶ
 * `runSplatSort(true, true)` (force + forceSortAll, `module.js:138826`) を
 * そのまま通すため、133,541 点を毎フレーム全ソートする。計測では
 * render 間隔 p50 が 4277 ms (full) に対し 20.3 ms (10fps) で、sort が
 * 支配的コストだった (`docs/UIKA_NATIVE_133K_LIPSYNC_SMOOTHNESS.md` §2)。
 * リップシンク更新レートは render レートと一致するため、既定を `camera`
 * にして sort を初回 + ユーザー操作中だけに限る。`?sortMode=full` で従来比較可。
 *
 * 通常 LAM はこの関数を呼ばないので影響しない。
 */
export function getUikaSortMode(): UikaSortMode {
    try {
        const m = new URLSearchParams(window.location.search).get('sortMode');
        if (m === '10fps' || m === 'camera' || m === 'full') return m;
    } catch { /* noop */ }
    return 'camera';
}

export type UikaExprPath = 'provider' | 'cache';

/**
 * 【診断用】UIKA の expression frame 取得経路を選ぶ。既定は現状維持の `provider`。
 *
 *   provider : renderer の `getExpressionData()` から
 *              `liveAudioManager.getCurrentExpressionFrame()` を直接呼ぶ (commit 9714965 以降)
 *   cache    : provider を設定せず、通常 LAM と同じ
 *              `AudioSyncPlayer rAF → updateExpression() → currentExpression` 経路にする
 *
 * `?uika133k=1` だけのときは `provider` (= 現在の挙動) を維持する。
 * 通常 LAM はこの関数を呼ばないので無影響。
 */
export function getUikaExprPath(): UikaExprPath {
    try {
        const m = new URLSearchParams(window.location.search).get('exprPath');
        if (m === 'cache') return 'cache';
    } catch { /* noop */ }
    return 'provider';
}

/** `?morphFast=off` / `=0` / `=false` で無効化できる。既定は有効。
 *
 * **同名パラメータが PoC 側にもある** (`poc/render-perf.ts:getMorphFastMode`)。
 * あちらは「既定 off / `1`|`on` で有効」なので既定が逆である。
 * `?morphFast=0` を「off を意味しない」と読むと、同じ URL で
 * 一方が on・他方が off という取り違えが起きる。off を意味する綴りは
 * すべて off として扱い、どちらの経路でも `0` が off になるようにする。
 *
 * なお両経路は `isUika133kMode()` (`?uika133k=1`) で相互排他なので
 * (`lam-websocket-manager.ts:167-178` が uika 経路で早期 return する)、
 * 同時に効くことはない。これは取り違え防止のための統一。 */
export function getUikaMorphFast(): boolean {
    try {
        const v = new URLSearchParams(window.location.search).get('morphFast');
        return !(v === 'off' || v === '0' || v === 'false');
    } catch { /* noop */ }
    return true;
}

export type UikaBlinkMode = 'idle' | 'always';

/**
 * `?blinkMode=` を読む。既定は `idle` (現状どおり Idle 中のみ)。
 * `always` は chatState を問わず procedural blink を A2E blink と
 * `max()` 合成する (発話中の瞬き A/B 用)。
 */
export function getUikaBlinkMode(): UikaBlinkMode {
    try {
        const m = new URLSearchParams(window.location.search).get('blinkMode');
        if (m === 'always') return m;
    } catch { /* noop */ }
    return 'idle';
}

export type UikaIdleMode = 'off' | 'rigid' | 'rigidPivot';

/**
 * `?idleMode=` を読む。既定は `rigid` (従来どおり)。
 *   - `off`        : skeletal animation を止めて H_head = 恒等
 *   - `rigid`      : H_head をそのまま camera へ合成 (比較用に温存)
 *   - `rigidPivot` : H_pivot = T(-d) · H_head · T(d) を camera へ合成
 */
export function getUikaIdleMode(): UikaIdleMode {
    try {
        const m = (new URLSearchParams(window.location.search).get('idleMode') || '').toLowerCase();
        if (m === 'off') return 'off';
        if (m === 'rigidpivot') return 'rigidPivot';
    } catch { /* noop */ }
    return 'rigid';
}

/** badge / ログ用の表示名。 */
function idleModeLabel(m: UikaIdleMode): string {
    return m === 'rigidPivot' ? 'RIGID-PIVOT' : m.toUpperCase();
}

export interface UikaModeStatus {
    enabled: boolean;
    headBoneIndex: number;
    hHeadMaxAbsDiffFromIdentity: number;
    hHeadIsIdentity: boolean;
    ready: boolean;
    gateReported: boolean;
    userInteracted: boolean;
    orbitEnabled: boolean;
    sortMode: UikaSortMode;
    idleMode: UikaIdleMode;
    headCompHooked: boolean;
    headNeutralized: boolean;
    hHeadMaxAbsDiffFromIdentityApplied: number;
    /** rigidPivot のとき true。H_pivot = T(-d)·H_head·T(d) を適用している。 */
    pivotApplied: boolean;
    /** 適用した H_pivot の max|H−I| (rigidPivot のときだけ値が入る)。 */
    hPivotMaxAbsDiffFromIdentity: number;
    projParityMaxDiff: number;
    blinkEnabled: boolean;
    blinkMode: UikaBlinkMode;
    blinkCount: number;
    morphFast: boolean;
    morphFastHooked: boolean;
    morphFullRuns: number;
    morphFastFrames: number;
    sortHooked: boolean;
    sortsAccepted: number;
    sortsSkipped: number;
    splatCount: number | null;
    bsCount: number | null;
    cameraApplied: boolean;
    /** meta camera pose を一度確定したか (以後 pose は meta へ再固定しない)。 */
    posePinned: boolean;
    controlsNeutralized: boolean;
    animationStopped: boolean;
    frames: number;
    errors: string[];
}

export function isUika133kMode(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        return new URLSearchParams(window.location.search).get('uika133k') === '1';
    } catch {
        return false;
    }
}

function maxAbsDiffFromIdentity(m: ArrayLike<number>): number {
    // three.js は column-major。恒等行列との差の最大絶対値。
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let mx = 0;
    for (let i = 0; i < 16; i++) {
        const d = Math.abs(m[i] - I[i]);
        if (d > mx) mx = d;
    }
    return mx;
}

function getSkeletonAndHeadIndex(splatMesh: any): { skeleton: any; headIndex: number } {
    const skeleton = splatMesh?.flameModel?.skeleton ?? null;
    const u = splatMesh?.material?.uniforms?.headBoneIndex;
    const headIndex = u ? Math.round(u.value) : -1;
    return { skeleton, headIndex };
}

/**
 * 骨格 animation を止め、head bone を bind pose に戻す。
 * `timeScale = 0` だけでは足りない (action が再生開始され、止めた時点の
 * pose が bind pose とは限らない) ため、
 *   stopAllAction → animManager.update の無効化 → skeleton.pose() → skeleton.update()
 * まで行う。
 */
function stopSkeletalAnimation(renderer: any): string[] {
    const errs: string[] = [];
    // idleMode=rigid では animation.glb をそのまま再生する。
    // splat 側へ H_head を掛けないのは setupHeadCompensation() の責務。
    try {
        if (renderer?.mixer) {
            renderer.mixer.stopAllAction();
            renderer.mixer.timeScale = 0;
        } else {
            errs.push('mixer が見つからない');
        }
    } catch (e: any) { errs.push('mixer: ' + e?.message); }

    try {
        // AnimationManager.update(state) は毎フレーム action.play() を呼ぶので
        // インスタンス側で無効化する (ライブラリ本体は変更しない)。
        const am = renderer?.animManager;
        if (am && !am.__uikaNeutralized) {
            am.update = function () { /* UIKA mode: 骨格 animation を駆動しない */ };
            am.__uikaNeutralized = true;
        }
    } catch (e: any) { errs.push('animManager: ' + e?.message); }

    try {
        const sm = renderer?.viewer?.splatMesh;
        const { skeleton } = getSkeletonAndHeadIndex(sm);
        if (skeleton) {
            // bind pose へ戻す。boneMatrices = bone.matrixWorld × boneInverse = I になる。
            skeleton.pose();
            skeleton.update();
            if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
            else if (typeof skeleton.computeBoneTexture === 'function') skeleton.computeBoneTexture();
            if (sm?.material?.uniforms?.boneTexture0) {
                sm.material.uniforms.boneTexture0.value = skeleton.boneTexture;
                sm.material.uniformsNeedUpdate = true;
            }
        } else {
            errs.push('skeleton が見つからない');
        }
    } catch (e: any) { errs.push('skeleton.pose: ' + e?.message); }

    return errs;
}

/**
 * meta.json の intrinsics から projection matrix を作って camera に入れる。
 *
 * `applyPose = true` のときだけ camera の **pose** (position / lookAt) も
 * meta の値に合わせる。pose を誰が持つかは呼び出し側が決める:
 *   - 初期化時の 1 回目: ここで meta pose を確定する (head compensation /
 *     OrbitControls はこの pose を基準に初期化される)
 *   - idleMode='rigid' の 2 回目以降: head compensation が C_orbit / C_render を
 *     管理するので pose には触らない (intrinsics だけ維持)
 *   - ユーザーが操作した後: OrbitControls が pose を持つので触らない
 * intrinsics / projection は常に meta のまま維持する。
 */
function applyUikaCamera(renderer: any, applyPose: boolean): string[] {
    const errs: string[] = [];
    const v = renderer?.viewer;
    const camera = v?.camera;
    if (!camera) { errs.push('camera が見つからない'); return errs; }

    const M = UIKA_META_CAMERA;
    const el = v.renderer?.domElement;
    const W = el?.width || M.renderSize;
    const H = el?.height || M.renderSize;

    // ===== meta.json (1024x1024) の intrinsics を実 canvas へ移す =====
    // **縦基準の等方 scale のみ**。width / height を別倍率で fx / fy に
    // 当てて非等方変形させてはいけない (2026-10-11 指示)。
    //
    //   scale = H / 1024
    //   fx = fy = 2590.80322265625 * scale
    //   cx = W / 2,  cy = H / 2
    //
    // Travel-sp 本番 UI の 500 x 200 では
    //   scale = 200/1024,  fx = fy = 506.0162544250488,  cx = 250,  cy = 100
    const scale = H / M.renderSize;
    const fx = M.fx * scale;
    const fy = M.fy * scale;          // fx === fy (等方)
    const cx = W / 2;
    const cy = H / 2;

    // UIKA camera.py:30-49 getProjectionMatrix の K 分岐と同じ frustum
    const left = -((W - cx) * M.near) / fx;
    const right = (cx * M.near) / fx;
    const top = (cy * M.near) / fy;
    const bottom = ((cy - H) * M.near) / fy;

    camera.up.set(M.up[0], M.up[1], M.up[2]);
    if (applyPose) {
        camera.position.set(M.lookAt[0], M.lookAt[1], M.lookAt[2] + M.radius);
        camera.lookAt(M.lookAt[0], M.lookAt[1], M.lookAt[2]);
    }
    camera.near = M.near;
    camera.far = M.far;
    camera.projectionMatrix.makePerspective(left, right, top, bottom, M.near, M.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    // Viewer.updateForRendererSizeChanges() が aspect から projection を作り直すので、
    // 自分の camera インスタンスの updateProjectionMatrix だけ無効化する。
    if (!(camera as any).__uikaProjLocked) {
        camera.updateProjectionMatrix = function () { /* UIKA mode: meta の projection を保持 */ };
        (camera as any).__uikaProjLocked = true;
    }
    camera.updateMatrixWorld(true);
    (window as any).__uikaCameraIntrinsics = {
        canvas: [W, H], scale, fx, fy, cx, cy, poseApplied: applyPose,
        isotropic: fx === fy,
        frustum: { left, right, top, bottom, near: M.near, far: M.far },
        P00: camera.projectionMatrix.elements[0],
        P11: camera.projectionMatrix.elements[5],
    };
    return errs;
}

/**
 * OrbitControls の扱い。
 *
 * 初期フレームでは camera pose を meta のまま保ちたいので `update()` を
 * 止めておき、**ユーザーが pointer / touch / wheel で触った瞬間に本来の
 * `update()` へ戻す**。以降は OrbitControls が camera を持ち、
 * 上下左右の orbit と zoom ができる。
 *
 * `Viewer.update()` は `controls.enabled` に関係なく `controls.update()` を
 * 呼び (`:138815-138816`)、`OrbitControls.update()` の末尾は
 * `object.lookAt(target)` (`:59121`) なので、固定したい間は update 自体を
 * 止めるしかない。
 *
 * orbit target は meta.json の `look_at` = [0,0,0]。これは UIKA native の
 * yaw スイープ (`scripts/identity_probe.py:113-117`) が周回する中心そのもので、
 * UIKA canonical 空間で顔を見る際の回転中心である。ここを target にすることで
 * 初期 pose (`position = look_at + [0,0,radius]`, `lookAt(look_at)`) が
 * OrbitControls の状態と矛盾せず、1 フレーム目で pose が動かない。
 */
function setupControls(renderer: any, status: UikaModeStatus): boolean {
    const v = renderer?.viewer;
    const controls = v?.controls;
    if (!controls) return false;

    controls.target.set(UIKA_META_CAMERA.lookAt[0], UIKA_META_CAMERA.lookAt[1], UIKA_META_CAMERA.lookAt[2]);
    controls.enabled = true;                 // 入力は受け付ける

    if (!controls.__uikaSetup) {
        controls.__uikaSetup = true;
        controls.__uikaOriginalUpdate = controls.update;
        // 初回操作までは pose を動かさない
        controls.update = function () { /* UIKA mode: 初回操作まで camera pose を保持 */ };

        // zoom が破綻しないよう、meta の radius を基準に可動域を決める
        const R = UIKA_META_CAMERA.radius;
        controls.minDistance = R * 0.35;
        controls.maxDistance = R * 3.0;

        const dom = v.renderer?.domElement;
        const release = () => {
            if (status.userInteracted) return;
            status.userInteracted = true;
            status.orbitEnabled = true;
            controls.update = controls.__uikaOriginalUpdate;
            (window as any).__uikaOrbitReleased = true;
        };
        if (dom) {
            dom.addEventListener('pointerdown', release, { passive: true });
            dom.addEventListener('touchstart', release, { passive: true });
            dom.addEventListener('wheel', release, { passive: true });
        }
        (controls as any).__uikaRelease = release;
    }
    return true;
}

/**
 * depth sort の A/B。**UIKA mode のみ**。
 *
 * `Viewer.update()` は毎フレーム `this.runSplatSort(true, true)` を呼ぶ
 * (`module.js:138826`)。`force = true` なので、ライブラリ自身が持っている
 * 「視線角・位置がほとんど変わっていなければ sort しない」早期 return
 * (`module.js:139121-139128`) が**毎回バイパスされる**。
 * つまり 133,541 splat の sort が毎フレーム走る。
 *
 * ここでは `viewer.runSplatSort` を instance-level で差し替え、
 * モードに応じて**呼び出しそのものを間引く**。
 *
 *   full   … 何もしない (現状のまま)
 *   10fps  … 直前に通した sort から 100ms 未満なら飛ばす
 *   camera … 初回 sort 以降は、camera の position / quaternion が
 *            変化したときと、pointer / wheel 操作中だけ通す。
 *            **A2E の expression 変化だけでは sort しない。**
 *
 * 飛ばすのは depth sort だけで、expression による Gaussian center の変形と
 * 描画は従来どおり毎フレーム行われる (morph は `runMorphUpdate()` と
 * shader 側の bsCount ループで、sort とは別経路)。
 *
 * 飛ばすときは `Promise.resolve(false)` を返す。これは元の実装が
 * 早期 return で返すのと同じ値 (`module.js:139127`)。
 */
/**
 * `runMorphUpdate()` の毎フレーム全量再構築をやめる (UIKA mode 限定)。
 *
 * ## 何が無駄か (実測)
 * `module.js:139478-139524` の `runMorphUpdate()` は毎フレーム
 *   1. `new Float32Array(position.array)` = 133,541 × 3 float = **1.60 MB を新規確保**
 *   2. `fillSplatCenterArray` で 133,541 点を詰め替え
 *   3. center/color texture を**全量再アップロード**
 * を行う。しかし UIKA mode では `baseData.centers` のハッシュが
 * **全フレーム同一** (`761531216`、`idleMode=rigidPivot` / `off` ともに実測)。
 * 理由は構造的で、`position` attribute は `cano_nose90` で固定、`sceneTransform` も
 * 固定、head bone slot は毎フレーム恒等に上書きしており、A2E morph は shader 側で
 * `flameModelTexture` + `bsWeight` から加算される経路なので center には入らない。
 * つまり**毎フレーム同じ結果を作り直して送り直している**。
 *
 * ## 何が必要か
 * A2E を GPU へ渡すのに必要なのは `bsWeight` (51 float) だけで、それは
 * `splatMesh.updateBoneMatrixTexture()` (`module.js:64775-64808`) が単独で行う
 * (小さい `boneMatrix` texture に書いて `needsUpdate` を立て、uniform を貼り直す。
 *  center/color texture には触らない)。
 * head compensation のために `skeleton.update()` も必要。
 *
 * ## 初回だけ完全実行する理由
 * 元の `runMorphUpdate()` は初回に
 *   - `splatMesh.bonesNum = 5` (bsWeight の書き込みオフセットに使われる)
 *   - `skinIndex` / `skinWeight` の InstancedBufferAttribute コピー
 *     (`setSkinAttibutes` ガード付き。`splatIndex` attribute が出来てからでないと走らない)
 *   - `splatMesh.morphedMesh` と centers の初回アップロード
 * を行うので、それらが揃うまでは完全実行する。
 *
 * renderer package には一切触らない。`?morphFast=off` で元の挙動に戻せる。
 */
function setupMorphFastPath(renderer: any, status: UikaModeStatus): boolean {
    const v = renderer?.viewer;
    if (!v || typeof v.runMorphUpdate !== 'function') return false;
    if (!status.morphFast) return false;
    if (v.__uikaMorphFastHooked) return true;
    v.__uikaMorphFastHooked = true;

    const origMorph = v.runMorphUpdate.bind(v);
    const MIN_FULL_RUNS = 30;        // 初期化が揃うまでの余裕 (起動時のみのコスト)
    let fullRuns = 0;
    let ready = false;

    (window as any).__uikaForceFullMorph = () => { ready = false; fullRuns = 0; };

    v.runMorphUpdate = function (...a: any[]) {
        if (!ready) {
            const z = origMorph(...a);
            fullRuns++;
            status.morphFullRuns = fullRuns;
            const initDone = v.setSkinAttibutes === true
                && v.splatMesh?.splatDataTextures?.['flameModel'] !== undefined;
            if (initDone && fullRuns >= MIN_FULL_RUNS) ready = true;
            return z;
        }
        // 以降は centers を作り直さない。skeleton と bsWeight だけ更新する。
        try {
            if (v.useFlame === false) {
                v.skinModel?.skeleton?.update?.();
                v.boneRoot?.updateMatrixWorld?.(true);
            }
            v.splatMesh?.updateBoneMatrixTexture?.(v.useFlame === true);
            status.morphFastFrames++;
        } catch (e: any) {
            status.errors.push('morphFast:' + e?.message);
            ready = false;        // 失敗したら完全実行へ戻す
        }
        return undefined;
    };
    return true;
}

function setupSortMode(renderer: any, status: UikaModeStatus): boolean {
    const v = renderer?.viewer;
    if (!v || typeof v.runSplatSort !== 'function') return false;
    if (v.__uikaSortHooked) return true;
    if (status.sortMode === 'full') { v.__uikaSortHooked = true; return true; }
    v.__uikaSortHooked = true;

    const orig = v.runSplatSort;                 // arrow property。bind 不要
    let firstDone = false;
    let lastAcceptedAt = -Infinity;
    let pointerUntil = 0;                        // ユーザー操作中だけ開く窓

    const dom = v.renderer?.domElement;
    if (dom) {
        const mark = () => { pointerUntil = performance.now() + 400; };
        dom.addEventListener('pointerdown', mark, { passive: true });
        dom.addEventListener('pointermove', () => { if (pointerUntil > 0) mark(); }, { passive: true });
        dom.addEventListener('pointerup', mark, { passive: true });
        dom.addEventListener('touchstart', mark, { passive: true });
        dom.addEventListener('touchmove', mark, { passive: true });
        dom.addEventListener('wheel', mark, { passive: true });
    }

    const accept = (force: any, forceSortAll: any) => {
        lastAcceptedAt = performance.now();
        status.sortsAccepted++;
        return orig(force, forceSortAll);
    };

    v.runSplatSort = function (force?: any, forceSortAll?: any) {
        if (!firstDone) { firstDone = true; return accept(force, forceSortAll); }
        const now = performance.now();
        let allow: boolean;
        if (status.sortMode === '10fps') {
            allow = (now - lastAcceptedAt) >= 100;          // 最大 10Hz
        } else {                                            // 'camera'
            // `v.camera` は idleMode='rigid' のとき head compensation 後の
            // C_render になっており、A2E / idle head motion だけで毎フレーム
            // 変化する。これを「camera 移動」と誤認しないよう、camera mode の
            // 判定は C_orbit を動かす要因 = ユーザー操作だけを見る
            // (初回 sort は上の firstDone で常に通す)。
            allow = now < pointerUntil;
        }
        if (!allow) { status.sortsSkipped++; return Promise.resolve(false); }
        return accept(force, forceSortAll);
    };
    return true;
}

/**
 * 画面上の診断パネル。DevTools を開かずに A/B の数値を読めるようにする。
 * UIKA mode のときだけ出し、通常 LAM には一切出さない。
 * 値は `window.__uikaA2EStats` (lam-websocket-manager が集計) と
 * `window.__uikaMainGap` (core-controller の heartbeat が集計) を読むだけで、
 * 同期ロジック・描画・A2E 値には触らない。
 */
function updateDiagHud(status: UikaModeStatus): void {
    if (typeof document === 'undefined' || !document.body) return;
    let el = document.getElementById('uikaDiagHud') as HTMLDivElement | null;
    if (!el) {
        el = document.createElement('div');
        el.id = 'uikaDiagHud';
        el.style.cssText = [
            'position:fixed', 'top:6px', 'left:8px', 'z-index:2147483647',
            'font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
            'color:#fff', 'background:rgba(0,0,0,.72)', 'padding:6px 9px',
            'border-radius:5px', 'pointer-events:none', 'user-select:none',
            'white-space:pre', 'max-width:60vw',
        ].join(';');
        document.body.appendChild(el);
    }
    const w = window as any;
    const a = w.__uikaA2EStats;
    const g = w.__uikaMainGap || { count: 0, maxMs: 0 };
    const f = (x: any, n = 0) => (typeof x === 'number' ? x.toFixed(n) : '-');

    let iv50 = '-', iv95 = '-', ivMax = '-', frames = 0;
    if (a && a.renderTimes && a.renderTimes.length > 2) {
        const t = a.renderTimes;
        frames = t.length;
        const d: number[] = [];
        for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
        d.sort((x, y) => x - y);
        const q = (pp: number) => d[Math.min(d.length - 1, Math.floor(pp * d.length))].toFixed(1);
        iv50 = q(0.5); iv95 = q(0.95); ivMax = d[d.length - 1].toFixed(1);
    }
    const st = a && a.last;
    const openMs = a && a.clampOpenAt !== null && a.clampOpenAt !== undefined
        ? performance.now() - a.clampOpenAt : 0;

    el.textContent =
        'UIKA DIAG  exprPath=' + (a ? a.exprPath : (status.enabled ? '(待機)' : '-')) + '\n'
        + 'playback ' + f(st && st.playbackMs) + 'ms  coverage ' + f(st && (st.bufferFrames / st.fps * 1000))
        + 'ms  buf ' + f(st && st.bufferFrames) + '\n'
        + 'req ' + f(st && st.requestedFrame) + ' -> sel ' + f(st && st.selectedFrame)
        + '  clamped ' + (st ? String(st.clamped) : '-') + '\n'
        + 'clamp  回数 ' + f(a && a.clampCount) + '  累計 ' + f(a && a.clampTotalMs)
        + 'ms  最長 ' + f(a && Math.max(a.clampMaxMs, openMs)) + 'ms\n'
        + 'maxLag ' + f(a && a.maxLag) + ' frames'
        + '  初回expr pb ' + f(a && a.firstExprPlaybackMs) + 'ms / cov ' + f(a && a.firstExprCoverageMs) + 'ms\n'
        + 'render ' + frames + ' 回  p50 ' + iv50 + '  p95 ' + iv95 + '  max ' + ivMax + 'ms\n'
        + 'MAIN GAP 回数 ' + g.count + '  最大 ' + f(g.maxMs, 1) + 'ms\n'
        + 'sort ' + status.sortMode + ' / idle ' + idleModeLabel(status.idleMode)
        + ' / blink ' + status.blinkMode + (status.morphFast ? ' / fast' : '');
}

/** テスト用の小さなモード表示。UIKA debug URL のときだけ出す。 */
function showSortModeBadge(status: UikaModeStatus): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById('uikaSortBadge')) return;
    const el = document.createElement('div');
    el.id = 'uikaSortBadge';
    el.textContent = 'UIKA / SORT ' + status.sortMode.toUpperCase()
                   + ' / IDLE ' + idleModeLabel(status.idleMode)
                   + ' / BLINK ' + status.blinkMode.toUpperCase()
                   + (status.morphFast ? ' / FAST' : ' / FAST OFF');
    el.style.cssText = [
        'position:fixed', 'top:6px', 'right:8px', 'z-index:2147483647',
        'font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
        'letter-spacing:.04em', 'color:#fff', 'background:rgba(0,0,0,.62)',
        'padding:3px 7px', 'border-radius:4px', 'pointer-events:none',
        'user-select:none',
    ].join(';');
    document.body.appendChild(el);
}

const IDENTITY16 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

/**
 * Idle blink レイヤー (最小の補助機能)。
 *
 * `animation.glb` には morph (`weights`) トラックが 1 本も無いことを実データで
 * 確認済みなので、通常 LAM にも blink の源は A2E しか無い。Idle 中に
 * 「生きて見える」ために、**`eyeBlinkLeft` / `eyeBlinkRight` だけ**を
 * 独立レイヤーとして足す。眉・頬・口へはランダムノイズを入れない。
 *
 * - 固定周期にしない。次の blink までを 2.6〜6.4 秒で散らす
 * - 1 回の blink は 180ms 程度 (閉じ 80ms / 開き 100ms) で左右ほぼ同時
 *   (右目を 8ms 遅らせる程度)
 * - A2E が blink を出しているときは競合させない:
 *     final = clamp(max(a2eBlink, procedural), 0, 1)
 * - いまは Idle 中のみ (`chatState !== 'Responding'`)
 * - 乱数は seed 可能 (`?blinkSeed=` / 既定 1)
 */
function makeBlinker(seed: number) {
    let st = (seed >>> 0) || 1;
    const rnd = () => {                       // mulberry32
        st |= 0; st = (st + 0x6D2B79F5) | 0;
        let t = Math.imul(st ^ (st >>> 15), 1 | st);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const CLOSE_MS = 80, OPEN_MS = 100, GAP_MIN = 2600, GAP_MAX = 6400, R_DELAY = 8;
    let next = -1, count = 0;
    const shape = (dt: number) => {
        if (dt < 0 || dt > CLOSE_MS + OPEN_MS) return 0;
        const x = dt < CLOSE_MS ? dt / CLOSE_MS : 1 - (dt - CLOSE_MS) / OPEN_MS;
        return 0.5 - 0.5 * Math.cos(Math.PI * Math.min(Math.max(x, 0), 1));  // smoothstep 的
    };
    return {
        get count() { return count; },
        value(now: number): [number, number] {
            if (next < 0) { next = now + GAP_MIN + rnd() * (GAP_MAX - GAP_MIN); return [0, 0]; }
            const dt = now - next;
            if (dt > CLOSE_MS + OPEN_MS) {
                next = now + GAP_MIN + rnd() * (GAP_MAX - GAP_MIN); count++; return [0, 0];
            }
            return [shape(dt), shape(dt - R_DELAY)];
        },
    };
}

function setupIdleBlink(
    renderer: any,
    status: UikaModeStatus,
    getChatState?: () => string,
): boolean {
    if (renderer.__uikaBlinkHooked) return true;
    const orig = renderer.getExpressionData;
    if (typeof orig !== 'function') return false;
    renderer.__uikaBlinkHooked = true;
    let seed = 1;
    try { seed = parseInt(new URLSearchParams(window.location.search).get('blinkSeed') || '1', 10) || 1; }
    catch { /* noop */ }
    const b = makeBlinker(seed);
    renderer.getExpressionData = function () {
        const out = orig.call(this);
        try {
            // chatState は renderer の内部 property ではなく、
            // LAMWebSocketManager から渡された getter で読む。
            // getter が無い場合は blink しない (推測で判定しない)。
            const chatState = typeof getChatState === 'function' ? getChatState() : null;
            // blinkMode='always' は chatState を問わず合成する (発話中 blink の A/B)。
            // 合成は常に max(a2eBlink, proceduralBlink) で 0〜1 clamp。
            const allowBlink = status.blinkMode === 'always'
                ? true
                : (chatState !== null && chatState !== 'Responding');
            if (allowBlink) {
                const [l, r] = b.value(performance.now());
                if (l > 0 || r > 0) {
                    out.eyeBlinkLeft  = Math.min(1, Math.max(out.eyeBlinkLeft  || 0, l));
                    out.eyeBlinkRight = Math.min(1, Math.max(out.eyeBlinkRight || 0, r));
                }
                status.blinkCount = b.count;
            }
        } catch { /* noop */ }
        return out;
    };
    return true;
}

/**
 * head rigid motion を **camera 側へ**合成する (idleMode = 'rigid')。
 *
 * ## なぜ camera か
 * shader (`module.js:61785-61809`) は `head` bone の skinning 行列 `H_head(t)` を
 * **全 splat の center** に掛ける。一方 covariance は
 * `transformModelViewMatrix` だけから作られ (`module.js:62413/62439`)、
 * `H_head` を受けない。そのため splat 側に H を掛けると
 * 「center は動くが楕円の向きが追従しない」不整合が出る。
 *
 * `H_head` は全 splat に共通で掛かる **rigid transform** である
 * (`animation.glb` 全 12 clip で実測: 特異値 [0.999999, 1.000000] /
 *  det [+0.999998, +1.000000] / max|AᵀA−I| = 1.610e-06)。
 * rigid なら「全点に H を掛ける」ことと「camera に等価変換を掛ける」ことは
 * 描画として等価で、かつ camera 経由なら center と covariance が
 * **同じ view 変換**を受けるため上記の不整合が起きない。
 *
 * ## 行列の向き
 * three.js は column-vector / column-major (`projectionMatrix * modelViewMatrix * position`,
 * `viewMatrix = camera.matrixWorldInverse`)。通常 LAM の投影は
 *
 *     clip = P · V · H · p
 *
 * なので、splat 側に H を掛けない UIKA でこれと一致させるには
 *
 *     V_render = V_orbit · H      ⟹      C_render = inverse(H) · C_orbit
 *
 * である。**`H · C_orbit` ではない。**
 *
 * ## C_orbit と C_render の分離
 * OrbitControls が次フレームで `C_render` を基準にしてしまうとドリフトするので、
 * - `viewer.update()` の**先頭**で camera を `C_orbit` に戻してから
 *   `controls.update()` にユーザー操作を反映させ、
 * - `runMorphUpdate()` の**直後** (= `skeleton.update()` の後、
 *   `runSplatSort` と `render` の前) に `C_orbit` を控えてから `C_render` を書く。
 * これで OrbitControls は `C_render` を一度も見ない。
 */
function setupHeadCompensation(renderer: any, status: UikaModeStatus): boolean {
    const v = renderer?.viewer;
    if (!v || (status.idleMode !== 'rigid' && status.idleMode !== 'rigidPivot')) return false;
    if (v.__uikaHeadCompHooked) return true;
    if (typeof v.runMorphUpdate !== 'function' || typeof v.update !== 'function') return false;
    v.__uikaHeadCompHooked = true;

    const camera = v.camera;
    const M4 = camera.matrixWorld.constructor;
    const H = new M4(), Happ = new M4(), Hinv = new M4(), Crender = new M4();
    const orbitWorld = new M4().copy(camera.matrixWorld);
    let haveOrbit = false;

    // T(d) / T(-d)。three.js は column-major なので translation は elements[12..14]。
    const usePivot = status.idleMode === 'rigidPivot';
    const d = UIKA_CANO_TO_LAM_BIND;
    const Td = new M4(), Tmd = new M4();          // new Matrix4() は恒等
    Td.elements[12] = d[0];  Td.elements[13] = d[1];  Td.elements[14] = d[2];
    Tmd.elements[12] = -d[0]; Tmd.elements[13] = -d[1]; Tmd.elements[14] = -d[2];
    status.pivotApplied = usePivot;

    /**
     * 実際に camera へ合成する行列を H から作る。
     *   rigid      : H_app = H_head
     *   rigidPivot : H_app = T(-d) · H_head · T(d)
     * (Matrix4.multiply(m) は this·m なので下の 2 行で T(-d)·H·T(d))
     */
    const toApplied = () => {
        if (!usePivot) return Happ.copy(H);
        Happ.multiplyMatrices(Tmd, H).multiply(Td);
        return Happ;
    };

    const origUpdate = v.update.bind(v);
    const origMorph = v.runMorphUpdate.bind(v);

    v.update = function (...a: any[]) {
        // フレーム先頭: controls が触る前に C_orbit へ戻す
        if (haveOrbit) {
            orbitWorld.decompose(camera.position, camera.quaternion, camera.scale);
            camera.updateMatrixWorld(true);
        }
        return origUpdate(...a);
    };

    v.runMorphUpdate = function (...a: any[]) {
        const z = origMorph(...a);                 // この中で skeleton.update() が走る
        try {
            const sm = v.splatMesh;
            const { skeleton, headIndex } = getSkeletonAndHeadIndex(sm);
            if (!skeleton?.boneMatrices || headIndex < 0) return z;
            const off = headIndex * 16;
            H.fromArray(skeleton.boneMatrices as any, off);

            // splat 側には H を掛けない。shader が読む head スロットを恒等にする。
            // (headBoneIndex を負にすると `skinned` が 0 のままになり全点が原点へ
            //  潰れるので、スロットの中身を恒等にする方法を採る)
            for (let i = 0; i < 16; i++) skeleton.boneMatrices[off + i] = IDENTITY16[i];
            if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true;
            status.headNeutralized = true;
            status.hHeadMaxAbsDiffFromIdentityApplied = (() => {
                let mx = 0; const e = H.elements;
                for (let i = 0; i < 16; i++) { const d = Math.abs(e[i] - IDENTITY16[i]); if (d > mx) mx = d; }
                return mx;
            })();

            // C_orbit を控えて C_render = inverse(H_app) · C_orbit を書く
            camera.updateMatrixWorld(true);
            orbitWorld.copy(camera.matrixWorld); haveOrbit = true;
            const Ha = toApplied();
            if (usePivot) {
                let mx = 0; const e = Ha.elements;
                for (let i = 0; i < 16; i++) { const df = Math.abs(e[i] - IDENTITY16[i]); if (df > mx) mx = df; }
                status.hPivotMaxAbsDiffFromIdentity = mx;
            }
            Hinv.copy(Ha).invert();
            Crender.multiplyMatrices(Hinv, orbitWorld);
            Crender.decompose(camera.position, camera.quaternion, camera.scale);
            camera.updateMatrixWorld(true);
        } catch (e: any) { status.errors.push('headComp:' + e?.message); }
        return z;
    };

    // 投影一致の数値検証: P·V_orbit·H·p  と  P·V_render·p
    (window as any).__uikaVerifyProjection = () => {
        const V3 = camera.position.constructor;
        const pts = [[0,0,0],[0.1,0,0],[0,0.1,0],[0,0,0.1],[0.115407,0.133521,0.060738],[-0.207022,-0.177291,-0.207337]];
        const Vorbit = new M4().copy(orbitWorld).invert();
        const Vrender = new M4().copy(camera.matrixWorldInverse);
        const P = camera.projectionMatrix;
        const Ha = toApplied();
        let worst = 0; const rows: any[] = [];
        for (const q of pts) {
            const a = new V3(q[0], q[1], q[2]).applyMatrix4(Ha).applyMatrix4(Vorbit).applyMatrix4(P);
            const b = new V3(q[0], q[1], q[2]).applyMatrix4(Vrender).applyMatrix4(P);
            const d = Math.max(Math.abs(a.x-b.x), Math.abs(a.y-b.y), Math.abs(a.z-b.z));
            if (d > worst) worst = d;
            rows.push({ p: q, lam: [a.x, a.y, a.z], uika: [b.x, b.y, b.z], diff: d });
        }
        status.projParityMaxDiff = worst;
        return {
            maxAbsDiff: worst, rows,
            H: Array.from(H.elements),
            Happlied: Array.from(toApplied().elements),
            idleMode: status.idleMode,
            d: [d[0], d[1], d[2]],
        };
    };

    /**
     * 検証用: 現フレームの H_head / H_app を cano 頂点に当てたときの変位統計。
     * `avatarMesh.geometry.attributes.position` は cano_nose90 そのもの
     * (`module.js:139478-139480` が毎フレームこれを splat center の素にしている)。
     */
    (window as any).__uikaPivotStats = (stride = 37) => {
        const pos = v.avatarMesh?.geometry?.attributes?.position?.array;
        if (!pos) return { error: 'position attribute が無い' };
        const Ha = toApplied();
        const e = H.elements, a = Ha.elements;
        let nRaw = 0, sRaw = 0, mxRaw = 0, sApp = 0, mxApp = 0, bad = 0;
        for (let i = 0; i + 2 < pos.length; i += 3 * stride) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { bad++; continue; }
            const rx = e[0] * x + e[4] * y + e[8] * z + e[12] - x;
            const ry = e[1] * x + e[5] * y + e[9] * z + e[13] - y;
            const rz = e[2] * x + e[6] * y + e[10] * z + e[14] - z;
            const ax = a[0] * x + a[4] * y + a[8] * z + a[12] - x;
            const ay = a[1] * x + a[5] * y + a[9] * z + a[13] - y;
            const az = a[2] * x + a[6] * y + a[10] * z + a[14] - z;
            const lr = Math.sqrt(rx * rx + ry * ry + rz * rz);
            const la = Math.sqrt(ax * ax + ay * ay + az * az);
            sRaw += lr; sApp += la;
            if (lr > mxRaw) mxRaw = lr;
            if (la > mxApp) mxApp = la;
            nRaw++;
        }
        return {
            idleMode: status.idleMode, samples: nRaw, nonFinite: bad,
            meanAbsDispRawH: nRaw ? sRaw / nRaw : null, maxAbsDispRawH: mxRaw,
            meanAbsDispApplied: nRaw ? sApp / nRaw : null, maxAbsDispApplied: mxApp,
        };
    };
    return true;
}

/**
 * UIKA mode を適用し、毎フレーム状態を維持しつつ H_head を実測する。
 * 返り値の status は `window.__uikaStatus` にも出す (検証用)。
 */
export interface Uika133kModeOptions {
    /**
     * 現在の chatState を返す getter。Travel-sp では
     * `LAMWebSocketManager.chatState` を `() => this.chatState` で渡す。
     * blink の Idle 判定にだけ使う。
     */
    getChatState?: () => string;
}

export function applyUika133kMode(
    renderer: any,
    options: Uika133kModeOptions = {},
): UikaModeStatus {
    const status: UikaModeStatus = {
        enabled: true,
        headBoneIndex: -1,
        hHeadMaxAbsDiffFromIdentity: Number.NaN,
        hHeadIsIdentity: false,
        ready: false,
        gateReported: false,
        userInteracted: false,
        orbitEnabled: false,
        sortMode: getUikaSortMode(),
        idleMode: getUikaIdleMode(),
        headCompHooked: false,
        headNeutralized: false,
        hHeadMaxAbsDiffFromIdentityApplied: Number.NaN,
        pivotApplied: false,
        hPivotMaxAbsDiffFromIdentity: Number.NaN,
        projParityMaxDiff: Number.NaN,
        blinkEnabled: false,
        blinkMode: getUikaBlinkMode(),
        blinkCount: 0,
        morphFast: getUikaMorphFast(),
        morphFastHooked: false,
        morphFullRuns: 0,
        morphFastFrames: 0,
        sortHooked: false,
        sortsAccepted: 0,
        sortsSkipped: 0,
        splatCount: null,
        bsCount: null,
        cameraApplied: false,
        posePinned: false,
        controlsNeutralized: false,
        animationStopped: false,
        frames: 0,
        errors: [],
    };

    const apply = () => {
        // ===== camera を最初に確定する =====
        // 初期化の 1 回目で meta camera の pose (position = look_at + [0,0,radius],
        // lookAt(look_at)) と projection を確定し、**その pose を基準に**
        // setupControls() / setupHeadCompensation() を初期化する。
        // 2 回目以降は pose を meta へ再固定せず、intrinsics だけ維持する:
        //   - idleMode='rigid' : head compensation の C_orbit → C_render 管理に任せる
        //   - idleMode='off'   : head compensation が無いので、初回操作までは
        //                        pose を保持し続ける (0257113 と同じ挙動)
        //   - ユーザー操作後    : OrbitControls が pose を持つので触らない
        const pinPose = !status.posePinned
                     || (status.idleMode === 'off' && !status.userInteracted);
        status.errors.push(...applyUikaCamera(renderer, pinPose));
        status.cameraApplied = true;
        status.posePinned = true;

        status.controlsNeutralized = setupControls(renderer, status);

        // head compensation より先に入れる。
        // 結果の呼び出し順は headComp wrapper → fastPath → (skeleton.update + bsWeight)
        // → headComp が H を読んで head slot を恒等化 → camera を書く、となる。
        status.morphFastHooked = setupMorphFastPath(renderer, status);

        if (status.idleMode === 'off') {
            status.errors.push(...stopSkeletalAnimation(renderer));
            status.animationStopped = true;
        } else {
            status.animationStopped = false;
            status.headCompHooked = setupHeadCompensation(renderer, status);
            status.blinkEnabled = setupIdleBlink(renderer, status, options.getChatState);
        }
        status.sortHooked = setupSortMode(renderer, status);

        const sm = renderer?.viewer?.splatMesh;
        const { skeleton, headIndex } = getSkeletonAndHeadIndex(sm);
        status.headBoneIndex = headIndex;
        if (skeleton?.boneMatrices && headIndex >= 0) {
            const h = skeleton.boneMatrices.slice(headIndex * 16, headIndex * 16 + 16);
            status.hHeadMaxAbsDiffFromIdentity = maxAbsDiffFromIdentity(h);
            status.hHeadIsIdentity = status.hHeadMaxAbsDiffFromIdentity < H_HEAD_IDENTITY_TOL;
            // splat mesh と skeleton が揃って初めて gate を評価できる。
            // getInstance 直後の 1 回目はまだ揃っていないので判定しない。
            status.ready = true;
        }
        try { status.splatCount = sm?.getSplatCount?.() ?? null; } catch { /* noop */ }
        try { status.bsCount = sm?.material?.uniforms?.bsCount?.value ?? null; } catch { /* noop */ }
        status.frames++;
        (window as any).__uikaStatus = status;
    };

    apply();
    showSortModeBadge(status);

    // 毎フレーム維持する。Runtime 側のループが再度 pose / camera を動かしても
    // 次のフレームで戻す。
    let hudAt = 0;
    const tick = () => {
        apply();
        // 画面パネルは 5Hz まで (毎フレーム DOM を触らない)
        const nowHud = performance.now();
        if (nowHud - hudAt >= 200) { hudAt = nowHud; try { updateDiagHud(status); } catch { /* noop */ } }
        if (status.ready && !status.gateReported) {
            status.gateReported = true;
            if (status.hHeadIsIdentity) {
                console.log('[UIKA133K] GATE 合格: max|H_head - I| = '
                            + status.hHeadMaxAbsDiffFromIdentity
                            + ' (< ' + H_HEAD_IDENTITY_TOL + '), headBoneIndex='
                            + status.headBoneIndex + ', splatCount=' + status.splatCount
                            + ', bsCount=' + status.bsCount);
            } else {
                console.error('[UIKA133K] GATE 不合格: max|H_head - I| = '
                              + status.hHeadMaxAbsDiffFromIdentity);
            }
        }
        if (status.ready && !status.hHeadIsIdentity && status.frames % 60 === 0) {
            console.error('[UIKA133K] H_head が恒等でない: max|H-I| =',
                          status.hHeadMaxAbsDiffFromIdentity);
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    return status;
}

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

/** H_head が恒等とみなせる上限。指示どおりの gate。 */
export const H_HEAD_IDENTITY_TOL = 1e-6;

export interface UikaModeStatus {
    enabled: boolean;
    headBoneIndex: number;
    hHeadMaxAbsDiffFromIdentity: number;
    hHeadIsIdentity: boolean;
    ready: boolean;
    gateReported: boolean;
    splatCount: number | null;
    bsCount: number | null;
    cameraApplied: boolean;
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

/** meta.json の intrinsics から projection matrix を作って camera に入れる。 */
function applyUikaCamera(renderer: any): string[] {
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
    camera.position.set(M.lookAt[0], M.lookAt[1], M.lookAt[2] + M.radius);
    camera.lookAt(M.lookAt[0], M.lookAt[1], M.lookAt[2]);
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
        canvas: [W, H], scale, fx, fy, cx, cy,
        isotropic: fx === fy,
        frustum: { left, right, top, bottom, near: M.near, far: M.far },
        P00: camera.projectionMatrix.elements[0],
        P11: camera.projectionMatrix.elements[5],
    };
    return errs;
}

/** OrbitControls が camera pose を上書きしないようにする。 */
function neutralizeControls(renderer: any): boolean {
    const controls = renderer?.viewer?.controls;
    if (!controls) return false;
    controls.target.set(UIKA_META_CAMERA.lookAt[0], UIKA_META_CAMERA.lookAt[1], UIKA_META_CAMERA.lookAt[2]);
    controls.enabled = false;
    if (!controls.__uikaNeutralized) {
        controls.update = function () { /* UIKA mode: camera pose を上書きしない */ };
        controls.__uikaNeutralized = true;
    }
    return true;
}

/**
 * UIKA mode を適用し、毎フレーム状態を維持しつつ H_head を実測する。
 * 返り値の status は `window.__uikaStatus` にも出す (検証用)。
 */
export function applyUika133kMode(renderer: any): UikaModeStatus {
    const status: UikaModeStatus = {
        enabled: true,
        headBoneIndex: -1,
        hHeadMaxAbsDiffFromIdentity: Number.NaN,
        hHeadIsIdentity: false,
        ready: false,
        gateReported: false,
        splatCount: null,
        bsCount: null,
        cameraApplied: false,
        controlsNeutralized: false,
        animationStopped: false,
        frames: 0,
        errors: [],
    };

    const apply = () => {
        status.errors.push(...stopSkeletalAnimation(renderer));
        status.animationStopped = true;
        status.controlsNeutralized = neutralizeControls(renderer);
        status.errors.push(...applyUikaCamera(renderer));
        status.cameraApplied = true;

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

    // 毎フレーム維持する。Runtime 側のループが再度 pose / camera を動かしても
    // 次のフレームで戻す。
    const tick = () => {
        apply();
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

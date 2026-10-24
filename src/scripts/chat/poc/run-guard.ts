/**
 * PoC: 性能計測 run の前提条件チェック (指示書 §5 / §6)
 *
 * 目的は **計測の有効性判定だけ**。描画も lip-sync も一切変えない。
 *
 * 計測を始める前に「この run は本当に測りたい条件になっているか」を 1 行で出す。
 * 過去に `?morphFast=1&sortMode=10fps` で測った D が、実は
 * `skinMode=head / applied=false` のままだったため、
 * 「FULL133 + aligned multi-bone の性能」ではない数字を採ってしまった。
 * 同じ取り違えを二度とやらないための gate。
 *
 * 1 項目でも期待と違えば `RUN_VALID=false` を出す。
 * **描画は止めない** (アプリを壊さないため)。止める代わりに
 * `console.error` で目立たせ、`window.__runConfig.valid === false` を残す。
 * 集計する側がこれを見て run を破棄する。
 */

import { getSkinMode, type SkinMode } from './multibone-skinning';
import { getSortModeFlag, getAvatarIdForDiag } from './render-perf';
import { getMorphPath, type Full133MorphPath } from '../full133-runtime';
import { getSortPolicy, type SortPolicy } from './adaptive-sort';

/** FULL133 の Gaussian 数。`tools/uika_to_lam/build_full133.py` の出力と一致する値。 */
const EXPECTED_SPLATS_FULL133 = 133541;

/** splat 数の検証を掛ける avatarId。これ以外では件数を記録するだけで判定しない。 */
const FULL133_AVATAR_ID = 'uika-full133-skin';

export interface RunConfig {
    avatarId: string;
    splatCount: number;
    expectedSplatCount: number | null;
    skinMode: SkinMode;
    skinModeSource: string;
    multiBoneApplied: boolean;
    multiBoneReason: string;
    activeInfluenceLines: number;
    headOnlyLineActive: boolean;
    alignedLookupActive: boolean;
    morphPath: Full133MorphPath;
    morphPathSource: string;
    morphPathApplied: boolean;
    /** steady-state path を通ったフレーム数。0 のまま進まなければ効いていない。 */
    morphSteadyFrames: number;
    sortMode: 'full' | '10fps';
    sortApplied: boolean;
    sortPolicy: SortPolicy;
    sortPolicySource: string;
    sortPolicyApplied: boolean;
    sortPolicyBackend: 'gpu' | 'cpu' | null;
    gpuAcceleratedSort: boolean | null;
    diagMode: string;
    build: string;
    rendererBundle: string;
    chrome: string;
    gl: string;
    viewport: string;
    dpr: number;
    /** 期待と違った項目。空なら valid。 */
    violations: string[];
    valid: boolean;
}

/** 読み込まれている renderer の bundle 名。版の指紋として使う (推測値を書かない)。 */
function findBundle(pattern: RegExp): string {
    try {
        const hit = performance.getEntriesByType('resource')
            .map((e) => e.name)
            .filter((n) => pattern.test(n))
            .pop();
        return hit ? hit.split('/').pop()! : 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

/** GPU / ANGLE backend。renderer 自身の context から取る (別 context を作らない)。 */
function readGlInfo(renderer: any): string {
    try {
        const gl = renderer?.viewer?.renderer?.getContext?.();
        if (!gl) return 'unknown (context 取得不可)';
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (!ext) return String(gl.getParameter(gl.VERSION));
        return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    } catch (e) {
        return 'unknown';
    }
}

/**
 * 期待条件を渡して検証する。
 *
 * `expect` を省略すると URL パラメータがそのまま期待値になる
 * (= 「指定したとおりに効いているか」だけを見る)。
 */
export function buildRunConfig(renderer: any, diagMode: string): RunConfig {
    const v = renderer?.viewer;
    const patch = (window as any).__multiBoneSkinPatch ?? {};
    // URL 指定が無い場合は avatar-config 由来になるので、実際に決まった値を使う。
    const skinMode = (patch?.mode as SkinMode) ?? getSkinMode();
    const perf = (window as any).__renderPerf ?? {};
    const adaptive = (window as any).__adaptiveSort ?? {};
    const full133 = (window as any).__full133Runtime ?? {};
    const avatarId = getAvatarIdForDiag();
    const splatCount = Number(v?.splatMesh?.getSplatCount?.() ?? 0);
    const expectedSplatCount = avatarId === FULL133_AVATAR_ID ? EXPECTED_SPLATS_FULL133 : null;

    const cfg: RunConfig = {
        avatarId,
        splatCount,
        expectedSplatCount,
        skinMode,
        skinModeSource: String(patch.source ?? 'unknown'),
        multiBoneApplied: patch.applied === true,
        multiBoneReason: String(patch.reason ?? '(未実行)'),
        activeInfluenceLines: Number(patch.activeInfluenceLines ?? 0),
        headOnlyLineActive: patch.headOnlyLineActive === true,
        alignedLookupActive: patch.alignedLookupActive === true,
        // URL 指定が無い場合は avatar-config 由来になるので、実際に決まった値を使う。
        morphPath: (full133?.mode as Full133MorphPath) ?? getMorphPath(),
        morphPathSource: String(full133?.source ?? 'unknown'),
        morphPathApplied: full133?.applied === true,
        morphSteadyFrames: Number(full133?.steadyFrames ?? 0),
        sortMode: getSortModeFlag(),
        sortApplied: perf?.sort?.applied === true,
        // URL 指定が無い場合は avatar-config 由来になるので、実際に決まった値を使う。
        sortPolicy: (adaptive?.mode as SortPolicy) ?? getSortPolicy(),
        sortPolicySource: String(adaptive?.source ?? 'unknown'),
        sortPolicyApplied: adaptive?.applied === true,
        sortPolicyBackend: adaptive?.backend ?? null,
        gpuAcceleratedSort: typeof v?.gpuAcceleratedSort === 'boolean' ? v.gpuAcceleratedSort : null,
        diagMode,
        build: findBundle(/lam-websocket-manager/),
        rendererBundle: findBundle(/gaussian-splat-renderer-for-lam/),
        chrome: navigator.userAgent,
        gl: readGlInfo(renderer),
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        dpr: window.devicePixelRatio,
        violations: [],
        valid: false,
    };

    const bad = cfg.violations;
    if (!cfg.avatarId || cfg.avatarId === 'unknown') bad.push('avatarId が取れない');
    if (expectedSplatCount !== null && splatCount !== expectedSplatCount) {
        bad.push(`splatCount=${splatCount} (期待 ${expectedSplatCount})`);
    }
    if (splatCount <= 0) bad.push('splatCount=0 (モデル未ロード)');

    // skinMode: 指定したモードが本当に当たっているか。head 指定なら applied=false が正しい。
    if (skinMode === 'head') {
        if (cfg.multiBoneApplied) bad.push('skinMode=head なのに multiBone applied=true');
    } else {
        if (!cfg.multiBoneApplied) bad.push(`skinMode=${skinMode} なのに multiBone applied=false (${cfg.multiBoneReason})`);
        if (cfg.activeInfluenceLines < 4) bad.push(`activeInfluenceLines=${cfg.activeInfluenceLines} (期待 4)`);
    }
    // 指示書 §5 の「sort-index-aligned skin lookup == active」。
    if (skinMode === 'aligned' && !cfg.alignedLookupActive) {
        bad.push('alignedLookupActive=false (splatIndex 基準の skin lookup が効いていない)');
    }

    // morphPath / sortMode: 指定 = 適用 が一致しているか。
    if ((cfg.morphPath !== 'stock') !== cfg.morphPathApplied) {
        bad.push(`morphPath=${cfg.morphPath} なのに applied=${cfg.morphPathApplied}`
            + ` (${full133?.reason ?? '理由不明'})`);
    }
    if (full133?.fallbackCount > 0) {
        bad.push(`FULL133 steady-state path が ${full133.fallbackCount} 回 fallback`
            + ` (${full133?.lastError ?? '理由不明'})`);
    }
    if ((cfg.sortMode === '10fps') !== cfg.sortApplied) {
        bad.push(`sortMode=${cfg.sortMode} なのに applied=${cfg.sortApplied}`);
    }
    if ((cfg.sortPolicy !== 'stock') !== cfg.sortPolicyApplied) {
        bad.push(`sortPolicy=${cfg.sortPolicy} なのに applied=${cfg.sortPolicyApplied}`
            + ` (${adaptive?.reason ?? '理由不明'})`);
    }

    cfg.valid = bad.length === 0;
    return cfg;
}

/** `[PERF RUN CONFIG]` を 1 行で出す (§6)。`window.__runConfig` にも残す。 */
export function logRunConfig(renderer: any, diagMode: string): RunConfig {
    const c = buildRunConfig(renderer, diagMode);
    (window as any).__runConfig = c;
    const line = '[PERF RUN CONFIG]'
        + ' avatarId=' + c.avatarId
        + ' splatCount=' + c.splatCount
        + ' skinMode=' + c.skinMode + '/' + c.multiBoneApplied + '/' + c.skinModeSource
        + ' multiBoneApplied=' + c.multiBoneApplied
        + ' influenceLines=' + c.activeInfluenceLines
        + ' alignedLookup=' + c.alignedLookupActive
        + ' headOnlyLine=' + c.headOnlyLineActive
        + ' morphPath=' + c.morphPath + '/' + c.morphPathApplied + '/' + c.morphPathSource
        + ' steadyFrames=' + c.morphSteadyFrames
        + ' sortMode=' + c.sortMode + '/' + c.sortApplied
        + ' sortPolicy=' + c.sortPolicy + '/' + c.sortPolicyApplied
        + '/' + c.sortPolicyBackend + '/' + c.sortPolicySource
        + ' gpuAcceleratedSort=' + c.gpuAcceleratedSort
        + ' diagMode=' + c.diagMode
        + ' build=' + c.build
        + ' renderer=' + c.rendererBundle
        + ' viewport=' + c.viewport + '@' + c.dpr
        + ' gl="' + c.gl + '"'
        + ' RUN_VALID=' + c.valid;
    if (c.valid) {
        console.log(line);
    } else {
        console.error(line + '\n  ↑ この run は性能集計に使えません: ' + c.violations.join(' / '));
    }
    return c;
}

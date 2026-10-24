// src/scripts/chat/poc/sort-mode.ts
//
// 【診断専用】`?gpuSort=0` で splat sort の GPU 距離計算を切る。
//
// 【なぜ要るか (installed renderer のコードで確定させたもの、推測ではない)】
//
// `Viewer.update()` は毎フレーム `runSplatSort(true, true)` を呼ぶ
// (`Viewer.js:2124`)。`gpuAcceleratedSort` が true のとき、その中で
// `SplatMesh.computeDistancesOnGPU()` が走り、
//
//   1. 全 splat ぶんの transform feedback draw
//        gl.drawArrays(gl.POINTS, 0, this.getSplatCount())
//   2. gl.fenceSync(SYNC_GPU_COMMANDS_COMPLETE) + gl.flush()
//   3. **fence 待ちを setTimeout のポーリングループで行う**
//        clientWaitSync(sync, 0, 0) が TIMEOUT_EXPIRED の間
//        setTimeout(checkSync) を張り直し続ける
//   4. 完了後 gl.getBufferSubData() で距離を CPU へ readback
//
// を行う (`SplatMesh.js:2009-2051`)。
//
// ここで 2 つの問題が起きる:
//
// (a) readback がフレーム内に終わらないと、次フレームの transform feedback が
//     同じ outDistancesBuffer を**先に上書き**してしまう。ANGLE はこれを
//       "READ-usage buffer was written, then fenced, but written again before
//        being read back. This discarded the shadow copy that was created to
//        accelerate readback."
//     として警告する。高速 readback パスが毎フレーム破棄されるので
//     readback はさらに遅くなる = 自己増幅する。
//
// (b) fence 待ちが `setTimeout` である。`setTimeout` のコールバックは
//     Socket.IO の `live_audio` / `live_expression` コールバックと**同じ
//     マクロタスクキュー**に並ぶ。さらに HTML 仕様では timer の nesting level が
//     5 を超えると 0/1ms 指定は 4ms へクランプされるので、ポーリング自体も
//     待たされながらキューを埋め続ける。
//     その間 `sortRunning` は true のままで (`Viewer.js:2401/2428`)、
//     次フレームの sort はスキップされる。
//
// `?gpuSort=0` にすると `runSplatSort` の
//   `if (this.gpuAcceleratedSort && ...) computeDistancesOnGPU(...)`
// が走らず、距離計算は sort worker 側 (`usePrecomputedDistances=false`) で
// 行われる。つまり上記の fence ポーリングと readback が経路から消える。
//
// 【介入範囲】
// `renderer.viewer.gpuAcceleratedSort` を false にするだけ。
// node_modules (production dependency) は書き換えない。
// フラグが無ければ**何もしない**ので、既定の挙動は出荷版のまま。

export type SortMode = 'gpu' | 'cpu';

export function getSortMode(): SortMode {
    try {
        return new URLSearchParams(window.location.search).get('gpuSort') === '0'
            ? 'cpu' : 'gpu';
    } catch (e) {
        return 'gpu';
    }
}

export interface SortModeResult {
    mode: SortMode;
    applied: boolean;
    reason: string;
    /** 切り替え後に renderer が実際に持っている値 (実測) */
    gpuAcceleratedSort: boolean | null;
}

/**
 * `viewer` が生えるまで rAF で待ってから当てる。
 * 結果は `window.__sortModePatch` に入る。
 */
export function installSortMode(renderer: any, mode: SortMode,
                                maxTries = 600): Promise<SortModeResult> {
    return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
            const viewer = renderer?.viewer;
            const ready = viewer && typeof viewer.gpuAcceleratedSort === 'boolean';
            if (ready || mode === 'gpu' || ++tries >= maxTries) {
                const r = applySortMode(renderer, mode);
                (window as any).__sortModePatch = r;
                resolve(r);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

export function applySortMode(renderer: any, mode: SortMode): SortModeResult {
    const viewer = renderer?.viewer;
    if (mode === 'gpu') {
        return {
            mode, applied: false,
            reason: 'gpuSort 未指定のため出荷版のまま (GPU 距離計算あり)',
            gpuAcceleratedSort: typeof viewer?.gpuAcceleratedSort === 'boolean'
                ? viewer.gpuAcceleratedSort : null,
        };
    }
    if (!viewer || typeof viewer.gpuAcceleratedSort !== 'boolean') {
        return {
            mode, applied: false,
            reason: 'viewer.gpuAcceleratedSort が見つからない (renderer 版が違う)',
            gpuAcceleratedSort: null,
        };
    }
    viewer.gpuAcceleratedSort = false;
    return {
        mode, applied: true,
        reason: 'gpuAcceleratedSort = false (fence ポーリングと readback を経路から外した)',
        gpuAcceleratedSort: viewer.gpuAcceleratedSort,
    };
}

/**
 * PoC: 1 フレームのコスト分解 (指示書 §13)
 *
 * 【なぜ必要か】
 * adaptive-cpu で splat sort は 60 秒に 1 回しか走らなくなった
 * (実測 `started=1` / `skippedUnchanged=3924`)。それでも
 * `overBudgetPct = 14.5%` が残っている。つまり **残りの long frame の
 * 原因は sort ではない**。どこが使っているのかを推測せずに測る。
 *
 * 【測り方】
 * renderer の毎フレーム経路は installed package 側に書かれている
 * (`rsrc/src/render.ts:271-330`、sourcemap から復元した正本):
 *
 *     requestAnimationFrame(() => this.render())
 *       animManager.update(chatState)
 *       expressionData = updateBS(getExpressionData())
 *       (useFlame === false) mixer.update(delta) → motioncfg → setExpression()
 *       viewer.update(renderer, camera)
 *          controls.update() / runMorphUpdate() / runSplatSort(true, true)
 *          updateForRendererSizeChanges() / updateSplatMesh()
 *       if (viewer.shouldRender()) viewer.render()
 *          → renderer.render(threeScene|splatMesh, camera) を 1〜4 回
 *
 * この経路上の関数を **instance レベルで包んで** 時間を採る。
 * node_modules は書き換えない。`?frameCost=1` が無ければ 1 行も実行しない。
 *
 * 【exclusive time (入れ子を二重計上しない)】
 * `runMorphUpdate` の中で `updateBoneMatrixTexture` が呼ばれ、
 * `viewer.render` の中で `THREE.WebGLRenderer.render` が呼ばれる。
 * 素朴に足すと合計が total を超える。そこで stack を持ち、
 * 各フレームについて **exclusive time** (自分の時間 − 子の時間) を記録する。
 * これにより
 *
 *     total === anim + expr + updateBS + mixer + setExpr + vUpdate
 *              + morph + bone + sort + render + other
 *
 * が**定義上**成立する (`other` = root の exclusive time = 未計測部分)。
 * 括弧内の数値を合わせるための補正は一切していない。
 *
 * 【注意】
 * - 計測自体に `performance.now()` 20 数回/フレームのコストが乗る。
 *   M0/M1 のような性能比較 run では **frameCost を付けないこと**。
 * - hook が当たらなかった項目は `hooked` が false になり、その時間は
 *   `other` か親の exclusive 時間に含まれる。取れなかったものを
 *   推定値で埋めることはしない。
 */

export const FRAME_COST_BUDGET_MS = 1000 / 30;

/** `[FRAME COST]` 行を出す上限。これを超えた long frame は集計だけに入る。 */
const MAX_LOGS = 40;

/** 保持するフレーム記録の上限。超えたら古い方を捨てる (直近を残す)。 */
const MAX_RECORDS = 20000;

/** 分解の内訳。すべて exclusive time (ms)。 */
export interface FrameBuckets {
    /** animManager.update() — idle / 表情以外のアニメーション */
    anim: number;
    /** getExpressionData() — A2E frame の取得 (Travel-sp 側の callback) */
    expr: number;
    /** updateBS() — 取得した expression の名前解決 */
    updateBS: number;
    /** mixer.update() — three.js skeletal animation */
    mixer: number;
    /** setExpression() — bsWeight への書き込み */
    setExpr: number;
    /** viewer.update() のうち morph / sort を除いた部分
     *  (controls.update / updateForRendererSizeChanges / updateSplatMesh) */
    vUpdate: number;
    /** runMorphUpdate() のうち bone texture 更新を除いた部分 */
    morph: number;
    /** splatMesh.updateBoneMatrixTexture() */
    bone: number;
    /** runSplatSort() の同期部分 (GPU readback の待ちは含まない) */
    sort: number;
    /** viewer.render() 全体 (中の THREE renderer.render を含む) */
    render: number;
    /** root の exclusive time = 未計測部分 */
    other: number;
}

const BUCKET_KEYS: (keyof FrameBuckets)[] = [
    'anim', 'expr', 'updateBS', 'mixer', 'setExpr',
    'vUpdate', 'morph', 'bone', 'sort', 'render', 'other',
];

/** 入れ子の内側として参考までに出す値 (exclusive ではないので合計に入れない)。 */
export interface FrameNested {
    /** viewer.render の中の THREE.WebGLRenderer.render 合計 */
    gl: number;
    /** texImage2D / texSubImage2D の合計 (bone / splatMesh の内側) */
    texUp: number;
    /** 上記の呼び出し回数 */
    glCalls: number;
    texCalls: number;
}

interface FrameRecord {
    total: number;
    interval: number;
    b: FrameBuckets;
    n: FrameNested;
}

export interface FrameCostStats {
    enabled: boolean;
    applied: boolean;
    reason: string;
    budgetMs: number;
    frames: number;
    longFrames: number;
    logged: number;
    hooked: Record<string, boolean>;
}

function emptyBuckets(): FrameBuckets {
    return {
        anim: 0, expr: 0, updateBS: 0, mixer: 0, setExpr: 0,
        vUpdate: 0, morph: 0, bone: 0, sort: 0, render: 0, other: 0,
    };
}

function emptyNested(): FrameNested {
    return { gl: 0, texUp: 0, glCalls: 0, texCalls: 0 };
}

function param(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
        return null;
    }
}

/** `?frameCost=1` のときだけ有効。既定は何もしない。 */
export function isFrameCostMode(): boolean {
    const v = param('frameCost');
    return v === '1' || v === 'on';
}

/** long frame の閾値。既定は A2E の 1 フレーム予算 (33.33ms)。 */
function budgetMs(): number {
    const v = Number(param('frameCostMs'));
    return Number.isFinite(v) && v > 0 ? v : FRAME_COST_BUDGET_MS;
}

/** `?texProbe=0` で WebGL texture upload の計測だけ切れる。既定は有効。 */
function texProbeEnabled(): boolean {
    return param('texProbe') !== '0';
}

function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[i];
}

function f1(n: number): string {
    return n.toFixed(1);
}

// ===================================================================
// exclusive-time stack
// ===================================================================

interface Frame {
    key: keyof FrameBuckets;
    start: number;
    childTime: number;
}

export function installFrameCost(renderer: any, maxTries = 600): Promise<FrameCostStats> {
    const enabled = isFrameCostMode();
    const budget = budgetMs();
    const stats: FrameCostStats = {
        enabled,
        applied: false,
        reason: enabled ? '' : 'frameCost 未指定のため何もしない',
        budgetMs: budget,
        frames: 0,
        longFrames: 0,
        logged: 0,
        hooked: {},
    };
    (window as any).__frameCostStats = stats;
    if (!enabled) return Promise.resolve(stats);

    return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
            const v = renderer?.viewer;
            const ready = v && typeof renderer?.render === 'function'
                && typeof v.update === 'function';
            if (ready || ++tries >= maxTries) {
                if (!ready) {
                    stats.reason = 'renderer.render / viewer.update が見つからない';
                } else {
                    apply(renderer, stats, budget);
                }
                resolve(stats);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function apply(renderer: any, stats: FrameCostStats, budget: number): void {
    if (renderer.__frameCostHooked) {
        stats.reason = 'すでに適用済み';
        return;
    }
    renderer.__frameCostHooked = true;

    const stack: Frame[] = [];
    let cur = emptyBuckets();
    let nested = emptyNested();
    const records: FrameRecord[] = [];
    let prevStart = 0;

    const begin = (key: keyof FrameBuckets): void => {
        stack.push({ key, start: performance.now(), childTime: 0 });
    };
    const end = (): void => {
        const f = stack.pop();
        if (!f) return;
        const incl = performance.now() - f.start;
        cur[f.key] += incl - f.childTime;
        const p = stack[stack.length - 1];
        if (p) p.childTime += incl;
    };

    /** 計測対象を包む。戻り値 / 例外 / this はそのまま通す。 */
    const wrap = (
        obj: any, name: string, key: keyof FrameBuckets, label: string,
    ): boolean => {
        try {
            const orig = obj?.[name];
            if (typeof orig !== 'function') return false;
            obj[name] = function (...a: any[]) {
                begin(key);
                try {
                    return orig.apply(this, a);
                } finally {
                    end();
                }
            };
            stats.hooked[label] = true;
            return true;
        } catch (e) {
            return false;
        }
    };

    /** 入れ子の参考値だけを採る (exclusive stack には積まない)。 */
    const wrapNested = (
        obj: any, name: string, field: 'gl' | 'texUp', counter: 'glCalls' | 'texCalls',
        label: string,
    ): boolean => {
        try {
            const orig = obj?.[name];
            if (typeof orig !== 'function') return false;
            obj[name] = function (...a: any[]) {
                const t = performance.now();
                try {
                    return orig.apply(this, a);
                } finally {
                    nested[field] += performance.now() - t;
                    nested[counter]++;
                }
            };
            stats.hooked[label] = true;
            return true;
        } catch (e) {
            return false;
        }
    };

    const v = renderer.viewer;

    // ---- viewer 側 (ロード完了時点で揃っている) ----
    wrap(v, 'update', 'vUpdate', 'viewer.update');
    wrap(v, 'runMorphUpdate', 'morph', 'viewer.runMorphUpdate');
    // adaptive sort の wrapper より **後**に入れるので、ここで包むのは
    // adaptive wrapper 自体 = 「skip 判定を含む実コスト」になる。
    // なお adaptive sort が例外で出荷版へ戻すとき `v.runSplatSort = orig` を
    // するので、そのときはこの hook も外れる。以降 sort の時間は
    // `vUpdate` の exclusive 側に含まれる (`__adaptiveSort.fallbackCount` で判る)。
    wrap(v, 'runSplatSort', 'sort', 'viewer.runSplatSort');
    wrap(v, 'render', 'render', 'viewer.render');
    wrap(v?.splatMesh, 'updateBoneMatrixTexture', 'bone', 'splatMesh.updateBoneMatrixTexture');
    wrapNested(v?.renderer, 'render', 'gl', 'glCalls', 'three.renderer.render');

    if (texProbeEnabled()) {
        try {
            const gl = v?.renderer?.getContext?.();
            if (gl) {
                wrapNested(gl, 'texSubImage2D', 'texUp', 'texCalls', 'gl.texSubImage2D');
                wrapNested(gl, 'texImage2D', 'texUp', 'texCalls', 'gl.texImage2D');
            }
        } catch (e) {
            // texture upload が取れなくても他の分解は成立する。推定値で埋めない。
        }
    }

    // ---- renderer 側。mixer / animManager は load 中に作られるので遅延で包む ----
    let lazyTries = 0;
    const lazyHook = (): void => {
        if (lazyTries++ > 300) return;
        if (!stats.hooked['renderer.getExpressionData']) {
            wrap(renderer, 'getExpressionData', 'expr', 'renderer.getExpressionData');
        }
        if (!stats.hooked['renderer.updateBS']) {
            wrap(renderer, 'updateBS', 'updateBS', 'renderer.updateBS');
        }
        if (!stats.hooked['renderer.setExpression']) {
            wrap(renderer, 'setExpression', 'setExpr', 'renderer.setExpression');
        }
        if (!stats.hooked['renderer.mixer.update']) {
            wrap(renderer?.mixer, 'update', 'mixer', 'renderer.mixer.update');
        }
        if (!stats.hooked['renderer.animManager.update']) {
            wrap(renderer?.animManager, 'update', 'anim', 'renderer.animManager.update');
        }
        if (!stats.hooked['splatMesh.updateBoneMatrixTexture']) {
            wrap(renderer?.viewer?.splatMesh, 'updateBoneMatrixTexture', 'bone',
                 'splatMesh.updateBoneMatrixTexture');
        }
    };
    lazyHook();

    // ---- root: 1 フレームの境界 ----
    const origRender = renderer.render;
    renderer.render = function (...a: any[]) {
        const now = performance.now();
        const interval = prevStart === 0 ? 0 : now - prevStart;
        prevStart = now;

        stack.length = 0;
        cur = emptyBuckets();
        nested = emptyNested();
        begin('other');          // root。exclusive = 未計測部分
        let total = 0;
        try {
            return origRender.apply(this, a);
        } finally {
            const root = stack[0];
            total = root ? performance.now() - root.start : 0;
            end();
            lazyHook();

            stats.frames++;
            const rec: FrameRecord = { total, interval, b: cur, n: nested };
            records.push(rec);
            if (records.length > MAX_RECORDS) records.shift();
            if (total >= stats.budgetMs) {
                stats.longFrames++;
                if (stats.logged < MAX_LOGS) {
                    stats.logged++;
                    console.log(formatLine(rec));
                }
            }
        }
    };

    stats.applied = true;
    stats.reason = 'renderer.render を基点に 1 フレームを分解する';

    const w = window as any;
    w.__frameCost = () => summarize(records, stats);
    w.__frameCostLong = (n = 10) => records
        .filter(r => r.total >= stats.budgetMs)
        .sort((x, y) => y.total - x.total)
        .slice(0, n)
        .map(formatLine);
    w.__frameCostReset = () => {
        records.length = 0;
        stats.frames = 0;
        stats.longFrames = 0;
        stats.logged = 0;
        return 'reset';
    };
    console.log('[FRAME COST] 有効。閾値 ' + f1(stats.budgetMs) + 'ms。'
        + 'hook=' + JSON.stringify(stats.hooked)
        + ' / 集計は __frameCost()、長いフレーム一覧は __frameCostLong()');
}

/** 1 フレーム 1 行。合計の内訳が total に一致する (exclusive time なので)。 */
function formatLine(r: FrameRecord): string {
    const b = r.b;
    const parts = BUCKET_KEYS
        .filter(k => b[k] >= 0.05)
        .sort((x, y) => b[y] - b[x])
        .map(k => k + '=' + f1(b[k]));
    return '[FRAME COST] total=' + f1(r.total)
        + ' interval=' + f1(r.interval)
        + ' ' + parts.join(' ')
        + ' | gl=' + f1(r.n.gl) + '(' + r.n.glCalls + ')'
        + ' texUp=' + f1(r.n.texUp) + '(' + r.n.texCalls + ')';
}

function summarize(records: FrameRecord[], stats: FrameCostStats): any {
    const longs = records.filter(r => r.total >= stats.budgetMs);
    const build = (rs: FrameRecord[]) => {
        if (rs.length === 0) return null;
        const totals = rs.map(r => r.total).sort((a, b) => a - b);
        const per: Record<string, any> = {};
        for (const k of BUCKET_KEYS) {
            const xs = rs.map(r => r.b[k]).sort((a, b) => a - b);
            const sum = xs.reduce((a, b) => a + b, 0);
            per[k] = {
                meanMs: Number((sum / rs.length).toFixed(2)),
                p50Ms: Number(pct(xs, 0.5).toFixed(2)),
                p95Ms: Number(pct(xs, 0.95).toFixed(2)),
                maxMs: Number(xs[xs.length - 1].toFixed(2)),
                /** total に対する平均寄与率 (%) */
                sharePct: Number((100 * sum / rs.reduce((a, r) => a + r.total, 0)).toFixed(1)),
            };
        }
        const glSum = rs.reduce((a, r) => a + r.n.gl, 0);
        const texSum = rs.reduce((a, r) => a + r.n.texUp, 0);
        return {
            frames: rs.length,
            totalP50Ms: Number(pct(totals, 0.5).toFixed(2)),
            totalP95Ms: Number(pct(totals, 0.95).toFixed(2)),
            totalMeanMs: Number((totals.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)),
            totalMaxMs: Number(totals[totals.length - 1].toFixed(2)),
            buckets: per,
            /** 寄与率の大きい順。long frame の主犯はこの先頭。 */
            ranking: BUCKET_KEYS
                .map(k => ({ bucket: k, sharePct: per[k].sharePct, meanMs: per[k].meanMs }))
                .sort((a, b) => b.sharePct - a.sharePct),
            nestedMeanMs: {
                gl: Number((glSum / rs.length).toFixed(2)),
                texUp: Number((texSum / rs.length).toFixed(2)),
            },
        };
    };
    return {
        budgetMs: Number(stats.budgetMs.toFixed(2)),
        hooked: stats.hooked,
        unhooked: Object.keys(stats.hooked).length === 0 ? '(none hooked)' : undefined,
        all: build(records),
        long: build(longs),
        longSharePct: records.length
            ? Number((100 * longs.length / records.length).toFixed(1))
            : 0,
    };
}

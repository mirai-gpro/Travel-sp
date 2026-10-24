// src/scripts/chat/startup/startup-metrics.ts
/**
 * 起動シーケンスの計測だけを持つモジュール (指示書 §16)。
 *
 * **挙動を一切変えない。** `performance.now()` を記録して console に出すだけ。
 * session / A2E / audio の制御ロジックはここに置かない。
 *
 * 同じ mark が複数回来た場合は **最初の 1 回だけ** 採用する
 * (reset は 2 回走るので、2 回目は別 mark 名で記録する)。
 */

export type StartupMarkName =
    | 'APP_START'
    | 'AVATAR_PREPARE_START'
    | 'RESET1_START'
    | 'RESET1_LIVE_START'
    | 'RESET1_END'
    | 'AVATAR_READY'
    | 'AVATAR_FALLBACK'
    | 'AVATAR_VISIBLE'
    | 'STARTUP_UNMUTE'
    | 'RESET2_START'
    | 'RESET2_LIVE_START'
    | 'RESET2_END'
    | 'FIRST_AUDIO'
    | 'FIRST_EXPRESSION'
    | 'RESET1_FIRST_AUDIO'
    | 'RESET1_FIRST_EXPRESSION'
    | 'RESET2_FIRST_AUDIO'
    | 'RESET2_FIRST_EXPRESSION';

const marks = new Map<string, number>();
let reported = false;

/** 計測点を記録する。初出のときだけ記録し、記録した時刻を返す。 */
export function mark(name: StartupMarkName): number {
    const t = performance.now();
    if (marks.has(name)) return marks.get(name)!;
    marks.set(name, t);
    console.log(`[Startup] ${name} t=${t.toFixed(1)}ms`);
    try {
        (window as any).__startupMarks = Object.fromEntries(marks);
    } catch (e) { /* noop */ }
    maybeReport();
    return t;
}

export function getMark(name: StartupMarkName): number | null {
    return marks.has(name) ? marks.get(name)! : null;
}

function delta(a: StartupMarkName, b: StartupMarkName): string {
    const x = getMark(a);
    const y = getMark(b);
    if (x === null || y === null) return 'n/a';
    return `${(y - x).toFixed(0)}ms`;
}

/**
 * 主要な所要時間を 1 行で出す。
 *
 * 5 秒評価に使うのは **APP_START -> RESET2_FIRST_AUDIO**。
 * reset #1 の Greeting は B-3 で MUTE 対象になり、ユーザーが実際に聞くのは
 * reset #2 の Greeting だから。reset #2 の Audio / Expression が揃ったら
 * 1 回だけ出す。
 */
function maybeReport(): void {
    if (reported) return;
    if (getMark('RESET2_FIRST_AUDIO') === null) return;
    if (getMark('RESET2_FIRST_EXPRESSION') === null) return;
    reported = true;
    const visible = getMark('AVATAR_VISIBLE') !== null ? 'AVATAR_VISIBLE' : 'AVATAR_READY';
    console.log(
        '[Startup] SUMMARY '
        + `avatar(${visible})=${delta('APP_START', visible as StartupMarkName)} `
        + `reset2FirstAudio=${delta('APP_START', 'RESET2_FIRST_AUDIO')} `
        + `reset2FirstExpression=${delta('APP_START', 'RESET2_FIRST_EXPRESSION')} `
        + `| reset1FirstAudio=${delta('APP_START', 'RESET1_FIRST_AUDIO')} `
        + `reset1=${delta('RESET1_START', 'RESET1_END')} `
        + `reset2start=${delta('APP_START', 'RESET2_START')}`
    );
}

/** 【診断用】記録済みの mark 一覧。 */
export function getStartupMarks(): Record<string, number> {
    return Object.fromEntries(marks);
}

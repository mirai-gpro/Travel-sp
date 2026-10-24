// UIKA Native Runtime v1.1 — LAM reference sort correctness contract
//
// This is a SEPARATE contract. The Gate 4B-2A pre-deformation contract (v1 pixel-identical,
// v2 numeric + visual equivalence) is NOT reused and is not imported here, because the two
// gates compare different things:
//
//   Gate 4B-2A compared two implementations of the SAME equation. Any difference was
//     float32 rounding, so a tolerance of one byte and a 1e-5 pixel ratio was a statement
//     about arithmetic noise.
//
//   This gate compares two DIFFERENT depth orders. The LAM-reference sort orders the
//     Gaussians by their canonical centres while the draw places them at
//     `canonical + D_UIKA x weights`, so the order is not the exact depth order of the
//     geometry being drawn (§8). Differences here are alpha-compositing differences from a
//     genuinely different draw order, not rounding, and a one-byte tolerance would say
//     nothing about whether they are acceptable.
//
// Therefore this contract reports MEASUREMENTS and a structural verdict only. It does not
// contain a pass threshold for the visual comparison, and it never returns PASS for the
// visual dimension: §9 makes that a human judgement against how the LAM runtime itself
// looks, and the harness must not pre-empt it.

export const LAM_SORT_ACCEPTANCE_VERSION = 'gate4b2c-v1-structural-pass-plus-human-visual';

/**
 * The only automatic thresholds in this gate. Each one is a structural requirement —
 * something that must hold for the measurement itself to be meaningful — not a judgement
 * about how the avatar looks.
 */
export const LAM_SORT_STRUCTURAL = {
    /** Every fixture frame must have produced a framebuffer from both modes. */
    requireAllSamples: true,
    /** WebGL errors in either mode. */
    maxGlErrors: 0,
    /** Page errors / unhandled rejections during the comparison. */
    maxPageErrors: 0,
    /** Worker errors reported by the LAM sort host. */
    maxWorkerErrors: 0,
    /** Sorts that were submitted but never completed by the end of the comparison. */
    maxUncompletedSorts: 0,
    /**
     * Both modes must render every splat. A render count below this would mean the
     * comparison silently dropped Gaussians rather than reordering them.
     */
    requiredRenderSplatCount: 133541,
} as const;

export type UikaLamVerdict = 'PASS' | 'FAIL';
/** The visual dimension has no automatic verdict: see the header. */
export type UikaLamVisualVerdict = 'REQUIRES_HUMAN_INSPECTION';

export interface UikaLamStructuralInput {
    framesRequested: number;
    framesCompared: number;
    glErrors: number;
    pageErrors: number;
    workerErrors: number;
    sortsSubmitted: number;
    sortsCompleted: number;
    renderSplatCountExact: number;
    renderSplatCountLam: number;
}

export interface UikaLamStructuralResult {
    verdict: UikaLamVerdict;
    failures: string[];
    checks: { name: string; ok: boolean; detail: string }[];
}

export function evaluateStructural(input: UikaLamStructuralInput): UikaLamStructuralResult {
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const add = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); };

    add(
        'all fixture frames compared',
        input.framesCompared === input.framesRequested,
        `${input.framesCompared} / ${input.framesRequested}`,
    );
    add('no GL errors', input.glErrors <= LAM_SORT_STRUCTURAL.maxGlErrors, `${input.glErrors}`);
    add('no page errors', input.pageErrors <= LAM_SORT_STRUCTURAL.maxPageErrors, `${input.pageErrors}`);
    add('no worker errors', input.workerErrors <= LAM_SORT_STRUCTURAL.maxWorkerErrors,
        `${input.workerErrors}`);
    add(
        'every submitted sort completed',
        input.sortsSubmitted - input.sortsCompleted <= LAM_SORT_STRUCTURAL.maxUncompletedSorts,
        `submitted ${input.sortsSubmitted}, completed ${input.sortsCompleted}`,
    );
    add(
        'exact-sort mode rendered every splat',
        input.renderSplatCountExact === LAM_SORT_STRUCTURAL.requiredRenderSplatCount,
        `${input.renderSplatCountExact} / ${LAM_SORT_STRUCTURAL.requiredRenderSplatCount}`,
    );
    add(
        'LAM-sort mode rendered every splat',
        input.renderSplatCountLam === LAM_SORT_STRUCTURAL.requiredRenderSplatCount,
        `${input.renderSplatCountLam} / ${LAM_SORT_STRUCTURAL.requiredRenderSplatCount}`,
    );

    const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    return { verdict: failures.length === 0 ? 'PASS' : 'FAIL', failures, checks };
}

// UIKA Native Runtime v1.1 — Gate 4B-2A correctness contract
//
// Acceptance history, kept deliberately:
//
//   v1  pixel-identical required.
//       The real-GPU run FAILED it: C-a2e-frame-20 differed by one pixel in 1,295,044,
//       one byte level in R, alpha plane identical. That FAIL is a historical fact and
//       is not rewritten.
//
//   v2  numeric equivalence + visual equivalence, with explicit cross-GPU tolerances.
//       Adopted on the evidence of the 192-frame real-GPU sweep: the same GLSL
//       arithmetic does not produce the same final float32 bits across shader stages and
//       GPU drivers, so bit-exact framebuffer equality is not a portable contract —
//       while the measured differences over the whole fixture stayed minute.
//
// The three equivalences are reported separately and never collapsed into one flag.
// A ULP distance is a diagnostic and is not used for severity or for PASS/FAIL.

export const ACCEPTANCE_VERSION = 'v2-numeric-and-visual-equivalence';
export const PREVIOUS_ACCEPTANCE_VERSION = 'v1-pixel-identical';

/** The tolerances the contract states. Decision rules, not measured quantities. */
export const CONTRACT = {
    /** B: animated-centre absolute difference, the bound carried over unchanged from v1. */
    maxCenterAbsDifference: 1e-6,
    /** B: depth-key absolute difference, added in v2. */
    maxDistanceAbsDifference: 1e-6,
    /** C: any RGBA channel, alpha included. */
    maxRgbaByteDelta: 1,
    /** C: per frame. */
    maxDifferentPixelRatio: 1e-5,
} as const;

export type UikaVerdict = 'PASS' | 'FAIL';

export interface UikaContractSample {
    label: string;
    /** Every centre comparison that applies to this sample, as absolute differences. */
    centerAbsDifferences: { name: string; maxAbs: number }[];
    distanceMaxAbsDifference: number;
    nonFiniteComponents: number;
    pixelIdentical: boolean;
    maxRgbaByteDelta: number;
    maxAlphaByteDelta: number;
    differentPixels: number;
    differentPixelRatio: number;
}

export interface UikaContractSampleResult {
    label: string;
    bitExact: UikaVerdict;
    numeric: UikaVerdict;
    visual: UikaVerdict;
    failures: string[];
}

export function evaluateSample(s: UikaContractSample): UikaContractSampleResult {
    const failures: string[] = [];

    const bitExact: UikaVerdict = s.pixelIdentical ? 'PASS' : 'FAIL';

    let numeric: UikaVerdict = 'PASS';
    for (const c of s.centerAbsDifferences) {
        if (!(c.maxAbs <= CONTRACT.maxCenterAbsDifference)) {
            numeric = 'FAIL';
            failures.push(`${c.name} max abs ${c.maxAbs.toExponential(6)} > `
                + `${CONTRACT.maxCenterAbsDifference.toExponential(0)}`);
        }
    }
    if (!(s.distanceMaxAbsDifference <= CONTRACT.maxDistanceAbsDifference)) {
        numeric = 'FAIL';
        failures.push(`distance max abs ${s.distanceMaxAbsDifference.toExponential(6)} > `
            + `${CONTRACT.maxDistanceAbsDifference.toExponential(0)}`);
    }
    if (s.nonFiniteComponents > 0) {
        numeric = 'FAIL';
        failures.push(`${s.nonFiniteComponents} non-finite components`);
    }

    let visual: UikaVerdict = 'PASS';
    if (!(s.maxRgbaByteDelta <= CONTRACT.maxRgbaByteDelta)) {
        visual = 'FAIL';
        failures.push(`max RGBA byte delta ${s.maxRgbaByteDelta} > ${CONTRACT.maxRgbaByteDelta}`);
    }
    // Alpha is held to the same rule as the colour channels, not to bit-exactness.
    if (!(s.maxAlphaByteDelta <= CONTRACT.maxRgbaByteDelta)) {
        visual = 'FAIL';
        failures.push(`max alpha byte delta ${s.maxAlphaByteDelta} > ${CONTRACT.maxRgbaByteDelta}`);
    }
    if (!(s.differentPixelRatio <= CONTRACT.maxDifferentPixelRatio)) {
        visual = 'FAIL';
        failures.push(`differing-pixel ratio ${s.differentPixelRatio.toExponential(6)} > `
            + `${CONTRACT.maxDifferentPixelRatio.toExponential(0)}`);
    }

    return { label: s.label, bitExact, numeric, visual, failures };
}

export interface UikaStructuralInput {
    samplesCompared: number;
    samplesExpected: number;
    glErrors: number;
    pageErrors: number;
    nonFiniteComponents: number;
}

export interface UikaContractReport {
    acceptanceVersion: string;
    previousAcceptanceVersion: string;
    contract: typeof CONTRACT;
    structural: {
        verdict: UikaVerdict;
        samplesCompared: number;
        samplesExpected: number;
        complete: boolean;
        glErrors: number;
        pageErrors: number;
        nonFiniteComponents: number;
        failures: string[];
    };
    bitExactVerdict: UikaVerdict;
    numericVerdict: UikaVerdict;
    visualVerdict: UikaVerdict;
    correctnessVerdict: UikaVerdict;
    counts: {
        bitExactPassing: number;
        numericPassing: number;
        visualPassing: number;
        total: number;
    };
    /** Samples that failed something, with the reason. */
    failingSamples: UikaContractSampleResult[];
    /** What v1 would have said, kept so the history stays visible. */
    underPreviousAcceptance: UikaVerdict;
    notes: string[];
}

export function rollUpContract(
    samples: UikaContractSample[],
    structuralInput: UikaStructuralInput,
): UikaContractReport {
    const results = samples.map(evaluateSample);
    const bitExactPassing = results.filter((r) => r.bitExact === 'PASS').length;
    const numericPassing = results.filter((r) => r.numeric === 'PASS').length;
    const visualPassing = results.filter((r) => r.visual === 'PASS').length;

    const structuralFailures: string[] = [];
    const complete = structuralInput.samplesCompared === structuralInput.samplesExpected
        && structuralInput.samplesCompared > 0;
    if (!complete) {
        structuralFailures.push(`${structuralInput.samplesCompared} of `
            + `${structuralInput.samplesExpected} expected samples were compared`);
    }
    if (structuralInput.glErrors !== 0) structuralFailures.push(`${structuralInput.glErrors} GL errors`);
    if (structuralInput.pageErrors !== 0) structuralFailures.push(`${structuralInput.pageErrors} page errors`);
    if (structuralInput.nonFiniteComponents !== 0) {
        structuralFailures.push(`${structuralInput.nonFiniteComponents} non-finite components`);
    }

    const structuralVerdict: UikaVerdict = structuralFailures.length === 0 ? 'PASS' : 'FAIL';
    const numericVerdict: UikaVerdict = numericPassing === results.length && results.length > 0 ? 'PASS' : 'FAIL';
    const visualVerdict: UikaVerdict = visualPassing === results.length && results.length > 0 ? 'PASS' : 'FAIL';
    const bitExactVerdict: UikaVerdict = bitExactPassing === results.length && results.length > 0 ? 'PASS' : 'FAIL';

    return {
        acceptanceVersion: ACCEPTANCE_VERSION,
        previousAcceptanceVersion: PREVIOUS_ACCEPTANCE_VERSION,
        contract: CONTRACT,
        structural: {
            verdict: structuralVerdict,
            samplesCompared: structuralInput.samplesCompared,
            samplesExpected: structuralInput.samplesExpected,
            complete,
            glErrors: structuralInput.glErrors,
            pageErrors: structuralInput.pageErrors,
            nonFiniteComponents: structuralInput.nonFiniteComponents,
            failures: structuralFailures,
        },
        bitExactVerdict,
        numericVerdict,
        visualVerdict,
        correctnessVerdict: structuralVerdict === 'PASS' && numericVerdict === 'PASS'
            && visualVerdict === 'PASS' ? 'PASS' : 'FAIL',
        counts: {
            bitExactPassing,
            numericPassing,
            visualPassing,
            total: results.length,
        },
        failingSamples: results.filter((r) => r.failures.length > 0 || r.bitExact === 'FAIL'),
        underPreviousAcceptance: bitExactVerdict,
        notes: [
            'v1 required pixel-identical framebuffers and the real-GPU run failed it; that '
            + 'result is kept, not rewritten',
            'the three equivalences are reported separately and are never collapsed into one flag',
            'ULP distances are diagnostics and are not used for severity or for PASS/FAIL',
        ],
    };
}

// UIKA Native Runtime — ambient declaration for `three`.
//
// three@0.173.0 ships no bundled type declarations and `@types/three` is not installed.
// The project already compiles with the same situation for
// `gaussian-splat-renderer-for-lam`, so the renderer fork follows that convention
// rather than adding a dependency (v1.1 §19: no dependency changes).
declare module 'three';

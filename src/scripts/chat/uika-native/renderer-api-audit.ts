// src/scripts/chat/uika-native/renderer-api-audit.ts
/**
 * UIKA Native Runtime Architecture Correction v1.0 — Gate 0
 *
 * `gaussian-splat-renderer-for-lam@0.0.9-alpha.1` の実際の ESM export surface を
 * 実行時に列挙するだけの read-only diagnostic。
 *
 * 目的:
 *   - low-level Viewer / DropInViewer / SplatMesh 等が public export かを確認する
 *   - `GaussianSplatRenderer.getInstance()` の LAM OAC lifecycle を経由せずに
 *     UIKA Native renderer adapter を作れるか判断するための事実を取る
 *
 * やらないこと:
 *   - renderer instance を生成しない
 *   - model / ZIP をロードしない
 *   - 通常 LAM / 既存 UIKA path に接続しない
 *   - private member を monkey-patch しない
 */

import * as GaussianSplats3D from 'gaussian-splat-renderer-for-lam';

export interface RendererApiAuditResult {
    expectedPackageVersion: '0.0.9-alpha.1';
    exportNames: string[];
    capabilities: {
        GaussianSplatRenderer: boolean;
        Viewer: boolean;
        DropInViewer: boolean;
        SplatMesh: boolean;
        PlyLoader: boolean;
        PlyParser: boolean;
        INRIAV1PlyParser: boolean;
    };
    matchingExportNames: {
        viewer: string[];
        splat: string[];
        ply: string[];
        renderer: string[];
    };
}

function matching(names: string[], token: string): string[] {
    const needle = token.toLowerCase();
    return names.filter((name) => name.toLowerCase().includes(needle));
}

export function auditRendererApi(): RendererApiAuditResult {
    // Dynamic key lookup only. A missing named export must not make the build fail:
    // absence itself is the Gate 0 result we need to observe.
    const moduleObject = GaussianSplats3D as unknown as Record<string, unknown>;
    const exportNames = Object.keys(moduleObject).sort();

    return {
        expectedPackageVersion: '0.0.9-alpha.1',
        exportNames,
        capabilities: {
            GaussianSplatRenderer: typeof moduleObject.GaussianSplatRenderer === 'function',
            Viewer: typeof moduleObject.Viewer === 'function',
            DropInViewer: typeof moduleObject.DropInViewer === 'function',
            SplatMesh: typeof moduleObject.SplatMesh === 'function',
            PlyLoader: typeof moduleObject.PlyLoader === 'function',
            PlyParser: typeof moduleObject.PlyParser === 'function',
            INRIAV1PlyParser: typeof moduleObject.INRIAV1PlyParser === 'function',
        },
        matchingExportNames: {
            viewer: matching(exportNames, 'viewer'),
            splat: matching(exportNames, 'splat'),
            ply: matching(exportNames, 'ply'),
            renderer: matching(exportNames, 'renderer'),
        },
    };
}

// src/scripts/chat/uika-native/renderer-api-audit.ts
/**
 * UIKA Native Runtime Architecture Correction v1.0 — Gate 0
 *
 * `gaussian-splat-renderer-for-lam@0.0.9-alpha.1` の実際の ESM export surface を
 * 確認する read-only diagnostic。
 *
 * compile probes:
 *   1. Viewer
 *   2. SplatMesh
 *
 * Vite/Rollup build が成功すれば、pinned package が両方を public export
 * していることを compile-time に確定できる。
 *
 * やらないこと:
 *   - renderer instance を生成しない
 *   - model / ZIP をロードしない
 *   - 通常 LAM / 既存 UIKA path に接続しない
 *   - private member を monkey-patch しない
 */

import * as GaussianSplats3D from 'gaussian-splat-renderer-for-lam';
import { SplatMesh, Viewer } from 'gaussian-splat-renderer-for-lam';

export interface RendererApiAuditResult {
    expectedPackageVersion: '0.0.9-alpha.1';
    compileProbe: {
        ViewerNamedExport: true;
        SplatMeshNamedExport: true;
    };
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
    const moduleObject = GaussianSplats3D as unknown as Record<string, unknown>;
    const exportNames = Object.keys(moduleObject).sort();

    // Reference named imports so Rollup cannot discard the compile probes as unused.
    if (typeof Viewer !== 'function') {
        throw new Error('Gate 0: Viewer named export exists but is not a constructor/function');
    }
    if (typeof SplatMesh !== 'function') {
        throw new Error('Gate 0: SplatMesh named export exists but is not a constructor/function');
    }

    return {
        expectedPackageVersion: '0.0.9-alpha.1',
        compileProbe: {
            ViewerNamedExport: true,
            SplatMeshNamedExport: true,
        },
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

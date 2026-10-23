/**
 * Remote Manifest (指示書 §6 / §19)。
 *
 * **起動の critical path に入れない。** Registry に `activeVersion` /
 * `assetUrl` / `sha256` が保存してあるので、通常起動は manifest 無しで成立する。
 * ここは「新しい version / 新しい avatar があるか」を起動後に非同期で見るだけ。
 *
 * 責務分離 (指示書 §25):
 *   avatar-config.json … camera / voice / skinMode / sortPolicy / morphPath /
 *                        installPolicy / posterUrl  (アプリ内 avatar 定義の正本)
 *   avatars-manifest   … version / assetUrl / size / sha256 / runtimeSchema
 *                        (配布・更新情報の正本)
 */

export const MANIFEST_URL = '/avatar/avatars-manifest.json';
export const DEFAULT_MANIFEST_TIMEOUT_MS = 8000;

export interface ManifestAvatarEntry {
    id: string;
    version: string;
    assetUrl: string;
    size: number;
    sha256: string;
    runtimeSchema: string;
    posterUrl?: string;
}

export interface AvatarsManifest {
    schemaVersion: number;
    avatars: ManifestAvatarEntry[];
}

function isEntry(v: any): v is ManifestAvatarEntry {
    return !!v && typeof v.id === 'string' && v.id.length > 0
        && typeof v.version === 'string' && v.version.length > 0
        && typeof v.assetUrl === 'string' && v.assetUrl.length > 0
        && typeof v.size === 'number' && v.size > 0
        && typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256)
        && typeof v.runtimeSchema === 'string';
}

export function parseManifest(raw: unknown): AvatarsManifest | null {
    const d: any = raw;
    if (!d || typeof d.schemaVersion !== 'number' || !Array.isArray(d.avatars)) return null;
    const avatars = d.avatars.filter(isEntry);
    if (avatars.length === 0) return null;
    return { schemaVersion: d.schemaVersion, avatars };
}

/**
 * manifest を取る。**失敗しても throw しない** (null を返す)。
 * timeout はぶら下がり防止であって、起動条件ではない。
 */
export async function fetchManifest(
    url = MANIFEST_URL,
    timeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
    fetchImpl: typeof fetch = fetch,
): Promise<AvatarsManifest | null> {
    let timer: any = null;
    try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetchImpl(url, {
            cache: 'no-cache',
            signal: ctrl ? ctrl.signal : undefined,
        } as any);
        if (!res || !res.ok) return null;
        return parseManifest(await res.json());
    } catch (e) {
        return null;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

export function findEntry(m: AvatarsManifest | null, avatarId: string): ManifestAvatarEntry | null {
    if (!m) return null;
    return m.avatars.find((a) => a.id === avatarId) ?? null;
}

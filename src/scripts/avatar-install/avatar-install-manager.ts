/**
 * Avatar install / update / recovery の orchestration (指示書 §24 / §26)。
 *
 * ここは **asset resolution** だけを担当し、renderer の初期化はしない。
 * 呼び出し側 (`LAMAvatar.astro`) が `resolveAvatarAsset()` の結果で分岐する。
 * これにより FULL133 の install 処理が LAM renderer 内部へ侵食しない。
 *
 * 起動時に remote manifest を待たない (指示書 §7)。Registry と Cache だけで
 * 判断するので、オフラインでもインストール済み FULL133 は起動できる。
 */

import {
    AvatarInstallRegistry, type AvatarInstallRecord, type AvatarVersionMeta,
    type KeyValueStore, createRegistryStore,
} from './avatar-install-registry';
import {
    cacheKeyFor, createAvatarCache, toObjectUrl, type AvatarCache,
} from './avatar-cache';
import {
    fetchManifest, findEntry, type AvatarsManifest, type ManifestAvatarEntry,
} from './avatar-manifest';
import { queryStorage, requestPersist, type StorageStatus } from './storage-capabilities';

/** install 機構を通す avatar だけが持つ印 (指示書 §4)。 */
export const LOCAL_PACKAGE_POLICY = 'local-package';

export interface InstallPolicyAvatar {
    id: string;
    modelUrl: string;
    installPolicy?: string;
    posterUrl?: string;
}

export type AssetResolution =
    | { kind: 'LOCAL_READY'; avatarId: string; version: string; assetUrl: string;
        objectUrl: string; record: AvatarInstallRecord;
        /** 次回起動から適用する候補 (pendingVersion) を試しているか */
        isPending: boolean }
    | { kind: 'INSTALL_REQUIRED'; avatarId: string; record?: AvatarInstallRecord;
        reason: string }
    | { kind: 'RECOVERY_REQUIRED'; avatarId: string; record: AvatarInstallRecord;
        reason: string }
    | { kind: 'LEGACY_REMOTE'; avatarId: string; assetUrl: string };

export interface InstallProgress {
    state: 'DOWNLOADING' | 'VERIFYING' | 'READY' | 'INSTALLED' | 'FAILED';
    receivedBytes: number;
    totalBytes: number;
    /** 0..1。totalBytes 不明なら null。 */
    ratio: number | null;
    message?: string;
}

export interface InstallManagerDeps {
    registry: AvatarInstallRegistry;
    cache: AvatarCache;
    fetchImpl: typeof fetch;
    /** ArrayBuffer -> hex SHA-256 */
    sha256: (buf: ArrayBuffer) => Promise<string>;
    manifestLoader: () => Promise<AvatarsManifest | null>;
    /** cache の Response -> renderer へ渡す URL */
    toUrl: (res: Response) => Promise<string>;
    storage: {
        query: (required: number) => Promise<StorageStatus>;
        persist: () => Promise<boolean>;
    };
    now: () => number;
}

/** 既定の依存。ブラウザ実行時はこれを使う。 */
export function defaultDeps(store?: KeyValueStore): InstallManagerDeps {
    return {
        registry: new AvatarInstallRegistry(store ?? createRegistryStore()),
        cache: createAvatarCache(),
        fetchImpl: (...a: Parameters<typeof fetch>) => fetch(...a),
        sha256: webCryptoSha256,
        manifestLoader: () => fetchManifest(),
        toUrl: toObjectUrl,
        storage: { query: queryStorage, persist: requestPersist },
        now: () => Date.now(),
    };
}

export async function webCryptoSha256(buf: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
}

export function usesLocalPackage(avatar: InstallPolicyAvatar | null | undefined): boolean {
    return avatar?.installPolicy === LOCAL_PACKAGE_POLICY;
}

export class AvatarInstallManager {
    constructor(private readonly deps: InstallManagerDeps) {}

    /**
     * 起動時に 1 回だけ呼ぶ。**remote manifest を待たない** (指示書 §7)。
     *
     * Registry と Cache Storage の両方を見て、食い違っていたら
     * RECOVERY_REQUIRED にする (指示書 §16)。壊れた asset は renderer へ渡さない。
     */
    async resolveAvatarAsset(avatar: InstallPolicyAvatar): Promise<AssetResolution> {
        if (!usesLocalPackage(avatar)) {
            // 既存 LAM avatar は従来どおり remote URL をそのまま使う (指示書 §4 / §27)。
            return { kind: 'LEGACY_REMOTE', avatarId: avatar.id, assetUrl: avatar.modelUrl };
        }
        return this.resolveInstalled(avatar.id);
    }

    /**
     * **avatar-config を一切読まずに** Registry と Cache Storage だけで解決する。
     *
     * offline では `/avatar/avatar-config.json` の取得に失敗し得るが、
     * インストール済み avatar の起動をそれに依存させてはいけない。
     * 呼び出し側は selectedAvatarId さえ分かればここへ来られる。
     *
     * 優先順位 (更新途中で終了しても active が必ず起動できるようにする):
     *   1. usable な pending があれば pending を試す
     *   2. pending が欠落 / 不整合なら pending を破棄して active へ
     *   3. usable な active があれば LOCAL_READY
     *   4. active の実体が無ければ RECOVERY_REQUIRED
     *   5. active 自体が無ければ INSTALL_REQUIRED
     *
     * record の global state (DOWNLOADING / VERIFYING / FAILED 等) は
     * **この判断に使わない**。v4 の download 中にアプリが終了しても、
     * v3 の実体が無事なら v3 で普通に起動できる必要がある。
     */
    async resolveInstalled(avatarId: string): Promise<AssetResolution> {
        let rec = await this.deps.registry.get(avatarId);
        if (!rec) {
            return { kind: 'INSTALL_REQUIRED', avatarId,
                     reason: 'Registry にレコードが無い (未インストール)' };
        }

        if (rec.pendingVersion) {
            const ready = await this.loadVersion(rec, rec.pendingVersion);
            if (ready) {
                return { kind: 'LOCAL_READY', avatarId, version: rec.pendingVersion,
                         assetUrl: ready.assetUrl, objectUrl: ready.objectUrl,
                         record: rec, isPending: true };
            }
            // pending の実体が無い / メタが欠けている = 更新が中断した。
            // active を壊さずに pending だけ捨てる。
            const dropped = rec.pendingVersion;
            rec = await this.deps.registry.update(avatarId, {
                pendingVersion: undefined,
                lastError: `pending ${dropped} の実体が無いため破棄`,
            });
            await this.deps.cache.delete(cacheKeyFor(avatarId, dropped)).catch(() => false);
        }

        const activeVersion = rec.activeVersion;
        if (activeVersion) {
            const ready = await this.loadVersion(rec, activeVersion);
            if (ready) {
                if (rec.state !== 'INSTALLED') {
                    // 更新が中断して DOWNLOADING / FAILED のまま残っていても、
                    // active の実体が無事なら INSTALLED に戻して起動する。
                    rec = await this.deps.registry.update(avatarId, { state: 'INSTALLED' });
                }
                return { kind: 'LOCAL_READY', avatarId, version: activeVersion,
                         assetUrl: ready.assetUrl, objectUrl: ready.objectUrl,
                         record: rec, isPending: false };
            }
            // Registry は active を指しているのに実体が無い = 不整合。
            // クラッシュさせず、黙って再 download もしない (指示書 §16)。
            const next = await this.deps.registry.update(avatarId, { state: 'MISSING' });
            return { kind: 'RECOVERY_REQUIRED', avatarId, record: next,
                     reason: 'Cache Storage に実体が無い (eviction の可能性)' };
        }

        return { kind: 'INSTALL_REQUIRED', avatarId, record: rec,
                 reason: `activeVersion が無い (state=${rec.state})` };
    }

    /** version の実体が揃っていれば renderer へ渡せる URL を作る。無ければ null。 */
    private async loadVersion(rec: AvatarInstallRecord, version: string):
        Promise<{ assetUrl: string; objectUrl: string } | null> {
        const meta = this.versionMeta(rec, version);
        if (!meta) return null;
        const res = await this.deps.cache.match(cacheKeyFor(rec.avatarId, version));
        if (!res) return null;
        return { assetUrl: meta.assetUrl, objectUrl: await this.deps.toUrl(res) };
    }

    /**
     * 承認後の install 本体 (指示書 §10 / §13 / §14)。
     * DOWNLOADING -> VERIFYING -> READY -> INSTALLED の順を守る。
     */
    async install(
        avatarId: string,
        entry: ManifestAvatarEntry,
        onProgress?: (p: InstallProgress) => void,
    ): Promise<AvatarInstallRecord> {
        const emit = (p: InstallProgress) => { try { onProgress?.(p); } catch (e) { /* noop */ } };
        const prev = await this.deps.registry.get(avatarId);
        const base: AvatarInstallRecord = prev ?? {
            avatarId, version: entry.version, assetUrl: entry.assetUrl,
            sha256: entry.sha256, size: entry.size, state: 'UNINSTALLED',
        };

        const storage = await this.deps.storage.query(entry.size);
        const persistGranted = await this.deps.storage.persist();

        let rec = await this.deps.registry.update(avatarId, {
            version: entry.version, assetUrl: entry.assetUrl, sha256: entry.sha256,
            size: entry.size, state: 'DOWNLOADING', persistGranted,
            lastError: null,
            versions: { ...(prev?.versions ?? {}), [entry.version]: {
                assetUrl: entry.assetUrl, sha256: entry.sha256, size: entry.size,
            } },
        }, base);
        emit({ state: 'DOWNLOADING', receivedBytes: 0, totalBytes: entry.size, ratio: 0 });

        try {
            const buf = await this.download(entry, (received, total) => {
                emit({
                    state: 'DOWNLOADING', receivedBytes: received, totalBytes: total,
                    ratio: total > 0 ? Math.min(1, received / total) : null,
                });
            });

            if (buf.byteLength !== entry.size) {
                throw new Error(`size 不一致: ${buf.byteLength} (期待 ${entry.size})`);
            }

            rec = await this.deps.registry.update(avatarId, { state: 'VERIFYING' });
            emit({ state: 'VERIFYING', receivedBytes: buf.byteLength,
                   totalBytes: entry.size, ratio: 1 });

            const digest = (await this.deps.sha256(buf)).toLowerCase();
            if (digest !== entry.sha256.toLowerCase()) {
                throw new Error(`SHA-256 不一致: ${digest} (期待 ${entry.sha256})`);
            }

            // 検証が通ってから初めて cache へ置く。破損 asset を残さない。
            await this.deps.cache.put(
                cacheKeyFor(avatarId, entry.version),
                new Response(buf, { headers: { 'Content-Type': 'application/zip' } }),
            );
            if (!(await this.deps.cache.has(cacheKeyFor(avatarId, entry.version)))) {
                throw new Error('cache 保存を確認できない');
            }

            rec = await this.deps.registry.update(avatarId, {
                state: 'READY', lastVerifiedAt: this.deps.now(),
            });
            emit({ state: 'READY', receivedBytes: entry.size, totalBytes: entry.size, ratio: 1 });

            const hasActive = !!rec.activeVersion
                && rec.activeVersion !== entry.version
                && !!this.versionMeta(rec, rec.activeVersion);
            if (hasActive) {
                // 既存 version が動いているので live swap しない (指示書 §15)。
                rec = await this.deps.registry.update(avatarId, {
                    state: 'INSTALLED', pendingVersion: entry.version,
                    installedAt: this.deps.now(),
                });
            } else {
                rec = await this.deps.registry.update(avatarId, {
                    state: 'INSTALLED', activeVersion: entry.version,
                    pendingVersion: undefined, installedAt: this.deps.now(),
                });
            }
            emit({ state: 'INSTALLED', receivedBytes: entry.size,
                   totalBytes: entry.size, ratio: 1 });
            void this.cleanupOldVersions(avatarId);
            return rec;
        } catch (e: any) {
            const message = String(e?.message ?? e);
            // 失敗した version を active にしない。
            const failed = await this.deps.registry.update(avatarId, {
                state: prev?.activeVersion ? 'INSTALLED' : 'FAILED',
                pendingVersion: undefined, lastError: message,
            });
            await this.deps.cache.delete(cacheKeyFor(avatarId, entry.version))
                .catch(() => false);
            emit({ state: 'FAILED', receivedBytes: 0, totalBytes: entry.size,
                   ratio: null, message });
            if (!prev?.activeVersion) throw e;
            return failed;
        }
    }

    /** renderer が実際にロードできた version を active にする (指示書 §15)。 */
    async markLoadSucceeded(avatarId: string, version: string): Promise<void> {
        const rec = await this.deps.registry.get(avatarId);
        if (!rec || rec.activeVersion === version) return;
        await this.deps.registry.update(avatarId, {
            activeVersion: version, pendingVersion: undefined, state: 'INSTALLED',
        });
        await this.cleanupOldVersions(avatarId);
    }

    /** pending のロードに失敗したら active へ戻す。旧 version は壊さない。 */
    async markLoadFailed(avatarId: string, version: string, reason: string): Promise<void> {
        const rec = await this.deps.registry.get(avatarId);
        if (!rec) return;
        if (rec.pendingVersion === version) {
            await this.deps.registry.update(avatarId, {
                pendingVersion: undefined, lastError: reason,
            });
            await this.deps.cache.delete(cacheKeyFor(avatarId, version)).catch(() => false);
            return;
        }
        await this.deps.registry.update(avatarId, { state: 'MISSING', lastError: reason });
    }

    /**
     * 起動後に非同期で呼ぶ (指示書 §19 / §20)。
     * 失敗しても現在の avatar 利用に影響させない。
     */
    async checkForUpdate(avatarId: string): Promise<{
        manifest: AvatarsManifest | null;
        entry: ManifestAvatarEntry | null;
        updateAvailable: boolean;
    }> {
        const manifest = await this.deps.manifestLoader();
        const entry = findEntry(manifest, avatarId);
        if (!entry) return { manifest, entry: null, updateAvailable: false };
        const rec = await this.deps.registry.get(avatarId);
        const current = rec?.activeVersion;
        const updateAvailable = !!current
            && current !== entry.version
            && rec?.pendingVersion !== entry.version;
        return { manifest, entry, updateAvailable };
    }

    /** install 前にユーザーへ見せる情報 (指示書 §10 / §12)。 */
    async describeInstall(entry: ManifestAvatarEntry): Promise<StorageStatus> {
        return this.deps.storage.query(entry.size);
    }

    getRecord(avatarId: string): Promise<AvatarInstallRecord | undefined> {
        return this.deps.registry.get(avatarId);
    }

    /** active / pending 以外の version を cache から消す。 */
    async cleanupOldVersions(avatarId: string): Promise<string[]> {
        const rec = await this.deps.registry.get(avatarId);
        if (!rec) return [];
        const keep = new Set([rec.activeVersion, rec.pendingVersion].filter(Boolean) as string[]);
        const all = Object.keys(rec.versions ?? {});
        const removed: string[] = [];
        for (const v of all) {
            if (keep.has(v)) continue;
            if (await this.deps.cache.delete(cacheKeyFor(avatarId, v))) removed.push(v);
            else removed.push(v);
        }
        if (removed.length > 0) {
            const versions: Record<string, AvatarVersionMeta> = {};
            for (const v of keep) {
                const meta = rec.versions?.[v];
                if (meta) versions[v] = meta;
            }
            await this.deps.registry.update(avatarId, { versions });
        }
        return removed;
    }

    private versionMeta(rec: AvatarInstallRecord, version: string): AvatarVersionMeta | null {
        const map = rec.versions;
        if (map?.[version]) return map[version];
        if (rec.version === version) {
            return { assetUrl: rec.assetUrl, sha256: rec.sha256, size: rec.size };
        }
        return null;
    }

    /** progress 付き download。Range / resume は Phase 1 では実装しない (指示書 §11)。 */
    private async download(
        entry: ManifestAvatarEntry,
        onChunk: (received: number, total: number) => void,
    ): Promise<ArrayBuffer> {
        const res = await this.deps.fetchImpl(entry.assetUrl, { cache: 'no-store' } as any);
        if (!res || !res.ok) throw new Error(`download 失敗: HTTP ${res?.status ?? '?'}`);
        const header = Number(res.headers?.get?.('Content-Length') ?? 0);
        const total = header > 0 ? header : entry.size;
        const body: any = (res as any).body;
        if (!body || typeof body.getReader !== 'function') {
            const buf = await res.arrayBuffer();
            onChunk(buf.byteLength, total);
            return buf;
        }
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                received += value.byteLength;
                onChunk(received, total);
            }
        }
        // 連結は 1 回だけ。25MB に対して何重もの巨大コピーを作らない (指示書 §13)。
        const out = new Uint8Array(received);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.byteLength; }
        chunks.length = 0;
        return out.buffer;
    }
}

/**
 * Install Registry (指示書 §5-2)。
 *
 * **IndexedDB** に状態だけを持つ。ZIP binary は入れない (それは Cache Storage)。
 *
 * テスト容易性のため `KeyValueStore` を挟む。本番は IndexedDB 実装、
 * ロジックテストは Map 実装を差し込む。
 */

export type InstallState =
    | 'UNINSTALLED'
    | 'DOWNLOADING'
    | 'VERIFYING'
    | 'READY'
    | 'INSTALLED'
    | 'MISSING'
    | 'FAILED';

export interface AvatarInstallRecord {
    avatarId: string;
    version: string;

    assetUrl: string;
    sha256: string;
    size: number;

    state: InstallState;

    /** 実際に起動に使う version */
    activeVersion?: string;
    /** download / 検証まで終わったが、次回起動から使う version */
    pendingVersion?: string;

    installedAt?: number;
    lastVerifiedAt?: number;
    persistGranted?: boolean;
    /** FAILED のときの理由 */
    lastError?: string | null;
    /** version ごとの asset メタ。active / pending の両方を保持できるようにする。
     *  これが無いと update 中に pending の起動へ失敗したとき active へ戻せない。 */
    versions?: Record<string, AvatarVersionMeta>;
}

export interface AvatarVersionMeta {
    assetUrl: string;
    sha256: string;
    size: number;
}

export interface KeyValueStore {
    get(key: string): Promise<AvatarInstallRecord | undefined>;
    put(key: string, value: AvatarInstallRecord): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

export const REGISTRY_DB_NAME = 'travel-avatar-install';
export const REGISTRY_DB_VERSION = 1;
export const REGISTRY_STORE_NAME = 'installs';

class IndexedDbStore implements KeyValueStore {
    private dbPromise: Promise<IDBDatabase> | null = null;

    private open(): Promise<IDBDatabase> {
        if (this.dbPromise) return this.dbPromise;
        this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(REGISTRY_DB_NAME, REGISTRY_DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(REGISTRY_STORE_NAME)) {
                    db.createObjectStore(REGISTRY_STORE_NAME, { keyPath: 'avatarId' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this.dbPromise;
    }

    private async tx<T>(mode: IDBTransactionMode,
                        run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
        const db = await this.open();
        return new Promise<T>((resolve, reject) => {
            const t = db.transaction(REGISTRY_STORE_NAME, mode);
            const req = run(t.objectStore(REGISTRY_STORE_NAME));
            req.onsuccess = () => resolve(req.result as T);
            req.onerror = () => reject(req.error);
        });
    }

    get(key: string): Promise<AvatarInstallRecord | undefined> {
        return this.tx('readonly', (s) => s.get(key));
    }
    async put(key: string, value: AvatarInstallRecord): Promise<void> {
        await this.tx('readwrite', (s) => s.put(value));
    }
    async delete(key: string): Promise<void> {
        await this.tx('readwrite', (s) => s.delete(key));
    }
    async keys(): Promise<string[]> {
        return (await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()))
            .map((k) => String(k));
    }
}

export function createRegistryStore(): KeyValueStore {
    return new IndexedDbStore();
}

export class AvatarInstallRegistry {
    constructor(private readonly store: KeyValueStore) {}

    get(avatarId: string): Promise<AvatarInstallRecord | undefined> {
        return this.store.get(avatarId);
    }

    async save(record: AvatarInstallRecord): Promise<AvatarInstallRecord> {
        await this.store.put(record.avatarId, record);
        return record;
    }

    /** 既存レコードへ部分更新を当てる。無ければ `base` から作る。 */
    async update(avatarId: string, patch: Partial<AvatarInstallRecord>,
                 base?: AvatarInstallRecord): Promise<AvatarInstallRecord> {
        const current = (await this.store.get(avatarId)) ?? base;
        if (!current) throw new Error(`install record がありません: ${avatarId}`);
        const next: AvatarInstallRecord = { ...current, ...patch, avatarId };
        await this.store.put(avatarId, next);
        return next;
    }

    remove(avatarId: string): Promise<void> {
        return this.store.delete(avatarId);
    }

    list(): Promise<string[]> {
        return this.store.keys();
    }
}

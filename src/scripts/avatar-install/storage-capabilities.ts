/**
 * Storage API (`navigator.storage`) の薄いラッパ (指示書 §12)。
 *
 * - `persist()` が false でも install を止めない
 * - quota は物理空き容量そのものではないので、厳格な独自判定で install を拒否しない
 *   (明らかに足りないときだけ警告を返す)
 */

export interface StorageStatus {
    supported: boolean;
    usage: number | null;
    quota: number | null;
    /** quota - usage。取れなければ null。 */
    available: number | null;
    persistGranted: boolean;
    /** 明らかに足りない場合だけ true。install をブロックする判断には使わない。 */
    likelyInsufficient: boolean;
}

/** 必要量に対してこの倍率の余裕が無ければ警告する。拒否はしない。 */
const HEADROOM = 1.5;

export async function queryStorage(requiredBytes: number): Promise<StorageStatus> {
    const result: StorageStatus = {
        supported: false, usage: null, quota: null, available: null,
        persistGranted: false, likelyInsufficient: false,
    };
    try {
        const s: any = (navigator as any)?.storage;
        if (!s || typeof s.estimate !== 'function') return result;
        result.supported = true;
        const est = await s.estimate();
        result.usage = typeof est?.usage === 'number' ? est.usage : null;
        result.quota = typeof est?.quota === 'number' ? est.quota : null;
        if (result.usage !== null && result.quota !== null) {
            result.available = Math.max(0, result.quota - result.usage);
            result.likelyInsufficient = result.available < requiredBytes * HEADROOM;
        }
        if (typeof s.persisted === 'function') {
            result.persistGranted = (await s.persisted()) === true;
        }
    } catch (e) {
        // 取得できなくても install は続行する。
    }
    return result;
}

/**
 * persistent storage を要求する。false / 未対応でも install は続ける
 * (best effort storage として扱う)。
 */
export async function requestPersist(): Promise<boolean> {
    try {
        const s: any = (navigator as any)?.storage;
        if (!s || typeof s.persist !== 'function') return false;
        if (typeof s.persisted === 'function' && (await s.persisted()) === true) return true;
        return (await s.persist()) === true;
    } catch (e) {
        return false;
    }
}

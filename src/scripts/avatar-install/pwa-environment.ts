/**
 * PWA / standalone 判定をここ 1 箇所へ集約する (指示書 §9)。
 *
 * 既存コードは `InstallPrompt.astro` / `index.astro` / `concierge.astro` に
 * それぞれ standalone 判定を持っている。新しい判定を増やして散在させず、
 * avatar install 機構はこの helper だけを見る。既存コードには手を入れない。
 */

export type PwaPlatform = 'ios' | 'android' | 'desktop' | 'unknown';

export interface PwaEnvironment {
    platform: PwaPlatform;
    /** Home Screen / インストール済み Web App として起動しているか */
    standalone: boolean;
    /** iPhone / iPad の Safari (standalone ではない) か */
    iosBrowser: boolean;
    /** Cache Storage / IndexedDB が使えるか */
    storageAvailable: boolean;
}

function ua(): string {
    try {
        return navigator.userAgent || '';
    } catch (e) {
        return '';
    }
}

function isIOS(): boolean {
    const u = ua();
    if (/iPad|iPhone|iPod/.test(u)) return true;
    // iPadOS 13+ は Macintosh を名乗るので touch で見分ける。
    try {
        return u.includes('Macintosh') && (navigator as any).maxTouchPoints > 1;
    } catch (e) {
        return false;
    }
}

/** display-mode と iOS の `navigator.standalone` の両方を見る。 */
export function isStandalone(): boolean {
    try {
        if (window.matchMedia?.('(display-mode: standalone)')?.matches) return true;
    } catch (e) { /* noop */ }
    try {
        if ((navigator as any).standalone === true) return true;
    } catch (e) { /* noop */ }
    return false;
}

export function getPwaEnvironment(): PwaEnvironment {
    const ios = isIOS();
    const standalone = isStandalone();
    const u = ua();
    const platform: PwaPlatform = ios ? 'ios'
        : /Android/.test(u) ? 'android'
        : u ? 'desktop' : 'unknown';
    let storageAvailable = false;
    try {
        storageAvailable = typeof caches !== 'undefined' && typeof indexedDB !== 'undefined';
    } catch (e) {
        storageAvailable = false;
    }
    return { platform, standalone, iosBrowser: ios && !standalone, storageAvailable };
}

/**
 * iPhone Safari で 25MB を先にインストールさせない (指示書 §9)。
 * Safari と Home Screen Web App では storage が別なので、二重 download になる。
 */
export function shouldDeferInstallToHomeScreen(env: PwaEnvironment): boolean {
    return env.iosBrowser;
}

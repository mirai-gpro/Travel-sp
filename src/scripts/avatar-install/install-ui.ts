/**
 * Install / Recovery / Poster の UI (指示書 §10 / §11 / §16 / §17 / §24)。
 *
 * storage 実装 (Cache / IndexedDB / manifest) は一切持たない。
 * `AvatarInstallManager` から渡された情報を描くだけ。
 */

import type { InstallProgress } from './avatar-install-manager';
import type { PwaEnvironment } from './pwa-environment';

const STYLE_ID = 'avatar-install-ui-style';

const CSS = `
.avatar-install-overlay{position:absolute;inset:0;display:flex;align-items:center;
 justify-content:center;z-index:30;background:#000;overflow:hidden}
.avatar-install-poster{position:absolute;inset:0;width:100%;height:100%;
 object-fit:cover;opacity:1;transition:opacity .45s ease}
.avatar-install-poster.is-hidden{opacity:0}
.avatar-install-poster-fallback{position:absolute;inset:0;
 background:linear-gradient(180deg,#dff3e4 0%,#bfe6cc 100%)}
.avatar-install-card{position:relative;z-index:1;max-width:19rem;margin:0 1rem;
 padding:1.25rem 1.25rem 1.1rem;border-radius:14px;background:rgba(255,255,255,.96);
 box-shadow:0 8px 28px rgba(0,0,0,.22);color:#1f2a24;
 font:14px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
.avatar-install-card h2{margin:0 0 .5rem;font-size:15px;font-weight:700}
.avatar-install-card p{margin:.35rem 0}
.avatar-install-size{font-weight:700}
.avatar-install-note{color:#5a6b61;font-size:12.5px}
.avatar-install-actions{margin-top:.9rem;display:flex;gap:.5rem}
.avatar-install-btn{flex:1;padding:.6rem .8rem;border:0;border-radius:9px;
 background:#18a058;color:#fff;font-size:14px;font-weight:700;cursor:pointer}
.avatar-install-btn[disabled]{opacity:.55;cursor:default}
.avatar-install-btn.is-secondary{background:#e6ece9;color:#2c3a33}
.avatar-install-bar{margin-top:.75rem;height:7px;border-radius:999px;
 background:#e3eae6;overflow:hidden}
.avatar-install-bar > i{display:block;height:100%;width:0;background:#18a058;
 transition:width .25s ease}
.avatar-install-steps{margin:.5rem 0 0;padding-left:1.05rem;color:#5a6b61;font-size:12.5px}
.avatar-install-error{margin-top:.5rem;color:#b4322a;font-size:12.5px;word-break:break-all}
`;

function ensureStyle(): void {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

function mb(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

export interface InstallUiHandles {
    root: HTMLElement;
    /** Poster をフェードアウトして 3D を見せる (指示書 §17)。 */
    revealRenderer(): void;
    destroy(): void;
}

export interface PosterOptions {
    posterUrl?: string;
    /** poster asset が無いときに出す代替背景を使うか */
    allowFallback?: boolean;
}

/**
 * Poster だけを出す。3D の First Frame が安定したら `revealRenderer()` を呼ぶ。
 * poster asset が無い場合でも黒画面にしない (指示書 §17)。
 */
export function mountPoster(container: HTMLElement, opts: PosterOptions): InstallUiHandles {
    ensureStyle();
    const root = document.createElement('div');
    root.className = 'avatar-install-overlay';
    root.dataset.role = 'avatar-poster';

    let img: HTMLImageElement | null = null;
    const fallback = document.createElement('div');
    fallback.className = 'avatar-install-poster-fallback';
    root.appendChild(fallback);

    if (opts.posterUrl) {
        img = document.createElement('img');
        img.className = 'avatar-install-poster';
        img.alt = '';
        img.decoding = 'async';
        // poster asset が存在しない場合はフォールバック背景のまま残す。
        img.addEventListener('error', () => { img?.remove(); img = null; });
        img.src = opts.posterUrl;
        root.appendChild(img);
    }

    container.appendChild(root);
    let removed = false;
    const destroy = () => {
        if (removed) return;
        removed = true;
        root.remove();
    };
    return {
        root,
        revealRenderer() {
            root.style.transition = 'opacity .45s ease';
            root.style.opacity = '0';
            setTimeout(destroy, 480);
        },
        destroy,
    };
}

export interface InstallPromptOptions {
    sizeBytes: number;
    /** 容量が明らかに足りない可能性があるときだけ出す警告 */
    storageWarning?: string | null;
    onStart: () => void;
}

/** 初回インストール案内 (指示書 §10)。承認前に download は始めない。 */
export function renderInstallPrompt(host: HTMLElement, o: InstallPromptOptions): {
    setProgress(p: InstallProgress): void;
} {
    ensureStyle();
    host.querySelector('.avatar-install-card')?.remove();
    const card = document.createElement('div');
    card.className = 'avatar-install-card';
    card.innerHTML = `
        <h2>高精度3Dアバターを準備します</h2>
        <p>データサイズ：<span class="avatar-install-size">約${mb(o.sizeBytes)}</span></p>
        <p>初回のみダウンロードが必要です。完了後は端末から高速に起動できます。</p>
        <p class="avatar-install-note">インストール中は、この画面を開いたままにしてください。</p>
        ${o.storageWarning ? `<p class="avatar-install-error">${o.storageWarning}</p>` : ''}
        <div class="avatar-install-actions">
            <button type="button" class="avatar-install-btn" data-act="start">インストール開始</button>
        </div>
        <div class="avatar-install-bar" hidden><i></i></div>
        <p class="avatar-install-note" data-role="status" hidden></p>
        <p class="avatar-install-error" data-role="error" hidden></p>
    `;
    host.appendChild(card);

    const btn = card.querySelector<HTMLButtonElement>('[data-act="start"]')!;
    const bar = card.querySelector<HTMLElement>('.avatar-install-bar')!;
    const fill = bar.querySelector<HTMLElement>('i')!;
    const status = card.querySelector<HTMLElement>('[data-role="status"]')!;
    const error = card.querySelector<HTMLElement>('[data-role="error"]')!;

    btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = '準備中…';
        bar.hidden = false;
        status.hidden = false;
        o.onStart();
    });

    return {
        setProgress(p: InstallProgress) {
            if (p.state === 'DOWNLOADING') {
                const pct = p.ratio === null ? null : Math.round(p.ratio * 100);
                fill.style.width = (pct ?? 0) + '%';
                status.textContent = (pct === null ? '' : pct + '%  ')
                    + `${mb(p.receivedBytes)} / ${mb(p.totalBytes)}`;
            } else if (p.state === 'VERIFYING') {
                fill.style.width = '100%';
                status.textContent = 'データを検証しています…';
            } else if (p.state === 'READY' || p.state === 'INSTALLED') {
                fill.style.width = '100%';
                status.textContent = 'インストール完了。起動しています…';
            } else if (p.state === 'FAILED') {
                btn.disabled = false;
                btn.textContent = 'やり直す';
                status.textContent = '';
                error.hidden = false;
                error.textContent = 'インストールに失敗しました: ' + (p.message ?? '');
            }
        },
    };
}

/** Registry と Cache が食い違ったときの案内 (指示書 §16)。黙って再 download しない。 */
export function renderRecoveryPrompt(host: HTMLElement, o: {
    sizeBytes: number; reason: string; onRetry: () => void;
}): void {
    ensureStyle();
    host.querySelector('.avatar-install-card')?.remove();
    const card = document.createElement('div');
    card.className = 'avatar-install-card';
    card.innerHTML = `
        <h2>アバターデータを再準備する必要があります</h2>
        <p class="avatar-install-note">${o.reason}</p>
        <p>再ダウンロード：<span class="avatar-install-size">約${mb(o.sizeBytes)}</span></p>
        <div class="avatar-install-actions">
            <button type="button" class="avatar-install-btn" data-act="retry">再準備</button>
        </div>
    `;
    host.appendChild(card);
    card.querySelector('[data-act="retry"]')!
        .addEventListener('click', () => o.onRetry());
}

/**
 * iPhone Safari 向けの Home Screen 案内 (指示書 §9)。
 * Safari 側で 25MB を入れさせない。`beforeinstallprompt` には依存しない。
 */
export function renderHomeScreenGuide(host: HTMLElement, env: PwaEnvironment, o: {
    onContinueAnyway?: () => void;
}): void {
    ensureStyle();
    host.querySelector('.avatar-install-card')?.remove();
    const card = document.createElement('div');
    card.className = 'avatar-install-card';
    card.innerHTML = `
        <h2>高精度アバターはホーム画面からの利用をおすすめします</h2>
        <p class="avatar-install-note">Safari とホーム画面のアプリでは保存領域が別のため、
        Safari で先に入れると同じデータを2回ダウンロードすることになります。</p>
        <ol class="avatar-install-steps">
            <li>画面下の共有ボタン <span aria-hidden="true">(□↑)</span> を押す</li>
            <li>「ホーム画面に追加」を選ぶ</li>
            <li>追加されたアイコンから開く</li>
        </ol>
        <div class="avatar-install-actions">
            ${o.onContinueAnyway
                ? '<button type="button" class="avatar-install-btn is-secondary" data-act="anyway">このまま続ける</button>'
                : ''}
        </div>
    `;
    host.appendChild(card);
    if (o.onContinueAnyway) {
        card.querySelector('[data-act="anyway"]')
            ?.addEventListener('click', () => o.onContinueAnyway!());
    }
    void env;
}

/**
 * 更新準備が終わったことだけを伝える通知。
 *
 * **download 案内 UI (`renderUpdateNotice`) を再利用しない。**
 * sizeBytes を 0 にして流用すると「約0.0MB のダウンロードが必要です」という
 * 誤った文面になるため、専用の文面だけを出す。
 */
export function renderUpdateReadyNotice(host: HTMLElement, o: {
    onDismiss?: () => void;
} = {}): void {
    ensureStyle();
    const card = document.createElement('div');
    card.className = 'avatar-install-card';
    card.style.position = 'absolute';
    card.style.right = '0.75rem';
    card.style.bottom = '0.75rem';
    card.style.maxWidth = '16rem';
    card.innerHTML = `
        <h2>更新準備が完了しました。次回起動から新しいアバターを使用します。</h2>
        <div class="avatar-install-actions">
            <button type="button" class="avatar-install-btn is-secondary" data-act="close">閉じる</button>
        </div>
    `;
    host.appendChild(card);
    card.querySelector('[data-act="close"]')!.addEventListener('click', () => {
        card.remove();
        o.onDismiss?.();
    });
}

/** 更新が見つかったときの軽い通知 (指示書 §19 / §20)。起動は止めない。 */
export function renderUpdateNotice(host: HTMLElement, o: {
    label: string; sizeBytes: number; onUpdate: () => void; onDismiss?: () => void;
}): void {
    ensureStyle();
    const card = document.createElement('div');
    card.className = 'avatar-install-card';
    card.style.position = 'absolute';
    card.style.right = '0.75rem';
    card.style.bottom = '0.75rem';
    card.style.maxWidth = '16rem';
    card.innerHTML = `
        <h2>${o.label}</h2>
        <p class="avatar-install-note">約${mb(o.sizeBytes)} のダウンロードが必要です。</p>
        <div class="avatar-install-actions">
            <button type="button" class="avatar-install-btn" data-act="update">更新</button>
            <button type="button" class="avatar-install-btn is-secondary" data-act="later">あとで</button>
        </div>
    `;
    host.appendChild(card);
    card.querySelector('[data-act="update"]')!.addEventListener('click', () => {
        card.remove();
        o.onUpdate();
    });
    card.querySelector('[data-act="later"]')!.addEventListener('click', () => {
        card.remove();
        o.onDismiss?.();
    });
}

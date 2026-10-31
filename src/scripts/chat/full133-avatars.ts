/**
 * FULL133 (UIKA 133,541 Gaussian を 1:1 で運んだ ZIP) として扱う avatar の一覧。
 *
 * FULL133 専用の処理 (`full133-runtime` / `full133-predeform` /
 * `full133-render-budget` / `poc/adaptive-sort` / `poc/run-guard`) は、
 * この一覧に入っている avatar にだけ効く。splatCount の検査は各ファイル側で従来どおり行う。
 *
 * 一覧に足すのは、UIKA_mirai の `tools/uika_to_lam/batch_cli.py` で作り
 * (`build_full133` の all_preserved=True)、`--approve` で採用した ZIP だけ。
 */
export const FULL133_AVATAR_IDS: ReadonlySet<string> = new Set([
    'uika-full133-skin',
    // BATCH_20261030_01 (2026-10-31 採用)
    'uika-aragaki-full133',
    'uika-benedict-full133',
    'uika-machida-full133',
    'uika-meruru3-full133',
    'uika-nozomi-full133',
]);

export function isFull133AvatarId(id: string | null | undefined): boolean {
    return typeof id === 'string' && FULL133_AVATAR_IDS.has(id);
}

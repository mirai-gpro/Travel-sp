// src/config/avatar-config.ts
// アバター定義の一元管理
// avatar-config.json から動的に読み込み + localStorage で選択を永続化

export interface AvatarDef {
  id: string;
  name: string;       // メニュー表示名
  modelUrl: string;   // public/avatar/ 配下のzipパス
  thumbnail?: string; // サムネイル画像パス（なければファイル名表示）
  voiceModel: string; // 紐づく音声モデル名
}

/** デフォルトのアバター一覧（JSONロード失敗時のフォールバック） */
const DEFAULT_AVATARS: AvatarDef[] = [
  { id: 'meruru', name: 'メルル', modelUrl: '/avatar/meruru.zip', voiceModel: 'ja-JP-Chirp3-HD-Leda' },
  { id: 'elf',    name: 'エルフ', modelUrl: '/avatar/elf.zip', voiceModel: 'ja-JP-Chirp3-HD-Leda' },
];

/** モードごとのデフォルトアバターID */
const MODE_DEFAULT_AVATAR: Record<string, string> = {
  lesson: 'meruru',
  concierge: 'elf',
};

const STORAGE_KEY = 'selectedAvatar';

let _avatarCache: AvatarDef[] | null = null;

/** avatar-config.json からアバター一覧を読み込み */
export async function loadAvatarConfig(): Promise<AvatarDef[]> {
  if (_avatarCache) return _avatarCache;
  try {
    const resp = await fetch('/avatar/avatar-config.json');
    if (resp.ok) {
      _avatarCache = await resp.json();
      return _avatarCache!;
    }
  } catch (e) {
    console.warn('[AvatarConfig] JSON読み込み失敗、デフォルト使用', e);
  }
  _avatarCache = DEFAULT_AVATARS;
  return _avatarCache;
}

/** 選択中のアバターIDを取得（localStorage） */
export function getSelectedAvatarId(mode: string): string {
  const stored = localStorage.getItem(`${STORAGE_KEY}_${mode}`);
  return stored || MODE_DEFAULT_AVATAR[mode] || 'meruru';
}

/** アバターIDとURLを保存（localStorage） */
export function setSelectedAvatar(mode: string, avatar: AvatarDef): void {
  localStorage.setItem(`${STORAGE_KEY}_${mode}`, avatar.id);
  localStorage.setItem(`selectedAvatarUrl_${mode}`, avatar.modelUrl);
  localStorage.setItem(`selectedVoiceModel_${mode}`, avatar.voiceModel);
}

/** IDからアバター定義を取得 */
export function getAvatarById(avatars: AvatarDef[], id: string): AvatarDef | undefined {
  return avatars.find(a => a.id === id);
}

/** 現在選択されているアバターのモデルURLを取得 */
export async function getSelectedAvatarUrl(mode: string): Promise<string> {
  const avatars = await loadAvatarConfig();
  const id = getSelectedAvatarId(mode);
  const avatar = getAvatarById(avatars, id);
  return avatar?.modelUrl || '/avatar/meruru.zip';
}

/** 現在選択されているアバターの音声モデルを取得 */
export async function getSelectedVoiceModel(mode: string): Promise<string> {
  const avatars = await loadAvatarConfig();
  const id = getSelectedAvatarId(mode);
  const avatar = getAvatarById(avatars, id);
  return avatar?.voiceModel || 'ja-JP-Chirp3-HD-Leda';
}

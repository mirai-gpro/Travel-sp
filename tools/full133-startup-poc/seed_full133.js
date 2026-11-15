// 計測用: 利用者が UIKA meruru02 FULL133 を選んだ状態（src/config/avatar-config.ts の setSelectedAvatar と同じキー）
try {
  if (!localStorage.getItem('selectedCamera_concierge')) {
    localStorage.setItem('selectedAvatar_concierge', 'uika-meruru02-full133');
    localStorage.setItem('selectedAvatarUrl_concierge', '/avatar/uika-meruru02-full133.zip');
    localStorage.setItem('selectedVoiceModel_concierge', 'ja-JP-Chirp3-HD-Leda');
    localStorage.setItem('selectedLiveVoice_concierge', 'Leda');
    localStorage.setItem('selectedTeacherName_concierge', '');
    localStorage.setItem('selectedCamera_concierge', JSON.stringify({ posY: 1.704, posZ: 0.45, targetY: 1.644, offsetX: 0.045 }));
  }
} catch (e) {}

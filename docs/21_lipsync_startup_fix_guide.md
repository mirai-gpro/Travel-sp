# 初期あいさつリップシンク不具合 対処ガイド

## 問題概要

初期起動時・リロード時に、初期あいさつのA2Eリップシンクが動作しない。
ソフトリセット（タイトルタップ）後は正常に動作する。

この問題はTravel-sp / Chatty-sp 両方で発生し、以下の2つの対処の組み合わせで改善された。

---

## 原因1: デプロイ時の依存解決によるバージョン変動

### 症状
- コードを一切変更していないのに、再デプロイ後にリップシンクが壊れる
- Cloud Runの再ビルドのたびに間接依存のバージョンが変わる

### 原因
`requirements.txt`に直接依存のみ記載（例: `supabase==2.28.3`）していると、
間接依存（例: `pyiceberg`, `zstandard`等）のバージョンはビルド時のpip解決に任される。
ビルドタイミングによって間接依存のバージョンが変わり、
`scipy`や`numpy`との相互作用でA2Eリップシンクが壊れた。

### 対処: requirements.txt 完全固定化

`pip freeze`で全依存（間接含む）のバージョンを完全固定した`requirements.txt`を使う。

#### 手順

1. 仮想環境を作成してインストール
```bash
cd support-base
python -m venv .venv_freeze
source .venv_freeze/bin/activate  # Windows: .\.venv_freeze\Scripts\activate
pip install -r requirements.txt
```

2. 全依存をfreezeして保存
```bash
pip freeze > requirements-lock.txt
```

3. requirements.txtを差し替え
`requirements-lock.txt`の内容を`requirements.txt`にコピーする。
先頭にコメントを追加:
```
# 全依存完全固定版（pip freeze から生成）
# Cloud Runの再ビルドで依存解決が変わる問題を防ぐため、間接依存も含めて全て固定
# 開発ツール（pdfplumber等）はrequirements-dev.txtに分離
```

4. 仮想環境を削除
```bash
deactivate
rm -rf .venv_freeze
```

5. コミット＆プッシュ

#### パッケージを追加・アップデートする場合
1. 仮想環境で`pip install 新パッケージ`（または`--upgrade`）
2. `pip freeze > requirements.txt`で再固定
3. デプロイ後にリップシンク含む全機能を確認

#### 障害時の対応
1. **即座**: GCPコンソール → Cloud Run → 正常だった旧リビジョンにトラフィック100%
2. **Git revert + 再ビルドでは復旧しない場合がある**（同じコードでもビルド結果が異なる）
3. 旧リビジョンで安定化後、原因特定してから修正

---

## 原因2: 初期起動フローでのA2E受信タイミング

### 症状
- 初期起動・リロード時: リップシンクが動かない
- ソフトリセット後: リップシンクが正常に動く
- requirements.txt固定だけでは改善しない場合がある

### 原因
初期起動時の`init()`が`initializeSession()`を直接呼んでいたため、
アバター（LAMAvatar）の初期化が完了する前にA2E expressionが送信され、
フロントエンド側で受け取れなかった。

ソフトリセット時は、すでにアバターが初期化済みのため、
A2E expressionを正常に受信できていた。

### 対処: init()をソフトリセット経由に変更

`core-controller.ts`の`init()`メソッドで、
`initializeSession()`の代わりに`resetAppContent()`を使用し、
初期起動完了後にもう一度`resetAppContent()`を実行する。

#### 変更前
```typescript
protected async init() {
    // ...
    await this.initializeSession();
    this.updateUILanguage();
    // ...
}
```

#### 変更後（Chatty-spと同じフロー）
```typescript
protected async init() {
    // ...
    await this.resetAppContent();
    // ...
    // ★ 初期起動完了後にソフトリセットを自動実行（リップシンク正常化）
    await this.resetAppContent();
}
```

#### なぜ2回呼ぶのか
1回目: 初期セッション確立（アバター初期化がバックグラウンドで進行）
2回目: アバター初期化完了後にセッションを再確立し、A2Eが正常に受信できる状態でリップシンク付きの初期あいさつを発火

---

## 確認手順（デプロイ後）

1. 初期あいさつのリップシンクが正常か確認
2. ソフトリセット不要で初回から動くか確認
3. リロード（F5）後も正常か確認

---

## 対処履歴

| 日付 | リポジトリ | 対処 | 結果 |
|------|-----------|------|------|
| 2026-04-03 | Chatty-sp | requirements.txt完全固定 + init()ソフトリセット経由 | 改善 |
| 2026-04-04 | Travel-sp | requirements.txt完全固定のみ | 改善せず |
| 2026-04-04 | Travel-sp | init()ソフトリセット経由を追加 | 改善 |

**結論: 両方の対処を組み合わせる必要がある。**

# -*- coding: utf-8 -*-
"""
ビジネスロジック・コアクラス
- プロンプト管理
- セッション管理
- アシスタント(AI会話ロジック)
"""
import os
import json
import uuid
import logging
import threading
from datetime import datetime
from google import genai
from google.genai import types
from google.cloud import storage
import google.generativeai as genai_legacy

# api_integrations から必要な関数をインポート
from api_integrations import extract_shops_from_response

logger = logging.getLogger(__name__)

# 長期記憶モジュールをインポート
try:
    from long_term_memory import LongTermMemory, PreferenceExtractor, extract_name_from_text
    LONG_TERM_MEMORY_ENABLED = True
except Exception as e:
    logger.warning(f"[LTM] 長期記憶モジュールのインポート失敗: {e}")
    LONG_TERM_MEMORY_ENABLED = False

# Gemini クライアント初期化
gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
genai_legacy.configure(api_key=os.getenv("GEMINI_API_KEY"))
model = genai_legacy.GenerativeModel('gemini-2.5-flash')

# ========================================
# RAMベースのセッション管理 (Firestore完全廃止)
# ========================================
_SESSION_CACHE = {}

# 確定店の操作（begin_search・commit_shops・紹介の印）はプロセスで 1 つのロックの中で行う
# （キーボードは Flask のスレッド、Live の検索は run_in_executor のスレッドで動くため。R1.4 §7）
_SHOPS_LOCK = threading.Lock()

# ========================================
# プロンプト読み込み (GCS優先、ローカルフォールバック)
# ========================================

def load_prompts_from_gcs():
    """
    GCSから2種類のプロンプトを読み込み
    - support_system_{lang}.txt: チャットモード用
    - concierge_{lang}.txt: コンシェルジュモード用
    - lesson_{lang}.txt: 会話レッスンモード用
    """
    try:
        bucket_name = os.getenv('PROMPTS_BUCKET_NAME')
        if not bucket_name:
            logger.warning("[Prompt] PROMPTS_BUCKET_NAME が設定されていません。ローカルファイルを使用します。")
            return None

        client = storage.Client()
        bucket = client.bucket(bucket_name)
        prompts = {
            'chat': {},      # チャットモード用
            'concierge': {},  # コンシェルジュモード用
            'lesson': {}     # 会話レッスンモード用
        }

        for lang in ['ja', 'en', 'zh', 'ko']:
            # チャットモード用プロンプト
            chat_blob = bucket.blob(f'prompts/support_system_{lang}.txt')
            if chat_blob.exists():
                prompts['chat'][lang] = chat_blob.download_as_text(encoding='utf-8')
                logger.info(f"[Prompt] GCSから読み込み成功: support_system_{lang}.txt")
            else:
                logger.warning(f"[Prompt] GCSに見つかりません: support_system_{lang}.txt")

            # コンシェルジュモード用プロンプト
            concierge_blob = bucket.blob(f'prompts/concierge_{lang}.txt')
            if concierge_blob.exists():
                content = concierge_blob.download_as_text(encoding='utf-8')
                try:
                    json_data = json.loads(content)
                    prompts['concierge'][lang] = json_data.get('concierge_system', content)
                except json.JSONDecodeError:
                    prompts['concierge'][lang] = content
                logger.info(f"[Prompt] GCSから読み込み成功: concierge_{lang}.txt")
            else:
                logger.warning(f"[Prompt] GCSに見つかりません: concierge_{lang}.txt")

            # 会話レッスンモード用プロンプト
            lesson_blob = bucket.blob(f'prompts/lesson_{lang}.txt')
            if lesson_blob.exists():
                prompts['lesson'][lang] = lesson_blob.download_as_text(encoding='utf-8')
                logger.info(f"[Prompt] GCSから読み込み成功: lesson_{lang}.txt")
            else:
                logger.warning(f"[Prompt] GCSに見つかりません: lesson_{lang}.txt")

        return prompts if (prompts['chat'] or prompts['concierge'] or prompts['lesson']) else None

    except Exception as e:
        logger.error(f"[Prompt] GCS読み込み失敗: {e}")
        return None

def load_prompts_from_local():
    """
    ローカルファイルから2種類のプロンプトを読み込み (フォールバック)
    """
    prompts = {
        'chat': {},
        'concierge': {},
        'lesson': {}
    }

    for lang in ['ja', 'en', 'zh', 'ko']:
        # チャットモード用
        chat_file = f'prompts/support_system_{lang}.txt'
        try:
            with open(chat_file, 'r', encoding='utf-8') as f:
                prompts['chat'][lang] = f.read()
                logger.info(f"[Prompt] ローカルから読み込み成功: support_system_{lang}.txt")
        except FileNotFoundError:
            logger.warning(f"[Prompt] ローカルファイルが見つかりません: {chat_file}")
        except Exception as e:
            logger.error(f"[Prompt] ローカル読み込みエラー (chat/{lang}): {e}")

        # コンシェルジュモード用
        concierge_file = f'prompts/concierge_{lang}.txt'
        try:
            with open(concierge_file, 'r', encoding='utf-8') as f:
                content = f.read()
                try:
                    json_data = json.loads(content)
                    prompts['concierge'][lang] = json_data.get('concierge_system', content)
                except json.JSONDecodeError:
                    prompts['concierge'][lang] = content
                logger.info(f"[Prompt] ローカルから読み込み成功: concierge_{lang}.txt")
        except FileNotFoundError:
            logger.warning(f"[Prompt] ローカルファイルが見つかりません: {concierge_file}")
        except Exception as e:
            logger.error(f"[Prompt] ローカル読み込みエラー (concierge/{lang}): {e}")

        # 会話レッスンモード用
        lesson_file = f'prompts/lesson_{lang}.txt'
        try:
            with open(lesson_file, 'r', encoding='utf-8') as f:
                prompts['lesson'][lang] = f.read()
                logger.info(f"[Prompt] ローカルから読み込み成功: lesson_{lang}.txt")
        except FileNotFoundError:
            logger.warning(f"[Prompt] ローカルファイルが見つかりません: {lesson_file}")
        except Exception as e:
            logger.error(f"[Prompt] ローカル読み込みエラー (lesson/{lang}): {e}")

    return prompts if (prompts['chat'] or prompts['concierge'] or prompts['lesson']) else None

def load_system_prompts():
    logger.info("[Prompt] プロンプト読み込み開始...")
    prompts = load_prompts_from_gcs()
    if not prompts:
        logger.info("[Prompt] GCSから読み込めませんでした。ローカルファイルを使用します。")
        prompts = load_prompts_from_local()

    if not prompts or (not prompts.get('chat') and not prompts.get('concierge') and not prompts.get('lesson')):
        logger.error("[Prompt] プロンプトの読み込みに失敗しました!")
        return {
            'chat': {'ja': 'エラー: チャットモードプロンプトが読み込めませんでした。'},
            'concierge': {'ja': 'エラー: コンシェルジュモードプロンプトが読み込めませんでした。'},
            'lesson': {'ja': 'エラー: レッスンモードプロンプトが読み込めませんでした。'}
        }

    logger.info(f"[Prompt] プロンプト読み込み完了:")
    logger.info(f"  - チャットモード: {list(prompts.get('chat', {}).keys())}")
    logger.info(f"  - コンシェルジュモード: {list(prompts.get('concierge', {}).keys())}")
    logger.info(f"  - レッスンモード: {list(prompts.get('lesson', {}).keys())}")
    return prompts

# プロンプト読み込み実行(モジュールロード時)
SYSTEM_PROMPTS = load_system_prompts()


def load_concierge_v11():
    """
    コンシェルジュ専用の共通プロンプト v11（R1.4 §5.2・§11 #3）。
    GCS は変えず、イメージに含めた prompts/concierge_v11_{lang}.txt だけを読む（PR-01）。
    ない言語は登録しない（その言語のコンシェルジュは「現在ご利用いただけません」を返す。§9）。
    """
    prompts = {}
    for lang in ['ja', 'en', 'zh', 'ko']:
        path = f'prompts/concierge_v11_{lang}.txt'
        try:
            with open(path, 'r', encoding='utf-8') as f:
                prompts[lang] = f.read()
            logger.info(f"[Prompt] v11 読み込み成功: concierge_v11_{lang}.txt")
        except FileNotFoundError:
            logger.warning(f"[Prompt] v11 がありません: {path}")
    return prompts


CONCIERGE_V11 = load_concierge_v11()
INITIAL_GREETINGS = {
    'chat': {
        'ja': 'こんにちは!お店探しをお手伝いします。どのようなお店をお探しですか?(例:新宿で美味しいイタリアン、明日19時に予約できる焼肉店など)',
        'en': 'Hello! I\'m here to help you find restaurants. What kind of restaurant are you looking for?',
        'zh': '$60A8好!我来$5E2E$60A8找餐$5385。$60A8在$5BFB找什$4E48$6837的餐$5385?',
        'ko': '$C548$B155$D558$C138$C694! $B808$C2A4$D1A0$B791 $CC3E$AE30$B97C $B3C4$C640$B4DC$B9AC$ACA0$C2B5$B2C8$B2E4. $C5B4$B5A4 $B808$C2A4$D1A0$B791$C744 $CC3E$C73C$C2DC$B098$C694?'
    },
    'concierge': {
        'ja': 'いらっしゃいませ。グルメコンシェルジュです。今日はどのようなシーンでお店をお探しでしょうか?接待、デート、女子会など、お気軽にお聞かせください。',
        'en': 'Welcome! I\'m your gourmet concierge. What kind of dining experience are you looking for today? Business dinner, date, gathering with friends?',
        'zh': '$6B22迎光$4E34!我是$60A8的美食礼$5BBE$5458。今天$60A8想$5BFB找什$4E48$6837的用餐$573A景?商$52A1宴$8BF7、$7EA6会、朋友聚会?',
        'ko': '$C5B4$C11C$C624$C138$C694! $C800$B294 $ADC0$D558$C758 $BBF8$C2DD $CEE8$C2DC$C5B4$C9C0$C785$B2C8$B2E4. $C624$B298$C740 $C5B4$B5A4 $C2DD$C0AC $C7A5$BA74$C744 $CC3E$C73C$C2DC$B098$C694? $C811$B300, $B370$C774$D2B8, $BAA8$C784 $B4F1?'
    },
    'lesson': {
        'ja': 'こんにちは！英会話のレッスンを担当します。旅行先で使える英語フレーズを練習しましょう！どんな場面で使う英語を練習したいですか？',
        'en': 'Hello! I\'m your English conversation coach. Let\'s practice useful travel phrases! What kind of situation would you like to practice?',
        'zh': '你好！我是你的英语会话教练。让我们练习旅行中实用的英语短语吧！你想练习什么场景的英语？',
        'ko': '안녕하세요! 영어 회화 코치입니다. 여행에서 쓸 수 있는 영어 표현을 연습해 봅시다! 어떤 상황의 영어를 연습하고 싶으세요?'
    }
}

CONVERSATION_SUMMARY_TEMPLATES = {
    'ja': '以下の会話を1文で要約してください。\n\nユーザー: {user_message}\nアシスタント: {assistant_response}\n\n要約:',
    'en': 'Summarize the following conversation in one sentence.\n\nUser: {user_message}\nAssistant: {assistant_response}\n\nSummary:',
    'zh': '$8BF7用一句$8BDD$603B$7ED3以下$5BF9$8BDD。\n\n用$6237:{user_message}\n助手:{assistant_response}\n\n$603B$7ED3:',
    'ko': '$B2E4$C74C $B300$D654$B97C $D55C $BB38$C7A5$C73C$B85C $C694$C57D$D558$C138$C694.\n\n$C0AC$C6A9$C790: {user_message}\n$C5B4$C2DC$C2A4$D134$D2B8: {assistant_response}\n\n$C694$C57D:'
}

FINAL_SUMMARY_TEMPLATES = {
    'ja': '以下の会話全体を要約し、問い合わせ内容をまとめてください。\n\n{conversation_text}\n\n作成日時: {timestamp}\n\n要約:',
    'en': 'Summarize the entire conversation below and organize the inquiry content.\n\n{conversation_text}\n\nCreated: {timestamp}\n\nSummary:',
    'zh': '$8BF7$603B$7ED3以下整个$5BF9$8BDD并整理咨$8BE2内容。\n\n{conversation_text}\n\n$521B建$65F6$95F4:{timestamp}\n\n$603B$7ED3:',
    'ko': '$B2E4$C74C $B300$D654$B97C $D55C $BB38$C7A5$C73C$B85C $C694$C57D$D558$C138$C694.\n\n$C0AC$C6A9$C790: {user_message}\n$C5B4$C2DC$C2A4$D134$D2B8: {assistant_response}\n\n$C694$C57D:'
}

# ========================================
# コンシェルジュのキーボード会話（R1.4 §5）
# 文面は草案で、実装前の承認（D-4）を受けて確定する。モデルは §4.1（D-3）
# ========================================
CONCIERGE_C1_MODEL = 'gemini-3.6-flash'
CONCIERGE_C2_MODEL = 'gemini-3.5-flash-lite'
CONCIERGE_LLM_TIMEOUT_MS = 20000  # concierge_recommender.LLM_TIMEOUT_MS と同じ（推奨値）

CONCIERGE_C1_SCHEMA = {
    'type': 'object',
    'properties': {
        'message': {'type': 'string'},
        'action': {
            'type': 'object',
            'properties': {
                'type': {'type': 'string'},
                'updates': {
                    'type': 'object',
                    'properties': {
                        'preferred_name': {'type': 'string'},
                        'name_honorific': {'type': 'string'},
                    },
                },
            },
            'required': ['type', 'updates'],
        },
        'shop_request': {
            'type': 'object',
            'properties': {'user_request': {'type': 'string'}},
            'required': ['user_request'],
        },
    },
    'required': ['message'],
}

CONCIERGE_REST_RULES = """
【文字の会話の規則（キーボード）】
- 返答は指定された JSON スキーマに従う。message は画面に出す文章で、マークダウンや記号の装飾を使わない。
- 推薦を依頼するときは shop_request.user_request に、確認した条件を全て入れる。このとき message は短い前置きだけにし、店名を書かない。
- 推薦を依頼しないときは shop_request を出さない。追質問か新しい推薦かは、会話の意味で判断する。
- 名前の登録・変更の意図が明確なときだけ action を出す（type は update_user_profile、updates に preferred_name と name_honorific）。
- お店について聞かれたら、下の【現在の確定店】の情報だけで答える。そこにない店名を挙げない。営業時間・評価・住所は答えず、画面のカードを案内する。
"""

CONCIERGE_TEXTS = {
    'ja': {
        'intro': 'ご希望に合うお店を 5 件ご紹介します。',
        'too_few': '条件に合うと確認できたお店は {n} 軒で、5 軒に届きませんでした。エリア・予算・ジャンルなど、少し広げてもよい条件はありますか？',
        'fresh_disabled': '最近開店したお店の検索は準備中です。通常の探し方でお探ししてもよろしいでしょうか？',
        'superseded': '新しい検索を受け付けたため、この検索の結果は表示しませんでした。',
        'summary': '5軒のお店を提案しました。',
        'unsupported_language': 'この言語では現在ご利用いただけません。',
        'no_shops': 'まだご提案したお店はありません。',
    },
    'en': {
        'intro': 'Here are 5 restaurants that match your request.',
        'too_few': 'We could confirm only {n} restaurants matching your conditions, short of 5. Is there a condition such as area, budget or cuisine that we could relax?',
        'fresh_disabled': 'Searching for newly opened restaurants is not available yet. Shall I search in the usual way instead?',
        'superseded': 'A newer search was received, so the results of this search were not shown.',
        'summary': 'Suggested 5 restaurants.',
        'unsupported_language': 'This language is currently not available.',
        'no_shops': 'No restaurants have been suggested yet.',
    },
    'zh': {
        'intro': '为您推荐 5 家符合要求的餐厅。',
        'too_few': '能确认符合条件的餐厅只有 {n} 家，不足 5 家。地区、预算、菜系等条件中，有可以放宽的吗？',
        'fresh_disabled': '新开餐厅的搜索功能尚在准备中。可以按通常的方式为您搜索吗？',
        'superseded': '由于收到了新的搜索请求，本次搜索结果未予显示。',
        'summary': '推荐了5家餐厅。',
        'unsupported_language': '目前暂不支持该语言。',
        'no_shops': '目前还没有推荐的餐厅。',
    },
    'ko': {
        'intro': '조건에 맞는 식당 5곳을 소개해 드립니다.',
        'too_few': '조건에 맞는 것으로 확인된 식당은 {n}곳으로 5곳에 미치지 못했습니다. 지역, 예산, 장르 등 조금 넓혀도 되는 조건이 있으신가요?',
        'fresh_disabled': '최근 개업한 식당 검색은 준비 중입니다. 일반적인 방법으로 찾아 드려도 될까요?',
        'superseded': '새로운 검색을 받았기 때문에 이번 검색 결과는 표시하지 않았습니다.',
        'summary': '5곳의 식당을 제안했습니다.',
        'unsupported_language': '이 언어는 현재 이용하실 수 없습니다.',
        'no_shops': '아직 제안한 식당이 없습니다.',
    },
}

CONCIERGE_ERROR_TEXTS = {
    'ja': 'エラーが発生しました。もう一度お試しください。',
    'en': 'An error occurred. Please try again.',
    'zh': '発生錯誤。請重試。',
    'ko': '오류가 발생했습니다. 다시 시도해주세요.',
}


def concierge_text(language: str, key: str, **kw) -> str:
    texts = CONCIERGE_TEXTS.get(language, CONCIERGE_TEXTS['ja'])
    return texts[key].format(**kw)


def format_concierge_shops_for_llm(shops: list, version: int, language: str = 'ja') -> str:
    """確定店の会話用の項目を LLM 用の文字列にする（C1・Live 共通。place_id は渡さない）"""
    if not shops:
        return concierge_text(language, 'no_shops')
    lines = [f"版 {version}"]
    for s in shops:
        parts = [f"{s.get('order')}. {s.get('name', '')}（{s.get('area', '')}）",
                 f"ジャンル: {s.get('genre', '')}",
                 f"看板料理: {s.get('specialty', '')}",
                 f"雰囲気: {s.get('atmosphere', '')}",
                 f"予算の目安: {s.get('price_estimate', '')}",
                 f"推薦理由: {s.get('reason', '')}"]
        if s.get('opened'):
            parts.append(f"開店時期: {s.get('opened')}")
        lines.append(' / '.join(parts))
    return '\n'.join(lines)


def build_concierge_reply(language: str, outcome: dict) -> str:
    """推薦の結果の状態ごとに、キーボードの返答の文章をサーバーが作る（§5.3・§9）"""
    status = outcome.get('status')
    if status == 'complete':
        lines = [concierge_text(language, 'intro'), '']
        for s in outcome.get('shops', []):
            lines.append(f"{s['order']}. {s['name']}（{s.get('area', '')}）: {s.get('reason', '')}")
        return '\n'.join(lines)
    if status == 'superseded':
        return concierge_text(language, 'superseded')
    if status == 'not_found':
        if outcome.get('reason_code') == 'fresh_disabled':
            return concierge_text(language, 'fresh_disabled')
        return concierge_text(language, 'too_few', n=outcome.get('found_count', 0))
    return CONCIERGE_ERROR_TEXTS.get(language, CONCIERGE_ERROR_TEXTS['ja'])


class SupportSession:
    """サポートセッション管理 (RAM版)"""

    def __init__(self, session_id=None):
        self.session_id = session_id or str(uuid.uuid4())

    def initialize(self, user_info=None, language='ja', mode='chat'):
        """
        新規セッション初期化 - モード対応 + 長期記憶統合

        【新設計】効率化版:
        - user_id はフロントエンドから user_info.user_id で受け取る
        - チャットモードはDB読み込みをスキップ（高速化）
        - コンシェルジュモードは軽量クエリ（名前のみ）で初期化
        - サマリーは初回メッセージ時に遅延読み込み
        - 新規ユーザーはDB INSERTしない（名前登録時に初めてINSERT）
        """
        # user_id を user_info から取得
        user_id = user_info.get('user_id') if user_info else None

        # 長期記憶から既存プロファイルを取得
        long_term_profile = None
        is_first_visit = True
        user_context = ""

        # 全モードで長期記憶を使用（ユーザー名の共有）
        if LONG_TERM_MEMORY_ENABLED and user_id:
            try:
                ltm = LongTermMemory()

                # 軽量クエリで名前のみ取得（1回のDB照会のみ）
                profile_basic = ltm.get_profile_basic(user_id)

                if profile_basic:
                    # リピーター: プロファイルあり
                    is_first_visit = False
                    long_term_profile = profile_basic

                    # 訪問回数インクリメント（キャッシュ済みなので追加DB照会なし）
                    current_count = profile_basic.get('visit_count', 0)
                    ltm.increment_visit_count(user_id, current_count)

                    logger.info(f"[Session] リピーター: user_id={user_id}, 訪問={current_count + 1}回目")
                else:
                    # 新規ユーザー: DBにはまだ書き込まない
                    # → 名前登録時（LLM action）に初めてINSERT
                    is_first_visit = True
                    long_term_profile = None
                    logger.info(f"[Session] 新規ユーザー: user_id={user_id}")

            except Exception as e:
                logger.error(f"[Session] 長期記憶の読み込みエラー: {e}")

        data = {
            'session_id': self.session_id,
            'user_id': user_id,  # ★ user_id を保存（DB操作に使用）
            'messages': [],  # SDKネイティブのリスト形式用
            'status': 'active',
            'user_info': user_info or {},
            'language': language,
            'mode': mode,
            'summary': None,
            'inquiry_summary': None,
            'current_shops': [],
            # 確定店の共有（R1.4 §7）
            'search_seq': 0,        # 最後に始めた検索の番号
            'shops_version': 0,     # 確定ごとに 1 増える
            'intro_marks': {},      # 店の順番 → 紹介の印
            # 長期記憶関連の追加フィールド
            'is_first_visit': is_first_visit,
            'user_context': user_context,
            'long_term_profile': long_term_profile
        }
        _SESSION_CACHE[self.session_id] = data
        logger.info(f"[Session] RAM作成: {self.session_id}, 言語: {language}, モード: {mode}, 初回: {is_first_visit}")
        return data

    def add_message(self, role, content, message_type='chat'):
        """メッセージを追加(役割(Role)$00E5$02C6$00A5$00E3$0081$00AE$00E6§$2039$00E9$20AC $00E3$0081§$00E4$00BF$009D$00E5$00AD$02DC$00EF$00BC‰"""
        data = self.get_data()
        if not data:
            return None
        
        # genai SDKが理解できる構造で保存
        message = {
            'role': 'user' if role == 'user' else 'model',
            'parts': [content],
            'type': message_type,  # 内部管理用
            'timestamp': datetime.now().isoformat()
        }
        data['messages'].append(message)
        logger.info(f"[Session] メッセージ追加: role={message['role']}, type={message_type}")
        return message

    def get_history_for_api(self):
        """SDKにそのまま渡せる形式のリストを返す(types.Contentオブジェクトのリスト)"""
        data = self.get_data()
        if not data:
            return []
        
        # 【重要】辞書ではなくtypes.Contentオブジェクトを作成
        history = []
        for m in data['messages']:
            if m['type'] == 'chat':
                # types.Contentオブジェクトを作成
                content = types.Content(
                    role=m['role'],
                    parts=[types.Part(text=m['parts'][0])]  # partsは文字列のリストなので最初の要素を取得
                )
                history.append(content)
        
        logger.info(f"[Session] API用履歴生成: {len(history)}件のメッセージ")
        return history

    def get_messages(self, include_types=None):
        """メッセージ履歴を取得(互換性のため残す)"""
        data = self.get_data()
        if not data:
            return []

        messages = data.get('messages', [])

        if include_types:
            messages = [m for m in messages if m.get('type') in include_types]

        return messages

    def save_current_shops(self, shops):
        """現在の店舗リストを保存"""
        data = self.get_data()
        if data:
            data['current_shops'] = shops
            logger.info(f"[Session] 店舗リスト保存: {len(shops)}件")

    def get_current_shops(self):
        """現在の店舗リストを取得"""
        data = self.get_data()
        return data.get('current_shops', []) if data else []

    # ---- 確定店の共有（R1.4 §7）。ロックの中では外部 API を呼ばない ----

    def begin_search(self):
        """search_seq を 1 増やして返す。セッションがなければ None"""
        with _SHOPS_LOCK:
            data = self.get_data()
            if not data:
                return None
            data['search_seq'] = data.get('search_seq', 0) + 1
            logger.info(f"[Session] 検索開始: seq={data['search_seq']}")
            return data['search_seq']

    def commit_shops(self, seq, shops, origin='text'):
        """
        seq が最新なら current_shops を置き換えて shops_version を 1 増やし、版を返す。
        最新でなければ None（superseded）。セッションがなければ False。
        キーボードで確定した店の印は「画面に表示済み・音声では未紹介」、音声は「未開始」。
        """
        with _SHOPS_LOCK:
            data = self.get_data()
            if not data:
                return False
            if seq != data.get('search_seq'):
                logger.info(f"[Session] superseded: seq={seq}, 最新={data.get('search_seq')}")
                return None
            data['current_shops'] = shops
            data['shops_version'] = data.get('shops_version', 0) + 1
            mark = 'screen_only' if origin == 'text' else 'not_started'
            data['intro_marks'] = {s['order']: mark for s in shops}
            logger.info(f"[Session] 確定: seq={seq}, 版={data['shops_version']}, {len(shops)}店, origin={origin}")
            return data['shops_version']

    def get_shops_state(self):
        """(確定店, 版, 紹介の印) を返す。セッションがなければ None"""
        with _SHOPS_LOCK:
            data = self.get_data()
            if not data:
                return None
            return (list(data.get('current_shops', [])), data.get('shops_version', 0),
                    dict(data.get('intro_marks', {})))

    def set_intro_mark(self, version, order, mark):
        """紹介の印を 1 つ書く。版が変わっていれば書かない（古い紹介の記録で新しい店を汚さない）"""
        with _SHOPS_LOCK:
            data = self.get_data()
            if not data or data.get('shops_version') != version:
                return False
            if order in data.get('intro_marks', {}):
                data['intro_marks'][order] = mark
                return True
            return False

    def update_status(self, status, **kwargs):
        """ステータス更新"""
        data = self.get_data()
        if data:
            data['status'] = status
            data.update(kwargs)
            logger.info(f"[Session] ステータス更新: {status}")

    def get_data(self):
        """セッションデータ取得"""
        return _SESSION_CACHE.get(self.session_id)

    def get_language(self):
        """セッション言語を取得"""
        data = self.get_data()
        return data.get('language', 'ja') if data else 'ja'

    def get_mode(self):
        """セッションモードを取得"""
        data = self.get_data()
        return data.get('mode', 'chat') if data else 'chat'

    def update_language(self, language: str):
        """セッション言語を更新"""
        data = self.get_data()
        if data:
            data['language'] = language
            logger.info(f"[Session] 言語更新: {language}")

    def update_mode(self, mode: str):
        """セッションモードを更新"""
        data = self.get_data()
        if data:
            data['mode'] = mode
            logger.info(f"[Session] モード更新: {mode}")


class SupportAssistant:
    """サポートアシスタント - モード対応版"""

    def __init__(self, session: SupportSession, system_prompts: dict):
        self.session = session
        self.language = session.get_language()
        self.mode = session.get_mode()  # ★ モードを取得

        # ★★★ モードに応じたプロンプトを選択 ★★★
        mode_prompts = system_prompts.get(self.mode, SYSTEM_PROMPTS.get('chat', {}))
        self.system_prompt = mode_prompts.get(self.language, mode_prompts.get('ja', ''))

        # ★★★ 長期記憶のコンテキストをシステムプロンプトに追加（concierge/lessonモード） ★★★
        session_data = session.get_data()
        if self.mode == 'concierge' and session_data:
            is_first_visit = session_data.get('is_first_visit', True)
            profile = session_data.get('long_term_profile', {})

            if is_first_visit:
                # 初回訪問時は、名前登録の指示を追加
                first_visit_context = """
【重要: 初回訪問ユーザー】
このユーザーは初めての訪問です。
- ユーザーが名前を教えてくれたら、必ず action フィールドを使って名前を登録してください
- action形式: {"type": "update_user_profile", "updates": {"preferred_name": "名前", "name_honorific": "様"}}
- 敬称はユーザーの希望がなければデフォルトで「様」を使用
- ユーザーが名前を教えたくない場合は、名前なしで会話を続けてください
"""
                self.system_prompt = f"{self.system_prompt}\n\n{first_visit_context}"
                logger.info(f"[Assistant] 初回訪問コンテキストを注入")
            elif profile:
                # リピーター: プロファイル情報をコンテキストに注入
                preferred_name = profile.get('preferred_name', '')
                name_honorific = profile.get('name_honorific', '')
                visit_count = profile.get('visit_count', 1)

                if preferred_name:
                    user_context = f"""
【ユーザー情報】
- 呼び方: {preferred_name}{name_honorific}
- 訪問回数: {visit_count}回目
"""
                else:
                    # 名前未登録のリピーター
                    user_context = f"""
【ユーザー情報】
- 名前: 未登録（名前での呼びかけはしないでください）
- 訪問回数: {visit_count}回目
"""
                self.system_prompt = f"{self.system_prompt}\n\n{user_context}"
                logger.info(f"[Assistant] ユーザーコンテキストを注入（リピーター）")

        # ★★★ レッスンモード: ユーザー情報をプロンプトに注入 ★★★
        if self.mode == 'lesson' and session_data:
            is_first_visit = session_data.get('is_first_visit', True)
            profile = session_data.get('long_term_profile', {})

            if is_first_visit:
                lesson_context = """
【重要: 初回レッスンユーザー】
このユーザーは初めてのレッスンです。
- まず自己紹介をして、名前を聞いてください
- ユーザーが名前を教えてくれたら、必ず action フィールドで保存してください
- action形式: {"type": "update_user_profile", "updates": {"preferred_name": "名前", "name_honorific": "さん"}}
"""
                self.system_prompt = f"{self.system_prompt}\n\n{lesson_context}"
                logger.info(f"[Assistant] レッスンモード: 初回ユーザーコンテキスト注入")
            elif profile:
                preferred_name = profile.get('preferred_name', '')
                name_honorific = profile.get('name_honorific', 'さん')
                teacher_name = profile.get('lesson_teacher_name', 'Lisa')

                if preferred_name:
                    lesson_context = f"""
【ユーザー情報】
- 呼び方: {preferred_name}{name_honorific}
- AI講師名: {teacher_name}
"""
                else:
                    lesson_context = f"""
【ユーザー情報】
- 名前: 未登録（まず名前を聞いてください）
- AI講師名: {teacher_name}
"""
                self.system_prompt = f"{self.system_prompt}\n\n{lesson_context}"
                logger.info(f"[Assistant] レッスンモード: ユーザーコンテキスト注入（リピーター）")

        # ★★★ JSON形式の強制ルール（ハードコード） ★★★
        # GCSプロンプトに依存せず、PY側でショップ情報返却時のJSON形式を強制する
        json_enforcement = """

【絶対遵守: レスポンス形式ルール】
■ 通常の会話（挨拶、質問、雑談、確認など）:
  → 必ず「平文（プレーンテキスト）」でフレンドリーに返答すること。
  → JSONで返してはいけない。

■ ショップ・レストラン情報を提案する場合のみ:
  → 必ず以下のJSON形式で返すこと。例外は認めない。
  {
    "message": "お客様への返答メッセージ（フレンドリーな平文）",
    "shops": [
      {
        "name": "店名",
        "area": "エリア",
        "genre": "ジャンル",
        "budget": "予算帯",
        "description": "お店の説明",
        "specialty": "おすすめポイント",
        "atmosphere": "雰囲気",
        "features": "特徴"
      }
    ]
  }
  → shopsが空の場合でも、ショップ検索を行った結果なければ "shops": [] とすること。
  → message内は平文（JSONではない）で、親しみやすく書くこと。

■ アクション（名前登録など）がある場合:
  → JSON形式で返し、"action" フィールドを追加すること。
  {
    "message": "返答メッセージ",
    "shops": [],
    "action": {"type": "update_user_profile", "updates": {"preferred_name": "名前", "name_honorific": "様"}}
  }

この形式ルールはシステムプロンプトより優先される。絶対に守ること。
"""
        self.system_prompt = f"{self.system_prompt}\n{json_enforcement}"

        logger.info(f"[Assistant] 初期化: mode={self.mode}, language={self.language}, JSON強制ルール注入済み")

    def get_initial_message(self):
        """初回メッセージ - モード別 + 初回訪問判定（コンシェルジュモードのみ）"""
        session_data = self.session.get_data()

        # 通常の挨拶（デフォルト）
        greetings = INITIAL_GREETINGS.get(self.mode, INITIAL_GREETINGS.get('chat', {}))
        base_greeting = greetings.get(self.language, greetings.get('ja', ''))

        # チャットモードは常にシンプルな挨拶のみ
        if self.mode not in ('concierge', 'lesson'):
            logger.info(f"[Assistant] チャットモード: シンプルな挨拶")
            return base_greeting

        # ========================================
        # 以下はコンシェルジュ/レッスンモード（パーソナライズ対応）
        # ========================================

        # レッスンモードの初期メッセージ
        if self.mode == 'lesson':
            is_first_visit = session_data.get('is_first_visit', True) if session_data else True
            profile = session_data.get('long_term_profile', {}) if session_data else {}
            teacher_name = profile.get('lesson_teacher_name', 'Lisa') if profile else 'Lisa'

            if is_first_visit:
                first_lesson_greetings = {
                    'ja': f'Hello! I\'m {teacher_name}, your English conversation coach.\nこんにちは！{teacher_name}です。英会話レッスンを担当します。\nお名前を教えてください。',
                    'en': f'Hello! I\'m {teacher_name}, your English conversation coach.\nMay I ask your name?',
                    'zh': f'Hello! I\'m {teacher_name}, your English conversation coach.\n你好！我是{teacher_name}，你的英语会话教练。\n请问你叫什么名字？',
                    'ko': f'Hello! I\'m {teacher_name}, your English conversation coach.\n안녕하세요! {teacher_name}입니다. 영어 회화 코치를 맡고 있습니다.\n이름을 알려주시겠어요?'
                }
                return first_lesson_greetings.get(self.language, first_lesson_greetings['ja'])

            preferred_name = profile.get('preferred_name', '') if profile else ''
            name_honorific = profile.get('name_honorific', 'さん') if profile else 'さん'

            if preferred_name:
                returning_lesson_greetings = {
                    'ja': f'Hi {preferred_name}! It\'s {teacher_name}.\n{preferred_name}{name_honorific}、こんにちは！{teacher_name}です。\n今日はどんな練習をしましょうか？',
                    'en': f'Hi {preferred_name}! It\'s {teacher_name}.\nWhat would you like to practice today?',
                    'zh': f'Hi {preferred_name}! It\'s {teacher_name}.\n{preferred_name}，你好！我是{teacher_name}。\n今天想练习什么？',
                    'ko': f'Hi {preferred_name}! It\'s {teacher_name}.\n{preferred_name}{name_honorific}, 안녕하세요! {teacher_name}입니다.\n오늘은 어떤 연습을 할까요?'
                }
                return returning_lesson_greetings.get(self.language, returning_lesson_greetings['ja'])

            return base_greeting

        is_first_visit = session_data.get('is_first_visit', True) if session_data else True

        # デバッグログ
        logger.info(f"[Assistant] コンシェルジュモード: is_first_visit={is_first_visit}")
        if session_data:
            profile = session_data.get('long_term_profile', {})
            logger.info(f"[Assistant] Profile: {profile}")

        # 初回訪問の場合、名前を聞く
        if is_first_visit:
            first_visit_greetings = {
                'ja': '初めまして、AIコンシェルジュです。\n宜しければ、あなたを何とお呼びすればいいか、教えて頂けますか？',
                'en': 'Nice to meet you! I am your AI Concierge.\nMay I ask what I should call you?',
                'zh': '$60A8好！我是AI礼$5BBE$5458。\n$8BF7$95EE我$5E94$8BE5怎$4E48称呼$60A8？',
                'ko': '$CC98$C74C $BD59$ACA0$C2B5$B2C8$B2E4! AI $CEE8$C2DC$C5B4$C9C0$C785$B2C8$B2E4.\n$C5B4$B5BB$AC8C $BD88$B7EC$B4DC$B9AC$BA74 $B420$AE4C$C694?'
            }
            return first_visit_greetings.get(self.language, first_visit_greetings['ja'])

        # 2回目以降は、名前を呼びかけてから質問
        profile = session_data.get('long_term_profile', {}) if session_data else {}
        preferred_name = profile.get('preferred_name', '') if profile else ''
        name_honorific = profile.get('name_honorific', '') if profile else ''

        # 質問部分（共通）
        question_part = {
            'ja': '今日はどのようなシーンでお店をお探しでしょうか？接待、デート、女子会など、お気軽にお聞かせください。',
            'en': 'What kind of dining experience are you looking for today? Business dinner, date, gathering with friends?',
            'zh': '今天$60A8想$5BFB找什$4E48$6837的用餐$573A景？商$52A1宴$8BF7、$7EA6会、朋友聚会？',
            'ko': '$C624$B298$C740 $C5B4$B5A4 $C2DD$C0AC $C7A5$BA74$C744 $CC3E$C73C$C2DC$B098$C694? $C811$B300, $B370$C774$D2B8, $BAA8$C784 $B4F1?'
        }
        question = question_part.get(self.language, question_part['ja'])

        # 名前がある場合、個別挨拶に変更
        if preferred_name:
            personalized_greetings = {
                'ja': f'お帰りなさいませ、{preferred_name}{name_honorific}。\n{question}',
                'en': f'Welcome back, {preferred_name}{name_honorific}!\n{question}',
                'zh': f'$6B22迎回来，{preferred_name}{name_honorific}！\n{question}',
                'ko': f'$B2E4$C2DC $C624$C2E0 $AC83$C744 $D658$C601$D569$B2C8$B2E4, {preferred_name}{name_honorific}!\n{question}'
            }
            return personalized_greetings.get(self.language, personalized_greetings['ja'])

        # 名前未登録のリピーター: シンプルな挨拶（名前呼びなし）
        nameless_greetings = {
            'ja': f'いらっしゃいませ。\n{question}',
            'en': f'Welcome!\n{question}',
            'zh': f'$6B22迎光$4E34！\n{question}',
            'ko': f'$C5B4$C11C$C624$C138$C694!\n{question}'
        }
        return nameless_greetings.get(self.language, nameless_greetings['ja'])

    def is_followup_question(self, user_message, current_shops):
        """深掘り質問かどうかを判定"""
        if not current_shops:
            return False

        # フォローアップ質問のパターン(料理名は除外 - 初回検索で誤判定されるため)
        followup_patterns = [
            'この中で', 'これらの中で', 'さっきの', '先ほどの',
            'どれが', 'どこが', 'どの店', '何番目',
            '予約', '電話番号', '営業時間', 'アクセス',
            '詳しく', 'もっと', 'について'
        ]

        message_lower = user_message.lower()
        return any(pattern in message_lower for pattern in followup_patterns)

    def process_user_message(self, user_message, conversation_stage='conversation'):
        """
        ユーザーメッセージを処理
        
        【重要】改善されたフロー:
        1. 履歴を構造化リストで取得
        2. 履歴には既に最新のユーザーメッセージが含まれている(add_message$00E3$0081§$00E8$00BF$00BD$00E5$0160 $00E6$00B8$02C6$00E3$0081$00BF$00EF$00BC‰
        3. そのため、履歴をそのままGeminiに渡す
        """
        # 履歴を構造化リストで取得(既に最新のユーザーメッセージを含む)
        history = self.session.get_history_for_api()
        current_shops = self.session.get_current_shops()

        is_followup = self.is_followup_question(user_message, current_shops)

        # フォローアップの場合は現在の店舗情報をシステムプロンプトに追加
        system_prompt = self.system_prompt
        if is_followup and current_shops:
            followup_messages = {
                'ja': {
                    'header': '【現在提案中の店舗情報】',
                    'footer': 'ユーザーは上記の店舗について質問しています。店舗情報を参照して回答してください。'
                },
                'en': {
                    'header': '【Currently Proposed Restaurants】',
                    'footer': 'The user is asking about the restaurants listed above. Please refer to the restaurant information when answering.'
                },
                'zh': {
                    'header': '【当前推荐的餐$5385信息】',
                    'footer': '用$6237正在$8BE2$95EE上述餐$5385的信息。$8BF7参考餐$5385信息$8FDB行回答。'
                },
                'ko': {
                    'header': '【$D604$C7AC $C81C$C548 $C911$C778 $B808$C2A4$D1A0$B791 $C815$BCF4】',
                    'footer': '$C0AC$C6A9$C790$B294 $C704 $B808$C2A4$D1A0$B791$C5D0 $B300$D574 $C9C8$BB38$D558$ACE0 $C788$C2B5$B2C8$B2E4. $B808$C2A4$D1A0$B791 $C815$BCF4$B97C $CC38$C870$D558$C5EC $B2F5$BCC0$D558$C138$C694.'
                }
            }
            shop_context = f"\n\n{current_followup_msg['header']}\n{self._format_current_shops(current_shops)}\n\n{current_followup_msg['footer']}"
            system_prompt = self.system_prompt + shop_context
            logger.info("[Assistant] フォローアップ質問モード: 店舗情報をシステムプロンプトに追加")

        # ツール設定
        tools = None
        if not is_followup:
            tools = [types.Tool(google_search=types.GoogleSearch())]
            logger.info("[Assistant] Google検索グラウンディングを有効化")

        try:
            logger.info(f"[Assistant] Gemini API呼び出し開始: 履歴={len(history)}件")

            # ---------------------------------------------------------
            # 【修正箇所】ここを書き換えてください
            # ---------------------------------------------------------
            # 【重要】configパラメータの設定
            # Google検索(tools)を使う場合は、response_mime_type="application/json" を
            # 指定してはいけません（400エラーの原因になります）。
            config = types.GenerateContentConfig(
                system_instruction=system_prompt if system_prompt else None,
                tools=tools if tools else None,
                # response_mime_type="application/json"  # ← ★必ずコメントアウト（先頭に # をつける）
            )

            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=history,
                config=config
            )
            # ---------------------------------------------------------

            logger.info("[Assistant] Gemini API呼び出し完了")

            # レスポンスからテキストを取得
            assistant_text = response.text

            if not assistant_text:
                logger.error("[Assistant] Empty response from Gemini")
                raise RuntimeError("Gemini returned empty response")

            logger.info(f"[Assistant] Gemini response received: {len(assistant_text)} chars")


            # 【デバッグ】エンコーディング確認用ログ
            logger.info(f"[DEBUG] Response encoding type: {type(assistant_text)}")
            logger.info(f"[DEBUG] Response first 200 chars: {repr(assistant_text[:200])}")

            # UTF-8として正しくエンコードされているか確認
            try:
                test_encode = assistant_text.encode('utf-8')
                logger.info(f"[DEBUG] UTF-8 encoding test: OK ({len(test_encode)} bytes)")
            except Exception as e:
                logger.error(f"[DEBUG] UTF-8 encoding test: FAILED - {e}")
            parsed_message, parsed_shops, parsed_action = self._parse_json_response(assistant_text)

            if parsed_shops:
                self.session.save_current_shops(parsed_shops)

            summary = None
            if conversation_stage == 'conversation':
                if parsed_shops:
                    summary_messages = {
                        'ja': lambda count: f"{count}軒のお店を提案しました。",
                        'en': lambda count: f"Suggested {count} restaurants.",
                        'zh': lambda count: f"推荐了{count}家餐$5385。",
                        'ko': lambda count: f"{count}$AC1C$C758 $B808$C2A4$D1A0$B791$C744 $C81C$C548$D588$C2B5$B2C8$B2E4."
                    }
                    summary_func = summary_messages.get(self.language, summary_messages['ja'])
                    summary = summary_func(len(parsed_shops))
                else:
                    summary = self._generate_summary(user_message, parsed_message)

            return {
                'response': parsed_message,
                'summary': summary,
                'shops': parsed_shops,
                'should_confirm': conversation_stage == 'conversation',
                'is_followup': is_followup,
                'action': parsed_action
            }

        except Exception as e:
            logger.error(f"[Assistant] Gemini API error: {e}", exc_info=True)
            error_messages = {
                'ja': 'エラーが発生しました。もう一度お試しください。',
                'en': 'An error occurred. Please try again.',
                'zh': '発生錯誤。請重試。',
                'ko': '$C624$B958$AC00 $BC1C$C0DD$D588$C2B5$B2C8$B2E4. $B2E4$C2DC $C2DC$B3C4$D574$C8FC$C138$C694.'
            }
            return {
                'response': error_messages.get(self.language, error_messages['ja']),
                'summary': None,
                'shops': [],
                'should_confirm': False,
                'is_followup': False
            }

    # ---- コンシェルジュ（R1.4 §5。mode が concierge のときだけ /api/chat から呼ぶ） ----

    def _concierge_user_context(self) -> str:
        """v11 の {user_context}。現行の REST と同じく SupportSession のプロフィールから作る"""
        session_data = self.session.get_data() or {}
        if session_data.get('is_first_visit', True):
            return """【重要: 初回訪問ユーザー】
このユーザーは初めての訪問です。
- ユーザーが名前を教えてくれたら、必ず action フィールドを使って名前を登録してください
- 敬称はユーザーの希望がなければデフォルトで「様」を使用
- ユーザーが名前を教えたくない場合は、名前なしで会話を続けてください"""
        profile = session_data.get('long_term_profile') or {}
        preferred_name = profile.get('preferred_name', '')
        visit_count = profile.get('visit_count', 1)
        if preferred_name:
            return f"""【ユーザー情報】
- 呼び方: {preferred_name}{profile.get('name_honorific', '')}
- 訪問回数: {visit_count}回目"""
        return f"""【ユーザー情報】
- 名前: 未登録（名前での呼びかけはしないでください）
- 訪問回数: {visit_count}回目"""

    def _concierge_system_prompt(self) -> str:
        """C1 のプロンプト：v11 + REST 用の規則 + SupportSession の確定店（会話用の項目だけ）"""
        v11 = CONCIERGE_V11[self.language].replace('{user_context}', self._concierge_user_context())
        state = self.session.get_shops_state() or ([], 0, {})
        shops_text = format_concierge_shops_for_llm(state[0], state[1], self.language)
        return f"{v11}\n{CONCIERGE_REST_RULES}\n【現在の確定店】\n{shops_text}\n"

    def _call_concierge_c1(self):
        """C1 を 1 回呼ぶ。JSON として読めなければ None（自動のやり直しはしない）"""
        config = types.GenerateContentConfig(
            system_instruction=self._concierge_system_prompt(),
            response_mime_type='application/json',
            response_json_schema=CONCIERGE_C1_SCHEMA,
            http_options=types.HttpOptions(timeout=CONCIERGE_LLM_TIMEOUT_MS),
        )
        try:
            response = gemini_client.models.generate_content(
                model=CONCIERGE_C1_MODEL,
                contents=self.session.get_history_for_api(),
                config=config,
            )
            data = json.loads(response.text or '')
        except Exception as e:
            logger.error(f"[Concierge] C1 失敗: {type(e).__name__}")
            return None
        if not isinstance(data, dict) or not isinstance(data.get('message'), str):
            logger.error("[Concierge] C1 の JSON に message がない")
            return None
        return data

    def _generate_concierge_summary(self, user_message, assistant_response):
        """C2：現行と同じ要約のテンプレートを、安いモデルで呼ぶ"""
        template = CONVERSATION_SUMMARY_TEMPLATES.get(self.language, CONVERSATION_SUMMARY_TEMPLATES['ja'])
        try:
            response = gemini_client.models.generate_content(
                model=CONCIERGE_C2_MODEL,
                contents=template.format(user_message=user_message, assistant_response=assistant_response),
            )
            return response.text
        except Exception as e:
            logger.error(f"[Concierge] C2 失敗: {type(e).__name__}")
            return None

    def process_concierge_message(self, user_message, conversation_stage='conversation', on_action=None):
        """
        キーボードのコンシェルジュ会話（R1.4 §5.3）。
        1. C1 を呼ぶ。2. action があれば on_action で名前登録（推薦より先。失敗しても推薦は続ける）。
        3. shop_request があれば recommend_shops(origin='text') を 1 回呼び、5 店なら commit_shops。
           返答の文章は結果の状態ごとにサーバーが作り、要約は固定文（要約の LLM は呼ばない）。
        4. shop_request がなければ message をそのまま使い、現行と同じ条件で要約を C2 で作る。
        戻り値の record が False のときは、返答を履歴に記録しない（C1 の出力が読めなかったとき）。
        """
        lang = self.language
        if lang not in CONCIERGE_V11:
            return {'record': False, 'response': concierge_text(lang, 'unsupported_language'),
                    'summary': None, 'shops': [], 'outcome': None}

        c1 = self._call_concierge_c1()
        if c1 is None:
            return {'record': False, 'response': CONCIERGE_ERROR_TEXTS.get(lang, CONCIERGE_ERROR_TEXTS['ja']),
                    'summary': None, 'shops': [], 'outcome': None}

        action = c1.get('action')
        if isinstance(action, dict) and action.get('type') == 'update_user_profile' and on_action:
            try:
                on_action(action)
            except Exception as e:
                logger.error(f"[Concierge] 名前登録の例外: {type(e).__name__}")

        shop_request = c1.get('shop_request') if isinstance(c1.get('shop_request'), dict) else None
        user_request = (shop_request or {}).get('user_request', '').strip()
        if not user_request:
            message = c1['message']
            summary = None
            if conversation_stage == 'conversation':
                summary = self._generate_concierge_summary(user_message, message)
            return {'record': True, 'response': message, 'summary': summary, 'shops': [], 'outcome': None}

        from concierge_recommender import recommend_shops
        seq = self.session.begin_search()
        result = recommend_shops(user_request, lang, 'text', gemini_client)
        status = result['status']
        version = None
        if status == 'complete':
            version = self.session.commit_shops(seq, result['shops'], origin='text')
            if version is None:
                status = 'superseded'
        if version is None:
            state = self.session.get_shops_state()
            version = state[1] if state else 0
        outcome_for_text = dict(result, status=status)
        response = build_concierge_reply(lang, outcome_for_text)
        complete = status == 'complete'
        return {
            'record': True,
            'response': response,
            'summary': concierge_text(lang, 'summary') if complete else None,
            'shops': result['cards'] if complete else [],
            'shop_names': [s['name'] for s in result['shops']] if complete else [],
            'user_request': user_request,
            'outcome': {
                'session_id': self.session.session_id,
                'search_seq': seq,
                'status': status,
                'reason_code': result.get('reason_code') if status != 'superseded' else None,
                'source': result.get('source'),
                'shops_version': version,
                'found_count': result.get('found_count', 0),
            },
        }

    def generate_final_summary(self):
        """最終要約を生成"""
        all_messages = self.session.get_history_for_api()
        
        # 会話テキストを整形
        # 【重要】all_messagesはtypes.Contentオブジェクトのリスト
        conversation_lines = []
        for msg in all_messages:
            role_name = 'ユーザー' if msg.role == 'user' else 'アシスタント'
            # msg.partsはtypes.Partオブジェクトのリストなので、最初の要素のtextを取得
            conversation_lines.append(f"{role_name}: {msg.parts[0].text}")
        conversation_text = '\n'.join(conversation_lines)

        template = FINAL_SUMMARY_TEMPLATES.get(self.language, FINAL_SUMMARY_TEMPLATES['ja'])
        summary_prompt = template.format(
            conversation_text=conversation_text,
            timestamp=datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        )

        try:
            logger.info("[Assistant] Generating final summary")
            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=summary_prompt
            )
            summary = response.text

            self.session.update_status(
                'completed',
                inquiry_summary=summary
            )

            return summary

        except Exception as e:
            logger.error(f"[Assistant] Final summary error: {e}", exc_info=True)
            return "要約の生成中にエラーが発生しました。"

    def _format_current_shops(self, shops):
        """店舗情報を整形してプロンプトに追加"""
        # 多言語ラベル
        shop_labels = {
            'ja': {
                'description': '説明',
                'specialty': '看板メニュー',
                'price': '予算',
                'atmosphere': '雰囲気',
                'features': '特色'
            },
            'en': {
                'description': 'Description',
                'specialty': 'Specialty',
                'price': 'Price Range',
                'atmosphere': 'Atmosphere',
                'features': 'Features'
            },
            'zh': {
                'description': '$8BF4明',
                'specialty': '招牌菜',
                'price': '$9884算',
                'atmosphere': '氛$56F4',
                'features': '特色'
            },
            'ko': {
                'description': '$C124$BA85',
                'specialty': '$B300$D45C $BA54$B274',
                'price': '$C608$C0B0',
                'atmosphere': '$BD84$C704$AE30',
                'features': '$D2B9$C9D5'
            }
        }

        current_shop_labels = shop_labels.get(self.language, shop_labels['ja'])
        lines = []
        for i, shop in enumerate(shops, 1):
            lines.append(f"{i}. {shop.get('name', '')} ({shop.get('area', '')})")
            lines.append(f"   - {current_shop_labels['description']}: {shop.get('description', '')}")
            if shop.get('specialty'):
                lines.append(f"   - {current_shop_labels['specialty']}: {shop.get('specialty')}")
            if shop.get('price_range'):
                lines.append(f"   - {current_shop_labels['price']}: {shop.get('price_range')}")
            if shop.get('atmosphere'):
                lines.append(f"   - {current_shop_labels['atmosphere']}: {shop.get('atmosphere')}")
            if shop.get('features'):
                lines.append(f"   - {current_shop_labels['features']}: {shop.get('features')}")
            lines.append("")
        return "\n".join(lines)

    def _parse_json_response(self, text: str) -> tuple:
        """JSONレスポンスをパース - 最初のJSONオブジェクトのみ抽出"""
        try:
            # 【重要】最初の { から 対応する } までを抽出
            # 入れ子のJSONに対応するため、ブレースのカウントを行う
            start_idx = text.find('{')
            if start_idx == -1:
                logger.warning("[JSON Parse] JSON形式が見つかりません")
                shops = extract_shops_from_response(text)
                return text, shops, None

            # ブレースのカウントで対応する閉じブレースを見つける
            brace_count = 0
            end_idx = -1
            for i in range(start_idx, len(text)):
                if text[i] == '{':
                    brace_count += 1
                elif text[i] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end_idx = i + 1
                        break

            if end_idx == -1:
                logger.warning("[JSON Parse] JSONの閉じブレースが見つかりません")
                shops = extract_shops_from_response(text)
                return text, shops, None

            json_str = text[start_idx:end_idx].strip()
            logger.info(f"[JSON Parse] JSONオブジェクトを検出: {len(json_str)}文字")

            data = json.loads(json_str)

            message = data.get('message', text)
            shops = data.get('shops', [])
            action = data.get('action', None)

            logger.info(f"[JSON Parse] 成功: message={len(message)}文字, shops={len(shops)}件, action={action is not None}")
            return message, shops, action

        except json.JSONDecodeError as e:
            logger.warning(f"[JSON Parse] パース失敗: {e}")
            shops = extract_shops_from_response(text)
            return text, shops, None

    def _generate_summary(self, user_message, assistant_response):
        """会話の要約を生成"""
        template = CONVERSATION_SUMMARY_TEMPLATES.get(self.language, CONVERSATION_SUMMARY_TEMPLATES['ja'])
        summary_prompt = template.format(
            user_message=user_message,
            assistant_response=assistant_response
        )

        try:
            logger.info("[Assistant] Generating summary")
            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=summary_prompt
            )
            return response.text

        except Exception as e:
            logger.error(f"[Assistant] Summary generation error: {e}", exc_info=True)
            return None


# ========================================
# API エンドポイント
# ========================================


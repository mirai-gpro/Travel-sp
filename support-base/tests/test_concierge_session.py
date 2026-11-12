"""
SupportSession の確定店の共有と、キーボードのコンシェルジュ会話（C1）の決定的テスト（外部 API は呼ばない）

実行: cd support-base && python -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('GEMINI_API_KEY', 'dummy')
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # prompts/ を読むため

import concierge_recommender  # noqa: E402
import support_core as sc  # noqa: E402


def item(order, name):
    return {'order': order, 'name': name, 'area': '恵比寿', 'genre': '焼き鳥', 'specialty': 'つくね',
            'atmosphere': '落ち着いた', 'price_estimate': '6,000円', 'reason': f'{name}の理由。',
            'fit': [], 'source': 'knowledge', 'place_id': f'P{order}'}


FIVE = [item(i, f'店{i}') for i in range(1, 6)]


def complete_result():
    return {'status': 'complete', 'reason_code': None, 'source': 'knowledge', 'found_count': 5,
            'shops': FIVE, 'cards': [{'name': s['name'], 'place_id': s['place_id']} for s in FIVE]}


def new_session(language='ja'):
    s = sc.SupportSession()
    s.initialize({}, language=language, mode='concierge')
    s.add_message('model', 'いらっしゃいませ', 'chat')
    return s


class FakeModels:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def generate_content(self, model, contents, config=None):
        self.calls.append({'model': model, 'contents': contents, 'config': config})
        r = self.replies.pop(0)
        return mock.Mock(text=r if isinstance(r, str) else json.dumps(r, ensure_ascii=False))


class TestSessionShops(unittest.TestCase):
    def test_latest_search_only(self):
        s = new_session()
        seq1 = s.begin_search()
        seq2 = s.begin_search()
        self.assertEqual((seq1, seq2), (1, 2))
        self.assertIsNone(s.commit_shops(seq1, FIVE))           # 古い検索は superseded
        self.assertEqual(s.get_shops_state(), ([], 0, {}))
        self.assertEqual(s.commit_shops(seq2, FIVE, origin='text'), 1)
        shops, version, marks = s.get_shops_state()
        self.assertEqual((len(shops), version), (5, 1))
        self.assertEqual(set(marks.values()), {'screen_only'})  # キーボード：画面に表示済み・音声では未紹介

    def test_live_commit_marks_not_started(self):
        s = new_session()
        seq = s.begin_search()
        s.commit_shops(seq, FIVE, origin='live')
        self.assertEqual(set(s.get_shops_state()[2].values()), {'not_started'})

    def test_no_session(self):
        s = sc.SupportSession('missing')
        self.assertIsNone(s.begin_search())
        self.assertFalse(s.commit_shops(1, FIVE))
        self.assertIsNone(s.get_shops_state())

    def test_intro_mark_ignores_old_version(self):
        s = new_session()
        s.commit_shops(s.begin_search(), FIVE, origin='live')
        self.assertTrue(s.set_intro_mark(1, 1, 'done'))
        s.commit_shops(s.begin_search(), FIVE, origin='text')
        self.assertFalse(s.set_intro_mark(1, 2, 'done'))         # 版 1 の記録は版 2 に書かない
        self.assertEqual(s.get_shops_state()[2][2], 'screen_only')

    def test_llm_text_has_no_place_id(self):
        text = sc.format_concierge_shops_for_llm(FIVE, 3)
        self.assertIn('版 3', text)
        self.assertIn('店1', text)
        self.assertNotIn('P1', text)


class TestConciergeMessage(unittest.TestCase):
    def run_c1(self, session, replies, recommend=None, on_action=None, message='恵比寿で焼き鳥'):
        session.add_message('user', message, 'chat')
        fake = FakeModels(replies)
        rec = mock.Mock(side_effect=recommend or (lambda *a, **k: complete_result()))
        with mock.patch.object(sc, 'gemini_client', mock.Mock(models=fake)), \
                mock.patch.object(concierge_recommender, 'recommend_shops', rec):
            out = sc.SupportAssistant(session, sc.SYSTEM_PROMPTS).process_concierge_message(
                message, 'conversation', on_action=on_action)
        return out, fake, rec

    def test_plain_message_uses_c2_summary(self):
        s = new_session()
        out, fake, rec = self.run_c1(s, [{'message': 'エリアはどちらですか？'}, '要約'])
        self.assertEqual((out['response'], out['summary'], out['outcome']), ('エリアはどちらですか？', '要約', None))
        rec.assert_not_called()
        self.assertEqual([c['model'] for c in fake.calls], [sc.CONCIERGE_C1_MODEL, sc.CONCIERGE_C2_MODEL])
        self.assertIsNone(fake.calls[0]['config'].tools)  # C1 は検索なし

    def test_c1_prompt_has_v11_rules_and_confirmed_shops(self):
        s = new_session()
        s.commit_shops(s.begin_search(), FIVE, origin='live')
        _, fake, _ = self.run_c1(s, [{'message': 'はい'}, '要約'])
        prompt = fake.calls[0]['config'].system_instruction
        self.assertIn('お店探しの依頼', prompt)        # v11（R2.0 の本文）
        self.assertIn('文字の会話の規則', prompt)       # REST 用の規則
        self.assertIn('店3（恵比寿）', prompt)          # 確定店
        self.assertNotIn('{user_context}', prompt)

    def test_shop_request_complete_commits_and_builds_reply(self):
        s = new_session()
        out, fake, rec = self.run_c1(s, [{'message': 'お探しします', 'shop_request': {'user_request': '恵比寿 焼き鳥 接待'}}])
        rec.assert_called_once()
        self.assertEqual(rec.call_args[0][:3], ('恵比寿 焼き鳥 接待', 'ja', 'text'))
        self.assertEqual(len(fake.calls), 1)                       # 要約の LLM は呼ばない
        self.assertEqual(out['outcome']['status'], 'complete')
        self.assertEqual(out['outcome']['shops_version'], 1)
        self.assertEqual(out['summary'], '5軒のお店を提案しました。')
        self.assertIn('1. 店1（恵比寿）', out['response'])
        self.assertNotIn('お探しします', out['response'])          # 文章はサーバーが作る
        self.assertEqual(len(out['shops']), 5)
        self.assertEqual(s.get_shops_state()[1], 1)

    def test_not_found_keeps_previous_shops(self):
        s = new_session()
        s.commit_shops(s.begin_search(), FIVE, origin='live')
        nf = {'status': 'not_found', 'reason_code': 'too_few_verified', 'source': 'knowledge',
              'found_count': 3, 'shops': [], 'cards': []}
        out, _, _ = self.run_c1(s, [{'message': 'x', 'shop_request': {'user_request': '個室 焼肉'}}],
                                recommend=lambda *a, **k: nf)
        self.assertIn('3 軒', out['response'])
        self.assertEqual(out['shops'], [])
        self.assertEqual(out['outcome']['shops_version'], 1)       # 確定店は変わらない
        self.assertEqual(s.get_shops_state()[0][0]['name'], '店1')

    def test_superseded_when_newer_search_started(self):
        s = new_session()

        def racing(*a, **k):
            s.begin_search()          # 推薦の最中に音声で別の検索が始まった
            return complete_result()

        out, _, _ = self.run_c1(s, [{'message': 'x', 'shop_request': {'user_request': 'y'}}], recommend=racing)
        self.assertEqual(out['outcome']['status'], 'superseded')
        self.assertEqual(out['shops'], [])
        self.assertIn('新しい検索', out['response'])
        self.assertEqual(s.get_shops_state(), ([], 0, {}))

    def test_action_before_recommend_and_failure_does_not_stop(self):
        s = new_session()
        order = []

        def on_action(a):
            order.append('action')
            raise RuntimeError('db down')

        def rec(*a, **k):
            order.append('recommend')
            return complete_result()

        out, _, _ = self.run_c1(s, [{'message': 'x', 'action': {'type': 'update_user_profile',
                                                               'updates': {'preferred_name': '太郎'}},
                                     'shop_request': {'user_request': 'y'}}], recommend=rec, on_action=on_action)
        self.assertEqual(order, ['action', 'recommend'])
        self.assertEqual(out['outcome']['status'], 'complete')

    def test_c1_not_json_is_not_recorded(self):
        s = new_session()
        out, _, rec = self.run_c1(s, ['これは JSON ではない'])
        self.assertFalse(out['record'])
        self.assertEqual(out['response'], sc.CONCIERGE_ERROR_TEXTS['ja'])
        rec.assert_not_called()

    def test_language_without_v11(self):
        s = new_session('ko')
        out, fake, _ = self.run_c1(s, [])
        self.assertEqual(out['response'], sc.CONCIERGE_TEXTS['ko']['unsupported_language'])
        self.assertEqual(fake.calls, [])


class TestApiChat(unittest.TestCase):
    """/api/chat のコンシェルジュ分岐。chat モードは既存の処理を通る"""

    @classmethod
    def setUpClass(cls):
        # 起動時に作る TTS・STT クライアントは GCP の認証を要するので、読み込みの間だけ差し替える
        from google.cloud import speech, texttospeech
        with mock.patch.object(texttospeech, 'TextToSpeechClient'), mock.patch.object(speech, 'SpeechClient'):
            import app_customer_support as app_module
        cls.app_module = app_module
        cls.client = app_module.app.test_client()

    def test_concierge_branch_returns_outcome_and_records_once(self):
        s = new_session()
        fake = FakeModels([{'message': 'x', 'shop_request': {'user_request': 'y'}}])
        with mock.patch.object(sc, 'gemini_client', mock.Mock(models=fake)), \
                mock.patch.object(concierge_recommender, 'recommend_shops', return_value=complete_result()), \
                mock.patch.object(self.app_module, 'LONG_TERM_MEMORY_ENABLED', False), \
                mock.patch.object(sc.SupportAssistant, 'process_user_message') as legacy:
            r = self.client.post('/api/chat', json={'session_id': s.session_id, 'message': '恵比寿で焼き鳥',
                                                     'mode': 'concierge', 'language': 'ja'})
        legacy.assert_not_called()
        body = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body['outcome']['status'], 'complete')
        self.assertEqual(body['outcome']['session_id'], s.session_id)
        self.assertEqual(len(body['shops']), 5)
        chats = [m for m in s.get_messages(['chat']) if m['role'] == 'model']
        self.assertEqual(chats[-1]['parts'][0], body['response'])
        self.assertEqual(len(chats), 2)  # 初回あいさつ + 返答 1 回

    def test_chat_mode_uses_existing_path(self):
        s = sc.SupportSession()
        s.initialize({}, language='ja', mode='chat')
        legacy_result = {'response': 'ok', 'summary': None, 'shops': [], 'should_confirm': True, 'is_followup': False}
        with mock.patch.object(sc.SupportAssistant, 'process_user_message', return_value=legacy_result) as legacy, \
                mock.patch.object(sc.SupportAssistant, 'process_concierge_message') as concierge:
            r = self.client.post('/api/chat', json={'session_id': s.session_id, 'message': 'こんにちは',
                                                     'mode': 'chat', 'language': 'ja'})
        legacy.assert_called_once()
        concierge.assert_not_called()
        self.assertNotIn('outcome', r.get_json())


if __name__ == '__main__':
    unittest.main()

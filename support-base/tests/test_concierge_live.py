"""
Live のコンシェルジュ部分（FC・tool_response・紹介の記録・再開文・再接続の文脈）の決定的テスト
Gemini には接続しない。Socket.IO と Live のセッションは偽物を使う。

実行: cd support-base && python -m unittest discover -s tests -v
"""
import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('GEMINI_API_KEY', 'dummy')
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import live_api_handler as lah  # noqa: E402
import support_core as sc  # noqa: E402


def item(order, name):
    return {'order': order, 'name': name, 'area': '恵比寿', 'genre': '焼き鳥', 'specialty': 'つくね',
            'atmosphere': '落ち着いた', 'price_estimate': '6,000円', 'reason': f'{name}の理由。',
            'fit': [], 'source': 'knowledge', 'place_id': f'P{order}'}


FIVE = [item(i, f'店{i}') for i in range(1, 6)]


class FakeSocket:
    def __init__(self):
        self.events = []

    def emit(self, name, data=None, room=None):
        self.events.append((name, data))

    def named(self, name):
        return [d for n, d in self.events if n == name]


class FakeLive:
    def __init__(self):
        self.responses = []

    async def send_tool_response(self, function_responses):
        self.responses.extend(function_responses)


def fc(name, args=None, id_='c1'):
    return SimpleNamespace(name=name, args=args or {}, id=id_)


def new_store():
    s = sc.SupportSession()
    s.initialize({}, language='ja', mode='concierge')
    return s


def live(mode='concierge', store=None, callback=None, language='ja'):
    sock = FakeSocket()
    l = lah.LiveAPISession(session_id=store.session_id if store else 'sid', mode=mode, language=language,
                           system_prompt='PROMPT', socketio=sock, client_sid='c', shop_search_callback=callback,
                           shops_store=store)
    return l, sock


def complete_callback(store):
    def cb(user_request, lang, mode, seq):
        v = store.commit_shops(seq, FIVE, origin='live')
        return {'status': 'complete', 'reason_code': None, 'source': 'knowledge', 'found_count': 5,
                'shops': FIVE, 'cards': [{'name': s['name']} for s in FIVE], 'shops_version': v}
    return cb


class TestConfigAndPrompt(unittest.TestCase):
    def test_concierge_tools_include_get_current_shops(self):
        l, _ = live(store=new_store())
        names = [d.name for d in l._build_config()['tools'][0].function_declarations]
        self.assertEqual(names, ['search_shops', 'get_current_shops', 'update_user_profile'])
        self.assertEqual(lah.GET_CURRENT_SHOPS_DECLARATION.behavior, lah.types.Behavior.BLOCKING)

    def test_chat_tools_unchanged(self):
        l, _ = live(mode='chat')
        names = [d.name for d in l._build_config()['tools'][0].function_declarations]
        self.assertEqual(names, ['search_shops', 'update_user_profile'])

    def test_reconnect_instruction_has_latest_shops_and_marks(self):
        store = new_store()
        store.commit_shops(store.begin_search(), FIVE, origin='text')
        l, _ = live(store=store)
        self.assertEqual(l._build_config()['system_instruction'], 'PROMPT')   # 初回接続は変えない
        l.session_count = 2
        inst = l._build_config(with_context='')['system_instruction']
        self.assertIn('版 1', inst)
        self.assertIn('店3（恵比寿）', inst)
        self.assertIn('画面に表示済み・音声では未紹介', inst)
        self.assertNotIn('P3', inst)

    def test_build_system_instruction_appends_rules_only_for_concierge(self):
        prompts = {'concierge': {'ja': 'V11 {user_context}'}, 'chat': {'ja': 'CHAT'}}
        c = lah.build_system_instruction('concierge', None, prompts, 'ja')
        self.assertTrue(c.startswith('V11 '))
        self.assertIn('get_current_shops', c)
        self.assertIn('1軒目は、'.replace('1', 'N'), c)
        self.assertEqual(lah.build_system_instruction('chat', None, prompts, 'ja'), 'CHAT')


class TestToolCalls(unittest.TestCase):
    def test_search_complete(self):
        store = new_store()
        l, sock = live(store=store, callback=complete_callback(store))
        sess = FakeLive()
        asyncio.run(l._handle_tool_call(SimpleNamespace(function_calls=[fc('search_shops', {'user_request': 'x'})]), sess))
        self.assertEqual(sock.named('shop_search_start'), [{'search_seq': 1}])
        result = sock.named('shop_search_result')[0]
        self.assertEqual((result['status'], result['search_seq'], result['shops_version']), ('complete', 1, 1))
        self.assertEqual(result['session_id'], store.session_id)
        self.assertEqual(len(result['shops']), 5)
        payload = sess.responses[0].response
        self.assertNotIn('result', payload)                      # 指示文を入れない
        self.assertEqual(payload['status'], 'complete')
        self.assertEqual([s['mark'] for s in payload['shops']], ['not_started'] * 5)
        self.assertNotIn('place_id', payload['shops'][0])
        self.assertTrue(l._shop_intro_turn_pending)

    def test_second_search_in_same_call_is_busy(self):
        store = new_store()
        calls = []

        def cb(*a):
            calls.append(a)
            return complete_callback(store)(*a)

        l, _ = live(store=store, callback=cb)
        sess = FakeLive()
        asyncio.run(l._handle_tool_call(SimpleNamespace(function_calls=[
            fc('search_shops', {'user_request': 'a'}, 'c1'), fc('search_shops', {'user_request': 'b'}, 'c2')]), sess))
        self.assertEqual(len(calls), 1)
        self.assertEqual(sess.responses[1].response, {'status': 'busy'})

    def test_not_found_keeps_previous_shops_and_no_cards(self):
        store = new_store()
        store.commit_shops(store.begin_search(), FIVE, origin='text')

        def cb(user_request, lang, mode, seq):
            return {'status': 'not_found', 'reason_code': 'too_few_verified', 'source': 'knowledge',
                    'found_count': 2, 'shops': [], 'cards': [], 'shops_version': 1}

        l, sock = live(store=store, callback=cb)
        sess = FakeLive()
        asyncio.run(l._handle_tool_call(SimpleNamespace(function_calls=[fc('search_shops', {'user_request': 'x'})]), sess))
        self.assertEqual(sock.named('shop_search_result')[0]['shops'], [])
        payload = sess.responses[0].response
        self.assertEqual((payload['status'], payload['found_count']), ('not_found', 2))
        self.assertEqual(payload['shops'][0]['name'], '店1')      # その時点の確定店
        self.assertFalse(l._shop_intro_turn_pending)

    def test_callback_exception_is_error(self):
        store = new_store()

        def cb(*a):
            raise RuntimeError('boom')

        l, sock = live(store=store, callback=cb)
        sess = FakeLive()
        asyncio.run(l._handle_tool_call(SimpleNamespace(function_calls=[fc('search_shops', {'user_request': 'x'})]), sess))
        self.assertEqual(sock.named('shop_search_result')[0]['status'], 'error')
        self.assertEqual(sess.responses[0].response['status'], 'error')

    def test_get_current_shops(self):
        store = new_store()
        l, _ = live(store=store)
        sess = FakeLive()
        call = SimpleNamespace(function_calls=[fc('get_current_shops')])
        asyncio.run(l._handle_tool_call(call, sess))
        self.assertEqual(sess.responses[-1].response['status'], 'none')
        store.commit_shops(store.begin_search(), FIVE, origin='text')
        asyncio.run(l._handle_tool_call(call, sess))
        r = sess.responses[-1].response
        self.assertEqual((r['status'], r['shops_version'], r['shops'][0]['mark']), ('ok', 1, 'screen_only'))
        unavailable, _ = live(store=sc.SupportSession('missing'))
        asyncio.run(unavailable._handle_tool_call(call, sess))
        self.assertEqual(sess.responses[-1].response, {'status': 'unavailable'})


class TestIntroRecording(unittest.TestCase):
    def setUp(self):
        self.store = new_store()
        self.store.commit_shops(self.store.begin_search(), FIVE, origin='live')
        self.l, _ = live(store=self.store)
        self.l._shop_intro_turn_pending = True
        self.l._start_intro(1, 5)

    def marks(self):
        return self.store.get_shops_state()[2]

    def test_leads_mark_progress(self):
        for t in ['1軒目は、店1です。', '落ち着いた店です。2軒目', 'は、店2です。']:
            self.l._record_intro_text(t)
        self.assertEqual((self.marks()[1], self.marks()[2]), ('done', 'in_progress'))

    def test_shop_name_or_mid_sentence_number_does_not_count(self):
        self.l._record_intro_text('1軒目は、2軒目という名前の店です')
        self.assertEqual(self.marks()[2], 'not_started')

    def test_incomplete_turn_resumes_from_interrupted_shop(self):
        self.l._record_intro_text('1軒目は、店1です。2軒目は、店2です。3軒目は、店3で、')
        self.l.ai_transcript_buffer = '1軒目は、店1です。2軒目は、店2です。3軒目は、店3で、'
        self.l._process_turn_complete()
        self.assertTrue(self.l.needs_reconnect)
        self.assertEqual(self.l._resume_message, '3軒目のお店から紹介を続けてください。')
        self.assertEqual([self.marks()[i] for i in range(1, 6)],
                         ['done', 'done', 'interrupted', 'not_started', 'not_started'])

    def test_all_done(self):
        text = ''.join(f'{i}軒目は、店{i}です。' for i in range(1, 6)) + 'x' * 500
        self.l._record_intro_text(text)
        self.l.ai_transcript_buffer = text + '。'
        self.l._process_turn_complete()
        self.assertTrue(self.l.needs_reconnect)                  # 500 文字を超えた
        self.assertEqual(self.l._resume_message, lah.CONCIERGE_RESUME_TEXTS['ja']['done'])
        self.assertEqual(set(self.marks().values()), {'done'})

    def test_no_lead_is_unknown(self):
        self.l.ai_transcript_buffer = 'おすすめのお店を、'
        self.l._process_turn_complete()
        self.assertEqual(self.l._resume_message, lah.CONCIERGE_RESUME_TEXTS['ja']['unknown'])
        self.assertEqual(set(self.marks().values()), {'unknown'})

    def test_interrupt_marks_current_and_ends_tracking(self):
        self.l._record_intro_text('1軒目は、店1です。2軒目は')
        self.l._interrupt_intro()
        self.assertEqual((self.marks()[1], self.marks()[2]), ('done', 'interrupted'))
        self.assertIsNone(self.l._intro)
        self.assertFalse(self.l._shop_intro_turn_pending)

    def test_old_version_marks_not_written_after_new_commit(self):
        self.store.commit_shops(self.store.begin_search(), FIVE, origin='text')   # キーボードで版 2
        self.l._record_intro_text('1軒目は、店1です。')
        self.assertEqual(self.marks()[1], 'screen_only')


class TestLiveStart(unittest.TestCase):
    """handle_live_start のコンシェルジュ分岐（Live には接続しない）"""

    @classmethod
    def setUpClass(cls):
        from google.cloud import speech, texttospeech
        with mock.patch.object(texttospeech, 'TextToSpeechClient'), mock.patch.object(speech, 'SpeechClient'):
            import app_customer_support as app_module
        cls.app = app_module

    def start(self, language='ja', store=None):
        # Socket.IO の文脈なしでハンドラを直接呼ぶ（request.sid と emit だけ差し替える）
        fake_cls = mock.Mock()
        emit = mock.Mock()
        with mock.patch.object(self.app, 'LiveAPISession', fake_cls), \
                mock.patch.object(self.app.threading, 'Thread'), \
                mock.patch.object(self.app, 'request', SimpleNamespace(sid='client-1')), \
                mock.patch.object(self.app, 'emit', emit):
            self.app.handle_live_start({'session_id': store.session_id if store else None,
                                        'mode': 'concierge', 'language': language})
        self.app.active_live_sessions.pop('client-1', None)
        return fake_cls, emit

    def test_language_without_v11_does_not_start_live(self):
        fake_cls, emit = self.start('ko', new_store())
        fake_cls.assert_not_called()
        emit.assert_called_once_with('error', {'message': sc.CONCIERGE_TEXTS['ko']['unsupported_language']})

    def test_concierge_uses_v11_rules_and_shared_store(self):
        store = new_store()
        fake_cls, _ = self.start('ja', store)
        kwargs = fake_cls.call_args.kwargs
        self.assertIn('推薦の依頼', kwargs['system_prompt'])          # v11
        self.assertIn('get_current_shops', kwargs['system_prompt'])   # Live 用規則
        self.assertEqual(kwargs['shops_store'].session_id, store.session_id)
        cb = kwargs['shop_search_callback']
        result = {'status': 'complete', 'reason_code': None, 'source': 'knowledge', 'found_count': 5,
                  'shops': FIVE, 'cards': []}
        import concierge_recommender
        with mock.patch.object(concierge_recommender, 'recommend_shops', return_value=dict(result)) as rec:
            seq = store.begin_search()
            out = cb('恵比寿 焼き鳥', 'ja', 'concierge', seq)
        self.assertEqual(rec.call_args[0][:3], ('恵比寿 焼き鳥', 'ja', 'live'))
        self.assertEqual((out['status'], out['shops_version']), ('complete', 1))
        self.assertEqual(store.get_shops_state()[2][1], 'not_started')
        with mock.patch.object(concierge_recommender, 'recommend_shops', return_value=dict(result)):
            old_seq = store.begin_search()
            store.begin_search()                                       # キーボードで後から検索が始まった
            out = cb('x', 'ja', 'concierge', old_seq)
        self.assertEqual((out['status'], out['shops_version']), ('superseded', 1))


class TestChatModeUnchanged(unittest.TestCase):
    def test_chat_resume_text_is_the_existing_one(self):
        l, _ = live(mode='chat')
        l._shop_intro_turn_pending = True
        l.ai_transcript_buffer = 'お店の紹介です、'
        l._process_turn_complete()
        self.assertEqual(l._resume_message, 'ありがとうございます。気になるお店について教えてください。')


if __name__ == '__main__':
    unittest.main()

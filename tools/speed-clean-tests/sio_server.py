import os, sys, time
from flask import Flask, send_from_directory
from flask_socketio import SocketIO
DIST = sys.argv[1]
app = Flask(__name__, static_folder=None)
sio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

@app.route('/', defaults={'p': ''})
@app.route('/<path:p>')
def files(p):
    full = os.path.join(DIST, p)
    if os.path.isdir(full):
        return send_from_directory(full, 'index.html')
    if os.path.exists(full):
        return send_from_directory(DIST, p)
    return ('', 404)

def seq(sid):
    time.sleep(2.0)
    e = lambda ev, d: (sio.emit(ev, d, room=sid), time.sleep(0.3))
    e('shop_search_start', {'search_id': 'S1'})
    e('shop_search_result', {'search_id': 'S1', 'response': '', 'shops': [
        {'name': 'A店', 'place_id': 'PA'}, {'name': 'B店', 'place_id': 'PB'}]})
    e('shop_links_update', {'search_id': 'S1', 'updates': [{'place_id': 'PA', 'fields': {'hotpepper_url': 'https://hp/A'}}]})
    e('shop_search_start', {'search_id': 'S2'})
    e('shop_links_update', {'search_id': 'S1', 'updates': [{'place_id': 'PB', 'fields': {'hotpepper_url': 'https://hp/B-stale'}}]})
    e('shop_search_result', {'search_id': 'S2', 'response': '', 'shops': []})
    e('shop_links_update', {'search_id': 'S2', 'updates': [{'place_id': 'PB', 'fields': {'hotpepper_url': 'https://hp/B-S2'}}]})
    e('shop_search_start', {'search_id': 'S3'})
    e('shop_search_result', {'search_id': 'S3', 'response': '', 'shops': [{'name': 'C店', 'place_id': 'PC'}]})
    e('shop_links_update', {'search_id': 'S3', 'updates': [{'place_id': 'PC', 'fields': {'hotpepper_url': 'https://hp/C', 'name': 'HACK'}}]})
    e('test_done', {})

@sio.on('connect')
def on_connect(auth=None):
    from flask import request
    sio.start_background_task(seq, request.sid)

sio.run(app, host='127.0.0.1', port=4398, allow_unsafe_werkzeug=True)

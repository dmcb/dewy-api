from datetime import datetime, timedelta

from couchbase.bucket import Bucket
from flask import Blueprint
from flask import session, request
from flask_oauthlib.provider import OAuth2Provider

# Based on https://github.com/lepture/example-oauth2-server/blob/master/app.py

oauth = OAuth2Provider()
blueprint = Blueprint('oauth', __name__)
auth_db = Bucket('couchbase://192.168.99.100/dewy_auth')

def current_user():
	if 'id' in session:
		return session['id']
	return None 

@oauth.clientgetter
def load_client(client_id):
	# Load a client document from auth_db. The document key
	# is client_id prefixed with 'c/'.
	key = 'c/%s' % client_id
	client = None

	try:
		res = auth_db.get(key)
		client = res.value
	except:
		pass

	return client

@oauth.grantgetter
def load_grant(client_id, code):
	# Load a grant token for a client from auth_db. The
	# document key is 'c/{client_id}/g/{code}'
	key = 'c/%s/g/%s' % (client_id, code)
	grant = None

	try:
		res = auth_db.get(key)
		grant = res.value
	except:
		pass

	return grant

@oauth.grantsetter
def save_grant(client_id, code, request, *args, **kwargs):
	key = 'c/%s/g/%s' % (client_id, code['code'])
	ttl = 600
	grant = {
		'client_id': client_id,
		'user_id': session['id'],
		'code': code['code'],
		'redirect_uri': request.redirect_uri,
		'scopes': ' '.join(request.scopes)
	}

	try:
		res = auth_db.insert(key, grant, ttl=ttl)
		grant = res.value
	except:
		grant = None

	return grant

@oauth.tokengetter
def load_token(access_token=None, refresh_token=None):
	key = 'c/%s/t/%s' % (request.client.client_id, access_token or refresh_token)
	token = None

	try:
		res = auth_db.get(key)
		token = res.value
	except:
		pass

	return token

@oauth.tokensetter
def save_token(token, request, *args, **kwargs):
	pass

@blueprint.route('/token', methods=['GET', 'POST'])
@oauth.token_handler
def access_token():
	return None

@blueprint.route('/authorize', methods=['GET', 'POST'])
@oauth.authorize_handler
def authorize(*args, **kwargs):
	pass

@blueprint.route('/me')
@oauth.require_oauth()
def me():
	pass


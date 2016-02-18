var uuid = require('uuid');
var couchbase = require('couchbase');
var db = require('../app.js').bucket;
var md5 = require('md5');

exports.create = function(params, callback) {
    // Construct user document
    var userDoc = {
        uid: uuid.v4(),
        apikey: uuid.v4(),
        username: params.username,
        email: params.email,
        password: params.password
    };
    db.insert('user::' + userDoc.uid, userDoc, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, userDoc);
    });
}

exports.get = function(uid, callback) {
    db.get('user::' + uid, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        // Hash email for Gravatar
        var userDoc = result.value;
        userDoc.gravatar = md5(userDoc.email); 
        callback(null, userDoc);
    });
}

exports.getByApiKey = function(apikey, callback) {
    query = couchbase.ViewQuery.from('users', 'by_apikey')
        .key([apikey])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.getByEmail = function(email, callback) {
    query = couchbase.ViewQuery.from('users', 'by_email')
        .key([email])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.getByUsername = function(username, callback) {
    query = couchbase.ViewQuery.from('users', 'by_username')
        .key([username])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.update = function(userDoc, callback) {
    db.replace('user::' + userDoc.uid, userDoc, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}
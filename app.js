// Dependencies
var express = require('express');
var bodyParser = require('body-parser');
var oauthserver = require('oauth2-server');
var couchbase = require('couchbase');
var config = new require('./config')();

var app = express();

// Feedback to user
console.log(config.environment);

// Express configuration
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Global declaration of Couchbase
module.exports.bucket = (new couchbase.Cluster(config.couchbase.server)).openBucket(config.couchbase.bucket, config.couchbase.password);

// Install Couchbase design documents
argv = process.argv.splice(2);
if (argv[0] === '--setup') {
    var design = require('./setup.js');
    design.setup(function(error, result) {
        if (error) {
            console.log(error);
        } else {
            console.log(result);
        }
        process.exit(0);
    });
}
// Run a site audit
else if (argv[0] === '--audit') {
    var design = require('./admin.js');
    design.audit(function(error, result) {
        if (error) {
            console.log(error);
        } else {
            console.log(result);
        }
        process.exit(0);
    });
}
// Run a release retrieval
else if (argv[0] === '--releases') {
    var design = require('./admin.js');
    design.releases(function(error, result) {
        if (error) {
            console.log(error);
        } else {
            console.log(result);
        }
        process.exit(0);
    });
}
// Run the API
else {
    // Allow API access from dewy.io
    app.use(function(req, res, next) {
        if (config.environment == 'production') {
            res.header('Access-Control-Allow-Origin', 'http://dewy.io');
        }
        else {
            res.header('Access-Control-Allow-Origin', 'http://dewy.local');
        }
        res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        next();
    });

    // OAuth 2 configuration
    var debug = true;
    if (config.environment == 'production') {
        debug: false
    }
    app.oauth = oauthserver({
        model: require('./models/oauth'),
        grants: ['authorization_code', 'password', 'refresh_token'],
        accessTokenLifetime: config.oauth.accessTokenLifetime,
        refreshTokenLifetime: config.oauth.refreshTokenLifetime,
        debug: debug
    });
    module.exports.oauth = app.oauth;
    app.all('/oauth/token', app.oauth.grant());

    // API endpoints
    var fieldRoutes = require('./routes/fields');
    var filterRoutes = require('./routes/filters');
    var moduleRoutes = require('./routes/modules');
    var siteRoutes = require('./routes/sites');
    var userRoutes = require('./routes/users');
    app.use('/fields', fieldRoutes);
    app.use('/filters', filterRoutes);
    app.use('/modules', moduleRoutes);
    app.use('/sites', siteRoutes);
    app.use('/users', userRoutes);

    // Error handling
    app.use(app.oauth.errorHandler());
    app.use(function(req, res) {
      res.status(404).send("Not a valid API endpoint");
    });
}
module.exports = app;
var _ = require('underscore');
var uuid = require('uuid');
var couchbase = require('couchbase');
var db = require('../api.js').bucket;
var async = require('async');
var request = require('request');
var modules = require('../models/modules');
var config = require('../config');

exports.audit = function(sid, results, callback) {
    db.get('site::' + sid, function(error, result) {
        if (error) {
            results.push({ sid: sid, error: error });
            return callback();
        }
        var siteDoc = result.value;
        console.log('Auditing ' + result.value.sid + ' at ' + siteDoc.baseurl + '/admin/reports/dewy');
        if (siteDoc.fake) {
            results.push({ sid: siteDoc.sid, error: 'This is a fake site for demo purposes, it will not be audited' });
            return callback();
        }
        request({
            uri: siteDoc.baseurl + '/admin/reports/dewy',
            method: 'POST',
            body: 'token=' + siteDoc.token,
            rejectUnauthorized: false,
            charset: 'utf-8',
            timeout: 600000,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }, function(error, response, body) {
            var date = new Date().getTime() / 1000;
            date = Math.round(date);

            // Define audit values if they've never been defined before
            if ('audit' in siteDoc) {
                siteDoc.audit.lastAudit = date;
            }
            else {
                siteDoc.audit = {
                    lastAudit: date,
                    lastSuccessfulAudit: 0,
                    lastSuccessfulContentAudit: 0,
                    errors: []
                }
            }
            
            if (error || response.statusCode != 200) {
                var errorValue = error;
                if (response.statusCode == 403) {
                    errorValue = 'Dewy is not permitted to communicate to this site. Is this site still linked to this account and enabled for Dewy reporting? Is this site behind a proxy? Please edit your site\'s settings.php file and follow the steps to configure reverse proxy servers.';
                }
                else if (response.statusCode == 404) {
                    errorValue = 'Dewy could not be found on this site. Is the module enabled on the site?';
                }
                else if (response.statusCode != 200) {
                    errorValue = response.statusCode;
                }

                siteDoc.audit.errors.unshift({date: date, error: errorValue});
                if (siteDoc.audit.errors.length > 3) {
                    siteDoc.audit.errors.splice(3, siteDoc.audit.errors.length-3);
                }
                exports.update(siteDoc, function(error, result) {
                    if (error) {
                        results.push({ sid: siteDoc.sid, error: error });
                        return callback();
                    }
                    else {
                        results.push({ sid: siteDoc.sid, error: siteDoc.audit.errors[0].error });
                        return callback();
                    }
                });
            }
            else {
                // Store details
                async.parallel([
                    function(callback) {
                        try {
                            siteDoc.details = JSON.parse(body);
                            return callback();
                        }
                        catch (e) {
                            siteDoc.audit.errors.unshift({date: date, error: 'Failed to parse: ' + e.message});
                            if (siteDoc.audit.errors.length > 3) {
                                siteDoc.audit.errors.splice(3, siteDoc.audit.errors.length-3);
                            }
                            exports.update(siteDoc, function(error, result) {
                                if (error) {
                                    return callback({ sid: siteDoc.sid, error: error });
                                }
                                else {
                                    return callback({ sid: siteDoc.sid, error: siteDoc.audit.errors[0].error });
                                }
                            });
                        }
                    }
                ], function (error) {
                    if (error) {
                        results.push(error);
                        return callback();
                    }
                    async.parallel([
                        function(callback) {
                            exports.auditContent(siteDoc, function(error, result) {
                                if (error) {
                                    return callback(error);
                                }
                                return callback();
                            });
                        }
                    ], function (error) {
                        contentAuditSuccessful = true;
                        if (error) {
                            contentAuditSuccessful = false;
                            results.push(error);
                        }

                        try {
                            // Process details
                            exports.processDoc(siteDoc, function(error, result) {
                                if (error) {
                                    results.push({ sid: siteDoc.sid, error: error });
                                    return callback();
                                }
                                // Save site with a successful audit
                                var siteDoc = result;
                                siteDoc.audit.lastSuccessfulAudit = date;
                                siteDoc.audit.errors = [];
                                var lastSuccessfulContentAuditPriorToThisOne = siteDoc.audit.lastSuccessfulContentAudit;
                                if (contentAuditSuccessful) {
                                    siteDoc.audit.lastSuccessfulContentAudit = date;
                                }
                                exports.update(siteDoc, function(error, result) {
                                    if (error) {
                                        // If the document is now too large to store with content
                                        // then we have to remove it and save again.
                                        // This is a flaw with my implementation. Should I do more
                                        // with content handling, it would be best to pursue
                                        // a better solution for big data.
                                        if (error.code == '4') {
                                            if (config.debug) {
                                                console.log('Content audit for ' + siteDoc.sid + ' too large to be saved');
                                            }
                                            // Revert date of last successful content audit
                                            siteDoc.audit.lastSuccessfulContentAudit = lastSuccessfulContentAuditPriorToThisOne;
                                            // Clear content audit results
                                            siteDoc.raw = "";
                                            exports.update(siteDoc, function(error, result) {
                                                if (error) {
                                                    results.push({ sid: siteDoc.sid, error: error });
                                                }
                                                return callback();
                                            });
                                        }
                                        else {
                                            results.push({ sid: siteDoc.sid, error: error });
                                            return callback();
                                        }
                                    }
                                    else {
                                        return callback();
                                    }
                                });
                            });
                        }
                        catch (e) {
                            siteDoc.audit.errors.unshift({date: date, error: 'Failed to process: ' + e.message});
                            if (siteDoc.audit.errors.length > 3) {
                                siteDoc.audit.errors.splice(3, siteDoc.audit.errors.length-3);
                            }
                            exports.update(siteDoc, function(error, result) {
                                if (error) {
                                    results.push({ sid: siteDoc.sid, error: error });
                                    return callback();
                                }
                                else {
                                    results.push({ sid: siteDoc.sid, error: siteDoc.audit.errors[0].error });
                                    return callback();
                                }
                            });
                        }
                    });
                });
            }
        });
    });
}

exports.auditContent = function(siteDoc, callback) {
    // If the site has content enabled, grab the raw content
    if (siteDoc.content == 1) {
        request({
            uri: siteDoc.baseurl + '/admin/reports/dewy-content',
            method: 'POST',
            body: 'token=' + siteDoc.token,
            rejectUnauthorized: false,
            charset: 'utf-8',
            timeout: 600000,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }, function(error, response, body) {
            if (error) {
                return callback({ sid: siteDoc.sid, warning: 'Content retrieval failed: ' + error });
            }
            else if (response.statusCode != 200) {
                return callback({ sid: siteDoc.sid, warning: 'Content retrieval failed: ' + response.statusCode });
            }
            else {
                try {
                    siteDoc.raw = JSON.parse(body);
                }
                catch (e) {
                    return callback({ sid: siteDoc.sid, warning: 'Content parsing failed: ' + e });
                }
            }
            return callback();
        });
    }
    else {
        return callback({ sid: siteDoc.sid, warning: 'Content not permitted for audit' });
    }
}

exports.auditAll = function(callback) {
    // Get all users
    query = couchbase.ViewQuery.from('users', 'by_username')
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            return callback(error);
        }
        if (result.length) {
            // Run site audits per-user account, in parallel
            async.each(result,
                function(row, callback) {
                    var uid = row.value;

                    query = couchbase.ViewQuery.from('sites', 'by_uid')
                        .key([uid, null]);
                    db.query(query, function(error, result) {
                        if (error) {
                            return callback();
                        }

                        console.log('Auditing the ' + result.length + ' real sites owned by ' + uid);

                        var results = [];
                        // Site at a time per user = little chance of DoS
                        // Should really do site at a time per domain per user to speed things up more
                        async.eachLimit(result, 1,
                            function(row, callback) {
                                exports.audit(row.value, results, function(error, result) {
                                    callback();
                                });
                            },
                            function(error) {
                                if (results.length) {
                                    console.log('Site audit for ' + uid + ' complete, ' + results.length + ' non-successful results occurred:');
                                    console.log(results);
                                }
                                else {
                                    console.log('Site audit for ' + uid + ' complete, no non-successful results occurred');
                                }
                                callback();
                            }
                        );
                    });
                },
                function(error){
                    return callback('Audit successful');
                }
            );  
        }
        else {
            return callback('There are no users to audit');
        }
    });
}

exports.create = function(uid, token, baseurl, enabled, users, content, traffic, dateAdded, callback) {
    // Construct site document
    var siteDoc = {
        sid: uuid.v4(),
        uid: uid,
        token: token,
        baseurl: baseurl,
        enabled: enabled,
        users: users,
        content: content,
        traffic: traffic,
        dateAdded: dateAdded
    };

    // Insert site
    db.insert('site::' + siteDoc.sid, siteDoc, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, siteDoc.sid);
    });
}

exports.delete = function(sid, callback) {
    db.remove('site::' + sid, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.get = function(sid, callback) {
    db.get('site::' + sid, function (error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result.value);
    });
}

exports.getAll = function(uid, fid, callback) {
    // If no filter is given, return all sites
    if (fid == null) {
        query = couchbase.ViewQuery.from('sites', 'audited_by_uid')
            .key([uid])
            .stale(1);
    } else {
        query = couchbase.ViewQuery.from('users-filter-' + fid, 'sites')
            .stale(1);
    }
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        var sites = [];
        for (item in result) {
            sites.push(result[item].value);
        }
        callback(null, sites);
    });
}

exports.getAllOffline = function(params, callback) {
    query = couchbase.ViewQuery.from('sites', 'offline_by_uid')
        .key([params.uid])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        var sites = [];
        for (item in result) {
            sites.push(result[item].value);
        }
        callback(null, sites);
    });
}

exports.getAllTags = function(params, callback) {
    query = couchbase.ViewQuery.from('sites', 'tags_by_uid')
        .range([params.uid, null], [params.uid, {}])
        .group(true);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.getByBaseurl = function(params, callback) {
    query = couchbase.ViewQuery.from('sites', 'by_uid_and_baseurl')
        .key([params.uid, params.baseurl])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

exports.getByProject = function(uid, project, core, maxModuleUpdateLevel, callback) {
    query = couchbase.ViewQuery.from('sites', 'by_uid_and_project')
        .range([uid, project, core, 0], [uid, project, core, maxModuleUpdateLevel])
        .stale(1);
    db.query(query, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        var sites = [];
        for (item in result) {
            sites.push(result[item].value);
        }
        callback(null, sites);
    })
}

exports.getDetail = function(siteDoc) {
    var projectVersions = {};
    for (project in siteDoc.details.projects) {
        projectVersions[project] = siteDoc.details.projects[project].version;
    }
    var core = {};
    core['version'] = siteDoc.details.drupal_core;
    core['major'] = core['version'].split('.');
    core['major'] = core['major'][0] + '.x';
    return { core: core, users: siteDoc.users, content: siteDoc.content, traffic: siteDoc.traffic, attributeDetails: siteDoc.attributeDetails, audit: siteDoc.audit, projectVersions: projectVersions };
}

exports.processDoc = function(siteDoc, callback) {
    siteDoc.attributes = {};
    var databaseUpdates = [];
    var projectKeys = [];
    var availableModules = [];
    var enabledModules = [];

    // Process time offset
    siteDoc.audit.timeOffset = siteDoc.audit.lastAudit - siteDoc.details.date;

    // Process projects
    var enabledProjects = 0;
    for (var i in siteDoc.details.projects) {
        if (siteDoc.details.projects[i].version) {
            var version = siteDoc.details.projects[i].version.split('-');
            // Drupal versions go 7.50 not 7.x-5.0, so we have to alter the core number just for the Drupal project
            if (i == 'drupal') {
                version = siteDoc.details.projects[i].version.split('.');
                version[0] = version[0] + '.x';
            }
            var core = version[0];
            projectKeys.push('project::' + i + '-' + core);
        }
        var moduleEnabled = false;
        for (var j in siteDoc.details.projects[i].modules) {
            if (siteDoc.details.projects[i].modules[j].schema != -1) {
                if (siteDoc.details.projects[i].modules[j].schema != siteDoc.details.projects[i].modules[j].latest_schema) {
                    databaseUpdates.push(j);
                }
                moduleEnabled = true;
                enabledModules.push(j);
            }
            availableModules.push(j);
        }
        if (moduleEnabled) {
            enabledProjects = enabledProjects+1;
        }
    }

    // Process traffic
    var hitsPerDay = -1;
    if (siteDoc.traffic == 1) {
        var hits = 0;
        for (var i in siteDoc.details.traffic.paths) {
            hits = hits + siteDoc.details.traffic.paths[i].hits;
        }
        if (hits) {
            var days = (siteDoc.audit.lastAudit - siteDoc.details.traffic.recorded_since + siteDoc.audit.timeOffset) / 86400;
            hitsPerDay = hits / days;
            hitsPerDay = +hitsPerDay.toFixed(1);
        }
    }

    // Process nodes
    var lastModified = 0;
    var avgLastModified = 0;
    var words = 0;
    var contentTypes = [];
    var nodeAuthors = {};
    for (var i in siteDoc.details.nodes) {
        avgLastModified = avgLastModified + Number(siteDoc.details.nodes[i].changed);
        if (siteDoc.details.nodes[i].changed > lastModified) {
            lastModified = siteDoc.details.nodes[i].changed;
        }
        if (contentTypes.indexOf(siteDoc.details.nodes[i].type) == '-1') {
            contentTypes.push(siteDoc.details.nodes[i].type)
        }
        words = words + siteDoc.details.nodes[i].words;
        var author = siteDoc.details.nodes[i].author;
        if (author) {
            if (author in nodeAuthors) {
                nodeAuthors[author] += 1;
            }
            else {
                nodeAuthors[author] = 1;
            }
        }
    }

    var nodes = _.keys(siteDoc.details.nodes).length;
    avgLastModified = Math.round(avgLastModified / nodes);

    // Process blocks
    for (var i in siteDoc.details.blocks) {
        words = words + siteDoc.details.blocks[i].words;
    }

    // Process users
    var lastAccess = 0;
    var avgLastAccess = 0;
    var users = [];
    var roles = [];
    for (var i in siteDoc.details.users) {
        // If last access is 0, set it to the user's created date
        if (!siteDoc.details.users[i].last_access) {
            siteDoc.details.users[i].last_access = siteDoc.details.users[i].created;
        }
        avgLastAccess = avgLastAccess + Number(siteDoc.details.users[i].last_access);
        if (siteDoc.details.users[i].last_access > lastAccess) {
            lastAccess = siteDoc.details.users[i].last_access;
        }
        if (siteDoc.users == 1) {
            users.push(i);
        }
        else {
            users.push('[obfuscated]');
        }
        for (var j in siteDoc.details.users[i].roles) {
            if (roles.indexOf(siteDoc.details.users[i].roles[j]) == '-1') {
                roles.push(siteDoc.details.users[i].roles[j]);
            }
        }
    }
    avgLastAccess = Math.round(avgLastAccess / users.length);

    var diskSpace = Number(siteDoc.details.files.public.size) + Number(siteDoc.details.files.private.size) + Number(siteDoc.details.db_size)
    diskSpace = +diskSpace.toFixed(2);

    // Process releases
    var projectsThatAreUnsupported = [];
    var projectsThatAreObsolete = [];
    var projectsWithUpdates = [];
    var projectsWithSecurityUpdates = [];
    modules.getReleasesFromProjects(projectKeys, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        var undocumentedProjects = [];
        for (var i in siteDoc.details.projects) {
            if (siteDoc.details.projects[i].version) {
                var version = siteDoc.details.projects[i].version.split('-');
                // Drupal versions go 7.50 not 7.x-5.0, so we have to alter the core number just for the Drupal project
                if (i == 'drupal') {
                    version = siteDoc.details.projects[i].version.split('.');
                    version[0] = version[0] + '.x';
                }
                var core = version[0];
                if (result['project::' + i + '-' + core] && result['project::' + i + '-' + core].value) {
                    var projectDoc = result['project::' + i + '-' + core].value;
                    if (projectDoc.maintenanceStatus == 'Unsupported') {
                        projectsThatAreUnsupported.push(i);
                    }
                    if (projectDoc.developmentStatus == 'Obsolete') {
                        projectsThatAreObsolete.push(i);
                    }
                    var updateResult = modules.checkVersionForUpdate(projectDoc, siteDoc.details.projects[i].version);
                    // If we were recording individual modules, we would use this code
                    // for (var j in siteDoc.details.projects[i].modules) {
                    //     if (updateResult.update) {
                    //         projectsWithUpdates.push(j);
                    //     }
                    //     if (updateResult.securityUpdate) {
                    //         projectsWithSecurityUpdates.push(j);
                    //     }
                    // }
                    // But we're reporting projects instead
                    if (updateResult.update) {
                        projectsWithUpdates.push(i);
                    }
                    if (updateResult.securityUpdate) {
                        projectsWithSecurityUpdates.push(i);
                    }
                }
                else {
                    // The Drupal.org release information was not found in Dewy for this particular project
                    // Perhaps because it's a project without release information, or maybe because Dewy hasn't seen it before
                    // Lets attempt to grab it right now
                    undocumentedProjects.push({ projectName: i, core: core, version: siteDoc.details.projects[i].version });
                }
            }
        }

        // Loop through any projects that weren't found in Dewy
        var undocumentedProjectsNowDocumented = [];
        async.each(undocumentedProjects,
            function(row, callback) {
                // Ping Drupal.org to see if we can get project information
                modules.getRelease(row.projectName, row.core, [], function(error, result) {
                    if (result) {
                        // If a projectDoc was created, there may be Drupal.org release information added to Dewy
                        undocumentedProjectsNowDocumented.push({ projectDoc: result, version: row.version });
                    }
                    callback();
                });
            },
            function(error) {
                // Process any new projects and determine if they have updates and record to siteDoc
                for (var i in undocumentedProjectsNowDocumented) {
                    var projectDoc = undocumentedProjectsNowDocumented[i].projectDoc;
                    if (projectDoc.maintenanceStatus == 'Unsupported') {
                        projectsThatAreUnsupported.push(projectDoc.project);
                    }
                    if (projectDoc.developmentStatus == 'Obsolete') {
                        projectsThatAreObsolete.push(projectDoc.project);
                    }
                    var updateResult = modules.checkVersionForUpdate(undocumentedProjectsNowDocumented[i].projectDoc, undocumentedProjectsNowDocumented[i].version);
                    if (updateResult.update) {
                        projectsWithUpdates.push(projectDoc.project);
                    }
                    if (updateResult.securityUpdate) {
                        projectsWithSecurityUpdates.push(projectDoc.project);
                    }
                }

                siteDoc.attributes = {
                    availableModules: availableModules.length,
                    enabledModules: enabledModules.length,
                    contentTypes: contentTypes.length,
                    roles: roles.length,
                    users: users.length,
                    nodes: nodes,
                    files: siteDoc.details.files.public.count + siteDoc.details.files.private.count,
                    words: words,
                    diskSpace: diskSpace,
                    lastModified: lastModified + siteDoc.audit.timeOffset,
                    avgLastModified: avgLastModified + siteDoc.audit.timeOffset,
                    lastAccess: lastAccess + siteDoc.audit.timeOffset,
                    avgLastAccess: avgLastAccess + siteDoc.audit.timeOffset,
                    hitsPerDay: hitsPerDay,
                    databaseUpdates: databaseUpdates.length,
                    projectsThatAreUnsupported: projectsThatAreUnsupported.length,
                    projectsThatAreObsolete: projectsThatAreObsolete.length,
                    projectsWithUpdates: projectsWithUpdates.length,
                    projectsWithSecurityUpdates: projectsWithSecurityUpdates.length,
                    enabledProjects: enabledProjects
                }

                siteDoc.attributeDetails = {
                    availableModules: availableModules,
                    enabledModules: enabledModules,
                    contentTypes: contentTypes,
                    roles: roles,
                    users: users,
                    databaseUpdates: databaseUpdates,
                    projectsThatAreUnsupported: projectsThatAreUnsupported,
                    projectsThatAreObsolete: projectsThatAreObsolete,
                    projectsWithUpdates: projectsWithUpdates,
                    projectsWithSecurityUpdates: projectsWithSecurityUpdates,
                    nodeAuthors: nodeAuthors
                }

                callback(null, siteDoc);
            }
        );
    });
}

exports.update = function(siteDoc, callback) {
    db.replace('site::' + siteDoc.sid, siteDoc, function(error, result) {
        if (error) {
            callback(error, null);
            return;
        }
        callback(null, result);
    });
}

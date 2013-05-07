// Load modules

var Os = require('os');
var Events = require('events');
var Path = require('path');
var Fs = require('fs');
var NodeUtil = require('util');
var Async = require('async');
var Request = require('request');
var Hoek = require('hoek');
var System = require('./system');
var Process = require('./process');


// Declare internals

var internals = {
    host: Os.hostname(),
    appVer: Hoek.loadPackage(__dirname + '/..').version || 'unknown'                        // Look up a level to get the package.json page
};


internals.defaults = {
    schemaName: 'good.v1',                          // String to include using 'schema' key in update envelope
    broadcastInterval: 0,                           // MSec, 0 for immediately
    opsInterval: 15000,                             // MSec, equal to or greater than 100
    extendedRequests: false,
    requestsEvent: 'tail',                          // Sets the event used by the monitor to listen to finished requests. Other options: 'response'.
    subscribers: null,                              // { console: ['ops', 'request', 'log'] }
    alwaysMeasureOps: false,                        // Measures ops even if no subscribers
    maxLogSize: 0                                   // Max bytes allowed to be written to each log file
};


module.exports = internals.Monitor = function (plugin, options) {

    var self = this;

    Hoek.assert(this.constructor === internals.Monitor, 'Monitor must be instantiated using new');

    this.plugin = plugin;
    this.settings = Hoek.applyToDefaults(internals.defaults, options || {});

    if (!this.settings.subscribers) {
        this.settings.subscribers = {
            console: ['request', 'log']
        };
    }

    // Validate settings

    Hoek.assert(this.settings.opsInterval >= 100, 'Invalid monitor.opsInterval configuration');
    Hoek.assert(this.settings.subscribers, 'Invalid monitor.subscribers configuration');
    Hoek.assert(this.settings.requestsEvent === 'response' || this.settings.requestsEvent === 'tail', 'Invalid monitor.requestsEvent configuration');

    // Register as event emitter

    Events.EventEmitter.call(this);

    // Private members

    this._subscriberQueues = {              // { destination -> subscriberQueue }
        console: {},
        http: {},
        file: {}
    };
    this._eventQueues = {};                 // { eventType -> [subscriberQueue] }
    this._subscriberTags = {};
    this._background = {};                  // internval ids
    this._fileLogs = {};                    // log file write streams
    this._isProcessingLogs = false;

    // Identify subscriptions

    var subscriberKeys = Object.keys(this.settings.subscribers);
    for (var i = 0, il = subscriberKeys.length; i < il; ++i) {
        var dest = subscriberKeys[i];
        var destType = dest === 'console' ? dest : /^(http|https)\:/i.test(dest) ? 'http' : 'file';

        this._subscriberQueues[destType][dest] = [];

        var subscriptions = this.settings.subscribers[dest];
        var eventTypes = Array.isArray(subscriptions) ? subscriptions : subscriptions.events;
        this._subscriberTags[dest] = subscriptions.tags;

        for (var s = 0, sl = eventTypes.length; s < sl; ++s) {
            var eventType = eventTypes[s];
            this._eventQueues[eventType] = this._eventQueues[eventType] || [];
            this._eventQueues[eventType].push(this._subscriberQueues[destType][dest]);
        }
    }

    if (Object.keys(this._eventQueues).length ||
        this.settings.alwaysMeasureOps) {

        // Setup broadcast interval

        if (this.settings.broadcastInterval) {
            this._background.broadcastInterval = setInterval(this._broadcastHttp.bind(this), this.settings.broadcastInterval);
        }

        // Initialize Events

        if (this._eventQueues.log) {
            this._background.log = this._handle('log');
            this.plugin.events.on('log', this._background.log);
        }

        if (this._eventQueues.request) {
            this._background.request = this._handle('request');
            this.plugin.events.on(this.settings.requestsEvent, this._background.request);
        }

        if (this._eventQueues.ops ||
            this.settings.alwaysMeasureOps) {

            this._process = new Process.Monitor();
            this._os = new System.Monitor();

            this._background.ops = this._handle('ops');
            self.on('ops', this._background.ops);

            // Set ops interval timer

            var opsFunc = function () {

                // Gather operational statistics in parallel

                Async.parallel({
                    oscpu: self._os.cpu,
                    osdisk: self._os.disk,
                    osload: self._os.loadavg,
                    osmem: self._os.mem,
                    osup: self._os.uptime,
                    psup: self._process.uptime,
                    psmem: self._process.memory,
                    pscpu: self._process.cpu,
                    psdelay: self._process.delay
                },
                function (err, results) {

                    if (!err) {
                        self.emit('ops', results);
                    }
                });
            };

            this._background.opsInterval = setInterval(opsFunc, this.settings.opsInterval);
        }
    }

    return this;
};

NodeUtil.inherits(internals.Monitor, Events.EventEmitter);


internals.Monitor.prototype.stop = function () {

    if (this._background.opsInterval) {
        clearInterval(this._background.opsInterval);
    }

    if (this._background.broadcastInterval) {
        clearInterval(this._background.broadcastInterval);
    }

    if (this._background.log) {
        this.plugin.events.removeListener('log', this._background.log);
    }

    if (this._background.request) {
        this.plugin.events.removeListener(this.settings.requestsEvent, this._background.request);
    }

    if (this._background.ops) {
        this.removeListener('ops', this._background.ops);
    }
};


internals.Monitor.prototype._eventsFilter = function (destFilterTags, subscriberQueue) {

    var filteredQueue = subscriberQueue.filter(function (event) {

        var containsEventTag = function (tag) {

            return event.tags && event.tags.indexOf(tag) >= 0;
        };

        return !destFilterTags || destFilterTags.some(containsEventTag);
    });

    return filteredQueue;
};


internals.Monitor.prototype._broadcastHttp = function () {

    var self = this;

    Object.keys(self._subscriberQueues.http).forEach(function (uri) {

        var subscriberQueue = self._subscriberQueues.http[uri];
        if (!subscriberQueue.length) {
            return;
        }

        var envelope = {
            schema: self.settings.schemaName,
            host: internals.host,
            appVer: internals.appVer,
            timestamp: Date.now(),
            events: self._eventsFilter(self._subscriberTags[uri], subscriberQueue)
        };

        subscriberQueue.length = 0;                                     // Empty queue (must not set to [] or queue reference will change)

        Request({ method: 'post', uri: uri, json: envelope });          // Ignore errors
    });
};


internals.Monitor.prototype._broadcastConsole = function () {

    var subscriberQueue = this._subscriberQueues.console.console;
    if (!subscriberQueue || !subscriberQueue.length) {
        return;
    }

    var events = this._eventsFilter(this._subscriberTags.console, subscriberQueue);

    subscriberQueue.length = 0;                                         // Empty queue (must not set to [] or queue reference will change)

    this._display(events);
};


internals.Monitor.prototype._broadcastFile = function () {

    var self = this;

    var keys = Object.keys(this._subscriberQueues.file);
    var keysLength = keys.length;

    if (!keysLength) {
        return;
    }

    if (this._isProcessingLogs) {
        return setImmediate(this._broadcastFile.bind(this));
    }

    this._isProcessingLogs = true;
    var totalLogged = 0;
    var logged = function () {

        totalLogged++;
        if (totalLogged === keysLength) {
            self._isProcessingLogs = false;
        }
    };

    for (var i = 0; i < keysLength; ++i) {

        var file = keys[i];
        var subscriberQueue = this._subscriberQueues.file[file];
        var events = self._eventsFilter(this._subscriberTags[file], subscriberQueue);

        subscriberQueue.length = 0;                                     // Empty queue (must not set to [] or queue reference will change)
        self._logToFile(file, events, logged);
    }
};


internals.Monitor.prototype._handle = function (eventName) {

    var self = this;
    var eventHandler = null;

    if (eventName === 'ops') {
        eventHandler = this._ops();
    }
    else if (eventName === 'request') {
        eventHandler = this._request();
    }
    else if (eventName === 'log') {
        eventHandler = this._log();
    }

    Hoek.assert(eventHandler !== null, 'Invalid eventName specified');

    return function (context) {

        var subscriptions = self._eventQueues[eventName];
        if (subscriptions &&
            subscriptions.length) {

            var event = eventHandler(context);

            for (var i = 0, il = subscriptions.length; i < il; ++i) {
                subscriptions[i].push(event);
            }

            if (self.settings.broadcastInterval === 0) {
                self._broadcastHttp();
            }

            self._broadcastConsole();
            self._broadcastFile();
        }
    };
};


internals.Monitor.prototype._ops = function () {

    return function (results) {

        var event = {
            event: 'ops',
            timestamp: Date.now(),
            os: {
                load: results.osload,
                mem: results.osmem,
                disk: results.osdisk,
                uptime: results.osup
                // io: '', // Not yet implemented
                // net: '' // Not yet implemented
            },
            proc: {
                uptime: results.psup,
                mem: results.psmem,
                cpu: results.pscpu
            }
        };

        if (results.oscpu !== null &&
            results.oscpu !== '-') {

            event.os.cpu = results.oscpu;
        }

        return event;
    };
};


internals.Monitor.prototype._request = function () {

    var self = this;

    return function (request) {

        var req = request.raw.req;
        var res = request.raw.res;

        var event = {
            event: 'request',
            timestamp: request.info.received,
            id: request.id,
            instance: request.server.settings.nickname,
            method: request.method,
            path: request.path,
            query: request.query,
            source: {
                remoteAddress: (req.connection ? req.connection.remoteAddress : 'unknown'),
                userAgent: req.headers['user-agent'],
                referer: req.headers.referer
            },
            responseTime: Date.now() - request.info.received,
            statusCode: res.statusCode
        };

        if (self.settings.extendedRequests) {
            event.log = request.getLog();
        }

        return event;
    };
};


internals.Monitor.prototype._log = function () {

    return function (event) {

        event = {
            event: 'log',
            timestamp: event.timestamp,
            tags: event.tags,
            data: event.data
        };

        return event;
    };
};


internals.Monitor.prototype._display = function (events) {

    for (var i = 0, il = events.length; i < il; ++i) {
        var event = events[i];
        if (event.event === 'ops') {

            Hoek.printEvent({
                timestamp: event.timestamp,
                tags: ['ops'],
                data: 'memory: ' + Math.round(event.proc.mem.rss / (1024 * 1024)) + 'M cpu: ' + event.proc.cpu
            });
        }
        else if (event.event === 'request') {

            Hoek.printEvent({
                timestamp: event.timestamp,
                tags: ['request'],
                data: event.instance + ': ' + event.method + ' ' + event.path + ' (' + event.responseTime + 'ms)'
            });
        }
        else if (event.event === 'log') {

            Hoek.printEvent(event);
        }
    }
};


internals.Monitor.prototype._logToFile = function (dest, events, callback) {

    var self = this;

    var total = events.length;
    var written = 0;

    events.forEach(function (event) {

        var data = new Buffer(JSON.stringify(event));
        var bytes = data.length;

        self._getFileLog(dest, bytes, function (err, fileLog) {

            if (fileLog.stream.bytesWritten) {
                fileLog.stream.write('\n');
            }

            fileLog.stream.write(data, function (err) {

                written++;
                if (written === total) {
                    return callback();
                }
            });
        });
    });
};


internals.Monitor.prototype._getFileLog = function (dest, bytes, callback) {

    var self = this;

    var checkFileLog = function () {

        var fileLog = self._fileLogs[dest];
        if (typeof fileLog === 'undefined') {
            var isFile = dest[dest.length - 1] !== Path.sep;
            var directory = isFile ? Path.dirname(dest) : dest;
            var file = isFile ? Path.basename(dest) : Date.now().toString();

            self._nextFile(directory, file, processNextFile);
        }
        else if (self.settings.maxLogSize && (bytes + fileLog.stream.bytesWritten > self.settings.maxLogSize)) {
            self._nextFile(Path.dirname(fileLog.path), Path.basename(fileLog.path), processNextFile);
        }
        else {
            callback(null, fileLog);
        }
    };

    var processNextFile = function (err, filePath) {

        var fileLog = {
            path: filePath,
            stream: Fs.createWriteStream(filePath)
        };

        self._fileLogs[dest] = fileLog;
        callback(null, fileLog);
    };

    checkFileLog();
};


internals.Monitor.prototype._nextFile = function (directory, file, callback) {

    Fs.readdir(directory, function (err, filenames) {

        var extNum = 0;
        filenames.forEach(function (filename) {

            if (Path.basename(filename) === file) {
                var fileExtNum = parseInt(Path.extname(filename).substr(1));
                extNum = fileExtNum > extNum ? fileExtNum : extNum;
            }
        });

        extNum++;
        var ext = extNum.toString();
        while (ext.length < 3) {
            ext = '0' + ext;
        }

        callback(null, Path.join(directory, Path.basename(file, Path.extname(file)) + '.' + ext));
    });
};
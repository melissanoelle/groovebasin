var groove = require('groove');
var semver = require('semver');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var mkdirp = require('mkdirp');
var fs = require('fs');
var uuid = require('./uuid');
var path = require('path');
var Pend = require('pend');
var DedupedQueue = require('./deduped_queue');
var findit = require('findit');
var shuffle = require('mess');
var mv = require('mv');
var MusicLibraryIndex = require('music-library-index');
var keese = require('keese');
var safePath = require('./safe_path');
var PassThrough = require('stream').PassThrough;
var url = require('url');
var download = require('./download').download;
var Cookies = require('cookies');
var dbIterate = require('./db_iterate');
var log = require('./log');

module.exports = Player;

ensureGrooveVersionIsOk();

var cpuCount = require('os').cpus().length;

var PLAYER_KEY_PREFIX = "Player.";
var LIBRARY_KEY_PREFIX = "Library.";
var LIBRARY_DIR_PREFIX = "LibraryDir.";
var QUEUE_KEY_PREFIX = "Playlist.";
var PLAYLIST_KEY_PREFIX = "StoredPlaylist.";
var PLAYLIST_META_KEY_PREFIX = "StoredPlaylistMeta.";

// db: store in the DB
// read: send to clients
// write: accept updates from clients
var DB_PROPS = {
  key: {
    db: true,
    read: true,
    write: false,
    type: 'string',
  },
  name: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  artistName: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  albumArtistName: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  albumName: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  compilation: {
    db: true,
    read: true,
    write: true,
    type: 'boolean',
  },
  track: {
    db: true,
    read: true,
    write: true,
    type: 'integer',
  },
  trackCount: {
    db: true,
    read: true,
    write: true,
    type: 'integer',
  },
  disc: {
    db: true,
    read: true,
    write: true,
    type: 'integer',
  },
  discCount: {
    db: true,
    read: true,
    write: true,
    type: 'integer',
  },
  duration: {
    db: true,
    read: true,
    write: false,
    type: 'float',
  },
  year: {
    db: true,
    read: true,
    write: true,
    type: 'integer',
  },
  genre: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  file: {
    db: true,
    read: true,
    write: false,
    type: 'string',
  },
  mtime: {
    db: true,
    read: false,
    write: false,
    type: 'integer',
  },
  replayGainAlbumGain: {
    db: true,
    read: false,
    write: false,
    type: 'float',
  },
  replayGainAlbumPeak: {
    db: true,
    read: false,
    write: false,
    type: 'float',
  },
  replayGainTrackGain: {
    db: true,
    read: false,
    write: false,
    type: 'float',
  },
  replayGainTrackPeak: {
    db: true,
    read: false,
    write: false,
    type: 'float',
  },
  composerName: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  performerName: {
    db: true,
    read: true,
    write: true,
    type: 'string',
  },
  lastQueueDate: {
    db: true,
    read: false,
    write: false,
    type: 'date',
  },
  fingerprint: {
    db: true,
    read: false,
    write: false,
    type: 'array',
  },
  playCount: {
    db: true,
    read: true,
    write: false,
    type: 'integer',
  },
};

var PROP_TYPE_PARSERS = {
  'string': function(value) {
    return value ? String(value) : "";
  },
  'date': function(value) {
    if (!value) return null;
    var date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date;
  },
  'integer': parseIntOrNull,
  'float': parseFloatOrNull,
  'boolean': function(value) {
    return value == null ? null : !!value;
  },
  'array': function(value) {
    return Array.isArray(value) ? value : null;
  },
};

// how many GrooveFiles to keep open, ready to be decoded
var OPEN_FILE_COUNT = 8;
var PREV_FILE_COUNT = Math.floor(OPEN_FILE_COUNT / 2);
var NEXT_FILE_COUNT = OPEN_FILE_COUNT - PREV_FILE_COUNT;

var DB_SCALE = Math.log(10.0) * 0.05;
var REPLAYGAIN_PREAMP = 0.75;
var REPLAYGAIN_DEFAULT = 0.25;

Player.REPEAT_OFF = 0;
Player.REPEAT_ONE = 1;
Player.REPEAT_ALL = 2;

Player.trackWithoutIndex = trackWithoutIndex;

util.inherits(Player, EventEmitter);
function Player(db, musicDirectory, encodeQueueDuration) {
  EventEmitter.call(this);
  this.setMaxListeners(0);

  setGrooveLoggingLevel();

  this.db = db;
  this.musicDirectory = musicDirectory;
  this.dbFilesByPath = {};
  this.libraryIndex = new MusicLibraryIndex();
  this.addQueue = new DedupedQueue({
    processOne: this.addToLibrary.bind(this),
    // limit to 1 async operation because we're blocking on the hard drive,
    // it's faster to read one file at a time.
    maxAsync: 1,
  });

  this.dirs = {};
  this.dirScanQueue = new DedupedQueue({
    processOne: this.refreshFilesIndex.bind(this),
    // only 1 dir scanning can happen at a time
    // we'll pass the dir to scan as the ID so that not more than 1 of the
    // same dir can queue up
    maxAsync: 1,
  });
  this.dirScanQueue.on('error', function(err) {
    log.error("library scanning error:", err.stack);
  });

  this.playlist = {};
  this.playlists = {};
  this.currentTrack = null;
  this.tracksInOrder = []; // another way to look at playlist
  this.grooveItems = {}; // maps groove item id to track
  this.seekRequestPos = -1; // set to >= 0 when we want to seek
  this.invalidPaths = {}; // files that could not be opened
  this.playlistItemDeleteQueue = [];
  this.dontBelieveTheEndOfPlaylistSentinelItsATrap = false;
  this.queueClearEncodedBuffers = false;

  this.repeat = Player.REPEAT_OFF;
  this.desiredPlayerHardwareState = null; // true: normal hardware playback. false: dummy
  this.pendingPlayerAttachDetach = null;
  this.isPlaying = false;
  this.trackStartDate = null;
  this.pausedTime = 0;
  this.dynamicModeOn = false;
  this.dynamicModeHistorySize = 10;
  this.dynamicModeFutureSize = 10;

  this.ongoingScans = {};
  this.scanQueue = new DedupedQueue({
    processOne: this.performScan.bind(this),
    maxAsync: cpuCount,
  });

  this.headerBuffers = [];
  this.recentBuffers = [];
  this.newHeaderBuffers = [];
  this.openStreamers = [];
  this.expectHeaders = true;
  // when a streaming client connects we send them many buffers quickly
  // in order to get the stream started, then we slow down.
  this.encodeQueueDuration = encodeQueueDuration;

  this.groovePlaylist = groove.createPlaylist();
  this.groovePlayer = null;
  this.grooveEncoder = groove.createEncoder();
  this.grooveEncoder.encodedBufferSize = 128 * 1024;

  this.detachEncoderTimeout = null;
  this.autoPauseTimeout = null;
  this.pendingEncoderAttachDetach = null;
  this.desiredEncoderAttachState = false;
  this.flushEncodedInterval = null;
  this.groovePlaylist.pause();
  this.volume = this.groovePlaylist.gain;
  this.grooveEncoder.formatShortName = "mp3";
  this.grooveEncoder.codecShortName = "mp3";
  this.grooveEncoder.bitRate = 256 * 1000;

  this.importUrlFilters = [];
}

Player.prototype.initialize = function(cb) {
  var self = this;
  var startupTrackInfo = null;

  initLibrary(function(err) {
    if (err) return cb(err);
    cacheTracksArray(self);
    self.requestUpdateDb();
    cacheAllOptions(function(err) {
      if (err) return cb(err);
      setInterval(doPersistCurrentTrack, 10000);
      if (startupTrackInfo) {
        self.seek(startupTrackInfo.id, startupTrackInfo.pos);
      } else {
        playlistChanged(self);
      }
      lazyReplayGainScanPlaylist(self);
      cb();
    });
  });

  function initLibrary(cb) {
    var pend = new Pend();
    pend.go(cacheAllDb);
    pend.go(cacheAllDirs);
    pend.go(cacheAllQueue);
    pend.go(cacheAllPlaylists);
    pend.wait(cb);
  }

  function cacheAllPlaylists(cb) {
    cacheAllPlaylistMeta(function(err) {
      if (err) return cb(err);
      cacheAllPlaylistItems(cb);
    });

    function cacheAllPlaylistMeta(cb) {
      dbIterate(self.db, PLAYLIST_META_KEY_PREFIX, processOne, cb);
      function processOne(key, value) {
        log.debug("key:", key, "value:", value);
        var playlist = deserializePlaylist(value);
        self.playlists[playlist.id] = playlist;
      }
    }

    function cacheAllPlaylistItems(cb) {
      dbIterate(self.db, PLAYLIST_KEY_PREFIX, processOne, cb);
      function processOne(key, value) {
        var playlistIdEnd = key.indexOf('.', PLAYLIST_KEY_PREFIX.length);
        var playlistId = key.substring(PLAYLIST_KEY_PREFIX.length, playlistIdEnd);
        // TODO remove this once verified that it's working
        log.debug("playlistId", playlistId);
        var playlistItem = JSON.parse(value);
        self.playlists[playlistId].items[playlistItem.id] = playlistItem;
      }
    }
  }

  function cacheAllQueue(cb) {
    dbIterate(self.db, QUEUE_KEY_PREFIX, processOne, cb);
    function processOne(key, value) {
      var plEntry = JSON.parse(value);
      self.playlist[plEntry.id] = plEntry;
    }
  }

  function cacheAllOptions(cb) {
    var options = {
      repeat: null,
      dynamicModeOn: null,
      dynamicModeHistorySize: null,
      dynamicModeFutureSize: null,
      hardwarePlayback: null,
      volume: null,
      currentTrackInfo: null,
    };
    var pend = new Pend();
    for (var name in options) {
      pend.go(makeGetFn(name));
    }
    pend.wait(function(err) {
      if (err) return cb(err);
      if (options.repeat != null) {
        self.setRepeat(options.repeat);
      }
      if (options.dynamicModeOn != null) {
        self.setDynamicModeOn(options.dynamicModeOn);
      }
      if (options.dynamicModeHistorySize != null) {
        self.setDynamicModeHistorySize(options.dynamicModeHistorySize);
      }
      if (options.dynamicModeFutureSize != null) {
        self.setDynamicModeFutureSize(options.dynamicModeFutureSize);
      }
      if (options.volume != null) {
        self.setVolume(options.volume);
      }
      startupTrackInfo = options.currentTrackInfo;
      var hardwarePlaybackValue = options.hardwarePlayback == null ? true : options.hardwarePlayback;
      // start the hardware player first
      // fall back to dummy
      self.setHardwarePlayback(hardwarePlaybackValue, function(err) {
        if (err) {
          log.error("Unable to attach hardware player, falling back to dummy.", err.stack);
          self.setHardwarePlayback(false);
        }
        cb();
      });
    });

    function makeGetFn(name) {
      return function(cb) {
        self.db.get(PLAYER_KEY_PREFIX + name, function(err, value) {
          if (!err && value != null) {
            try {
              options[name] = JSON.parse(value);
            } catch (err) {
              cb(err);
              return;
            }
          }
          cb();
        });
      };
    }
  }

  function cacheAllDirs(cb) {
    dbIterate(self.db, LIBRARY_DIR_PREFIX, processOne, cb);
    function processOne(key, value) {
      var dirEntry = JSON.parse(value);
      self.dirs[dirEntry.dirName] = dirEntry;
    }
  }

  function cacheAllDb(cb) {
    var scrubCmds = [];
    dbIterate(self.db, LIBRARY_KEY_PREFIX, processOne, scrubAndCb);
    function processOne(key, value) {
      var dbFile = deserializeFileData(value);
      // scrub duplicates
      if (self.dbFilesByPath[dbFile.file]) {
        scrubCmds.push({type: 'del', key: key});
      } else {
        self.libraryIndex.addTrack(dbFile);
        self.dbFilesByPath[dbFile.file] = dbFile;
      }
    }
    function scrubAndCb() {
      if (scrubCmds.length === 0) return cb();
      log.warn("Scrubbing " + scrubCmds.length + " duplicate db entries");
      self.db.batch(scrubCmds, function(err) {
        if (err) log.error("Unable to scrub duplicate tracks from db:", err.stack);
        cb();
      });
    }
  }

  function doPersistCurrentTrack() {
    if (self.isPlaying) {
      self.persistCurrentTrack();
    }
  }
};

function startEncoderAttach(self, cb) {
  if (self.desiredEncoderAttachState) return;
  self.desiredEncoderAttachState = true;
  if (!self.pendingEncoderAttachDetach) {
    self.pendingEncoderAttachDetach = true;
    self.grooveEncoder.attach(self.groovePlaylist, function(err) {
      if (err) return cb(err);
      self.pendingEncoderAttachDetach = false;
      if (!self.desiredEncoderAttachState) startEncoderDetach(self, cb);
    });
  }
}

function startEncoderDetach(self, cb) {
  if (!self.desiredEncoderAttachState) return;
  self.desiredEncoderAttachState = false;
  if (!self.pendingEncoderAttachDetach) {
    self.pendingEncoderAttachDetach = true;
    self.grooveEncoder.detach(function(err) {
      if (err) return cb(err);
      self.pendingEncoderAttachDetach = false;
      if (self.desiredEncoderAttachState) startEncoderAttach(self, cb);
    });
  }
}

Player.prototype.getBufferedSeconds = function() {
  if (this.recentBuffers.length < 2) return 0;
  var firstPts = this.recentBuffers[0].pts;
  var lastPts = this.recentBuffers[this.recentBuffers.length - 1].pts;
  var frameCount = lastPts - firstPts;
  var sampleRate = this.grooveEncoder.actualAudioFormat.sampleRate;
  return frameCount / sampleRate;
};

Player.prototype.attachEncoder = function(cb) {
  var self = this;

  cb = cb || logIfError;

  if (self.flushEncodedInterval) return cb();

  log.debug("first streamer connected - attaching encoder");
  self.flushEncodedInterval = setInterval(flushEncoded, 100);

  startEncoderAttach(self, cb);

  function flushEncoded() {
    if (!self.desiredEncoderAttachState || self.pendingEncoderAttachDetach) return;

    var playHead = self.groovePlayer.position();
    if (!playHead.item) return;

    var plItems = self.groovePlaylist.items();

    // get rid of old items
    var buf;
    while (buf = self.recentBuffers[0]) {
      if (isBufOld(buf)) {
        self.recentBuffers.shift();
      } else {
        break;
      }
    }

    // poll the encoder for more buffers until either there are no buffers
    // available or we get enough buffered
    while (self.getBufferedSeconds() < self.encodeQueueDuration) {
      buf = self.grooveEncoder.getBuffer();
      if (!buf) break;
      if (buf.buffer) {
        if (buf.item) {
          if (self.expectHeaders) {
            log.debug("encoder: got first non-header");
            self.headerBuffers = self.newHeaderBuffers;
            self.newHeaderBuffers = [];
            self.expectHeaders = false;
          }
          self.recentBuffers.push(buf);
          for (var i = 0; i < self.openStreamers.length; i += 1) {
            self.openStreamers[i].write(buf.buffer);
          }
        } else if (self.expectHeaders) {
          // this is a header
          log.debug("encoder: got header");
          self.newHeaderBuffers.push(buf.buffer);
        } else {
          // it's a footer, ignore the fuck out of it
          log.debug("ignoring encoded audio footer");
        }
      } else {
        // end of playlist sentinel
        log.debug("encoder: end of playlist sentinel");
        if (self.queueClearEncodedBuffers) {
          self.queueClearEncodedBuffers = false;
          self.clearEncodedBuffer();
          self.emit('seek');
        }
        self.expectHeaders = true;
      }
    }

    function isBufOld(buf) {
      // typical case
      if (buf.item.id === playHead.item.id) {
        return playHead.pos > buf.pos;
      }
      // edge case
      var playHeadIndex = -1;
      var bufItemIndex = -1;
      for (var i = 0; i < plItems.length; i += 1) {
        var plItem = plItems[i];
        if (plItem.id === playHead.item.id) {
          playHeadIndex = i;
        } else if (plItem.id === buf.item.id) {
          bufItemIndex = i;
        }
      }
      return playHeadIndex > bufItemIndex;
    }
  }

  function logIfError(err) {
    if (err) {
      log.error("Unable to attach encoder:", err.stack);
    }
  }
};

Player.prototype.detachEncoder = function(cb) {
  cb = cb || logIfError;

  this.clearEncodedBuffer();
  this.queueClearEncodedBuffers = false;
  clearInterval(this.flushEncodedInterval);
  this.flushEncodedInterval = null;
  startEncoderDetach(this, cb);
  this.grooveEncoder.removeAllListeners();

  function logIfError(err) {
    if (err) {
      log.error("Unable to attach encoder:", err.stack);
    }
  }
};

Player.prototype.requestUpdateDb = function(dirName, forceRescan, cb) {
  var fullPath = path.resolve(this.musicDirectory, dirName || "");
  this.dirScanQueue.add(fullPath, {
    dir: fullPath,
    forceRescan: forceRescan,
  }, cb);
};

Player.prototype.refreshFilesIndex = function(args, cb) {
  var self = this;
  var dir = args.dir;
  var forceRescan = args.forceRescan;
  var dirWithSlash = ensureSep(dir);
  var walker = findit(dirWithSlash, {followSymlinks: true});
  var thisScanId = uuid();
  walker.on('directory', function(fullDirPath, stat, stop) {
    var dirName = path.relative(self.musicDirectory, fullDirPath);
    var baseName = path.basename(dirName);
    if (isFileIgnored(baseName)) {
      stop();
      return;
    }
    var dirEntry = self.getOrCreateDir(dirName, stat);
    if (fullDirPath === dirWithSlash) return; // ignore root search path
    var parentDirName = path.dirname(dirName);
    if (parentDirName === '.') parentDirName = '';
    var parentDirEntry = self.getOrCreateDir(parentDirName);
    parentDirEntry.dirEntries[baseName] = thisScanId;
  });
  walker.on('file', function(fullPath, stat) {
    var relPath = path.relative(self.musicDirectory, fullPath);
    var dirName = path.dirname(relPath);
    if (dirName === '.') dirName = '';
    var baseName = path.basename(relPath);
    if (isFileIgnored(baseName)) return;
    var dirEntry = self.getOrCreateDir(dirName);
    dirEntry.entries[baseName] = thisScanId;
    onAddOrChange(relPath, stat);
  });
  walker.on('error', function(err) {
    walker.stop();
    cb(err);
  });
  walker.on('end', function() {
    var dirName = path.relative(self.musicDirectory, dir);
    checkDirEntry(self.dirs[dirName]);
    cb();

    function checkDirEntry(dirEntry) {
      if (!dirEntry) return;
      var id;
      var baseName;
      var i;
      var deletedFiles = [];
      var deletedDirs = [];
      for (baseName in dirEntry.entries) {
        id = dirEntry.entries[baseName];
        if (id !== thisScanId) deletedFiles.push(baseName);
      }
      for (i = 0; i < deletedFiles.length; i += 1) {
        baseName = deletedFiles[i];
        delete dirEntry.entries[baseName];
        onFileMissing(dirEntry, baseName);
      }

      for (baseName in dirEntry.dirEntries) {
        id = dirEntry.dirEntries[baseName];
        var childEntry = self.dirs[path.join(dirEntry.dirName, baseName)];
        checkDirEntry(childEntry);
        if (id !== thisScanId) deletedDirs.push(baseName);
      }
      for (i = 0; i < deletedDirs.length; i += 1) {
        baseName = deletedDirs[i];
        delete dirEntry.dirEntries[baseName];
        onDirMissing(dirEntry, baseName);
      }

      self.persistDirEntry(dirEntry);
    }

  });

  function onDirMissing(parentDirEntry, baseName) {
    var dirName = path.join(parentDirEntry.dirName, baseName);
    log.debug("directory deleted:", dirName);
    var dirEntry = self.dirs[dirName];
    var watcher = dirEntry.watcher;
    if (watcher) watcher.close();
    delete self.dirs[dirName];
    delete parentDirEntry.dirEntries[baseName];
  }

  function onFileMissing(parentDirEntry, baseName) {
    var relPath = path.join(parentDirEntry.dirName, baseName);
    log.debug("file deleted:", relPath);
    delete parentDirEntry.entries[baseName];
    var dbFile = self.dbFilesByPath[relPath];
    if (dbFile) self.delDbEntry(dbFile);
  }

  function onAddOrChange(relPath, stat) {
    // check the mtime against the mtime of the same file in the db
    var dbFile = self.dbFilesByPath[relPath];
    var fileMtime = stat.mtime.getTime();

    if (dbFile && !forceRescan) {
      var dbMtime = dbFile.mtime;

      if (dbMtime >= fileMtime) {
        // the info we have in our db for this file is fresh
        return;
      }
    }
    self.addQueue.add(relPath, {
      relPath: relPath,
      mtime: fileMtime,
    });
  }
};

Player.prototype.watchDirEntry = function(dirEntry) {
  var self = this;
  var changeTriggered = null;
  var fullDirPath = path.join(self.musicDirectory, dirEntry.dirName);
  var watcher;
  try {
    watcher = fs.watch(fullDirPath, onChange);
    watcher.on('error', onWatchError);
  } catch (err) {
    log.error("Unable to fs.watch:", err.stack);
    watcher = null;
  }
  dirEntry.watcher = watcher;

  function onChange(eventName) {
    if (changeTriggered) clearTimeout(changeTriggered);
    changeTriggered = setTimeout(function() {
      changeTriggered = null;
      log.debug("dir updated:", dirEntry.dirName);
      self.dirScanQueue.add(fullDirPath, { dir: fullDirPath });
    }, 100);
  }

  function onWatchError(err) {
    log.error("watch error:", err.stack);
  }
};

Player.prototype.getOrCreateDir = function (dirName, stat) {
  var dirEntry = this.dirs[dirName];

  if (!dirEntry) {
    dirEntry = this.dirs[dirName] = {
      dirName: dirName,
      entries: {},
      dirEntries: {},
      watcher: null, // will be set just below
      mtime: stat && stat.mtime,
    };
  } else if (stat && dirEntry.mtime !== stat.mtime) {
    dirEntry.mtime = stat.mtime;
  }
  if (!dirEntry.watcher) this.watchDirEntry(dirEntry);
  return dirEntry;
};


Player.prototype.getCurPos = function() {
  return this.isPlaying ?
      ((new Date() - this.trackStartDate) / 1000.0) : this.pausedTime;
};

function startPlayerSwitchDevice(self, wantHardware, cb) {
  self.desiredPlayerHardwareState = wantHardware;
  if (self.pendingPlayerAttachDetach) return;

  self.pendingPlayerAttachDetach = true;
  if (self.groovePlayer) {
    self.groovePlayer.removeAllListeners();
    self.groovePlayer.detach(onDetachComplete);
  } else {
    onDetachComplete();
  }

  function onDetachComplete(err) {
    if (err) return cb(err);
    self.groovePlayer = groove.createPlayer();
    self.groovePlayer.deviceIndex = wantHardware ? null : groove.DUMMY_DEVICE;
    self.groovePlayer.attach(self.groovePlaylist, function(err) {
      self.pendingPlayerAttachDetach = false;
      if (err) return cb(err);
      if (self.desiredPlayerHardwareState !== wantHardware) {
        startPlayerSwitchDevice(self, self.desiredPlayerHardwareState, cb);
      } else {
        cb();
      }
    });
  }
}

Player.prototype.setHardwarePlayback = function(value, cb) {
  var self = this;

  cb = cb || logIfError;
  value = !!value;

  if (value === self.desiredPlayerHardwareState) return cb();

  startPlayerSwitchDevice(self, value, function(err) {
    if (err) return cb(err);

    self.clearEncodedBuffer();
    self.emit('seek');
    self.groovePlayer.on('nowplaying', onNowPlaying);
    self.persistOption('hardwarePlayback', self.desiredPlayerHardwareState);
    self.emit('hardwarePlayback', self.desiredPlayerHardwareState);
    cb();
  });

  function onNowPlaying() {
    var playHead = self.groovePlayer.position();
    var decodeHead = self.groovePlaylist.position();
    if (playHead.item) {
      var nowMs = (new Date()).getTime();
      var posMs = playHead.pos * 1000;
      self.trackStartDate = new Date(nowMs - posMs);
      self.currentTrack = self.grooveItems[playHead.item.id];
      playlistChanged(self);
      self.currentTrackChanged();
    } else if (!decodeHead.item) {
      if (!self.dontBelieveTheEndOfPlaylistSentinelItsATrap) {
        // both play head and decode head are null. end of playlist.
        log.debug("end of playlist");
        self.currentTrack = null;
        playlistChanged(self);
        self.currentTrackChanged();
      }
    }
  }

  function logIfError(err) {
    if (err) {
      log.error("Unable to set hardware playback mode:", err.stack);
    }
  }
};

Player.prototype.streamMiddleware = function(req, resp, next) {
  var self = this;
  if (req.path !== '/stream.mp3') return next();

  var cookies = new Cookies(req, resp);
  resp.token = cookies.get('token');

  resp.setHeader('Content-Type', 'audio/mpeg');
  resp.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  resp.setHeader('Pragma', 'no-cache');
  resp.setHeader('Expires', '0');
  resp.statusCode = 200;

  self.headerBuffers.forEach(function(headerBuffer) {
    resp.write(headerBuffer);
  });
  self.recentBuffers.forEach(function(recentBuffer) {
    resp.write(recentBuffer.buffer);
  });
  self.cancelDetachEncoderTimeout();
  self.attachEncoder();
  self.openStreamers.push(resp);
  self.emit('streamerConnect', resp);
  req.on('close', function() {
    for (var i = 0; i < self.openStreamers.length; i += 1) {
      if (self.openStreamers[i] === resp) {
        self.openStreamers.splice(i, 1);
        if (self.openStreamers.length === 0) {
          self.startDetachEncoderTimeout();
          if (self.autoPauseTimeout) {
            clearTimeout(self.autoPauseTimeout);
          }
          self.autoPauseTimeout = setTimeout(checkAutoPause, 500);
        } else {
          log.debug("streamer count:", self.openStreamers.length);
        }
        self.emit('streamerDisconnect', resp);
        break;
      }
    }
    resp.end();
  });

  function checkAutoPause() {
    self.autoPauseTimeout = null;
    // when last streamer disconnects, if hardware playback is off,
    // press pause
    if (!self.desiredPlayerHardwareState && self.openStreamers.length === 0) {
      self.pause();
    }
  }
};

Player.prototype.cancelDetachEncoderTimeout = function() {
  if (this.detachEncoderTimeout) {
    clearTimeout(this.detachEncoderTimeout);
    this.detachEncoderTimeout = null;
  }
};

Player.prototype.startDetachEncoderTimeout = function() {
  var self = this;
  self.cancelDetachEncoderTimeout();
  // we use encodeQueueDuration for the encoder timeout so that we are
  // guaranteed to have audio available for the encoder in the case of
  // detaching and reattaching the encoder.
  self.detachEncoderTimeout = setTimeout(timeout, self.encodeQueueDuration * 1000);

  function timeout() {
    if (self.openStreamers.length === 0 && self.isPlaying) {
      log.debug("last streamer disconnected. detaching encoder");
      self.detachEncoder();
    }
  }
};

Player.prototype.deleteFile = function(key) {
  var self = this;
  var dbFile = self.libraryIndex.trackTable[key];
  if (!dbFile) {
    log.error("Error deleting file - no entry:", key);
    return;
  }
  var fullPath = path.join(self.musicDirectory, dbFile.file);
  fs.unlink(fullPath, function(err) {
    if (err) {
      log.error("Error deleting", dbFile.file, err.stack);
    }
  });
  self.delDbEntry(dbFile);
};

Player.prototype.delDbEntry = function(dbFile) {
  // delete items from the queue that are being deleted from the library
  var deleteQueueItems = [];
  for (var queueId in this.playlist) {
    var queueItem = this.playlist[queueId];
    if (queueItem.key === dbFile.key) {
      deleteQueueItems.push(queueId);
    }
  }
  this.removeQueueItems(deleteQueueItems);

  this.libraryIndex.removeTrack(dbFile.key);
  delete this.dbFilesByPath[dbFile.file];
  var baseName = path.basename(dbFile.file);
  var parentDirName = path.dirname(dbFile.file);
  if (parentDirName === '.') parentDirName = '';
  var parentDirEntry = this.dirs[parentDirName];
  if (parentDirEntry) delete parentDirEntry[baseName];
  this.emit('deleteDbTrack', dbFile);
  this.db.del(LIBRARY_KEY_PREFIX + dbFile.key, function(err) {
    if (err) {
      log.error("Error deleting db entry", dbFile.key, err.stack);
    }
  });
};

Player.prototype.setVolume = function(value) {
  value = Math.min(2.0, value);
  value = Math.max(0.0, value);
  this.volume = value;
  this.groovePlaylist.setGain(value);
  this.persistOption('volume', this.volume);
  this.emit("volumeUpdate");
};

Player.prototype.importUrl = function(urlString, cb) {
  var self = this;
  cb = cb || logIfError;

  var tmpDir = path.join(self.musicDirectory, '.tmp');
  var filterIndex = 0;

  mkdirp(tmpDir, function(err) {
    if (err) return cb(err);

    tryImportFilter();
  });

  function tryImportFilter() {
    var importPlugin = self.importUrlFilters[filterIndex];
    if (importPlugin) {
      importPlugin.importUrl(urlString, callNextFilter);
    } else {
      downloadRaw();
    }
    function callNextFilter(err, dlStream, filename) {
      if (err || !dlStream) {
        if (err) log.error("import filter error, skipping:", err.stack);
        filterIndex += 1;
        tryImportFilter();
        return;
      }
      handleDownload(dlStream, filename);
    }
  }

  function downloadRaw() {
    var parsedUrl = url.parse(urlString);
    var remoteFilename = path.basename(parsedUrl.pathname);
    var decodedFilename;
    try {
      decodedFilename = decodeURI(remoteFilename);
    } catch (err) {
      decodedFilename = remoteFilename;
    }
    download(urlString, function(err, resp) {
      if (err) return cb(err);
      handleDownload(resp, decodedFilename);
    });
  }

  function handleDownload(req, remoteFilename) {
    var ext = path.extname(remoteFilename);
    var destPath = path.join(tmpDir, uuid() + ext);
    var ws = fs.createWriteStream(destPath);

    var calledCallback = false;
    req.pipe(ws);
    ws.on('close', function(){
      if (calledCallback) return;
      self.importFile(ws.path, remoteFilename, function(err, dbFile) {
        if (err) {
          cleanAndCb(err);
        } else {
          calledCallback = true;
          cb(null, dbFile);
        }
      });
    });
    ws.on('error', cleanAndCb);
    req.on('error', cleanAndCb);

    function cleanAndCb(err) {
      fs.unlink(destPath, function(err) {
        if (err) {
          log.warn("Unable to clean up temp file:", err.stack);
        }
      });
      if (calledCallback) return;
      calledCallback = true;
      cb(err);
    }
  }

  function logIfError(err) {
    if (err) {
      log.error("Unable to import by URL.", err.stack, "URL:", urlString);
    }
  }
};

// moves the file at srcFullPath to the music library
Player.prototype.importFile = function(srcFullPath, filenameHint, cb) {
  var self = this;
  cb = cb || logIfError;

  log.debug("importFile open file:", srcFullPath);
  groove.open(srcFullPath, function(err, file) {
    if (err) return cb(err);
    var newDbFile = grooveFileToDbFile(file, filenameHint);
    var suggestedPath = self.getSuggestedPath(newDbFile, filenameHint);
    var pend = new Pend();
    pend.go(function(cb) {
      log.debug("importFile close file:", file.filename);
      file.close(cb);
    });
    pend.go(function(cb) {
      tryMv(suggestedPath, cb);
    });
    pend.wait(function(err) {
      if (err) return cb(err);
      cb(null, newDbFile);
    });

    function tryMv(destRelPath, cb) {
      var destFullPath = path.join(self.musicDirectory, destRelPath);
      mv(srcFullPath, destFullPath, {mkdirp: true, clobber: false}, function(err) {
        if (err) {
          if (err.code === 'EEXIST') {
            tryMv(uniqueFilename(destRelPath), cb);
          } else {
            cb(err);
          }
          return;
        }
        // in case it doesn't get picked up by a watcher
        self.requestUpdateDb(path.dirname(destRelPath), false, function(err) {
          if (err) return cb(err);
          self.addQueue.waitForId(destRelPath, function(err) {
            if (err) return cb(err);
            newDbFile = self.dbFilesByPath[destRelPath];
            cb();
          });
        });
      });
    }
  });

  function logIfError(err) {
    if (err) {
      log.error("unable to import file:", err.stack);
    }
  }
};

Player.prototype.persistDirEntry = function(dirEntry, cb) {
  cb = cb || logIfError;
  this.db.put(LIBRARY_DIR_PREFIX + dirEntry.dirName, serializeDirEntry(dirEntry), cb);

  function logIfError(err) {
    if (err) {
      log.error("unable to persist db entry:", dirEntry, err.stack);
    }
  }
};

Player.prototype.persist = function(dbFile, cb) {
  cb = cb || logIfError;
  var prevDbFile = this.libraryIndex.trackTable[dbFile.key];
  this.libraryIndex.addTrack(dbFile);
  this.dbFilesByPath[dbFile.file] = dbFile;
  this.emit('update', prevDbFile, dbFile);
  this.db.put(LIBRARY_KEY_PREFIX + dbFile.key, serializeFileData(dbFile), cb);

  function logIfError(err) {
    if (err) {
      log.error("unable to persist db entry:", dbFile, err.stack);
    }
  }
};

Player.prototype.persistPlaylistItem = function(playlist, item, cb) {
  var key = playlistItemKey(playlist, item);
  this.db.put(key, serializePlaylistItem(item), cb || logIfError);

  function logIfError(err) {
    if (err) {
      log.error("unable to persist playlist item:", item, err.stack);
    }
  }
};

Player.prototype.persistQueueItem = function(item, cb) {
  this.db.put(QUEUE_KEY_PREFIX + item.id, serializeQueueItem(item), cb || logIfError);

  function logIfError(err) {
    if (err) {
      log.error("unable to persist queue item:", item, err.stack);
    }
  }
};

Player.prototype.persistOption = function(name, value, cb) {
  this.db.put(PLAYER_KEY_PREFIX + name, JSON.stringify(value), cb || logIfError);
  function logIfError(err) {
    if (err) {
      log.error("unable to persist player option:", err.stack);
    }
  }
};

Player.prototype.addToLibrary = function(args, cb) {
  var self = this;
  var relPath = args.relPath;
  var mtime = args.mtime;
  var fullPath = path.join(self.musicDirectory, relPath);
  log.debug("addToLibrary open file:", fullPath);
  groove.open(fullPath, function(err, file) {
    if (err) {
      self.invalidPaths[relPath] = err.message;
      cb();
      return;
    }
    var dbFile = self.dbFilesByPath[relPath];
    var eventType = dbFile ? 'updateDbTrack' : 'addDbTrack';
    var newDbFile = grooveFileToDbFile(file, relPath, dbFile);
    newDbFile.file = relPath;
    newDbFile.mtime = mtime;
    var pend = new Pend();
    pend.go(function(cb) {
      log.debug("addToLibrary close file:", file.filename);
      file.close(cb);
    });
    pend.go(function(cb) {
      self.persist(newDbFile, function(err) {
        if (err) log.error("Error saving", relPath, "to db:", err.stack);
        cb();
      });
    });
    self.emit(eventType, newDbFile);
    pend.wait(cb);
  });
};

Player.prototype.updateTags = function(obj) {
  for (var key in obj) {
    var track = this.libraryIndex.trackTable[key];
    if (!track) continue;
    var props = obj[key];
    if (!props || typeof props !== 'object') continue;
    for (var propName in DB_PROPS) {
      var prop = DB_PROPS[propName];
      if (! prop.write) continue;
      if (! (propName in props)) continue;
      var parser = PROP_TYPE_PARSERS[prop.type];
      track[propName] = parser(props[propName]);
    }
    this.persist(track);
    this.emit('updateDbTrack', track);
  }
};

Player.prototype.insertTracks = function(index, keys, tagAsRandom) {
  if (keys.length === 0) return;
  if (index < 0) index = 0;
  if (index > this.tracksInOrder.length) index = this.tracksInOrder.length;

  var trackBeforeIndex = this.tracksInOrder[index - 1];
  var trackAtIndex = this.tracksInOrder[index];

  var prevSortKey = trackBeforeIndex ? trackBeforeIndex.sortKey : null;
  var nextSortKey = trackAtIndex ? trackAtIndex.sortKey : null;

  var items = {};
  var ids = [];
  keys.forEach(function(key) {
    var id = uuid();
    var thisSortKey = keese(prevSortKey, nextSortKey);
    prevSortKey = thisSortKey;
    items[id] = {
      key: key,
      sortKey: thisSortKey,
    };
    ids.push(id);
  });
  this.addItems(items, tagAsRandom);
  return ids;
};

Player.prototype.appendTracks = function(keys, tagAsRandom) {
  return this.insertTracks(this.tracksInOrder.length, keys, tagAsRandom);
};

// items looks like {id: {key, sortKey}}
Player.prototype.addItems = function(items, tagAsRandom) {
  var self = this;
  tagAsRandom = !!tagAsRandom;
  for (var id in items) {
    var item = items[id];
    var dbFile = self.libraryIndex.trackTable[item.key];
    if (!dbFile) continue;
    dbFile.lastQueueDate = new Date();
    self.persist(dbFile);
    var queueItem = {
      id: id,
      key: item.key,
      sortKey: item.sortKey,
      isRandom: tagAsRandom,
      grooveFile: null,
      pendingGrooveFile: false,
      deleted: false,
    };
    self.playlist[id] = queueItem;
    self.persistQueueItem(queueItem);
  }
  playlistChanged(self);
  lazyReplayGainScanPlaylist(self);
};

Player.prototype.playlistCreate = function(id, name) {
  var playlist = {
    id: id,
    name: name,
    items: {},
  };
  this.playlists[playlist.id] = playlist;
  this.persistPlaylist(playlist);
  this.emit('playlistCreate', playlist);
};

Player.prototype.playlistRename = function(playlistId, newName) {
  var playlist = this.playlists[playlistId];
  if (!playlist) return;

  playlist.name = newName;
  this.persistPlaylist(playlist);
  this.emit('playlistUpdate', playlist);
};

Player.prototype.playlistDelete = function(playlistIds) {
  var delCmds = [];
  for (var i = 0; i < playlistIds.length; i += 1) {
    var playlistId = playlistIds[i];
    var playlist = this.playlists[playlistId];
    if (!playlist) continue;

    for (var id in playlist.items) {
      var item = playlist[id].items[id];
      if (!item) continue;

      delCmds.push({type: 'del', key: playlistItemKey(playlist, item)});
      delete playlist.items[id];
    }
    delCmds.push({type: 'del', key: playlistKey(playlist)});
    delete this.playlists[playlistId];
  }

  if (delCmds.length > 0) {
    this.db.batch(delCmds, logIfError);
    this.emit('playlistDelete');
  }

  function logIfError(err) {
    if (err) {
      log.error("Error deleting playlist entries from db:", err.stack);
    }
  }
};

Player.prototype.playlistAddItems = function(playlistId, items) {
  var playlist = this.playlists[playlistId];
  if (!playlist) return;

  for (var id in items) {
    var item = items[id];
    var dbFile = this.libraryIndex.trackTable[item.key];
    if (!dbFile) continue;
    var playlistItem = {
      id: id,
      key: item.key,
      sortKey: item.sortKey,
    };
    playlist[id] = playlistItem;
    this.persistPlaylistItem(playlist, playlistItem);
  }

  this.emit('playlistUpdate');
};

Player.prototype.playlistRemoveItems = function(playlistId, ids) {
  if (ids.length === 0) return;

  var playlist = this.playlists[playlistId];
  if (!playlist) return;

  var delCmds = [];
  for (var i = 0; i < ids.length; i += 1) {
    var id = ids[i];
    var item = playlist[id];
    if (!item) continue;

    delCmds.push({type: 'del', key: playlistItemKey(playlist, item)});
    delete playlist[id];
  }
  if (delCmds.length > 0) {
    this.db.batch(delCmds, logIfError);
    this.emit('playlistUpdate', playlist);
  }

  function logIfError(err) {
    if (err) {
      log.error("Error deleting playlist entries from db:", err.stack);
    }
  }
};

// items looks like {id: {sortKey}}
Player.prototype.playlistMoveItems = function(playlistId, items) {
  var playlist = this.playlists[playlistId];
  if (!playlist) return;

  for (var id in items) {
    var item = playlist[id];
    if (!item) continue; // race conditions, etc.
    item.sortKey = items[id].sortKey;
    this.persistPlaylistItem(playlist, item);
  }
  this.emit('playlistUpdate', playlist);
};

Player.prototype.persistPlaylist = function(playlist, cb) {
  cb = cb || logIfError;
  var key = playlistKey(playlist);
  var payload = serializePlaylist(playlist);
  this.db.put(key, payload, cb);

  function logIfError(err) {
    if (err) {
      log.error("unable to persist playlist:", err.stack);
    }
  }
};

Player.prototype.clearQueue = function() {
  this.removeQueueItems(Object.keys(this.playlist));
};

Player.prototype.shufflePlaylist = function() {
  shuffle(this.tracksInOrder);
  // fix sortKey and index properties
  var nextSortKey = keese(null, null);
  for (var i = 0; i < this.tracksInOrder.length; i += 1) {
    var track = this.tracksInOrder[i];
    track.index = i;
    track.sortKey = nextSortKey;
    this.persistQueueItem(track);
    nextSortKey = keese(nextSortKey, null);
  }
  playlistChanged(this);
};

Player.prototype.removeQueueItems = function(ids) {
  if (ids.length === 0) return;
  var delCmds = [];
  var currentTrackChanged = false;
  for (var i = 0; i < ids.length; i += 1) {
    var id = ids[i];
    var item = this.playlist[id];
    if (!item) continue;

    delCmds.push({type: 'del', key: QUEUE_KEY_PREFIX + id});

    if (item.grooveFile) this.playlistItemDeleteQueue.push(item);
    if (item === this.currentTrack) {
      var nextPos = this.currentTrack.index + 1;
      for (;;) {
        var nextTrack = this.tracksInOrder[nextPos];
        var nextTrackId = nextTrack && nextTrack.id;
        this.currentTrack = nextTrackId && this.playlist[nextTrack.id];
        if (!this.currentTrack && nextPos < this.tracksInOrder.length) {
          nextPos += 1;
          continue;
        }
        break;
      }
      if (this.currentTrack) {
        this.seekRequestPos = 0;
      }
      currentTrackChanged = true;
    }

    delete this.playlist[id];
  }
  if (delCmds.length > 0) this.db.batch(delCmds, logIfError);

  playlistChanged(this);
  if (currentTrackChanged) {
    this.currentTrackChanged();
  }

  function logIfError(err) {
    if (err) {
      log.error("Error deleting playlist entries from db:", err.stack);
    }
  }
};

// items looks like {id: {sortKey}}
Player.prototype.moveQueueItems = function(items) {
  for (var id in items) {
    var track = this.playlist[id];
    if (!track) continue; // race conditions, etc.
    track.sortKey = items[id].sortKey;
    this.persistQueueItem(track);
  }
  playlistChanged(this);
};

Player.prototype.moveRangeToPos = function(startPos, endPos, toPos) {
  var ids = [];
  for (var i = startPos; i < endPos; i += 1) {
    var track = this.tracksInOrder[i];
    if (!track) continue;

    ids.push(track.id);
  }
  this.moveIdsToPos(ids, toPos);
};

Player.prototype.moveIdsToPos = function(ids, toPos) {
  var trackBeforeIndex = this.tracksInOrder[toPos - 1];
  var trackAtIndex = this.tracksInOrder[toPos];

  var prevSortKey = trackBeforeIndex ? trackBeforeIndex.sortKey : null;
  var nextSortKey = trackAtIndex ? trackAtIndex.sortKey : null;

  for (var i = 0; i < ids.length; i += 1) {
    var id = ids[i];
    var queueItem = this.playlist[id];
    if (!queueItem) continue;

    var thisSortKey = keese(prevSortKey, nextSortKey);
    prevSortKey = thisSortKey;
    queueItem.sortKey = thisSortKey;
    this.persistQueueItem(queueItem);
  }
  playlistChanged(this);
};

Player.prototype.pause = function() {
  if (!this.isPlaying) return;
  this.isPlaying = false;
  this.pausedTime = (new Date() - this.trackStartDate) / 1000;
  this.groovePlaylist.pause();
  this.cancelDetachEncoderTimeout();
  playlistChanged(this);
  this.currentTrackChanged();
};

Player.prototype.play = function() {
  if (!this.currentTrack) {
    this.currentTrack = this.tracksInOrder[0];
  } else if (!this.isPlaying) {
    this.trackStartDate = new Date(new Date() - this.pausedTime * 1000);
  }
  this.groovePlaylist.play();
  this.startDetachEncoderTimeout();
  this.isPlaying = true;
  playlistChanged(this);
  this.currentTrackChanged();
};

// This function should be avoided in favor of seek. Note that it is called by
// some MPD protocol commands, because the MPD protocol is stupid.
Player.prototype.seekToIndex = function(index, pos) {
  this.currentTrack = this.tracksInOrder[index];
  this.seekRequestPos = pos;
  playlistChanged(this);
  this.currentTrackChanged();
};

Player.prototype.seek = function(id, pos) {
  this.currentTrack = this.playlist[id];
  this.seekRequestPos = pos;
  playlistChanged(this);
  this.currentTrackChanged();
};

Player.prototype.next = function() {
  this.skipBy(1);
};

Player.prototype.prev = function() {
  this.skipBy(-1);
};

Player.prototype.skipBy = function(amt) {
  var defaultIndex = amt > 0 ? -1 : this.tracksInOrder.length;
  var currentIndex = this.currentTrack ? this.currentTrack.index : defaultIndex;
  var newIndex = currentIndex + amt;
  this.seekToIndex(newIndex, 0);
};

Player.prototype.setRepeat = function(value) {
  value = Math.floor(value);
  if (value !== Player.REPEAT_ONE &&
      value !== Player.REPEAT_ALL &&
      value !== Player.REPEAT_OFF)
  {
    return;
  }
  if (value === this.repeat) return;
  this.repeat = value;
  this.persistOption('repeat', this.repeat);
  playlistChanged(this);
  this.emit('repeatUpdate');
};

Player.prototype.setDynamicModeOn = function(value) {
  value = !!value;
  if (value === this.dynamicModeOn) return;
  this.dynamicModeOn = value;
  this.persistOption('dynamicModeOn', this.dynamicModeOn);
  this.emit('dynamicModeOn');
  this.checkDynamicMode();
};

Player.prototype.setDynamicModeHistorySize = function(value) {
  value = Math.floor(value);
  if (value === this.dynamicModeHistorySize) return;
  this.dynamicModeHistorySize = value;
  this.persistOption('dynamicModeHistorySize', this.dynamicModeHistorySize);
  this.emit('dynamicModeHistorySize');
  this.checkDynamicMode();
};

Player.prototype.setDynamicModeFutureSize = function(value) {
  value = Math.floor(value);
  if (value === this.dynamicModeFutureSize) return;
  this.dynamicModeFutureSize = value;
  this.persistOption('dynamicModeFutureSize', this.dynamicModeFutureSize);
  this.emit('dynamicModeFutureSize');
  this.checkDynamicMode();
};

Player.prototype.stop = function() {
  this.isPlaying = false;
  this.cancelDetachEncoderTimeout();
  this.groovePlaylist.pause();
  this.seekRequestPos = 0;
  this.pausedTime = 0;
  playlistChanged(this);
};

Player.prototype.clearEncodedBuffer = function() {
  while (this.recentBuffers.length > 0) {
    this.recentBuffers.shift();
  }
};

Player.prototype.getSuggestedPath = function(track, filenameHint) {
  var p = "";
  if (track.albumArtistName) {
    p = path.join(p, safePath(track.albumArtistName));
  } else if (track.compilation) {
    p = path.join(p, safePath(this.libraryIndex.variousArtistsName));
  } else if (track.artistName) {
    p = path.join(p, safePath(track.artistName));
  }
  if (track.albumName) {
    p = path.join(p, safePath(track.albumName));
  }
  var t = "";
  if (track.track != null) {
    t += safePath(zfill(track.track, 2)) + " ";
  }
  t += safePath(track.name + path.extname(filenameHint));
  return path.join(p, t);
};

Player.prototype.queueScan = function(dbFile) {
  var self = this;

  var scanKey, scanType;
  if (dbFile.albumName) {
    scanType = 'album';
    scanKey = self.libraryIndex.getAlbumKey(dbFile);
  } else {
    scanType = 'track';
    scanKey = dbFile.key;
  }

  if (self.scanQueue.idInQueue(scanKey)) {
    return;
  }
  self.scanQueue.add(scanKey, {
    type: scanType,
    key: scanKey,
  });
};

Player.prototype.performScan = function(args, cb) {
  var self = this;
  var scanType = args.type;
  var scanKey = args.key;

  // build list of files we want to open
  var dbFilesToOpen;
  if (scanType === 'album') {
    var albumKey = scanKey;
    self.libraryIndex.rebuild();
    var album = self.libraryIndex.albumTable[albumKey];
    if (!album) {
      log.warn("wanted to scan album with key", JSON.stringify(albumKey), "but no longer exists.");
      cb();
      return;
    }
    log.debug("Scanning album for loudness:", JSON.stringify(albumKey));
    dbFilesToOpen = album.trackList;
  } else if (scanType === 'track') {
    var trackKey = scanKey;
    var dbFile = self.libraryIndex.trackTable[trackKey];
    log.debug("Scanning track for loudness:", JSON.stringify(trackKey));
    dbFilesToOpen = [dbFile];
  } else {
    throw new Error("unexpected scan type: " + scanType);
  }

  // open all the files in the list
  var pend = new Pend();
  // we're already doing multiple parallel scans. within each scan let's
  // read one thing at a time to avoid slamming the system.
  pend.max = 1;

  var grooveFileList = [];
  var files = {};
  dbFilesToOpen.forEach(function(dbFile) {
    pend.go(function(cb) {
      var fullPath = path.join(self.musicDirectory, dbFile.file);
      log.debug("performScan open file:", fullPath);
      groove.open(fullPath, function(err, file) {
        if (err) {
          log.error("Error opening", fullPath, "in order to scan:", err.stack);
        } else {
          var fileInfo;
          files[file.id] = fileInfo = {
            dbFile: dbFile,
            loudnessDone: false,
            fingerprintDone: false,
          };
          self.ongoingScans[dbFile.key] = fileInfo;
          grooveFileList.push(file);
        }
        cb();
      });
    });
  });

  var scanPlaylist;
  var endOfPlaylistPend = new Pend();

  var scanDetector;
  var scanDetectorAttached = false;
  var endOfDetectorCb;

  var scanFingerprinter;
  var scanFingerprinterAttached = false;
  var endOfFingerprinterCb;

  pend.wait(function() {
    // emit this because we updated ongoingScans
    self.emit('scanProgress');

    scanPlaylist = groove.createPlaylist();
    scanPlaylist.setFillMode(groove.ANY_SINK_FULL);
    scanDetector = groove.createLoudnessDetector();
    scanFingerprinter = groove.createFingerprinter();

    scanDetector.on('info', onLoudnessInfo);
    scanFingerprinter.on('info', onFingerprinterInfo);

    var pend = new Pend();
    pend.go(attachLoudnessDetector);
    pend.go(attachFingerprinter);
    pend.wait(onEverythingAttached);
  });

  function onEverythingAttached(err) {
    if (err) {
      log.error("Error attaching:", err.stack);
      cleanupAndCb();
      return;
    }

    grooveFileList.forEach(function(file) {
      scanPlaylist.insert(file);
    });

    endOfPlaylistPend.wait(function() {
      for (var fileId in files) {
        var fileInfo = files[fileId];
        var dbFile = fileInfo.dbFile;
        self.persist(dbFile);
        self.emit('scanComplete', dbFile);
      }
      cleanupAndCb();
    });
  }

  function attachLoudnessDetector(cb) {
    scanDetector.attach(scanPlaylist, function(err) {
      if (err) return cb(err);
      scanDetectorAttached = true;
      endOfPlaylistPend.go(function(cb) {
        endOfDetectorCb = cb;
      });
      cb();
    });
  }

  function attachFingerprinter(cb) {
    scanFingerprinter.attach(scanPlaylist, function(err) {
      if (err) return cb(err);
      scanFingerprinterAttached = true;
      endOfPlaylistPend.go(function(cb) {
        endOfFingerprinterCb = cb;
      });
      cb();
    });
  }

  function onLoudnessInfo() {
    var info;
    while (info = scanDetector.getInfo()) {
      var gain = groove.loudnessToReplayGain(info.loudness);
      var dbFile;
      var fileInfo;
      if (info.item) {
        fileInfo = files[info.item.file.id];
        fileInfo.loudnessDone = true;
        dbFile = fileInfo.dbFile;
        log.info("loudness scan file complete:", dbFile.name,
            "gain", gain, "duration", info.duration);
        dbFile.replayGainTrackGain = gain;
        dbFile.replayGainTrackPeak = info.peak;
        dbFile.duration = info.duration;
        checkUpdateGroovePlaylist(self);
        self.emit('scanProgress');
      } else {
        log.debug("loudness scan complete:", JSON.stringify(scanKey), "gain", gain);
        for (var fileId in files) {
          fileInfo = files[fileId];
          dbFile = fileInfo.dbFile;
          dbFile.replayGainAlbumGain = gain;
          dbFile.replayGainAlbumPeak = info.peak;
        }
        checkUpdateGroovePlaylist(self);
        if (endOfDetectorCb) {
          endOfDetectorCb();
          endOfDetectorCb = null;
        }
        return;
      }
    }
  }

  function onFingerprinterInfo() {
    var info;
    while (info = scanFingerprinter.getInfo()) {
      if (info.item) {
        var fileInfo = files[info.item.file.id];
        fileInfo.fingerprintDone = true;
        var dbFile = fileInfo.dbFile;
        log.info("fingerprint scan file complete:", dbFile.name);
        dbFile.fingerprint = info.fingerprint;
        self.emit('scanProgress');
      } else {
        log.debug("fingerprint scan complete:", JSON.stringify(scanKey));
        if (endOfFingerprinterCb) {
          endOfFingerprinterCb();
          endOfFingerprinterCb = null;
        }
        return;
      }
    }
  }

  function cleanupAndCb() {
    grooveFileList.forEach(function(file) {
      pend.go(function(cb) {
        var fileInfo = files[file.id];
        var dbFile = fileInfo.dbFile;
        delete self.ongoingScans[dbFile.key];
        log.debug("performScan close file:", file.filename);
        file.close(cb);
      });
    });
    if (scanDetectorAttached) pend.go(detachLoudnessScanner);
    if (scanFingerprinterAttached) pend.go(detachFingerprinter);
    pend.wait(function(err) {
      // emit this because we changed ongoingScans above
      self.emit('scanProgress');
      cb(err);
    });
  }

  function detachLoudnessScanner(cb) {
    scanDetector.detach(cb);
  }

  function detachFingerprinter(cb) {
    scanFingerprinter.detach(cb);
  }
};

Player.prototype.checkDynamicMode = function() {
  var self = this;
  if (!self.dynamicModeOn) return;

  // if no track is playing, assume the first track is about to be
  var currentIndex = self.currentTrack ? self.currentTrack.index : 0;

  var deleteCount = Math.max(currentIndex - self.dynamicModeHistorySize, 0);
  if (self.dynamicModeHistorySize < 0) deleteCount = 0;
  var addCount = Math.max(self.dynamicModeFutureSize + 1 - (self.tracksInOrder.length - currentIndex), 0);

  var idsToDelete = [];
  for (var i = 0; i < deleteCount; i += 1) {
    idsToDelete.push(self.tracksInOrder[i].id);
  }
  var keys = getRandomSongKeys(addCount);
  self.removeQueueItems(idsToDelete);
  self.appendTracks(keys, true);

  function getRandomSongKeys(count) {
    if (count === 0) return [];
    var neverQueued = [];
    var sometimesQueued = [];
    for (var key in self.libraryIndex.trackTable) {
      var dbFile = self.libraryIndex.trackTable[key];
      if (dbFile.lastQueueDate == null) {
        neverQueued.push(dbFile);
      } else {
        sometimesQueued.push(dbFile);
      }
    }
    // backwards by time
    sometimesQueued.sort(function(a, b) {
      return b.lastQueueDate - a.lastQueueDate;
    });
    // distribution is a triangle for ever queued, and a rectangle for never queued
    //    ___
    //   /| |
    //  / | |
    // /__|_|
    var maxWeight = sometimesQueued.length;
    var triangleArea = Math.floor(maxWeight * maxWeight / 2);
    if (maxWeight === 0) maxWeight = 1;
    var rectangleArea = maxWeight * neverQueued.length;
    var totalSize = triangleArea + rectangleArea;
    if (totalSize === 0) return [];
    // decode indexes through the distribution shape
    var keys = [];
    for (var i = 0; i < count; i += 1) {
      var index = Math.random() * totalSize;
      if (index < triangleArea) {
        // triangle
        keys.push(sometimesQueued[Math.floor(Math.sqrt(index))].key);
      } else {
        keys.push(neverQueued[Math.floor((index - triangleArea) / maxWeight)].key);
      }
    }
    return keys;
  }
};

Player.prototype.currentTrackChanged = function() {
  this.persistCurrentTrack();
  this.emit('currentTrack');
};

Player.prototype.persistCurrentTrack = function(cb) {
  // save the current track and time to db
  var currentTrackInfo = {
    id: this.currentTrack && this.currentTrack.id,
    pos: this.getCurPos(),
  };
  this.persistOption('currentTrackInfo', currentTrackInfo, cb);
};

function operatorCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function disambiguateSortKeys(self) {
  var previousUniqueKey = null;
  var previousKey = null;
  self.tracksInOrder.forEach(function(track, i) {
    if (track.sortKey === previousKey) {
      // move the repeat back
      track.sortKey = keese(previousUniqueKey, track.sortKey);
      previousUniqueKey = track.sortKey;
    } else {
      previousUniqueKey = previousKey;
      previousKey = track.sortKey;
    }
  });
}

// generate self.tracksInOrder from self.playlist
function cacheTracksArray(self) {
  self.tracksInOrder = Object.keys(self.playlist).map(trackById);
  self.tracksInOrder.sort(asc);
  self.tracksInOrder.forEach(function(track, index) {
    track.index = index;
  });

  function asc(a, b) {
    return operatorCompare(a.sortKey, b.sortKey);
  }
  function trackById(id) {
    return self.playlist[id];
  }
}

function lazyReplayGainScanPlaylist(self) {
  // clear the queue since we're going to completely rebuild it anyway
  // this allows the following priority code to work.
  self.scanQueue.clear();

  // prioritize the currently playing track, followed by the next tracks,
  // followed by the previous tracks
  var albumGain = {};
  var start1 = self.currentTrack ? self.currentTrack.index : 0;
  var i;
  for (i = start1; i < self.tracksInOrder.length; i += 1) {
    checkScan(self.tracksInOrder[i]);
  }
  for (i = 0; i < start1; i += 1) {
    checkScan(self.tracksInOrder[i]);
  }

  function checkScan(track) {
    var dbFile = self.libraryIndex.trackTable[track.key];
    if (!dbFile) return;
    var albumKey = self.libraryIndex.getAlbumKey(dbFile);
    var needScan =
        dbFile.fingerprint == null ||
        dbFile.replayGainAlbumGain == null ||
        dbFile.replayGainTrackGain == null ||
        (dbFile.albumName && albumGain[albumKey] && albumGain[albumKey] !== dbFile.replayGainAlbumGain);
    if (needScan) {
      self.queueScan(dbFile);
    } else {
      albumGain[albumKey] = dbFile.replayGainAlbumGain;
    }
  }
}

function playlistChanged(self) {
  cacheTracksArray(self);
  disambiguateSortKeys(self);

  if (self.currentTrack) {
    self.tracksInOrder.forEach(function(track, index) {
      var prevDiff = self.currentTrack.index - index;
      var nextDiff = index - self.currentTrack.index;
      var withinPrev = prevDiff <= PREV_FILE_COUNT && prevDiff >= 0;
      var withinNext = nextDiff <= NEXT_FILE_COUNT && nextDiff >= 0;
      var shouldHaveGrooveFile = withinPrev || withinNext;
      var hasGrooveFile = track.grooveFile != null || track.pendingGrooveFile;
      if (hasGrooveFile && !shouldHaveGrooveFile) {
        removePreloadFromTrack(self, track);
      } else if (!hasGrooveFile && shouldHaveGrooveFile) {
        preloadFile(self, track);
      }
    });
  } else {
    self.isPlaying = false;
    self.cancelDetachEncoderTimeout();
    self.trackStartDate = null;
    self.pausedTime = 0;
  }
  checkUpdateGroovePlaylist(self);
  performGrooveFileDeletes(self);

  self.checkDynamicMode();

  self.emit('queueUpdate');
}

function performGrooveFileDeletes(self) {
  while (self.playlistItemDeleteQueue.length) {
    var item = self.playlistItemDeleteQueue.shift();
    // we set this so that any callbacks that return which were trying to
    // set the grooveItem can check if the item got deleted
    item.deleted = true;
    log.debug("performGrooveFileDeletes close file:", item.grooveFile.filename);
    closeFile(item.grooveFile);
  }
}

function preloadFile(self, track) {
  var relPath = self.libraryIndex.trackTable[track.key].file;
  var fullPath = path.join(self.musicDirectory, relPath);
  track.pendingGrooveFile = true;

  log.debug("preloadFile open file:", fullPath);
  groove.open(fullPath, function(err, file) {
    track.pendingGrooveFile = false;
    if (err) {
      log.error("Error opening", relPath, err.stack);
      return;
    }
    if (track.deleted) {
      log.debug("preloadFile close file:", file.filename);
      closeFile(file);
      return;
    }
    track.grooveFile = file;
    checkUpdateGroovePlaylist(self);
  });
}

function checkUpdateGroovePlaylist(self) {
  if (!self.currentTrack) {
    self.groovePlaylist.clear();
    self.grooveItems = {};
    return;
  }

  var groovePlaylist = self.groovePlaylist.items();
  var playHead = self.groovePlayer.position();
  var playHeadItemId = playHead.item && playHead.item.id;
  var groovePlIndex = 0;
  var grooveItem;

  if (playHeadItemId) {
    while (groovePlIndex < groovePlaylist.length) {
      grooveItem = groovePlaylist[groovePlIndex];
      if (grooveItem.id === playHeadItemId) break;
      // this groove playlist item is before the current playhead. delete it!
      self.groovePlaylist.remove(grooveItem);
      delete self.grooveItems[grooveItem.id];
      groovePlIndex += 1;
    }
  }

  var plItemIndex = self.currentTrack.index;
  var plTrack;
  var currentGrooveItem = null; // might be different than playHead.item
  var groovePlItemCount = 0;
  var gainAndPeak;
  while (groovePlIndex < groovePlaylist.length) {
    grooveItem = groovePlaylist[groovePlIndex];
    var grooveTrack = self.grooveItems[grooveItem.id];
    // now we have deleted all items before the current track. we are now
    // comparing the libgroove playlist and the groovebasin playlist
    // side by side.
    plTrack = self.tracksInOrder[plItemIndex];
    if (grooveTrack === plTrack) {
      // if they're the same, we advance
      // but we might have to correct the gain
      gainAndPeak = calcGainAndPeak(plTrack);
      self.groovePlaylist.setItemGain(grooveItem, gainAndPeak.gain);
      self.groovePlaylist.setItemPeak(grooveItem, gainAndPeak.peak);
      currentGrooveItem = currentGrooveItem || grooveItem;
      groovePlIndex += 1;
      incrementPlIndex();
      continue;
    }

    // this groove track is wrong. delete it.
    self.groovePlaylist.remove(grooveItem);
    delete self.grooveItems[grooveItem.id];
    groovePlIndex += 1;
  }

  // we still need to add more libgroove playlist items, but this one has
  // not yet finished loading from disk. We must take note of this so that
  // if we receive the end of playlist sentinel, we start playback again
  // once this track has finished loading.
  self.dontBelieveTheEndOfPlaylistSentinelItsATrap = true;
  while (groovePlItemCount < NEXT_FILE_COUNT) {
    plTrack = self.tracksInOrder[plItemIndex];
    if (!plTrack) {
      // we hit the end of the groove basin playlist. we're done adding tracks
      // to the libgroove playlist.
      self.dontBelieveTheEndOfPlaylistSentinelItsATrap = false;
      break;
    }
    if (!plTrack.grooveFile) {
      break;
    }
    // compute the gain adjustment
    gainAndPeak = calcGainAndPeak(plTrack);
    grooveItem = self.groovePlaylist.insert(plTrack.grooveFile, gainAndPeak.gain, gainAndPeak.peak);
    self.grooveItems[grooveItem.id] = plTrack;
    currentGrooveItem = currentGrooveItem || grooveItem;
    incrementPlIndex();
  }

  if (currentGrooveItem && self.seekRequestPos >= 0) {
    var seekPos = self.seekRequestPos;
    // we want to clear encoded buffers after the seek completes, e.g. after
    // we get the end of playlist sentinel
    self.clearEncodedBuffer();
    self.queueClearEncodedBuffers = true;
    self.groovePlaylist.seek(currentGrooveItem, seekPos);
    self.seekRequestPos = -1;
    if (self.isPlaying) {
      var nowMs = (new Date()).getTime();
      var posMs = seekPos * 1000;
      self.trackStartDate = new Date(nowMs - posMs);
    } else {
      self.pausedTime = seekPos;
    }
    self.currentTrackChanged();
  }

  function calcGainAndPeak(plTrack) {
    // if the previous item is the previous item from the album, or the
    // next item is the next item from the album, use album replaygain.
    // else, use track replaygain.
    var dbFile = self.libraryIndex.trackTable[plTrack.key];
    var albumMode = albumInfoMatch(-1) || albumInfoMatch(1);

    var gain = REPLAYGAIN_PREAMP;
    var peak;
    if (dbFile.replayGainAlbumGain != null && albumMode) {
      gain *= dBToFloat(dbFile.replayGainAlbumGain);
      peak = dbFile.replayGainAlbumPeak || 1.0;
    } else if (dbFile.replayGainTrackGain != null) {
      gain *= dBToFloat(dbFile.replayGainTrackGain);
      peak = dbFile.replayGainTrackPeak || 1.0;
    } else {
      gain *= REPLAYGAIN_DEFAULT;
      peak = 1.0;
    }
    return {gain: gain, peak: peak};

    function albumInfoMatch(dir) {
      var otherPlTrack = self.tracksInOrder[plTrack.index + dir];
      if (!otherPlTrack) return false;

      var otherDbFile = self.libraryIndex.trackTable[otherPlTrack.key];
      if (!otherDbFile) return false;

      var albumMatch = self.libraryIndex.getAlbumKey(dbFile) === self.libraryIndex.getAlbumKey(otherDbFile);
      if (!albumMatch) return false;

      // if there are no track numbers then it's hardly an album, is it?
      if (dbFile.track == null || otherDbFile.track == null) {
        return false;
      }

      var trackMatch = dbFile.track + dir === otherDbFile.track;
      if (!trackMatch) return false;

      return true;
    }
  }

  function incrementPlIndex() {
    groovePlItemCount += 1;
    if (self.repeat !== Player.REPEAT_ONE) {
      plItemIndex += 1;
      if (self.repeat === Player.REPEAT_ALL && plItemIndex >= self.tracksInOrder.length) {
        plItemIndex = 0;
      }
    }
  }
}

function removePreloadFromTrack(self, track) {
  if (!track.grooveFile) return;
  var file = track.grooveFile;
  track.grooveFile = null;
  log.debug("removePreloadFromTrack close file:", file.filename);
  closeFile(file);
}

function isFileIgnored(basename) {
  return (/^\./).test(basename) || (/~$/).test(basename);
}

function deserializeFileData(dataStr) {
  var dbFile = JSON.parse(dataStr);
  for (var propName in DB_PROPS) {
    var propInfo = DB_PROPS[propName];
    if (!propInfo) continue;
    var parser = PROP_TYPE_PARSERS[propInfo.type];
    dbFile[propName] = parser(dbFile[propName]);
  }
  return dbFile;
}

function serializeQueueItem(item) {
  return JSON.stringify({
    id: item.id,
    key: item.key,
    sortKey: item.sortKey,
    isRandom: item.isRandom,
  });
}

function serializePlaylistItem(item) {
  return JSON.stringify({
    id: item.id,
    key: item.key,
    sortKey: item.sortKey,
  });
}

function trackWithoutIndex(category, dbFile) {
  var out = {};
  for (var propName in DB_PROPS) {
    var prop = DB_PROPS[propName];
    if (!prop[category]) continue;
    // save space by leaving out null and undefined values
    var value = dbFile[propName];
    if (value == null) continue;
    out[propName] = value;
  }
  return out;
}

function serializeFileData(dbFile) {
  return JSON.stringify(trackWithoutIndex('db', dbFile));
}

function serializeDirEntry(dirEntry) {
  return JSON.stringify({
    dirName: dirEntry.dirName,
    entries: dirEntry.entries,
    dirEntries: dirEntry.dirEntries,
    mtime: dirEntry.mtime,
  });
}

function trackNameFromFile(filename) {
  var basename = path.basename(filename);
  var ext = path.extname(basename);
  return basename.substring(0, basename.length - ext.length);
}

function closeFile(file) {
  file.close(function(err) {
    if (err) {
      log.error("Error closing", file, err.stack);
    }
  });
}

function parseTrackString(trackStr) {
  if (!trackStr) return {};
  var parts = trackStr.split('/');
  if (parts.length > 1) {
    return {
      value: parseIntOrNull(parts[0]),
      total: parseIntOrNull(parts[1]),
    };
  }
  return {
    value: parseIntOrNull(parts[0]),
  };
}

function parseIntOrNull(n) {
  n = parseInt(n, 10);
  if (isNaN(n)) return null;
  return n;
}

function parseFloatOrNull(n) {
  n = parseFloat(n);
  if (isNaN(n)) return null;
  return n;
}

function grooveFileToDbFile(file, filenameHint, object) {
  object = object || {key: uuid()};
  var parsedTrack = parseTrackString(file.getMetadata("track"));
  var parsedDisc = parseTrackString(file.getMetadata("disc") || file.getMetadata("TPA"));
  object.name = (file.getMetadata("title") || trackNameFromFile(filenameHint) || "").trim();
  object.artistName = (file.getMetadata("artist") || "").trim();
  object.composerName = (file.getMetadata("composer") ||
                         file.getMetadata("TCM") || "").trim();
  object.performerName = (file.getMetadata("performer") || "").trim();
  object.albumArtistName = (file.getMetadata("album_artist") || "").trim();
  object.albumName = (file.getMetadata("album") || "").trim();
  object.compilation = !!(parseInt(file.getMetadata("TCP"),  10) ||
                          parseInt(file.getMetadata("TCMP"), 10));
  object.track = parsedTrack.value;
  object.trackCount = parsedTrack.total;
  object.disc = parsedDisc.value;
  object.discCount = parsedDisc.total;
  object.duration = file.duration();
  object.year = parseIntOrNull(file.getMetadata("date"));
  object.genre = file.getMetadata("genre");
  object.replayGainTrackGain = parseFloatOrNull(file.getMetadata("REPLAYGAIN_TRACK_GAIN"));
  object.replayGainTrackPeak = parseFloatOrNull(file.getMetadata("REPLAYGAIN_TRACK_PEAK"));
  object.replayGainAlbumGain = parseFloatOrNull(file.getMetadata("REPLAYGAIN_ALBUM_GAIN"));
  object.replayGainAlbumPeak = parseFloatOrNull(file.getMetadata("REPLAYGAIN_ALBUM_PEAK"));
  return object;
}

function uniqueFilename(filename) {
  // break into parts
  var dirname = path.dirname(filename);
  var basename = path.basename(filename);
  var extname = path.extname(filename);

  var withoutExt = basename.substring(0, basename.length - extname.length);

  var match = withoutExt.match(/_(\d+)$/);
  var withoutMatch;
  var number;
  if (match) {
    number = parseInt(match[1], 10);
    if (!number) number = 0;
    withoutMatch = withoutExt.substring(0, match.index);
  } else {
    number = 0;
    withoutMatch = withoutExt;
  }

  number += 1;

  // put it back together
  var newBasename = withoutMatch + "_" + number + extname;
  return path.join(dirname, newBasename);
}

function dBToFloat(dB) {
  return Math.exp(dB * DB_SCALE);
}

function ensureSep(dir) {
  return (dir[dir.length - 1] === path.sep) ? dir : (dir + path.sep);
}

function ensureGrooveVersionIsOk() {
  var ver = groove.getVersion();
  var verStr = ver.major + '.' + ver.minor + '.' + ver.patch;
  var reqVer = '>=4.1.1';

  if (semver.satisfies(verStr, reqVer)) return;

  log.fatal("Found libgroove", verStr, "need", reqVer);
  process.exit(1);
}

function playlistItemKey(playlist, item) {
  return PLAYLIST_KEY_PREFIX + playlist.id + '.' + item.id;
}

function playlistKey(playlist) {
  return PLAYLIST_META_KEY_PREFIX + playlist.id;
}

function serializePlaylist(playlist) {
  return JSON.stringify({
    id: playlist.id,
    name: playlist.name,
  });
}

function deserializePlaylist(str) {
  var playlist = JSON.parse(str);
  playlist.items = {};
  return playlist;
}

function zfill(number, size) {
  number = String(number);
  while (number.length < size) number = "0" + number;
  return number;
}

function setGrooveLoggingLevel() {
  switch (log.level) {
    case log.levels.Fatal:
      groove.setLogging(groove.LOG_QUIET);
      break;
    case log.levels.Error:
      groove.setLogging(groove.LOG_QUIET);
      break;
    case log.levels.Info:
      groove.setLogging(groove.LOG_QUIET);
      break;
    case log.levels.Warn:
      groove.setLogging(groove.LOG_WARNING);
      break;
    case log.levels.Debug:
      groove.setLogging(groove.LOG_INFO);
      break;
  }
}

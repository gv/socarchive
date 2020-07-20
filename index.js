"use strict"
const commander = require("./lib/commander.js");
const https = require("https");
const querystring = require("querystring");
const url = require("url");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events").EventEmitter;
const util = require("util");

const options = commander.
	  option("-t, --token <token>", "Access token").
	  option(
		  "-m, --move <id>",
		  "Read items from stdin and move them to album <id>").
	  option(
		  "-r, --remove",
		  "Read items from stdin and remove them").
	  option("-o, --open", "Get OAuth page").
	  option("--srt <substring>", "Get a subtitle with this substring").
	  option("--internal", "Use internal subtitles").
	  option("--upload <path>", "Test upload").
	  option("--reverse", "Reverse directory lists").
	  option("--list", "List videos").
	  option("--verbose, -v", "Verbose").
	  option("--copy", "Copy source videos to temp dir before encoding").
	  option(
		  "--rename-subs",
		  "Don't upload anything, rename subtitles to match video file names").
	  parse(process.argv);

util.inherits(Entry, EventEmitter);

function Entry(ep, dir, options) {
	if (!new.target)
		return new Entry(ep);
	this.parts = ep.split(new RegExp(`\\${path.sep}+`, "g"));
	this.path = ep;
	this.options = options;
	this.dir = dir;
}

const verb = function() {
	console.error.apply(console, arguments);
};

verb("path.sep=%j", path.sep);

Entry.prototype.getDirName = function() {
	const p = [];
	for (let i = this.parts.length - 2; i >= 0; i--) {
		p.unshift(this.parts[i]);
		let words = this.parts[i].split(/[^A-Za-z]+/g);
		verb("words=%j", words);
		words = words.filter(x => !x.match(/season|series|^$/i));
		if (words.length)
			break;
	}
	return `${p.join(", ")} ${this.options.srt.toUpperCase()} SUB`;
};

Entry.prototype.getName1 = function() {
	return this.parts[this.parts.length -1].replace(/[.][^.]+$/, "");
};

Entry.prototype.getName = function() {
	return `${this.getName1()} ${this.options.srt.toUpperCase()} SUB`;
};

Entry.prototype.isIn = function(items) {
	return this.find(items).length !== 0;
};

Entry.prototype.find = function(items) {
	// console.error("items=%j", items);
	const r = [];
	for (let x of items) {
		if (this.getName1() === x.title)
			r.push(x);
		else if (this.getName() === x.title)
			r.push(x)
	}
	return r;
};

Entry.prototype.getSubtitleNames = function() {
	return fs.readdirSync(path.dirname(this.path)).
		filter(x => !x.match("^._")).
		filter(x => x.match("[.]srt$"));
};

const getSubtitleName = function(entry, cb) {
	let m;
	m = entry.getName().match("S(\\d\\d)E(\\d\\d)");
	if (!m) {
		return void find(entry, entry.getName1(), (e, r) => {
			if (e || r)
				return void cb(e, r);
			return void(cb(`Can't find sub for ${entry.getName()}`));
		});
	}

	let s = parseInt(m[1], 10);
	find(entry, `${s}x${m[2]}`, (e, r) => {
		if (r)
			return void cb(null, r);
		//find (entry, `${}`, (e, r) => {
		//	if (r)
		//		return void cb(null, r);
		find(entry, `^0*${parseInt(m[2], 10)}[^\\d]`, cb);
		//});
	});
};

const find = function(entry, pat, cb) {
	console.error("Matching %j in %j", pat, entry.getSubtitleNames());
	const sns = entry.getSubtitleNames().filter(x => x.match(pat));
	if (sns.length === 0)
		return void(cb(`No subtitles for ${entry.path}`));
	if (sns.length > 1)
		return void(cb(`Too much subtitles for ${entry.path}: \
${JSON.stringify(sns)}`));
	cb(null, sns[0]);
};

Entry.prototype.getUploadable = function(cb) {
	if (this.options.internal) {
		return void this.getHardsub(this.path, path.basename(this.path), cb);
	} else if (this.options.srt) {
		getSubtitleName(this, (e, r) => {
			if (e)
				return void cb(e);
			this.getHardsub(this.path, r, cb);
		});
	} else {
		cb("Uploading without subtitles disabled");
		//cb(null, this.path);
	}
};

const quoteForFilterDef = str =>
	  str.replace(new RegExp("'", "g"), "\\'");

Entry.prototype.getTmpDirPath = function() {
	return (process.platform == "win32") ? process.cwd() : "/tmp";
};

Entry.prototype.releaseUploadable = function(tmpPath) {
	this.deleteTmpFileSync(tmpPath);
};

Entry.prototype.deleteTmpFileSync = function(tmp) {
	if (path.dirname(tmp) !== this.getTmpDirPath()) {
		throw new TypeError(
			util.format(
				"%j can't be a temp file (not in %j)", tmp,
				this.getTmpDirPath()));
	}
	verb("Deleting %j...", tmp);
	try {
		fs.unlinkSync(tmp);
	} catch (e) {
		verb("Warning %j", e);
	}
};

Entry.prototype.getHardsubForFullPath = function(src, subName, cb) {
	if (!this.options.copy)
		return void this.getHardsubCopyDone(src, subName, cb);
	const tmp = path.join(this.getTmpDirPath(), this.getName() + ".copy.mp4");
	fs.stat(src, (e, st) => {
		if (e)
			return void cb(e);
		process.on("exit", () => {
			this.deleteTmpFileSync(tmp);
		});

		return void spawn(
			"rsync", ["--progress", src, tmp], {stdio: [0, 1, 2]}).
			on("close", (code, sig) => {
				if(code || sig)
					return void cb(new RuntimeError(code || sig));
				this.getHardsubCopyDone(tmp, subName, cb);
			});
	});
};

Entry.prototype.getHardsub = function(src, subName, cb) {
	return this.getHardsubForFullPath(
		src, path.join(src, "..", subName), cb);
};

Entry.prototype.getHardsubCopyDone = function(src, sub, cb) {
	const ffmpeg = process.platform === "win32" ?
		  path.join(__dirname, "bin", "ffmpeg.exe"):
		  path.join(process.execPath, "..", "ffmpeg");
	const tmp = path.join(this.getTmpDirPath(), this.getName() + ".tmp.mp4");
	// Quoting is broken. Need to change working directory
	// until I figure out how to fix it
	const options = {
		stdio: ["inherit", "inherit", "pipe"], cwd: path.dirname(sub)};
	const subName = path.basename(sub);
	if (this.options.verbose)
		options.stdio[2] = "inherit";
	let cmd = [
		ffmpeg, "-i", path.resolve(src),
		"-vf", `subtitles=${quoteForFilterDef(subName)}`, "-y", tmp];
	if (process.platform !== "win32") 
		cmd = ["caffeinate", "nice"].concat(cmd);
	const p = spawn(cmd.shift(), cmd, options).on("close", (code, sig) => {
			  if (this.options.copy)
				  this.deleteTmpFileSync(src);
			  if (code)
				  return void(cb(`Code ${code}`));
			  if (sig)
				  return void(cb(`Signal ${sig}`));
			  cb(null, tmp);
		});
	process.on("exit", () => {
		this.deleteTmpFileSync(tmp);
	});
	if (!this.options.verbose) {
		getLinesWithLimit(p.stderr, (line, isLast, m) => {
			verb("ffmpeg: %s", line);
			if (m = line.match("Duration: ([0-9:.]+)")) {
				this.duration = m[1];
			} else if (m = line.match("time=\\s*([0-9:.]+)")) {
				this.position = m[1];
			}
		});
	}
};

const spawn = function(prog, args) {
	console.error("Running %j %j", prog, args);
	return child_process.spawn.apply(child_process, arguments);
};

function Directory() {
	this.subtitleNames = [];
}

function SocArrange(options) {
	if (!new.target)
		return new SocArrange(options);
	this.options = options;
	this.count = {moved: 0, deleted: 0, subtitles: 0};
}

SocArrange.prototype.openBrowser = function(cb) {
	let url = `https://oauth.vk.com/authorize?client_id=7505964&\
display=page&redirect_uri=https://oauth.vk.com/blank.html&\
scope=video,friends&response_type=token&v=5.52`;
	spawn("open", [url], {stdio: [0, 1, 2]});
};

SocArrange.prototype.run = function(cb) {
	this.runIfAccessOk(e => {
		if(e && 5 === e.error_code) {
			console.error("Received error: %j", e);
			return void this.openBrowser(cb);
		}
		cb(e);
	})
};

SocArrange.prototype.runIfAccessOk = function(cb) {
	if (this.options.open) {
		if (this.options.move || this.options.remove) {
			console.error(
				"Can't have --open with --move --remove");
			process.exit(1);
		}
		return void this.openBrowser(cb);
	}

	if (!this.options.token) {
		return void cb("-t option required for everything except --open");
	}
	
	if (this.options.move && this.options.remove) {
		console.error("Can't be 'move' and 'remove' at the same time");
		process.exit(1);
	}
	
	if (this.options.move) {
		this.processInput();
	} else if (this.options.remove) {
		this.method("users.get")({}, (e, r) => {
			if (e)
				return void(cb(e))
			console.error("r=%j", r);
			if (!(this.uid = r.response[0].id))
				throw "Must get uid";
			this.processInput();
		});
	} else if (this.options.list) {
		this.loadVideos([], (e, items) => {
			if (e)
				return void cb(e);
			for (let item of items) {
				console.log(
					"%s/%s %j", item.owner_id, item.id, item.title);
			}
		});
	} else {
		if (!this.options.srt)
			return void cb(new TypeError("\
Uploading without subtitles disabled; to \
engage internal subs, use --internal --srt LANG")); 
		this.loadingArchiveState = new EventEmitter();
		this.loadArchiveState((e, r) => {
			if (e)
				return void(cb(e));
			this.loadingArchiveState.emit("done");
			delete this.loadingArchiveState;
		});
		this.loadFiles(e => {
			if (e)
				return void(cb(e));
			if (!this.loadingArchiveState)
				return void(this.uploadEverything(cb));
			this.loadingArchiveState.on(
				"done", () => this.uploadEverything(cb));
		});
	}
};

SocArrange.prototype.loadFiles = function(cb) {
	this.count.files = {target: 0, loaded: 0};
	this.files = [];
	for(var p of this.options.args)
		this.load(p, null, out);
	function out(e) {
		if (cb)
			process.nextTick(cb, e)
		cb = null
	}
};

SocArrange.prototype.load = function(p, dir, cb) {
	this.count.files.target++;
	fs.stat(p, (e, s) => {
		if (e)
			return void(cb(e));
		if (s.isDirectory()) {
			fs.readdir(p, (e, list) => {
				const newDir = new Directory();
				if (e)
					return void(cb(e));
				this.count.files.target--;
				if (this.options.reverse)
					list = list.reverse();
				for (let n of list) {
					if (n.match("^._"))
						continue;
					if (n.match("[.](mp4|divx|avi)$")) {
						this.load(path.join(p, n), newDir, cb);
					} else if (n.match("[.]srt$")) {
						newDir.subtitleNames.push(n);
						this.count.subtitles++;
					}
				}
				checkSuccess(this.count);
			});
		} else {
			this.files.push(new Entry(p, dir, this.options));
			this.count.files.loaded++;
			checkSuccess(this.count);
		}
	});

	function checkSuccess(count) {
		if (count.files.loaded >= count.files.target)
			cb();
	}
};

SocArrange.prototype.loadArchiveState = function(cb) {
	this.albums = {};
	this.count.albums = 0;
	this.method("video.getAlbums")({}, (e, r) => {
		if (e)
			return void(cb(e));
		if (~~r.response.count < r.response.items.length)
			throw "TODO";
		for (let a of r.response.items) {
			this.albums[a.title] = a;
			this.count.albums++;
		}
		cb(null);
	});
};

SocArrange.prototype.uploadEverything = function(cb) {
	const caff = spawn("caffeinate", [], {stdio: [0, 1, 2]});
	const out = e => {
		caff.kill();
		cb(e);
	};
	console.error(
		"%j albums, %j files, %j subtitles",
		this.count.albums, this.count.files.loaded, this.count.subtitles);
	this.work = [];
	this.loadWork(0, (e, r) => {
		if (e)
			return void out(e);
		console.error("%j files to upload", this.work.length);
		this.continueUpload(0, out);
	});
};

SocArrange.prototype.continueUpload = function(i, cb) {
	if (i >= this.work.length)
		return void(cb(null));
	this.upload(this.work[i], e => {
		e ? cb(e) : this.continueUpload(i + 1, cb);
	});
};

SocArrange.prototype.findAlbum = function(title, cb) {
	this.method("video.getAlbums")({}, (e, r) => {
		if (e)
			return void cb(e);
		const w = r.response.items.filter(x => x.title == title);
		if (w.length > 1)
			return void cb(`Too much albums found ${JSON.stringify(w)}`);
		cb(null, w[0]);
	});
};

SocArrange.prototype.uploadIfNotExists = function(entry, cb) {
	this.findAlbum(entry.getDirName(), (e, r) => {
		if (e)
			return void cb(e);
		if (!r)
			return void this.upload(entry, cb);
		this.method("video.get")({album_id: r.id}, (e, r) => {
			
		});
	});
};

SocArrange.prototype.upload = function(entry, cb) {
	entry.getUploadable((e, tmpPath) => {
		if (e)
			return void cb(e);
		this.getAlbum(entry.getDirName(), (e, album) => {
			if (e)
				return void cb(e);
			if (!album.id)
				return void cb(`No album id ${JSON.stringify(album)}`)
			console.error(`Uploading to album id=${album.id}`);
			this.method("video.save")({
				album_id: album.id,
				is_private: 0,
				name: entry.getName()
			}, (e, r) => {
				if (e)
					return void cb(e);
				if (!r.response.upload_url)
					return void cb(`No upload_url ${JSON.stringify(r)}`);
				this.doUpload(r.response.upload_url, tmpPath, e => {
					entry.releaseUploadable(tmpPath);
					cb(e);
				});
			});
		});
	});
};

SocArrange.prototype.doUpload = function(target, tmpPath, cb) {
	const boundary =
		  "-----------------------------735323031399963166993862150";
	const options = url.parse(target, false);
	options.method = "POST";
	options.path = options.pathname + options.search;
	delete options.pathname;
	delete options.search;
	console.error("upload %j", options);
	options.headers = {
		"Content-Type": `multipart/form-data; boundary=${boundary}`
	};
	const req = https.request(options);
	req.write(`--${boundary}\r\n`);
	req.write(
		`Content-Disposition: form-data; name="file"; filename="${tmpPath}"\r\n`);
	req.write(
		`Content-Type: application/octet-stream\r\n\r\n`);
	fs.stat(tmpPath, (e, st) => {
		if (e)
			return void cb(e);
		this.count.upload = {target: st.size, done: 0};
		if (!this.count.upload.target)
			return void cb("Upload size = 0");
		fs.createReadStream(tmpPath).on("end", () => {
			req.end(`\r\n--${boundary}--\r\n`);
		}).on("data", d => {
			this.count.upload.done += d.length;
			this.update();
		}).pipe(req, {end: false});
	});
	req.on("response", res => {
		let msg = `Upload status=${res.statusCode}`;
		console.error(msg);
		if (res.statusCode >= 400)
			return void(cb(msg));
		cb(null);
	});
};

SocArrange.prototype.update = function() {
	process.stderr.write(`\r  uploaded ${num(this.count.upload.done)}\
 / ${num(this.count.upload.target)}`);
};

const num = n =>
	n.toString().split("").reverse().join("").
	replace(new RegExp("([0-9]{3})", "g"), "$1,").
	split("").reverse().join("").replace(new RegExp("^,"), "");

SocArrange.prototype.getAlbum = function(name, cb) {
	if (this.albums[name])
		return void(cb(null, this.albums[name]));
	console.error("Creating album %j", name);
	this.method("video.addAlbum")({
		title: name, privacy: 0}, (e, r) => {
			if (e)
				return void(cb(e));
			if (!r.response.album_id)
				return void(cb(`No album_id ${JSON.stringify(r)}`));
			r.response.id = r.response.album_id;
			cb(null, this.albums[name] = r.response);
		});
};

SocArrange.prototype.findEntry = function(entry) {
	
};

SocArrange.prototype.loadWork = function(i, cb) {
	if (i >= this.files.length)
		return void(cb(null));
	// Video is added to the album only after processing. Until then
	// it is in "Added" if not private...
	// TODO check "Added"
	let album = this.albums[this.files[i].getDirName()];
	if (!album) {
		this.work.push(this.files[i]);
		return void(this.loadWork(i + 1, cb));
	}
	this.getItems(album, (e, items) => {
		if (e)
			return void(cb(e));
		const existing = this.files[i].find(items);
		if (existing.length === 0) {
			this.work.push(this.files[i]);
			return void(this.loadWork(i + 1, cb));
		}
		this.ensureName(existing, this.files[i].getName()).
			then(r => {this.loadWork(i + 1, cb)}, e => process.nextTick(cb, e));
	});
};

SocArrange.prototype.ensureName = async function(videos, name) {
	if (!name)
		throw new TypeError("Has to be a name");
	for (let v of videos) {
		if (v.title === name)
			continue;
		const options = {name, video_id: v.id}
		console.error("Renaming from=%j to=%j", v.title, options);
		await this.pm("video.edit")(options);
	}
};

SocArrange.prototype.getItems = function(album, cb) {
	if (album.items)
		return void(cb(null, album.items));
	this.method("video.get")({album_id: album.id}, (e, r) => {
		if (e)
			return void(cb(e));
		if (~~r.response.count < r.response.items.length)
			throw "TODO";
		cb(null, album.items = r.response.items);
	});
};

SocArrange.prototype.processInput = function() {
	getLines(process.stdin, (line, isLast, m) => {
		if (m = line.match("^([0-9-]+)/([0-9]+) ")) {
			if (this.options.move) {
				this.cmd(
					"video.addToAlbum", {
						album_id: this.options.move,
						owner_id: m[1],
						video_id: m[2]
					}, (e, r) => {
						if (e)
							throw e;
						console.error(
							"moved=%d r=%j", this.count.moved++, r);
					});
			} else {
				this.method("video.delete")({
					owner_id: m[1],
					video_id: m[2],
					target_id: this.uid
				}, (e, r) => {
					if (e)
						throw e;
					console.error(
						"deleted=%d r=%j", this.count.deleted++, r);
				});
			}
		} else {
			console.error("Unparsed: %j", line);
		}
	});
};

SocArrange.prototype.loadVideos = function(head, cb) {
	this.cmd("video.get", {offset: head.length}, (e, r) => {
		if (e)
			return void cb(e);
		let items = head.concat(r.response.items);
		if (items.length >= r.response.count)
			cb(null, items);
		else
			this.loadVideos(items, cb);
	});
};

SocArrange.prototype.cmd = function(name, query, cb) {
	this.method(name)(query, cb);
};

SocArrange.prototype.pm = function(name) {
	return function(query) {
		query.access_token = this.options.token;
		query.v = "5.52";
		const options = {
			host: "api.vk.com",
			path: `/method/${name}?${querystring.stringify(query)}`};
		if (0)
			console.error("host=%j path=%j", options.host, options.path);
		return new Promise((resolve, reject) => {
			https.get(options, res => {
				exports.readWhole(res, (e, buf) => {
					if (e)
						return void reject(e);
					//console.error("r=%s", buf.toString());
					var r = JSON.parse(buf.toString());
					if (r.error)
						reject(r.error);
					else
						resolve(r);
				});
			});
		});
	}.bind(this);
};

SocArrange.prototype.method = function(name) {
	return function(query, cb) {
		this.pm(name)(query).then(
			r => cb(null, r), e => process.nextTick(cb, e));
	}.bind(this);
};

exports.readWhole = function(s, cb) {
    var list = [];
    s.on("data", function(b) {
        if (!Buffer.isBuffer(b))
            b = Buffer(b);
        list.push(b.toString("hex"))
    });
    s.on("end", function() { cb(null, new Buffer(list.join(""), "hex")) });
    s.on("error", cb);
};

function getLines(stream, cb) {
	let acc = "";
	stream.on("data", d => {
		var parts = (acc + d.toString("utf-8")).split("\n");
		acc = parts.pop();
		parts.forEach(x => {cb(x, false)});
	});
	stream.on("close", () => {acc & cb(acc, true)});
};

function getLinesWithLimit(stream, cb) {
	let acc = "";
	stream.on("data", d => {
		var parts = (acc + d.toString("utf-8")).split("\n");
		acc = parts.pop();
		parts.forEach(x => {cb(x, false)});
		if (acc.length > 80) {
			cb(acc, false);
			acc= "";
		}
	});
	stream.on("close", () => {acc & cb(acc, true)});
};


SocArrange(options).run(e => {
	if (e) {
		throw (e.error_msg || e)
	}
});

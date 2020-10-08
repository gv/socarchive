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
	  option("--internal", "Use embedded subtitles").
	  option("--upload <path>", "Test upload").
	  option("--reverse", "Read directories in reverse order").
	  option("--list", "List videos").
	  option("--verbose, -v", "Verbose").
	  option("--copy", "Copy source videos to temp dir before encoding").
	  option(
		  "--rename-subs",
		  "Don't upload anything, rename subtitles to match video file names").
	  option("--dry", "Dry run").
	  option("--nocaffeinate", "Do not suppress sleeping").
	  parse(process.argv);

util.inherits(Entry, EventEmitter);

function Entry(ep, dir, options) {
	/*
	if (!new.target)
		return new Entry(ep, dir, options);
	*/
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
		words = words.filter(x => !x.match(/season|series|^$/i));
		if (words.length)
			break;
	}
	return `${p.join(", ")} ${this.options.srt.toUpperCase()} SUB`;
};

Entry.prototype.getName1 = function() {
	return this.parts[this.parts.length - 1].replace(/[.][^.]+$/, "");
};

Entry.prototype.getName = function() {
	return `${this.getName1()} ${this.options.srt.toUpperCase()} SUB`;
};

Entry.prototype.getName3 = function() {
	let num = [], subCode;
	for (let i = this.parts.length - 1; i >= 0; i--) {
		let part = this.parts[i], m;
		if (m = part.match("S\\d+E\\d+")) {
			num = [m[0]];
			break;
		}
		if (m = part.match(new RegExp(
			"(episode|season|series)\\s*\\d+", "i"))) {
			num.unshift(m[0]);
		}
	}
	num.push(this.options.title || this.getDirTitle());
	if ((subCode = this.options.srt.toUpperCase()) !== "NONE") {
		num.push(subCode);
		num.push("SUB");
	}
	return num.join(" ");
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

Entry.prototype.getSubtitleNamesFrom = function(dir) {
	// If we read them from Directory object we won't be
	// able to put in new ones as it runs...
	return fs.readdirSync(dir).
		filter(x => !x.match("^._")).
		filter(x => x.match(new RegExp("[.]srt$", "i")));
};

Entry.prototype.getSubtitleNames = function() {
	return this.getSubtitleNamesFrom(path.dirname(this.path));
};

const getSubtitleName1 = function(entry, names, dir, cb) {
	let name = entry.parts[entry.parts.length - 1],
		m = name.match("S(\\d\\d)E(\\d\\d)") ||
		name.match("(\\d+)[.](\\d+)");
	if (!m) {
		return void find1(entry, names, dir, entry.getName1(), (e, r) => {
			if (e || r)
				return void cb(e, r);
			return void(cb(`Can't find sub for ${entry.getName()}`));
		});
	}

	let s = parseInt(m[1], 10);
	find1(entry, names, dir, `${s}(x|E)${m[2]}`, (e, r) => {
		if (r)
			return void cb(null, r);
		//find (entry, `${}`, (e, r) => {
		//	if (r)
		//		return void cb(null, r);
		find1(entry, names, dir, `^0*${parseInt(m[2], 10)}[^\\d]`, cb);
		//});
	});
};

const getSubtitleName = function(entry, cb) {
	getSubtitleName1(
		entry, entry.getSubtitleNames(), path.dirname(entry.path), cb);
};

const getSubtitleNameFrom = function(entry, dir, cb) {
	getSubtitleName1(entry, entry.getSubtitleNamesFrom(dir), dir, cb);
}

const find1 = function(entry, names, dir, pat, cb) {
	console.error("Matching %j in %j", pat, names);
	const sns = names.filter(x => x.match(pat));
	if (sns.length === 0)
		return void cb(
			new Error(`No subtitles for ${entry.path} in "${dir}"}`));
	if (sns.length > 1)
		return void(cb(`Too much subtitles for ${entry.path}: \
${JSON.stringify(sns)}`));
	cb(null, sns[0]);
};

Entry.prototype.getUploadable1 = function(progressHandler, cb) {
	if (this.options.internal) {
		if (this.options.srtDir)
			return void cb(new Error(
				"'internal' and 'srtDir' options incompatible"));
		return void this.getHardsubWithProgress(
			path.basename(this.path), progressHandler, cb);
	} else if ("none" === this.options.srt) {
		return void cb(null, this.path);
	} else if (this.options.srt) {
		const srtDir = this.options.srtDir &&
			  path.join(this.options.configPath, "..", this.options.srtDir) ||
			  path.dirname(this.path);
		getSubtitleNameFrom(this, srtDir, (e, r) => {
			if (e)
				return void cb(e);
			this.getHardsubForFullPathWithProgress(
				path.join(srtDir, r), progressHandler, cb);
		});
	} else {
		cb("Uploading without subtitles disabled");
		//cb(null, this.path);
	}
};

Entry.prototype.getUploadableDoubleEnc = function(progressHandler, cb) {
	if (!this.options.topSrt)
		return void this.getUploadable1(progressHandler, cb);
	const sp = path.join(
		this.options.configPath, "..", this.options.topSrt.dir);
	getSubtitleName1(this, this.getSubtitleNamesFrom(sp), sp, (e, sn2) => {
		if (e)
			return void cb(e);
		this.getUploadable1(progressHandler, (e, hard1) => {
			if (e || !this.options.topSrt)
				return void cb(e, hard1);
			this.getHardsubCopyDoneWithProgress(
				hard1, path.join(sp, sn2) + ":force_style='Alignment=6'",
				progressHandler, (e, h2) => {
					this.releaseUploadable(hard1);
					cb(e, h2);
				});
		});
	});
};

Entry.prototype.getUploadable = function(progressHandler, cb) {
	// If there is 2nd sub check if it's readable before we convert
	if (!this.options.topSrt)
		return void this.getUploadable1(progressHandler, cb);
	const sp = path.join(
		this.options.configPath, "..", this.options.topSrt.dir);
	getSubtitleName1(this, this.getSubtitleNamesFrom(sp), sp, (e, sn2) => {
		if (e)
			return void cb(e);
		this.topSrt = path.join(sp, sn2);
		this.getUploadable1(progressHandler, cb);
	});
};
			
Entry.prototype.getTmpDirPath = function() {
	return (process.platform == "win32") ? process.cwd() : "/tmp";
};

Entry.prototype.releaseUploadable = function(tmpPath) {
	if ("none" !== this.options.srt)
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

Entry.prototype.getHardsubForFullPathWithProgress = function(
	sub, progressHandler, cb) {
	if (!this.options.copy)
		return void this.getHardsubCopyDoneWithProgress(
			this.path, sub, progressHandler, cb);
	const tmp = path.join(this.getTmpDirPath(), this.getName() + ".copy.mp4");
	fs.stat(this.path, (e, st) => {
		if (e)
			return void cb(e);
		process.on("exit", () => {
			this.deleteTmpFileSync(tmp);
		});

		return void spawn(
			"rsync", ["--progress", this.path, tmp], {stdio: [0, 1, 2]}).
			on("close", (code, sig) => {
				if(code || sig)
					return void cb(new RuntimeError(code || sig));
				this.getHardsubCopyDoneWithProgress(
					tmp, sub, progressHandler, cb);
			});
	});
};

Entry.prototype.getHardsubWithProgress = function(subName, progressHandler, cb) {
	return this.getHardsubForFullPathWithProgress(
		path.join(this.path, "..", subName), progressHandler, cb);
};

// See ffmpeg/doc/filters.texi @section Notes on filtergraph escaping

const quoteForFilterDef = str =>
	  str.replace(new RegExp("['\\\\]", "g"), "\\$&");

const quoteForFilterGraph = str =>
	  quoteForFilterDef(str).replace(new RegExp("['\\\\,]", "g"), "\\$&");

Entry.prototype.getFfmpegCommandSync = function(src, sub, tmp) {
	const ffmpeg = process.platform === "win32" ?
		  [path.join(__dirname, "bin", "ffmpeg.exe")] :
		  process.platform === "darwin" ?
		  [path.join(process.execPath, "..", "ffmpeg")] :
		  ["ffmpeg", "-strict", "-2"];
	let fg = `subtitles=${quoteForFilterGraph(sub)}`;
	if (this.topSrt) {
		fg += `\
,subtitles=${quoteForFilterGraph(this.topSrt)}:\
force_style='Alignment=6':charenc=cp1251`;
	}
	return ffmpeg.concat([
		"-i", path.resolve(src), "-vf", fg, "-y", "-nostdin", tmp]);
};

Entry.prototype.getMencoderCommandSync = function(src, sub, out) {
	let cmd = ["mencoder", src, "-oac", "copy", "-ovc", "copy", "-o", out];
	if (path.basename(sub) != path.basename(src)) {
		cmd = cmd.concat(["-sub", sub]);
	}
	return cmd
};

Entry.prototype.getHardsubCopyDoneWithProgress = function(
	src, sub, progressHandler, cb) {
	const tmp = path.join(this.getTmpDirPath(), this.getName() + ".tmp.mp4");
	let options = {stdio: ["inherit", "inherit", "pipe"]}, cmd, prog;
	if (this.options.cd) {
		// If quoting breaks again use this
		options.cwd = path.dirname(sub);
		sub = path.basename(sub);
	}
	if (this.options.verbose)
		options.stdio[2] = "inherit";
	if (process.platform === "___linux")
		cmd = this.getMencoderCommandSync(src, sub, tmp);
	else
		cmd = this.getFfmpegCommandSync(src, sub, tmp);
	prog = cmd[0];
	if (process.platform !== "win32") 
		cmd = ["nice"].concat(cmd);
	if (process.platform === "darwin")
		cmd = ["caffeinate"].concat(cmd);
	const p = spawn(cmd.shift(), cmd, options, e => {
		if (this.options.copy)
			this.deleteTmpFileSync(src);
		cb(e, tmp);
	});
	process.on("exit", () => {
		this.deleteTmpFileSync(tmp);
	});
	if (!this.options.verbose) {
		getLinesWithLimit(p.stderr, (line, isLast, m) => {
			progressHandler.verbFromProgram(prog, line);
			if (m = line.match("Duration: ([0-9:.]+)")) {
				this.duration = m[1];
			} else if (m = line.match("time=\\s*([0-9:.]+)")) {
				this.position = m[1];
			}
		});
	}
};

Entry.prototype.getDescription = function(video, cb) {
	// TODO delete private data from path
	// cb(null, this.path)
	cb(null, this.parts.slice(-2).join("/"));
};

const spawn = function(prog, args, options, cb) {
	console.error("Running %j %j", prog, args);
	const e = new Error();
	return child_process.spawn(prog, args, options).
		on("close", (code, sig) => {
			if (code || sig) {
				e.message = `Return ${code || sig}`;
			}
			cb && cb((code || sig) && e);
		});
};

function Directory() {
	this.subtitleNames = [];
}

function SocArrange(options) {
	if (!(this instanceof SocArrange))
		return new SocArrange(options);
	this.options = options;
	this.count = {moved: 0, deleted: 0, subtitles: 0};
}

SocArrange.prototype.verbFromProgram = function(prog, message) {
	verb(
		"%s [%d/%d]: %s", prog, this.currentIndex, this.work.length, message);
};

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
		if (0 && !this.options.srt)
			return void cb(new TypeError("\
Uploading without subtitles disabled; to \
engage internal subs, use --internal --srt LANG")); 
		this.loadArchiveState(cb);
		this.loadFiles(cb);
	}
};

SocArrange.prototype.handleLoadComplete = function(e, cb) {
	if (this.error)
		return;
	if (e)
		return void cb(this.error = e);
	// verb("count.files=%j", this.count.files);
	if (this.albums && (this.files.length >= this.count.files.target))
		this.uploadEverything(cb);
};

SocArrange.prototype.loadArchiveState = function(cb) {
	const albums = {};
	this.count.albums = 0;
	this.method("video.getAlbums")({}, (e, r) => {
		if (e)
			return void this.handleLoadComplete(e, cb);
		if (~~r.response.count < r.response.items.length)
			throw "TODO";
		for (let a of r.response.items) {
			albums[a.title] = a;
			this.count.albums++;
		}
		this.albums = albums;
		this.handleLoadComplete(null, cb);
	});
};

SocArrange.prototype.loadFiles = function(cb) {
	this.count.files = {target: 0};
	this.files = [];
	for(var p of this.options.args)
		this.load(p, null, this.options, cb);
};

SocArrange.prototype.loadDir = function(p, options, cb) {
	fs.readdir(p, (e, list) => {
		if (e)
			return void this.handleLoadComplete(e, cb);
		const newDir = new Directory();
		if (this.options.reverse)
			list = list.reverse();
		for (let n of list) {
			if (n.match("^._"))
				continue;
			const q = path.join(p, n);
			if (fs.statSync(q).isDirectory()) {
				this.count.files.target++;
				this.loadDir(q, options, cb);
			} else if (n.match("[.](mp4|divx|avi|mkv)$")) {
				this.count.files.target++;
				this.loadFile(q, newDir, options, cb);
			} else if (n.match("[.]srt$")) {
				newDir.subtitleNames.push(n);
				this.count.subtitles++;
			}
		}
		this.count.files.target--;
		this.handleLoadComplete(null, cb);
	});
};

SocArrange.prototype.loadFile = function(p, dir, options, cb) {
	let effOpts = options, newOpts;
	if (effOpts.exceptions) {
		for (let n of p.split(path.sep)) {
			if (newOpts = effOpts.exceptions[n]) {
				Object.setPrototypeOf(newOpts, effOpts);
				effOpts = newOpts;
			}
		}
	}
	if (effOpts.skip) 
		this.count.files.target--;
	else {
		this.files.push(new Entry(p, dir, effOpts));
	}
	this.handleLoadComplete(null, cb);
};

SocArrange.prototype.load = function(p, dir, options, cb) {
	verb("Loading %j...", p);
	this.count.files.target++;
	fs.stat(p, (e, s) => {
		if (e)
			return void this.handleLoadComplete(e, cb);
		if (s.isDirectory()) {
			this.loadDir(p, options, cb);
		} else if (p.match("[.]json")) {
			this.loadConfig(p, cb);
		} else {
			this.loadFile(p, dir, options, cb);
		}
	});
};

SocArrange.prototype.loadConfig = function(p, cb) {
	/*
	  config:

	  {
	   "dir1": {
	    "srt": "FR",
	    "exceptions": {
	     "subdir1": {"internal": true},
	     "basename1": {"srt": "none"}
	    }
	   },
	   "dir2": {
	   ...
	   },
	   ...,
	   "options": {
	    "srt": "EN",
	   }
	  }
	*/
	const conf = JSON.parse(fs.readFileSync(p));
	const options = conf.options || {};
	Object.setPrototypeOf(options, this.options);
	for (let k in conf) {
		if (k === "options")
			continue;
		const c = conf[k];
		const sourcePath = path.resolve(p, "..", k);
		Object.setPrototypeOf(c, options);
		c.configPath = p;
		// this will increase target count 
		this.load(sourcePath, null, c, cb);
	}
	this.count.files.target--;
	this.handleLoadComplete(null, cb);
};

SocArrange.prototype.uploadEverything = function(cb) {
	const out = e => {
		if (cb) {
			process.nextTick(cb, e);
			cb = null;
		}
	};
	console.error(
		"%j albums, %j files, %j subtitles",
		this.count.albums, this.files.length, this.count.subtitles);
	console.error("count=%j", this.count);
	this.work = [];
	const continueCheck = i => {
		if (i >= this.files.length)
			return void this.continueUpload(0, out);
		this.check(this.files[i++], e => {
			e ? out(e) : continueCheck(i)
		});
	};
	continueCheck(0);
};

SocArrange.prototype.continueUpload = function(i, cb) {
	if ((this.currentIndex = i) >= this.work.length)
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

SocArrange.prototype.upload = function(entry, cb) {
	console.error("options=%j", entry.options);
	entry.getUploadable(this, (e, tmpPath) => {
		if (e)
			return void cb(e);
		this.getAlbum(entry.getDirName(), (e, album) => {
			if (e)
				return void cb(e);
			if (!album.id)
				return void cb(`No album id ${JSON.stringify(album)}`)
			console.error(`Uploading to album id=${album.id}`);
			entry.getDescription(null, (e, description) => {
				if (e)
					return void cb(e);
				this.wmethod("video.save")({
					album_id: album.id,
					is_private: 0,
					name: entry.getName(),
					description
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
	this.wmethod("video.addAlbum")({
		title: name, privacy: 0}, (e, r) => {
			if (e)
				return void(cb(e));
			if (!r.response.album_id)
				return void(cb(`No album_id ${JSON.stringify(r)}`));
			r.response.id = r.response.album_id;
			cb(null, this.albums[name] = r.response);
		});
};

SocArrange.prototype.check = function(entry, cb) {
	let album = this.albums[entry.getDirName()];
	if (!album) {
		this.work.push(entry);
		return void cb();
	}
	this.getItems(album, (e, items) => {
		if (e)
			return void cb(e);
		const existing = entry.find(items);
		if (existing.length === 0) {
			this.work.push(entry);
			return void cb();
		}
		this.setVidsName(existing, entry, cb);
	});
};

SocArrange.prototype.setVidsName = function(videos, entry, cb) {
	const name = entry.getName();
	while (videos.length !== 0) {
		const v = videos.shift();
		return void entry.getDescription(v, (e, desc) => {
			if (e)
				return void cb(e);
			if (v.title !== name)
				console.error("Renaming %j to %j", v.title, name);
			else if (v.description !== desc)
				console.error("Updating description on %j", v.title);
			else
				return void this.setVidsName(videos, entry, cb);
			this.wmethod("video.edit")(
				{name, desc, video_id: v.id}, (e, r) => {
					if (e)
						return void cb(e);
					// verb(".edit=%j", r);
					this.setVidsName(videos, entry, cb);
				});
		});
	}
	cb();
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
	if (this.options.dry) {
		return void cb(`Dry run not supported with current options`);
	}
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
	const method = function(query, cb) {
		if (this.lastReqTime) {
			const d = 333 + (this.lastReqTime - new Date);
			if (d >= 0)
				return void setTimeout(method, d, query, cb);
		}
		this.lastReqTime = new Date;
		query.access_token = this.options.token;
		query.v = "5.52";
		const options = {
			host: "api.vk.com",
			path: `/method/${name}?${querystring.stringify(query)}`};
		https.get(options, res => {
			exports.readWhole(res, (e, buf) => {
				if (e)
					return void cb(e);
				try {
					var r = JSON.parse(buf.toString());
				} catch(e) {
					return void cb(e);
				}
				if (r.error)
					return void cb(r.error);
				cb(null, r);
			});
		});
	}.bind(this);
	return method;
};

SocArrange.prototype.wmethod = function(name) {
	return this.options.dry ? function(query, cb) {
		cb(null, {})
	} : this.method(name);
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

if (process.platform === "darwin" && (!options.nocaffeinate)) {
	const cmd = process.argv.concat(["--nocaffeinate"]);
	spawn("caffeinate", cmd, {stdio: [0, 1, 2]});
} else {
	SocArrange(options).run(e => {
		if (e) {
			throw (e.error_msg || e)
		}
	});
}

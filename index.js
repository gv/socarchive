#!/usr/bin/env node
"use strict"
const options = require("./lib/commander.js").
	  description("A script to make hardsubs & upload them to vk.com").
	  option("-t, --token <token>", "Access token").
	  option(
		  "-m, --move <id>",
		  "Read items from stdin and move them to album <id>").
	  option(
		  "-r, --remove",
		  "Read items from stdin and remove them").
	  option("-o, --open", "Get OAuth page").
	  option("--srt <substring>", "Get a subtitle with this substring").
	  option("--topSrt <substring>", "Top subtitle").
	  option("--embedded", "Use embedded subtitles").
	  option("--upload <path>", "Test upload").
	  option("--reverse", "Read directories in reverse order").
	  option("--list", "List videos").
	  option("--verbose, -v", "Verbose").
	  option("--copy", "Copy source videos to temp dir before encoding").
	  option("--updatedescriptions", "Update descriptions").
	  option("--gu <path>", "Get uploadable file").
	  /*
	  option(
		  "--rename-subs",
		  "Don't upload anything, rename subtitles to match video file names").
	  */
	  option("--dry", "Dry run").
	  option("--nocaffeinate", "Do not suppress sleeping on Mac").
	  option("--save <output_dir>", "Save hardsubs there").
	  parse(process.argv);

const https = require("https");
const querystring = require("querystring");
const url = require("url");
const child_process = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events").EventEmitter;
const util = require("util");

util.inherits(Entry, EventEmitter);

function Description(text) {
	if (!new.target)
		return new Description(text);
	if (text) {
		const parts = text.split("\n\n");
		this.title = parts.shift();
		for (let p of parts) {
			const q = p.split(":\n\t");
			throw new Error("TODO");
		}
	}
}

Description.prototype.getTextSync = function() {
	return [this.title].concat(
		["Notes", "Subtitles", "Top subtitles"].
			filter(n => this[n]).
			map(n => `${n}:\n   ${this[n]}`)).
		join("\n\n");
};

Description.prototype.setPart = function(name, text) {
	this[name] = text;
	return this;
};

function Entry(ep, dir, options) {
	if (!new.target)
		return new Entry(ep, dir, options);
	this.parts = ep.split(new RegExp(`\\${path.sep}+`, "g"));
	this.path = ep;
	this.options = options;
	this.dir = dir;
}

const verb = function() {
	console.error.apply(console, arguments);
};

Entry.prototype.getDirName = function() {
	if (this.options.albumTitle) {
		return this.options.albumTitle.replace("%Y", s => {
			const name = this.parts.slice(-1)[0], m = name.match("\\d{4}");
			if (!m)
				throw new Error(`No year in "${name}"`);
			return m[0];
		});
	}
	const p = [];
	for (let i = this.parts.length - 2; i >= 0; i--) {
		p.unshift(this.parts[i]);
		let words = this.parts[i].split(/[^A-Za-z]+/g);
		words = words.filter(x => !x.match(/season|series|^$/i));
		if (words.length)
			break;
	}
	const srt = this.dir.options.srt || this.dir.options.topSrt;
	return `${p.join(", ")} ${srt.toUpperCase()} SUB`;
};

Entry.prototype.isTitle = function(n) {
	let words = n.split(/[^A-Za-z]+/g);
	words = words.filter(x => !x.match(/episode|season|series|^$/i));
	return !!words.length;
};

Entry.prototype.getName1 = function() {
	return this.parts.slice(-1)[0].replace(/[.][^.]+$/, "");
};

Entry.prototype.getNameA = function() {
	let m = -1, n = this.parts.slice(m)[0].replace(/[.][^.]+$/, "");
	while (!this.isTitle(n) && (-m < this.parts.length))
		n = this.parts.slice(--m)[0] + " " + n;
	return n;
};

Entry.prototype.getName2_0 = function() {
	let srt = this.options.srt || this.options.topSrt;
	return `${this.getNameA()} ${srt.toUpperCase()} SUB`;
};

Entry.prototype.getName2_1 = function() {
	if ("none" === this.options.srt)
		return this.getNameA();
	else
		return this.getName2_0();
};

Entry.prototype.getName2_2 = function() {
	if (!this.options.title)
		return this.getName2_1();
	return this.options.title.replace(
		new RegExp("\\$(\\d)"), x => {
			throw x;
		});
};

Entry.prototype.getName3 = function() {
	if (!this.options.title)
		return this.getName2_1();
	return this.subst(this.options.title.replace("%N", s => this.number(-1)).
		replace("%M", s => this.number(-2)) +
		(("none" === this.options.srt) ? "" :
		 ` ${this.options.srt.toUpperCase()} SUB`));
};

Entry.prototype.number = function(index) {
	let p = this.parts.slice(index)[0], m;
	if (m = p.match("[0-9.]+"))
		return m;
	throw new Error(`No number in "${p}"`);
};

Entry.prototype.getName = Entry.prototype.getName3;

Entry.prototype.getNameUnused = function() {
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
		if (this.getName1() === x.title ||
			this.getName2_0() === x.title ||
			this.getName3() === x.title)
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

const findSameName = function(entry, names, dir, cb) {
	// Shouldn't use fs.exists here bc ".srt" letters might be in
	// different cases
	// console.error("check %j", entry.getName1(), entry.getSubtitleNames());
	return void find1(entry, names, dir, entry.getName1(), cb);
};

const getSubtitleName1 = function(entry, names, dir, cb) {
	findSameName(entry, names, dir, (e, r) => {
		if (r)
			return void cb(null, r);
		let name = entry.parts[entry.parts.length - 1],
			m = name.match("S(\\d\\d)E(\\d\\d)") ||
			name.match("(\\d+)[.](\\d+)") ||
			name.match("\\d+");
		if (!m) 
			return void cb(e);

		if (!m[2]) 
			return void find1(entry, names, dir, `[Ee]${m[0]}`, cb);

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
	});
}

const getSubtitleName = function(entry, cb) {
	getSubtitleName1(
		entry, entry.getSubtitleNames(), path.dirname(entry.path), cb);
};

const find1 = function(entry, names, dir, pat, cb) {
	// console.error("Matching %j in %j", pat, names);
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
	if (this.options.embedded) {
		if (this.options.srtDir)
			return void cb(new Error(
				"'embedded' and 'srtDir' options incompatible"));
		return void this.getHardsubForFullPathWithProgress(
			this.path, progressHandler, cb);
	} else if ("none" === this.options.srt) {
		return void cb(null, this.path);
	} else if (this.options.srt) {
		const srtDir = this.options.srtDir &&
			  path.join(this.options.configPath, "..", this.options.srtDir) ||
			  path.dirname(this.path);
		this.getSubtitleNameFrom(srtDir, (e, r) => {
			if (e)
				return void cb(e);
			this.getHardsubForFullPathWithProgress(
				path.join(srtDir, r), progressHandler, cb);
		});
	} else {
		cb(new Error("Uploading without subtitles disabled"));
	}
};

Entry.prototype.getUploadableDoubleEnc = function(progressHandler, cb) {
	throw "TODO Adjust for this.sub == null";
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
			this.getHardsubNoCopyWithProgress(
				hard1, path.join(sp, sn2) + ":force_style='Alignment=6'",
				progressHandler, (e, h2) => {
					this.releaseUploadable(hard1);
					cb(e, h2);
				});
		});
	});
};

Entry.prototype.getUploadable = function(progressHandler, cb) {
	if ("none" === this.options.srt)
		return void cb(null, this.path);
	this.getTopSubtitle(e => {
		if (e)
			return void cb(e);
		this.getSubtitle(e => {
			if (e)
				return void cb(e);
			this.adjustSub((e, sub) => {
				if (e)
					return void cb(e);
				this.getHardsubForFullPathWithProgress(
					sub, progressHandler, cb);
			});
		});
	});
};

// ffmpeg -itsoffset 2 -i subtitles.srt -c copy subtitles_delayed.srt
Entry.prototype.adjustSub = function(cb) {
	if (!this.options.delay || (this.options.delay == 0) || !this.sub)
		return void cb(null, this.sub);
	const tmpPath = path.join(this.getTmpDirPath(), this.getName() + ".srt");
	let cmd = this.getFfmpegSync().concat(
		"-y", "-nostdin", "-itsoffset", this.options.delay,
		"-i", this.sub, "-c", "copy", tmpPath);
	spawn(cmd.shift(), cmd, {stdio: [0, 1, 2]}, e => {
		cb(e, tmpPath);
	});
	process.on("exit", () => {
		this.deleteTmpFileSync(tmpPath);
	});
};
			
Entry.prototype.getTmpDirPath = function() {
	return (process.platform == "win32") ? process.cwd() : "/tmp";
};

Entry.prototype.releaseUploadable = function(tmpPath) {
	if ("none" !== this.options.srt)
		if (!this.options.save)
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
		return void this.getHardsubNoCopyWithProgress(
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
				this.getHardsubNoCopyWithProgress(
					tmp, sub, progressHandler, cb);
			});
	});
};

// See ffmpeg/doc/filters.texi @section Notes on filtergraph escaping

const quoteForFilterDef = str =>
	  str.replace(new RegExp("['\\\\:]", "g"), "\\$&");

const quoteForFilterGraph = str =>
	  quoteForFilterDef(str).replace(new RegExp("['\\\\,;\\[\\]]", "g"), "\\$&");

Entry.prototype.getFfmpegSync = function() {
	return process.platform === "win32" ?
		  [path.join(__dirname, "bin", "ffmpeg.exe")] :
		  process.platform === "darwin" ?
		//[path.join(process.execPath, "..", "ffmpeg")] :
		  [path.join(__dirname, "lib", "ffmpeg")] :
		  ["ffmpeg", "-strict", "-2"];
}

Entry.prototype.getFfmpegCommandSync = function(src, sub, tmp) {
	let enc = this.options.srtEncoding || "cp1251";
	let ff = [];
	if (sub)
		ff.push(`subtitles=${quoteForFilterGraph(sub)}:charenc=${enc}`);
	if (this.topSrt) {
		if (this.topSrt.sid) {
			ff.push(`subtitles=${quoteForFilterGraph(src)}:\
stream_index=${this.topSrt.sid}:`);
		} else {
			ff.push(`subtitles=${quoteForFilterGraph(this.topSrt)}:`);
		}
		const enc = this.options.topSrtEncoding || "cp1251";
		ff[ff.length - 1] += `force_style='Alignment=6':charenc=${enc}`;
	}
	let cmd = this.getFfmpegSync();
	if (this.options.ffmpeg && this.options.ffmpeg.input)
		cmd = cmd.concat(this.options.ffmpeg.input.split(" "));
	cmd = cmd.concat([
		"-i", path.resolve(src), "-vf", ff.join(","), "-y", "-nostdin"]);
	if (this.options.ffmpeg && this.options.ffmpeg.output)
		cmd = cmd.concat(this.options.ffmpeg.output.split(" "));
	cmd.push(tmp);
	return cmd;
};

Entry.prototype.getMencoderCommandSync = function(src, sub, out) {
	const vp = x => path.dirname(x) + ":" + path.dirname(x);
	const isHb = 1;
	let cmd = process.platform === "win32" ?
		[path.resolve(__filename, "..", "lib", "mencoder.exe")] :
		["docker", "run", "--rm", 
		 "-v", vp(src), "-v", vp(sub), "-v", vp(out),
		 "--entrypoint", isHb ? "/bin/HandBrakeCLI": "/bin/mencoder",
		 "-t", "ivonet/mediatools"];
	if (this.isDvdSync()) {
		if (isHb) {
			cmd = cmd.concat([
				"-i", src, "-o", out, "-a2",
				"--subtitle-burned=2"]);
		} else {
		cmd = cmd.concat([
			"-dvd-device", path.join(this.path, "VIDEO_TS"), "dvd://1",
			"-vobsubout", "subs", "-vobsuboutindex", "0", "-sid", "1",
			"-aid", "129", src, "-o", out,
			"-oac", "lavc", "-ovc", "lavc"]);
		}
	} else {
		cmd = cmd.concat(
			[src, "-oac", "copy", "-ovc", "copy", "-o", out]);
		if (path.basename(sub) != path.basename(src)) {
			cmd = cmd.concat(["-sub", sub]);
		}
	}
	return cmd.concat(this.options.mencoder || [])
};                           

Entry.prototype.getHardsubNoCopyWithProgress = function(
	src, sub, progressHandler, cb) {
	const tmp = this.options.save ? (
		this.options.configDir ?
			path.join(
				this.options.configDir, this.options.save,
				this.getName() + ".mp4") :
			path.join(this.options.save, this.getName() + ".mp4")):
		  path.join(this.getTmpDirPath(), this.getName() + ".tmp.mp4");
	this.makeDirectoryIfNotExists(path.dirname(tmp), e => {
		if (e)
			return void cb(e);
		let options = {stdio: ["inherit", "inherit", "pipe"]}, cmd, prog;
		if (this.options.cd && sub) {
			// If quoting breaks again use this
			options.cwd = path.dirname(sub);
			sub = path.basename(sub);
		}
		if (this.options.verbose)
			options.stdio[2] = "inherit";
		if (process.platform === "win32" || this.isDvdSync())
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
		this.options.save || process.on("exit", () => {
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
	});
};

Entry.prototype.makeDirectoryIfNotExists = function(p, cb) {
	fs.stat(p, (e, st) => {
		if (e) {
			if (e.code !== "ENOENT")
				return void cb(e);
			return void this.makeDirectoryIfNotExists(path.dirname(p), e => {
				if (e)
					return void cb(e);
				fs.mkdir(p, cb);
			});
		}
		cb(st.isDirectory() ? null : new Error(
			`${JSON.stringify(p)} is not a directory`));
	});
};

Entry.prototype.getDescription = function(video, cb) {
	// TODO delete private data from path
	// cb(null, this.path)
	//return void cb(null, this.parts.slice(-2).join("/"));
	this.getSubtitle(e => {
		if (e)
			return void cb(e);
		this.getTopSubtitle(e => {
			if (e)
				return void cb(e);
			const cutPath = parts => parts.slice(-2).join("/");
			const d = Description(cutPath(this.parts));
			if (this.options.notes)
				d.setPart("Notes", this.options.notes);
			if (this.sub) 
				d.setPart("Subtitles", cutPath(this.sub.split(path.sep)));
			if (this.topSrt)
				d.setPart(
					"Top subtitles",
					this.topSrt.sid ? `embedded id=${this.topSrt.sid}` :
						cutPath(this.topSrt.split(path.sep)));
			cb(null, d.getTextSync());
		});
	});
};

Entry.prototype.getSubtitle = function(cb) {
	if (this.sub || "none" === this.options.srt || !this.options.srt)
		return void cb(null, this.sub);
	if (this.options.embedded) {
		if (this.options.srtDir)
			return void cb(new Error(
				"'embedded' and 'srtDir' options incompatible"));
		this.sub = this.path;
		return void cb(null, this.sub);
	}
	const p = this.options.srtDir &&
		  path.join(this.options.configDir, this.options.srtDir) ||
		  path.dirname(this.path);
	this.getSubtitleNameFromDirOrItself(p, (e, n) => {
		if (e)
			return void cb(e);
		cb(null, this.sub = path.join(p, n));
	});
};

Entry.prototype.getTopSubtitle = function(cb) {
	if (this.topSrt || (!this.options.topSrt))
		return void cb(null, this.topSrt);
	if (this.options.topSrt.sid)
		return void cb(null, this.topSrt = this.options.topSrt);
	if (this.options.topSrt.file)
		return void cb(null, this.topSrt = path.join(
			path.dirname(this.path), this.options.topSrt.file));
	let d;
	if (this.options.topSrt.dir) {
		d = path.join(
			this.options.configDir, this.options.topSrt.dir);
	} else {
		if ("none" === this.options.srt || !this.options.srt)
			d = path.dirname(this.path);
		else
			return void cb(new Error(
				`topSrt option needs to have 'dir' or 'sid' subkey`));
	}
	this.getSubtitleNameFrom(d, (e, filename) => {
		if (e)
			return void cb(e);
		cb(null, this.topSrt = path.join(d, filename));
	});
};

Entry.prototype.subst = function(tmpl) {
	return tmpl.replace(new RegExp("%e", "g"), s => {
		let m = this.parts.slice(-1)[0].match("[Ee](\\d+)");
		if (m === null)
			throw new TypeError(`No ${s}`);
		return m[1];
	}).replace(new RegExp("%\\d", "g"), s => {
		const n = +(s.substring(1));
		return this.parts[this.parts.length - n];
	});
};

Entry.prototype.getSubtitleNameFromEx = function(dir, options, cb) {
	const is1 = array => {
		if (array.length === 1) {
			cb(null, array[0]);
			return true;
		}
		if (array.length !== 0)
			throw new Error("TODO");
	};
	this.listSubtitlesIn(dir, (e, names) => {
		if (e)
			return void cb(e);
		if (1 === names.length)
			return void cb(null, names[0]);
		if (0 === names.length && options.maybeItself) {
			const n = this.parts.slice(-1)[0];
			if (n.match(new RegExp("[.]mkv$", "i")))
				return void cb(null, this.parts.slice(-1)[0]);
		}

		if (this.options.srtMatch) {
			if (!is1(names.filter(
				n => n.match(this.subst(this.options.srtMatch))))) {
				throw new Error("TODO")
			}
			return;
		}
		
		if (is1(names.filter(name => (name.toLowerCase() === (
			this.getName1().toLowerCase() + ".srt")))))
			return;
		const cd = this.parts.slice(-1)[0].match("CD\\d+");
		if (cd) {
			if (is1(names.filter(n => n.match(cd[0]))))
				return;
		}
		getSubtitleName1(this, names, dir, cb);
	});
};

Entry.prototype.getSubtitleNameFrom = function(dir, cb) {
	this.getSubtitleNameFromEx(dir, {'maybeItself': false}, cb);
};

Entry.prototype.getSubtitleNameFromDirOrItself = function(dir, cb) {
	this.getSubtitleNameFromEx(dir, {'maybeItself': true}, cb);
};

Entry.prototype.listSubtitlesIn = function(dir, cb) {
	fs.readdir(dir, (e, names) => {
		if (e)
			return void cb(e);
		cb(null, names.filter(x => !x.match("^._")).
		   filter(x => x.match(new RegExp("[.]srt$", "i"))));
	});
};

Entry.prototype.isDvdSync = function() {
	return fs.existsSync(path.join(this.path, "VIDEO_TS"));
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

function Directory(options) {
	this.options = options;
	this.subtitleNames = [];
}

function SocArrange(options) {
	if (!(this instanceof SocArrange))
		return new SocArrange(options);
	this.options = options;
	this.count = {moved: 0, deleted: 0, subtitles: 0};
}

SocArrange.prototype.verbFromProgram = function(prog, message) {
	let m = util.format(
		"%s [%d/%d]: %j", prog.replace(__dirname, "@"),
		this.currentIndex, this.work.length,
		message.replace(/\s+$/, ""));
	if (message.match("^frame="))
		m += "\r";
	else
		m += "\n"
	process.stderr.write(m);
};

SocArrange.prototype.openBrowser = function(cb) {
	let url = `https://oauth.vk.com/authorize?client_id=51820460q&\
display=page&redirect_uri=https://oauth.vk.com/blank.html&\
scope=video,friends&response_type=token&v=5.52`;
	spawn("open", [url], {stdio: [0, 1, 2]});
};

SocArrange.prototype.run = function(cb) {
	this.runOrOpenBrowser(e => {
		if(e && 5 === e.error_code) {
			console.error("Received error: %j", e);
			return void this.openBrowser(cb);
		}
		cb(e);
	})
};

SocArrange.prototype.runOrOpenBrowser = function(cb) {
	if (this.options.open) {
		if (this.options.move || this.options.remove) {
			console.error(
				"Can't have --open with --move --remove");
			process.exit(1);
		}
		return void this.openBrowser(cb);
	}

	if (this.options.gu) {
		this.options.save = path.dirname(this.options.gu);
		this.work = [Entry(
			this.options.gu, this.options.save, this.options)];
		return void this.work[0].getUploadable(this, cb);
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
engage embedded subs, use --embedded --srt LANG")); 
		this.loadFiles(cb);
		this.loadArchiveState(cb);
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

SocArrange.prototype.loadArchiveState = function(cb) {
	// Temp
	this.albums = {};
	this.uploadEverything(cb);
};

SocArrange.prototype.loadFiles = function(cb) {
	this.count.files = {target: 0};
	this.files = [];
	for(var p of this.options.args)
		this.load(p, new Directory(this.options), this.options, cb);
};

SocArrange.prototype.getEffOptsSync = function(p, options) {
	throw new TypeError("TODO");
};

SocArrange.prototype.loadDir = function(p, options, cb) {
	const confPath = path.join(p, "sbackup.json");
	fs.stat(confPath, (e, st) => {
		if (!e)
			return void this.loadConfig(confPath, cb);
		if ("ENOENT" === e.code)
			return void this.loadDirNoDirConfFile(p, options, cb);
		cb(e);
	});
};

SocArrange.prototype.loadDirNoDirConfFile = function(p, options, cb) {
	fs.readdir(p, (e, list) => {
		if (e)
			return void this.handleLoadComplete(e, cb);
		const newDir = new Directory(options);
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
	// console.error("file=%s options=%s", p, JSON.stringify(effOpts, null, 2));
	if (effOpts.exceptions) {
		for (let n of p.split(path.sep)) {
			if (newOpts = options.exceptions[n]) {
				// Object.setPrototypeOf(newOpts, effOpts);
				// effOpts = newOpts;
				effOpts = Object.assign({}, effOpts, newOpts);
			}
		}
	}
	if (effOpts.skip) {// || (effOpts.delay && effOpts.delay != 0)) {
		this.log("Skipping %j", p);
		this.count.files.target--;
	} else {
		this.files.push(new Entry(p, dir, effOpts));
	}
	this.handleLoadComplete(null, cb);
};

SocArrange.prototype.log = function(/*...*/) {
	console.error.apply(console, arguments);
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
	     "subdir1": {"embedded": true},
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
	const options = Object.assign(
		{}, this.options, conf.options || {})
	// Object.setPrototypeOf(options, this.options);
	
	if (options.loadRoot) {
		const exceptions = {}, add = (k, v) => {
			if (k in exceptions)
				throw new Error(`Can't add ${k} twice`)
			exceptions[k] = v;
		};
		for (let k in conf) {
			if (k !== "options")
				add(k, conf[k]);
			if (conf[k].exceptions) {
				for (let c in conf[k].exceptions)
					add(c, conf[k].exceptions[c]);
			}
		}
		options.exceptions = exceptions;
		options.configPath = p;
		options.configDir = path.dirname(p);
		this.load(path.dirname(p), new Directory(options), options, cb);
	} else {
		for (let k in conf) {
			if (k === "options")
				continue;
			const sourcePath = path.resolve(p, "..", k);
			//const c = conf[k];
			//Object.setPrototypeOf(c, options);
			// conf[k].xxx is more important then options.xxx
			const c = Object.assign({}, options, conf[k]);
			c.configPath = p;
			c.configDir = path.dirname(p);
			// this will increase target count 
			this.load(sourcePath, new Directory(c), c, cb);
		}
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

SocArrange.prototype.upload1 = function(entry, cb) {
	// console.error("options=%j", entry.options);
	entry.getUploadable(this, (e, tmpPath) => {
		if (e)
			return void cb(e);
		this.getAlbum(entry.getDirName(), (e, album) => {
			if (e)
				return void cb(e);
			if (!album.id)
				return void cb(`No album id ${JSON.stringify(album)}`)
			console.error(`\
Uploading "${entry.getName()}" to album "${entry.getDirName()}" (${album.id})`);
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

SocArrange.prototype.upload = function(entry, cb) {
	this.checkSafeRename(entry.getName(), {}, e => {
		if (e)
			return void cb(e);
		this.upload1(entry, cb);
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
	delete options.query;
	delete options.href;
	console.error("upload %j", options);
	options.headers = {
		"Content-Type": `multipart/form-data; boundary=${boundary}`
	};
	const req = https.request(options);
	req.write(`--${boundary}\r\n`);
	req.write(
		`Content-Disposition: form-data; name="video_file"; filename="${tmpPath}"\r\n`);
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
		let msg = `Upload status=${res.statusCode} "${res.statusMessage}"`;
		console.error(msg);
		console.error("headers=%j", res.headers);
		res.pipe(process.stderr);
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

SocArrange.prototype.checkWithAlbum = function(entry, cb) {
	process.stderr.write(util.format(
		"Looking for %j in %j...", entry.getName(), entry.getDirName()));
	let album = this.albums[entry.getDirName()];
	if (!album) {
		console.error("No album");
		this.work.push(entry);
		return void cb();
	}
	this.getItems(album, (e, items) => {
		if (e)
			return void cb(e);
		const existing = entry.find(items);
		if (existing.length === 0) {
			console.error("Not found");
			this.work.push(entry);
			return void cb();
		}
		console.error("%j items", existing.length);
		this.setVidsName(existing, entry, cb);
	});
};

SocArrange.prototype.check = function(entry, cb) {
	// console.error("options=%s", JSON.stringify(entry.options, null, 1))
	process.stderr.write(util.format(
		"Looking for %j...", entry.getName()));
	this.getVideos(e => {
		if (e)
			return void cb(e);
		const existing = entry.find(this.videos);
		if (0 === existing.length) {
			console.error("Not found");
			this.work.push(entry);
			return void cb();
		}
		console.error("%j items", existing.length);
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
			// TODO
			// Description will change if subtitle options are
			// changed, but it would become inconsistent with the
			// video then
			// TODO
			else if (this.options.updatedescriptions &&
					 (v.description !== desc))
				console.error("Updating description on %j", v.title);
			else
				return void this.setVidsName(videos, entry, cb);
			this.checkSafeRename(name, v, e => {
				if (e)
					return void cb(e);
				this.wmethod("video.edit")(
					{name, desc, video_id: v.id}, (e, r) => {
						if (e)
							return void cb(e);
						// verb(".edit=%j", r);
						this.setVidsName(videos, entry, cb);
					});
			});
		});
	}
	cb();
};

SocArrange.prototype.checkSafeRename = function(name, v, cb) {
	if (name === v.title)
		return void cb(null);
	const e = new Error, getError = message => {
		e.message = message;
		return e;
	};
	this.getVideos(e => {
		cb(e ||
		   ((this.videos.filter(v => name === v.title).length) &&
			getError(`Name "${name}" already exists`)));
	});
};

SocArrange.prototype.getVideos = function(cb) {
	if (this.videos)
		return void cb(null, this.videos);
	this.loadVideos([], (e, videos) => {
		if (e)
			return void cb(e);
		cb(null, this.videos = videos);
	});
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
		const e = new Error();
		if (this.lastReqTime) {
			const d = 333 + (this.lastReqTime - new Date);
			if (d >= 0)
				return void setTimeout(method, d, query, cb);
		}
		this.lastReqTime = new Date;
		query.access_token = this.options.token;
		query.v = "5.81";
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

if (require.main === module) {
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
}
exports.SocArrange = SocArrange;

#!/usr/bin/env node
const options = require("./commander.js").
	  description("A script to autotranslate subtitles to latvian").
	  option(
		  "-m, --merge",
		  "Merge 2 srt subtitles to SSA file with 1st @ the bottom + 2nd @ the top").
	  option("-f, --force", "Reprocess even if all output paths exist").
	  option("-v, --verbose", "Verbose").
	  parse(process.argv);

const takeoff = new Date;
const https = require("https");
const fs = require("fs");
const url = require("url");
const stream = require("stream");
const path = require("path");
const util = require("util");

const Subtitle = function() {
	if (!new.target)
		return new Subtitle();
	this.style = "Bottom";
};

Subtitle.prototype.toSrt = function() {
	return this.number + "\n" + this.time + "\n" +
		this.text.split("\n").map(
			x => x.trim()).filter(x => !!x).join("\n");
};

Subtitle.prototype.copy = function() {
	const ns = Subtitle();
	ns.number = this.number;
	ns.time = this.time;
	ns.text = this.text;
	return ns;
};

Subtitle.prototype.getTime = function(i) {
	const p = this.time.split("-->")[i].trim().split(",");
	p[1] = p[1].substring(0, 2);
	return p.join(".");
};

Subtitle.prototype.getStart = function() {
	return this.getTime(0);
};

Subtitle.prototype.getEnd = function() {
	return this.getTime(1);
};

Subtitle.prototype.getText = function() {
	return this.text.replace(/<[/]?i>/g, "").trim();
};

// Subtitle.prototype.valueOf = Subtitle.prototype.getStart;

const SrtFile = function(path) {
	if (!new.target)
		return new SrtFile(path);
	this.path = path;
	this.subtitles = [];
};

SrtFile.prototype.load = function(cb) {
	fs.readFile(this.path, "utf-8", (e, text) => {
		if (e)
			return void cb(e);
		let entry;
		for (let line of text.split("\n")) {
			if (!(line = line.trim())) {
				if (entry) {
					this.subtitles.push(entry);
					entry = null;
				}
				continue;
			}
			if (!entry)
				entry = Subtitle();
			if (!entry.number) {
				entry.number = line;
				continue;
			}
			if (!entry.time) {
				entry.time = line;
				continue;
			}
			if (!entry.text) {
				entry.text = line;
				continue;
			}
			entry.text += "\n" + line;
		}
		if (entry)
			this.subtitles.push(entry);
		process.nextTick(cb, null, this);
	});
	return this;
};

SrtFile.prototype.save = function(cb) {
	fs.writeFile(
		this.path, this.subtitles.map(x => x.toSrt()).join("\n\n"), cb);
};

const SsaFile = function(path) {
	if (!new.target)
		return new SsaFile(path);
	this.path = path;
};

SsaFile.prototype.save = function(cb) {
	let contents = `\
[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Top,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0
Style: Bottom,Arial,12,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
	this.subtitles.sort((x, y) => {
		const x1  = x.getStart() + x.style;
		const y1 = y.getStart() + y.style;
		if (x1 < y1)
			return -1;
		if (x1 > y1)
			return 1;
		return 0;
	});
	contents += this.subtitles.map(x => {
		if (!x.text) {
			console.error("Bad subtitle: %j", x);
			return "";
		}
		const text = x.text.split("\n").join(" ");
		return `\
Dialogue: 0,${x.getStart()},${x.getEnd()},${x.style},,0,0,0,,${text}`
	}).join("\n");
	fs.writeFile(this.path, contents, cb);
};

const Translator = function(key, options) {
	if (!new.target)
		return new Translator(key, options);
	this.key = key;
	this.options = options;
};

Translator.prototype.translate = function(text, cb) {
	const obj = {
		text: text,
		systemID: "smt-e98a9ae8-c288-45bb-bbe2-0cf0baf3019d",
		appId: "r6vs",
	};
	const reqOptions = url.parse(
		"https://hugo.lv/ws/Service.svc/json/Translate", false);
	reqOptions.method = "POST";
	reqOptions.path = reqOptions.pathname;
	delete reqOptions.pathname;
	const msg = Buffer(JSON.stringify(obj));
	reqOptions.headers = {
		"client-id": this.key,
		"Content-Type": "application/json",
		"Content-Length": msg.length
	};
	const req = https.request(reqOptions, res => {
		if (res.statusCode != 200) {
			console.error(
				"statusCode=%j headers=%j", res.statusCode, res.headers); 
			res.pipe(process.stderr);
			res.on("end", () => {
				return void cb(
					`Input:\n${text}
Status=${res.statusCode}, Length=${text.length}`);
			});
		} else {
			cb(null, res);
		}
	});
	req.end(msg);
};

Translator.prototype.translateSubtitlesFileToStream = function(file, tool, cb) {
	const limit = 100, sep = "23985623865",
		  readable = new stream.Readable(
			  {objectMode: true, read: () => {}});
	const churn = start => {
		let text = file.subtitles.slice(start, start + limit).
			map(x => x.getText()).join("  " + sep + " ");
		tool.printStatus(`Sending ${path.basename(file.path)}...`)
		this.translate(text, (e, tr) => {
			if (e) 
				return void readable.emit("error", e);

			exports.readWhole(tr, (e, b) => {
				if (e)
					return void readable.emit("error", e);

				const chunks = b.toString("utf-8").split(sep);
				for(let i = 0; i < chunks.length; i++) {
					const ns = file.subtitles[start + i].copy();
					ns.text = chunks[i].trim();
					readable.push(ns.toSrt() + "\n\n");
				}
				tool.count.subtitles.done += chunks.length;
				if (start + limit < file.subtitles.length)
					churn(start + limit);
				else
					readable.push(null);
			});
		});
	};
	churn(0);
	process.nextTick(cb, null, readable);
};

Translator.prototype.translateSubtitlesFile = function(file, tool, cb) {
	const limit = 100, sep = "23985623865",
		  result = SrtFile();
	const churn = start => {
		let text = file.subtitles.slice(start, start + limit);
		let sent = text.length;
		text = text.map(x => x.getText()).join("\n" + sep + ".\n");
		tool.printStatus(`Sending ${path.basename(file.path)}...`)
		this.translate(text, (e, tr) => {
			if (e) 
				return void cb(e);

			exports.readWhole(tr, (e, b) => {
				if (e)
					return void cb(e);

				if(this.options.verbose) {
					console.error(b.toString("utf-8"));
				}

				let chunks = JSON.parse(b.toString("utf-8")).split(
				//	sep + ".");
					new RegExp(`${sep}[\s.]*`));
				if (chunks.length !== sent)
					console.error(
						`Received ${chunks.length} from ${sent} sent`);
				let ns;
				if (chunks.length > limit) {
					const n = chunks.filter(x => !!x.trim());
					if (n.length != chunks.length) {
						console.error(
							"Filtered empty subtitles: %j => %j",
							chunks.length, n.length);
						chunks = n;
					}
				}
				if (chunks.length > limit) {
					const n = chunks.filter(
						(x, i) => {
							if (i == 0)
								return true;
							return (x.trim() != chunks[i - 1].trim()) ||
								file.subtitles[start + i] &&
								(file.subtitles[start + i].text.trim() ==
								 file.subtitles[start + i - 1].text.trim());
						});
					if (n.length != chunks.length) {
						console.error(
							"Filtered repeating subtitles: %j => %j",
							chunks.length, n.length);
						chunks = n;
					}
				}
				for(let i = 0; i < chunks.length; i++) {
					/* 
					   Sometimes translator generates extra chunks
					   at the end (or at other places too?)
					 */
					if (i < limit) { 
						ns = file.subtitles[start + i].copy();
						ns.text = null;
						ns.style = "Top";
						result.subtitles.push(ns);
					}
					if (ns.text) {
						ns.text += "\n" + chunks[i].trim();
					} else {
						ns.text = chunks[i].trim();
					}
				}
				tool.count.subtitles.done += chunks.length;
				if (start + limit < file.subtitles.length)
					churn(start + limit);
				else
					process.nextTick(cb, null, result);
			});
		});
	};
	churn(0);
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

function getLines(stream, sep, cb) {
	let acc = "", count = 0;
	stream.on("data", d => {
		var parts = (acc + d.toString("utf-8")).split(sep);
		acc = parts.pop();
		parts.forEach(x => {cb(x, false, count++)});
	});
	stream.on("close", () => {acc & cb(acc, true, count)});
};


const Tool = function(options) {
	if (!new.target)
		return new Tool(options);
	this.options = options;
	this.count = {subtitles: {done:0, target:0}};
};

Tool.prototype.run = function() {
	if (!this.options.args.length) {
		console.error("No input files");
		process.exit(1);
	}

	if (this.options.merge) {
		if (this.options.args.length > 2) {
			console.error("Too many arguments");
			process.exit(1);
		}
		const bp = this.options.args[0];
		const tp = this.options.args[1] ||
			  bp.replace(/[.]srt$/i, ".hugo.srt");
		const bottom = SrtFile(bp).load(e => {
			if (e)
				throw e;
			const top = SrtFile(tp).load(e => {
				if (e)
					throw e;
				const r = SsaFile(bp.replace(/[.]srt$/i, ".hugo.ass"));
				r.subtitles = bottom.subtitles.concat(
					top.subtitles.map(x => {
						x.style = "Top";
						return x;
					}));
				r.save(e => {
					if (e)
						throw e;
					console.error("Written %j", r.path);
				});
			});
		});
		return;
	}
	
	this.paths = this.options.args.filter(
		x => !x.match("[.]hugo[.]srt"));
	const skipped = this.options.args.length - this.paths.length;
	if (skipped)
		console.error(
			"Skipping %j output paths", skipped);
	if (!this.options.force) {
		const paths = this.paths.filter(
			x => !fs.existsSync(this.outPath(x, 0)) ||
				!fs.existsSync(this.outPath(x, 1)));
		const skipped = this.paths.length - paths.length;
		if (skipped) {
			console.error("Skipping %j processed inputs", skipped);
			this.paths = paths;
		}
	}
	if (!this.paths.length) {
		console.error("No input files left!");
		process.exit(1);
	}
	this.files = [];
	this.processTheRest();
}

Tool.prototype.processTheRest = function() {
	const path = this.paths.shift();
	if (!path) {
		this.translateFiles();
		return;
	}
	this.printStatus(`Loading ${path}...`)
	SrtFile(path).load((e, sf) => {
		if (e)
			throw e;
		this.files.push(sf);
		this.count.subtitles.target += sf.subtitles.length;
		process.nextTick(() => this.processTheRest());
	});
};

Tool.prototype.outPath = function(inputPath, index) {
	return inputPath.replace(
		/[.]srt$/i, [".hugo.srt", ".hugo.ass"][index]);
};

Tool.prototype.translateFiles = function() {
	const sf = this.files.shift();
	if (!sf)
		return;
	const key = fs.readFileSync(
		path.join(__dirname, "hugo-client-id.txt"), "utf-8").trim();
	Translator(key, options).
		translateSubtitlesFile(sf, this, (e, file) => {
			if (e)
				throw e;
			file.path = this.outPath(sf.path, 0);
			file.save(e => {
				if (e)
					throw e;
				this.printStatus(util.format("Written %j\n", file.path));
				const ssa = SsaFile();
				ssa.path = this.outPath(sf.path, 1);
				ssa.subtitles = sf.subtitles.concat(file.subtitles);
				ssa.save(e => {
					if (e)
						throw e;
					this.translateFiles()
				});
			});
		});
};

Tool.prototype.printStatus = function(message) {
	process.stderr.write(`\
\r${this.count.subtitles.done} / ${this.count.subtitles.target}\
 ${message}`);
};

// TODO Make this a flag + not process-wide
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
process.on("exit", () => {
	console.error(`Done in ${(new Date) - takeoff} ms`);
});
Tool(options).run();
	

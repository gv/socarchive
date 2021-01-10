const child_process = require("child_process");
const cpspawn = child_process.spawn;
const EventEmitter = require("events");
const result = {subprocesses: []};
child_process.spawn = (cmd, args) => {
	result.subprocesses.push([cmd].concat(args));
	const b = new EventEmitter();
	process.nextTick(_ => b.emit("close"));
	b.stdout = new EventEmitter();
	b.stderr = new EventEmitter();
	return b;
};

const socarrange = require("..");
socarrange.SocArrange({
	args: ["/Volumes/small1/v21/sbackup12.json"],
	token:
	"92f28cb0650671031e8302b57fda689f9828f9b316807a155c9702a06cf722c3f1691b4c31e25aec09ffe"
}).run(e => {
	if (e)
		throw e;
});

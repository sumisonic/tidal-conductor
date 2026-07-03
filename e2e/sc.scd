// Headless SuperDirt + conductor.scd + a monitor that counts `lt` events per 2 s (E2E harness).
// Started by e2e/run.sh as: sclang -u <SC_PORT> e2e/sc.scd   (E2E_REPO and E2E_SC_PORT are read from the environment)
var repo = "E2E_REPO".getenv, port = "E2E_SC_PORT".getenv.asInteger;
s.options.numOutputBusChannels = 2;
s.waitForBoot {
	~dirt = SuperDirt(2, s);
	~dirt.loadSoundFiles;
	s.sync;
	~dirt.start(port, [0, 0]);
	(repo ++ "/integration/supercollider/conductor.scd").load;
	~ltCount = 0;
	OSCdef(\e2eMonitor, { |msg|
		var params = Dictionary.newFrom(msg[1..]);
		if(params.at(\s) == \lt, { ~ltCount = ~ltCount + 1 });
	}, '/dirt/play', nil);
	Task({ loop { 2.wait; ("E2E lt-events/2s: " ++ ~ltCount).postln; ~ltCount = 0; } }).play(SystemClock);
	"E2E SC READY".postln;
};

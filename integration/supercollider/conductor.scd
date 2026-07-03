// tidal-conductor - SuperCollider side (self-contained; no other files needed)
//
// Load this once in sclang, e.g. from your startup file:
//   "path/to/conductor.scd".load;
// Loading it after SuperDirt has started is the recommended order, not a requirement: the OSCdefs
// and the watchdog work on their own. Reloading the file is safe (the previous watchdog is stopped).
//
// Two jobs:
// 1. Clock: watch Tidal's /dirt/play messages (every event carries `cycle` and `cps`) and forward
//    `/ai/ctx/cycle cycle cps` to every Conductor in `conductorPorts` whenever the cycle floor changes.
//    The Conductor extrapolates between messages, so silence does not stop it once synced.
// 2. Deadman: the Conductor sends `/ai/heartbeat <channel>` every second. If a channel's
//    heartbeat stops for 3 s (Conductor crashed or was killed), silence that channel directly
//    in Tidal (slots 1..8 to "~", density to 0) so the last AI pattern does not play forever.
//    It is armed from the moment this file loads: channel 1 is cleared once at load, and any
//    channel that has sent a heartbeat is cleared when it goes quiet (re-armed by the next beat).
//    The silence is repeated on the following ticks (UDP has no delivery guarantee) unless a new
//    heartbeat arrives first.
// Also answers `/ai/ping` with `/ai/pong "ok" 1.0 armed` to the sender of the ping (pnpm preflight).
//
// Ports: `conductorPorts` lists the listen port of every Conductor process the clock is sent to
// (default [6011]; add one entry per extra Conductor). Tidal's /ctrl listener is 127.0.0.1:6010.
// The OSCdefs receive on sclang's own port (NetAddr.langPort, normally 57120), which is where the
// Conductor sends heartbeats and pings (AI_SCLANG_PORT).
(
var conductorHost = "127.0.0.1", conductorPorts = [6011];
var tidalHost = "127.0.0.1", tidalPort = 6010;
var deadmanTimeout = 3, resendTicks = 2, maxChannel = 1000000;

"tidal-conductor: loading conductor.scd".postln;

// Reloading: stop the previous watchdog before the Event that holds it is replaced
// (otherwise every reload leaks one more Task loop)
~conductor !? { |old| old[\deadman] !? { |t| t.stop } };

~conductor = (
	toConductors: conductorPorts.collect({ |p| NetAddr(conductorHost, p) }),
	toTidal: NetAddr(tidalHost, tidalPort),
	lastCycleFloor: -1,
	heartbeats: Dictionary.new,  // channel -> last heartbeat time (Main.elapsedTime)
	resend: Dictionary.new,      // channel -> remaining repeats of the silence after the deadman fired
	deadman: nil
);

// Silence one channel directly in Tidal (same keys the Conductor writes)
~conductor[\silence] = { |ch, quiet = false|
	(1..8).do({ |n|
		~conductor.toTidal.sendMsg("/ctrl", ("ai/" ++ ch ++ "/" ++ n).asSymbol, "~");
	});
	~conductor.toTidal.sendMsg("/ctrl", ("ai/" ++ ch ++ "/density").asSymbol, 0.0);
	if(quiet.not, { ("tidal-conductor: silenced channel " ++ ch).postln });
};

// 1. Clock from /dirt/play (raw messages are visible to OSCdef before SuperDirt handles them)
OSCdef(\tidalConductorClock, { |msg|
	// /dirt/play carries name/value pairs after the address; ignore anything malformed
	var args = msg[1..];
	if(args.size.even, {
		var params = Dictionary.newFrom(args);
		var cycle = params.at(\cycle), cps = params.at(\cps);
		if(cycle.isNumber, {
			if(cycle.floor != ~conductor.lastCycleFloor, {
				~conductor.lastCycleFloor = cycle.floor;
				~conductor.toConductors.do({ |addr|
					addr.sendMsg("/ai/ctx/cycle", cycle.asFloat, (cps ? 0).asFloat);
				});
			});
		});
	});
}, '/dirt/play', nil);

// 2. Deadman
OSCdef(\tidalConductorHeartbeat, { |msg|
	var ch = (msg[1] ? 1).asInteger;
	if((ch >= 1) and: { ch <= maxChannel }, {
		~conductor.heartbeats.put(ch, Main.elapsedTime);
		~conductor.resend.removeAt(ch);  // a live Conductor cancels any pending repeat of the silence
	});
}, '/ai/heartbeat', nil);

// SystemClock rather than AppClock: it does not depend on the application's main thread
~conductor.deadman = Task({
	loop {
		1.wait;
		// Repeats first (entries added on earlier ticks), then this tick's expiries: a channel that
		// fires now is repeated on the next two ticks, one second apart, never twice in one tick.
		// Collect keys first, then act: do not mutate the dictionaries while iterating over them
		~conductor.resend.keys.asArray.do({ |ch|
			var left = ~conductor.resend.at(ch);
			~conductor[\silence].value(ch, true);
			if(left <= 1, { ~conductor.resend.removeAt(ch) }, { ~conductor.resend.put(ch, left - 1) });
		});
		~conductor.heartbeats.keys.asArray.select({ |ch|
			(Main.elapsedTime - ~conductor.heartbeats.at(ch)) > deadmanTimeout
		}).do({ |ch|
			~conductor[\silence].value(ch);
			~conductor.heartbeats.removeAt(ch);      // fire once; the next heartbeat re-arms
			~conductor.resend.put(ch, resendTicks);  // and repeat the silence on the next ticks
		});
	}
}).play(SystemClock);

// Armed from load: clear the default channel once (removes residue from a previous run)
~conductor[\silence].value(1);

// preflight: /ai/ping -> /ai/pong "ok" 1.0 armed(int), back to whoever asked
OSCdef(\tidalConductorPing, { |msg, time, addr|
	var armed = ~conductor.deadman.notNil and: { ~conductor.deadman.isPlaying };
	var reply = { |a| a.sendMsg("/ai/pong", "ok", 1.0, armed.asInteger) };
	if(addr.notNil, { reply.value(addr) }, { ~conductor.toConductors.do(reply) });
}, '/ai/ping', nil);

"tidal-conductor: clock on /dirt/play, deadman armed, ping ready".postln;
)

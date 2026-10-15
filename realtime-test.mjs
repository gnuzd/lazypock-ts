// Exercises the SSE realtime client against a tiny local SSE server, so the
// transport, topic mapping, headers and frame parsing are all covered without a
// running lazypock node.

import assert from "node:assert/strict";
import http from "node:http";
import { RealtimeService, sseUrlFromBaseUrl } from "./dist/index.js";

const received = {
	subscribe: null,
	authorization: null,
	connection: null,
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (url.pathname !== "/api/realtime") {
		res.statusCode = 404;
		res.end();
		return;
	}
	received.subscribe = url.searchParams.get("subscribe");
	received.authorization = req.headers["authorization"] ?? null;
	received.connection = req.headers["x-connection-id"] ?? null;

	res.writeHead(200, { "Content-Type": "text/event-stream" });
	// A comment frame must be ignored, then one record event and one registry event.
	res.write(": keep-alive\n\n");
	res.write(
		'event: record\ndata: {"collection":"posts","action":"create","id":"p1","record":{"id":"p1","title":"hi"}}\n\n',
	);
	res.write(
		'event: record\ndata: {"collection":"collections","action":"update","id":"","record":{}}\n\n',
	);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

assert.equal(
	sseUrlFromBaseUrl("http://localhost:4000/api"),
	"http://localhost:4000/api/realtime",
	"sseUrlFromBaseUrl",
);

const rt = new RealtimeService();
rt.setUrl(`http://127.0.0.1:${port}/api/realtime`);
rt.setConnectionId("conn-test");
rt.setTokenProvider(() => "test-token");

const got = { wildcard: null, single: null, registry: null };
await new Promise((resolve, reject) => {
	const timer = setTimeout(
		() => reject(new Error(`timed out: ${JSON.stringify({ received, got })}`)),
		3000,
	);
	const check = () => {
		if (got.wildcard && got.single && got.registry) {
			clearTimeout(timer);
			resolve();
		}
	};
	rt.subscribe("collection:posts", (e) => {
		got.wildcard = e;
		check();
	});
	rt.subscribe("collection:posts:p1", (e) => {
		got.single = e;
		check();
	});
	rt.subscribe("collections", (e) => {
		got.registry = e;
		check();
	});
});

// A record event reaches both the collection topic and the record topic.
for (const [name, e] of [
	["wildcard", got.wildcard],
	["single", got.single],
]) {
	assert.equal(e.event, "create", name);
	assert.deepEqual(e.payload.record, { id: "p1", title: "hi" }, name);
}
assert.equal(got.wildcard.topic, "collection:posts");
assert.equal(got.single.topic, "collection:posts:p1");

// A registry event reaches the registry topic with the action as the event.
assert.equal(got.registry.topic, "collections");
assert.equal(got.registry.event, "update");

// The server saw the mapped topics and the auth/connection headers.
assert.deepEqual(
	(received.subscribe ?? "").split(",").sort(),
	["collections", "posts", "posts/p1"],
	"subscribe topics",
);
assert.equal(received.authorization, "Bearer test-token");
assert.equal(received.connection, "conn-test");

rt.disconnect();
server.close();
console.log("realtime-test: ok");

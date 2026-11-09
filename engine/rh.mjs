// Entry for the Robinhood Chain build of the engine (port 4680): same server, NETWORK=rh.
process.env.NETWORK ||= "rh";
await import("./server.mjs");

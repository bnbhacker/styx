// Entry for the Elysium testnet engine (port 4681): same server, NETWORK=elysium.
process.env.NETWORK ||= "elysium";
await import("./server.mjs");

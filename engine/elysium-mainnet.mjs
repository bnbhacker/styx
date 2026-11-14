// Entry for the Elysium mainnet engine (port 4682): same server, NETWORK=elysium-mainnet.
process.env.NETWORK ||= "elysium-mainnet";
await import("./server.mjs");

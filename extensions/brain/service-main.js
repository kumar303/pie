/**
 * Standalone brain pub/sub service.
 *
 * Spawned as a detached child process by ensureService().
 * Usage: node service-main.js <dataDir>
 *
 * Listens on a Unix domain socket and brokers pub/sub messages
 * between brain extension clients. Exits when the last client disconnects.
 *
 * Self-contained: no imports from the extension so it runs with bare node.
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write("Usage: node service-main.js <dataDir>\n");
  process.exit(1);
}

const socketPath = path.join(dataDir, "service.sock");

/** @type {Set<net.Socket>} */
const clients = new Set();

const server = net.createServer((socket) => {
  clients.add(socket);

  let buffer = "";
  socket.on("data", (data) => {
    buffer += data.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        // Broadcast to all other clients
        for (const client of clients) {
          if (client !== socket && !client.destroyed) {
            try {
              client.write(line + "\n");
            } catch {
              // Client disconnected
            }
          }
        }
      }
    }
  });

  socket.on("close", () => {
    clients.delete(socket);
    if (clients.size === 0) {
      shutdown();
    }
  });

  socket.on("error", () => {
    clients.delete(socket);
  });
});

function shutdown() {
  for (const client of clients) {
    client.destroy();
  }
  clients.clear();
  server.close(() => {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {}
    process.exit(0);
  });
}

server.on("error", (err) => {
  process.stderr.write(`Brain service error: ${err.message}\n`);
  process.exit(1);
});

server.listen(socketPath, () => {
  // Service is ready — clients can connect
});

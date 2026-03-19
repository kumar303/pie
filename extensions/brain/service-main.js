/**
 * Standalone brain pub/sub service.
 *
 * Spawned as a detached child process by ensureService().
 * Usage: node service-main.js <dataDir>
 *
 * Listens on a Unix domain socket and brokers pub/sub messages
 * between brain extension clients. Exits after a grace period
 * once all clients have disconnected.
 *
 * Self-contained: no imports from the extension so it runs with bare node.
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

const SHUTDOWN_GRACE_MS = 5000;

const dataDir = process.argv[2];
if (!dataDir) {
  process.stderr.write("Usage: node service-main.js <dataDir>\n");
  process.exit(1);
}

const socketPath = path.join(dataDir, "service.sock");

/** @type {Set<net.Socket>} */
const clients = new Set();

/** @type {ReturnType<typeof setTimeout> | null} */
let shutdownTimer = null;

const server = net.createServer((socket) => {
  clients.add(socket);

  // New client arrived — cancel any pending shutdown
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

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
      scheduleShutdown();
    }
  });

  socket.on("error", () => {
    clients.delete(socket);
  });
});

function scheduleShutdown() {
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    if (clients.size === 0) {
      shutdown();
    }
    shutdownTimer = null;
  }, SHUTDOWN_GRACE_MS);
}

function shutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
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

import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Member {
  name: string;
  sock: string;
  pid: number;
  sessionId: string;
  joinedAt: number;
}

export interface Registry {
  members: Member[];
}

export interface RegistryWriteIO {
  rename(from: string, to: string): Promise<void>;
}

export interface RegistryPaths {
  root: string;
  channels: string;
  sockets: string;
  registry: string;
  lock: string;
}

const LOCK_MAX_AGE_MS = 5_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 10_000;

export function storageRoot(): string {
  return (
    process.env.JOIN_PI_HOME ??
    join(process.env.HOME ?? process.cwd(), ".local", "share", "join-pi")
  );
}

export function pathsFor(channel: string, root = storageRoot()): RegistryPaths {
  const channels = join(root, "channels");
  return {
    root,
    channels,
    sockets: join(root, "sock"),
    registry: join(channels, `${channel}.json`),
    lock: join(channels, `${channel}.lock`),
  };
}

export async function ensureStorage(root = storageRoot()): Promise<boolean> {
  let repaired = false;
  try {
    const current = await stat(root);
    repaired = (current.mode & 0o077) !== 0;
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }

  const paths = pathsFor("unused", root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await mkdir(paths.channels, { recursive: true, mode: 0o700 });
  await chmod(paths.channels, 0o700);
  await mkdir(paths.sockets, { recursive: true, mode: 0o700 });
  await chmod(paths.sockets, 0o700);
  return repaired;
}

export async function readRegistry(
  path: string,
  onInvalid?: (quarantinePath: string) => void,
): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return { members: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return quarantineRegistry(path, onInvalid);
  }
  if (!isRegistry(parsed)) return quarantineRegistry(path, onInvalid);
  return parsed;
}

async function quarantineRegistry(
  path: string,
  onInvalid?: (quarantinePath: string) => void,
): Promise<Registry> {
  const quarantinePath = `${path}.invalid-${Date.now()}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
    onInvalid?.(quarantinePath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
  return { members: [] };
}

export async function writeRegistry(
  path: string,
  registry: Registry,
  io: RegistryWriteIO = { rename },
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await io.rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!isCode(cleanupError, "ENOENT")) throw cleanupError;
    });
    throw error;
  }
}

interface LockContender {
  path: string;
  value?: {
    pid: number;
    createdAt: number;
    token: string;
    choosing: boolean;
    ticket?: number;
  };
}

export async function withRegistryLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const token = randomUUID();
  const contenderPath = `${lockPath}.${token}`;
  const handle = await open(contenderPath, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
        token,
        choosing: true,
      }),
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(contenderPath, 0o600);

  try {
    const initial = await readLockContenders(lockPath);
    const maxTicket = initial.reduce(
      (max, contender) =>
        contender.value?.ticket === undefined
          ? max
          : Math.max(max, contender.value.ticket),
      0,
    );
    const ready = await open(contenderPath, "w", 0o600);
    try {
      await ready.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          token,
          choosing: false,
          ticket: maxTicket + 1,
        }),
        "utf8",
      );
      await ready.sync();
    } finally {
      await ready.close();
    }

    for (;;) {
      const contenders = await readLockContenders(lockPath);
      const live: LockContender[] = [];
      for (const contender of contenders) {
        if (await contenderIsStale(contender)) {
          await unlink(contender.path).catch((error: unknown) => {
            if (!isCode(error, "ENOENT")) throw error;
          });
        } else {
          live.push(contender);
        }
      }
      const allReady = live.every(
        (contender) => contender.value && !contender.value.choosing,
      );
      const elected = live
        .filter(
          (
            contender,
          ): contender is LockContender & {
            value: NonNullable<LockContender["value"]> & { ticket: number };
          } => contender.value?.ticket !== undefined,
        )
        .sort(
          (left, right) =>
            left.value.ticket - right.value.ticket ||
            left.value.token.localeCompare(right.value.token),
        )[0];
      if (allReady && elected?.value.token === token) break;
      if (Date.now() - startedAt >= LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for registry lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }

    return await operation();
  } finally {
    await unlink(contenderPath).catch((error: unknown) => {
      if (!isCode(error, "ENOENT")) throw error;
    });
  }
}

async function readLockContenders(lockPath: string): Promise<LockContender[]> {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  const entries = await readdir(directory);
  return Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry): Promise<LockContender> => {
        const path = join(directory, entry);
        try {
          const value: unknown = JSON.parse(await readFile(path, "utf8"));
          return { path, value: isLock(value) ? value : undefined };
        } catch (error) {
          if (error instanceof SyntaxError || isCode(error, "ENOENT")) {
            return { path };
          }
          throw error;
        }
      }),
  );
}

async function contenderIsStale(contender: LockContender): Promise<boolean> {
  if (!contender.value) {
    try {
      return (
        Date.now() - (await stat(contender.path)).mtimeMs > LOCK_MAX_AGE_MS
      );
    } catch (error) {
      if (isCode(error, "ENOENT")) return true;
      throw error;
    }
  }
  if (Date.now() - contender.value.createdAt > LOCK_MAX_AGE_MS) return true;
  try {
    process.kill(contender.value.pid, 0);
    return false;
  } catch (error) {
    return isCode(error, "ESRCH");
  }
}

function isRegistry(value: unknown): value is Registry {
  if (!isRecord(value) || !Array.isArray(value.members)) return false;
  return value.members.every(
    (member) =>
      isRecord(member) &&
      typeof member.name === "string" &&
      typeof member.sock === "string" &&
      typeof member.pid === "number" &&
      typeof member.sessionId === "string" &&
      typeof member.joinedAt === "number",
  );
}

function isLock(value: unknown): value is NonNullable<LockContender["value"]> {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.token === "string" &&
    typeof value.choosing === "boolean" &&
    (value.ticket === undefined || typeof value.ticket === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

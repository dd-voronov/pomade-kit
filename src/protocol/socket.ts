// The socket channel of the Host API (HOST-API §3 "Socket", pomade:E-028): the same messages as
// postMessage, one JSON object per line over a unix socket in Pomade's user-data folder. Pure —
// the framing, the limits, and the names of what Pomade records for its backends and commands;
// the Node client is `pomade-kit/node`.

/** The id a socket client of Pomade's own (a platform command such as `pomade-git`) presents in
 *  `hello`. No app may take it. */
export const PLATFORM_CLIENT_ID = "pomade";

/** Methods that need an app frame (a dialog, the frame's own overlay, watches kept with a frame):
 *  over the socket they are `capability-denied`. */
export const FRAME_ONLY_METHODS: readonly string[] = ["files.pickFolder", "files.pickFile", "git.watch", "git.unwatch", "overlay.open", "overlay.resize", "overlay.close", "panel.show", "tabs.setRoute", "tabs.setTitle", "tabs.close"];

/** True for a socket client's surface (`backend`, `command`). */
export function isSocketSurface(surface: string): boolean {
  return surface === "backend" || surface === "command";
}

/** macOS caps a unix socket path (`sun_path`) at 104 bytes including the terminating NUL. */
export const SOCKET_PATH_MAX_BYTES = 103;

/** The longest line (one message) either side accepts; a longer one closes the connection. */
export const SOCKET_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

/** The environment a backend or command is started with, and what Pomade's terminals carry. */
export const POMADE_ENV = {
  /** The socket's absolute path. */
  socket: "POMADE_SOCKET",
  /** The folder holding Pomade's command folder (`bin/`), workspace pointer and host record. */
  home: "POMADE_HOME",
  /** The calling app's id. */
  appId: "POMADE_APP_ID",
  /** The file holding the app's key. */
  keyFile: "POMADE_APP_KEY_FILE",
  /** `backend` or `command` (`ClientRole`). */
  role: "POMADE_CLIENT",
  /** The workspace root (absolute). */
  workspace: "POMADE_WORKSPACE",
  /** The app's machine-local state folder (`<userData>/app-state/<id>/`, absolute); Pomade creates it. */
  appState: "POMADE_APP_STATE",
  /** Backends only: where the app's keeper binds its socket (`keeperSocketPath`, pomade:E-034). */
  keeperSocket: "POMADE_KEEPER_SOCKET",
} as const;

/** What Pomade keeps in its home folder (`POMADE_HOME`; `~/.pomade` for the stable Pomade). */
export const HOME_FILES = {
  /** The command folder: app and platform commands, put on `PATH`. */
  bin: "bin",
  /** The current workspace root, one absolute path and a newline. */
  workspace: "workspace",
  /** `HostRecord` as JSON. */
  host: "host.json",
} as const;

/** How to start this Pomade when it is not running: `argv[0]` is run with the rest as arguments
 *  and `env` added to the environment (a packaged Pomade: `open -a <bundle>`). */
export interface LaunchSpec {
  argv: string[];
  env: Record<string, string>;
}

/** `<POMADE_HOME>/host.json` — written by Pomade at start, read by commands and backends. */
export interface HostRecord {
  /** The socket's absolute path. */
  socket: string;
  launch: LaunchSpec;
}

/** Why a socket path cannot be used, or `null` when it fits (`SOCKET_PATH_MAX_BYTES`). */
export function socketPathProblem(path: string): string | null {
  const bytes = new TextEncoder().encode(path).length;
  return bytes > SOCKET_PATH_MAX_BYTES
    ? `the socket path is ${bytes} bytes; macOS allows at most ${SOCKET_PATH_MAX_BYTES}: ${path}`
    : null;
}

/** One message as a line on the socket. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export interface LineDecoder {
  /** Feed received text; returns the complete lines' parsed values, in order. Unparseable lines
   *  are skipped. Throws when a line grows past the limit. */
  push(chunk: string): unknown[];
}

/** Split a byte stream (as text) into JSON messages, one per line. */
export function createLineDecoder(maxBytes: number = SOCKET_MESSAGE_MAX_BYTES): LineDecoder {
  let buffer = "";
  return {
    push(chunk) {
      // Only the new text is searched: the buffered part holds no newline.
      const out: unknown[] = [];
      let start = 0;
      let nl = chunk.indexOf("\n");
      while (nl !== -1) {
        const line = buffer + chunk.slice(start, nl);
        buffer = "";
        if (line.trim() !== "") {
          try {
            out.push(JSON.parse(line));
          } catch {
            // Not JSON: not a protocol message; ignored like any non-message.
          }
        }
        start = nl + 1;
        nl = chunk.indexOf("\n", start);
      }
      buffer += chunk.slice(start);
      // Characters, not bytes: a UTF-16 length is at most the UTF-8 byte length, so the cap holds.
      if (buffer.length > maxBytes) throw new Error(`message longer than ${maxBytes} bytes`);
      return out;
    },
  };
}

/** Parse `host.json`; `null` when it is not a host record. */
export function parseHostRecord(text: string): HostRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const launch: unknown = r.launch;
  if (typeof r.socket !== "string" || typeof launch !== "object" || launch === null) return null;
  const { argv, env } = launch as Record<string, unknown>;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) return null;
  if (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string")) return null;
  return { socket: r.socket, launch: { argv: [...(argv as string[])], env: { ...(env as Record<string, string>) } } };
}

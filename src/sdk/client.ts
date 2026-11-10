// The typed Host API client an app gets from `connect()` once the host said `welcome`.

import {
  CHANNEL,
  parseHostMessage,
  type ErrorCode,
  type FileChange,
  type HostInfo,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type ProjectRef,
  type ReadFolderParams,
  type ReadFolderResult,
  type SetBadgeParams,
  type FrameTarget,
  type WatchParams,
} from "../protocol/index.js";
import type { Transport } from "./transport.js";

/** A call the host answered with an error. */
export class HostError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/** What the host said in `welcome`: versions, app id, what the frame was opened for (`surface`,
 *  `icon`, `route`) and the project it was opened in. */
export interface Welcome extends FrameTarget {
  hostApi: number;
  pomadeVersion: string;
  appId: string;
  /** The project the frame was opened in. */
  project: ProjectRef;
}

export interface FileWatch {
  readonly watchId: string;
  /** Stop delivering changes (immediately) and unwatch on the host. Idempotent. */
  close(): Promise<void>;
}

export interface HostClient {
  readonly welcome: Welcome;
  info(): Promise<HostInfo>;
  readonly project: {
    getActive(): Promise<ProjectRef>;
    /** Called on every `project.changed`; returns an unsubscribe function. */
    onChange(callback: (project: ProjectRef) => void): () => void;
  };
  readonly files: {
    readFolder(params: ReadFolderParams): Promise<ReadFolderResult>;
    /** Resolves once the host accepted the watch; `onChanges` receives each batch. */
    watch(params: WatchParams, onChanges: (changes: FileChange[]) => void): Promise<FileWatch>;
  };
  readonly strip: {
    /** Badge one of the app's own strip icons; `count: 0` clears it, `urgent: true` paints it red. */
    setBadge(params: SetBadgeParams): Promise<void>;
  };
  /** Detach from the transport: no more events, pending calls reject. */
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** `onClose` runs once when the client is closed. */
export function createClient(transport: Transport, welcome: Welcome, onClose?: () => void): HostClient {
  let nextId = 1;
  let closed = false;
  const pending = new Map<string, Pending>();
  const watches = new Map<string, (changes: FileChange[]) => void>();
  const projectListeners = new Set<(project: ProjectRef) => void>();

  const unlisten = transport.listen((data) => {
    const msg = parseHostMessage(data);
    if (!msg) return;
    if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new HostError(msg.error.code, msg.error.message));
    } else if (msg.type === "event") {
      if (msg.name === "project.changed") {
        for (const cb of [...projectListeners]) cb(msg.payload);
      } else {
        watches.get(msg.payload.watchId)?.(msg.payload.changes);
      }
    }
  });

  // `onValue` runs synchronously when the result arrives, before any later message is handled.
  function call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    onValue?: (value: MethodResult<M>) => void,
  ): Promise<MethodResult<M>> {
    if (closed) return Promise.reject(new Error("pomade-kit: client is closed"));
    const id = String(nextId++);
    return new Promise<MethodResult<M>>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => {
          onValue?.(v as MethodResult<M>);
          resolve(v as MethodResult<M>);
        },
        reject,
      });
      transport.send({ channel: CHANNEL, type: "call", id, method, params });
    });
  }

  function dispose(): void {
    if (closed) return;
    closed = true;
    unlisten();
    onClose?.();
    watches.clear();
    projectListeners.clear();
    const error = new Error("pomade-kit: client is closed");
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  }

  return {
    welcome,
    info: () => call("host.info", {}),
    project: {
      getActive: () => call("project.getActive", {}),
      onChange(callback) {
        projectListeners.add(callback);
        return () => projectListeners.delete(callback);
      },
    },
    files: {
      readFolder: (params) => call("files.readFolder", params),
      async watch(params, onChanges) {
        const { watchId } = await call("files.watch", params, (v) => watches.set(v.watchId, onChanges));
        let unwatched: Promise<void> | null = null;
        return {
          watchId,
          close() {
            unwatched ??= (async () => {
              watches.delete(watchId);
              if (!closed) await call("files.unwatch", { watchId });
            })();
            return unwatched;
          },
        };
      },
    },
    strip: {
      async setBadge(params) {
        await call("strip.setBadge", params);
      },
    },
    close: dispose,
  };
}

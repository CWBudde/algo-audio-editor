interface TaskPort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
  start(): void;
}

interface TaskChannel {
  port1: TaskPort;
  port2: TaskPort;
}

/** Message tasks avoid recursive timer clamping and do not starve worker RPCs. */
export function createTaskYield(createChannel: () => TaskChannel = () => new MessageChannel()) {
  const channel = createChannel();
  const pending: { resolve(): void; reject(error: Error): void }[] = [];
  let disposed = false;
  channel.port1.onmessage = () => pending.shift()?.resolve();
  channel.port1.start();
  return {
    yieldTask(): Promise<void> {
      if (disposed) return Promise.reject(new Error("task scheduler disposed"));
      return new Promise((resolve, reject) => {
        const item = { resolve, reject };
        pending.push(item);
        try {
          channel.port2.postMessage(null);
        } catch (error) {
          pending.splice(pending.indexOf(item), 1);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
      for (const item of pending.splice(0)) item.reject(new Error("task scheduler disposed"));
    },
  };
}

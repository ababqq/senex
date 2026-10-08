interface FrameHost {
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
}

/** Suspend an unobserved preview's native frames without losing the project's queued callbacks. */
export function animationGate(host: FrameHost) {
  let visible = true;
  let next = 0;
  const pending = new Map<number, { callback: (time: number) => void; native: number | null; generation: number }>();
  const arm = (id: number) => {
    const entry = pending.get(id);
    if (!entry || !visible || entry.native !== null) return;
    const generation = ++entry.generation;
    entry.native = host.request((time) => {
      if (!visible || pending.get(id) !== entry || generation !== entry.generation) return;
      pending.delete(id);
      entry.callback(time);
    });
  };
  return {
    request(callback: (time: number) => void): number {
      const id = ++next;
      pending.set(id, { callback, native: null, generation: 0 });
      arm(id);
      return id;
    },
    cancel(id: number): void {
      const entry = pending.get(id);
      if (entry?.native !== null && entry?.native !== undefined) host.cancel(entry.native);
      pending.delete(id);
    },
    setVisible(value: boolean): void {
      if (visible === value) return;
      visible = value;
      for (const [id, entry] of pending) {
        if (visible) arm(id);
        else {
          if (entry.native !== null) host.cancel(entry.native);
          entry.native = null;
        }
      }
    },
  };
}

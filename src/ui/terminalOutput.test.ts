import { describe, expect, it, vi } from 'vitest';

import { writeOutput } from './terminalOutput';

describe('writeOutput', () => {
  it("hands xterm the bytes and reports done only from xterm's callback", () => {
    let callback: (() => void) | undefined;
    const write = vi.fn((_data: string | Uint8Array, cb?: () => void) => {
      callback = cb;
    });
    const done = vi.fn();
    const bytes = new Uint8Array([104, 105]);

    writeOutput({ write }, bytes, done);

    expect(write).toHaveBeenCalledWith(bytes, done);
    expect(done).not.toHaveBeenCalled();
    callback?.();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('reports done when the write throws, so a disposed terminal never holds the pty', () => {
    const done = vi.fn();
    writeOutput(
      {
        write: () => {
          throw new Error('disposed');
        },
      },
      new Uint8Array([1]),
      done,
    );
    expect(done).toHaveBeenCalledTimes(1);
  });
});

import { TransportTimeout } from './types';

/**
 * Packets arrive from the phone's USB stack as events, whenever the device
 * decides to speak; drivers ask for them one at a time and wait. This sits
 * between the two.
 *
 * A timeout leaves the queue untouched, so a packet that turns up late is
 * still there for the next read — a driver waiting on someone to press a
 * button can simply ask again.
 */
export class PacketQueue {
  private packets: Uint8Array[] = [];
  private failure: Error | null = null;
  private waiter: {
    resolve: (packet: Uint8Array) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  push(packet: Uint8Array): void {
    if (this.failure) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
      return;
    }
    this.packets.push(packet);
  }

  /** The device has gone. The read in flight, and every read after it, rejects with `error`. */
  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.packets = [];
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  read(timeoutMs: number): Promise<Uint8Array> {
    if (this.failure) return Promise.reject(this.failure);
    // Drivers talk to a device strictly in turn. Two reads at once would mean
    // two conversations sharing one wire, each taking the other's replies.
    if (this.waiter) return Promise.reject(new Error('The device is already busy with another request.'));
    const next = this.packets.shift();
    if (next) return Promise.resolve(next);
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new TransportTimeout());
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
}

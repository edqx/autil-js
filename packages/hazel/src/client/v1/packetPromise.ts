import { V1HazelClient } from ".";
import { V1ReliablePackets } from "./types";

export class PacketAcknowledgementPromise {
  protected resolve: () => void = () => this.resolveListeners.forEach(listener => listener());
  protected reject: (reason?: any) => void = (reason) => this.rejectListeners.forEach(listener => listener(reason));

  protected resolveListeners: Set<() => void> = new Set();
  protected rejectListeners: Set<(reason?: any) => void> = new Set();

  protected sendCount: number = 0;
  protected timeout: any;

  constructor(protected readonly client: V1HazelClient, protected readonly packet: V1ReliablePackets) {
    this.client = client;
    this.packet = packet;

    this.timeout = setInterval(() => {
      if (this.getSendCount() == 10) {
        this.setDropped();
        return;
      }

      this.attemptSend();
    }, 2000)

    this.attemptSend();
  }

  getClient() { return this.client }
  getPacket() { return this.packet }
  incrementSendCount() { this.sendCount++ }
  getSendCount() { return this.sendCount }

  cleanup() {
    clearInterval(this.timeout);
  }

  setResolved() {
    this.cleanup();
    this.resolve()
  }

  setDropped() {
    this.cleanup();
    this.reject(new Error("Packet was not acked"))
  }

  attemptSend() {
    this.incrementSendCount();

    this.getClient().write(this.getPacket());
  }

  then(onFulfilled: () => void, onRejected?: (reason?: any) => void): this {
    if (onRejected) this.rejectListeners.add(onRejected);

    this.resolveListeners.add(onFulfilled);

    return this;
  }

  catch(onRejected: (reason?: any) => void): this {
    this.rejectListeners.add(onRejected);

    return this;
  }
}

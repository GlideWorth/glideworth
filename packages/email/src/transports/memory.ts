import { type EmailTransport, EmailTransportError, type OutgoingEmail } from "../types.js";
import { assertOutgoing, EmailValidationError } from "../validate.js";

export function guard(transport: string, msg: OutgoingEmail): void {
  try {
    assertOutgoing(msg);
  } catch (e) {
    if (e instanceof EmailValidationError)
      throw new EmailTransportError(transport, e.code, false, e.message);
    throw e;
  }
}

export function memoryTransport(): EmailTransport & { sent: OutgoingEmail[]; clear(): void } {
  const sent: OutgoingEmail[] = [];
  return {
    name: "memory",
    sent,
    async send(msg) {
      guard("memory", msg);
      sent.push(structuredClone(msg));
      return { providerMessageId: `memory-${sent.length}` };
    },
    clear() {
      sent.length = 0;
    },
  };
}

import type { OutgoingEmail } from "../types.js";

/** Maps our message to nodemailer mail options. Addresses and headers were validated by `assertOutgoing`. */
export function toMailOptions(msg: OutgoingEmail) {
  return {
    from: { name: msg.from.name ?? "", address: msg.from.email },
    to: { name: msg.to.name ?? "", address: msg.to.email },
    ...(msg.replyTo
      ? { replyTo: { name: msg.replyTo.name ?? "", address: msg.replyTo.email } }
      : {}),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: msg.headers,
  };
}

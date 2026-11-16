import { createServer, type Server } from "node:net";

export interface FakeSmtp {
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  close(): Promise<void>;
}

/** Minimal in-process SMTP server on a random local port. Recipients containing "reject" get 550, "defer" 451. */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const messages: FakeSmtp["messages"] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    let inData = false;
    let from = "";
    let to: string[] = [];
    let data = "";
    sock.write("220 fake.local ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          messages.push({ from, to, data });
          sock.write("250 2.0.0 queued as FAKE123\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-fake.local\r\n250 8BITMIME\r\n");
        else if (cmd === "MAIL") {
          from = line.replace(/^MAIL FROM:\s*<?([^>\s]*)>?.*$/i, "$1");
          to = [];
          sock.write("250 OK\r\n");
        } else if (cmd === "RCPT") {
          const rcpt = line.replace(/^RCPT TO:\s*<?([^>\s]*)>?.*$/i, "$1");
          if (rcpt.includes("reject")) sock.write("550 5.1.1 no such user\r\n");
          else if (rcpt.includes("defer")) sock.write("451 4.3.0 try again later\r\n");
          else {
            to.push(rcpt);
            sock.write("250 OK\r\n");
          }
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else if (cmd === "RSET" || cmd === "NOOP") sock.write("250 OK\r\n");
        else sock.write("502 not implemented\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

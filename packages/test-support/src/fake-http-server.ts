import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * 外部 API(AWS の SES/SQS/Secrets Manager など)の fake HTTP server(docs/06 テスト方針)。
 * SDK の `endpoint` をこのサーバーへ向けて、成功・429・5xx・不正応答・timeout(応答しない)を再現する。
 * 受信した request を記録するので、送信内容(ヘッダー・本文)も検証できる。
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export type FakeResponse =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  /** 応答せず接続を保持する(クライアント側の timeout を起こす)。 */
  | { readonly hang: true }
  /** 接続を即座に切る(ネットワーク障害)。 */
  | { readonly destroy: true };

export type FakeHandler = (request: RecordedRequest, index: number) => FakeResponse;

export interface FakeHttpServer {
  readonly endpoint: string;
  readonly requests: readonly RecordedRequest[];
  /** 以降の request に使う handler を差し替える。 */
  respondWith(handler: FakeHandler): void;
  close(): Promise<void>;
}

export async function startFakeHttpServer(initial: FakeHandler): Promise<FakeHttpServer> {
  let handler = initial;
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const response = handler(recorded, requests.length - 1);
      if ("hang" in response) return;
      if ("destroy" in response) {
        req.socket.destroy();
        return;
      }
      res.writeHead(response.status, response.headers ?? {});
      res.end(response.body ?? "");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    respondWith(next) {
      handler = next;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

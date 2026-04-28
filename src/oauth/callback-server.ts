import { createServer } from "node:http";
import { LibertyError } from "../errors.js";

export interface CallbackOptions {
  port: number;
  path: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>llm-liberty</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; padding: 3rem; text-align: center; }
      h1 { font-size: 1.4rem; }
      p { color: #555; }
    </style>
  </head>
  <body>
    <h1>You can close this tab.</h1>
    <p>llm-liberty has received the authorization response.</p>
  </body>
</html>
`;

export function waitForCallback(opts: CallbackOptions): Promise<URL> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<URL>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${opts.port}`);
      if (url.pathname !== opts.path) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(SUCCESS_HTML);
      cleanup();
      resolve(url);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new LibertyError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OAuth callback.`,
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      server.close();
    };

    server.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "EADDRINUSE") {
        reject(
          new LibertyError(
            `Port ${opts.port} is already in use. Anthropic's OAuth client has this port hard-coded — free it (e.g. \`lsof -i :${opts.port}\`) and retry.`,
            err,
          ),
        );
        return;
      }
      reject(new LibertyError(`Callback server error: ${err.message}`, err));
    });

    server.listen(opts.port, "127.0.0.1");
  });
}

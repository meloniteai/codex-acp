import {once} from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, {recursive: true, force: true});
    }
});

describe("Codex app-server JSON-RPC logging", () => {
    it.skipIf(process.platform === "win32")("logs framed message diagnostics without request or response secrets", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-rpc-logs-"));
        temporaryDirectories.push(root);
        const logDirectory = path.join(root, "logs");
        const fakeCodex = path.join(root, "codex");
        fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
    buffer += chunk;
    for (;;) {
        const newline = buffer.indexOf("\\n");
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const messages = request.method === "thread/fork"
            ? [
                {
                    method: "thread/started",
                    params: {
                        env: {MELONITE_TOKEN: "response-env-secret"},
                        headers: {Authorization: "Bearer response-header-secret"},
                    },
                },
                {id: request.id, result: {token: "response-result-secret"}},
            ]
            : [{
                id: request.id,
                result: {
                    config: {
                        mcp_servers: {
                            melonite: {
                                env: {MELONITE_TOKEN: "config-read-env-secret"},
                                http_headers: {Authorization: "Bearer config-read-header-secret"},
                                token: "config-read-token-secret",
                            },
                        },
                    },
                },
            }];
        const framed = messages.map(JSON.stringify).join("\\n") + "\\n";
        const boundaries = [3, 11, 29, 47, 83, framed.length];
        let offset = 0;
        const writeNext = () => {
            const boundary = boundaries.shift();
            if (boundary === undefined) return;
            process.stdout.write(framed.slice(offset, boundary));
            offset = boundary;
            setTimeout(writeNext, 2);
        };
        writeNext();
    }
});
`);
        fs.chmodSync(fakeCodex, 0o755);

        vi.resetModules();
        vi.stubEnv("APP_SERVER_LOGS", logDirectory);
        const [{startCodexConnection}, {logger}] = await Promise.all([
            import("../../CodexJsonRpcConnection"),
            import("../../Logger"),
        ]);
        const codex = startCodexConnection(fakeCodex);

        try {
            await codex.connection.sendRequest("thread/fork", {
                config: {
                    mcp_servers: {
                        "verifier-review": {
                            env: {MELONITE_TOKEN: "request-env-secret"},
                            http_headers: {Authorization: "Bearer request-header-secret"},
                        },
                    },
                },
            });
            await codex.connection.sendRequest("config/read", {});
            logger.log("Structured MCP config", {
                mcp: {
                    env: [{name: "MELONITE_TOKEN", value: "context-env-secret"}],
                    headers: [{name: "Authorization", value: "context-header-secret"}],
                },
            });
            logger.log('Raw MCP config {"env":{"MELONITE_TOKEN":"embedded-token-secret"}}');
        } finally {
            const closed = once(codex.process, "close");
            codex.process.kill();
            await closed;
        }

        const contents = fs.readFileSync(path.join(logDirectory, "app-server.log"), "utf8");
        expect(contents).toContain('[IN] request method="thread/fork" id=0');
        expect(contents).toContain('[OUT] notification method="thread/started"');
        expect(contents).toContain("[OUT] response id=0");
        expect(contents).toContain('[IN] request method="config/read" id=1');
        expect(contents).toContain("[OUT] response id=1");
        expect(contents).toContain('[SYS] Structured MCP config {"mcp":{"env":"[REDACTED]","headers":"[REDACTED]"}}');
        expect(contents).toContain("[REDACTED]");
        expect(contents).not.toContain("MELONITE_TOKEN");
        expect(contents).not.toContain("Authorization");
        for (const secret of [
            "request-env-secret",
            "request-header-secret",
            "response-env-secret",
            "response-header-secret",
            "response-result-secret",
            "config-read-env-secret",
            "config-read-header-secret",
            "config-read-token-secret",
            "context-env-secret",
            "context-header-secret",
            "embedded-token-secret",
        ]) {
            expect(contents).not.toContain(secret);
        }
    });
});

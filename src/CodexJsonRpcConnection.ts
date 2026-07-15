import * as rpc from "vscode-jsonrpc/node";
import type {Message, MessageConnection, MessageReader, MessageWriter} from "vscode-jsonrpc/node";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
}

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv): CodexConnection {
    const spawnEnv = env ?? process.env;

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        codex = process.platform === 'win32'
            ? spawn(`"${codexPath}" app-server`, { shell: true, env: spawnEnv })
            : spawn(codexPath, ['app-server'], { env: spawnEnv });
    } else {
        const bundledCodexPath = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, 'app-server'], {env: spawnEnv});
    }

    attachLogs(codex);

    const reader = withMessageDiagnostics(createJSONRPCReader(codex.stdout), "OUT");
    const writer = withMessageDiagnostics(createJSONRPCWriter(codex.stdin), "IN");

    let connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // Terminate all current activities on process termination
    codex.on("exit", _ => {
        connection.dispose();
    });

    return {connection: connection, process: codex};
}

function attachLogs(proc: ChildProcessWithoutNullStreams) {
    proc.stderr.on("data", (data) => {
        logger.log(`[ERR] bytes=${Buffer.byteLength(data)}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}

function withMessageDiagnostics(reader: MessageReader, direction: "IN" | "OUT"): MessageReader;
function withMessageDiagnostics(writer: MessageWriter, direction: "IN" | "OUT"): MessageWriter;
function withMessageDiagnostics(
    transport: MessageReader | MessageWriter,
    direction: "IN" | "OUT",
): MessageReader | MessageWriter {
    if ("listen" in transport) {
        return {
            onError: transport.onError,
            onClose: transport.onClose,
            onPartialMessage: transport.onPartialMessage,
            listen(callback) {
                return transport.listen(message => {
                    logMessageDiagnostic(direction, message);
                    callback(message);
                });
            },
            dispose() {
                transport.dispose();
            },
        };
    }

    return {
        onError: transport.onError,
        onClose: transport.onClose,
        write(message) {
            logMessageDiagnostic(direction, message);
            return transport.write(message);
        },
        end() {
            transport.end();
        },
        dispose() {
            transport.dispose();
        },
    };
}

function logMessageDiagnostic(direction: "IN" | "OUT", message: Message): void {
    const record = message as unknown as Record<string, unknown>;
    const method = typeof record["method"] === "string" ? record["method"] : undefined;
    const hasId = Object.prototype.hasOwnProperty.call(record, "id");
    const hasError = Object.prototype.hasOwnProperty.call(record, "error");
    const kind = method ? (hasId ? "request" : "notification") : (hasError ? "error-response" : "response");
    const methodDiagnostic = method ? ` method=${JSON.stringify(method)}` : "";
    const idDiagnostic = hasId ? ` id=${formatMessageId(record["id"])}` : "";
    logger.log(`[${direction}] ${kind}${methodDiagnostic}${idDiagnostic}`);
}

function formatMessageId(id: unknown): string {
    if (typeof id === "number") {
        return String(id);
    }
    if (id === null) {
        return "null";
    }
    if (typeof id === "string") {
        const digest = createHash("sha256").update(id).digest("hex").slice(0, 12);
        return `sha256:${digest}`;
    }
    return "unknown";
}

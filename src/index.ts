#!/usr/bin/env node

import * as acp from "@agentclientprotocol/sdk";
import {z} from "zod";
import {startCodexConnection} from "./CodexJsonRpcConnection";
import {CodexAcpServer} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";
import {logger} from "./Logger";
import {runLoginCommand} from "./login";
import {runCodexCli} from "./CodexCli";
import {CODEX_FORK_PROMPT_METHOD, type CodexForkPromptRequest, LEGACY_SET_SESSION_MODEL_METHOD} from "./AcpExtensions";
import {sanitizeMcpServerName} from "./McpServerName";

const emptyExtensionParamsParser = z.preprocess(
    (params) => params ?? {},
    z.object({}).passthrough()
);

const legacySetSessionModelParamsParser = z.object({
    sessionId: z.string(),
    modelId: z.string(),
}).passthrough();

const legacyMeloniteForkPromptParamsParser = z.object({
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
}).strict();

const extensionMetaParser = z.record(z.string(), z.unknown()).nullable().optional();
const envVariableParser = z.object({
    name: z.string().min(1),
    value: z.string(),
    _meta: extensionMetaParser,
}).passthrough();
const httpHeaderParser = z.object({
    name: z.string().min(1),
    value: z.string(),
    _meta: extensionMetaParser,
}).passthrough();
const forkMcpServerParser = z.union([
    z.object({
        type: z.undefined().optional(),
        name: z.string().min(1),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.array(envVariableParser).default([]),
        _meta: extensionMetaParser,
    }).passthrough(),
    z.object({
        type: z.literal("http"),
        name: z.string().min(1),
        url: z.string().min(1),
        headers: z.array(httpHeaderParser).default([]),
        _meta: extensionMetaParser,
    }).passthrough(),
]);
const forkMcpServersParser = z.array(forkMcpServerParser).max(16).default([]).superRefine((servers, context) => {
    const names = new Set<string>();
    for (const server of servers) {
        const name = sanitizeMcpServerName(server.name);
        if (names.has(name)) {
            context.addIssue({code: "custom", message: `duplicate MCP server name: ${name}`});
        }
        names.add(name);
    }
});
const codexForkPromptParamsParser = z.object({
    sessionId: z.string().min(1),
    prompt: z.string().min(1),
    mcpServers: forkMcpServersParser,
}).passthrough();

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

if (process.argv[2] === "login") {
    const args = process.argv.slice(3);
    runLoginCommand(args)
        .then((success) => process.exit(success ? 0 : 1))
        .catch((error) => {
            console.error("Login error:", error.message);
            process.exit(1);
        });
} else if (process.argv[2] === "cli") {
    const args = process.argv.slice(3);
    runCodexCli(process.env["CODEX_PATH"], args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpServer();
}

function startAcpServer() {
    const codexPath = process.env["CODEX_PATH"];
    const configString = process.env["CODEX_CONFIG"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const modelProvider = process.env["MODEL_PROVIDER"];
    const config = configString ? JSON.parse(configString) : undefined;
    const parsedAuthRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedAuthRequest && isCodexAuthRequest(parsedAuthRequest) ? parsedAuthRequest : undefined;

    logger.log("Startup", {
        name: packageJson.name,
        version: packageJson.version,
        codexPath: codexPath,
        modelProvider: modelProvider ?? null,
        codexConfig: config ?? null,
        authRequest: authRequestString ?? null,
        defaultAuthRequest: defaultAuthRequest ?? null,
    });

    const codexConnection = startCodexConnection(codexPath);

    const maxStderrTailChars = 2 * 1024;
    let stderr = "";
    codexConnection.process.stderr.addListener("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-maxStderrTailChars);
    });

    process.stdin.on("close", () => {
        codexConnection.process.stdin.end();
        // Kill the codex process if it doesn't exit naturally
        setTimeout(() => {
            if (!codexConnection.process.killed) {
                logger.log("Codex still running 2s after stdin closed; terminating process");
                codexConnection.process.kill();
            }
        }, 2000);
    });

    const acpJsonStream = createJsonStream(process.stdin, process.stdout);

    function createAgent(connection: acp.AgentContext): CodexAcpServer {
        const appServerClient = new CodexAppServerClient(codexConnection.connection);
        const codexClient = new CodexAcpClient(appServerClient, config, modelProvider);
        return new CodexAcpServer(connection, codexClient, defaultAuthRequest, () => codexConnection.process.exitCode, () => stderr);
    }

    let codexAcpServer: CodexAcpServer | null = null;
    const getAgent = (): CodexAcpServer => {
        if (!codexAcpServer) {
            throw acp.RequestError.internalError("ACP agent is not connected");
        }
        return codexAcpServer;
    };

    acp.agent({name: packageJson.name})
        .onConnect((connection) => {
            const agent = createAgent(connection.client);
            codexAcpServer = agent;
            connection.signal.addEventListener("abort", () => {
                if (codexAcpServer === agent) {
                    codexAcpServer = null;
                }
            });
        })
        .onRequest(acp.methods.agent.initialize, (ctx) => getAgent().initialize(ctx.params))
        .onRequest(acp.methods.agent.session.new, (ctx) => getAgent().newSession(ctx.params))
        .onRequest(acp.methods.agent.session.load, (ctx) => getAgent().loadSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAgent().deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => getAgent().resumeSession(ctx.params))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAgent().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setMode, (ctx) => getAgent().setSessionMode(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAgent().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params))
        .onRequest(acp.methods.agent.logout, (ctx) => getAgent().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, (ctx) => getAgent().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, (ctx) => getAgent().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => getAgent().prompt(ctx.params, ctx.signal))
        .onNotification(acp.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))
        .onRequest("authentication/status", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/status", ctx.params))
        .onRequest("authentication/logout", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/logout", ctx.params))
        .onRequest(LEGACY_SET_SESSION_MODEL_METHOD, legacySetSessionModelParamsParser, (ctx) => getAgent().extMethod(LEGACY_SET_SESSION_MODEL_METHOD, ctx.params))
        .onRequest("melonite/fork_prompt", legacyMeloniteForkPromptParamsParser, (ctx) => getAgent().forkPrompt(ctx.params))
        .onRequest(CODEX_FORK_PROMPT_METHOD, codexForkPromptParamsParser, (ctx) => getAgent().detachedForkPrompt(ctx.params as CodexForkPromptRequest))
        .connect(acpJsonStream);
}

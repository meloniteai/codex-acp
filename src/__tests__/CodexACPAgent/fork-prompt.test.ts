import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";

describe("internal fork prompt", () => {
    it("runs a detached isolated fork with arbitrary request MCP servers", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {
                mcp_servers: {
                    "global-tools": {
                        command: "global-tools",
                        args: ["serve"],
                        env: {GLOBAL_TOKEN: "global-token"},
                        startup_timeout_sec: 15,
                        tool_timeout_sec: null,
                        default_tools_approval_mode: "approve",
                        tools: {
                            search: {approval_mode: "approve"},
                            mutate: {approval_mode: "never", enabled: false},
                        },
                    },
                    "inherited-review": {
                        url: "https://inherited.example/mcp",
                        http_headers: {Authorization: "Bearer inherited"},
                        default_tools_approval_mode: "approve",
                    },
                },
            },
        } as never);
        vi.spyOn(appServer, "threadFork").mockResolvedValue({
            thread: {id: "fork-thread", ephemeral: true, path: null},
        } as never);
        vi.spyOn(appServer, "runTurn").mockImplementation(async () => {
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "review",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow review tool?",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "accept", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "docs",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow docs tool?",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "accept", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "review",
                mode: "form",
                _meta: {},
                message: "Provide input",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "cancel", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "global-tools",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow inherited global tool?",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "cancel", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "parent_tools",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow inherited session tool?",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "cancel", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "other",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow foreign tool?",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "cancel", content: null, _meta: null});
            return {
                threadId: "fork-thread",
                turn: {
                    id: "fork-turn",
                    items: [{
                        type: "agentMessage",
                        id: "answer",
                        text: "fork answer",
                        phase: "final_answer",
                        memoryCitation: null,
                    }],
                    itemsView: "notLoaded",
                    status: "completed",
                    error: null,
                    startedAt: null,
                    completedAt: null,
                    durationMs: null,
                },
            } as never;
        });
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({} as never);

        await expect(client.detachedForkPrompt("parent-thread", {
            prompt: "answer privately",
            inheritedMcpServers: [{
                name: "parent tools",
                command: "parent-tools",
                args: ["serve"],
                env: [{name: "PARENT_TOKEN", value: "parent-token"}],
            }],
            mcpServers: [
                {name: "review", command: "melonite", args: ["mcp"], env: []},
                {type: "http", name: "docs", url: "https://docs.example/mcp", headers: [{name: "Authorization", value: "Bearer test"}]},
            ],
        }, "/test/cwd")).resolves.toEqual({
            response: "fork answer",
            stopReason: "completed",
        });
        expect(appServer.threadFork).toHaveBeenCalledWith({
            threadId: "parent-thread",
            cwd: "/test/cwd",
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
            config: {
                web_search: "disabled",
                features: {
                    apps: false,
                    plugins: false,
                },
                mcp_servers: {
                    "global-tools": {
                        command: "global-tools",
                        args: ["serve"],
                        env: {GLOBAL_TOKEN: "global-token"},
                        startup_timeout_sec: 15,
                        default_tools_approval_mode: "prompt",
                        tools: {
                            search: {approval_mode: "prompt"},
                            mutate: {approval_mode: "prompt", enabled: false},
                        },
                    },
                    parent_tools: {
                        command: "parent-tools",
                        args: ["serve"],
                        env: {PARENT_TOKEN: "parent-token"},
                        default_tools_approval_mode: "prompt",
                    },
                    "inherited-review": {
                        url: "https://inherited.example/mcp",
                        http_headers: {Authorization: "Bearer inherited"},
                        default_tools_approval_mode: "prompt",
                    },
                    review: {command: "melonite", args: ["mcp"], env: {}},
                    docs: {url: "https://docs.example/mcp", http_headers: {Authorization: "Bearer test"}},
                },
            },
        });
        const forkConfig = vi.mocked(appServer.threadFork).mock.calls[0]?.[0].config;
        expect((forkConfig?.["mcp_servers"] as Record<string, unknown>)["global-tools"]).not.toHaveProperty("tool_timeout_sec");
        expect(appServer.runTurn).toHaveBeenCalledWith({
            threadId: "fork-thread",
            input: [{type: "text", text: "answer privately", text_elements: []}],
            approvalPolicy: "never",
            sandboxPolicy: {type: "readOnly", networkAccess: false},
            summary: "none",
        });
        expect(appServer.threadUnsubscribe).toHaveBeenCalledWith({threadId: "fork-thread"});
        expect(fixture.getAcpConnectionEvents([])).toEqual([]);
    });

    it("rejects duplicate MCP names after sanitization", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "configRead").mockResolvedValue({config: {}} as never);
        const threadFork = vi.spyOn(appServer, "threadFork");

        await expect(client.detachedForkPrompt("parent-thread", {
            prompt: "answer privately",
            inheritedMcpServers: [],
            mcpServers: [
                {name: "review server", command: "first", args: [], env: []},
                {name: "review_server", command: "second", args: [], env: []},
            ],
        }, "/test/cwd")).rejects.toMatchObject({
            message: "Invalid request",
            data: "Duplicate MCP server name: review_server",
        });
        expect(threadFork).not.toHaveBeenCalled();
    });

    it("rejects requested MCP names that conflict with inherited credentials", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "configRead").mockResolvedValue({
            config: {
                mcp_servers: {
                    review: {
                        url: "https://inherited.example/mcp",
                        http_headers: {Authorization: "Bearer inherited-secret"},
                    },
                },
            },
        } as never);
        const threadFork = vi.spyOn(appServer, "threadFork");

        await expect(client.detachedForkPrompt("parent-thread", {
            prompt: "answer privately",
            inheritedMcpServers: [],
            mcpServers: [{
                type: "http",
                name: "review",
                url: "https://request.example/mcp",
                headers: [],
            }],
        }, "/test/cwd")).rejects.toMatchObject({
            message: "Invalid request",
            data: "Requested MCP server name conflicts with inherited server: review",
        });
        expect(threadFork).not.toHaveBeenCalled();
    });

    it("accepts requested MCP names that match object prototype properties", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
        vi.spyOn(appServer, "configRead").mockResolvedValue({config: {}} as never);
        vi.spyOn(appServer, "threadFork").mockResolvedValue({
            thread: {id: "fork-thread", ephemeral: true, path: null},
        } as never);
        vi.spyOn(appServer, "runTurn").mockResolvedValue({
            threadId: "fork-thread",
            turn: {
                id: "fork-turn",
                items: [],
                itemsView: "notLoaded",
                status: "completed",
                error: null,
                startedAt: null,
                completedAt: null,
                durationMs: null,
            },
        } as never);
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({} as never);

        await expect(client.detachedForkPrompt("parent-thread", {
            prompt: "answer privately",
            inheritedMcpServers: [],
            mcpServers: [
                {name: "constructor", command: "first", args: [], env: []},
                {name: "toString", command: "second", args: [], env: []},
                {name: "__proto__", command: "third", args: [], env: []},
            ],
        }, "/test/cwd")).resolves.toEqual({response: "", stopReason: "completed"});

        const forkConfig = vi.mocked(appServer.threadFork).mock.calls[0]?.[0].config;
        const mcpServers = forkConfig?.["mcp_servers"] as Record<string, unknown>;
        expect(Object.keys(mcpServers)).toEqual(["constructor", "toString", "__proto__"]);
        expect(Object.prototype.hasOwnProperty.call(mcpServers, "__proto__")).toBe(true);
        expect(mcpServers["constructor"]).toEqual({command: "first", args: [], env: {}});
        expect(mcpServers["toString"]).toEqual({command: "second", args: [], env: {}});
        expect(mcpServers["__proto__"]).toEqual({command: "third", args: [], env: {}});
    });

    it("preserves the legacy fork and accepts a generic detached fork", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        vi.spyOn(client, "forkPrompt").mockResolvedValue({response: "private", stopReason: "completed"});
        vi.spyOn(client, "detachedForkPrompt").mockResolvedValue({response: "detached", stopReason: "completed"});
        (agent as any).sessions.set("parent-session", createTestSessionState({
            sessionId: "parent-session",
            sessionMcpServers: ["parent-tools"],
            sessionMcpServerConfigs: [{
                name: "parent-tools",
                command: "parent-tools",
                args: ["serve"],
                env: [],
            }],
        }));

        await expect(agent.forkPrompt({sessionId: "parent-session", prompt: "legacy"})).resolves.toEqual({
            response: "private",
            stopReason: "completed",
        });
        const request = {sessionId: "parent-session", prompt: "answer", mcpServers: []};
        await expect(agent.detachedForkPrompt(request)).resolves.toEqual({accepted: true});
        await expect(agent.detachedForkPrompt({...request, sessionId: "missing"})).rejects.toBeTruthy();
        expect(client.forkPrompt).toHaveBeenCalledWith("parent-session", "legacy", "/test/cwd");
        expect(client.detachedForkPrompt).toHaveBeenCalledWith("parent-session", {
            prompt: "answer",
            mcpServers: [],
            inheritedMcpServers: [{
                name: "parent-tools",
                command: "parent-tools",
                args: ["serve"],
                env: [],
            }],
        }, "/test/cwd");
    });
});

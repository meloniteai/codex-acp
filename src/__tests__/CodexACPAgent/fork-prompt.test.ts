import {describe, expect, it, vi} from "vitest";
import {createCodexMockTestFixture, createTestSessionState} from "../acp-test-utils";

describe("internal fork prompt", () => {
    it("uses an ephemeral read-only thread without ACP session updates", async () => {
        const fixture = createCodexMockTestFixture();
        const client = fixture.getCodexAcpClient();
        const appServer = fixture.getCodexAppServerClient();
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
                serverName: "review",
                mode: "form",
                _meta: {},
                message: "Provide input",
                requestedSchema: {type: "object", properties: {}},
            })).resolves.toEqual({action: "cancel", content: null, _meta: null});
            await expect(fixture.sendServerRequest("mcpServer/elicitation/request", {
                threadId: "fork-thread",
                turnId: "fork-turn",
                serverName: "other",
                mode: "form",
                _meta: {codex_approval_kind: "mcp_tool_call"},
                message: "Allow other tool?",
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

        await expect(client.forkPrompt("parent-thread", {prompt: "answer privately", mcpServers: [{name: "review", command: "melonite", args: ["mcp"], env: {}}]}, "/test/cwd")).resolves.toEqual({
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
                mcp_servers: {
                    review: {command: "melonite", args: ["mcp"], env: {}},
                },
            },
        });
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

    it("only forks an active ACP parent session", async () => {
        const fixture = createCodexMockTestFixture();
        const agent = fixture.getCodexAcpAgent();
        const client = fixture.getCodexAcpClient();
        vi.spyOn(client, "forkPrompt").mockResolvedValue({response: "private", stopReason: "completed"});
        (agent as any).sessions.set("parent-session", createTestSessionState({sessionId: "parent-session"}));

        const request = {
            sessionId: "parent-session", consultationId: "consultation-1", prompt: "answer", async: true as const,
            sandboxMode: "read-only" as const, inheritTools: false as const,
            mcpServers: [{name: "review", command: "melonite", args: ["mcp"], env: {}}],
        };
        await expect(agent.forkPrompt(request)).resolves.toEqual({
            accepted: true,
            consultationId: "consultation-1",
            state: "running",
        });
        await expect(agent.forkPrompt({...request, sessionId: "missing"})).rejects.toBeTruthy();
        expect(client.forkPrompt).toHaveBeenCalledWith("parent-session", {prompt: "answer", mcpServers: request.mcpServers}, "/test/cwd");
    });
});

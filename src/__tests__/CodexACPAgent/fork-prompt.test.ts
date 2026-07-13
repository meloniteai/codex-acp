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
        vi.spyOn(appServer, "runTurn").mockResolvedValue({
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
        } as never);
        vi.spyOn(appServer, "threadUnsubscribe").mockResolvedValue({} as never);

        await expect(client.forkPrompt("parent-thread", "answer privately", "/test/cwd")).resolves.toEqual({
            response: "fork answer",
            stopReason: "completed",
        });
        expect(appServer.threadFork).toHaveBeenCalledWith({
            threadId: "parent-thread",
            cwd: "/test/cwd",
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
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

        await expect(agent.forkPrompt({sessionId: "parent-session", prompt: "answer"})).resolves.toEqual({
            response: "private",
            stopReason: "completed",
        });
        await expect(agent.forkPrompt({sessionId: "missing", prompt: "answer"})).rejects.toBeTruthy();
        expect(client.forkPrompt).toHaveBeenCalledWith("parent-session", "answer", "/test/cwd");
    });
});

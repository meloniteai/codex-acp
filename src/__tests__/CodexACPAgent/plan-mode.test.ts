import {describe, expect, it} from "vitest";
import {AgentMode} from "../../AgentMode";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    setupPromptTestSession,
} from "../acp-test-utils";

describe("Plan mode", () => {
    it("passes Codex plan collaboration mode on turn/start", async () => {
        const {mockFixture, turnStartSpy} = setupPromptTestSession({
            agentMode: AgentMode.Plan,
            currentModelId: "model-id[medium]",
        });

        await mockFixture.getCodexAcpAgent().prompt({
            sessionId: "session-id",
            prompt: [{type: "text", text: "Plan this change"}],
        });

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            collaborationMode: {
                mode: "plan",
                settings: {
                    model: "model-id",
                    reasoning_effort: "medium",
                    developer_instructions: null,
                },
            },
        }));
    });

    it("streams proposed plan deltas and completes without duplicating text", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "session-id"});

        await setupPromptAndSendNotifications(fixture, "session-id", sessionState, [
            {
                method: "item/plan/delta",
                params: {threadId: "session-id", turnId: "turn-id", itemId: "plan-1", delta: "draft plan"},
            },
            {
                method: "item/completed",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    completedAtMs: 0,
                    item: {type: "plan", id: "plan-1", text: "authoritative plan"},
                },
            },
        ]);

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                messageId: "plan-1",
                content: {type: "text", text: "draft plan"},
                _meta: {codex: {proposedPlan: {streaming: true, itemId: "plan-1"}}},
            },
            {
                sessionUpdate: "agent_message_chunk",
                messageId: "plan-1",
                content: {type: "text", text: ""},
                _meta: {codex: {proposedPlan: {complete: true, itemId: "plan-1", finalText: "authoritative plan"}}},
            },
        ]);
    });

    it("emits completed proposed plan text when no delta was streamed", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "session-id"});

        await setupPromptAndSendNotifications(fixture, "session-id", sessionState, [
            {
                method: "item/completed",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    completedAtMs: 0,
                    item: {type: "plan", id: "plan-1", text: "final plan"},
                },
            },
        ]);

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toEqual([
            {
                sessionUpdate: "agent_message_chunk",
                messageId: "plan-1",
                content: {type: "text", text: "final plan"},
                _meta: {codex: {proposedPlan: {complete: true, itemId: "plan-1"}}},
            },
        ]);
    });

    it("keeps checklist explanation metadata on structured plan updates", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "session-id"});

        await setupPromptAndSendNotifications(fixture, "session-id", sessionState, [
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    explanation: "Need to verify first.",
                    plan: [
                        {step: "Inspect", status: "completed"},
                        {step: "Patch", status: "inProgress"},
                    ],
                },
            },
        ]);

        const [update] = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(update).toEqual({
            sessionUpdate: "plan",
            entries: [
                {content: "Inspect", status: "completed", priority: "medium"},
                {content: "Patch", status: "in_progress", priority: "medium"},
            ],
            _meta: {
                codex: {
                    planUpdate: {
                        explanation: "Need to verify first.",
                    },
                },
            },
        });
    });
});

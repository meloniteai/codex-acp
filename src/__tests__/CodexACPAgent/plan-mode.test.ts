import {describe, expect, it} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
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

    it("emits one native Markdown plan update when Codex completes a streamed plan", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "session-id"});
        await fixture.getCodexAcpAgent().initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {plan: {}},
        });

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
                sessionUpdate: "plan_update",
                plan: {
                    type: "markdown",
                    planId: "plan-1",
                    content: "authoritative plan",
                },
            },
        ]);
    });

    it("falls back to plain agent text when native plan updates are unsupported", async () => {
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
            },
        ]);
    });

    it("maps Codex checklist statuses and explanation to an ACP plan update", async () => {
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
                        {step: "Verify", status: "pending"},
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
                {content: "Verify", status: "pending", priority: "medium"},
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

    it("forwards complete checklist replacements, including an empty clear", async () => {
        const fixture = createCodexMockTestFixture();
        const sessionState = createTestSessionState({sessionId: "session-id"});

        await setupPromptAndSendNotifications(fixture, "session-id", sessionState, [
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    explanation: null,
                    plan: [
                        {step: "Inspect", status: "inProgress"},
                        {step: "Verify", status: "pending"},
                    ],
                },
            },
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    explanation: "Work finished.",
                    plan: [
                        {step: "Inspect", status: "completed"},
                        {step: "Verify", status: "completed"},
                    ],
                },
            },
            {
                method: "turn/plan/updated",
                params: {
                    threadId: "session-id",
                    turnId: "turn-id",
                    explanation: null,
                    plan: [],
                },
            },
        ]);

        const updates = fixture.getAcpConnectionEvents([])
            .filter(event => event.method === "sessionUpdate")
            .map(event => event.args[0].update);
        expect(updates).toEqual([
            {
                sessionUpdate: "plan",
                entries: [
                    {content: "Inspect", status: "in_progress", priority: "medium"},
                    {content: "Verify", status: "pending", priority: "medium"},
                ],
                _meta: {codex: {planUpdate: {explanation: null}}},
            },
            {
                sessionUpdate: "plan",
                entries: [
                    {content: "Inspect", status: "completed", priority: "medium"},
                    {content: "Verify", status: "completed", priority: "medium"},
                ],
                _meta: {codex: {planUpdate: {explanation: "Work finished."}}},
            },
            {
                sessionUpdate: "plan",
                entries: [],
                _meta: {codex: {planUpdate: {explanation: null}}},
            },
        ]);
    });
});

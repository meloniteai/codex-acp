import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import type {
    CommandExecutionRequestApprovalParams,
    FileChangeRequestApprovalParams,
    PermissionsRequestApprovalParams,
    ToolRequestUserInputParams,
} from '../../app-server/v2';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { SessionState } from '../../CodexAcpServer';
import {AgentMode} from "../../AgentMode";
import {ApprovalOptionId} from "../../ApprovalOptionId";
import {CodexUserInputHandler, OTHER_SENTINEL_PREFIX} from "../../CodexUserInputHandler";

describe('Approval Events', () => {
    let fixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        fixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    function setupSessionWithPendingPrompt() {
        const codexAcpAgent = fixture.getCodexAcpAgent();

        let resolveTurnCompleted: (value: { threadId: string; turn: { id: string; items: never[]; status: string; error: null } }) => void;
        const turnCompletedPromise = new Promise<{ threadId: string; turn: { id: string; items: never[]; status: string; error: null } }>((resolve) => {
            resolveTurnCompleted = resolve;
        });

        fixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
            turn: { id: "turn-id", items: [], status: "inProgress", error: null }
        });
        fixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockReturnValue(turnCompletedPromise);

        const sessionState: SessionState = createTestSessionState({
            sessionId,
            currentModelId: 'model-id[effort]',
            agentMode: AgentMode.DEFAULT_AGENT_MODE
        });
        vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

        const promptPromise = codexAcpAgent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'Test prompt' }]
        });

        return {
            promptPromise,
            completeTurn: () => resolveTurnCompleted!({
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null }
            })
        };
    }

    describe('request_user_input approval bridge', () => {
        it('maps a selected ACP permission option back to a Codex user input answer', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: '1' }
            });

            const params: ToolRequestUserInputParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'request-user-input-1',
                autoResolutionMs: 60000,
                questions: [{
                    id: 'approval',
                    header: 'Approve app tool call?',
                    question: 'Allow this action?',
                    isOther: false,
                    isSecret: false,
                    options: [
                        { label: 'Allow', description: 'Run the tool and continue.' },
                        { label: 'Cancel', description: 'Cancel this tool call.' },
                    ],
                }],
            };

            const response = await fixture.sendServerRequest(
                'item/tool/requestUserInput',
                params
            );

            expect(response).toEqual({
                answers: {
                    approval: {
                        answers: ['Cancel'],
                    },
                },
            });

            const requestEvent = fixture.getAcpConnectionEvents([])[0];
            expect(requestEvent).toBeDefined();
            const request = requestEvent!.args[0];
            expect(request.toolCall).toMatchObject({
                toolCallId: 'request-user-input-1',
                kind: 'other',
                status: 'pending',
                title: 'Approve app tool call?',
            });
            expect(request.options).toEqual([
                expect.objectContaining({ optionId: '0', name: 'Allow', kind: 'allow_once' }),
                expect.objectContaining({ optionId: '1', name: 'Cancel', kind: 'reject_once' }),
            ]);

            completeTurn();
            await promptPromise;
        });

        it('accepts native Codex option questions that include an Other affordance', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: '0' }
            });

            const params: ToolRequestUserInputParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'request-user-input-1',
                autoResolutionMs: null,
                questions: [{
                    id: 'approval',
                    header: 'Confirm',
                    question: 'Proceed with the plan?',
                    isOther: true,
                    isSecret: false,
                    options: [
                        { label: 'Yes (Recommended)', description: 'Continue the current plan.' },
                        { label: 'No', description: 'Stop and revisit the approach.' },
                    ],
                }],
            };

            const response = await fixture.sendServerRequest(
                'item/tool/requestUserInput',
                params
            );

            expect(response).toEqual({
                answers: {
                    approval: {
                        answers: ['Yes (Recommended)'],
                    },
                },
            });
            expect(fixture.getAcpConnectionEvents([])[0]?.args[0].options).toEqual([
                expect.objectContaining({ optionId: '0', name: 'Yes (Recommended)', kind: 'allow_once' }),
                expect.objectContaining({ optionId: '1', name: 'No', kind: 'reject_once' }),
            ]);

            completeTurn();
            await promptPromise;
        });

        it('auto-resolves request_user_input questions that permission fallback cannot collect', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const params: ToolRequestUserInputParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'request-user-input-no-options',
                autoResolutionMs: null,
                questions: [{
                    id: 'approval',
                    header: 'Need input',
                    question: 'Type a value',
                    isOther: false,
                    isSecret: false,
                    options: null,
                }],
            };

            await expect(fixture.sendServerRequest(
                'item/tool/requestUserInput',
                params
            )).resolves.toEqual({answers: {}});
            expect(fixture.getAcpConnectionEvents([])).toEqual([]);

            completeTurn();
            await promptPromise;
        });

        it('uses ACP form elicitation for full request_user_input answers when supported', async () => {
            const connection = {
                request: vi.fn().mockResolvedValue({
                    action: 'accept',
                    content: {
                        approval: 'Allow',
                        approval__note: 'use the staging token',
                        comment: 'ship it',
                        secret: 'masked-value',
                    },
                }),
                notify: vi.fn(),
            };
            const handler = new CodexUserInputHandler(
                connection as any,
                createTestSessionState({sessionId}),
                {elicitation: {form: {}}},
            );

            const response = await handler.handleUserInput({
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'request-user-input-form',
                autoResolutionMs: null,
                questions: [
                    {
                        id: 'approval',
                        header: 'Approve app tool call?',
                        question: 'Allow this action?',
                        isOther: true,
                        isSecret: false,
                        options: [
                            { label: 'Allow', description: 'Run the tool and continue.' },
                            { label: 'Cancel', description: 'Cancel this tool call.' },
                        ],
                    },
                    {
                        id: 'comment',
                        header: 'Comment',
                        question: 'Add a note',
                        isOther: false,
                        isSecret: false,
                        options: null,
                    },
                    {
                        id: 'secret',
                        header: 'Secret',
                        question: 'Provide the token',
                        isOther: false,
                        isSecret: true,
                        options: null,
                    },
                ],
            });

            expect(response).toEqual({
                answers: {
                    approval: {answers: ['Allow', `${OTHER_SENTINEL_PREFIX}use the staging token`]},
                    comment: {answers: [`${OTHER_SENTINEL_PREFIX}ship it`]},
                    secret: {answers: [`${OTHER_SENTINEL_PREFIX}masked-value`]},
                },
            });
            expect(connection.request).toHaveBeenCalledWith(
                acp.methods.client.elicitation.create,
                expect.objectContaining({
                    sessionId,
                    mode: 'form',
                    requestedSchema: expect.objectContaining({
                        type: 'object',
                        properties: expect.objectContaining({
                            approval: expect.objectContaining({
                                type: 'string',
                                title: 'Approve app tool call?',
                                description: 'Allow this action?',
                                oneOf: [
                                    {const: 'Allow', title: 'Allow', description: 'Run the tool and continue.'},
                                    {const: 'Cancel', title: 'Cancel', description: 'Cancel this tool call.'},
                                ],
                            }),
                            approval__note: expect.objectContaining({
                                type: 'string',
                            }),
                            comment: expect.objectContaining({
                                type: 'string',
                                title: 'Comment',
                                description: 'Add a note',
                            }),
                            secret: expect.objectContaining({
                                type: 'string',
                                format: 'password',
                            }),
                        }),
                    }),
                    _meta: {
                        codex: {
                            request_user_input: {
                                threadId: sessionId,
                                turnId: 'turn-1',
                                itemId: 'request-user-input-form',
                                autoResolutionMs: null,
                                fields: [
                                    {
                                        questionId: 'approval',
                                        answerField: 'approval',
                                        noteField: 'approval__note',
                                    },
                                    {
                                        questionId: 'comment',
                                        answerField: 'comment',
                                    },
                                    {
                                        questionId: 'secret',
                                        answerField: 'secret',
                                    },
                                ],
                            },
                        },
                    },
                }),
                undefined,
            );
        });

        it('auto-resolves form elicitation when the request_user_input timer fires', async () => {
            vi.useFakeTimers();
            try {
                let aborted = false;
                const connection = {
                    request: vi.fn((_method, _params, options?: acp.SendRequestOptions) => new Promise((_resolve, reject) => {
                        options?.cancellationSignal?.addEventListener('abort', () => {
                            aborted = true;
                            reject(new Error('aborted'));
                        });
                    })),
                    notify: vi.fn(),
                };
                const handler = new CodexUserInputHandler(
                    connection as any,
                    createTestSessionState({sessionId}),
                    {elicitation: {form: {}}},
                );

                const responsePromise = handler.handleUserInput({
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: 'request-user-input-timeout',
                    autoResolutionMs: 50,
                    questions: [{
                        id: 'comment',
                        header: 'Comment',
                        question: 'Add a note',
                        isOther: false,
                        isSecret: false,
                        options: null,
                    }],
                });

                await vi.advanceTimersByTimeAsync(50);

                await expect(responsePromise).resolves.toEqual({answers: {}});
                expect(aborted).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('clears the request_user_input timer when form elicitation answers first', async () => {
            vi.useFakeTimers();
            try {
                let aborted = false;
                const connection = {
                    request: vi.fn((_method, _params, options?: acp.SendRequestOptions) => {
                        options?.cancellationSignal?.addEventListener('abort', () => {
                            aborted = true;
                        });
                        return Promise.resolve({
                            action: 'accept',
                            content: {comment: 'done'},
                        });
                    }),
                    notify: vi.fn(),
                };
                const handler = new CodexUserInputHandler(
                    connection as any,
                    createTestSessionState({sessionId}),
                    {elicitation: {form: {}}},
                );

                await expect(handler.handleUserInput({
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: 'request-user-input-fast-answer',
                    autoResolutionMs: 1000,
                    questions: [{
                        id: 'comment',
                        header: 'Comment',
                        question: 'Add a note',
                        isOther: false,
                        isSecret: false,
                        options: null,
                    }],
                })).resolves.toEqual({
                    answers: {
                        comment: {answers: [`${OTHER_SENTINEL_PREFIX}done`]},
                    },
                });

                await vi.advanceTimersByTimeAsync(1000);
                expect(aborted).toBe(false);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe('Command execution approval', () => {
        const commandApprovalCases = [
            { optionId: 'allow_once', expectedDecision: 'accept', description: 'allow once' },
            { optionId: 'allow_always', expectedDecision: 'acceptForSession', description: 'allow for session' },
            { optionId: 'reject_once', expectedDecision: 'decline', description: 'reject' },
        ] as const;

        it.each(commandApprovalCases)(
            'should map $optionId to $expectedDecision ($description)',
            async ({ optionId, expectedDecision }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: CommandExecutionRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: `item-${optionId}`,
                    reason: 'Test command',
                    startedAtMs: 0,
                    environmentId: null,
                    proposedExecpolicyAmendment: null,
                };

                const response = await fixture.sendServerRequest(
                    'item/commandExecution/requestApproval',
                    params
                );

                expect(response).toEqual({ decision: expectedDecision });

                completeTurn();
                await promptPromise;
            }
        );

        it('should handle cancelled permission dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-cancelled',
                reason: null,
                proposedExecpolicyAmendment: null,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });

            completeTurn();
            await promptPromise;
        });

        it('should map execpolicy amendment approval to the exact app-server decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment }
            });

            const proposedExecpolicyAmendment = ['npm', 'install'];
            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-execpolicy-amendment',
                startedAtMs: 0,
                environmentId: null,
                reason: 'Installing dependencies',
                command: 'npm install',
                cwd: '/home/user/project',
                proposedExecpolicyAmendment,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    acceptWithExecpolicyAmendment: {
                        execpolicy_amendment: proposedExecpolicyAmendment,
                    },
                },
            });

            const requestEvent = fixture.getAcpConnectionEvents([])[0];
            expect(requestEvent).toBeDefined();
            const request = requestEvent!.args[0];
            expect(request.options).toContainEqual(
                expect.objectContaining({
                    optionId: ApprovalOptionId.AcceptWithExecpolicyAmendment,
                    kind: 'allow_always',
                })
            );

            completeTurn();
            await promptPromise;
        });

        it('should map network policy amendment approval to the exact app-server decision', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            const optionId = `${ApprovalOptionId.ApplyNetworkPolicyAmendment}:0`;
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId }
            });

            const networkPolicyAmendment = { host: 'registry.npmjs.org', action: 'allow' as const };
            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'item-network-policy-amendment',
                startedAtMs: 0,
                environmentId: null,
                reason: 'Needs network access',
                networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
                proposedNetworkPolicyAmendments: [networkPolicyAmendment],
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({
                decision: {
                    applyNetworkPolicyAmendment: {
                        network_policy_amendment: networkPolicyAmendment,
                    },
                },
            });

            const requestEvent = fixture.getAcpConnectionEvents([])[0];
            expect(requestEvent).toBeDefined();
            const request = requestEvent!.args[0];
            expect(request.options).toContainEqual(
                expect.objectContaining({
                    optionId,
                    kind: 'allow_always',
                })
            );

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: CommandExecutionRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-no-handler',
                reason: null,
                proposedExecpolicyAmendment: null,
            };

            const response = await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-snapshot',
                reason: 'Running npm install',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-command-allow-once.json'
            );

            completeTurn();
            await promptPromise;
        });

        it('should include rawInput with command and cwd', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-with-command',
                reason: 'Installing dependencies',
                command: 'npm install',
                cwd: '/home/user/project',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-command-with-rawInput.json'
            );

            completeTurn();
            await promptPromise;
        });

        it.each([
            { command: '/bin/zsh -c npm install', expected: 'npm install' },
            { command: '/bin/bash -lc npm install', expected: 'npm install' },
            { command: 'zsh npm install', expected: 'npm install' },
            { command: 'sh -c ls -la', expected: 'ls -la' },
            { command: 'npm install', expected: 'npm install' },
            { command: "/bin/bash -lc './tests.cmd -Darg=value'", expected: './tests.cmd -Darg=value' },
            { command: "/bin/zsh -c 'echo hello'", expected: 'echo hello' },
        ])('should strip shell prefix from "$command" in rawInput', async ({ command, expected }) => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: CommandExecutionRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                environmentId: null,
                itemId: 'item-shell-prefix',
                reason: 'Installing dependencies',
                command,
                cwd: '/home/user/project',
                proposedExecpolicyAmendment: null,
            };

            await fixture.sendServerRequest(
                'item/commandExecution/requestApproval',
                params
            );

            const dump = fixture.getAcpConnectionDump(['_meta']);
            const parsed = JSON.parse(dump);
            expect(parsed.args[0].toolCall.rawInput.command).toBe(expected);

            completeTurn();
            await promptPromise;
        });
    });

    describe('File change approval', () => {
        const fileChangeApprovalCases = [
            { optionId: 'allow_once', expectedDecision: 'accept', description: 'allow once' },
            { optionId: 'allow_always', expectedDecision: 'acceptForSession', description: 'allow for session' },
            { optionId: 'reject_once', expectedDecision: 'decline', description: 'reject' },
        ] as const;

        it.each(fileChangeApprovalCases)(
            'should map $optionId to $expectedDecision ($description)',
            async ({ optionId, expectedDecision }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: FileChangeRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    startedAtMs: 0,
                    itemId: `file-change-${optionId}`,
                    reason: 'Test file change',
                    grantRoot: null,
                };

                const response = await fixture.sendServerRequest(
                    'item/fileChange/requestApproval',
                    params
                );

                expect(response).toEqual({ decision: expectedDecision });

                completeTurn();
                await promptPromise;
            }
        );

        it('should handle cancelled file change dialog', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                itemId: 'file-change-cancelled',
                reason: null,
                grantRoot: null,
            };

            const response = await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });

            completeTurn();
            await promptPromise;
        });

        it('should return cancel when no handler registered', async () => {
            const params: FileChangeRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                startedAtMs: 0,
                itemId: 'file-change-no-handler',
                reason: null,
                grantRoot: null,
            };

            const response = await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            expect(response).toEqual({ decision: 'cancel' });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: 'allow_once' }
            });

            const params: FileChangeRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                startedAtMs: 0,
                itemId: 'file-change-snapshot',
                reason: 'Modifying config file',
                grantRoot: null,
            };

            await fixture.sendServerRequest(
                'item/fileChange/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-file-change.json'
            );

            completeTurn();
            await promptPromise;
        });
    });

    describe('Permissions approval', () => {
        const requestedPermissions = {
            network: { enabled: true },
            fileSystem: {
                read: ['/home/user/project'],
                write: ['/home/user/project/tmp'],
                entries: [],
            },
        };

        const permissionApprovalCases = [
            {
                optionId: ApprovalOptionId.AllowPermissionsForTurn,
                expectedResponse: {
                    permissions: requestedPermissions,
                    scope: 'turn',
                    strictAutoReview: false,
                },
                description: 'allow for turn',
            },
            {
                optionId: ApprovalOptionId.AllowPermissionsForSession,
                expectedResponse: {
                    permissions: requestedPermissions,
                    scope: 'session',
                    strictAutoReview: false,
                },
                description: 'allow for session',
            },
            {
                optionId: ApprovalOptionId.RejectPermissions,
                expectedResponse: {
                    permissions: {},
                    scope: 'turn',
                    strictAutoReview: true,
                },
                description: 'reject',
            },
        ] as const;

        it.each(permissionApprovalCases)(
            'should map $optionId to app-server permissions response ($description)',
            async ({ optionId, expectedResponse }) => {
                const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
                fixture.setPermissionResponse({
                    outcome: { outcome: 'selected', optionId }
                });

                const params: PermissionsRequestApprovalParams = {
                    threadId: sessionId,
                    turnId: 'turn-1',
                    itemId: `permissions-${optionId}`,
                    environmentId: null,
                    startedAtMs: 0,
                    cwd: '/home/user/project',
                    reason: 'Need extra access',
                    permissions: requestedPermissions,
                };

                const response = await fixture.sendServerRequest(
                    'item/permissions/requestApproval',
                    params
                );

                expect(response).toEqual(expectedResponse);

                completeTurn();
                await promptPromise;
            }
        );

        it('should map cancelled permission dialog to strict auto-review with no grants', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'cancelled' }
            });

            const params: PermissionsRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'permissions-cancelled',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            expect(response).toEqual({
                permissions: {},
                scope: 'turn',
                strictAutoReview: true,
            });

            completeTurn();
            await promptPromise;
        });

        it('should return strict auto-review with no grants when no handler registered', async () => {
            const params: PermissionsRequestApprovalParams = {
                threadId: 'non-existent-session',
                turnId: 'turn-1',
                itemId: 'permissions-no-handler',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            const response = await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            expect(response).toEqual({
                permissions: {},
                scope: 'turn',
                strictAutoReview: true,
            });
        });

        it('should convert to ACP permission request format', async () => {
            const { promptPromise, completeTurn } = setupSessionWithPendingPrompt();
            fixture.setPermissionResponse({
                outcome: { outcome: 'selected', optionId: ApprovalOptionId.AllowPermissionsForSession }
            });

            const params: PermissionsRequestApprovalParams = {
                threadId: sessionId,
                turnId: 'turn-1',
                itemId: 'permissions-snapshot',
                environmentId: null,
                startedAtMs: 0,
                cwd: '/home/user/project',
                reason: 'Need extra access',
                permissions: requestedPermissions,
            };

            await fixture.sendServerRequest(
                'item/permissions/requestApproval',
                params
            );

            await expect(fixture.getAcpConnectionDump([])).toMatchFileSnapshot(
                'data/approval-permissions-request.json'
            );

            completeTurn();
            await promptPromise;
        });
    });
});

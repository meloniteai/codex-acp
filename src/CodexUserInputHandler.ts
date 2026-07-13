import * as acp from "@agentclientprotocol/sdk";
import type {SessionState} from "./CodexAcpServer";
import type {UserInputHandler} from "./CodexAppServerClient";
import type {
    ToolRequestUserInputAnswer,
    ToolRequestUserInputOption,
    ToolRequestUserInputParams,
    ToolRequestUserInputQuestion,
    ToolRequestUserInputResponse,
} from "./app-server/v2";
import type {AcpClientConnection} from "./ACPSessionConnection";
import {logger} from "./Logger";
import {clientSupportsFormElicitation} from "./ElicitationCapabilities";

export const OTHER_SENTINEL_PREFIX = "user_note: ";

const NOTE_FIELD_SUFFIX = "__note";

type UserInputOption = {
    option: acp.PermissionOption;
    answer: string;
};

type FormQuestionMapping = {
    question: ToolRequestUserInputQuestion;
    fieldName: string;
    noteFieldName: string | null;
    optionLabels: Set<string>;
    freeTextOnly: boolean;
};

export class CodexUserInputHandler implements UserInputHandler {
    private readonly connection: AcpClientConnection;
    private readonly sessionState: SessionState;
    private readonly clientCapabilities: acp.ClientCapabilities | null;
    private readonly cancellationSignal: AbortSignal | undefined;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        clientCapabilities: acp.ClientCapabilities | null = null,
        cancellationSignal?: AbortSignal,
    ) {
        this.connection = connection;
        this.sessionState = sessionState;
        this.clientCapabilities = clientCapabilities;
        this.cancellationSignal = cancellationSignal;
    }

    async handleUserInput(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        this.assertUniqueQuestionIds(params.questions);
        if (clientSupportsFormElicitation(this.clientCapabilities)) {
            return await this.handleWithFormElicitation(params);
        }
        return await this.handleWithPermissionFallback(params);
    }

    private async handleWithFormElicitation(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        const {request, mappings} = this.buildElicitationRequest(params);
        const response = await this.requestWithAutoResolution(
            params.autoResolutionMs,
            (options) => this.connection.request(
                acp.methods.client.elicitation.create,
                request,
                options,
            ),
        );
        if (response === null) {
            return { answers: {} };
        }
        return this.convertElicitationResponse(mappings, response);
    }

    private async handleWithPermissionFallback(params: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
        const answers: ToolRequestUserInputResponse["answers"] = {};
        for (const [questionIndex, question] of params.questions.entries()) {
            const answer = await this.handlePermissionQuestion(params, question, questionIndex);
            if (answer) {
                answers[question.id] = answer;
            }
        }
        return {answers};
    }

    private async handlePermissionQuestion(
        params: ToolRequestUserInputParams,
        question: ToolRequestUserInputQuestion,
        questionIndex: number,
    ): Promise<ToolRequestUserInputAnswer | null> {
        if (!this.permissionFallbackSupported(question)) {
            return null;
        }
        const options = this.buildOptions(question);
        const response = await this.requestWithAutoResolution(
            params.autoResolutionMs,
            (requestOptions) => this.connection.request(
                acp.methods.client.session.requestPermission,
                this.buildPermissionRequest(params, question, questionIndex, options),
                requestOptions,
            ),
        );
        if (response === null) {
            return null;
        }
        return this.convertPermissionResponse(question, options, response);
    }

    private async requestWithAutoResolution<T>(
        autoResolutionMs: number | null,
        request: (options?: acp.SendRequestOptions) => Promise<T>,
    ): Promise<T | null> {
        if (autoResolutionMs === null) {
            return await request(this.parentRequestOptions());
        }

        const controller = new AbortController();
        let autoResolved = false;
        const abortFromParent = () => controller.abort(this.cancellationSignal?.reason);
        if (this.cancellationSignal) {
            if (this.cancellationSignal.aborted) {
                abortFromParent();
            } else {
                this.cancellationSignal.addEventListener("abort", abortFromParent, {once: true});
            }
        }

        const timeout = setTimeout(() => {
            autoResolved = true;
            controller.abort();
        }, autoResolutionMs);

        try {
            const response = await request({cancellationSignal: controller.signal});
            return autoResolved ? null : response;
        } catch (error) {
            if (autoResolved) {
                return null;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
            this.cancellationSignal?.removeEventListener("abort", abortFromParent);
        }
    }

    private parentRequestOptions(): acp.SendRequestOptions | undefined {
        return this.cancellationSignal ? {cancellationSignal: this.cancellationSignal} : undefined;
    }

    private buildElicitationRequest(
        params: ToolRequestUserInputParams
    ): { request: acp.CreateElicitationRequest; mappings: FormQuestionMapping[] } {
        const mappings: FormQuestionMapping[] = [];
        const properties: NonNullable<acp.ElicitationSchema["properties"]> = {};
        const usedFieldNames = new Set(params.questions.map(question => question.id));

        for (const question of params.questions) {
            const freeTextOnly = !question.options || question.options.length === 0;
            const mapping: FormQuestionMapping = {
                question,
                fieldName: question.id,
                noteFieldName: question.isOther && !freeTextOnly
                    ? this.uniqueFieldName(`${question.id}${NOTE_FIELD_SUFFIX}`, usedFieldNames)
                    : null,
                optionLabels: new Set((question.options ?? []).map(option => option.label)),
                freeTextOnly,
            };
            mappings.push(mapping);
            properties[mapping.fieldName] = this.questionProperty(question, freeTextOnly);
            if (mapping.noteFieldName) {
                properties[mapping.noteFieldName] = {
                    type: "string",
                    title: `${this.title(question)} note`,
                    description: "Additional notes",
                };
            }
        }

        return {
            request: {
                sessionId: this.sessionState.sessionId,
                mode: "form",
                message: "Additional input is required.",
                requestedSchema: {
                    type: "object",
                    properties,
                },
                _meta: {
                    codex: {
                        request_user_input: {
                            threadId: params.threadId,
                            turnId: params.turnId,
                            itemId: params.itemId,
                            autoResolutionMs: params.autoResolutionMs,
                            fields: mappings.map(mapping => ({
                                questionId: mapping.question.id,
                                answerField: mapping.fieldName,
                                ...(mapping.noteFieldName ? {noteField: mapping.noteFieldName} : {}),
                            })),
                        },
                    },
                },
            },
            mappings,
        };
    }

    private questionProperty(
        question: ToolRequestUserInputQuestion,
        freeTextOnly: boolean
    ): acp.ElicitationPropertySchema {
        const base = {
            type: "string",
            title: this.title(question),
            description: question.question,
        };
        if (freeTextOnly) {
            if (question.isSecret) {
                return {
                    ...base,
                    format: "password",
                    _meta: {codex: {secret: true}},
                } as acp.ElicitationPropertySchema;
            }
            return base as acp.ElicitationPropertySchema;
        }
        return {
            ...base,
            oneOf: question.options!.map(option => ({
                const: option.label,
                title: option.label,
                ...(option.description.trim().length > 0 ? {description: option.description} : {}),
            })),
        };
    }

    private uniqueFieldName(base: string, usedFieldNames: Set<string>): string {
        if (!usedFieldNames.has(base)) {
            usedFieldNames.add(base);
            return base;
        }
        for (let index = 2; ; index += 1) {
            const candidate = `${base}_${index}`;
            if (!usedFieldNames.has(candidate)) {
                usedFieldNames.add(candidate);
                return candidate;
            }
        }
    }

    private convertElicitationResponse(
        mappings: FormQuestionMapping[],
        response: acp.CreateElicitationResponse,
    ): ToolRequestUserInputResponse {
        if (!acp.CreateElicitationResponse.isAccept(response)) {
            return {answers: {}};
        }
        const content = response.content && typeof response.content === "object" && !Array.isArray(response.content)
            ? response.content
            : {};
        const answers: ToolRequestUserInputResponse["answers"] = {};

        for (const mapping of mappings) {
            const values: string[] = [];
            const selectedValue = content[mapping.fieldName];
            if (selectedValue !== undefined && selectedValue !== null && selectedValue !== "") {
                if (typeof selectedValue !== "string") {
                    throw new Error(`Invalid request_user_input response for question ${mapping.question.id}: expected a string value`);
                }
                if (mapping.freeTextOnly) {
                    values.push(`${OTHER_SENTINEL_PREFIX}${selectedValue}`);
                } else if (mapping.optionLabels.has(selectedValue)) {
                    values.push(selectedValue);
                } else {
                    throw new Error(`Invalid request_user_input response for question ${mapping.question.id}: selected value is not a requested option label`);
                }
            }

            if (mapping.noteFieldName) {
                const noteValue = content[mapping.noteFieldName];
                if (noteValue !== undefined && noteValue !== null && noteValue !== "") {
                    if (typeof noteValue !== "string") {
                        throw new Error(`Invalid request_user_input response for question ${mapping.question.id}: expected a string note`);
                    }
                    values.push(`${OTHER_SENTINEL_PREFIX}${noteValue}`);
                }
            }

            if (values.length > 0) {
                answers[mapping.question.id] = {answers: values};
            }
        }

        return {answers};
    }

    private permissionFallbackSupported(question: ToolRequestUserInputQuestion): boolean {
        return !question.isSecret && question.options !== null && question.options.length > 0;
    }

    private buildPermissionRequest(
        params: ToolRequestUserInputParams,
        question: ToolRequestUserInputQuestion,
        questionIndex: number,
        options: UserInputOption[],
    ): acp.RequestPermissionRequest {
        return {
            sessionId: this.sessionState.sessionId,
            toolCall: {
                toolCallId: this.permissionToolCallId(params, question, questionIndex),
                kind: "other",
                status: "pending",
                title: this.title(question),
                rawInput: {
                    threadId: params.threadId,
                    turnId: params.turnId,
                    itemId: params.itemId,
                    question,
                },
                content: [{ type: "content", content: { type: "text", text: this.content(question) } }],
            },
            options: options.map(({option}) => option),
            _meta: {
                codex: {
                    request_user_input: {
                        threadId: params.threadId,
                        turnId: params.turnId,
                        itemId: params.itemId,
                        autoResolutionMs: params.autoResolutionMs,
                    },
                },
            },
        };
    }

    private convertPermissionResponse(
        question: ToolRequestUserInputQuestion,
        options: UserInputOption[],
        response: acp.RequestPermissionResponse,
    ): ToolRequestUserInputAnswer | null {
        if (response.outcome.outcome === "cancelled") {
            return null;
        }
        const optionId = "optionId" in response.outcome ? response.outcome.optionId : null;
        const selected = options.find(({option}) => option.optionId === optionId);
        if (!selected) {
            logger.error("Unknown request_user_input option selected", {
                optionId,
                questionId: question.id,
            });
            return null;
        }
        return { answers: [selected.answer] };
    }

    private buildOptions(question: ToolRequestUserInputQuestion): UserInputOption[] {
        return question.options!.map((questionOption, index) => {
            const optionId = String(index);
            return {
                option: {
                    optionId,
                    name: questionOption.label,
                    kind: this.optionKind(questionOption),
                    _meta: {
                        codex: {
                            questionId: question.id,
                            optionIndex: index,
                            label: questionOption.label,
                            description: questionOption.description,
                        },
                    },
                },
                answer: questionOption.label,
            };
        });
    }

    private permissionToolCallId(
        params: ToolRequestUserInputParams,
        question: ToolRequestUserInputQuestion,
        questionIndex: number,
    ): string {
        return params.questions.length === 1 ? params.itemId : `${params.itemId}:${question.id}:${questionIndex}`;
    }

    private title(question: ToolRequestUserInputQuestion): string {
        const header = question.header.trim();
        return header.length > 0 ? header : question.id || "Request input";
    }

    private content(question: ToolRequestUserInputQuestion): string {
        const lines = [question.question];
        for (const option of question.options ?? []) {
            const description = option.description.trim();
            lines.push(description.length > 0 ? `${option.label}: ${description}` : option.label);
        }
        return lines.join("\n");
    }

    private optionKind(option: ToolRequestUserInputOption): acp.PermissionOptionKind {
        const label = option.label.toLowerCase();
        if (
            label.includes("remember") ||
            label.includes("always") ||
            label.includes("don't ask") ||
            label.includes("dont ask") ||
            label.includes("for this session")
        ) {
            return "allow_always";
        }
        if (
            label.includes("cancel") ||
            label.includes("reject") ||
            label.includes("deny") ||
            label.includes("decline") ||
            label === "no" ||
            label.startsWith("no,") ||
            label.startsWith("no ")
        ) {
            return "reject_once";
        }
        return "allow_once";
    }

    private assertUniqueQuestionIds(questions: ToolRequestUserInputQuestion[]): void {
        const seen = new Set<string>();
        for (const question of questions) {
            if (seen.has(question.id)) {
                throw new Error(`Unsupported request_user_input shape: duplicate question id ${question.id}`);
            }
            seen.add(question.id);
        }
    }
}

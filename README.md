# @melonite/codex-acp

Personal fork of `@agentclientprotocol/codex-acp` published under the
`@melonite` npm scope.

## Publish

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm publish --access public
```

If npm asks for two-factor authentication:

```bash
npm publish --access public --otp <code>
```

## Consume

```bash
npm install @melonite/codex-acp
npx -y @melonite/codex-acp
```

## Codex planning updates

Codex `update_plan` TODO checklists are forwarded as standard ACP `plan`
session updates, including pending, in-progress, and completed task states.
These execution checklists are distinct from the Markdown proposals produced
by Codex Plan mode.

## Detached fork extension

`codex/fork_prompt` starts an ephemeral read-only fork and immediately returns
`{"accepted":true}`. The fork inherits the parent conversation. Inherited MCP
servers remain configured and may be reconnected so the fork can start
reliably, but their tool calls are forced through approval and denied. Those
inherited MCP processes still execute startup code and retain any process or
network authority granted by their configuration. Codex app and plugin
discovery and web search are disabled, built-in tools cannot write files or use
the network, and command, file-write, and arbitrary elicitation requests are
denied.

Callers may provide up to 16 fork-scoped stdio or HTTP MCP servers using the
standard ACP `McpServer` representation. Only MCP tool approvals from those
explicit servers are accepted. Their names must not conflict with inherited MCP
server names. Those servers run with their own authority, so an explicitly
supplied server may access the network or perform side effects.

```json
{
  "sessionId": "parent-session",
  "prompt": "Review the completed work.",
  "mcpServers": [
    {
      "name": "review",
      "command": "/path/to/review-server",
      "args": ["serve"],
      "env": [{"name": "REVIEW_ID", "value": "review-1"}]
    }
  ]
}
```

The existing synchronous `melonite/fork_prompt` extension remains available
for compatibility with earlier releases.

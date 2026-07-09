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


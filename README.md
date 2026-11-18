# Wati adapter for Chat SDK

[![npm version](https://img.shields.io/npm/v/@wati-io/chat-sdk-adapter)](https://www.npmjs.com/package/@wati-io/chat-sdk-adapter)
[![CI](https://github.com/wati-io/chat-sdk-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/wati-io/chat-sdk-adapter/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wati-io/chat-sdk-adapter)](LICENSE)

The official [Wati](https://www.wati.io) adapter for [Chat SDK](https://chat-sdk.dev), Vercel's open-source TypeScript library for chat bots. Build a WhatsApp bot once in TypeScript, and it answers your customers through your Wati number: formatted text, reply buttons, list menus, files and approved templates.

```bash
npm install @wati-io/chat-sdk-adapter chat
```

| Folder | What it is |
| --- | --- |
| [`adapter/`](adapter) | The [`@wati-io/chat-sdk-adapter`](https://www.npmjs.com/package/@wati-io/chat-sdk-adapter) npm package. **Start with its [README](adapter/README.md)** for setup, configuration and features. |
| [`example/`](example) | A Next.js test bot that uses the package, with commands to try every feature from your phone. Run it locally or deploy it to Vercel. |

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck && npm run build
```

The example app installs the published package from npm. See [`example/README.md`](example/README.md) to run it, and to try unreleased adapter changes.

Releases are published to npm with provenance by the release workflow when a version tag is pushed. See the end of the [adapter README](adapter/README.md).

## Support

Report bugs and request features in [GitHub issues](https://github.com/wati-io/chat-sdk-adapter/issues). For questions about your Wati account, contact [Wati support](https://www.wati.io).

## License

[MIT](LICENSE)

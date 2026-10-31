# Harness chat UI

A local browser chat for the [Strands harness](../../README.md). One `createHarness()` agent per
chat, with streamed replies, collapsible tool calls and thinking, in-page approval before any
tool that can change your machine, and chats that survive a restart.

It runs on macOS, Windows, and Linux with nothing but Node.js, and the model is your choice:
Claude through your Anthropic API key, or a model running entirely on your machine with Ollama.

> **Local use only.** The agent has a real shell and file access in its workspace. The server
> binds to `127.0.0.1` and refuses cross-origin requests; don't expose it on a network.

## Quick start

You need [Node.js 22 or newer](https://nodejs.org/) (`node --version`).

**macOS / Linux**

```bash
cd harness-ts/examples/chat-ui
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm start
```

**Windows (PowerShell)**

```powershell
cd harness-ts\examples\chat-ui
npm install
Copy-Item .env.example .env # then put your key in ANTHROPIC_API_KEY
npm start
```

Open <http://localhost:3000> and ask it something, for example _"Create a hello.py that prints
the date, run it, and tell me the output."_ The agent works in `./workspace` (created on first
run); point `HARNESS_WORKSPACE` at another directory to let it work on a real project.

The example installs the published `@strands-agents/harness` and `@strands-agents/sdk` packages
from npm, so it runs from a plain copy of this folder too; it doesn't need the rest of the repo.

## Choosing a model

Type any `provider/model` id into the **model** box and press **new chat**. The list suggests a
few; the default comes from `HARNESS_MODEL`.

| You want                                        | Model id                                                                                 | Setup                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Claude via the Anthropic API                    | `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`, `anthropic/claude-haiku-5-5` | `ANTHROPIC_API_KEY` in `.env`                                           |
| Fully local, no key, no data leaves the machine | `ollama/qwen3` (or any model you have pulled)                                            | Install [Ollama](https://ollama.com/download), then `ollama pull qwen3` |
| Claude on Amazon Bedrock                        | `bedrock/global.anthropic.claude-opus-5`                                                 | AWS credentials in your environment                                     |

Local models are slower and less capable with tools than Claude; pick one that supports tool
calling, such as `qwen3` or `llama3.2`. If Ollama runs somewhere other than
`http://127.0.0.1:11434`, set `OLLAMA_HOST`.

## Tool approval

Reading files, fetching web pages, and keeping a to-do list run freely. The shell, writing and
editing files, code execution, and subagents stop and show an **approval needed** card:

- **approve** runs this one call,
- **always allow this tool** runs it and stops asking for that tool in this chat,
- **deny** refuses it; the agent is told and carries on.

Set `HARNESS_APPROVAL=off` to let every tool run without asking.

## Chats and memory

Each chat is a harness session saved under `<workspace>/.agent/sessions`. The page remembers the
current chat, so reloading it, or restarting the server, picks up where you left off. **new chat**
starts a fresh session. Long-term memory the harness distills across chats lives in
`<workspace>/.agent/memory`.

## Configuration

All settings are environment variables, read from `.env` next to this README:

| Variable            | Default                       |                                 |
| ------------------- | ----------------------------- | ------------------------------- |
| `ANTHROPIC_API_KEY` |                               | Needed for `anthropic/*` models |
| `HARNESS_MODEL`     | `anthropic/claude-sonnet-5-5` | Model a new chat starts with    |
| `HARNESS_WORKSPACE` | `./workspace`                 | Directory the agent works in    |
| `HARNESS_APPROVAL`  | `ask`                         | `ask` or `off`                  |
| `PORT` / `HOST`     | `3000` / `127.0.0.1`          | Server address                  |
| `OLLAMA_HOST`       | `http://127.0.0.1:11434`      | Ollama endpoint                 |

## How it works

`src/server.ts` is a dependency-free Node HTTP server:

- `POST /api/session` calls `createHarness({ model, session, interventions })` and returns the
  session id plus any restored history.
- `POST /api/chat` runs `agent.stream(message)` and forwards text, thinking, and tool events to
  the page as Server-Sent Events.
- Tool approval is the SDK's `HumanInTheLoop` intervention with an `ask` callback: the callback
  sends an `approval` event down the open stream and waits for `POST /api/approval`.
- `POST /api/cancel` calls `agent.cancel()`.

`public/` is the page: plain HTML, CSS, and one ES module, with no build step.

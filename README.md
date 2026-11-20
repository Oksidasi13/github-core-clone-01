# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Oksidasi13/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Oksidasi13/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process: git smart HTTP (upload-pack v2 / receive-pack v0 with side-band-64k), the REST v3 API, GraphQL v4, and an MCP server, all backed by one in-memory store. No dependencies, no git binary, no network access at grade time — the git protocol, packfiles and object model are implemented from scratch on the Node standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral loopback port, registers it with the platform through `$MAKEFUN_ENV_URL/register`, and serves until the environment reports `done: true`. Requires Node 22 or newer.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

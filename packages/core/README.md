# @caohaotiantian/loom

A multi-agent runtime where every durable fact about a run is an append-only journal entry, so
parallelism, human gates, replay and tracing are one mechanism rather than four. Zero runtime
dependencies; Node.js 24 or newer (it keeps its journal in `node:sqlite`).

**Not yet published to npm.** Until it is, pack it from a clone — `node scripts/pack.mjs --out out`
— and install the tarball in its place: `npm install -g ./out/caohaotiantian-loom-0.1.0.tgz`. Keep
the `./`: npm reads `out/<name>` as a GitHub repository. Once published:

```bash
npm install -g @caohaotiantian/loom
loom --version
```

## Hello, world

```bash
mkdir demo && cd demo && mkdir graphs
cat > graphs/copy.json <<'EOF'
{"apiVersion":"loom.dev/v1","kind":"GraphSpec",
 "metadata":{"name":"copy-file","project":"demo","version":1},
 "policy":{"posture":"out","capabilities":["fs:read","fs:write"]},
 "channels":{"source":{"type":"string","reduce":"replace"},
             "body":{"type":"string","reduce":"replace"},
             "written":{"type":"object","reduce":"replace"}},
 "inputs":["source"],"outputs":["written"],
 "nodes":[{"id":"read","type":"tool","reads":["source"],"writes":["body"],
           "tool":{"name":"fs.read","version":"1.0","args":{"path":"${source}"}}},
          {"id":"write","type":"tool","reads":["body"],"writes":["written"],"unhandled":true,
           "tool":{"name":"fs.write","version":"1.0","args":{"path":"out/copy.txt","body":"${body}"}}}],
 "edges":[{"id":"e1","from":"read","to":"write","kind":"seq"}]}
EOF
echo hello > input.txt

loom compile graphs/copy.json
loom run     graphs/copy.json --input '{"source":"input.txt"}'   # prints the runId
loom replay  <runId>                                              # {"match": true, …}, touches nothing
```

As a library:

```ts
import { agent } from "@caohaotiantian/loom";
```

The shipped `.d.ts` needs no `@types/node` — `Buffer`/`NodeJS.*` in a public signature would have
forced every consumer to install it, so none remain. One TypeScript LIBRARY requirement does
remain, and only surfaces if your own `tsconfig.json` sets an explicit `"target"`/`"lib"` older
than the default `nodenext` infers (`esnext`): `bus.ts`'s `Subscription` uses `Disposable` (the
TC39 explicit-resource-management interface, `using`/`Symbol.dispose`), which needs the
`ESNext.Disposable` lib. `moduleResolution: "nodenext"` with no `"target"` set already gets it for
free; a project pinning `"target": "es2022"` (or older) needs it added explicitly, alongside
whatever else the target implies — it is additive, not a replacement for `"lib"`:

```json
{ "compilerOptions": { "target": "es2022", "lib": ["ES2022", "DOM", "DOM.Iterable", "ESNext.Disposable"] } }
```

The human-gate walkthrough, the graph language, the extension points and what does not work yet
are in the repository README: <https://github.com/caohaotiantian/EAgent#readme>.

MIT licensed.

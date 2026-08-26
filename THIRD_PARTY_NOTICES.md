# Third-party notices

## DeepSeek Harness

The programmatic tool-composition implementation in
`src/agentpatchcheck/programmatic-tool-runtime.ts` and the model-facing coding
facade in `src/agentpatchcheck/programmatic-tool-facade.ts` are adapted from
DeepSeek Harness Code Mode, its worker-thread runtime, generated TypeScript SDK,
and model-facing filesystem tools.

The opt-in DSH-compatible execution implementation in
`src/agentpatchcheck/dsh-compatible-code-runtime.ts` directly adapts the fresh
worker, host-side TypeScript stripping, `AsyncFunction` execution, empty
environment, tool-binding bridge, `ToolCallError`, bounded output, and worker
termination mechanisms from
`packages/code-runtime/code-runtime-worker-thread`. The nested dispatch queue,
exclusive barrier, cancellation, and drain-before-settle semantics adapt the
Code Mode sub-dispatch scheduler from `packages/core/tools/src/code-mode.ts`.
Its coding presentation also adapts the schema-derived TypeScript SDK, the
`code` agent preset, and the `todo_write` contract. AgentPatchCheck adds a thin
workspace-host adapter because Node worker threads cannot own an independent
working directory.

Copyright (c) 2026 DeepSeek

DeepSeek Harness is licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

# Pi Smart Mem

**Pick up where you left off without explaining everything again.**

Pi Smart Mem gives [Pi](https://pi.dev/) a memory across sessions. It helps Pi remember how you like to work, what your project expects, and what didn't work last time.

## What Pi remembers and where

| Scope | Memory types | Examples |
| --- | --- | --- |
| **Project** | Repository information, workflow decisions, and local failures | Where migrations live, which test command to use here, and a workaround specific to this repo |
| **Global** | User preferences and workflow failures that apply across projects | Prefer concise updates; verify that a check actually ran instead of relying on its exit code alone |

Project notes stay with their project. Global notes are available across projects. Memories are short, durable notes, not copies of chats or large blocks of code. Your current request and standing guidance take precedence. When a project note conflicts with a global default, the project note takes precedence in that project.

## How hybrid search finds notes

Search combines **keyword ranking (BM25)** with **semantic ranking (local embeddings)**. Keywords help find distinctive terms in errors and identifiers; embeddings help find the same idea in different words. For example, searching for "JWT lifetime" can surface a note about "token expiry". Smart Mem combines both rankings into one list.

Pi searches the current project and global notes by default. It can narrow search by scope or memory type, and results are labeled **Project** or **Global**. Other projects' memories are excluded. Pi can also follow saved links one step at a time to find a related note that neither search ranked highly. Links can lead from project notes to global notes, but not the reverse or into another project.

## When Pi saves memories

Pi can save a note during normal work. Say **"remember this"** to ask it to consider saving something; that request does not guarantee a new entry. Before saving, the model is prompted to check standing guidance and search for similar notes **in the same scope**. It should skip what's already covered, update a note when the rule changes, or add a genuinely distinct note. This is model judgment, not a guarantee against duplicates.

Automatic memory review runs in the main Pi session:

| Trigger | Default behavior |
| --- | --- |
| **Explicit save request or recognized correction** | Review at the end of the turn. |
| **Periodic review** | After 10 turns or 15 assistant tool calls, once there are at least 3 user messages and 4 usable context messages. |
| **Before compaction or on session shutdown** | Review once the conversation has at least 6 user messages. Shutdown review is skipped on reload. The review timeout defaults to 60 seconds. |

Expand a **Memory review** row to see what Pi saved, revised, or skipped and why.

## Model calls and token usage

**Searching and embedding notes run locally without a separate chat-model call. Reviewing, selecting, and maintaining memories can use extra tokens.** Reviews call your configured Pi model even when nothing is saved. A review can take multiple calls as the model searches and decides what to write. If you use a hosted model, conversation context and retrieved text can be sent to that provider. These calls count toward provider usage and may cost money.

Other features that make model calls:

- **Memory injection:** Pi selects relevant notes once after 10 total user and assistant messages by default. It selects again after compaction if it previously injected notes. `/inject-mem` runs selection on demand. Injected notes become part of the conversation and can increase input tokens on later turns.
- **Maintenance:** `/link-mem` asks the model which relationships to keep. `/consolidate-mem` asks it which notes to merge or shorten. Automatic linking is off by default; if enabled, it runs when a scope reaches 10 new unreviewed notes by default.

Open `/smart-mem-settings` to adjust thresholds and triggers. Reviews inherit the session model and reasoning level unless you choose separate settings.

## Set it up and make it yours

Requirements: Pi 1.5.2 or later, Node.js 22.19 or later, and Linux or WSL with `flock`. Git is optional; it enables origin and worktree detection.

On first launch, choose an embedding model and confirm setup. The default is English-focused MiniLM (about 23 MB). BGE Base (about 110 MB) is also available. Both run on CPU. The initial setup needs an internet connection to download the embedding model; embedding generation, indexing, and storage stay on your machine.

Open `/smart-mem-settings` to change models, review thresholds, triggers, tools, and prompts. Changing the embedding model rebuilds the index; close or coordinate other Pi sessions before doing this. CUDA is optional: install the ONNX Runtime Node CUDA 12 provider and its dependencies in your Smart Mem profile (normally `~/.pi/agent/pi-smart-mem`), then choose CUDA in settings. Smart Mem does not install CUDA or switch devices automatically.

## Migrate from pi-hermes-memory

Close other Pi sessions using Hermes or Smart Mem, then run `/migrate-hermes` in a main Pi session. One run imports global and project memories, skills, and pins. All Hermes failures become global workflow failures. Project folders are matched automatically; the command reports IDs for imported projects it could not match. Hermes files stay unchanged.

`/migrate-hermes --force` **replaces existing Smart Mem data**, including memories, links, skills, pins, and the transcript index. Without `--force`, migration refuses to replace a populated store. Neither form deletes Pi transcripts; use Smart Mem's transcript backfill to rebuild the index.

## Project identity

Smart Mem looks up Git `origin` locally and uses `.pi/smart-mem-id` when the origin is missing or new. It creates the marker in the main checkout, or in the working folder outside Git. Keep the marker when moving or renaming a project. Worktrees, clones with the same origin, and copies carrying the same marker share memories, skills, and pins within the same Smart Mem database. If origin and marker point to different known projects, Smart Mem reports the conflict and leaves both unchanged.

## Keep, find, and clean up information

- `/memory-pin <text>` adds standing instructions for this project. `/memory-pin global <text>` adds them across projects.
- Ask Pi to save a reusable procedure as a skill. The main model checks for similar skills and decides whether the procedure belongs to this project or applies globally. Automatic memory review does not save skills.
- Ask Pi to search past conversations for details that were never saved as memories. Transcript search uses a separate local index across projects. The **Transcript index** settings let you backfill existing Pi sessions or clear the index without deleting transcripts.
- `/consolidate-mem` and `/link-mem` process this project by default. Append `global` to either command to include global notes.

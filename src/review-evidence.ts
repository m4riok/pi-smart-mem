import { createHash } from "node:crypto";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { contentText } from "./archive.ts";

export function reviewEvidence(branch: SessionEntry[], messages: Message[]) {
  type Evidence = { id: string; text: string; incident: string };
  const byMessage = new Map<string, Evidence>();
  const firstReport = new Map<string, string>();
  const key = (message: Message) => message.role === "toolResult"
    ? `toolResult:${message.toolCallId}:${message.timestamp}`
    : `${message.role}:${message.timestamp}`;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    const text = contentText(message.content).trim();
    if (!text) continue;
    let incident = createHash("sha256").update(JSON.stringify([entry.id, message.timestamp])).digest("hex");
    if (message.role === "user") {
      // A verbatim repeat remains the same report, even after compaction.
      incident = firstReport.get(text) ?? incident;
      firstReport.set(text, incident);
    }
    byMessage.set(key(message), { id: entry.id, text, incident });
  }
  const visible = new Map<string, Evidence>();
  const annotated = messages.map((message): Message => {
    const source = byMessage.get(key(message));
    if (!source || message.role === "system" || !contentText(message.content).trim()) return message;
    visible.set(source.id, source);
    const label: TextContent = { type: "text", text: `\n[Smart Mem evidence messageId: ${source.id}]` };
    if (message.role === "user") return { ...message, content: typeof message.content === "string" ? message.content + label.text : [...message.content, label] };
    if (message.role === "assistant") return { ...message, content: [...message.content, label] };
    return { ...message, content: [...message.content, label] };
  });
  return {
    messages: annotated,
    incident(messageId: string, quote: string): string | undefined {
      const source = visible.get(messageId);
      return quote && source?.text.includes(quote) ? source.incident : undefined;
    },
  };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | {
      role: 'tool';
      toolCallId: string;
      content: string;
      /**
       * The call reported a failure rather than returning a result. Set by the
       * loop from the dispatch outcome, because the text alone cannot say: a
       * tool's error string and a file whose contents happen to start the same
       * way are indistinguishable once both are just `content`. Providers ignore
       * this field; it exists so local reasoning about the conversation (history
       * capping) can tell a result from a failure without guessing.
       */
      failed?: boolean;
    };

export interface Turn {
  text: string | null;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /**
   * A one-line steer for a turn that produced NO tool call but clearly *intended*
   * one — e.g. a fenced ```json block that names a real tool yet fails to parse
   * (unbalanced braces). The loop surfaces it in place of the generic
   * "continue using tools" nudge so the model fixes the malformed call instead of
   * misreading the silence as a broken tool (#I10). Providers that can't detect
   * a near-miss simply never set it.
   */
  nudge?: string;
}

export interface ChatOpts {
  maxTokens?: number;
  /**
   * Liveness callback for the loop's heartbeat (5.1). A streaming provider calls
   * it as output arrives, passing the cumulative streamed-output length in chars,
   * so a slow turn can be told apart from a hung one. Providers that don't stream
   * simply never call it (the heartbeat still reports elapsed time). Never used
   * for billing — real token usage is reported once, on the returned Turn.
   */
  onStream?: (streamedChars: number) => void;
}

export interface Provider {
  readonly name: string;
  chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn>;
  close?(): Promise<void>;
}

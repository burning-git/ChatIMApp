export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ChatSession {
  id: string;
  title: string;
  systemPrompt: string;
  stream: boolean;
  temperature: number | null;
  createdAt: string;
  updatedAt: string;
  lastMessage: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  images: string[];
  createdAt: string;
  replyToId?: string;
}

export interface Draft {
  text: string;
  images: string[];
}

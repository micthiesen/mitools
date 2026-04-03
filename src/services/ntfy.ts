export enum NtfyPriority {
  Min = 1,
  Low = 2,
  Default = 3,
  High = 4,
  Max = 5,
}

export interface NtfyViewAction {
  action: "view";
  label: string;
  url: string;
  clear?: boolean;
}

export interface NtfyHttpAction {
  action: "http";
  label: string;
  url: string;
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string;
  clear?: boolean;
}

export interface NtfyBroadcastAction {
  action: "broadcast";
  label: string;
  intent?: string;
  extras?: Record<string, string>;
  clear?: boolean;
}

export interface NtfyCopyAction {
  action: "copy";
  label: string;
  value: string;
  clear?: boolean;
}

export type NtfyAction =
  | NtfyViewAction
  | NtfyHttpAction
  | NtfyBroadcastAction
  | NtfyCopyAction;

export interface NtfyMessage {
  topic: string;
  message?: string;
  title?: string;
  priority?: NtfyPriority;
  tags?: string[];
  icon?: string;
  click?: string;
  actions?: NtfyAction[];
  markdown?: boolean;
  delay?: string;
  email?: string;
  call?: string;
  attach?: string;
  filename?: string;
}

export interface NtfyConfig {
  baseUrl: string;
  token?: string;
}

export async function ntfy(config: NtfyConfig, message: NtfyMessage): Promise<void> {
  const { topic, ...rest } = message;

  const body: Record<string, unknown> = { topic, ...rest };
  if (rest.markdown) {
    body.markdown = true;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const url = config.baseUrl.replace(/\/+$/, "");
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.text();
    throw new Error(`ntfy API returned status ${res.status}: ${data}`);
  }
}

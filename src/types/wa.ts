export class MessageMedia {
  mimetype: string;
  data: string; // base64 without prefix
  filename?: string;
  constructor(mimetype: string, data: string, filename?: string) {
    this.mimetype = mimetype;
    this.data = data;
    if (filename !== undefined) {
      this.filename = filename;
    }
  }
}

export interface Message {
  from: string;
  body?: string;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<MessageMedia | null>;
}

export interface Client {
  sendMessage(to: string, content: string | MessageMedia): Promise<void>;
}

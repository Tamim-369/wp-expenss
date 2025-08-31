import { Client, MessageMedia } from "../types/wa";

const GRAPH_VERSION = process.env.WABA_API_VERSION || "v20.0";

export class WhatsAppCloudAdapter implements Client {
  private accessToken: string;
  private phoneNumberId: string;

  constructor(params: { accessToken: string; phoneNumberId: string }) {
    this.accessToken = params.accessToken;
    this.phoneNumberId = params.phoneNumberId;
  }

  async sendMessage(to: string, content: string | MessageMedia): Promise<void> {
    if (typeof content === "string") {
      await this.sendText(to, content);
      return;
    }
    await this.sendDocument(to, content);
  }

  private async sendText(to: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("Failed to send text:", res.status, body);
      throw new Error(`Send text failed: ${res.status}`);
    }
  }

  private async sendDocument(to: string, media: MessageMedia): Promise<void> {
    const mediaId = await this.uploadMedia(media);
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/messages`;
    const payload: any = {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId },
    };
    if (media.filename) payload.document.filename = media.filename;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("Failed to send document:", res.status, body);
      throw new Error(`Send document failed: ${res.status}`);
    }
  }

  private async uploadMedia(media: MessageMedia): Promise<string> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.phoneNumberId}/media`;
    const buffer = Buffer.from(media.data, "base64");
    const blob = new Blob([buffer], { type: media.mimetype });
    const form = new FormData();
    form.append("file", blob, media.filename || "file");
    form.append("type", media.mimetype);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("Failed to upload media:", res.status, body);
      throw new Error(`Upload media failed: ${res.status}`);
    }
    const json = (await res.json()) as { id: string };
    return json.id;
  }
}

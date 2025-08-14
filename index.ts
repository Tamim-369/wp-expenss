import { Client, LocalAuth, Message, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import Groq from "groq-sdk";
import { config } from "dotenv";
import type { ExpenseData, GroqExpenseResponse } from "./types.ts";

config();

class WhatsAppExpenseTracker {
  private client: Client;
  private groq: Groq;
  private allowedNumbers: string[];

  constructor() {
    // Validate environment variables
    this.validateEnvVariables();

    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
        ],
      },
    });

    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });

    this.allowedNumbers = process.env.ALLOWED_NUMBERS
      ? process.env.ALLOWED_NUMBERS.split(",").map((num) => num.trim())
      : []; // Empty array means allow all numbers

    this.setupEventHandlers();
  }

  private validateEnvVariables(): void {
    const requiredVars = [
      "GROQ_API_KEY",
      "GOOGLE_SHEETS_ID",
      "GOOGLE_SERVICE_ACCOUNT_EMAIL",
      "GOOGLE_PRIVATE_KEY",
    ];
    const missingVars = requiredVars.filter((varName) => !process.env[varName]);
    if (missingVars.length > 0) {
      console.error(
        `❌ Missing required environment variables: ${missingVars.join(", ")}`
      );
      process.exit(1);
    }
    // Validate Google Private Key format
    if (
      !process.env.GOOGLE_PRIVATE_KEY.includes("-----BEGIN PRIVATE KEY-----")
    ) {
      console.error(
        "❌ GOOGLE_PRIVATE_KEY is invalid. Ensure it is a valid service account private key."
      );
      process.exit(1);
    }
  }

  private setupEventHandlers(): void {
    this.client.on("qr", (qr) => {
      console.log("📱 Scan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    });

    this.client.on("ready", () => {
      console.log("✅ WhatsApp client is ready!");
    });

    this.client.on("message", async (message) => {
      await this.handleMessage(message);
    });

    this.client.on("disconnected", (reason) => {
      console.log("❌ WhatsApp client disconnected:", reason);
      // Attempt to reconnect after a delay
      setTimeout(() => {
        this.client
          .initialize()
          .catch((error) => console.error("❌ Reconnection failed:", error));
      }, 5000);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      // Skip if message is from status or groups
      if (
        message.from === "status@broadcast" ||
        message.from.includes("@g.us")
      ) {
        return;
      }

      // Check if sender is in allowed numbers (if specified)
      if (this.allowedNumbers.length > 0) {
        const senderNumber = message.from.replace("@c.us", "");
        if (
          !this.allowedNumbers.some((num) =>
            senderNumber.includes(num.replace(/[^\d]/g, ""))
          )
        ) {
          return;
        }
      }

      console.log(`📨 New message from ${message.from}: ${message.body}`);

      // Process text message
      if (message.body && message.body.trim()) {
        await this.processExpenseMessage(message.body, message);
      }

      // Process image with caption
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        if (media && media.mimetype.startsWith("image/")) {
          await this.processImageMessage(media, message.body || "", message);
        }
      }
    } catch (error) {
      console.error("❌ Error handling message:", error);
      await message.reply(
        "Sorry, there was an error processing your message. Please try again."
      );
    }
  }

  private async processExpenseMessage(messageText: string, originalMessage: Message): Promise<void> {
    try {
      const expenseData = await this.extractExpenseData(messageText);

      if (expenseData) {
        await this.addToGoogleSheet(expenseData);
        await originalMessage.reply(
          `✅ Added to expenses:\n📝 Item: ${expenseData.item}\n💰 Price: $${expenseData.price}\n📅 Date: ${expenseData.date}`
        );
      } else {
        await originalMessage.reply(
          '❌ Could not extract expense information. Please use format like "Potato 10 usd" or "Coffee $5.50"'
        );
      }
    } catch (error) {
      console.error("❌ Error processing expense message:", error);
      await originalMessage.reply(
        "Sorry, there was an error processing your expense. Please try again."
      );
      throw error;
    }
  }

  private async processImageMessage(media: MessageMedia, caption: string, originalMessage: Message): Promise<void> {
    try {
      if (caption && caption.trim()) {
        await this.processExpenseMessage(caption, originalMessage);
      } else {
        await originalMessage.reply(
          '📸 Image received! Please add a caption with expense details like "Groceries 25 usd"'
        );
      }
    } catch (error) {
      console.error("❌ Error processing image message:", error);
      await originalMessage.reply(
        "Sorry, there was an error processing your image. Please try again."
      );
      throw error;
    }
  }

  private async extractExpenseData(text: string): Promise<ExpenseData | null> {
    try {
      const prompt = `You are a JSON parser. Extract expense information from: "${text}"

IMPORTANT: Return ONLY valid JSON, no code blocks, no explanations, no markdown.

Format: {"item": "name", "price": number, "currency": "USD"}
If invalid: {"error": "invalid"}

Examples:
"Coffee 10 dollar" -> {"item": "Coffee", "price": 10.00, "currency": "USD"}
"Potato $5" -> {"item": "Potato", "price": 5.00, "currency": "USD"}`;

      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a JSON parser. Return only valid JSON objects, never code blocks or explanations.",
          },
          { role: "user", content: prompt },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 100,
      });

      let response: any = completion.choices[0]?.message?.content?.trim();
      console.log("🤖 Groq response:", response);

      // Clean up response - remove code blocks if present
      response = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      const parsed = JSON.parse(response) as GroqExpenseResponse;

      if (parsed.error || !parsed.item || !parsed.price) {
        return null;
      }

      return {
        item: parsed.item,
        price: parsed.price,
        currency: parsed.currency || "USD",
        date: new Date().toISOString().split("T")[0] || "", // YYYY-MM-DD format
      };
    } catch (error) {
      console.error("❌ Error extracting expense data:", error);
      return null;
    }
  }

  private async addToGoogleSheet(expenseData: ExpenseData, retryCount: number = 0): Promise<void> {
    const maxRetries = 3;
    try {
      // Create JWT client for authentication
      const serviceAccountAuth = new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      // Debug: Log the GoogleSpreadsheet class and JWT client
      console.log("GoogleSpreadsheet class:", typeof GoogleSpreadsheet);
      console.log("JWT client created:", serviceAccountAuth.email);

      // Initialize GoogleSpreadsheet with JWT client
      const doc = new GoogleSpreadsheet(
        process.env.GOOGLE_SHEETS_ID,
        serviceAccountAuth
      );

      await doc.loadInfo();
      console.log("Google Sheet info loaded:", doc.title);

      // Get the first sheet or create a new one
      let sheet = doc.sheetsByIndex[0];
      if (!sheet) {
        console.log("Creating new sheet: Expenses");
        sheet = await doc.addSheet({
          title: "Expenses",
          headerValues: ["Date", "Item", "Price", "Currency"],
        });
      } else {
        // Ensure headers exist
        await sheet.loadHeaderRow();
        if (!sheet.headerValues || sheet.headerValues.length === 0) {
          console.log("Setting header row");
          await sheet.setHeaderRow(["Date", "Item", "Price", "Currency"]);
        }
      }

      // Add the expense data
      await sheet.addRow({
        Date: expenseData.date,
        Item: expenseData.item,
        Price: expenseData.price,
        Currency: expenseData.currency,
      });

      console.log("✅ Added to Google Sheet:", expenseData);
    } catch (error: any) {
      console.error("❌ Error adding to Google Sheet:", error);
      if (error.status === 429 && retryCount < maxRetries) {
        console.warn(
          `Rate limit hit, retrying (${retryCount + 1}/${maxRetries})...`
        );
        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (retryCount + 1))
        );
        return this.addToGoogleSheet(expenseData, retryCount + 1);
      }
      throw error;
    }
  }

  public async start(): Promise<void> {
    console.log("🚀 Starting WhatsApp Expense Tracker...");
    try {
      await this.client.initialize();
    } catch (error) {
      console.error("❌ Failed to initialize WhatsApp client:", error);
      process.exit(1);
    }
  }
}

// Start the bot
const bot = new WhatsAppExpenseTracker();
bot.start().catch((error) => {
  console.error("❌ Failed to start bot:", error);
  process.exit(1);
});

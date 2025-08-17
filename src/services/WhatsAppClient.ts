import { Client, LocalAuth, Message, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { ExpenseService } from "./ExpenseService";
import { ExcelService } from "./ExcelService";
import { MongoService } from "./MongoService";
import mongoose from "mongoose";

export class WhatsAppClient {
  private client: Client;
  private expenseService: ExpenseService;
  private excelService: ExcelService;
  private mongoService: MongoService;

  constructor() {
    this.validateEnvVariables();

    const puppeteerOptions: any = {
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
        "--single-process",
        "--disable-background-timer-throttling",
        "--disable-breakpad",
        "--disable-client-side-phishing-detection",
        "--disable-extensions",
      ],
    };

    if (process.env.CHROMIUM_PATH) {
      puppeteerOptions.executablePath = process.env.CHROMIUM_PATH;
    }

    this.client = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: puppeteerOptions,
    });

    this.expenseService = new ExpenseService();
    this.excelService = new ExcelService();
    this.mongoService = new MongoService();

    this.setupEventHandlers();
  }

  private validateEnvVariables(): void {
    const requiredVars = ["GROQ_API_KEY", "MONGO_URI"];
    const missingVars = requiredVars.filter((varName) => !process.env[varName]);
    if (missingVars.length > 0) {
      console.error(
        `❌ Missing required environment variables: ${missingVars.join(", ")}`
      );
      process.exit(1);
    }
  }

  private async connectToMongo(): Promise<void> {
    try {
      await mongoose.connect(process.env.MONGO_URI!, {
        dbName: "expense_tracker",
      });
      console.log("✅ Connected to MongoDB");
    } catch (error) {
      console.error("❌ Failed to connect to MongoDB:", error);
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
      setTimeout(() => {
        this.client
          .initialize()
          .catch((error) => console.error("❌ Reconnection failed:", error));
      }, 5000);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      if (
        message.from === "status@broadcast" ||
        message.from.includes("@g.us")
      ) {
        return;
      }

      if (message.fromMe) {
        return;
      }

      console.log(`📨 New message from ${message.from}: ${message.body}`);

      const userId = message.from;
      const messageText = message.body?.toLowerCase() || "";

      // Handle Excel export commands first
      if (
        messageText.includes("send expense info") ||
        messageText.includes("give excel file") ||
        messageText.includes("give my expense data") ||
        messageText.includes("expnese in excel") ||
        messageText.includes("expnese in sheet") ||
        messageText.includes("excel sheet") ||
        messageText.includes("google sheets") ||
        messageText.includes("monthly spend data") ||
        messageText.includes("full expense data") ||
        messageText.includes("all expense")
      ) {
        await this.excelService.sendExcelFile(userId, message);
        return;
      }

      // Handle correction commands
      if (messageText.startsWith("no it will be")) {
        await this.expenseService.handleCorrection(
          message.body!,
          userId,
          message,
          this.mongoService
        );
        return;
      }

      // Check if user has set a budget
      const hasBudget = await this.mongoService.hasMonthlyBudget(userId);
      if (!hasBudget) {
        if (message.body && !isNaN(parseFloat(message.body))) {
          const budget = parseFloat(message.body);
          await this.mongoService.setMonthlyBudget(userId, budget);
          await message.reply(
            `✅ Budget set to USD ${budget} for this month. Now you can start adding expenses.`
          );
        } else {
          await message.reply(
            "Welcome! Please enter your budget for this month (e.g., 1000)."
          );
        }
        return;
      }

      // Handle media (image) messages
      if (message.hasMedia) {
        const media = await message.downloadMedia();
        if (media && media.mimetype.startsWith("image/")) {
          await this.expenseService.processImageMessage(
            media,
            message.body || "",
            message,
            this.mongoService
          );
        } else {
          await message.reply(
            "❌ Sorry, only images are supported for expense tracking. Please send an image of a receipt."
          );
        }
        return;
      }

      // Handle text-based expense messages
      if (message.body && message.body.trim()) {
        // Basic validation to avoid processing invalid expense messages
        const trimmedMessage = message.body.trim();
        const hasNumber = /\d/.test(trimmedMessage);
        const hasText = /[a-zA-Z]/.test(trimmedMessage);

        if (hasNumber && hasText) {
          await this.expenseService.processExpenseMessage(
            trimmedMessage,
            message,
            this.mongoService
          );
        } else {
          await message.reply(
            `❌ Invalid expense format. Please use a format like "Coffee 10 usd" or send an image with a caption like "Groceries 25 usd".`
          );
        }
      }
    } catch (error) {
      console.error("❌ Error handling message:", error);
      await message.reply(
        "Sorry, there was an error processing your message. Please try again."
      );
    }
  }

  public async start(): Promise<void> {
    await this.connectToMongo();
    console.time("Client Initialization");
    try {
      await this.client.initialize();
      console.timeEnd("Client Initialization");
    } catch (error) {
      console.error("❌ Failed to initialize WhatsApp client:", error);
      process.exit(1);
    }
  }
}

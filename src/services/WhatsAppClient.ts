import { Client, LocalAuth, Message, MessageMedia } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { ExpenseService } from "./ExpenseService";
import { ExcelService } from "./ExcelService";
import { MongoService } from "./MongoService";
import { CurrencyService } from "./CurrencyService";
import mongoose from "mongoose";

export class WhatsAppClient {
  private client: Client;
  private expenseService: ExpenseService;
  private excelService: ExcelService;
  private mongoService: MongoService;
  private processedMessages: Set<string> = new Set();

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
      authStrategy: new LocalAuth({
        clientId: "expense-tracker-bot",
        dataPath: "./.wwebjs_auth"
      }),
      puppeteer: puppeteerOptions,
    });

    this.expenseService = new ExpenseService(this.client);
    this.excelService = new ExcelService(this.client);
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

    this.client.on("authenticated", () => {
      console.log("🔐 WhatsApp authentication successful!");
    });

    this.client.on("auth_failure", (msg) => {
      console.error("❌ WhatsApp authentication failed:", msg);
    });

    this.client.on("ready", () => {
      console.log("✅ WhatsApp client is ready!");
      console.log(`📱 Connected as: ${this.client.info?.pushname || 'Unknown'}`);
    });

    this.client.on("message", async (message) => {
      await this.handleMessage(message);
    });

    this.client.on("disconnected", (reason) => {
      console.log("❌ WhatsApp client disconnected:", reason);
      // Only attempt reconnection for certain disconnect reasons
      if (reason !== 'LOGOUT') {
        console.log("🔄 Attempting to reconnect in 5 seconds...");
        setTimeout(() => {
          this.client
            .initialize()
            .catch((error) => console.error("❌ Reconnection failed:", error));
        }, 5000);
      } else {
        console.log("🚪 Logged out - manual QR scan required");
      }
    });

    this.client.on("loading_screen", (percent, message) => {
      console.log(`⏳ Loading... ${percent}% - ${message}`);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      // Skip broadcast messages and group messages
      if (
        message.from === "status@broadcast" ||
        message.from.includes("@g.us")
      ) {
        return;
      }

      // Skip messages sent by this bot
      if (message.fromMe) {
        return;
      }

      // Check for duplicate message processing
      const messageId = message.id._serialized;
      if (this.processedMessages.has(messageId)) {
        console.log(`⚠️ Skipping duplicate message: ${messageId}`);
        return;
      }

      // Mark message as processed
      this.processedMessages.add(messageId);

      // Clean up old processed messages (keep last 1000)
      if (this.processedMessages.size > 1000) {
        const messagesToDelete = Array.from(this.processedMessages).slice(0, 500);
        messagesToDelete.forEach(id => this.processedMessages.delete(id));
      }

      // Add unique message ID logging to detect duplicates
      console.log(`📨 New message from ${message.from} (ID: ${messageId}): ${message.body}`);
      console.log(`🎯 Processing message for userId: ${message.from}`);

      const userId = message.from;
      const messageText = message.body?.toLowerCase() || "";

      // Get user state for onboarding flow
      const userState = await this.mongoService.getUserState(userId);

      // Handle Excel export commands (available for active users)
      if (userState === 'active' && (
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
      )) {
        await this.excelService.sendExcelFile(userId, message);
        return;
      }

      // Handle correction commands (available for active users)
      if (userState === 'active' && messageText.startsWith("no it will be")) {
        await this.expenseService.handleCorrection(
          message.body!,
          userId,
          message,
          this.mongoService
        );
        return;
      }

      // Onboarding flow
      if (userState === 'new') {
        // First message - welcome and ask for budget
        console.log(`📤 Sending welcome message to: ${userId}`);
        await this.client.sendMessage(
          userId,
          "Welcome 👋 What's your budget for this month? Example: 30000"
        );
        await this.mongoService.setUserState(userId, 'awaiting_budget');
        return;
      }

      if (userState === 'awaiting_budget') {
        // Second message - process budget and ask for currency
        if (message.body && !isNaN(parseFloat(message.body))) {
          const budget = parseFloat(message.body);
          // Store budget temporarily, will be saved with currency later
          await this.mongoService.setUserState(userId, 'awaiting_currency');

          console.log(`📤 Sending currency request to: ${userId}`);
          await this.client.sendMessage(
            userId,
            `Great. Which currency will you use? Example: INR or USD\nNote: we only store expenses in this currency.`
          );

          // Store budget in a temporary way (we'll update this when we get currency)
          const currentMonth = new Date().toISOString().slice(0, 7);
          await this.mongoService.setMonthlyBudgetWithCurrency(userId, budget, 'USD'); // temporary USD
          return;
        } else {
          console.log(`📤 Sending budget error message to: ${userId}`);
          await this.client.sendMessage(
            userId,
            "Please enter a valid budget amount (numbers only). Example: 30000"
          );
          return;
        }
      }

      if (userState === 'awaiting_currency') {
        // Third message - process currency and complete onboarding
        const detectedCurrency = CurrencyService.detectCurrency(message.body || '');

        if (detectedCurrency) {
          await this.mongoService.setUserCurrency(userId, detectedCurrency);

          // Update the budget with the correct currency
          const budget = await this.mongoService.getMonthlyBudget(userId);
          await this.mongoService.setMonthlyBudgetWithCurrency(userId, budget, detectedCurrency);

          console.log(`📤 Sending currency confirmation to: ${userId}`);
          await this.client.sendMessage(
            userId,
            `Perfect. We'll use ${detectedCurrency}.\nNow add your first expense. Example: Grocery 100`
          );
          return;
        } else {
          console.log(`📤 Sending currency error message to: ${userId}`);
          await this.client.sendMessage(
            userId,
            "Please enter a valid currency. Examples: USD, EUR, INR, BDT, Taka, Rupee, Dollar"
          );
          return;
        }
      }

      // Active user - handle expenses
      if (userState === 'active') {
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
            console.log(`📤 Sending image error message to: ${userId}`);
            await this.client.sendMessage(
              userId,
              "❌ Sorry, only images are supported for expense tracking. Please send an image of a receipt."
            );
          }
          return;
        }

        // Handle text-based expense messages
        if (message.body && message.body.trim()) {
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
            console.log(`📤 Sending invalid format message to: ${userId}`);
            await this.client.sendMessage(
              userId,
              `❌ Invalid expense format. Please use a format like "Coffee 10" or send an image with a caption.`
            );
          }
        }
      }
    } catch (error) {
      console.error("❌ Error handling message:", error);
      await this.client.sendMessage(
        message.from,
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

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
        dataPath: "./.wwebjs_auth",
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
      console.log(
        `📱 Connected as: ${this.client.info?.pushname || "Unknown"}`
      );
    });

    this.client.on("message", async (message) => {
      await this.handleMessage(message);
    });

    this.client.on("disconnected", (reason) => {
      console.log("❌ WhatsApp client disconnected:", reason);
      // Only attempt reconnection for certain disconnect reasons
      if (reason !== "LOGOUT") {
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
        const messagesToDelete = Array.from(this.processedMessages).slice(
          0,
          500
        );
        messagesToDelete.forEach((id) => this.processedMessages.delete(id));
      }

      // Add unique message ID logging to detect duplicates
      console.log(
        `📨 New message from ${message.from} (ID: ${messageId}): ${message.body}`
      );
      console.log(`🎯 Processing message for userId: ${message.from}`);

      const userId = message.from;
      const messageText = message.body?.toLowerCase() || "";

      // Get user state for onboarding flow
      const userState = await this.mongoService.getUserState(userId);

      // Handle Excel export commands (available for active users)
      if (
        userState === "active" &&
        (messageText.includes("send expense info") ||
          messageText.includes("give excel file") ||
          messageText.includes("give my expense data") ||
          messageText.includes("expnese in excel") ||
          messageText.includes("expnese in sheet") ||
          messageText.includes("excel sheet") ||
          messageText.includes("google sheets") ||
          messageText.includes("monthly spend data") ||
          messageText.includes("full expense data") ||
          messageText.includes("all expense"))
      ) {
        await this.excelService.sendExcelFile(userId, message);
        return;
      }

      // Handle budget updates (available for active users)
      if (userState === "active" && messageText.match(/^budget\s+\d+/i)) {
        await this.handleBudgetUpdate(message.body!, userId, message);
        return;
      }

      // Handle currency updates (available for active users) -> ask for confirmation
      if (userState === "active" && messageText.match(/^currency\s+\w+/i)) {
        await this.handleCurrencyUpdate(message.body!, userId, message);
        return;
      }

      // Handle help command
      if (userState === "active" && messageText === "help") {
        await this.handleHelpCommand(userId, message);
        return;
      }

      // Handle report generation
      if (userState === "active" && messageText === "report") {
        await this.handleReportGeneration(userId, message);
        return;
      }

      // Handle correction commands (available for active users)
      if (userState === "active" && messageText.startsWith("no it will be")) {
        await this.expenseService.handleCorrection(
          message.body!,
          userId,
          message,
          this.mongoService
        );
        return;
      }

      // Handle expense editing by number (e.g., "#001 Edit 400" or "#001 Coffee 400")
      if (
        userState === "active" &&
        messageText.match(/^#\d+\s+(edit\s+\d+|[\w\s]+\s+\d+)/)
      ) {
        await this.expenseService.handleExpenseEdit(
          message.body!,
          userId,
          message,
          this.mongoService
        );
        return;
      }

      // Handle expense deletion by number (e.g., "#001 Delete")
      if (userState === "active" && messageText.match(/^#\d+\s+delete/i)) {
        await this.expenseService.handleExpenseDelete(
          message.body!,
          userId,
          message,
          this.mongoService
        );
        return;
      }

      // Onboarding flow
      if (userState === "new") {
        // Step 1: ask for preferred currency first
        const currentMonthName = new Date().toLocaleString("default", { month: "long" });
        console.log(`📤 Sending currency-first welcome to: ${userId}`);
        await this.client.sendMessage(
          userId,
          `👋 👋 Welcome to the ${currentMonthName} Budget Challenge!\nFirst, tell me your preferred currency.\n👉 Example: AED, USD, INR`
        );
        await this.mongoService.setUserState(userId, "awaiting_currency");
        return;
      }

      if (userState === "awaiting_budget") {
        // Step 3: process numeric monthly budget in user's chosen currency
        const text = (message.body || "").trim();
        const numeric = parseFloat(text);
        if (text && !isNaN(numeric)) {
          const userCurrency = await this.mongoService.getUserCurrency(userId);
          await this.mongoService.setMonthlyBudgetWithCurrency(userId, numeric, userCurrency);
          await this.mongoService.setUserState(userId, "active");

          const currentMonthName = new Date().toLocaleString("default", { month: "long" });
          const currentYear = new Date().getFullYear();
          const dailyLimit = CurrencyService.getDailyLimit(numeric);

          console.log(`📤 Confirmed budget setup for: ${userId}`);
          await this.client.sendMessage(
            userId,
            `Budget set to ${numeric.toFixed(2)} ${userCurrency} for ${currentMonthName} ${currentYear} ✅\n🎯 Your daily limit is ${Math.round(dailyLimit).toString()} ${userCurrency}\n\nNow add your first expense. Example: Grocery 100`
          );
          return;
        } else {
          console.log(`📤 Sending numeric budget validation to: ${userId}`);
          const userCurrency = await this.mongoService.getUserCurrency(userId);
          await this.client.sendMessage(
            userId,
            `Please enter a valid number only.\n👉 Example: If your budget is 2000 ${userCurrency}, type 2000`
          );
          return;
        }
      }

      if (userState === "awaiting_currency") {
        // Step 2: process currency then ask for numeric budget
        const detectedCurrency = CurrencyService.detectCurrency(
          message.body || ""
        );

        if (detectedCurrency) {
          await this.mongoService.setUserCurrency(userId, detectedCurrency);
          await this.mongoService.setUserState(userId, "awaiting_budget");

          console.log(`📤 Asking for budget after currency for: ${userId}`);
          await this.client.sendMessage(
            userId,
            `Great! We’ll use ${detectedCurrency} for your budget.\nYour monthly budget (after fixed costs like rent, bills, loans)?\n👉 Example: If your budget is 2000 ${detectedCurrency}, type 2000`
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

      // Handle currency change confirmation responses
      if (userState === "awaiting_currency_change") {
        const normalized = (message.body || "").trim().toLowerCase();
        if (normalized === "yes" || normalized === "y") {
          const newCurrency = await this.mongoService.confirmCurrencyChange(userId);
          if (newCurrency) {
            console.log(`📤 Confirmed currency change for: ${userId}`);
            await this.client.sendMessage(
              userId,
              `Currency updated to ${newCurrency} ✅\nAll future expenses will be stored in ${newCurrency}.`
            );
          } else {
            await this.client.sendMessage(userId, "No pending currency change found.");
          }
          return;
        } else if (normalized === "no" || normalized === "n") {
          await this.mongoService.clearPendingCurrency(userId);
          console.log(`📤 Cancelled currency change for: ${userId}`);
          await this.client.sendMessage(userId, "Okay, cancelled the currency change.");
          return;
        } else {
          await this.client.sendMessage(userId, "Please reply with Yes to confirm or No to cancel the currency change.");
          return;
        }
      }

      // Handle OCR confirmation responses
      if (userState === "awaiting_ocr_confirmation") {
        const handled = await this.expenseService.handleOCRConfirmation(
          message.body || "",
          userId,
          message,
          this.mongoService
        );

        if (!handled) {
          console.log(`📤 Sending OCR confirmation help to: ${userId}`);
          await this.client.sendMessage(
            userId,
            "Please reply with *Yes* to save the expense or *No* to cancel."
          );
        }
        return;
      }

      // Active user - handle expenses
      if (userState === "active") {
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
              `Didn’t get that. Try: Grocery 100.\nWant quick commands? Reply: Help`
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

  private async handleBudgetUpdate(
    messageBody: string,
    userId: string,
    message: Message
  ): Promise<void> {
    try {
      const budgetMatch = messageBody.match(/budget\s+(\d+(?:\.\d+)?)/i);
      if (budgetMatch) {
        const newBudget = parseFloat(budgetMatch[1]!);
        const userCurrency = await this.mongoService.getUserCurrency(userId);

        await this.mongoService.setMonthlyBudgetWithCurrency(
          userId,
          newBudget,
          userCurrency
        );

        const currentMonth = new Date().toLocaleString("default", {
          month: "long",
        });
        const currentYear = new Date().getFullYear();
        const dailyLimit = CurrencyService.getDailyLimit(newBudget);

        console.log(`📤 Sending budget update confirmation to: ${userId}`);
        await this.client.sendMessage(
          userId,
          `Budget set to ${newBudget.toFixed(
            2
          )} ${userCurrency} for ${currentMonth} ${currentYear} ✅\n🎯 Your daily limit is ${dailyLimit.toFixed(
            0
          )} ${userCurrency}`
        );
      }
    } catch (error) {
      console.error("❌ Error updating budget:", error);
      await this.client.sendMessage(
        userId,
        "Sorry, there was an error updating your budget."
      );
    }
  }

  private async handleCurrencyUpdate(
    messageBody: string,
    userId: string,
    message: Message
  ): Promise<void> {
    try {
      const currencyMatch = messageBody.match(/currency\s+(\w+)/i);
      if (currencyMatch) {
        const requested = currencyMatch[1]!;
        const detectedCurrency = CurrencyService.detectCurrency(requested);

        if (detectedCurrency) {
          const currentCurrency = await this.mongoService.getUserCurrency(userId);
          await this.mongoService.setPendingCurrency(userId, detectedCurrency);

          console.log(`📤 Asking currency change confirmation to: ${userId}`);
          await this.client.sendMessage(
            userId,
            `You're asking to change currency from ${currentCurrency} to ${detectedCurrency}.\nReply with *Yes* to confirm or *No* to cancel.`
          );
        } else {
          await this.client.sendMessage(
            userId,
            "❌ Invalid currency. Examples: USD, EUR, INR, BDT, Taka, Rupee, Dollar"
          );
        }
      }
    } catch (error) {
      console.error("❌ Error updating currency:", error);
      await this.client.sendMessage(
        userId,
        "Sorry, there was an error updating your currency."
      );
    }
  }

  private async handleHelpCommand(
    userId: string,
    message: Message
  ): Promise<void> {
    try {
      const helpMessage = `*Quick Commands:*\n\n📝 *Add:* Grocery 100\n✏️ *Edit:* #001 Edit 80\n🗑️ *Delete:* #001 Delete\n💰 *Budget:* Budget 30000\n💱 *Currency:* Currency BDT\n📊 *Report:* Report (Excel file)\n📷 *Scan:* Send a receipt photo (optional caption like Food)\n🙋 *Help:* Help`;

      console.log(`📤 Sending help message to: ${userId}`);
      await this.client.sendMessage(userId, helpMessage);
    } catch (error) {
      console.error("❌ Error sending help:", error);
      await this.client.sendMessage(
        userId,
        "Sorry, there was an error displaying help."
      );
    }
  }

  private async handleReportGeneration(
    userId: string,
    message: Message
  ): Promise<void> {
    try {
      const currentMonth = new Date().toLocaleString("default", {
        month: "long",
      });
      const currentYear = new Date().getFullYear();

      console.log(`📤 Sending report generation message to: ${userId}`);
      await this.client.sendMessage(
        userId,
        `Generating your report for ${currentMonth} ${currentYear} 📊...`
      );

      // Generate and send the Excel report
      await this.excelService.sendExcelFile(userId, message);

      await this.client.sendMessage(
        userId,
        "Here's your monthly expense report in Excel."
      );
    } catch (error) {
      console.error("❌ Error generating report:", error);
      await this.client.sendMessage(
        userId,
        "Sorry, there was an error generating your report."
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

import { Client, Message, MessageMedia } from "../types/wa";
import Groq from "groq-sdk";
import type {
  ExpenseData,
  GroqExpenseResponse,
  IntentResult,
} from "../types/types";
import { Expense } from "../models/ExpenseModel";
import { CurrencyService } from "./CurrencyService";
import { CloudinaryService } from "./CloudinaryService";
import { MongoService } from "./MongoService";

export class ExpenseService {
  private groq: Groq;
  private client: Client;
  private cloudinaryService: CloudinaryService | null = null;

  constructor(client: Client) {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    this.client = client;
    try {
      this.cloudinaryService = new CloudinaryService();
    } catch (e) {
      console.warn("Cloudinary not configured. Skipping Cloudinary uploads:", (e as any)?.message || e);
      this.cloudinaryService = null;
    }
  }

  // Finalize a pending image expense after user replies with amount or full text
  public async finalizePendingImageExpense(
    userText: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    const userId = originalMessage.from;
    const pending = await mongoService.getPendingExpense(userId);
    if (!pending) {
      await this.client.sendMessage(userId, 'No pending image expense found. Please send a receipt photo again.');
      return;
    }

    const trimmed = (userText || '').trim();
    let data = await this.extractExpenseData(trimmed);

    if (!data) {
      // Maybe user sent only a number -> combine with pending item
      const onlyNumber = trimmed.match(/^(\d+(?:[\.,]\d+)?)$/);
      if (onlyNumber) {
        const price = parseFloat(onlyNumber[1]!.replace(',', '.'));
        const date = new Date().toISOString().slice(0, 10);
        const userCurrency = await mongoService.getUserCurrency(userId);
        data = { item: pending.item || 'Item', price, currency: userCurrency, date };
      }
    }

    if (!data) {
      await this.client.sendMessage(userId, 'Please send a valid amount (number only), e.g., 120');
      return;
    }

    // Use user's currency and attach image metadata from pending
    const userCurrency = await mongoService.getUserCurrency(userId);
    data.currency = userCurrency;
    data.price = Math.round(data.price * 100) / 100;
    if (pending.imageUrl) data.imageUrl = pending.imageUrl;
    if (pending.imageProvider) data.imageProvider = pending.imageProvider;
    if (pending.imageRef) data.imageRef = pending.imageRef;

    const created = await this.addToMongo(data, userId, mongoService);
    const monthlyTotal = await mongoService.calculateMonthlyTotal(userId, data.date);
    const budget = await mongoService.getMonthlyBudget(userId);
    const remaining = budget - monthlyTotal.totalAmount;
    const todaySpending = await CurrencyService.getTodaysSpending(userId);
    const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

    // Build reply (treat as image expense)
    const replyMessage = this.buildImageExpenseReply(
      created.number,
      data.item,
      data.currency,
      data.price,
      data.date,
      monthlyTotal.month,
      monthlyTotal.year,
      monthlyTotal.currency,
      monthlyTotal.totalAmount,
      monthlyTotal.expenseCount,
      budget,
      remaining,
      dailyLimit,
      todaySpending,
      false
    );

    await this.client.sendMessage(userId, replyMessage);
    await mongoService.clearPendingExpense(userId);
  }

  // Parse a free-form text like "Coffee 120 bdt" into an ExpenseData.
  // Heuristic: the last number in the text is the price; the leading words form the item name.
  // Currency is detected via CurrencyService or defaults to 'USD'. Date defaults to today (YYYY-MM-DD).
  private async extractExpenseData(text: string): Promise<ExpenseData | null> {
    const normalized = (text || '').trim();
    if (!normalized) return null;

    const numMatch = normalized.match(/(\d+(?:[\.,]\d+)?)(?!.*\d)/); // last number
    if (!numMatch) return null;

    const rawPrice = numMatch[1]!.replace(',', '.');
    const price = parseFloat(rawPrice);
    if (isNaN(price)) return null;

    const before = normalized.slice(0, numMatch.index).trim();
    const after = normalized.slice((numMatch.index || 0) + numMatch[0]!.length).trim();
    let item = before || after || 'Item';
    // collapse extra spaces
    item = item.replace(/\s{2,}/g, ' ').trim();

    // Detect currency tokens within the whole text
    const detected = CurrencyService.detectCurrency(normalized);
    const currency: string = detected ?? 'USD';

    const date = new Date().toISOString().slice(0, 10);

    return { item, price, currency, date };
  }

  // Persist expense to Mongo and return the created expense document
  private async addToMongo(expense: ExpenseData, userId: string, mongoService: MongoService) {
    const number = await mongoService.getNextExpenseNumber(userId);
    const created = await Expense.create({
      userId,
      item: expense.item,
      price: expense.price,
      currency: expense.currency,
      date: expense.date,
      number,
      imageUrl: expense.imageUrl,
      imageProvider: expense.imageProvider,
      imageRef: expense.imageRef,
    });
    return created;
  }

  // Extract expense from image. Placeholder implementation returning low confidence.
  // In future, integrate OCR and LLM extraction.
  private async extractExpenseWithConfidence(imageDataUrl: string, caption: string): Promise<{ confidence: number; expense: ExpenseData | null; }> {
    // If caption looks parseable, try that with a medium confidence
    const parsedFromCaption = await this.extractExpenseData(caption || '');
    if (parsedFromCaption) {
      return { confidence: 0.6, expense: parsedFromCaption };
    }
    return { confidence: 0.0, expense: null };
  }

  // Ask user to confirm OCR-parsed expense. Stores pending expense and sets state to awaiting_ocr_confirmation.
  private async handleUncertainOCR(expense: ExpenseData, originalMessage: Message, mongoService: MongoService, userCurrency: string): Promise<void> {
    // Normalize currency to the user's current currency for confirmation preview
    const pending = { ...expense, currency: userCurrency };
    await mongoService.storePendingExpense(originalMessage.from, pending);

    const preview = `*${pending.item}* — ${this.money(pending.price)} ${pending.currency}`;
    const dateStr = pending.date;
    const msg = `🧐 I found this from your photo:
${preview}
_${dateStr}_

Save it? Reply with YES or NO.`;
    await this.client.sendMessage(originalMessage.from, msg);
  }

  // Ask user to resend clearer photo or enter manually
  private async handleFailedOCR(originalMessage: Message): Promise<void> {
    const msg = `❌ Couldn't read the receipt.
Please send a clearer photo, add a caption like _Food_, or type manually like: Coffee 120`;
    await this.client.sendMessage(originalMessage.from, msg);
  }

  public async processExpenseMessage(
    messageText: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      const expenseData = await this.extractExpenseData(messageText);

      if (expenseData) {
        // Use user's saved currency instead of detected currency
        const userCurrency = await mongoService.getUserCurrency(originalMessage.from);
        expenseData.currency = userCurrency;

        // round to 2 decimals
        expenseData.price = Math.round(expenseData.price * 100) / 100;
        const created = await this.addToMongo(
          expenseData,
          originalMessage.from,
          mongoService
        );
        const monthlyTotal = await mongoService.calculateMonthlyTotal(
          originalMessage.from,
          expenseData.date
        );
        const budget = await mongoService.getMonthlyBudget(
          originalMessage.from
        );
        const remaining = budget - monthlyTotal.totalAmount;

        const todaySpending = await CurrencyService.getTodaysSpending(originalMessage.from);
        const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

        const replyMessage = this.buildAddedReply(
          created.number,
          expenseData.item,
          expenseData.currency,
          expenseData.price,
          expenseData.date,
          monthlyTotal.month,
          monthlyTotal.year,
          monthlyTotal.currency,
          monthlyTotal.totalAmount,
          monthlyTotal.expenseCount,
          budget,
          remaining,
          dailyLimit,
          todaySpending
        );

        console.log(`📤 Sending expense reply to: ${originalMessage.from}`);
        await this.client.sendMessage(originalMessage.from, replyMessage);
      } else {
        await this.client.sendMessage(
          originalMessage.from,
          '❌ Could not extract expense information. Please use format like "Potato 10 usd" or "Coffee $5.50"'
        );
      }
    } catch (error) {
      console.error("❌ Error processing expense message:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error processing your expense. Please try again."
      );
      throw error;
    }
  }

  public async processImageMessage(
    media: MessageMedia,
    caption: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      const imageDataUrl = `data:${media.mimetype};base64,${media.data}`;
      // Prepare upload to Cloudinary
      let uploadedImageUrl: string | undefined;
      let uploadedImageRef: string | undefined;
      let uploadedProvider: 'cloudinary' | undefined;
      try {
        const buffer = Buffer.from(media.data, 'base64');
        const ts = new Date();
        const yyyy = ts.getFullYear();
        const mm = String(ts.getMonth() + 1).padStart(2, '0');
        const dd = String(ts.getDate()).padStart(2, '0');
        const hh = String(ts.getHours()).padStart(2, '0');
        const mi = String(ts.getMinutes()).padStart(2, '0');
        const ss = String(ts.getSeconds()).padStart(2, '0');
        const safeCaption = (caption || '').trim().replace(/[^a-z0-9-_]+/gi, '_').slice(0, 40);
        const baseName = safeCaption || 'expense';
        const ext = media.mimetype?.split('/')?.[1] || 'jpg';
        const filename = `${yyyy}${mm}${dd}_${hh}${mi}${ss}_${baseName}.${ext}`;

        if (this.cloudinaryService) {
          const uploaded = await this.cloudinaryService.uploadImage({
            buffer,
            mimetype: media.mimetype || 'image/jpeg',
            filename,
            userId: originalMessage.from,
            date: ts,
          });
          uploadedImageUrl = uploaded.secureUrl;
          uploadedImageRef = uploaded.publicId;
          uploadedProvider = 'cloudinary';
        }
      } catch (e) {
        console.error('❌ Image upload failed (continuing without URL):', e);
      }
      const userCurrency = await mongoService.getUserCurrency(originalMessage.from);

      let finalExpense: ExpenseData | null = null;
      let isFromCaption = false;
      // Heuristic: treat short, numberless captions as a user-provided item name hint
      const captionNameHint = caption && caption.trim() && !/\d/.test(caption)
        ? caption.trim().substring(0, 50)
        : '';

      // Case A: Image + Caption - prioritize caption
      if (caption.trim()) {
        finalExpense = await this.extractExpenseData(caption);
        if (finalExpense) {
          console.log("✅ Using caption-based expense data:", finalExpense);
          isFromCaption = true;
        }
      }

      // Case B, C, D: Image processing with confidence levels
      if (!finalExpense) {
        const ocrResult = await this.extractExpenseWithConfidence(imageDataUrl, caption);

        if (ocrResult.confidence >= 0.85) {
          // Case B: High confidence - direct save
          finalExpense = ocrResult.expense;
          // If user caption looked like a name (no numbers), override item with it
          if (finalExpense && captionNameHint) {
            finalExpense.item = captionNameHint;
          }
          console.log("✅ High confidence OCR result:", finalExpense);
        } else if (ocrResult.confidence >= 0.5) {
          // Case C: Medium confidence - ask for confirmation
          // If we have a name hint from caption, carry it into the confirmation step
          if (ocrResult.expense && captionNameHint) {
            ocrResult.expense.item = captionNameHint;
          }
          await this.handleUncertainOCR(ocrResult.expense!, originalMessage, mongoService, userCurrency);
          return;
        } else {
          // Case D: Low confidence
          if (captionNameHint) {
            // Fallback: store a pending draft with the image and item hint; ask user for the amount
            const today = new Date().toISOString().slice(0, 10);
            const draft: ExpenseData = {
              item: captionNameHint,
              price: 0,
              currency: userCurrency,
              date: today,
            };
            if (uploadedImageUrl) draft.imageUrl = uploadedImageUrl;
            if (uploadedProvider) draft.imageProvider = uploadedProvider;
            if (uploadedImageRef) draft.imageRef = uploadedImageRef;
            await mongoService.storePendingImageExpenseDraft(originalMessage.from, draft);
            await this.client.sendMessage(
              originalMessage.from,
              `Couldn't read the amount from the photo.\nReply with the amount for *${captionNameHint}* (number only), e.g., 120\nOr send full: ${captionNameHint} 120`
            );
            return;
          } else {
            // Ask for a clearer photo or manual entry
            await this.handleFailedOCR(originalMessage);
            return;
          }
        }
      }

      if (finalExpense) {
        // Use user's saved currency
        finalExpense.currency = userCurrency;
        finalExpense.price = Math.round(finalExpense.price * 100) / 100;
        if (uploadedImageUrl) {
          finalExpense.imageUrl = uploadedImageUrl;
          if (uploadedProvider) finalExpense.imageProvider = uploadedProvider;
          if (uploadedImageRef) finalExpense.imageRef = uploadedImageRef;
        }

        const created = await this.addToMongo(
          finalExpense,
          originalMessage.from,
          mongoService
        );
        const monthlyTotal = await mongoService.calculateMonthlyTotal(
          originalMessage.from,
          finalExpense.date
        );
        const budget = await mongoService.getMonthlyBudget(originalMessage.from);
        const remaining = budget - monthlyTotal.totalAmount;

        const todaySpending = await CurrencyService.getTodaysSpending(originalMessage.from);
        const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

        const replyMessage = this.buildImageExpenseReply(
          created.number,
          finalExpense.item,
          finalExpense.currency,
          finalExpense.price,
          finalExpense.date,
          monthlyTotal.month,
          monthlyTotal.year,
          monthlyTotal.currency,
          monthlyTotal.totalAmount,
          monthlyTotal.expenseCount,
          budget,
          remaining,
          dailyLimit,
          todaySpending,
          isFromCaption
        );

        console.log(`📤 Sending image expense reply to: ${originalMessage.from}`);
        await this.client.sendMessage(originalMessage.from, replyMessage);
      }
    } catch (error) {
      console.error("❌ Error processing image message:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error processing your image. Please try again."
      );
      throw error;
    }
  }

  public async handleCorrection(
    messageBody: string,
    userId: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      // Extract the correction from "no it will be [correction]" format
      const correctionMatch: any = messageBody.match(/no it will be (.+)/i);
      if (!correctionMatch) {
        // await originalMessage.reply(
        //   "❌ Invalid correction format. Please use: 'no it will be [correct expense]'"
        // );
        return;
      }

      const correctionText = correctionMatch[1].trim();

      // Parse the correction using the same expense extraction logic
      const correctedExpenseData = await this.extractExpenseData(
        correctionText
      );

      if (!correctedExpenseData) {
        await this.client.sendMessage(
          originalMessage.from,
          "❌ Could not parse the correction. Please use format like 'no it will be Coffee 15'"
        );
        return;
      }

      // Use user's saved currency for correction
      const userCurrency = await mongoService.getUserCurrency(userId);
      correctedExpenseData.currency = userCurrency;

      // Get the most recent expense for this user
      const lastExpense = await Expense.findOne({ userId }).sort({
        createdAt: -1,
      });

      if (!lastExpense) {
        await this.client.sendMessage(
          originalMessage.from,
          "❌ No recent expense found to correct."
        );
        return;
      }

      // Update the last expense with corrected data
      correctedExpenseData.price = Math.round(correctedExpenseData.price * 100) / 100;
      await Expense.findByIdAndUpdate(lastExpense._id, {
        item: correctedExpenseData.item,
        price: correctedExpenseData.price,
        currency: correctedExpenseData.currency,
        date: correctedExpenseData.date,
      });

      // Calculate updated monthly totals
      const monthlyTotal = await mongoService.calculateMonthlyTotal(
        userId,
        correctedExpenseData.date
      );
      const budget = await mongoService.getMonthlyBudget(userId);
      const remaining = budget - monthlyTotal.totalAmount;

      const todaySpending = await CurrencyService.getTodaysSpending(userId);
      const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

      const replyMessage = this.buildUpdatedReply(
        typeof lastExpense.number === "number" ? lastExpense.number : 0,
        correctedExpenseData.item,
        correctedExpenseData.currency,
        correctedExpenseData.price,
        correctedExpenseData.date,
        monthlyTotal.month,
        monthlyTotal.year,
        monthlyTotal.currency,
        monthlyTotal.totalAmount,
        monthlyTotal.expenseCount,
        budget,
        remaining,
        dailyLimit,
        todaySpending
      );

      console.log(`📤 Sending correction reply to: ${originalMessage.from}`);
      await this.client.sendMessage(originalMessage.from, replyMessage);
    } catch (error) {
      console.error("❌ Error handling correction:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error processing your correction. Please try again."
      );
      throw error;
    }
  }

  private padNumber(num: number): string {
    if (!num || num < 0) return "";
    if (num < 1000) return String(num).padStart(3, "0");
    return String(num);
  }

  private money(amount: number): string {
    return (Math.round(amount * 100) / 100).toFixed(2);
  }

  private buildAddedReply(
    number: number,
    item: string,
    currency: string,
    price: number,
    date: string,
    month: string,
    year: number,
    totalCurrency: string,
    totalAmount: number,
    expenseCount: number,
    budget: number,
    remaining: number,
    dailyLimit: number | null,
    todaySpending: number | null
  ): string {
    let reply = `*#${this.padNumber(number)}* • *${item}* — ${this.money(price)} ${currency} ✅\n`;
    reply += `_${date}_\n`;
    reply += `• Spent (${month} ${year}): *${this.money(totalAmount)}* / *${this.money(budget)}* ${currency}\n`;
    reply += `• Remaining: *${this.money(remaining)}* ${currency}\n`;
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 *Daily limit*: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ *You're on track*. Keep it up!`;
      } else {
        reply += `⚠️ *Above daily limit*. Try to save tomorrow.`;
      }
    }

    // Add tip for first expense
    if (number === 1) {
      reply += `\n\n💡 _Tip_: You can also scan expenses from images. Send a receipt photo. Optional: add a caption like _Food_.`;
    }

    return reply;
  }

  private buildUpdatedReply(
    number: number,
    item: string,
    currency: string,
    price: number,
    date: string,
    month: string,
    year: number,
    totalCurrency: string,
    totalAmount: number,
    expenseCount: number,
    budget: number,
    remaining: number,
    dailyLimit: number | null,
    todaySpending: number | null
  ): string {
    let reply = `*#${this.padNumber(number)}* • *${item}* — ${this.money(price)} ${currency} ✅ _(Updated)_\n`;
    reply += `_${date}_\n`;
    reply += `• Spent (${month} ${year}): *${this.money(totalAmount)}* / *${this.money(budget)}* ${currency}\n`;
    reply += `• Remaining: *${this.money(remaining)}* ${currency}\n`;
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 *Daily limit*: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ *You're on track*. Keep it up!`;
      } else {
        reply += `⚠️ *Above daily limit*. Try to save tomorrow.`;
      }
    }

    return reply;
  }

  private buildImageExpenseReply(
    number: number,
    item: string,
    currency: string,
    price: number,
    date: string,
    month: string,
    year: number,
    totalCurrency: string,
    totalAmount: number,
    expenseCount: number,
    budget: number,
    remaining: number,
    dailyLimit: number | null,
    todaySpending: number | null,
    isFromCaption: boolean,
    shortLink?: string
  ): string {
    let reply = `*#${this.padNumber(number)}* • *${item}* — ${this.money(price)} ${currency} 📷 ✅\n`;
    reply += `_${date}_\n`;
    reply += `• Spent (${month} ${year}): *${this.money(totalAmount)}* / *${this.money(budget)}* ${currency}\n`;
    reply += `• Remaining: *${this.money(remaining)}* ${currency}\n`;
    if (shortLink) {
      reply += `🔗 View Image: ${shortLink}\n`;
    }
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 *Daily limit*: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ *You're on track*. Keep it up!`;
      } else {
        reply += `⚠️ *Above daily limit*. Try to save tomorrow.`;
      }
    }

    // Add tip for first expense
    if (number === 1) {
      reply += `\n\n💡 _Tip_: You can also scan expenses from images. Send a receipt photo. Optional: add a caption like _Food_.`;
    }

    return reply;
  }

  public async handleOCRConfirmation(
    response: string,
    userId: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<boolean> {
    try {
      const normalizedResponse = response.toLowerCase().trim();

      if (normalizedResponse === 'yes' || normalizedResponse === 'y') {
        // Get pending expense and save it
        const pendingExpense = await mongoService.getPendingExpense(userId);
        if (pendingExpense) {
          const userCurrency = await mongoService.getUserCurrency(userId);
          pendingExpense.currency = userCurrency;

          const created = await this.addToMongo(pendingExpense, userId, mongoService);
          const safeDate = pendingExpense.date || new Date().toISOString().split("T")[0];
          const monthlyTotal = await mongoService.calculateMonthlyTotal(userId, safeDate);
          const budget = await mongoService.getMonthlyBudget(userId);
          const remaining = budget - monthlyTotal.totalAmount;
          const todaySpending = await CurrencyService.getTodaysSpending(userId);
          const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

          const replyMessage = this.buildImageExpenseReply(
            created.number,
            pendingExpense.item,
            pendingExpense.currency,
            pendingExpense.price,
            safeDate,
            monthlyTotal.month,
            monthlyTotal.year,
            monthlyTotal.currency,
            monthlyTotal.totalAmount,
            monthlyTotal.expenseCount,
            budget,
            remaining,
            dailyLimit,
            todaySpending,
            false
          );

          await this.client.sendMessage(originalMessage.from, replyMessage);
          await mongoService.clearPendingExpense(userId);
          return true;
        }
      } else if (normalizedResponse === 'no' || normalizedResponse === 'n') {
        await this.client.sendMessage(
          originalMessage.from,
          "Please retake the photo clearly, or send manually like: Food 1180"
        );
        await mongoService.clearPendingExpense(userId);
        return true;
      }

      return false;
    } catch (error) {
      console.error("❌ Error handling OCR confirmation:", error);
      return false;
    }
  }

  // Method to handle expense editing by number
  public async handleExpenseEdit(
    messageBody: string,
    userId: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      // Parse the edit command: "#001 Edit 400" or "#001 Coffee 400"
      const editMatch = messageBody.match(/^#(\d+)\s+(.*)/i);
      if (!editMatch) {
        await this.client.sendMessage(
          originalMessage.from,
          "❌ Invalid edit format. Use: #001 Edit 400 or #001 Coffee 400"
        );
        return;
      }

      const expenseNumber = parseInt(editMatch[1]!);
      const editContent = editMatch[2]!.trim();

      // Find the expense by number and user
      const existingExpense = await Expense.findOne({
        userId,
        number: expenseNumber
      });

      if (!existingExpense) {
        await this.client.sendMessage(
          originalMessage.from,
          `❌ Expense #${this.padNumber(expenseNumber)} not found.`
        );
        return;
      }

      let newItem = existingExpense.item;
      let newPrice = existingExpense.price;

      // Check if it's a simple price edit (e.g., "Edit 400")
      if (editContent.toLowerCase().startsWith('edit ')) {
        const priceMatch = editContent.match(/edit\s+(\d+(?:\.\d+)?)/i);
        if (priceMatch) {
          newPrice = parseFloat(priceMatch[1]!);
        } else {
          await this.client.sendMessage(
            originalMessage.from,
            "❌ Invalid edit format. Use: #001 Edit 400"
          );
          return;
        }
      } else {
        // Full expense edit (e.g., "Coffee 400")
        const expenseData = await this.extractExpenseData(editContent);
        if (expenseData) {
          newItem = expenseData.item;
          newPrice = expenseData.price;
        } else {
          await this.client.sendMessage(
            originalMessage.from,
            "❌ Could not parse the edit. Use format like: #001 Coffee 400"
          );
          return;
        }
      }

      // Use user's saved currency
      const userCurrency = await mongoService.getUserCurrency(userId);
      newPrice = Math.round(newPrice * 100) / 100;

      // Update the expense
      await Expense.findByIdAndUpdate(existingExpense._id, {
        item: newItem,
        price: newPrice,
        currency: userCurrency,
      });

      // Calculate updated totals and send detailed confirmation with dynamic daily limit
      const todayStrForEdit = new Date().toISOString().slice(0, 10);
      const monthlyTotal = await mongoService.calculateMonthlyTotal(userId, todayStrForEdit);
      const budget = await mongoService.getMonthlyBudget(userId);
      const remaining = budget - monthlyTotal.totalAmount;
      const todaySpending = await CurrencyService.getTodaysSpending(userId);
      const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;

      const replyMessage = this.buildUpdatedReply(
        expenseNumber,
        newItem,
        userCurrency,
        newPrice,
        todayStrForEdit,
        monthlyTotal.month,
        monthlyTotal.year,
        monthlyTotal.currency,
        monthlyTotal.totalAmount,
        monthlyTotal.expenseCount,
        budget,
        remaining,
        dailyLimit,
        todaySpending
      );

      console.log(`📤 Sending expense edit confirmation to: ${originalMessage.from}`);
      await this.client.sendMessage(originalMessage.from, replyMessage);

    } catch (error) {
      console.error("❌ Error handling expense edit:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error editing your expense. Please try again."
      );
      throw error;
    }
  }

  // Method to handle expense deletion by number
  public async handleExpenseDelete(
    messageBody: string,
    userId: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      // Parse the delete command: "#001 Delete"
      const deleteMatch = messageBody.match(/^#(\d+)\s+delete/i);
      if (!deleteMatch) {
        await this.client.sendMessage(
          originalMessage.from,
          "❌ Invalid delete format. Use: #001 Delete"
        );
        return;
      }

      const expenseNumber = parseInt(deleteMatch[1]!);

      // Find the expense by number and user
      const existingExpense = await Expense.findOne({
        userId,
        number: expenseNumber
      });

      if (!existingExpense) {
        await this.client.sendMessage(
          originalMessage.from,
          `❌ Expense #${this.padNumber(expenseNumber)} not found.`
        );
        return;
      }

      // Delete the expense
      await Expense.findByIdAndDelete(existingExpense._id);

      // Calculate updated monthly totals after deletion
      const monthlyTotal = await mongoService.calculateMonthlyTotal(
        userId,
        existingExpense.date
      );
      const budget = await mongoService.getMonthlyBudget(userId);
      const userCurrency = await mongoService.getUserCurrency(userId);
      const remaining = budget - monthlyTotal.totalAmount;

      // Dynamic daily limit and today's spending
      const dailyLimit = budget > 0 ? CurrencyService.calculateDynamicDailyLimit(remaining) : null;
      const todaySpending = await CurrencyService.getTodaysSpending(userId);

      // Build and send confirmation message
      let replyMessage = `Deleted ❌\n#${this.padNumber(expenseNumber)} ${existingExpense.item}: ${this.money(existingExpense.price)} ${userCurrency}\n`;
      replyMessage += `${monthlyTotal.month} ${monthlyTotal.year} → Spent: ${this.money(monthlyTotal.totalAmount)} / ${this.money(budget)} ${userCurrency}\n`;
      replyMessage += `Remaining: ${this.money(remaining)} ${userCurrency}\n`;
      if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
        replyMessage += `🎯 Daily limit: ${this.money(dailyLimit)} ${userCurrency}\n`;
        if (todaySpending <= dailyLimit) {
          replyMessage += `✅ You're on track. Good job!`;
        } else {
          replyMessage += `⚠️ You're above your daily limit. Try to save tomorrow.`;
        }
      }

      console.log(`📤 Sending expense delete confirmation to: ${originalMessage.from}`);
      await this.client.sendMessage(originalMessage.from, replyMessage);

    } catch (error) {
      console.error("❌ Error handling expense delete:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error deleting your expense. Please try again."
      );
      throw error;
    }
  }
}

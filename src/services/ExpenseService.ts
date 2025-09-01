import { Client, Message, MessageMedia } from "../types/wa";
import Groq from "groq-sdk";
import type {
  ExpenseData,
  GroqExpenseResponse,
  IntentResult,
} from "../types/types";
import { Expense } from "../models/ExpenseModel";
import { CurrencyService } from "./CurrencyService";
import { MongoService } from "./MongoService";

export class ExpenseService {
  private groq: Groq;
  private client: Client;

  constructor(client: Client) {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
    this.client = client;
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
      const userCurrency = await mongoService.getUserCurrency(originalMessage.from);

      let finalExpense: ExpenseData | null = null;
      let isFromCaption = false;

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
          console.log("✅ High confidence OCR result:", finalExpense);
        } else if (ocrResult.confidence >= 0.5) {
          // Case C: Medium confidence - ask for confirmation
          await this.handleUncertainOCR(ocrResult.expense!, originalMessage, mongoService, userCurrency);
          return;
        } else {
          // Case D: Low confidence - ask for manual entry
          await this.handleFailedOCR(originalMessage);
          return;
        }
      }

      if (finalExpense) {
        // Use user's saved currency
        finalExpense.currency = userCurrency;
        finalExpense.price = Math.round(finalExpense.price * 100) / 100;

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
    let reply = `#${this.padNumber(number)} ${item}: ${this.money(price)} ${currency} ✅\n`;
    reply += `${month} ${year} → Spent: ${this.money(totalAmount)} / ${this.money(budget)} ${currency}\n`;
    reply += `Remaining: ${this.money(remaining)} ${currency}\n`;
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 Daily limit: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ You're on track. Good job!`;
      } else {
        reply += `⚠️ You're above your daily limit. Try to save tomorrow.`;
      }
    }

    // Add tip for first expense
    if (number === 1) {
      reply += `\n\nTip 💡 You can also scan expenses from images. Just send a photo of a receipt, bill, or ticket. Optional: add a caption like "Food" to label it.`;
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
    let reply = `#${this.padNumber(number)} ${item}: ${this.money(price)} ${currency} ✅ (Updated)\n`;
    reply += `${month} ${year} → Spent: ${this.money(totalAmount)} / ${this.money(budget)} ${currency}\n`;
    reply += `Remaining: ${this.money(remaining)} ${currency}\n`;
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 Daily limit: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ You're on track. Good job!`;
      } else {
        reply += `⚠️ You're above your daily limit. Try to save tomorrow.`;
      }
    }

    return reply;
  }

  private async extractTextFromImage(imageUrl: string): Promise<string> {
    try {
      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are an accurate OCR tool. Transcribe all text visible in the image exactly as it appears, including prices and totals. Preserve formatting where possible.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract and transcribe all text from this image:",
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.1,
        max_tokens: 500,
      });

      return completion.choices[0]?.message?.content || "";
    } catch (error) {
      console.error("❌ Error extracting text from image:", error);
      return "";
    }
  }

  private async verifyExtractedText(
    imageUrl: string,
    extractedText: string
  ): Promise<boolean> {
    try {
      const prompt = `Verify if the provided extracted text accurately matches the text in the image. Be strict: check for completeness, accuracy, and no hallucinations.
Extracted text: "${extractedText.replace(/"/g, '\\"')}"

Return ONLY valid JSON: {"is_good": true} or {"is_good": false}`;

      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a verification tool. Return only valid JSON, no explanations.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0,
        max_tokens: 100,
      });

      const response = completion.choices[0]?.message?.content?.trim();
      if (!response) {
        console.error("❌ No response from Groq for text verification");
        return false;
      }

      const cleanedResponse = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleanedResponse);
      return parsed.is_good === true;
    } catch (error) {
      console.error("❌ Error verifying extracted text:", error);
      return false;
    }
  }

  private async directExtractExpenseFromImage(
    imageUrl: string,
    caption: string
  ): Promise<ExpenseData | null> {
    try {
      const prompt = `You are an expense extractor from receipt images. Analyze the image to extract expense info.
IMPORTANT:
- If a total price, subtotal, or full amount is present, use THAT as the price, ignore individual items.
- Item: A summary description like "Groceries", "Dinner", or based on receipt content.
- Use caption for context if provided: "${caption.replace(/"/g, '\\"')}"
- Detect currency, default USD.

Return ONLY valid JSON, no explanations: {"item": "name", "price": number, "currency": "USD"}
If invalid or unclear: {"error": "invalid"}`;

      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "Return only valid JSON objects, never code blocks or explanations.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.1,
        max_tokens: 200,
      });

      const response = completion.choices[0]?.message?.content?.trim();
      if (!response) {
        console.error("❌ No response from Groq for direct expense extraction");
        return null;
      }

      console.log("🤖 Groq direct extract response:", response);
      const cleanedResponse = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleanedResponse) as GroqExpenseResponse;

      if (parsed.error || !parsed.item || !parsed.price) {
        return null;
      }

      return {
        item: parsed.item,
        price: parsed.price,
        currency: parsed.currency || "USD",
        date: new Date().toISOString().split("T")[0] || "",
      };
    } catch (error) {
      console.error("❌ Error direct extracting expense from image:", error);
      return null;
    }
  }

  public async extractExpenseData(text: string): Promise<ExpenseData | null> {
    try {
      const prompt = `You are a JSON parser. Extract expense information from: "${text}"

IMPORTANT: Return ONLY valid JSON, no code blocks, no explanations, no markdown.
- Item names can be multiple words (e.g., "Gari Bhara", "Ice Cream", "Bus Fare")
- The price is usually the last number in the text
- If text mentions total or full amount, prioritize that.

Format: {"item": "name", "price": number, "currency": "USD"}
If invalid: {"error": "invalid"}

Examples:
"Coffee 10 dollar" -> {"item": "Coffee", "price": 10.00, "currency": "USD"}
"Gari Bhara 500" -> {"item": "Gari Bhara", "price": 500.00, "currency": "USD"}
"Ice cream cone 25 taka" -> {"item": "Ice cream cone", "price": 25.00, "currency": "BDT"}
"Bus fare to dhaka 150" -> {"item": "Bus fare to dhaka", "price": 150.00, "currency": "USD"}`;

      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content:
              "You are a JSON parser. Return only valid JSON objects, never code blocks or explanations. Item names can be multiple words.",
          },
          { role: "user", content: prompt },
        ],
        model: "llama-3.1-8b-instant",
        temperature: 0,
        max_tokens: 150,
      });

      const response = completion.choices[0]?.message?.content?.trim();
      if (!response) {
        console.error("❌ No response from Groq for expense extraction");
        return null;
      }

      console.log("🤖 Groq response:", response);
      const cleanedResponse = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleanedResponse) as GroqExpenseResponse;

      if (parsed.error || !parsed.item || !parsed.price) {
        return null;
      }

      return {
        item: parsed.item,
        price: parsed.price,
        currency: parsed.currency || "USD",
        date: new Date().toISOString().split("T")[0] || "",
      };
    } catch (error) {
      console.error("❌ Error extracting expense data:", error);
      return null;
    }
  }

  public async addToMongo(
    expenseData: ExpenseData,
    userId: string,
    mongoService: MongoService
  ): Promise<{ id: string; number: number }> {
    try {
      const seq = await mongoService.getNextExpenseNumber(userId);
      const saved = await Expense.create({
        ...expenseData,
        userId,
        number: seq,
      });
      console.log("✅ Added to MongoDB:", { ...expenseData, number: seq });
      return { id: String(saved._id), number: seq };
    } catch (error) {
      console.error("❌ Error adding to MongoDB:", error);
      throw error;
    }
  }

  // New methods for image processing with confidence levels
  private async extractExpenseWithConfidence(
    imageUrl: string,
    caption: string
  ): Promise<{ expense: ExpenseData | null; confidence: number }> {
    try {
      const prompt = `You are an expense extractor from receipt images. Analyze the image to extract expense info and provide confidence.

IMPORTANT:
- If a total price, subtotal, or full amount is present, use THAT as the price
- Item: A summary description like "Groceries", "Dinner", or based on receipt content
- Use caption for context if provided: "${caption.replace(/"/g, '\\"')}"
- Provide confidence score (0.0 to 1.0) based on image clarity and text readability

Return ONLY valid JSON:
{"item": "name", "price": number, "currency": "USD", "confidence": 0.95}
If invalid or unclear: {"error": "invalid", "confidence": 0.0}`;

      const completion = await this.groq.chat.completions.create({
        messages: [
          {
            role: "system",
            content: "Return only valid JSON objects with confidence scores, never code blocks or explanations.",
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl,
                },
              },
            ],
          },
        ],
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0.1,
        max_tokens: 200,
      });

      const response = completion.choices[0]?.message?.content?.trim();
      if (!response) {
        return { expense: null, confidence: 0.0 };
      }

      console.log("🤖 Groq OCR with confidence response:", response);
      const cleanedResponse = response
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleanedResponse);

      if (parsed.error || !parsed.item || !parsed.price) {
        return { expense: null, confidence: parsed.confidence || 0.0 };
      }

      const expense: ExpenseData = {
        item: parsed.item,
        price: parsed.price,
        currency: parsed.currency || "USD",
        date: new Date().toISOString().split("T")[0] || "",
      };

      return { expense, confidence: parsed.confidence || 0.5 };
    } catch (error) {
      console.error("❌ Error extracting expense with confidence:", error);
      return { expense: null, confidence: 0.0 };
    }
  }

  private async handleUncertainOCR(
    expense: ExpenseData,
    originalMessage: Message,
    mongoService: MongoService,
    userCurrency: string
  ): Promise<void> {
    try {
      // Store the uncertain expense temporarily for confirmation
      await mongoService.storePendingExpense(originalMessage.from, expense);

      console.log(`📤 Sending OCR confirmation request to: ${originalMessage.from}`);
      await this.client.sendMessage(
        originalMessage.from,
        `I'm not sure about the total.\nDid you mean ${expense.price.toFixed(2)} ${userCurrency}?\n\nReply with:\n*Yes* → Save it\n*No* → Cancel`
      );
    } catch (error) {
      console.error("❌ Error handling uncertain OCR:", error);
      await this.client.sendMessage(
        originalMessage.from,
        "Sorry, there was an error processing your image. Please try again."
      );
    }
  }

  private async handleFailedOCR(originalMessage: Message): Promise<void> {
    try {
      console.log(`📤 Sending OCR failure message to: ${originalMessage.from}`);
      await this.client.sendMessage(
        originalMessage.from,
        `I couldn't read the amount from this image.\n\nMake sure:\n• Full bill is in frame\n• Good light, no blur\n• Numbers are visible\n\nOr, send manually like: Travel 500`
      );
    } catch (error) {
      console.error("❌ Error handling failed OCR:", error);
    }
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
    isFromCaption: boolean
  ): string {
    let reply = `#${this.padNumber(number)} ${item}: ${this.money(price)} ${currency} 📷 ✅\n`;
    reply += `${month} ${year} → Spent: ${this.money(totalAmount)} / ${this.money(budget)} ${currency}\n`;
    reply += `Remaining: ${this.money(remaining)} ${currency}\n`;
    if (budget > 0 && dailyLimit !== null && todaySpending !== null) {
      reply += `🎯 Daily limit: ${this.money(dailyLimit)} ${currency}\n`;
      if (todaySpending <= dailyLimit) {
        reply += `✅ You're on track. Good job!`;
      } else {
        reply += `⚠️ You're above your daily limit. Try to save tomorrow.`;
      }
    }

    return reply;
  }

  // Method to handle OCR confirmation responses
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

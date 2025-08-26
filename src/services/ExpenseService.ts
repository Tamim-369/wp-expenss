import { Client, Message, MessageMedia } from "whatsapp-web.js";
import Groq from "groq-sdk";
import type {
  ExpenseData,
  GroqExpenseResponse,
  IntentResult,
} from "../types/types";
import { Expense } from "../models/ExpenseModel";
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
          remaining
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

      let finalExpense: ExpenseData | null = null;
      if (caption.trim()) {
        finalExpense = await this.extractExpenseData(caption);
        if (finalExpense) {
          console.log("✅ Using caption-based expense data:", finalExpense);
        }
      }

      if (!finalExpense) {
        const extractedText = await this.extractTextFromImage(imageDataUrl);
        let textBasedExpense = null;
        if (extractedText.trim()) {
          textBasedExpense = await this.extractExpenseData(extractedText);
        }

        let isTextGood = false;
        if (extractedText.trim()) {
          isTextGood = await this.verifyExtractedText(
            imageDataUrl,
            extractedText
          );
        }

        if (isTextGood && textBasedExpense) {
          finalExpense = textBasedExpense;
        } else {
          finalExpense = await this.directExtractExpenseFromImage(
            imageDataUrl,
            caption
          );
        }
      }

      if (finalExpense) {
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
        const budget = await mongoService.getMonthlyBudget(
          originalMessage.from
        );
        const remaining = budget - monthlyTotal.totalAmount;

        const replyMessage = this.buildAddedReply(
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
          remaining
        );

        console.log(`📤 Sending image expense reply to: ${originalMessage.from}`);
        await this.client.sendMessage(originalMessage.from, replyMessage);
      } else {
        await this.client.sendMessage(
          originalMessage.from,
          '❌ Could not extract expense information from the image. Please add a caption with details like "Groceries 25 usd" or try a clearer image.'
        );
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
          "❌ Could not parse the correction. Please use format like 'no it will be Coffee 15 usd'"
        );
        return;
      }

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
        remaining
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
    remaining: number
  ): string {
    const numLine = number ? `*#${this.padNumber(number)}*\n` : "";
    return (
      `*✅ Expense Added*\n` +
      numLine +
      `*Item:* ${item}\n` +
      `*Price:* ${currency} ${this.money(price)}\n` +
      `*Date:* ${date}\n\n` +
      `*${month} ${year} Summary*\n` +
      `*Total:* ${totalCurrency} ${this.money(totalAmount)}\n` +
      `*Expenses:* ${expenseCount} items\n` +
      `*Budget:* USD ${this.money(budget)}\n` +
      `*Remaining:* USD ${this.money(remaining)}`
    );
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
    remaining: number
  ): string {
    const numLine = number ? `*#${this.padNumber(number)}*\n` : "";
    return (
      `*✅ Expense Updated*\n` +
      numLine +
      `*Item:* ${item}\n` +
      `*Price:* ${currency} ${this.money(price)}\n` +
      `*Date:* ${date}\n\n` +
      `*${month} ${year} Summary*\n` +
      `*Total:* ${totalCurrency} ${this.money(totalAmount)}\n` +
      `*Expenses:* ${expenseCount} items\n` +
      `*Budget:* USD ${this.money(budget)}\n` +
      `*Remaining:* USD ${this.money(remaining)}`
    );
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
- If text mentions total or full amount, prioritize that.

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
      const seq = await mongoService.getNextExpenseNumber();
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
}

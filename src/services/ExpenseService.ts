// services/ExpenseService.ts
import { Message, MessageMedia } from "whatsapp-web.js";
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

  constructor() {
    this.groq = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  public async processExpenseMessage(
    messageText: string,
    originalMessage: Message,
    mongoService: MongoService
  ): Promise<void> {
    try {
      const expenseData = await this.extractExpenseData(messageText);

      if (expenseData) {
        await this.addToMongo(expenseData, originalMessage.from);
        const monthlyTotal = await mongoService.calculateMonthlyTotal(
          originalMessage.from,
          expenseData.date
        );
        const budget = await mongoService.getMonthlyBudget(
          originalMessage.from
        );
        const remaining = budget - monthlyTotal.totalAmount;

        const replyMessage = `✅ Added to expenses:
📝 Item: ${expenseData.item}
💰 Price: ${expenseData.currency} ${expenseData.price}
📅 Date: ${expenseData.date}

📊 ${monthlyTotal.month} ${monthlyTotal.year} Summary:
💵 Total: ${monthlyTotal.currency} ${monthlyTotal.totalAmount}
📈 Expenses: ${monthlyTotal.expenseCount} items
🛡️ Budget: USD ${budget}
📉 Remaining: USD ${remaining}`;

        await originalMessage.reply(replyMessage);
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
        await this.addToMongo(finalExpense, originalMessage.from);
        const monthlyTotal = await mongoService.calculateMonthlyTotal(
          originalMessage.from,
          finalExpense.date
        );
        const budget = await mongoService.getMonthlyBudget(
          originalMessage.from
        );
        const remaining = budget - monthlyTotal.totalAmount;

        const replyMessage = `✅ Added to expenses from image:
📝 Item: ${finalExpense.item}
💰 Price: ${finalExpense.currency} ${finalExpense.price}
📅 Date: ${finalExpense.date}

📊 ${monthlyTotal.month} ${monthlyTotal.year} Summary:
💵 Total: ${monthlyTotal.currency} ${monthlyTotal.totalAmount}
📈 Expenses: ${monthlyTotal.expenseCount} items
🛡️ Budget: USD ${budget}
📉 Remaining: USD ${remaining}`;

        await originalMessage.reply(replyMessage);
      } else {
        await originalMessage.reply(
          '❌ Could not extract expense information from the image. Please add a caption with details like "Groceries 25 usd" or try a clearer image.'
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
        await originalMessage.reply(
          "❌ Could not parse the correction. Please use format like 'no it will be Coffee 15 usd'"
        );
        return;
      }

      // Get the most recent expense for this user
      const lastExpense = await Expense.findOne({ userId }).sort({
        createdAt: -1,
      });

      if (!lastExpense) {
        await originalMessage.reply("❌ No recent expense found to correct.");
        return;
      }

      // Update the last expense with corrected data
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

      const replyMessage = `✅ Expense corrected:
📝 Item: ${correctedExpenseData.item}
💰 Price: ${correctedExpenseData.currency} ${correctedExpenseData.price}
📅 Date: ${correctedExpenseData.date}

📊 ${monthlyTotal.month} ${monthlyTotal.year} Summary:
💵 Total: ${monthlyTotal.currency} ${monthlyTotal.totalAmount}
📈 Expenses: ${monthlyTotal.expenseCount} items
🛡️ Budget: USD ${budget}
📉 Remaining: USD ${remaining}`;

      await originalMessage.reply(replyMessage);
    } catch (error) {
      console.error("❌ Error handling correction:", error);
      await originalMessage.reply(
        "Sorry, there was an error processing your correction. Please try again."
      );
      throw error;
    }
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
    userId: string
  ): Promise<void> {
    try {
      await Expense.create({
        ...expenseData,
        userId,
      });
      console.log("✅ Added to MongoDB:", expenseData);
    } catch (error) {
      console.error("❌ Error adding to MongoDB:", error);
      throw error;
    }
  }
}

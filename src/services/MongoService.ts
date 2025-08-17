import { Budget, Expense, Conversation } from "../models/ExpenseModel";
import type { MonthlyTotal } from "../types/types";

export class MongoService {
  public async hasMonthlyBudget(userId: string): Promise<boolean> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const budget = await Budget.findOne({ userId, month: currentMonth });
    return !!budget;
  }

  public async setMonthlyBudget(userId: string, budget: number): Promise<void> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    await Budget.create({
      userId,
      month: currentMonth,
      budget,
      currency: "USD",
    });
  }

  public async getMonthlyBudget(userId: string): Promise<number> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const budgetDoc = await Budget.findOne({ userId, month: currentMonth });
    return budgetDoc?.budget || 0;
  }

  public async calculateMonthlyTotal(
    userId: string,
    currentDate: string
  ): Promise<MonthlyTotal> {
    try {
      const currentMonth = new Date(currentDate).getMonth();
      const currentYear = new Date(currentDate).getFullYear();

      const expenses = await Expense.find({
        userId,
        date: {
          $regex: `^${currentYear}-${String(currentMonth + 1).padStart(
            2,
            "0"
          )}`,
        },
      });

      let totalAmount = 0;
      let expenseCount = 0;
      let currency = "USD";

      for (const exp of expenses) {
        totalAmount += exp.price;
        expenseCount++;
        if (expenseCount === 1) {
          currency = exp.currency || "USD";
        }
      }

      return {
        month: new Date(currentDate).toLocaleString("default", {
          month: "long",
        }),
        year: currentYear,
        totalAmount: Math.round(totalAmount * 100) / 100,
        currency,
        expenseCount,
      };
    } catch (error) {
      console.error("❌ Error calculating monthly total:", error);
      return {
        month: new Date(currentDate).toLocaleString("default", {
          month: "long",
        }),
        year: new Date(currentDate).getFullYear(),
        totalAmount: 0,
        currency: "USD",
        expenseCount: 0,
      };
    }
  }

  public async saveMessage(userId: string, message: string): Promise<void> {
    await Conversation.create({
      userId,
      message,
    });
  }

  public async getLastMessages(
    userId: string,
    count: number
  ): Promise<string[]> {
    const messages = await Conversation.find({ userId })
      .sort({ timestamp: -1 })
      .limit(count)
      .select("message");
    return messages.map((m) => m.message).reverse(); // oldest to newest
  }
}

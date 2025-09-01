import { Budget, Expense, Conversation, Counter, User } from "../models/ExpenseModel";
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

  public async getNextExpenseNumber(userId: string): Promise<number> {
    // Use a per-user counter so each user starts from #001
    const key = `expense_number:${userId}`;
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    return counter.seq;
  }

  // User state management methods
  public async getUserState(userId: string): Promise<'new' | 'awaiting_budget' | 'awaiting_currency' | 'active' | 'awaiting_ocr_confirmation' | 'awaiting_currency_change'> {
    const user = await User.findOne({ userId });
    return user?.state || 'new';
  }

  public async setUserState(userId: string, state: 'new' | 'awaiting_budget' | 'awaiting_currency' | 'active' | 'awaiting_ocr_confirmation' | 'awaiting_currency_change'): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      { state },
      { upsert: true, new: true }
    );
  }

  public async setUserCurrency(userId: string, currency: string): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      { currency, state: 'active' },
      { upsert: true, new: true }
    );
  }

  public async getUserCurrency(userId: string): Promise<string> {
    const user = await User.findOne({ userId });
    return user?.currency || 'USD';
  }

  public async setMonthlyBudgetWithCurrency(userId: string, budget: number, currency: string): Promise<void> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    await Budget.findOneAndUpdate(
      { userId, month: currentMonth },
      { budget, currency },
      { upsert: true, new: true }
    );
  }

  public async isUserActive(userId: string): Promise<boolean> {
    const user = await User.findOne({ userId });
    return user?.state === 'active';
  }

  // Pending expense methods for OCR confirmation
  public async storePendingExpense(userId: string, expense: any): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      {
        pendingExpense: expense,
        state: 'awaiting_ocr_confirmation'
      },
      { upsert: true, new: true }
    );
  }

  public async getPendingExpense(userId: string): Promise<any | null> {
    const user = await User.findOne({ userId });
    return user?.pendingExpense || null;
  }

  public async clearPendingExpense(userId: string): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      {
        $unset: { pendingExpense: 1 },
        state: 'active'
      }
    );
  }

  public async isAwaitingOCRConfirmation(userId: string): Promise<boolean> {
    const user = await User.findOne({ userId });
    return user?.state === 'awaiting_ocr_confirmation';
  }

  // Pending currency change flow
  public async setPendingCurrency(userId: string, currency: string): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      { pendingCurrency: currency, state: 'awaiting_currency_change' },
      { upsert: true, new: true }
    );
  }

  public async getPendingCurrency(userId: string): Promise<string | null> {
    const user = await User.findOne({ userId });
    return user?.pendingCurrency || null;
  }

  public async confirmCurrencyChange(userId: string): Promise<string | null> {
    const user = await User.findOne({ userId });
    const newCurrency = user?.pendingCurrency || null;
    if (!newCurrency) return null;
    await User.findOneAndUpdate(
      { userId },
      { currency: newCurrency, $unset: { pendingCurrency: 1 }, state: 'active' }
    );
    return newCurrency;
  }

  public async clearPendingCurrency(userId: string): Promise<void> {
    await User.findOneAndUpdate(
      { userId },
      { $unset: { pendingCurrency: 1 }, state: 'active' }
    );
  }
}

import { Schema, Document, model } from "mongoose";

interface IBudget extends Document {
  userId: string;
  month: string;
  budget: number;
  currency: string;
}

interface IExpense extends Document {
  userId: string;
  item: string;
  price: number;
  currency: string;
  date: string;
}

interface IConversation extends Document {
  userId: string;
  message: string;
  timestamp: Date;
}

const BudgetSchema = new Schema<IBudget>({
  userId: { type: String, required: true },
  month: { type: String, required: true },
  budget: { type: Number, required: true },
  currency: { type: String, required: true, default: "USD" },
});

const ExpenseSchema = new Schema<IExpense>({
  userId: { type: String, required: true },
  item: { type: String, required: true },
  price: { type: Number, required: true },
  currency: { type: String, required: true, default: "USD" },
  date: { type: String, required: true },
});

const ConversationSchema = new Schema<IConversation>({
  userId: { type: String, required: true },
  message: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

export const Budget = model<IBudget>("Budget", BudgetSchema);
export const Expense = model<IExpense>("Expense", ExpenseSchema);
export const Conversation = model<IConversation>(
  "Conversation",
  ConversationSchema
);
